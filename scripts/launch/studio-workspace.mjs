// Runs the fixed Debug/Release instances using existing Studio and Relay entry points.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { inspectMobile, systemdQuote } from '../../apps/kcoder-relay/src/local-update-files.mjs';
import { createRelayUrls } from '../../apps/kcoder-relay/deploy/config.mjs';
import { prepareInstanceIdentityFile, readRegisteredClientId, resolveIdentityFile } from '../../apps/kcoder-relay/src/client-identity.mjs';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const [profile, action, option, ...extra] = process.argv.slice(2);
const valid = { dev: ['build', 'configure', 'start', 'stop', 'status', 'expo', 'mobile-tunnel'], release: ['build', 'install', 'start', 'stop', 'status', 'upgrade'] };
if (!Object.hasOwn(valid, profile) || !valid[profile].includes(action)) {
  console.error('Usage: node scripts/launch/studio-workspace.mjs dev|release build|start|stop|status');
  console.error('Dev also supports configure. Release build/install/start take a ref. Start accepts --relay.');
  console.error('Dev start serves Mobile through the Gateway. --mobile-tunnel selects the legacy SSH preview.');
  console.error('Dev expo start|stop|status manages only root-worktree Expo and reuses the running Gateway.');
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
const launchConfig = debug ? join(state, '.env.launch') : dotenv;
const legacyLaunchConfig = join(state, 'launch.env');
const releaseHome = !debug && existsSync(dotenv) ? parseEnv(readFileSync(dotenv, 'utf8')).KCODER_WORKSPACE_RELEASE_HOME : undefined;
const home = debug ? join(target, 'home') : resolve(homedir(), releaseHome || '.config/kcoder');
const studio = join(source, 'apps/kcoder-studio');
const mobile = join(studio, 'mobile');
const gatewayUnit = `${instance}-gateway.service`;
const clientUnit = `${instance}-relay.service`;
const expoUnit = `${instance}-expo.service`;
const proxyUnit = `${instance}-mobile.service`;
const tunnelUnit = `${instance}-mobile-tunnel.service`;
const units = debug ? [tunnelUnit, clientUnit, proxyUnit, expoUnit, gatewayUnit] : [clientUnit, gatewayUnit];
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
  const mobileDist = join(mobile, 'dist');
  const mobileManifestSha256 = record.mobileManifestSha256 ?? digest(join(mobileDist, 'kcoder-mobile-web.json'));
  if (units.some(active)) throw new Error('Stop this Release instance before reinstalling it');
  const dest = releaseVersion(commit);
  if (existsSync(dest)) {
    const installed = readInstalledRelease(commit);
    if (installed.binarySha256 !== binarySha256 || installed.studioManifestSha256 !== studioManifestSha256 ||
        installed.mobileManifestSha256 !== mobileManifestSha256) {
      throw new Error('This commit already has different installed bytes');
    }
    return;
  }
  privateDirectory(dirname(dest));
  const stage = mkdtempSync(join(dirname(dest), '.install-'));
  try {
    const runtime = join(stage, 'runtime');
    const studioRuntime = join(runtime, 'apps/kcoder-studio');
    const relayRuntime = join(runtime, 'apps/kcoder-relay');
    mkdirSync(studioRuntime, { recursive: true, mode: 0o700 });
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
    await inspectMobile(mobileDist, mobileManifestSha256);
    const mobileRuntime = join(studioRuntime, 'mobile/dist');
    if (!existsSync(mobileRuntime)) cpSync(mobileDist, mobileRuntime, { recursive: true });
    await inspectMobile(mobileRuntime, mobileManifestSha256);
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
    writePrivate(join(stage, 'release.json'), JSON.stringify({ commit, binarySha256, studioManifestSha256, mobileManifestSha256 }) + '\n');
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
      digest(join(version, 'runtime/apps/kcoder-studio/kcoder-release-manifest.json')) !== record.studioManifestSha256 ||
      digest(join(version, 'runtime/apps/kcoder-studio/mobile/dist/kcoder-mobile-web.json')) !== record.mobileManifestSha256) {
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
  const variables = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  if (!debug) {
    if (/[\\\x00-\x1f\x7f]/.test(cwd)) throw new Error('Invalid systemd working directory');
    const unitPath = join(state, unit);
    const command = ['/usr/bin/env', '-i', ...variables, file, ...args].map(systemdQuote).join(' ');
    const unitFile = `[Unit]\nDescription=${unit}\nAfter=network-online.target\n\n[Service]\nType=exec\nWorkingDirectory=${cwd.replaceAll('%', '%%')}\nExecStart=${command}\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
    atomicPrivate(unitPath, unitFile);
    systemctl('link', unitPath);
    systemctl('start', unit);
    return;
  }
  run('systemd-run', ['--user', '--collect', '--property=Type=exec', '--property=KillMode=control-group',
    `--unit=${unit}`, `--working-directory=${cwd}`, '--', '/usr/bin/env', '-i', ...variables, file, ...args], { env: cleanEnv });
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
function httpStatus(url) {
  const result = spawnSync('curl', ['--noproxy', '*', '--max-time', '1', '--silent', '--output', '/dev/null',
    '--write-out', '%{http_code}', url], { encoding: 'utf8', env: cleanEnv });
  return Number(result.stdout) || 0;
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || lstatSync(path).uid !== process.getuid()) {
    throw new Error(`Expected a directory owned by the current user: ${path}`);
  }
  chmodSync(path, 0o700);
}
function writePrivate(path, data) {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
}
function atomicPrivate(path, data) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}`;
  writePrivate(temporary, data);
  renameSync(temporary, path);
}
function initPrivate(path, create) {
  if (!existsSync(path)) writePrivate(path, create());
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.nlink !== 1) {
    throw new Error(`Expected a private file owned by the current user: ${path}`);
  }
}
function migrateDevLaunchConfig() {
  if (!debug || !existsSync(legacyLaunchConfig)) return;
  const previous = lstatSync(legacyLaunchConfig);
  const current = existsSync(launchConfig) ? lstatSync(launchConfig) : null;
  // A same-inode pair can remain if the exclusive move was interrupted.
  if (current && (current.dev !== previous.dev || current.ino !== previous.ino)) {
    throw new Error('Both .env.launch and legacy launch.env exist; reconcile them without overwriting either file');
  }
  if (!previous.isFile() || previous.uid !== process.getuid() || (previous.mode & 0o077) !== 0 ||
      previous.nlink !== (current ? 2 : 1)) {
    throw new Error('Expected a private legacy launch.env owned by the current user');
  }
  if (!current) linkSync(legacyLaunchConfig, launchConfig);
  const retained = lstatSync(legacyLaunchConfig);
  const moved = lstatSync(launchConfig);
  if (retained.dev !== moved.dev || retained.ino !== moved.ino) {
    throw new Error('Launch configuration changed during migration; both files were preserved');
  }
  unlinkSync(legacyLaunchConfig);
}
function readPorts(config) {
  const read = (key, fallback) => {
    const value = Number(config[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${key}`);
    return value;
  };
  const debugPort = read('KCODER_WORKSPACE_DEBUG_PORT', 4283);
  const releasePort = read('KCODER_WORKSPACE_RELEASE_PORT', 4383);
  const expo = read('KCODER_WORKSPACE_EXPO_PORT', 14275);
  const preview = read('KCODER_WORKSPACE_MOBILE_PORT', 4285);
  if (new Set([debugPort, releasePort, expo, preview]).size !== 4) throw new Error('Gateway, Mobile preview and Expo ports must differ');
  return { gateway: debug ? debugPort : releasePort, expo, preview };
}
function readLaunchConfig() {
  // Auxiliary operations may read an old instance without moving its configuration.
  let file = launchConfig;
  if (debug && existsSync(legacyLaunchConfig)) {
    if (existsSync(launchConfig)) throw new Error('Both .env.launch and legacy launch.env exist; reconcile them before starting');
    file = legacyLaunchConfig;
  }
  if (!existsSync(file)) {
    if (debug) throw new Error('Run node scripts/launch/studio-workspace.mjs dev configure to prepare the private launch configuration');
    return {};
  }
  if (debug) initPrivate(file, () => '');
  const config = parseEnv(readFileSync(file, 'utf8'));
  if (debug && ['KCODER_WORKSPACE_DEBUG_HOME', 'KCODER_WORKSPACE_DEBUG_BIN', 'KCODER_NATIVE_CONNECTIVITY_BINDING_V1',
    'KCODER_RELAY_KCODER_BIN', 'KCODER_RELAY_CONFIG_DIR', 'KCODER_RELAY_SERVERS_FILE'].some(key => config[key])) {
    throw new Error('Dev paths are managed by the launcher; remove legacy Home, binary, resource and target overrides from .env.launch');
  }
  return config;
}
function privateDevDirectory(path) {
  if (existsSync(path) && lstatSync(path).dev !== lstatSync(target).dev) {
    throw new Error(`Dev data must reside on its checkout filesystem, not an external mount: ${path}`);
  }
  privateDirectory(path);
}
function build() {
  requireCheckout();
  if (units.some(active)) throw new Error('Stop the instance before replacing its built executable');
  const commit = debug ? git(checkout, ['rev-parse', 'HEAD']) : requireRelease(option);
  const receipt = run('bash', [join(root, 'scripts/launch/worktree.sh'), 'artifact', debug ? 'operations' : 'packages', `${profile}-build`],
    { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const args = ['build', '--locked', '-p', 'kcoder_cli', '--bin', 'kcoder'];
  if (!debug) args.push('--release');
  privateDevDirectory(join(target, 'tmp'));
  run('cargo', args, { cwd: checkout, env: { ...process.env, CARGO_TARGET_DIR: target, TMPDIR: join(target, 'tmp') } });
  // Native child launchers reject group-writable executable files.
  for (const program of [binary, join(dirname(binary), 'kcoder-process-supervisor')]) {
    if (existsSync(program)) chmodSync(program, 0o755);
  }
  run(binary, ['--version'], { env: cleanEnv });
  if (!debug) {
    run('pnpm', ['--dir', studio, 'install', '--frozen-lockfile']);
    run('pnpm', ['--dir', join(studio, 'renderer'), 'install', '--frozen-lockfile']);
    run('npm', ['--prefix', mobile, 'ci', '--no-audit', '--no-fund']);
    run('npm', ['--prefix', join(source, 'apps/kcoder-relay'), 'ci', '--no-audit', '--no-fund']);
    run('pnpm', ['--dir', studio, 'build:renderer']);
    run('npm', ['--prefix', mobile, 'run', 'build:web']);
    requireRelease(option);
    run('npm', ['pack', '--pack-destination', receipt], { cwd: studio });
    requireRelease(option);
  }
  const record = { profile, source: checkout, commit, binary, binarySha256: digest(binary) };
  if (!debug) {
    record.studioManifestSha256 = digest(join(studio, 'kcoder-release-manifest.json'));
    record.mobileManifestSha256 = digest(join(mobile, 'dist/kcoder-mobile-web.json'));
  }
  writePrivate(join(receipt, 'build.json'), JSON.stringify(record, null, 2) + '\n');
  if (!debug) atomicPrivate(join(target, '.workspace-release-commit'), JSON.stringify(record) + '\n');
  console.log(receipt);
}
function configure() {
  requireCheckout();
  if (active(gatewayUnit)) throw new Error('Stop the Debug Gateway before configuring its profile');
  privateDevDirectory(home);
  privateDirectory(state);
  migrateDevLaunchConfig();
  initPrivate(launchConfig, () => readFileSync(existsSync(dotenv) ? dotenv : join(root, '.env.example'), 'utf8'));
  const workspace = join(target, 'workspace');
  privateDevDirectory(workspace);
  privateDevDirectory(join(target, 'tmp'));
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
function previewConfig(ports) {
  const template = readFileSync(join(root, 'scripts/launch/services/systemd/kcoder-studio-mobile-web.nginx.conf'), 'utf8');
  return template
    .replace('pid /run/kcoder-studio-mobile-web/nginx.pid;', `pid ${JSON.stringify(join(state, 'mobile-nginx.pid'))};`)
    .replace(/^\s*listen 4175;\n/m, '\n')
    .replace('127.0.0.1:4175', `127.0.0.1:${ports.preview}`)
    .replace('127.0.0.1:4173', `127.0.0.1:${ports.gateway}`)
    .replace('127.0.0.1:14175', `127.0.0.1:${ports.expo}`);
}
function startExpo(port, publicGateway, legacyTunnel, startUnit = launch) {
  run('npm', ['run', 'build:terminal-webview'], { cwd: mobile, env: cleanEnv });
  privateDevDirectory(join(target, 'tmp'));
  const metroEnv = { ...cleanEnv, TMPDIR: join(target, 'tmp'), EXPO_OFFLINE: '1', EXPO_NO_DOTENV: '1', KCODER_WORKSPACE_EXPO_PORT: String(port),
    KCODER_STUDIO_ALLOW_HTTP: '1', EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: '1' };
  if (!legacyTunnel) Object.assign(metroEnv, {
    KCODER_STUDIO_MOBILE_DEV_BASE: `${publicGateway ? new URL(publicGateway).pathname : ''}/mobile`,
    EXPO_NO_METRO_LAZY: '1',
  });
  startUnit(expoUnit, mobile, process.execPath, ['--require', join(root, 'scripts/launch/lib/expo-loopback.cjs'),
    join(mobile, 'node_modules/expo/bin/cli'), 'start', '--web', '--port', String(port), '--host', 'localhost'], metroEnv);
  waitFor(expoUnit, () => httpStatus(`http://127.0.0.1:${port}/status`) === 200, 'Metro HTTP');
}
async function expo() {
  if (!['start', 'stop', 'status'].includes(option) || extra.length) throw new Error('Use dev expo start|stop|status');
  if (option === 'stop') {
    if (active(expoUnit)) systemctl('stop', expoUnit);
    console.log(JSON.stringify({ source: mobile, running: false }));
    return;
  }
  const gatewayRunning = active(gatewayUnit);
  if (!gatewayRunning) {
    if (option === 'status') {
      console.log(JSON.stringify({ source: mobile, running: active(expoUnit), gatewayRunning: false }));
      return;
    }
    throw new Error('The existing Gateway must be running; Expo does not start or reconfigure the backend.');
  }
  const pid = run('systemctl', ['--user', 'show', gatewayUnit, '-p', 'MainPID', '--value'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: cleanEnv }).trim();
  const environment = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    .filter(value => value.includes('=')).map(value => {
      const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    }));
  const port = Number(environment.KCODER_STUDIO_MOBILE_DEV_PORT);
  const proxyConfigured = environment.KCODER_STUDIO_RENDERER_MODE === 'vite' && Number.isInteger(port) && port >= 1024 && port <= 65535;
  if (option === 'start' && !proxyConfigured) {
    throw new Error('The existing Gateway has no Expo proxy. Configure KCODER_STUDIO_MOBILE_DEV_PORT once and restart only the Gateway.');
  }
  const relayRuntime = await import('../../apps/kcoder-studio/src/gateway-relay-instance.js');
  const selection = await relayRuntime.readRelayConfiguration(join(state, 'desktop-relay.json'));
  const owned = !selection || selection.disabled ? null : await relayRuntime.relayProfileState({
    userDataDir: state, profile: selection.selectedProfile ?? null, legacyUrl: selection.url,
  });
  const publicGateway = owned?.publicBaseUrl ?? (!selection?.disabled && environment.KCODER_RELAY_PUBLIC_URL && environment.KCODER_RELAY_IDENTITY_FILE
    ? createRelayUrls({ publicUrl: environment.KCODER_RELAY_PUBLIC_URL,
      gatewayId: JSON.parse(readFileSync(environment.KCODER_RELAY_IDENTITY_FILE, 'utf8')).id,
      routeMode: 'path', registryMode: true }).gatewayBase.toString().replace(/\/$/, '') : null);
  if (option === 'start' && !active(expoUnit)) {
    let started = false;
    try {
      startExpo(port, publicGateway, false, (...args) => { launch(...args); started = true; });
    } catch (error) {
      if (started && active(expoUnit)) systemctl('stop', expoUnit);
      throw error;
    }
  }
  console.log(JSON.stringify({ source: mobile, running: active(expoUnit), proxyConfigured,
    port: proxyConfigured ? port : null, gatewayPid: Number(pid),
    mobile: publicGateway ? `${publicGateway}/mobile/` : `http://127.0.0.1:${environment.KCODER_STUDIO_PORT}/mobile/` }, null, 2));
}
async function start() {
  const flags = debug && option ? [option, ...extra] : extra;
  const relayRequested = flags.includes('--relay');
  const mountMobile = debug && flags.includes('--mobile-tunnel');
  if (flags.length !== Number(relayRequested) + Number(mountMobile)) throw new Error('Invalid start arguments');
  if (debug) requireCheckout();
  if (units.some(active)) throw new Error('Instance is active. Stop it explicitly before starting it again.');
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
  const workspace = debug ? join(target, 'workspace') : realpathSync(resolve(root, config.KCODER_WORKSPACE_RELEASE_WORKSPACE || homedir()));
  if (debug) privateDevDirectory(workspace);
  if (!lstatSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
  const ports = readPorts(config);
  const tunnel = mountMobile ? mobileTunnelOptions(config, ports.preview) : null;
  if (debug) privateDevDirectory(home);
  privateDirectory(state);
  const local = `http://127.0.0.1:${ports.gateway}`;
  const env = { ...cleanEnv, KCODER_HOME: home, KCODER_CONFIG_DIR: home,
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(ports.gateway),
    KCODER_STUDIO_WORKSPACE: workspace, KCODER_STUDIO_KCODER_BIN: runBinary,
    KCODER_STUDIO_RENDERER_MODE: debug ? 'vite' : 'static',
    KCODER_STUDIO_DATA_DIR: state,
    KCODER_STUDIO_RELAY_DEFAULT_URL: config.KCODER_RELAY_PUBLIC_URL || '',
    KCODER_STUDIO_SERVERS_STORE: join(state, 'servers.json'),
  };
  if (debug) {
    privateDevDirectory(join(target, 'tmp'));
    env.TMPDIR = join(target, 'tmp');
  }
  if (debug && config.KCODER_STUDIO_VITE_BUNDLED_DEV !== undefined) {
    env.KCODER_STUDIO_VITE_BUNDLED_DEV = config.KCODER_STUDIO_VITE_BUNDLED_DEV;
  }
  if (debug && tunnel) {
    const remotePort = config.KCODER_WORKSPACE_MOBILE_REMOTE_PORT;
    const previewPorts = [ports.preview];
    if (remotePort && /^\d{4,5}$/.test(remotePort) && Number(remotePort) >= 1024 && Number(remotePort) <= 65535) {
      previewPorts.push(Number(remotePort));
    }
    const previewOrigins = previewPorts.flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]).join(',');
    env.KCODER_STUDIO_MOBILE_WEB_ORIGINS = previewOrigins;
    env.KCODER_STUDIO_PUBLIC_ORIGINS = previewOrigins;
    env.KCODER_STUDIO_ALLOW_HTTP = '1';
  }
  if (debug && !tunnel) {
    env.KCODER_STUDIO_MOBILE_DEV_PORT = String(ports.expo);
    env.KCODER_STUDIO_ALLOW_HTTP = '1';
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
    if (!selection?.disabled && !selection?.selectedProfile && !ownedPublicGateway && relayUrl && existsSync(registrationFile)) {
      initPrivate(registrationFile, () => '');
      const stored = parseEnv(readFileSync(registrationFile, 'utf8'));
      const gatewaySecret = stored.KCODER_RELAY_GATEWAY_SECRET;
      const legacyIdentityFile = join(state, 'relay-identity.json');
      const identityOptions = { relayUrl, gatewaySecret };
      if (await readRegisteredClientId({ ...identityOptions, identityFile: resolveIdentityFile({}, state), allowUnregistered: true }) ||
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
      initPrivate(join(state, 'initial-servers.json'), () => JSON.stringify([{ id: 'local', label: debug ? 'Debug' : 'Release', transport: 'local' }]));
      Object.assign(env, {
        KCODER_RELAY_ENV_FILE: registrationFile, KCODER_RELAY_PUBLIC_URL: publicOrigin.origin,
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
    if (!debug) started.push(unit);
    launch(unit, cwd, file, args, values);
    if (debug) started.push(unit);
  }
  try {
    if (relay) {
      const clientEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('KCODER_RELAY_')));
      startUnit(clientUnit, runSource, process.execPath, [join(runRelaySource, 'client.mjs')], { ...cleanEnv, ...(debug ? { TMPDIR: env.TMPDIR } : {}), ...clientEnv });
      waitFor(clientUnit, () => {
        try { return Boolean(JSON.parse(readFileSync(env.KCODER_RELAY_IDENTITY_FILE, 'utf8')).id); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }, 'Relay registration');
    }
    const publicGateway = relay ? createRelayUrls({
      publicUrl: env.KCODER_RELAY_PUBLIC_URL,
      gatewayId: JSON.parse(readFileSync(env.KCODER_RELAY_IDENTITY_FILE, 'utf8')).id,
      routeMode: 'path', registryMode: true,
    }).gatewayBase.toString().replace(/\/$/, '') : ownedPublicGateway;
    if (debug) startExpo(ports.expo, publicGateway, Boolean(tunnel), startUnit);
    if (tunnel) {
      const nginx = spawnSync('which', ['nginx'], { encoding: 'utf8' }).stdout?.trim();
      if (!nginx) throw new Error('nginx is required for the Mobile preview');
      const runtime = join(state, 'mobile-proxy');
      privateDirectory(runtime);
      const nginxConfig = join(runtime, 'mobile.conf');
      atomicPrivate(nginxConfig, previewConfig(ports));
      run(nginx, ['-p', `${runtime}/`, '-c', nginxConfig, '-t']);
      startUnit(proxyUnit, runtime, nginx, ['-p', `${runtime}/`, '-c', nginxConfig, '-g', 'daemon off;'], cleanEnv);
    }
    startUnit(gatewayUnit, runStudio, process.execPath, [relay ? join(runRelaySource, 'gateway.mjs') : join(runStudio, 'web-dev.mjs')], env);
    // Cold SDK resource preparation can outlast the short transport readiness window.
    waitFor(gatewayUnit, () => [200, 302, 401].includes(httpStatus(local)), 'Gateway HTTP', 120_000);
    const mobileUrl = tunnel ? `http://127.0.0.1:${ports.preview}` : `${debug && publicGateway ? publicGateway : local}/mobile/`;
    if (tunnel) {
      waitFor(proxyUnit, () => httpStatus(`${mobileUrl}/status`) === 200, 'Metro via the Mobile proxy');
      mountMobileTunnel(tunnel);
      started.push(tunnelUnit);
    }
    if (started.some(unit => !active(unit))) throw new Error('A workspace service exited during startup');
    const record = { source: runSource, workspace, binary: runBinary, home, gateway: local, mobile: mobileUrl, publicGateway };
    if (publicGateway && !tunnel) record.publicMobile = `${publicGateway}/mobile/`;
    if (tunnel) record.remoteMobile = tunnel.remoteUrl;
    if (!debug) systemctl('enable', ...started);
    atomicPrivate(launchRecord, JSON.stringify(record, null, 2) + '\n');
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
function mobileTunnelOptions(config, localPort) {
  const host = config.KCODER_RELAY_SSH_HOSTNAME;
  const user = config.KCODER_RELAY_SSH_USER;
  const remotePort = Number(config.KCODER_WORKSPACE_MOBILE_REMOTE_PORT);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host || '') || !/^[a-z_][a-z0-9_-]*$/.test(user || '') ||
      !Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
    throw new Error(`Set KCODER_RELAY_SSH_HOSTNAME, KCODER_RELAY_SSH_USER and KCODER_WORKSPACE_MOBILE_REMOTE_PORT in ${launchConfig}`);
  }
  const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
  const identity = config.KCODER_RELAY_SSH_IDENTITY;
  if (identity) sshOptions.push('-i', resolve(root, identity.replace(/^~\//, `${homedir()}/`)));
  return { sshOptions, destination: `${user}@${host}`, forward: `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
    remoteUrl: `http://127.0.0.1:${remotePort}` };
}
function mountMobileTunnel({ sshOptions, destination, forward, remoteUrl }) {
  if (active(tunnelUnit)) throw new Error('The Debug Mobile tunnel is already active');
  const args = ['-NT', ...sshOptions, '-R', forward, destination];
  launch(tunnelUnit, root, '/usr/bin/ssh', args, cleanEnv);
  try {
    waitFor(tunnelUnit, () => spawnSync('/usr/bin/ssh', [...sshOptions, destination, 'curl', '--fail', '--silent', '--max-time', '2',
      `${remoteUrl}/status`], { env: cleanEnv, timeout: 5000 }).status === 0,
    'remote Mobile loopback mount');
  } catch (error) {
    if (active(tunnelUnit)) systemctl('stop', tunnelUnit);
    throw error;
  }
}
function mobileTunnel() {
  if (!active(proxyUnit)) throw new Error('Start the Debug Mobile proxy first');
  const config = readLaunchConfig();
  const localPort = new URL(JSON.parse(readFileSync(join(state, 'launch.json'), 'utf8')).mobile).port;
  const tunnel = mobileTunnelOptions(config, localPort);
  mountMobileTunnel(tunnel);
  console.log(`Mobile preview mounted on the Relay host at ${tunnel.remoteUrl}`);
}

try {
  if (action === 'build') build();
  if (action === 'configure') configure();
  if (action === 'install') await installRelease();
  if (action === 'start') await start();
  if (action === 'expo') await expo();
  if (action === 'mobile-tunnel') mobileTunnel();
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
