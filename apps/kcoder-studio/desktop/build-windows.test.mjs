import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWindowsX64Executable, probeGitIdentity, windowsBuildEnv, windowsBuildInputs, windowsPackConfig } from "./build-windows.mjs";

test("Windows builder receives a callable dependency hook independent of launch directory", async () => {
  let calls = 0;
  const config = windowsPackConfig(async () => { calls += 1; });
  assert.equal(typeof config.beforePack, "function");
  assert.equal(config.npmRebuild, false);
  await config.beforePack();
  assert.equal(calls, 1);
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
  assert.match(probed.KCODER_BUILD_TIME_UNIX, /^\d+$/);

  const fallback = windowsBuildEnv({}, () => ({ commit: null, dirty: null }));
  assert.equal(fallback.KCODER_BUILD_COMMIT, "unknown");
  assert.equal(fallback.KCODER_BUILD_DIRTY, "true");
});

test("git probe resolves a real commit and clean-tree flag in an ESM context", () => {
  const identity = probeGitIdentity(new URL("../../..", import.meta.url).pathname);
  assert.match(identity.commit ?? "", /^[0-9a-f]{40}$/, "probe must capture the real HEAD commit");
  assert.equal(typeof identity.dirty, "boolean");
});
