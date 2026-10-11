import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMacX64Executable } from '../../../scripts/release/mac-executable.mjs';
export { assertMacX64Executable } from '../../../scripts/release/mac-executable.mjs';
import { stageDesktopResources } from './stage-desktop-resources.mjs';
import releaseArtifactHook from './release-artifact-hook.mjs';
import { windowsBuildEnv as buildIdentityEnv, probeGitIdentity } from './build-windows.mjs';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(studioRoot, '../..');

export function macBuildInputs(env = process.env, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'x64') throw new Error('macOS Intel packaging requires a native x64 macOS build host');
  const target = env.KCODER_MACOS_TARGET || 'x86_64-apple-darwin';
  if (target !== 'x86_64-apple-darwin') throw new Error('macOS Intel packaging requires the x86_64-apple-darwin Rust target');
  return {
    target,
    binaryDir: resolve(repository, env.CARGO_TARGET_DIR || 'target', target, 'release'),
    stageDir: resolve(repository, 'target/packages/kcoder-studio/macos-input/bin'),
  };
}

export function macPackConfig(stage = stageDesktopResources, audit = releaseArtifactHook, options = {}) {
  return {
    npmRebuild: false,
    directories: { output: resolve(repository, 'target/packages/kcoder-studio/macos') },
    mac: {
      identity: null,
      minimumSystemVersion: '15.7',
      icon: 'renderer/src-tauri/icons/icon.icns',
      target: [{ target: 'dmg', arch: ['x64'] }],
      artifactName: 'KCoder-Studio-${version}-mac-${arch}.${ext}',
      extraResources: [
        { from: resolve(repository, 'target/packages/kcoder-studio/macos-input/bin/kcoder'), to: 'bin/kcoder' },
        { from: resolve(repository, 'target/packages/kcoder-studio/macos-input/bin/chrome'), to: 'bin/chrome' },
        { from: resolve(repository, 'target/packages/kcoder-studio/macos-input/bin/pdf'), to: 'bin/pdf' },
      ],
    },
    beforePack: async context => { await stage(context); },
    afterPack: async context => { await audit(context, options); },
  };
}


async function run(command, args, cwd, env) {
  await new Promise((complete, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? complete() : reject(new Error(`${command} failed (${code})`)));
  });
}

export async function macBuildIdentity(env = process.env) {
  if (!env.KCODER_RELEASE_IDENTITY_FILE) return undefined;
  const path = resolve(env.KCODER_RELEASE_IDENTITY_FILE), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Invalid frozen macOS build identity file');
  const identity = JSON.parse(await readFile(path, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(identity.packagingSource?.commit ?? '') || typeof identity.packagingSource.dirty !== 'boolean'
    || identity.versions?.studio !== JSON.parse(await readFile(resolve(studioRoot, 'package.json'), 'utf8')).version) throw new Error('Frozen macOS build identity does not match this source version');
  if (env.KCODER_BUILD_COMMIT && env.KCODER_BUILD_COMMIT !== identity.packagingSource.commit) throw new Error('macOS sidecar and package must use the same frozen commit');
  return identity;
}

export async function buildMac() {
  const inputs = macBuildInputs();
  const identity = await macBuildIdentity();
  const env = buildIdentityEnv({ ...process.env, ...(identity ? { KCODER_BUILD_COMMIT: identity.packagingSource.commit, KCODER_BUILD_DIRTY: String(identity.packagingSource.dirty) } : {}), CSC_IDENTITY_AUTO_DISCOVERY: 'false', MACOSX_DEPLOYMENT_TARGET: '15.7' }, () => probeGitIdentity(repository));
  const rendererRoot = resolve(studioRoot, 'renderer');
  const require = createRequire(resolve(rendererRoot, 'package.json'));
  await run(process.execPath, [resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '-b'], rendererRoot, env);
  await run(process.execPath, [resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], rendererRoot, env);
  await run('cargo', ['build', '--release', '--locked', '--manifest-path', resolve(repository, 'Cargo.toml'), '--target', inputs.target,
    '-p', 'kcoder_cli', '--bin', 'kcoder'], repository, env);
  await mkdir(inputs.stageDir, { recursive: true });
  const source = resolve(inputs.binaryDir, 'kcoder');
  await assertMacX64Executable(source);
  const staged = resolve(inputs.stageDir, 'kcoder');
  await copyFile(source, staged);
  await chmod(staged, 0o755);
  const { build, Platform, Arch } = await import('electron-builder');
  await build({ projectDir: studioRoot, targets: Platform.MAC.createTarget(['dmg'], Arch.x64), publish: 'never', config: macPackConfig(undefined, undefined, identity ? { identity } : {}) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMac().catch(error => { console.error(error.message); process.exitCode = 1; });
}
