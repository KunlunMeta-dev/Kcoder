import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertWindowsX64Executable, probeGitIdentity, windowsBuildEnv, windowsBuildInputs, windowsComputerUseInputs, windowsPackConfig } from "./build-windows.mjs";

test("full and remote packages include widget isolation code without shipping its tests", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, resolve } = await import("node:path");
  const { readFile, stat } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const studio = fileURLToPath(new URL("..", import.meta.url));
  const require = createRequire(resolve(studio, "package.json"));
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { FileMatcher } = builderRequire(resolve(dirname(builderRequire.resolve("app-builder-lib")), "fileMatcher.js"));
  const full = JSON.parse(await readFile(resolve(studio, "package.json"), "utf8")).build;
  const remote = JSON.parse(await readFile(resolve(studio, "electron-builder.remote.json"), "utf8"));
  for (const config of [full, remote]) {
    const includes = new FileMatcher(studio, studio, path => path, config.files.filter(pattern => typeof pattern === "string")).createFilter();
    for (const name of ["controller.mjs", "policy.mjs", "controller.test.mjs", "policy.test.mjs"]) {
      const path = resolve(studio, "desktop/widget-isolation", name);
      assert.equal(includes(path, await stat(path)), !name.includes(".test."), name);
    }
  }
});

test("Windows builder receives a callable dependency hook independent of launch directory", async () => {
  let calls = 0;
  let audits = 0;
  let computerUse;
  const env = { KCODER_COMPUTER_USE_INVENTORY_SHA256: "a".repeat(64) };
  const config = windowsPackConfig(async () => { calls += 1; }, async () => {
    assert.ok(computerUse, "Computer Use must be staged before the release audit");
    audits += 1;
  }, env, undefined, async options => { computerUse = options; });
  assert.equal(typeof config.beforePack, "function");
  assert.equal(typeof config.afterPack, "function");
  assert.equal(config.npmRebuild, false);
  await config.beforePack();
  await config.afterPack({ appOutDir: join(tmpdir(), "kcoder-windows-package") });
  assert.equal(calls, 1);
  assert.equal(audits, 1);
  assert.match(computerUse.source, /target[/\\]packages[/\\]kcoder-studio[/\\]windows-input[/\\]computer-use$/);
  assert.match(computerUse.destination, /resources[/\\]computer-use$/);
  assert.equal(computerUse.expectedHash, env.KCODER_COMPUTER_USE_INVENTORY_SHA256);
  assert.equal(computerUse.allowPrototype, false);
});

test("full Windows installers fail before building when the trusted Computer Use pin is missing", () => {
  assert.throws(() => windowsPackConfig(undefined, undefined, {}), /require Computer Use resources/);
  assert.throws(() => windowsComputerUseInputs({ KCODER_COMPUTER_USE_INVENTORY_SHA256: "invalid" }), /trusted files.sha256.json digest/);
  const input = windowsComputerUseInputs({ KCODER_COMPUTER_USE_RUNTIME: "custom-runtime",
    KCODER_COMPUTER_USE_INVENTORY_SHA256: "b".repeat(64), KCODER_COMPUTER_USE_ALLOW_PROTOTYPE: "1" });
  assert.equal(input.source, fileURLToPath(new URL("../../../custom-runtime", import.meta.url)));
  assert.equal(input.allowPrototype, true);
});

test("Computer Use staging failure prevents a Windows release audit", async () => {
  const config = windowsPackConfig(async () => {}, async () => assert.fail("incomplete bundles must not be audited"),
    { KCODER_COMPUTER_USE_INVENTORY_SHA256: "c".repeat(64) }, undefined,
    async () => { throw new Error("Runtime resource mismatch"); });
  await assert.rejects(config.afterPack({ appOutDir: tmpdir() }), /Runtime resource mismatch/);
});

test("Windows packaging selects Windows Rust targets on either build host", () => {
  assert.equal(windowsBuildInputs({}, "linux").target, "x86_64-pc-windows-gnu");
  assert.equal(windowsBuildInputs({}, "win32").target, "x86_64-pc-windows-msvc");
  assert.throws(() => windowsBuildInputs({ KCODER_WINDOWS_TARGET: "x86_64-unknown-linux-gnu" }), /Windows Rust target/);
  assert.match(windowsBuildInputs({ CARGO_TARGET_DIR: "/tmp/isolated-cargo" }, "linux").binaryDir,
    /isolated-cargo.*x86_64-pc-windows-gnu.*release/);
});

test("packaging refuses Linux and non-x64 sidecars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kcoder-pe-test-"));
  try {
    const path = join(directory, "binary.exe");
    await writeFile(path, Buffer.from("\x7fELF"));
    await assert.rejects(assertWindowsX64Executable(path), /Not a Windows executable/);
    const pe = Buffer.alloc(128);
    pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x14c, 68);
    await writeFile(path, pe);
    await assert.rejects(assertWindowsX64Executable(path), /Not a Windows x64/);
    pe.writeUInt16LE(0x8664, 68); await writeFile(path, pe);
    await assertWindowsX64Executable(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows packaging injects explicit build identity into the cargo environment", () => {
  const explicit = windowsBuildEnv({ KCODER_BUILD_COMMIT: "abc123", KCODER_BUILD_DIRTY: "false",
    KCODER_BUILD_TIME_UNIX: "42" }, () => { throw new Error("probe must not run when env is set"); });
  assert.equal(explicit.KCODER_BUILD_COMMIT, "abc123");
  assert.equal(explicit.KCODER_BUILD_DIRTY, "false");
  assert.equal(explicit.KCODER_BUILD_TIME_UNIX, "42");

  const probed = windowsBuildEnv({}, () => ({ commit: "deadbeef".repeat(5), dirty: false }));
  assert.equal(probed.KCODER_BUILD_COMMIT, "deadbeef".repeat(5));
  assert.equal(probed.KCODER_BUILD_DIRTY, "false");
  assert.equal(probed.KCODER_BUILD_TIME_UNIX, "0");
  assert.equal(windowsBuildEnv({ SOURCE_DATE_EPOCH: "123" }).KCODER_BUILD_TIME_UNIX, "123");

  const fallback = windowsBuildEnv({}, () => ({ commit: null, dirty: null }));
  assert.equal(fallback.KCODER_BUILD_COMMIT, "unknown");
  assert.equal(fallback.KCODER_BUILD_DIRTY, "true");
});

test("git probe resolves a real commit and clean-tree flag in an ESM context", () => {
  const identity = probeGitIdentity(new URL("../../..", import.meta.url).pathname);
  assert.match(identity.commit ?? "", /^[0-9a-f]{40}$/, "probe must capture the real HEAD commit");
  assert.equal(typeof identity.dirty, "boolean");
});

test("git identity probes preserve the index stat cache", async t => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-git-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const tracked = join(root, "tracked.txt");
  await writeFile(tracked, "unchanged content\n");
  git(["init", "-b", "main"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Fixture"]);
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  const index = join(root, ".git", "index");
  const original = await readFile(index);
  const changedTime = new Date(Date.now() + 2_000);
  await utimes(tracked, changedTime, changedTime);
  const identity = probeGitIdentity(root);
  assert.equal(identity.commit, git(["rev-parse", "HEAD"]));
  assert.equal(identity.dirty, false);
  assert.deepEqual(await readFile(index), original);
});
