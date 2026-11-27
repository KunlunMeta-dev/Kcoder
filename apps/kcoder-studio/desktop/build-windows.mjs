import { stageNativeWindowsComponentImage } from './native-component-image.mjs';
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageComputerUseRuntime, verifyComputerUseRuntime } from "../../../scripts/release/stage-computer-use.mjs";
import { stageDesktopResources } from "./stage-desktop-resources.mjs";
import releaseArtifactHook from "./release-artifact-hook.mjs";
import { loadWindowsSigningConfiguration, runWithWindowsSigning, verifyWindowsSigningTool } from "../../../scripts/release/windows-signing-config.mjs";
import { checkClientVersion } from "../../../scripts/release/client-version.mjs";
import { buildNativeCli, cliReleaseIdentity, stageBuiltCli } from "../../../scripts/release/cli-native-build.mjs";

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(studioRoot, "../..");

export function windowsComputerUseInputs(env = process.env) {
  if (!/^[a-f0-9]{64}$/.test(env.KCODER_COMPUTER_USE_INVENTORY_SHA256 ?? "")) {
    throw new Error("Full Windows installers require Computer Use resources: prepare them with scripts/computer-use/build-runtime.ps1 and set KCODER_COMPUTER_USE_INVENTORY_SHA256 to the trusted files.sha256.json digest");
  }
  return {
    source: resolve(repoRoot, env.KCODER_COMPUTER_USE_RUNTIME || "target/packages/kcoder-studio/windows-input/computer-use"),
    expectedHash: env.KCODER_COMPUTER_USE_INVENTORY_SHA256,
    // Evaluation builds must still explicitly acknowledge prototype resources.
    allowPrototype: env.KCODER_COMPUTER_USE_ALLOW_PROTOTYPE === "1",
  };
}

export function windowsPackConfig(stage = stageDesktopResources, audit = releaseArtifactHook, env = process.env, nativeImagePin, stageComputerUse = stageComputerUseRuntime) {
  const computerUse = windowsComputerUseInputs(env);
  return {
    // The external Gateway ships portable dependencies; Electron uses built-ins only.
    npmRebuild: false,
    ...(nativeImagePin ? {extraMetadata:{nativeWindowsComponentImage:nativeImagePin}} : {}),
    directories: { output: resolve(repoRoot, "target/packages/kcoder-studio/windows") },
    beforePack: async context => { await stage(context); },
    afterPack: async context => {
      await stageComputerUse({ ...computerUse,
        destination: resolve(context.appOutDir, "resources/computer-use"),
      });
      return audit(context);
    },
  };
}

export function windowsBuildInputs(env = process.env, platform = process.platform) {
  const target = env.KCODER_WINDOWS_TARGET || (platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-pc-windows-gnu");
  if (!["x86_64-pc-windows-gnu", "x86_64-pc-windows-msvc"].includes(target)) {
    throw new Error("Windows desktop packaging requires an x86_64 Windows Rust target");
  }
  const targetDir = resolve(repoRoot, env.CARGO_TARGET_DIR || "target");
  return { target, binaryDir: resolve(targetDir, target, "release"),
    stageDir: resolve(repoRoot, "target/packages/kcoder-studio/windows-input/bin") };
}

export function windowsCargoBuildArgs(target, manifestPath = resolve(repoRoot, "Cargo.toml")) {
  // The addon is a separate cdylib with no dependency on the CLI or supervisor.
  // Building it cannot switch the feature set of the CLI's process library.
  return ["build", "--release", "--locked", "--manifest-path", manifestPath,
    "--target", target, "-p", "kcoder_cli",
    "-p", "kcoder_process_supervisor",
    "-p", "kcoder_native_image"];
}

export async function assertWindowsX64Executable(path) {
  const file = await open(path, "r");
  try {
    const dos = Buffer.alloc(64);
    const { bytesRead } = await file.read(dos, 0, dos.length, 0);
    if (bytesRead !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not a Windows executable: ${path}`);
    const pe = Buffer.alloc(6);
    await file.read(pe, 0, pe.length, dos.readUInt32LE(60));
    if (pe.toString("ascii", 0, 4) !== "PE\0\0" || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error(`Not a Windows x64 PE executable: ${path}`);
    }
  } finally {
    await file.close();
  }
}

// Cargo may publish its DLL with a second hard link in deps/. Copy from a
// held regular-file descriptor into an owned single-link input before sealing.
async function withOwnedCargoNativeCopy(sourcePath, stageDir, callback) {
  const input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let stage, owner, output, failure, result, published = false;
  const same = (a, b) => b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  try {
    const initial = await input.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink < 1n || initial.size > 1024n * 1024n * 1024n
        || !same(initial, await lstat(sourcePath, { bigint: true }))) throw new Error('Invalid Cargo Native addon input');
    stage = await mkdtemp(resolve(stageDir, '.cargo-native-input-'));
    owner = await lstat(stage, { bigint: true });
    const privatePath = resolve(stage, 'cargo-native.dll');
    output = await open(privatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.alloc(1024 * 1024); let total = 0n;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += BigInt(bytesRead);
      if (total > initial.size) throw new Error('Cargo Native addon changed during staging');
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
        if (!bytesWritten) throw new Error('Cargo Native addon staging made no progress');
        offset += bytesWritten;
      }
    }
    await output.sync(); await output.close(); output = undefined;
    if (total !== initial.size || !same(initial, await input.stat({ bigint: true }))
        || !same(initial, await lstat(sourcePath, { bigint: true }))) throw new Error('Cargo Native addon changed during staging');
    result = await callback(privatePath); published = true;
  } catch (error) { failure = error; }
  const cleanupFailures = [];
  for (const cleanup of [
    async () => { if (output) await output.close(); },
    async () => { await input.close(); },
    async () => {
      if (!stage) return;
      const current = await lstat(stage, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !owner || current.dev !== owner.dev || current.ino !== owner.ino) {
        throw new Error('Cargo Native addon staging ownership changed');
      }
      await rm(stage, { recursive: true });
    },
  ]) {
    try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length) {
    const cleanupError = new AggregateError(cleanupFailures, 'Cargo Native addon staging cleanup failed');
    if (failure) { failure.cleanupError = cleanupError; failure.cleanupUnconfirmed = true; }
    else throw Object.assign(new Error('Cargo Native addon staging cleanup is unconfirmed'), { published, cleanupUnconfirmed: true, cause: cleanupError });
  }
  if (failure) throw failure;
  return result;
}

/** Sign only owned staging copies, before ASAR metadata and resource manifests are sealed. */
export async function stageWindowsSignedNativeInputs(context, inputs, signing) {
  if (!signing.enabled && signing.allowUnsigned !== true) throw new Error('Unsigned native inputs require explicit local-development authorization');
  const manager = signing.enabled ? await context.packager.signingManager.value : null;
  const signFile = async path => {
    if (!signing.enabled) return;
    const signed = await manager.signFile({ path, options: context.packager.platformSpecificBuildOptions });
    if (signed !== true) throw new Error('Windows native resource signing did not complete; refusing package creation');
  };
  for (const name of ["kcoder.exe", "kcoder-process-supervisor.exe"]) {
    const path = resolve(inputs.stageDir, name);
    await assertWindowsX64Executable(path);
    await signFile(path);
  }
  const pin = await withOwnedCargoNativeCopy(
    resolve(inputs.binaryDir, "kcoder_native_image.dll"), inputs.stageDir,
    library => stageNativeWindowsComponentImage({ library, destination: inputs.stageDir, signFile }),
  );
  await signFile(resolve(inputs.stageDir, 'kcoder-native-storage.node'));
  context.packager.config.extraMetadata = { ...context.packager.config.extraMetadata, nativeWindowsComponentImage: pin };
  return pin;
}

async function run(command, args, cwd, env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${code})`)));
  });
}

/**
 * Resolves the build identity injected into the cargo environment so the
 * packaged CLI reports a real `doctor` build commit instead of a stale or
 * failed `git rev-parse` captured by an earlier build-script run. Explicit
 * environment values win; a failing probe falls back to the same
 * "unknown"/dirty=true semantics build.rs uses.
 */
export function windowsBuildEnv(env = {}, probe = null) {
  const hasCommit = Boolean((env.KCODER_BUILD_COMMIT || "").trim());
  const hasDirty = env.KCODER_BUILD_DIRTY != null && env.KCODER_BUILD_DIRTY !== "";
  // Probe git lazily: an explicit environment must not invoke git at all.
  const identity = hasCommit && hasDirty ? { commit: null, dirty: null }
    : probe ? probe() : { commit: null, dirty: null };
  const commit = hasCommit ? env.KCODER_BUILD_COMMIT.trim()
    : (identity.commit || "").trim() || "unknown";
  const dirty = hasDirty
    ? ["1", "true"].includes(env.KCODER_BUILD_DIRTY.trim().toLowerCase())
    : identity.dirty == null ? true : Boolean(identity.dirty);
  return {
    ...env,
    KCODER_BUILD_COMMIT: commit,
    KCODER_BUILD_DIRTY: dirty ? "true" : "false",
    KCODER_BUILD_TIME_UNIX: env.KCODER_BUILD_TIME_UNIX || env.SOURCE_DATE_EPOCH || "0",
  };
}

export function probeGitIdentity(repoRoot) {
  const run = args => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return ""; }
  };
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain", "--untracked-files=no"]);
  return { commit: commit || null, dirty: status ? true : status === "" ? false : null };
}

export async function buildWindows() {
  await checkClientVersion(repoRoot);
  const signing = await loadWindowsSigningConfiguration(repoRoot);
  await verifyWindowsSigningTool(signing);
  const inputs = windowsBuildInputs();
  const env = windowsBuildEnv(process.env, () => probeGitIdentity(repoRoot));
  delete env.KCODER_WINDOWS_CERTIFICATE_PASSWORD;
  delete env.WIN_CSC_KEY_PASSWORD;
  const computerUse = windowsComputerUseInputs(env);
  const verified = await verifyComputerUseRuntime(computerUse.source, computerUse.expectedHash);
  if (!computerUse.allowPrototype && verified.status !== "release-ready") {
    throw new Error("Computer Use runtime has not passed release readiness audit; evaluation builds require KCODER_COMPUTER_USE_ALLOW_PROTOTYPE=1");
  }
  if (inputs.target === "x86_64-pc-windows-gnu" && process.platform !== "win32") {
    env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ||= "x86_64-w64-mingw32-gcc";
  }
  // Invoke JavaScript build entries directly; Windows .cmd wrappers and spaced
  // executable paths must not require shell interpolation.
  const rendererRoot = resolve(studioRoot, "renderer");
  const rendererRequire = createRequire(resolve(rendererRoot, "package.json"));
  const tsc = resolve(dirname(rendererRequire.resolve("typescript/package.json")), "bin/tsc");
  const vite = resolve(dirname(rendererRequire.resolve("vite/package.json")), "bin/vite.js");
  await run(process.execPath, [tsc, "-b"], rendererRoot, env);
  await run(process.execPath, [vite, "build"], rendererRoot, env);
  const native = await buildNativeCli(windowsCargoBuildArgs(inputs.target), { root: repoRoot, env });
  await mkdir(inputs.stageDir, { recursive: true });
  await assertWindowsX64Executable(native.executable);
  await stageBuiltCli(native, resolve(inputs.stageDir, 'kcoder.exe'), await cliReleaseIdentity(repoRoot, env));
  for (const name of ["kcoder-process-supervisor.exe"]) {
    const source = resolve(inputs.binaryDir, name);
    await assertWindowsX64Executable(source);
    await copyFile(source, resolve(inputs.stageDir, name));
  }
  const { build, Platform, Arch } = await import("electron-builder");
  const stageSignedResources = async context => {
    await stageDesktopResources(context, { env });
    await stageWindowsSignedNativeInputs(context, inputs, signing);
  };
  await runWithWindowsSigning(signing, signingOptions => build({
    projectDir: studioRoot, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never",
    config: { ...windowsPackConfig(stageSignedResources, releaseArtifactHook, env), ...signingOptions },
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindows().catch(error => { console.error(error.message); process.exitCode = 1; });
}
