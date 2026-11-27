import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertMacExecutable } from '../../../scripts/release/mac-executable.mjs';
import { macTarget } from '../../../scripts/release/mac-target.mjs';
import { checkClientVersion } from '../../../scripts/release/client-version.mjs';
import { cargoPackageVersion } from '../../../scripts/release/artifact-manifest.mjs';
export { assertMacX64Executable } from '../../../scripts/release/mac-executable.mjs';
import { stageDesktopResources } from './stage-desktop-resources.mjs';
import releaseArtifactHook from './release-artifact-hook.mjs';
import { macApplicationPath, normalizeMacApplicationPermissions, verifyMacReleaseManifest } from './mac-artifact-layout.mjs';
import { windowsBuildEnv as buildIdentityEnv } from './build-windows.mjs';
import { withFrozenMacSnapshot, runFrozenOwned } from './mac-frozen-snapshot.mjs';
import { desktopRelayBuildDefaults } from './relay-build-defaults.mjs';
import { buildNativeCli, cliReleaseIdentity, stageBuiltCli } from '../../../scripts/release/cli-native-build.mjs';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(studioRoot, '../..');

export function macBuildInputs(env = process.env, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') throw new Error('macOS packaging requires a native x64 macOS or arm64 macOS build host');
  const native = macTarget(arch);
  const target = env.KCODER_MACOS_TARGET || native.target;
  if (target !== native.target) throw new Error(`macOS ${arch} packaging requires the ${native.target} Rust target`);
  return {
    ...native, target,
    binaryDir: resolve(repository, env.CARGO_TARGET_DIR || 'target', target, 'release'),
    stageDir: resolve(repository, 'target/packages/kcoder-studio', native.stage, 'bin'),
  };
}

export async function finalizeMacSignature(context, options = {}) {
  const bundle = macApplicationPath(context);
  // The manifest is now final. Reseal only the outer bundle, preserving the
  // Electron entitlements and the already signed nested code/resource bytes.
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none',
    '--preserve-metadata=identifier,entitlements,flags', bundle], undefined, process.env);
  // Staging may inherit umask 077. Set only bundle permission bits after all
  // writers finish, then verify that the sealed application is still intact.
  await normalizeMacApplicationPermissions(bundle, options);
  await verifyMacReleaseManifest(bundle, options);
}

export function macPackConfig(stage = stageDesktopResources, audit = releaseArtifactHook, options = {}, finalize = finalizeMacSignature) {
  const target = macTarget(options.arch ?? process.arch);
  const inputRoot = resolve(repository, 'target/packages/kcoder-studio', target.stage);
  return {
    npmRebuild: false,
    directories: { output: resolve(repository, 'target/packages/kcoder-studio/macos') },
    mac: {
      identity: '-',
      hardenedRuntime: false,
      notarize: false,
      gatekeeperAssess: false,
      strictVerify: true,
      preAutoEntitlements: false,
      timestamp: 'none',
      // These sealed dependencies retain their verified upstream bytes. The
      // outer application signature covers them as resources.
      signIgnore: ['(^|/)Contents/Resources(/|$)'],
      minimumSystemVersion: '15.7',
      icon: 'desktop/icons/icon.icns',
      target: [{ target: 'dmg', arch: [target.arch] }],
      artifactName: 'KCoder-Studio-${version}-mac-${arch}.${ext}',
      extraResources: [
        { from: resolve(inputRoot, 'bin/kcoder'), to: 'bin/kcoder' },
        { from: resolve(inputRoot, 'bin/kcoder-native-storage.node'), to: 'bin/kcoder-native-storage.node' },
        { from: resolve(inputRoot, 'bin/chrome'), to: 'bin/chrome' },
        { from: resolve(inputRoot, 'bin/pdf'), to: 'bin/pdf' },
        { from: resolve(inputRoot, 'searxng'), to: 'searxng' },
        { from: resolve(inputRoot, 'lark-cli'), to: 'lark-cli' },
        { from: resolve(inputRoot, 'channel'), to: 'kcoder-channel-host', filter: ['**/*', '!node_modules{,/**/*}'] },
        { from: resolve(inputRoot, 'channel/node_modules'), to: 'kcoder-channel-host/node_modules', filter: ['**/*', '**/.*'] },
        { from: resolve(inputRoot, 'computer-use'), to: 'computer-use' },
      ],
    },
    beforePack: async context => { await stage(context); },
    // Override the shared package.json hook; macOS must audit after signing.
    afterPack: null,
    afterSign: async context => {
      const signedOptions = { ...options, codeSigning: 'ad-hoc' };
      await audit(context, signedOptions);
      await finalize(context, signedOptions);
    },
  };
}


async function run(command, args, cwd, env) {
  await new Promise((complete, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? complete() : reject(new Error(`${command} failed (${code})`)));
  });
}

function probeMacSource({ includeUntracked = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = args => execFileSync('git', args, { cwd: repository, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    // Git must describe this build root, not an ancestor of an extracted archive.
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(repository)) throw new Error('source root mismatch');
    const commit = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('source commit unavailable');
    const statusArgs = ['status', '--porcelain', includeUntracked ? '--untracked-files=all' : '--untracked-files=no'];
    let dirty = Boolean(git(statusArgs));
    if (includeUntracked) {
      const entries = git(['ls-files', '-v', '-z']).split('\0').filter(Boolean);
      if (!entries.length || entries.some(row => !row.startsWith('H '))) throw new Error('source index has hidden or unverified files');
      dirty ||= Boolean(git(statusArgs));
    }
    if (git(['rev-parse', 'HEAD']) !== commit || realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(repository)) {
      throw new Error('source identity changed while probing');
    }
    return { commit, dirty };
  } catch {
    throw new Error('Cannot verify the current macOS source Git checkout; an archive needs independently verified source provenance');
  }
}

export function macDevelopmentIdentity(probe = probeMacSource) {
  try { return probe(); }
  catch { return { commit: null, dirty: true }; }
}

async function readMacFrozenIdentity(path) {
  const maximum = 1024 * 1024;
  const canonical = await realpath(path);
  const before = await lstat(path, { bigint: true });
  const same = (left, right) => right.isFile() && right.nlink === 1n && right.ino !== 0n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino === 0n || before.size > BigInt(maximum)) throw new Error('Invalid frozen macOS build identity file');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const held = await handle.stat({ bigint: true });
    if (!same(before, held)) throw new Error('Frozen macOS build identity changed before reading');
    const chunks = [], buffer = Buffer.alloc(Math.min(65536, maximum + 1)); let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maximum + 1 - size), null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum) throw new Error('Invalid frozen macOS build identity file');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (BigInt(size) !== held.size || !same(held, await handle.stat({ bigint: true })) ||
        !same(held, await lstat(path, { bigint: true })) || await realpath(path) !== canonical) {
      throw new Error('Frozen macOS build identity changed while reading');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  } finally { await handle.close(); }
}

export async function macBuildIdentity(env = process.env, probe = probeMacSource) {
  if (!env.KCODER_RELEASE_IDENTITY_FILE) return undefined;
  const path = resolve(env.KCODER_RELEASE_IDENTITY_FILE);
  const identity = await readMacFrozenIdentity(path);
  if (!/^[a-f0-9]{40}$/.test(identity.packagingSource?.commit ?? '') || typeof identity.packagingSource.dirty !== 'boolean'
    || identity.versions?.studio !== JSON.parse(await readFile(resolve(studioRoot, 'package.json'), 'utf8')).version
    || identity.versions.cli !== cargoPackageVersion(await readFile(resolve(repository, 'crates/kcoder_cli/Cargo.toml'), 'utf8'), await readFile(resolve(repository, 'Cargo.toml'), 'utf8'))) throw new Error('Frozen macOS build identity does not match this source version');
  if (identity.packagingSource.dirty) throw new Error('A dirty macOS source cannot be verified by the frozen release identity');
  const source = probe({ includeUntracked: true });
  if (source.commit !== identity.packagingSource.commit || source.dirty !== identity.packagingSource.dirty) throw new Error('Frozen macOS build identity does not match the current source checkout');
  if (env.KCODER_BUILD_COMMIT && env.KCODER_BUILD_COMMIT !== identity.packagingSource.commit) throw new Error('macOS sidecar and package must use the same frozen commit');
  return identity;
}

export async function assertMacFrozenIdentityUnchanged(expected, env = process.env, readIdentity = macBuildIdentity) {
  if (JSON.stringify(await readIdentity(env)) !== expected) throw new Error('Frozen macOS build identity changed during packaging');
}

async function buildMacPhases() {
  await checkClientVersion(repository);
  const inputs = macBuildInputs();
  const identity = await macBuildIdentity();
  const frozenIdentity = identity ? JSON.stringify(identity) : null;
  const recheckIdentity = async () => {
    if (frozenIdentity !== null) await assertMacFrozenIdentityUnchanged(frozenIdentity);
  };
  const env = buildIdentityEnv({ ...process.env, ...(identity ? { KCODER_BUILD_COMMIT: identity.packagingSource.commit, KCODER_BUILD_DIRTY: String(identity.packagingSource.dirty) } : {}), CSC_IDENTITY_AUTO_DISCOVERY: 'false', MACOSX_DEPLOYMENT_TARGET: '15.7' }, macDevelopmentIdentity);
  const rendererRoot = resolve(studioRoot, 'renderer');
  const require = createRequire(resolve(rendererRoot, 'package.json'));
  await run(process.execPath, [resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '-b'], rendererRoot, env);
  await recheckIdentity();
  await run(process.execPath, [resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], rendererRoot, env);
  await recheckIdentity();
  const native = await buildNativeCli(['build', '--release', '--locked', '--manifest-path', resolve(repository, 'Cargo.toml'), '--target', inputs.target,
    '-p', 'kcoder_cli', '--bin', 'kcoder'], { root: repository, env });
  await recheckIdentity();
  await mkdir(inputs.stageDir, { recursive: true });
  const source = resolve(inputs.binaryDir, 'kcoder');
  await assertMacExecutable(source, inputs.arch);
  const staged = resolve(inputs.stageDir, 'kcoder');
  await stageBuiltCli(native, staged, await cliReleaseIdentity(repository, env));
  await chmod(staged, 0o755);
  // Metadata changes invalidate the linker's ad-hoc seal; sign the owned copy
  // before resource inventory. Cargo's original executable remains untouched.
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', staged], repository, env);
  const { build, Platform, Arch } = await import('electron-builder');
  await build({ projectDir: studioRoot, targets: Platform.MAC.createTarget(['dmg'], Arch[inputs.arch]), publish: 'never', config: macPackConfig(context => stageDesktopResources(context, { env }), undefined, { arch: inputs.arch, ...(identity ? { identity } : {}) }) });
  await recheckIdentity();
}


async function assertFrozenDirectoryIdentity(path, expected) {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink()
      || (expected && (current.dev !== expected.dev || current.ino !== expected.ino))
      || await realpath(path) !== path) {
    throw new Error('Frozen macOS output directory identity changed');
  }
  return current;
}

async function assertOutputLinksContained(root, checkout, expectedRoot) {
  const canonicalCheckout = await realpath(checkout);
  let ancestor = canonicalCheckout;
  for (const part of ['target', 'packages', 'kcoder-studio', 'macos']) {
    ancestor = join(ancestor, part);
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Frozen macOS output ancestor is not an owned directory');
  }
  const rootIdentity = await assertFrozenDirectoryIdentity(root, expectedRoot);
  const canonicalRoot = await realpath(root);
  const outputRelative = relative(canonicalCheckout, canonicalRoot);
  if (isAbsolute(outputRelative) || outputRelative === '..' || outputRelative.startsWith(`..${sep}`)) throw new Error('Frozen macOS output escaped its checkout');
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (isAbsolute(await readlink(path))) throw new Error('Frozen macOS output contains an absolute link');
        const target = await realpath(path);
        const rel = relative(canonicalRoot, target);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Frozen macOS output link escapes its build');
      } else if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw new Error('Frozen macOS output contains a special file');
    }
  }
  await visit(canonicalRoot);
  await assertFrozenDirectoryIdentity(root, rootIdentity);
  return rootIdentity;
}

async function ensureFrozenOutputParent(sourceRoot) {
  let directory = await realpath(sourceRoot);
  for (const part of ['target', 'packages', 'kcoder-studio', 'macos']) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error('Frozen macOS publication ancestor is not an owned directory');
    }
  }
  return directory;
}

export async function buildFrozenMac(identity, { sourceRoot = repository, environment = process.env } = {}) {
  const relay = desktopRelayBuildDefaults(environment, resolve(sourceRoot, '.env'));
  return withFrozenMacSnapshot({ sourceRoot, commit: identity.packagingSource.commit, env: environment }, async ({ root, checkout }) => {
    const identityFile = join(root, 'frozen-identity.json');
    await writeFile(identityFile, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith('GIT_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
    Object.assign(env, { KCODER_RELEASE_IDENTITY_FILE: identityFile, CARGO_TARGET_DIR: join(checkout, 'target') });
    if (relay.relayPublicUrl) env.KCODER_STUDIO_DESKTOP_RELAY_URL = relay.relayPublicUrl;
    for (const args of [
      ['--dir', join(checkout, 'apps/kcoder-studio'), 'install', '--offline', '--frozen-lockfile'],
      ['--dir', join(checkout, 'apps/kcoder-studio/renderer'), 'install', '--offline', '--frozen-lockfile'],
      ['--dir', join(checkout, 'apps/kcoder-studio/skill-runtime'), 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
    ]) await runFrozenOwned('pnpm', args, { cwd: checkout, env });
    await runFrozenOwned('npm', ['--prefix', join(checkout, 'apps/kcoder-channel-host'), 'ci', '--offline'], { cwd: checkout, env });
    await runFrozenOwned(process.execPath, [join(checkout, 'apps/kcoder-studio/desktop/build-macos.mjs'), '--owned-frozen-child'], {
      cwd: checkout, env, handshake: { version: 1, root, checkout, sourceRoot: await realpath(sourceRoot), commit: identity.packagingSource.commit },
    });
    const output = join(checkout, 'target/packages/kcoder-studio/macos');
    const outputIdentity = await assertOutputLinksContained(output, checkout);
    const parent = await ensureFrozenOutputParent(sourceRoot);
    const parentIdentity = await assertFrozenDirectoryIdentity(parent);
    const destination = await mkdtemp(join(parent, `frozen-${identity.packagingSource.commit.slice(0, 12)}-`));
    const destinationIdentity = await assertFrozenDirectoryIdentity(destination);
    try {
      for (const entry of await readdir(output)) {
        await assertFrozenDirectoryIdentity(output, outputIdentity);
        await assertFrozenDirectoryIdentity(parent, parentIdentity);
        await assertFrozenDirectoryIdentity(destination, destinationIdentity);
        await cp(join(output, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      }
      // Certify the copied tree, not only the build output inspected before copying.
      await assertOutputLinksContained(destination, sourceRoot, destinationIdentity);
      await assertFrozenDirectoryIdentity(output, outputIdentity);
      await assertFrozenDirectoryIdentity(parent, parentIdentity);
    }
    catch (error) { throw new Error(`Frozen macOS output copy failed; partial output retained at ${destination}`, { cause: error }); }
    console.log(`Frozen macOS output: ${destination}`);
    return destination;
  });
}

export async function buildMac() {
  await checkClientVersion(repository);
  macBuildInputs();
  const identity = await macBuildIdentity();
  if (identity) return buildFrozenMac(identity);
  return buildMacPhases();
}

async function runFrozenChild() {
  if (!process.connected || !process.send) throw new Error('Frozen macOS child requires its owned parent');
  const claim = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Frozen macOS parent did not provide its checkout')), 10_000);
    process.once('message', value => { clearTimeout(timer); accept(value); });
    process.once('disconnect', () => { clearTimeout(timer); reject(new Error('Frozen macOS parent disconnected')); });
  });
  if (claim?.version !== 1 || typeof claim.root !== 'string' || typeof claim.checkout !== 'string'
      || typeof claim.sourceRoot !== 'string' || !/^[a-f0-9]{40}$/.test(claim.commit ?? '')) throw new Error('Invalid frozen macOS child checkout');
  const root = await realpath(claim.root), checkout = await realpath(claim.checkout), source = await realpath(claim.sourceRoot);
  const rootInfo = await lstat(claim.root), gitInfo = await lstat(join(checkout, '.git'));
  const fromTemp = relative(await realpath(tmpdir()), root), fromSource = relative(source, root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && rootInfo.uid !== process.getuid())
      || !/^kcoder-macos-frozen-[A-Za-z0-9]{6}$/.test(basename(root))
      || isAbsolute(fromTemp) || fromTemp === '..' || fromTemp.startsWith(`..${sep}`)
      || !fromSource || (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`))
      || checkout !== await realpath(repository) || checkout !== join(root, 'source')
      || !gitInfo.isDirectory() || gitInfo.isSymbolicLink()
      || resolve(process.env.KCODER_RELEASE_IDENTITY_FILE ?? '') !== join(root, 'frozen-identity.json')) {
    throw new Error('Frozen macOS child requires a private owned source snapshot');
  }
  process.disconnect();
  const identity = await macBuildIdentity();
  if (!identity || identity.packagingSource.commit !== claim.commit) throw new Error('Frozen macOS child identity mismatch');
  return buildMacPhases();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const task = process.argv[2] === '--owned-frozen-child' ? runFrozenChild() : buildMac();
  task.catch(error => { if (process.connected) process.disconnect(); console.error(error.message); if (error.ownedSnapshot) console.error(`Owned snapshot retained for reconciliation: ${error.ownedSnapshot}`); process.exitCode = error.interruptedSignal === 'SIGINT' ? 130 : error.interruptedSignal === 'SIGTERM' ? 143 : 1; });
}
