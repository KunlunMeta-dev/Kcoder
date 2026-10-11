import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactSourceRoot, createRedactingStream, isolatedEnvironment, portableTimestamp, redact, repoRoot, runE2E, RunContext } from "./run-context.mjs";

test("artifact mapping mirrors the exact E2E source path under target/test", () => {
  const source = new URL("../suites/browser/ssh-browser.e2e.mjs", import.meta.url);
  assert.equal(
    artifactSourceRoot(source.pathname),
    `${repoRoot}/target/test/apps/kcoder-studio/e2e/suites/browser/ssh-browser.e2e.mjs`,
  );
  assert.equal(portableTimestamp(new Date("2026-07-28T09:15:30.482Z")), "20260728-091530.482Z");
});

test("run roots are collision safe and case paths use project/test slugs", async () => {
  const first = await RunContext.create(import.meta.url, { testId: "collision-a" });
  const second = await RunContext.create(import.meta.url, { testId: "collision-b" });
  try {
    assert.notEqual(first.runRoot, second.runRoot);
    assert.equal(
      first.pathInCase("chromium", "auth-mainline", "trace.zip"),
      `${first.runRoot}/cases/chromium/auth-mainline/trace.zip`,
    );
    assert.throws(() => first.pathInCase("../escape", "case"), /invalid E2E project slug/);
  } finally {
    await first.finish("passed", { ok: true });
    await second.finish("passed", { ok: true });
  }
});

test("manifest redaction removes credentials recursively", () => {
  const value = redact({
    token: "abc",
    nested: { apiKey: "def", safe: "visible" },
    list: [{ cookie: "ghi" }],
    error: "provider body: {\"api_key\":\"DUMMY_SECRET_123456\"}; headers: {\"Authorization\":\"Basic DUMMY_CREDENTIAL_123456\"}; https://user:DUMMY_PASSWORD_123456@example.invalid/v1; known=TOP_SECRET",
  });
  assert.deepEqual(value, {
    token: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", safe: "visible" },
    list: [{ cookie: "[REDACTED]" }],
    error: "provider body: {\"api_key\":[REDACTED]}; headers: {\"Authorization\":\"Basic [REDACTED]; https://[REDACTED]@example.invalid/v1; known=TOP_SECRET",
  });
  assert.equal(redact("known=TOP_SECRET", "", ["TOP_SECRET"]), "known=[REDACTED]");
});

test("retained child logs redact known secrets even when writes split the value", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "redacted-child-log", retainSuccessLogs: true });
  context.registerSecret("DUMMY_SECRET_123456");
  const child = context.spawnOwned("secret-writer", process.execPath, [
    "-e",
    "process.stdout.write('value=DUMMY_'); setTimeout(() => process.stdout.write('SECRET_123456\\n'), 10)",
  ]);
  await new Promise((resolveExit, reject) => {
    child.once("exit", resolveExit);
    child.once("error", reject);
  });
  await context.finish("passed", { ok: true });
  const log = await readFile(`${context.runRoot}/logs/secret-writer.log`, "utf8");
  assert.equal(log.includes("DUMMY_SECRET_123456"), false);
  assert.match(log, /value=\[REDACTED\]/);
});

test("streaming redactor hides a long Unicode secret across bytes, newlines and the old 64KiB boundary", async () => {
  const secret = `密钥-${"x".repeat(70 * 1024)}-结束`;
  const secrets = new Set([secret]);
  const input = Buffer.from(`before\n${secret}\nafter`, "utf8");
  const first = Buffer.byteLength("before\n密", "utf8") - 1;
  const second = first + 33 * 1024;
  const stream = createRedactingStream(value => redact(value, "", secrets), () => secrets);
  Readable.from([input.subarray(0, first), input.subarray(first, second), input.subarray(second)]).pipe(stream);
  let output = "";
  for await (const chunk of stream) output += chunk.toString("utf8");

  assert.equal(output, "before\n[REDACTED]\nafter");
  assert.equal(output.includes(secret), false);
});

test("runE2E rethrows a redacted terminal-safe failure", async () => {
  await assert.rejects(
    runE2E(import.meta.url, { testId: "redacted-terminal-failure" }, async context => {
      context.registerSecret("KNOWN_TERMINAL_SECRET");
      throw new Error("Basic BASIC_VALUE https://user:pass@example.invalid token=TOKEN_VALUE KNOWN_TERMINAL_SECRET");
    }),
    error => {
      assert.equal(error.message.includes("BASIC_VALUE"), false);
      assert.equal(error.message.includes("pass@example"), false);
      assert.equal(error.message.includes("TOKEN_VALUE"), false);
      assert.equal(error.message.includes("KNOWN_TERMINAL_SECRET"), false);
      return true;
    },
  );
});

test("runE2E handles SIGTERM by finishing owned cleanup before failing", async () => {
  let cleanupRan = false;
  let rejectedLateSpawn = false;
  await assert.rejects(
    runE2E(import.meta.url, { testId: "sigterm-cleanup" }, async (context, signal) => {
      context.addCleanup("signal cleanup proof", async () => { cleanupRan = true; });
      setImmediate(() => process.emit("SIGTERM"));
      await new Promise(resolveAbort => signal.addEventListener("abort", resolveAbort, { once: true }));
      assert.throws(
        () => context.spawnOwned("too-late", process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
        /aborting|finished/,
      );
      await assert.rejects(
        context.writeArtifactJson("late-body.json", { unsafe: true }),
        /aborting|finished/,
      );
      rejectedLateSpawn = true;
    }),
    /received SIGTERM/,
  );
  assert.equal(cleanupRan, true);
  assert.equal(rejectedLateSpawn, true);
});

test("runE2E bounds a body that ignores AbortSignal and records cancellation failure", { timeout: 30_000 }, async () => {
  let runRoot;
  await assert.rejects(
    runE2E(import.meta.url, { testId: "sigterm-ignored-abort", bodyAbortTimeoutMs: 50 }, async context => {
      runRoot = context.runRoot;
      setImmediate(() => process.emit("SIGTERM"));
      await new Promise(() => {});
    }),
    /did not stop within 50ms after abort/,
  );
  const result = JSON.parse(await readFile(`${runRoot}/artifacts/result.json`, "utf8"));
  assert.equal(result.status, "failed");
  assert.match(result.error, /did not stop within 50ms after abort/);
});

test("finish bounds a cleanup that never cooperates and records the failure", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "non-cooperative-cleanup",
    cleanupTimeoutMs: 50,
  });
  context.addCleanup("never resolves", () => new Promise(() => {}));
  const startedAt = Date.now();

  await assert.rejects(context.finish("passed", { ok: true }), /did not finish within 50ms/);

  assert.ok(Date.now() - startedAt < 2_000, "不合作 cleanup 必须有界失败");
  const result = JSON.parse(await readFile(`${context.runRoot}/artifacts/result.json`, "utf8"));
  assert.equal(result.status, "failed");
  assert.match(result.cleanupErrors.join("\n"), /cleanup never resolves did not finish/);
});

test("isolated environments omit unrelated credentials and preserve explicit values", () => {
  const name = "KCODER_E2E_UNRELATED_SECRET";
  process.env[name] = "SHOULD_NOT_LEAK_123456";
  try {
    const isolated = isolatedEnvironment({ SAFE_VALUE: "visible" }, ["CI"]);
    assert.equal(isolated[name], undefined);
    assert.equal(isolated.SAFE_VALUE, "visible");
    assert.equal(isolated.PATH, process.env.PATH);
  } finally {
    delete process.env[name];
  }
});

test("runtime target wrappers use the shared isolated environment", async () => {
  for (const source of [
    "../suites/gateway/runtime-target-local.e2e.mjs",
    "../suites/gateway/runtime-target-ssh.e2e.mjs",
  ]) {
    const text = await readFile(fileURLToPath(new URL(source, import.meta.url)), "utf8");
    assert.match(text, /context\.isolatedEnvironment\(/);
    assert.doesNotMatch(text, /\.\.\.process\.env/);
  }
});

test("run paths reject existing symbolic-link components", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "symlink-path-rejection" });
  try {
    const real = context.pathInState("real");
    await mkdir(real);
    await symlink(real, context.pathInState("link"));
    assert.throws(() => context.pathInState("link", "escaped.json"), /symbolic link/);
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("artifact writes reject a replaced symbolic-link root", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "symlink-root-rejection" });
  const outside = resolve(context.runRoot, "outside-artifacts");
  try {
    await mkdir(outside);
    await rm(context.artifactsDir, { recursive: true });
    await symlink(outside, context.artifactsDir);
    await assert.rejects(
      context.writeArtifactJson("escaped.json", { unsafe: true }),
      /root is a symbolic link/,
    );
    await rm(context.artifactsDir);
    await mkdir(context.artifactsDir);
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("state writes are create-only and cannot silently replace fixture inputs", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "state-create-only" });
  try {
    await context.writeStateJson("config/settings.json", { first: true });
    await assert.rejects(
      context.writeStateJson("config/settings.json", { first: false }),
      error => error?.code === "EEXIST",
    );
    const value = JSON.parse(await readFile(context.pathInState("config/settings.json"), "utf8"));
    assert.deepEqual(value, { first: true });
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("owned process labels are filesystem-safe and unambiguous", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "owned-process-label" });
  try {
    assert.throws(
      () => context.spawnOwned("gateway / production", process.execPath, ["-e", "process.exit(0)"]),
      /invalid owned process label/,
    );
  } finally {
    await context.finish("passed", { ok: true });
  }
});

test("queued running manifest writes cannot overwrite the final status", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "manifest-write-order" });
  for (let port = 10_000; port < 10_100; port += 1) context.registerPort(`port-${port}`, port);
  await context.finish("passed", { ok: true });
  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8"));
  assert.equal(manifest.status, "passed");
  assert.ok(manifest.endedAt);
  assert.equal(manifest.ports.length, 100);
});

test("owned process groups are terminated by label without broad process matching", async () => {
  const context = await RunContext.create(import.meta.url, { testId: "owned-process-cleanup" });
  const child = context.spawnOwned("owned-test-child", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const pid = child.pid;
  await context.stopOwned("owned-test-child");
  await context.finish("passed", { ok: true });
  await assert.rejects(async () => process.kill(-pid, 0), error => error?.code === "ESRCH");
  await access(context.runRoot);
});

test("Windows owned cleanup terminates a nested child after its leader exits", { skip: process.platform !== "win32" }, async () => {
  const context = await RunContext.create(import.meta.url, { testId: "windows-owned-process-tree" });
  const pidPath = context.pathInState("nested-child.pid");
  const leader = context.spawnOwned("windows-nested-tree", process.execPath, ["-e", [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid))`,
  ].join(";")]);
  await new Promise((resolveExit, reject) => {
    leader.once("exit", resolveExit);
    leader.once("error", reject);
  });
  const nestedPid = Number(await readFile(pidPath, "utf8"));
  await context.stopOwned("windows-nested-tree");
  await context.finish("passed", { ok: true });
  assert.throws(() => process.kill(nestedPid, 0), error => error?.code === "ESRCH");
});

test.after(async () => {
  await rm(artifactSourceRoot(new URL(import.meta.url).pathname), { recursive: true, force: true });
});
