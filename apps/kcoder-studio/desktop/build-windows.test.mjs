import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertWindowsX64Executable, probeGitIdentity, stageWindowsSignedNativeInputs, windowsBuildEnv, windowsBuildInputs, windowsComputerUseInputs, windowsPackConfig } from "./build-windows.mjs";

test("Windows storage addon is signed alongside the existing executable and Native Image inputs", async t => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-sign-native-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = { binaryDir: join(root, "build"), stageDir: join(root, "stage") };
  await Promise.all([mkdir(inputs.binaryDir), mkdir(inputs.stageDir)]);
  const pe = library => {
    const bytes = Buffer.alloc(4096); bytes.write("MZ"); bytes.writeUInt32LE(128, 60);
    bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(library ? 0x2000 : 0, 150);
    return bytes;
  };
  for (const name of ["kcoder.exe", "kcoder-process-supervisor.exe"]) await writeFile(join(inputs.stageDir, name), pe(false));
  await writeFile(join(inputs.stageDir, "kcoder-native-storage.node"), pe(true));
  const library = join(inputs.binaryDir, "kcoder_native_image.dll"); await writeFile(library, pe(true));
  const paths = [], options = { signtoolOptions: { signingHashAlgorithms: ["sha256"] } };
  const context = { packager: { config: { extraMetadata: { retained: true } }, platformSpecificBuildOptions: options,
    signingManager: { value: Promise.resolve({ signFile: async input => {
      assert.equal(input.options, options); paths.push(input.path); await appendFile(input.path, "signed-fixture"); return true;
    } }) } } };
  const pin = await stageWindowsSignedNativeInputs(context, inputs, { enabled: true });
  for (const path of paths) {
    const inside = relative(inputs.stageDir, path);
    assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep), 'Only owned staging copies may be signed');
  }
  assert.deepEqual(paths.map(path => basename(path)),
    ["kcoder.exe", "kcoder-process-supervisor.exe", "kcoder-native-image.node", "kcoder-native-storage.node"]);
  assert.notEqual(paths[2], join(inputs.stageDir, 'kcoder-native-image.node'), 'The image addon must finish signing before its publish slot changes');
  const sha = async name => createHash("sha256").update(await readFile(join(inputs.stageDir, name))).digest("hex");
  assert.equal(pin.programSha256, await sha("kcoder.exe"));
  assert.equal(pin.addonSha256, await sha("kcoder-native-image.node"));
  assert.deepEqual(context.packager.config.extraMetadata, { retained: true, nativeWindowsComponentImage: pin });
  assert.deepEqual(await readFile(library), pe(true), "The original build output must not be signed in place");
  context.packager.signingManager.value = Promise.resolve({ signFile: async () => false });
  await assert.rejects(stageWindowsSignedNativeInputs(context, inputs, { enabled: true }), /signing did not complete/);
});

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
  const identity = probeGitIdentity(fileURLToPath(new URL("../../..", import.meta.url)));
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
