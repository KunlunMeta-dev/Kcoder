import { chmod } from "node:fs/promises";
import assert from "node:assert/strict";
import { access, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactSourceRoot, createRedactingStream, isolatedEnvironment, portableTimestamp, redact, repoRoot, retainedArtifactRunRoot, runE2E, RunContext } from "./run-context.mjs";

test("artifact mapping groups E2E runs by the Shanghai date of their UTC run ID", () => {
  const source = fileURLToPath(new URL("../suites/browser/ssh-browser.e2e.mjs", import.meta.url));
  const start = new Date("2026-07-28T16:15:30.482Z");
  const id = portableTimestamp(start);
  assert.equal(
    artifactSourceRoot(source, start),
    resolve(repoRoot, "target/e2e/2026/07/29/suites/browser/ssh-browser.e2e.mjs"),
  );
  assert.equal(id, "20260728-161530.482Z");
  assert.equal(retainedArtifactRunRoot(source, id), resolve(artifactSourceRoot(source, start), id));
  assert.throws(() => retainedArtifactRunRoot(source, "../escape"), /invalid retained E2E run ID/);
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

test("public numeric model budgets survive replay snapshots while authentication stays redacted", () => {
  assert.deepEqual(redact({ cacheReadTokens: 42, cacheCreationTokens: 0, cache_read_tokens: 43, cache_creation_tokens: 1 }),
    { cacheReadTokens: 42, cacheCreationTokens: 0, cache_read_tokens: 43, cache_creation_tokens: 1 });
  assert.equal(redact("secret-reference", "cacheReadTokens"), "[REDACTED]");
  assert.equal(redact(42, "cacheReadTokens", ["42"]), "[REDACTED]");
  const output = redact({
    context_window_tokens: 128000, outputHeadroomTokens: 8192, max_output_tokens: 2048,
    usage: { input_tokens: 500, output_tokens: 40, total_tokens: 540 },
    access_token: 123456, token: 123456, apiKey: "private",
    max_tokens: "private", summary_max_tokens: -1,
    credential: { max_tokens: 2048 },
  });
  assert.deepEqual(output, {
    context_window_tokens: 128000, outputHeadroomTokens: 8192, max_output_tokens: 2048,
    usage: { input_tokens: 500, output_tokens: 40, total_tokens: 540 },
    access_token: "[REDACTED]", token: "[REDACTED]", apiKey: "[REDACTED]",
    max_tokens: "[REDACTED]", summary_max_tokens: "[REDACTED]",
    credential: "[REDACTED]",
  });
  assert.equal(redact(2048, "max_tokens", ["2048"]), "[REDACTED]");
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

test("finish bounds a cleanup that never cooperates and preserves its unconfirmed owner state", async t => {
  const context = await RunContext.create(import.meta.url, {
    testId: "non-cooperative-cleanup",
    cleanupTimeoutMs: 50,
  });
  const checkpoint = await context.writeStateJson("unconfirmed-writer.json", { revision: 7 });
  // This fixture has no real writer; release only its test-owned state after assertions.
  t.after(() => rm(context.stateDir, { recursive: true, force: true }));
  context.addCleanup("never resolves", () => new Promise(() => {}));
  const startedAt = Date.now();

  await assert.rejects(context.finish("passed", { ok: true }), /did not finish within 50ms/);

  assert.ok(Date.now() - startedAt < 2_000, "不合作 cleanup 必须有界失败");
  const result = JSON.parse(await readFile(`${context.runRoot}/artifacts/result.json`, "utf8"));
  assert.equal(result.status, "failed");
  assert.match(result.cleanupErrors.join("\n"), /cleanup never resolves did not finish/);
  assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), { revision: 7 });
  assert.equal(JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8")).status, "failed");
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

test("owned scratch records filesystem identity, enforces 0700, and removes only its directory", {
  skip: typeof process.getuid !== "function",
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: "owned-scratch-identity-cleanup" });
  const baseDirectory = context.pathInState("scratch-base");
  await mkdir(baseDirectory, { mode: 0o700 });
  let scratch;
  try {
    scratch = await context.createOwnedScratchDirectory("unit-scratch", {
      baseDirectory,
      requiredBytes: 10n,
      reserveBytes: 20n,
      availableMemoryBytes: 100n,
    });
    const info = await lstat(scratch.path);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.mode & 0o777, 0o700);
    if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid());
    assert.equal(scratch.dev, String(info.dev));
    assert.equal(scratch.ino, String(info.ino));
    assert.equal(scratch.realPath, scratch.path);
    assert.equal(scratch.requiredMemoryBytes, "30");
    assert.match(scratch.filesystemType, /^0x[\da-f]+$/);
    assert.equal(context.pathInScratch(scratch, "owned.txt"), `${scratch.path}/owned.txt`);
    await context.finish("passed", { scratchAllocatedAndCleaned: true });
  } catch (error) {
    if (!context.finished) await context.finish("failed", null, error).catch(() => undefined);
    throw error;
  }

  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8"));
  assert.equal(manifest.scratchDirectories.length, 1);
  assert.equal(manifest.scratchDirectories[0].cleanupStatus, "removed");
  assert.ok(manifest.scratchDirectories[0].cleanedAt);
  assert.equal(manifest.scratchDirectories[0].baseDev, scratch.baseDev);
  assert.equal(manifest.scratchDirectories[0].requiredMemoryBytes, "30");
  assert.equal(manifest.scratchDirectories[0].filesystemType, scratch.filesystemType);
  assert.ok(manifest.cleanupSteps.some(step => step.label === "remove owned scratch unit-scratch" && step.status === "completed"));
  await assert.rejects(access(scratch.path), error => error?.code === "ENOENT");
});

test("owned scratch capacity preflight rejects before allocating a path", {
  skip: typeof process.getuid !== "function",
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: "owned-scratch-capacity-preflight" });
  const baseDirectory = context.pathInState("scratch-base");
  await mkdir(baseDirectory, { mode: 0o700 });
  try {
    await assert.rejects(
      context.createOwnedScratchDirectory("too-large", {
        baseDirectory,
        requiredBytes: 1n << 120n,
        reserveBytes: 0n,
      }),
      error => error?.code === "KCODER_E2E_SCRATCH_CAPACITY" && /filesystem capacity is insufficient/.test(error.message),
    );
    await assert.rejects(
      context.createOwnedScratchDirectory("too-memory-intensive", {
        baseDirectory,
        requiredBytes: 0n,
        reserveBytes: 0n,
        requiredMemoryBytes: 100n,
        availableMemoryBytes: 99n,
      }),
      error => error?.code === "KCODER_E2E_SCRATCH_CAPACITY" && /memory capacity is insufficient/.test(error.message),
    );
    await assert.rejects(
      context.createOwnedScratchDirectory("filesystem-changed", {
        baseDirectory,
        expectedFilesystemType: "0x0",
      }),
      /filesystem type changed during capacity preflight/,
    );
    assert.deepEqual(await readdir(baseDirectory), []);
  } finally {
    await context.finish("passed", { capacityRejectedBeforeAllocation: true });
  }
});

test("owned scratch replacement fails closed and leaves the replacement target intact", {
  skip: typeof process.getuid !== "function",
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: "owned-scratch-replacement" });
  const baseDirectory = context.pathInState("scratch-base");
  const outside = context.pathInState("outside");
  const held = context.pathInState("held-original-scratch");
  await mkdir(baseDirectory, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  const outsideSentinel = `${outside}/keep.txt`;
  await writeFile(outsideSentinel, "keep");
  let scratch;
  let replacementInstalled = false;
  try {
    scratch = await context.createOwnedScratchDirectory("replace-check", { baseDirectory });
    await rename(scratch.path, held);
    await symlink(outside, scratch.path);
    replacementInstalled = true;
    assert.throws(() => context.pathInScratch(scratch, "escaped.txt"), /symbolic link|identity changed/);
    await assert.rejects(context.removeOwnedScratchDirectory(scratch), /identity changed/);
    assert.equal(await readFile(outsideSentinel, "utf8"), "keep");
  } finally {
    if (replacementInstalled) {
      await rm(scratch.path, { force: true });
      await rename(held, scratch.path);
    }
    if (!context.finished) await context.finish("passed", { replacementRejected: true });
  }
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

test('isolated browser processes preserve filename encoding without inheriting secrets', () => {
  const names=['LANG','LC_ALL','LC_CTYPE','KCODER_PRIVATE_ENCODING_CANARY'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    process.env.LANG='C.UTF-8';process.env.LC_ALL='C.UTF-8';process.env.LC_CTYPE='C.UTF-8';process.env.KCODER_PRIVATE_ENCODING_CANARY='not-in-child';
    const env=isolatedEnvironment();
    assert.equal(env.LANG,'C.UTF-8');assert.equal(env.LC_ALL,'C.UTF-8');assert.equal(env.LC_CTYPE,'C.UTF-8');assert.equal(env.KCODER_PRIVATE_ENCODING_CANARY,undefined);
  } finally {
    for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  }
});

test("owned worker outer traversal permits only its fixed 0711 mode and retains identity cleanup", {
  skip: typeof process.getuid !== "function",
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: "owned-worker-outer-traversal" });
  const baseDirectory = context.pathInState("worker-outer-base");
  await mkdir(baseDirectory, { mode:0o700 });
  try {
    const scratch = await context.createOwnedScratchDirectory("worker-outer", { baseDirectory, ownedWorkerTraversal:true });
    assert.equal((await lstat(scratch.path)).mode & 0o777, 0o711);
    assert.equal(scratch.mode,"0711");
    const privateChild = context.pathInScratch(scratch,"profile");
    await mkdir(privateChild,{mode:0o700});
    assert.equal((await lstat(privateChild)).mode & 0o777,0o700);
    await chmod(scratch.path,0o777);
    assert.throws(()=>context.pathInScratch(scratch,"replaced"),/identity changed/);
    await chmod(scratch.path,0o711);
    await assert.rejects(context.createOwnedScratchDirectory("invalid-mode",{baseDirectory,ownedWorkerTraversal:0o777}),/traversal policy/);
    await context.finish("passed",{fixedOuterOnly:true});
    await assert.rejects(access(scratch.path),error=>error?.code==="ENOENT");
  } catch(error) {
    if(!context.finished)await context.finish("failed",null,error).catch(()=>undefined);
    throw error;
  }
});


test("failed owner cleanup retains state and artifacts even with no tracked process survivors", async t => {
  const context = await RunContext.create(import.meta.url, { testId: "unknown-owner-state" });
  const checkpoint = await context.writeStateJson("original-operation.json", { operation: "owned-original", phase: "pending" });
  const evidence = await context.writeArtifactJson("original-receipt.json", { observed: true });
  // The injected callback represents an unknown owner result, not an actual live writer.
  t.after(() => rm(context.stateDir, { recursive: true, force: true }));
  context.addCleanup("owner exit unknown", () => { throw Error("Original owner exit unconfirmed"); });
  await assert.rejects(context.finish("passed", { ok: true }), /Original owner exit unconfirmed/);
  assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), { operation: "owned-original", phase: "pending" });
  assert.deepEqual(JSON.parse(await readFile(evidence, "utf8")), { observed: true });
  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8"));
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.cleanupSteps.find(step => step.label === "owner exit unknown").status, "failed");
});
