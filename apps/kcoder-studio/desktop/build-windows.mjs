import { stageNativeWindowsComponentImage } from './native-component-image.mjs';
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageComputerUseRuntime, verifyComputerUseRuntime } from "../../../scripts/release/stage-computer-use.mjs";
import { stageDesktopResources } from "./stage-desktop-resources.mjs";
import releaseArtifactHook from "./release-artifact-hook.mjs";
import { loadWindowsSigningConfiguration, runWithWindowsSigning, verifyWindowsSigningTool } from "../../../scripts/release/windows-signing-config.mjs";
import { checkClientVersion } from "../../../scripts/release/client-version.mjs";

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
  await run("cargo", ["build", "--release", "--locked", "--manifest-path", resolve(repoRoot, "Cargo.toml"),
    "--target", inputs.target, "-p", "kcoder_cli", "--bin", "kcoder", "-p", "kcoder_process_supervisor", "--bin", "kcoder-process-supervisor"], repoRoot, env);
  await mkdir(inputs.stageDir, { recursive: true });
  for (const name of ["kcoder.exe", "kcoder-process-supervisor.exe"]) {
    const source = resolve(inputs.binaryDir, name);
    await assertWindowsX64Executable(source);
    await copyFile(source, resolve(inputs.stageDir, name));
  }
  await run("cargo", ["build", "--release", "--locked", "--manifest-path", resolve(repoRoot, "Cargo.toml"),
    "--target", inputs.target, "-p", "kcoder_process_supervisor", "--lib", "--features", "native-image-addon"], repoRoot, env);
  const nativeImagePin = await stageNativeWindowsComponentImage({
    library:resolve(inputs.binaryDir, "kcoder_process_supervisor.dll"), destination:inputs.stageDir,
  });
  const { build, Platform, Arch } = await import("electron-builder");
  await runWithWindowsSigning(signing, signingOptions => build({
    projectDir: studioRoot, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never",
    config: { ...windowsPackConfig(stageDesktopResources, releaseArtifactHook, env, nativeImagePin), ...signingOptions },
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindows().catch(error => { console.error(error.message); process.exitCode = 1; });
}
