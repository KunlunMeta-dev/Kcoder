import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RunContext } from "./run-context.mjs";

// Direct construction keeps these filesystem unit tests out of shared E2E retention.
async function withContext(body) {
  const root = await mkdtemp(join(tmpdir(), "kcoder-progress-test-"));
  const context = new RunContext(fileURLToPath(import.meta.url), "harness/run-context-progress.test.mjs", root, {});
  try {
    await context.initialize();
    await body(context);
  } finally {
    try { await context.finish("passed", { unitTest: true }); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("progress replaces a complete redacted snapshot without changing immutable evidence", () => withContext(async context => {
  const secret = "owned-progress-canary";
  context.registerSecret(secret);
  const evidence = await context.writeArtifactJson("original.json", { outcome: "failed" });
  const stages = [{ phase: "gateway-ready", elapsedMs: 10 }];
  const path = await context.writeProgressJson("startup.json", { stages, detail: secret });
  stages.push({ phase: "window-ready", elapsedMs: 20 });
  assert.equal(await context.writeProgressJson("startup.json", { stages, detail: secret }), path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { stages, detail: "[REDACTED]" });
  assert.deepEqual(await readdir(join(context.artifactsDir, "progress")), ["startup.json"]);
  await assert.rejects(context.writeArtifactJson("original.json", { outcome: "passed" }), { code: "EEXIST" });
  await assert.rejects(context.writeArtifactJson("result.json", {}), /reserved/);
  assert.deepEqual(JSON.parse(await readFile(evidence, "utf8")), { outcome: "failed" });
  await assert.rejects(context.writeProgressJson("../original.json", {}), /escaped run directory/);
  await assert.rejects(context.writeProgressJson("../result.json", {}), /escaped run directory/);
}));

test("readers see complete progress snapshots and a failed update retains the previous snapshot", () => withContext(async context => {
  const path = await context.writeProgressJson("startup.json", { revision: 0, content: "initial" });
  let updating = true;
  const reader = (async () => {
    while (updating) {
      const value = JSON.parse(await readFile(path, "utf8"));
      assert.equal(typeof value.revision, "number");
      assert.equal(typeof value.content, "string");
    }
  })();
  try {
    for (let revision = 1; revision <= 12; revision++)
      await context.writeProgressJson("startup.json", { revision, content: "complete".repeat(8192) });
  } finally { updating = false; await reader; }
  const before = await readFile(path, "utf8");
  await assert.rejects(context.writeProgressJson("startup.json", { unsupported: 1n }), /BigInt/);
  await assert.rejects(context.writeProgressJson("startup.json", undefined), /not serializable/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(join(context.artifactsDir, "progress")), ["startup.json"]);
}));

test("progress rejects a symbolic-link destination and leaves its target intact", () => withContext(async context => {
  const target = await context.writeStateJson("outside.json", { retained: true });
  const root = join(context.artifactsDir, "progress");
  await mkdir(root);
  await symlink(target, join(root, "startup.json"));
  await assert.rejects(context.writeProgressJson("startup.json", {}), /symbolic link/);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { retained: true });
}));

test("progress cannot update after finalization", () => withContext(async context => {
  const path = await context.writeProgressJson("startup.json", { phase: "observed" });
  await context.finish("passed", { complete: true });
  await assert.rejects(context.writeProgressJson("startup.json", { phase: "late" }), /finished/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { phase: "observed" });
  assert.equal(JSON.parse(await readFile(join(context.artifactsDir, "result.json"), "utf8")).status, "passed");
}));

test("invalid JSON cannot reserve an immutable artifact or fixture input path", () => withContext(async context => {
  const circular = {};
  circular.self = circular;
  for (const [method, directory] of [["writeArtifactJson", context.artifactsDir], ["writeStateJson", context.stateDir]]) {
    for (const [name, value] of [["bigint.json", { unsupported: 1n }], ["circular.json", circular],
      ["undefined.json", undefined], ["function.json", () => {}], ["symbol.json", Symbol("invalid-json")]]) {
      await assert.rejects(context[method](name, value));
      await assert.rejects(lstat(join(directory, name)), { code: "ENOENT" });
      const path = await context[method](name, { recovered: true });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { recovered: true });
      await assert.rejects(context[method](name, { recovered: false }), { code: "EEXIST" });
    }
  }
}));

test("equivalent result paths remain reserved for finalization", () => withContext(async context => {
  const names = ["./result.json", "nested/../result.json", join(context.artifactsDir, "result.json")];
  if (process.platform === "win32") names.push("RESULT.JSON");
  for (const name of names)
    await assert.rejects(context.writeArtifactJson(name, { status: "passed" }), /reserved/);
  await assert.rejects(lstat(join(context.artifactsDir, "result.json")), { code: "ENOENT" });
  // A nested case result is not the run's final receipt.
  await context.writeArtifactJson("nested/result.json", { caseOnly: true });
}));

test("manifest serialization failure preserves the last receipt without orphan temporary files", () => withContext(async context => {
  const path = join(context.runRoot, "manifest.json");
  const before = await readFile(path, "utf8");
  context.metadata.testId = 1n;
  try {
    await assert.rejects(context.writeManifest("running"), /BigInt/);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual((await readdir(context.runRoot)).filter(name => name.endsWith(".tmp")), []);
  } finally { delete context.metadata.testId; }
  await context.writeManifest("running");
}));
