// Runs the fixed Debug/Release instances using existing Studio and Relay entry points.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { systemdQuote } from '../../apps/kcoder-relay/src/local-update-files.mjs';
import { createRelayUrls } from '../../apps/kcoder-relay/deploy/config.mjs';
import { prepareInstanceIdentityFile, readRegisteredClientId, resolveIdentityFile } from '../../apps/kcoder-relay/src/client-identity.mjs';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const [profile, action, option, ...extra] = process.argv.slice(2);
const valid = { dev: ['build', 'configure', 'start', 'stop', 'status'], release: ['build', 'install', 'start', 'stop', 'status', 'upgrade'] };
if (!Object.hasOwn(valid, profile) || !valid[profile].includes(action)) {
  console.error('Usage: node scripts/launch/studio-workspace.mjs dev|release build|start|stop|status');
  console.error('Dev also supports configure. Release build/install/start take a ref. Start accepts --relay.');
  console.error('Release upgrade forwards explicit options to Relay update-local.');
  process.exit(2);
}

const debug = profile === 'dev';
const checkout = join(root, 'target/worktree', debug ? 'dev' : 'stable');
const source = debug ? root : checkout;
const target = join(checkout, 'target');
const binary = join(target, debug ? 'debug/kcoder' : 'release/kcoder');
const instance = `kcoder-workspace-${createHash('sha256').update(root).digest('hex').slice(0, 12)}-${profile}`;
const state = debug ? join(target, 'studio') : join(homedir(), '.config/kcoder-studio', instance);
const dotenv = join(root, '.env');
const launchConfig = dotenv;
const releaseHome = !debug && existsSync(dotenv) ? parseEnv(readFileSync(dotenv, 'utf8')).KCODER_WORKSPACE_RELEASE_HOME : undefined;
const home = debug ? join(target, 'home') : resolve(homedir(), releaseHome || '.config/kcoder');
const studio = join(source, 'apps/kcoder-studio');
const gatewayUnit = `${instance}-gateway.service`;
const clientUnit = `${instance}-relay.service`;
const units = [clientUnit, gatewayUnit];
const cleanEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${file} exited with ${result.status ?? result.error?.code ?? result.signal}`);
  return result.stdout;
}
function git(cwd, args) {
  return run('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}
function requireCheckout() {
  if (realpathSync(checkout) !== checkout || git(checkout, ['rev-parse', '--show-toplevel']) !== checkout ||
      git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) {
    throw new Error('Expected the fixed registered worktree. Create it with worktree.sh first.');
  }
}
function requireRelease(ref) {
  if (!ref || ref.startsWith('-')) throw new Error('Select an explicit release commit or tag');
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (git(checkout, ['rev-parse', 'HEAD']) !== commit || git(checkout, ['status', '--porcelain'])) {
    throw new Error('Stable worktree must be clean and checked out at the requested commit');
  }
  return commit;
}
function requireReleaseBuild() {
  const commit = requireRelease(option);
  const stamp = join(target, '.workspace-release-commit');
  const record = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : null;
  if (record?.commit !== commit || digest(binary) !== record.binarySha256 ||
      digest(join(studio, 'kcoder-release-manifest.json')) !== record.studioManifestSha256) {
    throw new Error('Build the requested stable revision first');
  }
  return record;
}
function digest(file) {
  return run('sha256sum', ['--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).slice(0, 64);
}
function releaseVersion(commit) {
  return join(homedir(), '.local/share', instance, commit);
}
async function installRelease() {
  requireCheckout();
  const record = requireReleaseBuild();
  const { commit, binarySha256, studioManifestSha256 } = record;
  if (units.some(active)) throw new Error('Stop this Release instance before reinstalling it');
  const dest = releaseVersion(commit);
  if (existsSync(dest)) {
    const installed = readInstalledRelease(commit);
    if (installed.binarySha256 !== binarySha256 || installed.studioManifestSha256 !== studioManifestSha256) {
      throw new Error('This commit already has different installed bytes');
    }
    return;
  }
  ensureDirectory(dirname(dest));
  const stage = mkdtempSync(join(dirname(dest), '.install-'));
  try {
    const runtime = join(stage, 'runtime');
    const studioRuntime = join(runtime, 'apps/kcoder-studio');
    const relayRuntime = join(runtime, 'apps/kcoder-relay');
    mkdirSync(studioRuntime, { recursive: true });
    const packJson = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], {
      cwd: studio, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [pack] = JSON.parse(packJson);
    if (typeof pack?.filename !== 'string' || basename(pack.filename) !== pack.filename || !pack.filename.endsWith('.tgz')) {
      throw new Error('Invalid Studio package name');
    }
    run('tar', ['-xf', join(stage, pack.filename), '--strip-components=1', '-C', studioRuntime]);
    const manifest = join(studioRuntime, 'kcoder-release-manifest.json');
    if (digest(manifest) !== studioManifestSha256) throw new Error('Installed Studio manifest did not match the build');
    run(process.execPath, [join(checkout, 'scripts/release/artifact-manifest.mjs'), '--verify', studioRuntime, commit]);
    const sourceTar = join(stage, 'runtime-source.tar');
    run('git', ['archive', '--format=tar', '--output', sourceTar, commit,
      'apps/kcoder-relay', 'apps/kcoder-studio/shared'], { cwd: checkout });
    run('tar', ['-xf', sourceTar, '--skip-old-files', '-C', runtime]);
    copyFileSync(join(studio, 'pnpm-lock.yaml'), join(studioRuntime, 'pnpm-lock.yaml'));
    copyFileSync(join(studio, 'pnpm-workspace.yaml'), join(studioRuntime, 'pnpm-workspace.yaml'));
    run('pnpm', ['--dir', studioRuntime, 'install', '--prod', '--frozen-lockfile']);
    run('npm', ['--prefix', relayRuntime, 'ci', '--omit=dev', '--no-audit', '--no-fund']);
    run('bash', [join(checkout, 'scripts/install/installers/cli-release.sh')], { cwd: checkout,
      env: { ...cleanEnv, KCODER_INSTALL_DIR: join(stage, 'bin'), KCODER_RELEASE_BIN: binary, KCODER_CONFIG_DIR: home } });
    if (digest(join(stage, 'bin/kcoder')) !== binarySha256) throw new Error('Installed Release binary did not match the build');
    rmSync(join(stage, pack.filename));
    rmSync(sourceTar);
    writeExclusive(join(stage, 'release.json'), JSON.stringify({ commit, binarySha256, studioManifestSha256 }) + '\n');
    renameSync(stage, dest);
    console.log(dest);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
function readInstalledRelease(commit) {
  const version = releaseVersion(commit);
  const record = JSON.parse(readFileSync(join(version, 'release.json'), 'utf8'));
  if (record.commit !== commit || digest(join(version, 'bin/kcoder')) !== record.binarySha256 ||
      digest(join(version, 'runtime/apps/kcoder-studio/kcoder-release-manifest.json')) !== record.studioManifestSha256) {
    throw new Error('Installed Release did not match its receipt');
  }
  return record;
}
function active(unit) {
  return spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit], { env: cleanEnv }).status === 0;
}
function systemctl(action, ...names) {
  run('systemctl', ['--user', action, ...names], { env: cleanEnv });
}
function launch(unit, cwd, file, args, env) {
  if (!debug) {
    const variables = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    if (/[\\\x00-\x1f\x7f]/.test(cwd)) throw new Error('Invalid systemd working directory');
    const unitPath = join(state, unit);
    const command = ['/usr/bin/env', '-i', ...variables, file, ...args].map(systemdQuote).join(' ');
    const unitFile = `[Unit]\nDescription=${unit}\nAfter=network-online.target\n\n[Service]\nType=exec\nWorkingDirectory=${cwd.replaceAll('%', '%%')}\nExecStart=${command}\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
    atomicWrite(unitPath, unitFile);
    systemctl('link', unitPath);
    systemctl('start', unit);
    return;
  }
  run('systemd-run', ['--user', '--collect', '--property=Type=exec', '--property=KillMode=control-group',
    ...(unit === gatewayUnit ? ['--property=Restart=on-failure', '--property=RestartSec=3s'] : []),
    `--unit=${unit}`, `--working-directory=${cwd}`,
    ...Object.keys(env).map(key => `--setenv=${key}`), '--', file, ...args], { env: { ...cleanEnv, ...env } });
}
function waitFor(unit, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!active(unit)) throw new Error(`${unit} exited while waiting for ${label}`);
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitForIdentity(unit, options, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!active(unit)) throw new Error(`${unit} exited while waiting for Relay registration`);
    const id = await readRegisteredClientId({ ...options, allowUnregistered: true });
    if (id) return id;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for Relay registration');
}
function httpStatus(url) {
  const result = spawnSync('curl', ['--noproxy', '*', '--max-time', '1', '--silent', '--output', '/dev/null',
    '--write-out', '%{http_code}', url], { encoding: 'utf8', env: cleanEnv });
  return Number(result.stdout) || 0;
}
function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new Error(`Expected an ordinary directory: ${path}`);
  }
}
function writeExclusive(path, data) {
  writeFileSync(path, data, { flag: 'wx' });
}
function atomicWrite(path, data) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}`;
  writeExclusive(temporary, data);
  renameSync(temporary, path);
}
function initializeFile(path, create) {
  if (!existsSync(path)) writeExclusive(path, create());
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Expected a regular single-link file: ${path}`);
  }
}
function readPorts(config) {
  const read = (key, fallback) => {
    const value = Number(config[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${key}`);
    return value;
  };
  const debugPort = read('KCODER_WORKSPACE_DEBUG_PORT', 4283);
  const releasePort = read('KCODER_WORKSPACE_RELEASE_PORT', 4383);
  if (debugPort === releasePort) throw new Error('Debug and Release Gateway ports must differ');
  return { gateway: debug ? debugPort : releasePort };
}
function readLaunchConfig() {
  if (!existsSync(launchConfig)) {
    if (!debug) return {};
    throw new Error('Create the repository root .env using .env.example before starting');
  }
  if (debug) initializeFile(launchConfig, () => '');
  const config = parseEnv(readFileSync(launchConfig, 'utf8'));
  if (debug && ['KCODER_WORKSPACE_DEBUG_HOME', 'KCODER_WORKSPACE_DEBUG_BIN', 'KCODER_NATIVE_CONNECTIVITY_BINDING_V1',
    'KCODER_RELAY_KCODER_BIN', 'KCODER_RELAY_CONFIG_DIR', 'KCODER_RELAY_SERVERS_FILE'].some(key => config[key])) {
    throw new Error('Dev paths are managed by the launcher; remove legacy Home, binary, resource and target overrides from the repository root .env');
  }
  return config;
}
function ensureDevDirectory(path, initialize = true) {
  if (existsSync(path) && lstatSync(path).dev !== lstatSync(target).dev) {
    throw new Error(`Dev data must reside on its checkout filesystem, not an external mount: ${path}`);
  }
  if (initialize) ensureDirectory(path);
  else {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path)
      throw new Error(`Recovery requires the existing directory: ${path}`);
  }
}
async function build() {
  requireCheckout();
  if (units.some(active)) throw new Error('Stop the instance before replacing its built executable');
  const commit = debug ? git(checkout, ['rev-parse', 'HEAD']) : requireRelease(option);
  const receipt = run('bash', [join(root, 'scripts/launch/worktree.sh'), 'artifact', debug ? 'operations' : 'packages', `${profile}-build`],
    { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const args = ['build', '--locked', '-p', 'kcoder_cli', '--bin', 'kcoder'];
  if (debug) args.push('-p', 'kcoder_native_storage', '--lib');
  if (!debug) args.push('--release');
  ensureDevDirectory(join(target, 'tmp'));
  const { buildNativeCli, cliReleaseIdentity, stageBuiltCli } = await import(pathToFileURL(join(checkout, 'scripts/release/cli-native-build.mjs')).href);
  const env = { ...process.env, CARGO_TARGET_DIR: join(target, 'native'), TMPDIR: join(target, 'tmp') };
  const native = await buildNativeCli(args, { root: checkout, env });
  await stageBuiltCli(native, binary, await cliReleaseIdentity(checkout, env));
  // Native child launchers reject group-writable executable files.
  for (const program of [binary, join(dirname(binary), 'kcoder-process-supervisor')]) {
    if (existsSync(program)) chmodSync(program, 0o755);
  }
  run(binary, ['--version'], { env: cleanEnv });
  if (!debug) {
    run('pnpm', ['--dir', studio, 'install', '--frozen-lockfile']);
    run('pnpm', ['--dir', join(studio, 'renderer'), 'install', '--frozen-lockfile']);
    run('npm', ['--prefix', join(source, 'apps/kcoder-relay'), 'ci', '--no-audit', '--no-fund']);
    run('pnpm', ['--dir', studio, 'build:renderer']);
    requireRelease(option);
    run('npm', ['pack', '--pack-destination', receipt], { cwd: studio });
    requireRelease(option);
  }
  const record = { profile, source: checkout, commit, binary, binarySha256: digest(binary) };
  if (debug) {
    const storageNative = join(target, 'native/debug/libkcoder_native_storage.so');
    record.storageNative = { path: storageNative, sha256: digest(storageNative) };
  }
  if (!debug) {
    record.studioManifestSha256 = digest(join(studio, 'kcoder-release-manifest.json'));
  }
  writeExclusive(join(receipt, 'build.json'), JSON.stringify(record, null, 2) + '\n');
  if (!debug) atomicWrite(join(target, '.workspace-release-commit'), JSON.stringify(record) + '\n');
  console.log(receipt);
}
function configure() {
  requireCheckout();
  if (active(gatewayUnit)) throw new Error('Stop the Debug Gateway before configuring its profile');
  readLaunchConfig();
  ensureDevDirectory(home);
  ensureDirectory(state);
  const workspace = join(target, 'workspace');
  ensureDevDirectory(workspace);
  ensureDevDirectory(join(target, 'tmp'));
  const env = { ...cleanEnv, KCODER_HOME: home, KCODER_CONFIG_DIR: home, TMPDIR: join(target, 'tmp') };
  if (!existsSync(join(home, 'settings.json'))) {
    run(binary, ['config', 'migrate'], { cwd: workspace, env });
    run(binary, ['config', 'import', '--scope', 'user', '--file',
      join(checkout, 'crates/kcoder_config/setting_dev_user.jsonc')], { cwd: workspace, env });
  }
  run(binary, ['config', 'set', 'credential_store', 'file', '--scope', 'user'], { cwd: workspace, env });
  if (existsSync(dotenv)) run(binary, ['auth', 'login', '--provider', 'kunlunmeta', '--store', 'file', '--env-file', dotenv], { cwd: workspace, env });
  run(binary, ['config', 'validate'], { cwd: workspace, env });
}
async function start() {
  const flags = debug && option ? [option, ...extra] : extra;
  const relayRequested = flags.includes('--relay');
  if (flags.length !== Number(relayRequested)) throw new Error('Invalid start arguments');
  if (debug) requireCheckout();
  if (recover ? active(gatewayUnit) : units.some(active)) throw new Error('Instance is active. Stop it explicitly before starting it again.');
  const config = readLaunchConfig();
  let runBinary = binary;
  let runSource = source;
  if (!debug) {
    if (!option || option.startsWith('-')) throw new Error('Select an explicit installed commit or tag');
    const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${option}^{commit}`]);
    readInstalledRelease(commit);
    runBinary = join(releaseVersion(commit), 'bin/kcoder');
    runSource = join(releaseVersion(commit), 'runtime');
  }
  const runStudio = join(runSource, 'apps/kcoder-studio');
  const runRelaySource = join(runSource, 'apps/kcoder-relay/src');
  if (!existsSync(runBinary)) throw new Error(`Build or install the selected backend first: ${runBinary}`);
  if (debug && !existsSync(join(target, 'native/debug/libkcoder_native_storage.so'))) {
    throw new Error('Build the Dev Native storage addon with dev build before starting');
  }
  const workspace = debug ? join(target, 'workspace') : realpathSync(resolve(root, config.KCODER_WORKSPACE_RELEASE_WORKSPACE || homedir()));
  if (debug) ensureDevDirectory(workspace, !recover);
  if (!lstatSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
  const ports = readPorts(config);
  if (debug) {
    ensureDevDirectory(home, !recover);
    ensureDevDirectory(state, !recover);
  } else ensureDirectory(state);
  const local = `http://127.0.0.1:${ports.gateway}`;
  const previous = recover ? JSON.parse(readFileSync(join(state, 'launch.json'), 'utf8')) : null;
  if (recover) {
    // Recovery reuses the recorded instance; it cannot select another Home or workspace.
    const expected = { source: runSource, workspace, binary: runBinary, home, gateway: local };
    if (Object.entries(expected).some(([key, value]) => previous[key] !== value))
      throw new Error('Recovery does not match the recorded workspace instance');
  }
  // Forward only runtime configuration; deployment/test credentials stay in the launcher.
  const runtimeKeys = [
    'DEV_DEBUG', 'KUNLUNMETA_BASE_API_KEY', 'KUNLUNMETA_BASE_URL', 'KUNLUNMETA_BASE_MODEL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'KCODER_STUDIO_AUTH_TOKEN', 'KCODER_STUDIO_MOBILE_PAIRING_TOKEN', 'KCODER_STUDIO_MOBILE_PAIRING_MODE',
    'KCODER_STUDIO_MOBILE_WEB_ORIGINS', 'KCODER_STUDIO_MOBILE_WEB_ROOT',
    'KCODER_STUDIO_P2P', 'KCODER_STUDIO_P2P_STUN_URLS',
  ];
  const env = { ...cleanEnv, ...(debug ? Object.fromEntries(runtimeKeys.filter(key => config[key] !== undefined).map(key => [key, config[key]])) : {}),
    KCODER_HOME: home, KCODER_CONFIG_DIR: home,
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(ports.gateway),
    KCODER_STUDIO_WORKSPACE: workspace, KCODER_STUDIO_KCODER_BIN: runBinary,
    KCODER_STUDIO_RENDERER_MODE: debug ? 'vite' : 'static',
    KCODER_STUDIO_DEPLOYMENT_MODE: debug ? 'dev' : 'release',
    KCODER_STUDIO_DATA_DIR: state,
    KCODER_STUDIO_RELAY_DEFAULT_URL: config.KCODER_RELAY_PUBLIC_URL || '',
    KCODER_STUDIO_SERVERS_STORE: join(state, 'servers.json'),
  };
  if (debug) {
    ensureDevDirectory(join(target, 'tmp'), !recover);
    env.TMPDIR = join(target, 'tmp');
    env.KCODER_TARGET_DIR = join(target, 'native');
  }
  if (debug && config.KCODER_STUDIO_VITE_BUNDLED_DEV !== undefined) {
    env.KCODER_STUDIO_VITE_BUNDLED_DEV = config.KCODER_STUDIO_VITE_BUNDLED_DEV;
  }
  run(runBinary, ['config', 'validate'], { cwd: workspace, env });
  const launchRecord = join(state, 'launch.json');
  let relay = false;
  let ownedPublicGateway = null;
  if (relayRequested) {
    const relayRuntime = await import(pathToFileURL(join(runStudio, 'src/gateway-relay-instance.js')).href);
    const selection = await relayRuntime.readRelayConfiguration(join(state, 'desktop-relay.json'));
    if (selection && !selection.disabled) {
      const owned = await relayRuntime.prepareGatewayRelay({ userDataDir: state, env: {} }).catch(() => null);
      ownedPublicGateway = owned?.publicBaseUrl ?? null;
      owned?.close();
    }
    const relayUrl = config.KCODER_RELAY_PUBLIC_URL;
    const registrationFile = join(state, 'registration.env');
    let identityFile;
    let gatewaySecret;
    if (!selection?.disabled && !selection?.selectedProfile && !ownedPublicGateway && relayUrl && existsSync(registrationFile)) {
      initializeFile(registrationFile, () => '');
      const stored = parseEnv(readFileSync(registrationFile, 'utf8'));
      gatewaySecret = stored.KCODER_RELAY_GATEWAY_SECRET;
      const legacyIdentityFile = join(state, 'relay-identity.json');
      const identityOptions = { relayUrl, gatewaySecret };
      if (typeof gatewaySecret !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(gatewaySecret)) {
        console.error('Relay is paused: restore the original Gateway internal secret in the private registration file; the local Gateway remains available.');
      } else if (await readRegisteredClientId({ ...identityOptions, identityFile: resolveIdentityFile({}, state), allowUnregistered: true }) ||
          await readRegisteredClientId({ ...identityOptions, identityFile: legacyIdentityFile, allowUnregistered: true })) {
        identityFile = await prepareInstanceIdentityFile({ stateDirectory: state, legacyIdentityFile, ...identityOptions });
      }
    }
    if (identityFile) {
      const publicOrigin = new URL(relayUrl);
      if (publicOrigin.protocol !== 'https:' || publicOrigin.href !== `${publicOrigin.origin}/`) {
        throw new Error(`Relay requires a root HTTPS URL in ${launchConfig}`);
      }
      relay = true;
      initializeFile(join(state, 'initial-servers.json'), () => JSON.stringify([{ id: 'local', label: debug ? 'Debug' : 'Release', transport: 'local' }]));
      Object.assign(env, {
        ...(debug ? { KCODER_RELAY_NO_DOTENV: '1', KCODER_RELAY_GATEWAY_SECRET: gatewaySecret }
          : { KCODER_RELAY_ENV_FILE: registrationFile }),
        KCODER_RELAY_PUBLIC_URL: publicOrigin.origin,
        KCODER_RELAY_PUBLIC_ORIGINS: [publicOrigin.origin, env.KCODER_STUDIO_PUBLIC_ORIGINS].filter(Boolean).join(','),
        KCODER_RELAY_ROUTE_MODE: 'path', KCODER_RELAY_LOCAL_GATEWAY: local,
        KCODER_RELAY_IDENTITY_FILE: identityFile,
        KCODER_RELAY_CONFIG_DIR: home, KCODER_RELAY_KCODER_BIN: runBinary,
        KCODER_RELAY_SERVERS_FILE: join(state, 'initial-servers.json'),
      });
    } else if (!ownedPublicGateway) {
      console.log('Sign in to Relay from the local Gateway in Settings → Access Links.');
    }
  }
  const started = [];
  function startUnit(unit, cwd, file, args, values) {
    if (recover && active(unit)) return;
    if (!debug) started.push(unit);
    launch(unit, cwd, file, args, values);
    if (debug) started.push(unit);
  }
  try {
    let relayGatewayId;
    if (relay) {
      const clientKeys = ['KCODER_RELAY_NO_DOTENV', 'KCODER_RELAY_PUBLIC_URL', 'KCODER_RELAY_GATEWAY_SECRET',
        'KCODER_RELAY_ROUTE_MODE', 'KCODER_RELAY_LOCAL_GATEWAY', 'KCODER_RELAY_IDENTITY_FILE'];
      const clientEnv = debug ? Object.fromEntries(clientKeys.map(key => [key, env[key]]))
        : Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('KCODER_RELAY_')));
      startUnit(clientUnit, runSource, process.execPath, [join(runRelaySource, 'client.mjs')], { ...cleanEnv, ...(debug ? { TMPDIR: env.TMPDIR } : {}), ...clientEnv });
      relayGatewayId = await waitForIdentity(clientUnit, { identityFile: env.KCODER_RELAY_IDENTITY_FILE,
        relayUrl: env.KCODER_RELAY_PUBLIC_URL, gatewaySecret: env.KCODER_RELAY_GATEWAY_SECRET });
    }
    const publicGateway = relay ? createRelayUrls({
      publicUrl: env.KCODER_RELAY_PUBLIC_URL,
      gatewayId: relayGatewayId,
      routeMode: 'path', registryMode: true,
    }).gatewayBase.toString().replace(/\/$/, '') : ownedPublicGateway;
    if (recover && previous.publicGateway !== publicGateway)
      throw new Error('Recovery must preserve the recorded Relay route; include --relay when required');
    startUnit(gatewayUnit, runStudio, process.execPath, [relay ? join(runRelaySource, 'gateway.mjs') : join(runStudio, 'web-dev.mjs')], env);
    waitFor(gatewayUnit, () => [200, 302, 401].includes(httpStatus(local)), 'Gateway HTTP', 120_000);
    if (started.some(unit => !active(unit))) throw new Error('A workspace service exited during startup');
    const record = { source: runSource, workspace, binary: runBinary, home, gateway: local, publicGateway };
    if (!debug) systemctl('enable', ...started);
    atomicWrite(launchRecord, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify(record, null, 2));
    if (debug && relayRequested) console.error('公网账号测试：npm --prefix apps/kcoder-relay run test:account（读取私有 .env）');
  } catch (error) {
    if (started.length) {
      const running = started.reverse().filter(active);
      try {
        if (running.length) systemctl('stop', ...running);
      } finally {
        if (!debug) systemctl('disable', ...started);
      }
    }
    throw error;
  }
}

try {
  if (action === 'build') await build();
  if (action === 'configure') configure();
  if (action === 'install') await installRelease();
  if (action === 'start') await start();
  if (action === 'status') {
    const record = join(state, 'launch.json');
    console.log(JSON.stringify({ instance, launchConfig, units: Object.fromEntries(units.map(unit => [unit, active(unit)])),
      launch: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null }, null, 2));
  }
  if (action === 'stop') {
    const running = units.filter(active);
    if (debug && running.length) systemctl('stop', ...running);
    if (!debug) {
      const installed = units.filter(unit => existsSync(join(state, unit)));
      if (installed.length) systemctl('disable', '--now', ...installed);
    }
  }
  if (action === 'upgrade') run(process.execPath, [join(root, 'apps/kcoder-relay/src/update-local.mjs'), ...process.argv.slice(4)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
