import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageDesktopResources } from "./stage-desktop-resources.mjs";
import releaseArtifactHook from "./release-artifact-hook.mjs";

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(studioRoot, "../..");

export function windowsPackConfig(stage = stageDesktopResources, audit = releaseArtifactHook) {
  return {
    // The external Gateway ships portable dependencies; Electron uses built-ins only.
    npmRebuild: false,
    directories: { output: resolve(repoRoot, "target/packages/kcoder-studio/windows") },
    beforePack: async context => { await stage(context); },
    afterPack: audit,
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
    KCODER_BUILD_TIME_UNIX: env.KCODER_BUILD_TIME_UNIX || String(Math.floor(Date.now() / 1000)),
  };
}

export function probeGitIdentity(repoRoot) {
  const run = args => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return ""; }
  };
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain", "--untracked-files=no"]);
  return { commit: commit || null, dirty: status ? true : status === "" ? false : null };
}

export async function buildWindows() {
  const inputs = windowsBuildInputs();
  const env = windowsBuildEnv(process.env, () => probeGitIdentity(repoRoot));
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
  const { build, Platform, Arch } = await import("electron-builder");
  await build({ projectDir: studioRoot, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never",
    config: windowsPackConfig() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindows().catch(error => { console.error(error.message); process.exitCode = 1; });
}
