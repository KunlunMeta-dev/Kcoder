import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClientVersion } from './client-version.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCOPES = [
  'apps/kcoder-studio/mobile', 'apps/kcoder-studio/shared', 'apps/kcoder-studio/src',
  'apps/kcoder-studio/package.json', 'apps/kcoder-studio/renderer/package.json',
  'apps/kcoder-studio/desktop/gateway-package.json',
];
const PHASES = ['prepare', 'build', 'export', 'install'];
const BUNDLE_ID = 'dev.kcoder.studio';
const fail = message => { throw new Error(message); };

export function parseArgs(argv) {
  const options = {};
  const values = new Set(['run', 'ref', 'team', 'build-number', 'developer-dir', 'device', 'pod']);
  const flags = new Set(['help', 'dry-run', 'launch', 'allow-provisioning-updates', 'allow-http', 'export-ipa']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || (!values.has(key) && !flags.has(key))) fail(`Unknown option: ${argv[index]}`);
    if (Object.hasOwn(options, key)) fail(`Duplicate option: --${key}`);
    if (flags.has(key)) options[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) fail(`--${key} requires a value`);
      options[key] = value;
    }
  }
  if (options.team && !/^[A-Z0-9]{10}$/.test(options.team)) fail('--team must be a 10-character Apple Team ID');
  if (options['build-number'] && !/^[1-9]\d{0,8}$/.test(options['build-number'])) fail('--build-number must be a positive integer of at most 9 digits');
  if (options.device && !/^[A-Za-z0-9][A-Za-z0-9._:-]{4,127}$/.test(options.device)) fail('--device must be a device identifier, not a display name');
  if (options.ref?.startsWith('-')) fail('--ref must not start with a dash');
  return options;
}

export function buildEnvironment(source = process.env, options = {}) {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
    if (source[key]) environment[key] = source[key];
  }
  if (options['developer-dir']) environment.DEVELOPER_DIR = resolve(options['developer-dir']);
  Object.assign(environment, { CI: '1', EXPO_NO_DOTENV: '1', NODE_BINARY: process.execPath, RUBYOPT: '-rlogger' });
  if (options['allow-http']) Object.assign(environment, { KCODER_STUDIO_ALLOW_HTTP: '1', EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: '1' });
  return environment;
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

export async function withRunLock(run, action) {
  const state = await lstat(run);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o077)) {
    fail('Run directory must be an owned, private directory (mode 0700)');
  }
  const lock = join(run, '.operation-lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('Run is locked; inspect its owner before manually removing .operation-lock');
    throw error;
  }
  try {
    await atomicJson(join(lock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
    return await action();
  } finally { await rm(lock, { recursive: true }); }
}

export async function containedPath(run, path) {
  if (!path || isAbsolute(path)) fail('Artifact path must be relative to the run directory');
  const root = await realpath(run);
  const candidate = await realpath(resolve(root, path));
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('Artifact escapes the run directory');
  return candidate;
}

export async function treeDigest(root) {
  const hash = createHash('sha256');
  async function visit(path, name) {
    const info = await lstat(path);
    hash.update(JSON.stringify([name, info.mode & 0o777]));
    if (info.isSymbolicLink()) {
      await containedPath(root, name);
      hash.update(JSON.stringify(['link', await readlink(path)]));
    } else if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (info.isFile()) {
      hash.update(JSON.stringify(['file', info.size]));
      hash.update(await readFile(path));
    } else fail('Artifact contains an unsupported filesystem entry');
  }
  await visit(root, '');
  return hash.digest('hex');
}

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

async function command(context, executable, args, { cwd = context.run, capture = false, timeoutMs = 30 * 60_000 } = {}) {
  if (context.execute) return context.execute(executable, args, { cwd, capture, timeoutMs });
  const log = join(context.run, 'logs', `${String(++context.step).padStart(3, '0')}-${context.phase}.log`);
  const output = await open(log, 'wx', 0o600);
  let child;
  let terminationTimer;
  let cancelled = false;
  const terminate = () => {
    cancelled = true;
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    terminationTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5_000);
  };
  let stdout = '';
  try {
    child = spawn(executable, args, { cwd, env: context.env, detached: true, stdio: ['ignore', capture ? 'pipe' : output.fd, output.fd] });
    child.stdout?.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) terminate();
    });
    process.once('SIGINT', terminate);
    process.once('SIGTERM', terminate);
    const timeout = setTimeout(terminate, timeoutMs);
    try {
      const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
      if (cancelled || code !== 0) fail(`${executable} failed${cancelled ? ' or was cancelled' : ` (exit ${code})`}; private log: ${log}`);
    } finally { clearTimeout(timeout); }
    return stdout.trim();
  } finally {
    process.removeListener('SIGINT', terminate);
    process.removeListener('SIGTERM', terminate);
    clearTimeout(terminationTimer);
    await output.close();
  }
}

async function loadReceipt(run) {
  const path = join(run, 'receipt.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) fail('Receipt must be an owned private file');
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit)) fail('Invalid iOS run receipt');
  if (!/^[A-Z0-9]{10}$/.test(receipt.team) || !/^[1-9]\d{0,8}$/.test(receipt.buildNumber) || !receipt.sourceFiles || typeof receipt.sourceFiles !== 'object') fail('Invalid iOS build identity');
  return receipt;
}

async function verifySource(run, receipt) {
  for (const [path, expected] of Object.entries(receipt.sourceFiles)) {
    if (await sha256(await containedPath(run, `source/${path}`)) !== expected) fail(`Prepared source changed: ${path}; create a new run`);
  }
}

export function assertAppIdentity(info, receipt) {
  if (info.CFBundleIdentifier !== BUNDLE_ID || String(info.CFBundleVersion) !== receipt.buildNumber) fail('App bundle identifier or build number does not match this run');
  if (receipt.productVersion !== undefined && info.CFBundleShortVersionString !== receipt.productVersion) fail('iOS app version does not match the frozen Studio product version');
  if (!info.CFBundleSupportedPlatforms?.includes('iPhoneOS')) fail('Expected a physical-device iOS app, not a simulator app');
}

async function verifyApp(context, app, receipt, deviceUdid) {
  await command(context, '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const entitlements = join(context.run, `entitlements-${randomUUID()}.plist`);
  const xml = await command(context, '/usr/bin/codesign', ['-d', '--entitlements', ':-', '--', app], { capture: true });
  await writeFile(entitlements, xml, { mode: 0o600 });
  const signedEntitlements = JSON.parse(await command(context, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlements], { capture: true }));
  const team = signedEntitlements['com.apple.developer.team-identifier'];
  if (team !== receipt.team) fail('Signed app belongs to a different Apple team');
  const info = JSON.parse(await command(context, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')], { capture: true }));
  assertAppIdentity(info, receipt);
  if (!(await lstat(join(app, 'main.jsbundle'))).isFile() || !(await readFile(join(app, 'main.jsbundle'))).length) fail('Release app is missing its embedded JavaScript bundle');
  const profile = join(context.run, `profile-${randomUUID()}.plist`);
  await command(context, '/usr/bin/security', ['cms', '-D', '-i', join(app, 'embedded.mobileprovision'), '-o', profile]);
  const expirationXml = await command(context, '/usr/bin/plutil', ['-extract', 'ExpirationDate', 'xml1', '-o', '-', profile], { capture: true });
  const expiration = expirationXml.match(/<date>([^<]+)<\/date>/)?.[1];
  if (!expiration || !Number.isFinite(Date.parse(expiration)) || Date.parse(expiration) <= Date.now()) fail('Signing profile has expired or has no valid expiration date');
  if (deviceUdid) {
    const devices = JSON.parse(await command(context, '/usr/bin/plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', profile], { capture: true }));
    if (!Array.isArray(devices) || !devices.some(value => String(value).toUpperCase() === deviceUdid)) fail('Signing profile does not authorize the selected iPhone; update the profile and export a new signed artifact');
  }
  return { bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, buildNumber: String(info.CFBundleVersion), team, signingExpiresAt: expiration };
}

async function prepare(context, options) {
  if (!options.team || !options['build-number']) fail('prepare requires --team and --build-number');
  const xcode = await command(context, 'xcodebuild', ['-version'], { capture: true });
  if (!/^Xcode /m.test(xcode)) fail('Select a full Xcode installation with --developer-dir');
  const commit = await command(context, 'git', ['rev-parse', '--verify', `${options.ref || 'HEAD'}^{commit}`], { cwd: REPO, capture: true });
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('Cannot resolve source commit');
  const files = (await command(context, 'git', ['ls-tree', '-r', '--name-only', commit, '--', ...SCOPES], { cwd: REPO, capture: true })).split('\n');
  if (files.some(path => path.split('/').some(part => part.startsWith('.env')))) fail('Committed dotenv files must not enter an iOS build');
  const archive = join(context.run, 'source.tar');
  await command(context, 'git', ['archive', '--format=tar', '-o', archive, commit, '--', ...SCOPES], { cwd: REPO });
  const source = join(context.run, 'source');
  await mkdir(source, { mode: 0o700 });
  await command(context, '/usr/bin/tar', ['-xf', archive, '-C', source]);
  await rm(archive);
  const productVersion = await checkClientVersion(source);
  const sourceFiles = {};
  for (const path of files) sourceFiles[path] = await sha256(await containedPath(context.run, `source/${path}`));
  const mobile = join(source, SCOPES[0]);
  await command(context, 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: mobile });
  await command(context, 'npm', ['run', 'typecheck'], { cwd: mobile });
  await command(context, 'npx', ['--no-install', 'expo', 'prebuild', '--platform', 'ios', '--no-install'], { cwd: mobile });
  await command(context, options.pod || 'pod', ['install', '--project-directory=ios'], { cwd: mobile });
  const receipt = {
    schemaVersion: 1, sourceCommit: commit, team: options.team, productVersion, buildNumber: options['build-number'],
    xcode, developerDir: context.env.DEVELOPER_DIR || null, allowHttp: Boolean(options['allow-http']),
    preparedAt: new Date().toISOString(), sourceFiles,
  };
  await verifySource(context.run, receipt);
  await atomicJson(join(context.run, 'receipt.json'), receipt);
  return receipt;
}

export function assertInstallAllowed(receipt, device) {
  if (!receipt.built) fail('Run build before install');
  if (Object.hasOwn(receipt.installations || {}, device)) fail('An installation was already attempted for this device; inspect its receipt/device state before any manual retry. It is never replayed automatically.');
}

export function canonicalDeviceId(details) {
  const identifiers = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'udid' && typeof child === 'string' && /^(?:[a-f\d]{8}-[a-f\d]{16}|[a-f\d]{40})$/i.test(child)) identifiers.add(child.toUpperCase());
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(details);
  if (identifiers.size !== 1) fail('Device tool did not identify exactly one physical iPhone UDID');
  return [...identifiers][0];
}

export async function executePhase(context, options) {
  if (context.phase === 'prepare') return prepare(context, options);
  const receipt = await loadReceipt(context.run);
  if (options['developer-dir'] && receipt.developerDir && resolve(options['developer-dir']) !== receipt.developerDir) fail('Xcode selection changed; create a new run');
  if (receipt.developerDir) context.env.DEVELOPER_DIR = receipt.developerDir;
  context.env = buildEnvironment(context.env, { 'allow-http': receipt.allowHttp });
  if (['build', 'export'].includes(context.phase) && await command(context, 'xcodebuild', ['-version'], { capture: true }) !== receipt.xcode) fail('Xcode version changed after prepare; create a new run');
  if (context.phase === 'build') {
    if (receipt.built) fail('Run already has a build; use export or create a new run');
    await verifySource(context.run, receipt);
    const folder = `build-${randomUUID()}`;
    await mkdir(join(context.run, folder), { mode: 0o700 });
    const archive = join(context.run, folder, 'KCoderStudio.xcarchive');
    await command(context, 'xcodebuild', [
      '-workspace', 'ios/KCoderStudio.xcworkspace', '-scheme', 'KCoderStudio', '-configuration', 'Release',
      '-destination', 'generic/platform=iOS', '-archivePath', archive, '-derivedDataPath', join(context.run, 'DerivedData'),
      '-jobs', '4', ...(options['allow-provisioning-updates'] ? ['-allowProvisioningUpdates'] : []),
      `DEVELOPMENT_TEAM=${receipt.team}`, 'CODE_SIGN_STYLE=Automatic', `CURRENT_PROJECT_VERSION=${receipt.buildNumber}`, 'archive',
    ], { cwd: join(context.run, 'source', SCOPES[0]) });
    const appRelative = `${folder}/KCoderStudio.xcarchive/Products/Applications/KCoderStudio.app`;
    const app = await containedPath(context.run, appRelative);
    const identity = await verifyApp(context, app, receipt);
    receipt.built = { archive: `${folder}/KCoderStudio.xcarchive`, app: appRelative, appSha256: await treeDigest(app), identity, completedAt: new Date().toISOString() };
  } else if (context.phase === 'export') {
    if (!receipt.built) fail('Run build before export');
    if (receipt.exported) fail('Run already has an export; use install or create a new run');
    const app = await containedPath(context.run, receipt.built.app);
    if (await treeDigest(app) !== receipt.built.appSha256) fail('Archived app changed after verification');
    const exportPath = join(context.run, `export-${randomUUID()}`);
    const plist = join(context.run, `export-options-${randomUUID()}.plist`);
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>method</key><string>debugging</string><key>teamID</key><string>${receipt.team}</string><key>signingStyle</key><string>automatic</string><key>manageAppVersionAndBuildNumber</key><false/></dict></plist>`, { mode: 0o600 });
    await command(context, 'xcodebuild', ['-exportArchive', '-archivePath', await containedPath(context.run, receipt.built.archive), '-exportPath', exportPath, '-exportOptionsPlist', plist, ...(options['allow-provisioning-updates'] ? ['-allowProvisioningUpdates'] : [])]);
    const ipas = (await readdir(exportPath)).filter(name => name.endsWith('.ipa'));
    if (ipas.length !== 1) fail('Export must produce exactly one IPA');
    const ipa = join(exportPath, ipas[0]);
    const unpack = join(exportPath, 'verified');
    await command(context, '/usr/bin/ditto', ['-x', '-k', ipa, unpack]);
    const apps = (await readdir(join(unpack, 'Payload'))).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) fail('Exported IPA must contain exactly one app');
    const exportedApp = await containedPath(context.run, relative(context.run, join(unpack, 'Payload', apps[0])));
    const identity = await verifyApp(context, exportedApp, receipt);
    receipt.exported = { ipa: relative(context.run, ipa), sha256: await sha256(ipa), identity, completedAt: new Date().toISOString() };
  } else if (context.phase === 'install') {
    if (!options.device) fail('install requires --device');
    if (!receipt.built) fail('Run build before install');
    const deviceInfo = join(context.run, `device-info-${randomUUID()}.json`);
    await command(context, 'xcrun', ['devicectl', 'device', 'info', 'details', '--device', options.device, '--json-output', deviceInfo]);
    const udid = canonicalDeviceId(JSON.parse(await readFile(deviceInfo, 'utf8')));
    assertInstallAllowed(receipt, udid);
    let app;
    if (receipt.exported) {
      const ipa = await containedPath(context.run, receipt.exported.ipa);
      if (await sha256(ipa) !== receipt.exported.sha256) fail('IPA changed after export');
      const unpack = join(context.run, `install-${randomUUID()}`);
      await command(context, '/usr/bin/ditto', ['-x', '-k', ipa, unpack]);
      const apps = (await readdir(join(unpack, 'Payload'))).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) fail('IPA must contain exactly one app');
      app = await containedPath(context.run, relative(context.run, join(unpack, 'Payload', apps[0])));
    } else {
      app = await containedPath(context.run, receipt.built.app);
      if (await treeDigest(app) !== receipt.built.appSha256) fail('Archived app changed after verification');
    }
    const identity = await verifyApp(context, app, receipt, udid);
    const toolResults = { install: `device-install-${randomUUID()}.json` };
    if (options.launch) toolResults.launch = `device-launch-${randomUUID()}.json`;
    const installation = { device: options.device, udid, status: 'unknown', identity, toolResults, attemptedAt: new Date().toISOString() };
    receipt.installations ??= {};
    receipt.installations[udid] = installation;
    await atomicJson(join(context.run, 'receipt.json'), receipt);
    // Persist unknown before a side effect; a lost receipt must never cause an automatic reinstall.
    await command(context, 'xcrun', ['devicectl', 'device', 'install', 'app', '--device', options.device, app, '--json-output', join(context.run, toolResults.install)]);
    installation.status = 'installed';
    installation.installedAt = new Date().toISOString();
    await atomicJson(join(context.run, 'receipt.json'), receipt);
    if (options.launch) {
      await command(context, 'xcrun', ['devicectl', 'device', 'process', 'launch', '--device', options.device, BUNDLE_ID, '--json-output', join(context.run, toolResults.launch)]);
      installation.launch = 'accepted';
    }
  }
  await atomicJson(join(context.run, 'receipt.json'), receipt);
  return receipt;
}

export async function cli(selected, argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(`Usage: node scripts/release/${selected}_mobile_ios.mjs [options]\n\nPhases: prepare, build, export, install. deploy runs prepare/build/install.\n--export-ipa                    Also export an IPA during deploy\n--run DIR                       Private run directory (required after prepare)\n--ref REF                       Committed source for prepare (default HEAD)\n--team TEAM --build-number N     Required for prepare/deploy\n--developer-dir DIR             Full Xcode Contents/Developer directory\n--pod FILE                      CocoaPods executable for prepare\n--device ID --launch             Install target and optional launch\n--allow-provisioning-updates     Let Xcode update signing profiles\n--allow-http                    Explicit private-network HTTP support\n--dry-run                       Print phases only, without tool execution\n--help                          Show help\n\nRun on the Mac. No SSH, TestFlight upload, CI setup, or automatic device selection.`);
      return;
    }
    const phases = selected === 'deploy' ? PHASES.filter(value => value !== 'export' || options['export-ipa']) : [selected];
    const allowed = new Set(['run', 'developer-dir', 'dry-run', 'help', ...(selected === 'deploy' ? ['export-ipa'] : []), ...(phases.includes('prepare') ? ['ref', 'team', 'build-number', 'pod', 'allow-http'] : []), ...(phases.includes('build') || phases.includes('export') ? ['allow-provisioning-updates'] : []), ...(phases.includes('install') ? ['device', 'launch'] : [])]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) fail(`--${key} does not apply to ${selected}`);
    if (phases.includes('prepare') && (!options.team || !options['build-number'])) fail('prepare/deploy requires --team and --build-number');
    if (phases.includes('install') && !options.device) fail('install/deploy requires --device');
    if (!phases.includes('prepare') && !options.run) fail('--run is required');
    const run = resolve(options.run || join(REPO, 'target/packages/kcoder-studio-mobile', `ios-${Date.now()}-${randomUUID()}`));
    if (options['dry-run']) { console.log(JSON.stringify({ run, phases, ref: options.ref || 'HEAD', mutates: false }, null, 2)); return; }
    if (process.platform !== 'darwin') fail('iOS deployment requires macOS with full Xcode; --dry-run is available on other hosts');
    if (phases.includes('prepare')) {
      await mkdir(dirname(run), { recursive: true });
      await mkdir(run, { mode: 0o700 });
      await mkdir(join(run, 'logs'), { mode: 0o700 });
    }
    await withRunLock(run, async () => {
      const context = { run, env: buildEnvironment(process.env, options), step: 0, phase: '' };
      // Unique log names also preserve evidence when a later phase runs in another process.
      const previousLogs = await readdir(join(run, 'logs'));
      context.step = Math.max(0, ...previousLogs.map(name => Number(name.split('-')[0]) || 0));
      for (const current of phases) {
        context.phase = current;
        console.log(`iOS ${current}: ${run}`);
        await executePhase(context, options);
      }
    });
    console.log(`Completed ${selected}. Receipt: ${join(run, 'receipt.json')}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
