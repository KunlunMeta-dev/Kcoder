import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRelayCaddySnippet,
  assertPort80ListenerStateUnchanged,
  createCaddyCleanupPlan,
  createCaddyInstallPlan,
  parseRelayCaddySettings,
  validateRelayOnDemandTls,
} from './caddy-lifecycle.mjs';

const TEST_ROOT = process.env.KCODER_RELAY_INTERNAL_TEST_ROOT;
if (TEST_ROOT && !/^\/tmp\/kcoder-relay-lifecycle-test-[a-f0-9]{24}$/.test(TEST_ROOT)) {
  throw new Error('Invalid internal Relay lifecycle test namespace');
}
const ROOT_UID = TEST_ROOT ? process.getuid() : 0;
const hostPath = (path) => TEST_ROOT ? join(TEST_ROOT, path.replace(/^\//, '')) : path;
const TEST_BIN = TEST_ROOT ? join(TEST_ROOT, 'bin') : undefined;
const TRUSTED_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

function validatePrivateTestDirectory(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error(`Internal lifecycle test directory is missing: ${path}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || realpathSync(path) !== path) {
    throw new Error(`Internal lifecycle test directory is unsafe: ${path}`);
  }
}

function validateTestExecutable(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error(`Required internal command shim is missing: ${path}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0 || stat.nlink !== 1 || realpathSync(path) !== path) {
    throw new Error(`Internal command shim is unsafe: ${path}`);
  }
  let parent = dirname(path);
  while (parent !== TEST_ROOT) {
    let parentStat;
    try { parentStat = lstatSync(parent); }
    catch { throw new Error(`Internal command shim parent is missing: ${parent}`); }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid()
        || (parentStat.mode & 0o022) !== 0 || realpathSync(parent) !== parent) {
      throw new Error(`Internal command shim parent is unsafe: ${parent}`);
    }
    const relativeParent = relative(TEST_ROOT, parent);
    if (relativeParent === '..' || relativeParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        || relativeParent === '') throw new Error(`Internal command shim parent escapes its namespace: ${parent}`);
    parent = dirname(parent);
  }
}

function validateProductionExecutable(path) {
  let resolved;
  try { resolved = realpathSync(path); }
  catch { fail(`Trusted executable is missing: ${path}`); }
  if (resolved !== path) fail(`Trusted executable must not be a symlink: ${path}`, EXIT.conflict);
  let cursor = path;
  while (cursor !== '/') {
    let stat;
    try { stat = lstatSync(cursor); }
    catch { fail(`Trusted executable path is missing: ${cursor}`); }
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      fail(`Trusted executable path is unsafe: ${cursor}`, EXIT.conflict);
    }
    cursor = dirname(cursor);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) fail(`Trusted executable is not executable: ${path}`, EXIT.conflict);
}

if (TEST_ROOT) {
  validatePrivateTestDirectory(TEST_ROOT);
  validatePrivateTestDirectory(TEST_BIN);
  for (const command of ['systemctl', 'getent', 'id', 'groupadd', 'useradd', 'chown']) {
    validateTestExecutable(join(TEST_BIN, command));
  }
}

const ROOT = hostPath('/opt/kcoder-relay');
const ENV_PATH = hostPath('/etc/kcoder-relay.env');
const REGISTRY_PATH = hostPath('/etc/kcoder-relay-registry.json');
const UNIT_PATH = hostPath('/etc/systemd/system/kcoder-relay.service');
const UNIT_NAME = 'kcoder-relay.service';
const RECEIPT_DIR = hostPath('/var/lib/kcoder-relay-deploy');
const RECEIPT_PATH = `${RECEIPT_DIR}/owner.json`;
const REGISTRATION_STORE = hostPath('/var/lib/kcoder-relay/registered-gateways.json');
const CADDY_PATH = hostPath('/etc/caddy/Caddyfile');
const CADDY_FRAGMENT_PATH = hostPath('/etc/caddy/kcoder-relay.caddy');
const EXIT = { usage: 2, conflict: 3, host: 4 };

class LifecycleError extends Error {
  constructor(message, code = EXIT.host) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = EXIT.host) {
  throw new LifecycleError(message, code);
}

function parseArgs(args) {
  const action = args[0];
  if (!['prepare', 'install', 'upgrade', 'status', 'cleanup'].includes(action)) fail('Unsupported Relay host action', EXIT.usage);
  const options = { action, stageDir: undefined, checkOnly: false, adoptExisting: false, purgeData: false };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--stage-dir') {
      if (options.stageDir || index + 1 >= args.length) fail('Invalid --stage-dir argument', EXIT.usage);
      options.stageDir = args[++index];
    } else if (argument === '--check-only') {
      if (action !== 'prepare' || options.checkOnly) fail('Invalid --check-only argument', EXIT.usage);
      options.checkOnly = true;
    } else if (argument === '--adopt-existing') {
      if (!['install', 'upgrade'].includes(action) || options.adoptExisting) fail('Invalid --adopt-existing argument', EXIT.usage);
      options.adoptExisting = true;
    } else if (argument === '--purge-data') {
      if (action !== 'cleanup' || options.purgeData) fail('Invalid --purge-data argument', EXIT.usage);
      options.purgeData = true;
    } else {
      fail(`Unknown Relay host argument: ${argument}`, EXIT.usage);
    }
  }
  if (!options.stageDir || !/^\/var\/tmp\/kcoder-relay-deploy-[a-f0-9]{16,64}$/.test(options.stageDir)) {
    fail('A valid private deployment staging directory is required', EXIT.usage);
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readRegularFile(path, { maxBytes = 64 * 1024 * 1024, ownerUid, privateMode = false } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`Unsafe regular file: ${path}`, EXIT.conflict);
  if (ownerUid !== undefined && stat.uid !== ownerUid) fail(`Unexpected owner for ${path}`, EXIT.conflict);
  if (privateMode && (stat.mode & 0o077) !== 0) fail(`Private file permissions are required for ${path}`, EXIT.conflict);
  if (stat.size > maxBytes) fail(`File exceeds the permitted size: ${path}`);
  return readFileSync(path);
}

function safeDirectory(path, { create = false, mode = 0o755 } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    mkdirSync(path, { mode });
    chmodSync(path, mode);
    stat = lstatSync(path);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ROOT_UID || (stat.mode & 0o022) !== 0) {
    fail(`Unsafe or unowned directory: ${path}`, EXIT.conflict);
  }
  return stat;
}

function ensureParent(path) {
  const parent = dirname(path);
  const missing = [];
  let cursor = parent;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  safeDirectory(cursor);
  for (const item of missing.reverse()) safeDirectory(item, { create: true, mode: 0o755 });
  safeDirectory(parent);
}

function atomicWrite(path, contents, mode = 0o644) {
  ensureParent(path);
  const temporary = `${path}.kcoder-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, contents, { mode, flag: 'wx' });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function assertFileRevision(path, expectedHash) {
  if ((currentHash(path) ?? null) !== expectedHash) {
    fail(`Relay deployment found a concurrent file revision: ${path}`, EXIT.conflict);
  }
}

function atomicWriteIfRevision(path, contents, mode, expectedHash) {
  ensureParent(path);
  const temporary = `${path}.kcoder-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporary, contents, { mode, flag: 'wx' });
    chmodSync(temporary, mode);
    assertFileRevision(path, expectedHash);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function atomicJson(path, value, mode = 0o600) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function run(command, args, { allowFailure = false, env = process.env } = {}) {
  let executable;
  let commandEnv;
  if (TEST_ROOT) {
    if (command.startsWith('/')) {
      executable = resolve(command);
      const relativePath = relative(TEST_ROOT, executable);
      if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || relativePath === '') {
        fail(`Internal lifecycle fixture command escapes its test namespace: ${command}`, EXIT.conflict);
      }
    } else {
      executable = join(TEST_BIN, command);
    }
    validateTestExecutable(executable);
    commandEnv = { PATH: TEST_BIN, HOME: TEST_ROOT, LC_ALL: 'C', ...Object.fromEntries(
      Object.entries(env).filter(([key]) => ['KCODER_RELAY_INTERNAL_TEST_ROOT', 'KCODER_RELAY_INTERNAL_TEST_NODE'].includes(key)
        || ['FAIL_RELAY_RESTART_ONCE', 'FAIL_CADDY_RELOAD_ONCE', 'CADDY_BIN', 'CADDY_CONFIG', 'TEST_STATE_DIR'].includes(key)),
    ) };
  } else {
    if (command.startsWith('/')) {
      executable = resolve(command);
    } else {
      executable = undefined;
      for (const directory of TRUSTED_PATH.split(':')) {
        const candidate = join(directory, command);
        try { lstatSync(candidate); executable = candidate; break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!executable) fail(`Trusted system command is unavailable: ${command}`);
    }
    validateProductionExecutable(executable);
    commandEnv = { ...env, PATH: TRUSTED_PATH };
  }
  const result = spawnSync(executable, args, { encoding: 'utf8', env: commandEnv, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr?.trim();
    fail(detail ? `${command} failed: ${detail}` : `${command} failed with exit ${result.status}`);
  }
  return { status: result.status ?? 4, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function systemctl(args, { allowFailure = false } = {}) {
  return run('systemctl', args, { allowFailure });
}

function isActive(unit) {
  return systemctl(['is-active', '--quiet', unit], { allowFailure: true }).status === 0;
}

function relayUnitActiveState() {
  const result = systemctl(['is-active', '--quiet', UNIT_NAME], { allowFailure: true });
  if (result.status === 0) return true;
  if ([3, 4].includes(result.status)) return false;
  fail('Could not determine the Relay service active state');
}

function relayUnitEnabledState() {
  const result = systemctl(['is-enabled', '--quiet', UNIT_NAME], { allowFailure: true });
  if (result.status === 0) return true;
  if ([1, 4].includes(result.status)) return false;
  fail('Could not determine the Relay service enabled state');
}

function relayUnitShow(property, { allowMissing = false } = {}) {
  const result = systemctl(['show', UNIT_NAME, `--property=${property}`, '--value'], { allowFailure: true });
  if (result.status !== 0) {
    if (allowMissing && [1, 4].includes(result.status)) return '';
    fail(`Could not inspect the Relay service ${property}`);
  }
  return result.stdout.trim();
}

function verifyRelayUnitState(expected, { unitFileExists } = {}) {
  const active = relayUnitActiveState();
  const enabled = relayUnitEnabledState();
  const mainPidText = relayUnitShow('MainPID', { allowMissing: !unitFileExists });
  const mainPid = mainPidText === '' && !unitFileExists ? 0 : Number(mainPidText);
  const fragmentPath = relayUnitShow('FragmentPath', { allowMissing: !unitFileExists });
  if (!Number.isInteger(mainPid) || mainPid < 0 || active !== expected.active || enabled !== expected.enabled
      || (expected.active ? mainPid <= 0 : mainPid !== 0)
      || (unitFileExists ? fragmentPath !== UNIT_PATH : fragmentPath !== '')) {
    fail('Could not verify the restored Relay service file, active, enabled, or process state');
  }
}

function stopNewRelayUnitBeforeRemovingFiles(transaction) {
  const active = relayUnitActiveState();
  const enabled = relayUnitEnabledState();
  if (active) systemctl(['stop', UNIT_NAME]);
  if (enabled) systemctl(['disable', UNIT_NAME]);
  systemctl(['daemon-reload']);
  verifyRelayUnitState({ active: false, enabled: false }, { unitFileExists: existsSync(UNIT_PATH) });
}

function captureRelayUnitState() {
  const active = relayUnitActiveState();
  const enabled = relayUnitEnabledState();
  const mainPidText = relayUnitShow('MainPID', { allowMissing: !existsSync(UNIT_PATH) });
  const mainPid = mainPidText === '' && !existsSync(UNIT_PATH) ? 0 : Number(mainPidText);
  const fragmentPath = relayUnitShow('FragmentPath', { allowMissing: !existsSync(UNIT_PATH) });
  if (!Number.isInteger(mainPid) || mainPid < 0 || (active ? mainPid <= 0 : mainPid !== 0)
      || (existsSync(UNIT_PATH) ? fragmentPath !== UNIT_PATH : fragmentPath !== '')) {
    fail('Could not capture a verifiable Relay service state');
  }
  return { active, enabled, mainPid };
}

function parseEnvironmentFile(contents, allowedKeys) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !allowedKeys.has(match[1]) || values.has(match[1]) || /[\u0000-\r\n]/.test(match[2])) {
      fail('Deployment environment contains an unsupported or duplicate setting', EXIT.conflict);
    }
    values.set(match[1], match[2]);
  }
  return values;
}

function formatEnvironment(values) {
  return `${[...values].map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function validateCloudEnvironment(stageDir) {
  const path = join(stageDir, 'cloud.env');
  const buffer = readRegularFile(path, { maxBytes: 64 * 1024, privateMode: true });
  if (!buffer) fail('Private cloud environment file is missing', EXIT.conflict);
  const values = parseEnvironmentFile(buffer.toString('utf8'), new Set([
    'KCODER_RELAY_PUBLIC_URL', 'KCODER_RELAY_CONTROL_PORT', 'KCODER_RELAY_PROXY_PORT', 'KCODER_RELAY_REGISTRATION_STORE_FILE',
    'KCODER_RELAY_REGISTRATION_KEY', 'KCODER_RELAY_REGISTRY_FILE', 'KCODER_RELAY_DEVICE_ID',
    'KCODER_RELAY_GATEWAY_ID', 'KCODER_RELAY_SECRET',
    'KCODER_RELAY_ADMIN_USERNAME', 'KCODER_RELAY_ADMIN_PASSWORD_HASH',
  ]));
  const port = (key) => {
    const value = Number(values.get(key));
    if (!Number.isInteger(value) || value < 1024 || value > 65535) fail(`Invalid ${key}`);
    return value;
  };
  const controlPort = port('KCODER_RELAY_CONTROL_PORT');
  const proxyPort = port('KCODER_RELAY_PROXY_PORT');
  if (controlPort === proxyPort) fail('Relay control and proxy ports must differ');
  const key = values.get('KCODER_RELAY_REGISTRATION_KEY');
  const adminHash = values.get('KCODER_RELAY_ADMIN_PASSWORD_HASH');
  if (adminHash !== undefined && !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(adminHash)) fail('Invalid administrator password hash', EXIT.conflict);
  if (values.has('KCODER_RELAY_ADMIN_USERNAME') && !/^[A-Za-z0-9_.@-]{1,100}$/.test(values.get('KCODER_RELAY_ADMIN_USERNAME'))) fail('Invalid administrator username', EXIT.conflict);
  if (key !== undefined && !/^[A-Za-z0-9._~-]{32,512}$/.test(key)) fail('Invalid registration key', EXIT.conflict);
  const gatewayId = values.get('KCODER_RELAY_GATEWAY_ID');
  const legacyId = values.get('KCODER_RELAY_DEVICE_ID');
  if (gatewayId !== undefined && legacyId !== undefined && gatewayId !== legacyId) fail('Conflicting Relay Gateway IDs', EXIT.conflict);
  if (values.get('KCODER_RELAY_SECRET') !== undefined && values.get('KCODER_RELAY_SECRET').length < 32) {
    fail('Invalid Relay secret', EXIT.conflict);
  }
  if (values.get('KCODER_RELAY_REGISTRATION_STORE_FILE') !== undefined
      && values.get('KCODER_RELAY_REGISTRATION_STORE_FILE') !== '/var/lib/kcoder-relay/registered-gateways.json') {
    fail('Relay registration store path must be the persistent service store', EXIT.conflict);
  }
  return { values, controlPort, proxyPort };
}

function sourceFiles(stageDir) {
  const files = new Map();
  const addTree = (from, to) => {
    const rootStat = lstatSync(from);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`Unsafe staged directory: ${from}`, EXIT.conflict);
    const walk = (source, destination) => {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.name === '.bin') continue;
        const sourcePath = join(source, entry.name);
        const targetPath = join(destination, entry.name);
        const stat = lstatSync(sourcePath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          walk(sourcePath, targetPath);
        } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
          files.set(targetPath, { contents: readFileSync(sourcePath), mode: sourcePath.endsWith('.sh') ? 0o755 : 0o644 });
        } else {
          fail(`Unsafe staged source entry: ${sourcePath}`, EXIT.conflict);
        }
      }
    };
    walk(from, to);
  };
  addTree(join(stageDir, 'src'), `${ROOT}/src`);
  addTree(join(stageDir, 'deploy'), `${ROOT}/deploy`);
  addTree(join(stageDir, 'node_modules'), `${ROOT}/node_modules`);
  for (const name of ['package.json', 'package-lock.json']) {
    const path = join(stageDir, name);
    const contents = readRegularFile(path, { maxBytes: 4 * 1024 * 1024 });
    if (!contents) fail(`Staged Relay package metadata is missing: ${name}`, EXIT.conflict);
    files.set(`${ROOT}/${name}`, { contents, mode: 0o644 });
  }
  const routes = readRegularFile(join(stageDir, 'gatewayConnectionRoutes.runtime.mjs'), { maxBytes: 1024 * 1024 });
  if (!routes) fail('Staged Gateway route contract is missing', EXIT.conflict);
  files.set(`${ROOT}/src/gatewayConnectionRoutes.runtime.mjs`, { contents: routes, mode: 0o644 });
  return files;
}

function hashPlan(files) {
  return Object.fromEntries([...files].map(([path, item]) => [path, sha256(item.contents)]));
}

function beginTransaction({ paths, expectedWrites, unitState, preconditionHashes = {} }) {
  for (const [path, expectedHash] of Object.entries(preconditionHashes)) assertFileRevision(path, expectedHash);
  makeReceiptDirectory();
  const id = randomBytes(12).toString('hex');
  const directory = join(RECEIPT_DIR, `transaction-${id}`);
  safeDirectory(directory, { create: true, mode: 0o700 });
  const snapshots = {};
  for (const [index, path] of [...new Set(paths)].entries()) {
    const contents = readRegularFile(path, { maxBytes: 64 * 1024 * 1024 });
    if (Object.hasOwn(preconditionHashes, path) && (contents ? sha256(contents) : null) !== preconditionHashes[path]) {
      rmSync(directory, { recursive: true, force: true });
      if (!existsSync(RECEIPT_PATH)) {
        try { rmdirSync(RECEIPT_DIR); } catch { /* Keep pre-existing private owner state. */ }
      }
      fail(`Relay deployment found a concurrent file revision: ${path}`, EXIT.conflict);
    }
    if (contents === undefined) {
      snapshots[path] = { exists: false };
      continue;
    }
    const stat = lstatSync(path);
    const backupPath = join(directory, `file-${index.toString(16).padStart(4, '0')}`);
    writeFileSync(backupPath, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(backupPath, 0o600);
    snapshots[path] = {
      exists: true,
      backupPath,
      hash: sha256(contents),
      mode: stat.mode & 0o777,
      uid: stat.uid,
      gid: stat.gid,
    };
  }

  const previousReceipt = readRegularFile(RECEIPT_PATH, { maxBytes: 1024 * 1024, ownerUid: ROOT_UID, privateMode: true });
  const previousReceiptPath = previousReceipt ? join(directory, 'owner.previous.json') : undefined;
  if (previousReceipt) {
    writeFileSync(previousReceiptPath, previousReceipt, { mode: 0o600, flag: 'wx' });
    chmodSync(previousReceiptPath, 0o600);
  }
  return {
    id,
    directory,
    state: 'applying',
    snapshots,
    expectedWrites: { ...expectedWrites },
    unitState,
    previousReceiptExists: Boolean(previousReceipt),
    previousReceiptPath,
    previousReceiptHash: previousReceipt ? sha256(previousReceipt) : undefined,
  };
}

function currentSafeHash(path) {
  const contents = readRegularFile(path, { maxBytes: 64 * 1024 * 1024 });
  return contents === undefined ? undefined : sha256(contents);
}

function restoreSnapshotFile(path, snapshot, contents) {
  if (path !== REGISTRATION_STORE) {
    atomicWrite(path, contents, snapshot.mode);
  } else {
    const parent = dirname(path);
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== snapshot.uid || (parentStat.mode & 0o077) !== 0) {
      fail('Relay registration store directory is not private and service-owned', EXIT.conflict);
    }
    const temporary = `${path}.kcoder-rollback-${process.pid}-${randomBytes(6).toString('hex')}`;
    writeFileSync(temporary, contents, { mode: snapshot.mode, flag: 'wx' });
    chmodSync(temporary, snapshot.mode);
    run('chown', [`${snapshot.uid}:${snapshot.gid}`, temporary]);
    renameSync(temporary, path);
  }
  if ((snapshot.uid !== ROOT_UID || snapshot.gid !== ROOT_UID) && path !== REGISTRATION_STORE) {
    run('chown', [`${snapshot.uid}:${snapshot.gid}`, path]);
  }
}

function validateTransactionBackups(transaction) {
  if (!transaction || !/^[a-f0-9]{24}$/.test(transaction.id || '')
      || transaction.directory !== join(RECEIPT_DIR, `transaction-${transaction.id}`)
      || !transaction.snapshots || typeof transaction.snapshots !== 'object'
      || !transaction.expectedWrites || typeof transaction.expectedWrites !== 'object') {
    fail('Relay transaction receipt is invalid', EXIT.conflict);
  }
  safeDirectory(transaction.directory);
  for (const [path, snapshot] of Object.entries(transaction.snapshots)) {
    if (!snapshot.exists) continue;
    if (typeof snapshot.backupPath !== 'string' || !snapshot.backupPath.startsWith(`${transaction.directory}/`)) {
      fail('Relay rollback backup path is invalid', EXIT.conflict);
    }
    const contents = readRegularFile(snapshot.backupPath, { maxBytes: 64 * 1024 * 1024, ownerUid: ROOT_UID, privateMode: true });
    if (!contents || sha256(contents) !== snapshot.hash) fail('Relay rollback backup is missing or changed', EXIT.conflict);
  }
  if (transaction.previousReceiptExists) {
    const previous = readRegularFile(transaction.previousReceiptPath, { maxBytes: 1024 * 1024, ownerUid: ROOT_UID, privateMode: true });
    if (!previous || sha256(previous) !== transaction.previousReceiptHash) fail('Previous Relay owner receipt backup is missing or changed', EXIT.conflict);
  }
}

function restoreTransactionFiles(transaction) {
  validateTransactionBackups(transaction);
  for (const [path, snapshot] of Object.entries(transaction.snapshots)) {
    const actualHash = currentSafeHash(path);
    const expectedHash = transaction.expectedWrites[path];
    const isAlreadyRestored = snapshot.exists ? actualHash === snapshot.hash : actualHash === undefined;
    const isOurChange = snapshot.exists
      ? (expectedHash === null ? actualHash === undefined : actualHash === expectedHash)
      : (typeof expectedHash === 'string' && actualHash === expectedHash);
    if (!isAlreadyRestored && !isOurChange) {
      fail(`Relay rollback found concurrent file drift: ${path}`, EXIT.conflict);
    }
  }

  for (const [path, snapshot] of Object.entries(transaction.snapshots)) {
    const actualHash = currentSafeHash(path);
    const expectedHash = transaction.expectedWrites[path];
    const isAlreadyRestored = snapshot.exists ? actualHash === snapshot.hash : actualHash === undefined;
    if (isAlreadyRestored) continue;
    if (!snapshot.exists) {
      rmSync(path);
      continue;
    }
    const backup = readRegularFile(snapshot.backupPath, { maxBytes: 64 * 1024 * 1024, ownerUid: ROOT_UID, privateMode: true });
    restoreSnapshotFile(path, snapshot, backup);
    if (expectedHash === null && actualHash === undefined) continue;
  }
}

function restoreUnitState(transaction) {
  const unitSnapshot = transaction.snapshots[UNIT_PATH];
  systemctl(['daemon-reload']);
  if (!unitSnapshot?.exists) {
    verifyRelayUnitState({ active: false, enabled: false }, { unitFileExists: false });
    return;
  }
  if (transaction.unitState?.enabled === true) {
    if (!relayUnitEnabledState()) systemctl(['enable', UNIT_NAME]);
  } else if (relayUnitEnabledState()) {
    systemctl(['disable', UNIT_NAME]);
  }
  if (transaction.unitState?.active === true) {
    systemctl(['restart', UNIT_NAME]);
  } else if (relayUnitActiveState()) {
    systemctl(['stop', UNIT_NAME]);
  }
  verifyRelayUnitState({
    active: Boolean(transaction.unitState?.active),
    enabled: Boolean(transaction.unitState?.enabled),
  }, { unitFileExists: true });
}

function rollbackTransaction(receipt) {
  const transaction = receipt?.transaction;
  if (!transaction) return readReceipt();
  try {
    if (!transaction.snapshots[UNIT_PATH]?.exists) {
      validateTransactionBackups(transaction);
      stopNewRelayUnitBeforeRemovingFiles(transaction);
    }
    restoreTransactionFiles(transaction);
    restoreUnitState(transaction);
    if (transaction.snapshots[CADDY_PATH] || transaction.snapshots[CADDY_FRAGMENT_PATH]) {
      systemctl(['reload', 'caddy.service']);
    }
    removeOwnedEmptyDirectories(transaction.snapshots);
    if (transaction.previousReceiptExists) {
      const previous = readRegularFile(transaction.previousReceiptPath, { maxBytes: 1024 * 1024, ownerUid: ROOT_UID, privateMode: true });
      atomicWrite(RECEIPT_PATH, previous, 0o600);
    } else {
      rmSync(RECEIPT_PATH, { force: true });
    }
    rmSync(transaction.directory, { recursive: true, force: true });
    try { rmSync(RECEIPT_DIR); } catch { /* Other private owner state may remain. */ }
    return readReceipt();
  } catch (error) {
    receipt.state = 'rollback-pending';
    receipt.transaction.state = 'rollback-pending';
    try { atomicJson(RECEIPT_PATH, receipt); } catch { /* Keep the last readable transaction receipt. */ }
    throw new LifecycleError(`Relay rollback is pending: ${error.message}`, error instanceof LifecycleError ? error.code : EXIT.host);
  }
}

function completeTransaction(receipt) {
  const transaction = receipt.transaction;
  delete receipt.transaction;
  try { atomicJson(RECEIPT_PATH, receipt); }
  catch (error) {
    receipt.transaction = transaction;
    throw error;
  }
  if (transaction?.directory) rmSync(transaction.directory, { recursive: true, force: true });
}

function refreshTransactionSnapshot(receipt, path, ownerUid) {
  const transaction = receipt.transaction;
  const previousSnapshot = transaction?.snapshots?.[path];
  if (!previousSnapshot) return;
  const contents = readRegularFile(path, { maxBytes: 64 * 1024 * 1024, ownerUid, privateMode: true });
  if (!contents) {
    if (previousSnapshot.exists) fail('Relay registration store disappeared before it could be purged', EXIT.conflict);
    return;
  }
  const stat = lstatSync(path);
  const backupPath = join(transaction.directory, `refresh-${randomBytes(8).toString('hex')}`);
  writeFileSync(backupPath, contents, { mode: 0o600, flag: 'wx' });
  chmodSync(backupPath, 0o600);
  transaction.snapshots[path] = {
    exists: true, backupPath, hash: sha256(contents), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid,
  };
  try { atomicJson(RECEIPT_PATH, receipt); }
  catch (error) {
    transaction.snapshots[path] = previousSnapshot;
    throw error;
  }
}

function recoverTransaction(receipt) {
  if (!receipt?.transaction) return receipt;
  return rollbackTransaction(receipt);
}

function readReceipt() {
  const contents = readRegularFile(RECEIPT_PATH, { maxBytes: 1024 * 1024, ownerUid: ROOT_UID, privateMode: true });
  if (!contents) return undefined;
  let receipt;
  try { receipt = JSON.parse(contents.toString('utf8')); }
  catch { fail('Relay owner receipt is invalid', EXIT.conflict); }
  if (receipt?.version !== 1 || receipt.component !== 'relay' || !receipt.files || typeof receipt.files !== 'object') {
    fail('Relay owner receipt has an unsupported format', EXIT.conflict);
  }
  return receipt;
}

function hasUnmanagedRelayResources() {
  return [UNIT_PATH, ENV_PATH, CADDY_FRAGMENT_PATH, `${ROOT}/src/server.mjs`]
    .some((path) => existsSync(path));
}

function validateManagedFile(path, expectedHashes, { ownerUid = ROOT_UID, allowMissing = false, privateMode = false } = {}) {
  const contents = readRegularFile(path, { maxBytes: 64 * 1024 * 1024, ownerUid, privateMode });
  if (!contents) {
    if (allowMissing) return false;
    fail(`Managed file is missing: ${path}`, EXIT.conflict);
  }
  if (!expectedHashes.includes(sha256(contents))) fail(`Managed file drifted: ${path}`, EXIT.conflict);
  return true;
}

function cleanStatus(state, extra = {}) {
  return { component: 'relay', action: 'status', state, ...extra };
}

function statusRelay() {
  const receipt = readReceipt();
  if (!receipt) {
    if (hasUnmanagedRelayResources()) {
      return { result: cleanStatus('unmanaged'), status: EXIT.conflict };
    }
    return { result: cleanStatus('absent'), status: 0 };
  }
  const incomplete = receipt.state !== 'active' || Boolean(receipt.transaction);
  const allowMissing = incomplete;
  for (const [path, hash] of Object.entries(receipt.files)) {
    validateManagedFile(path, [...new Set([hash, receipt.previousFiles?.[path]].filter(Boolean))], {
      ownerUid: Number(receipt.fileOwners?.[path] ?? ROOT_UID),
      allowMissing,
      privateMode: path === REGISTRY_PATH,
    });
  }
  validateManagedFile(ENV_PATH, [receipt.environmentHash, ...(receipt.previousEnvironmentHashes || [])].filter(Boolean), { allowMissing, privateMode: true });
  if (receipt.registryHash) validateManagedFile(REGISTRY_PATH, [receipt.registryHash, ...(receipt.previousRegistryHashes || [])].filter(Boolean), {
    ownerUid: Number(receipt.fileOwners?.[REGISTRY_PATH] ?? ROOT_UID), allowMissing, privateMode: true,
  });
  validateManagedFile(UNIT_PATH, [receipt.unitHash, ...(receipt.previousUnitHashes || [])].filter(Boolean), { allowMissing });
  const fragmentHashes = receipt.caddy.fragmentHashes || [receipt.caddy.fragmentHash];
  validateManagedFile(CADDY_FRAGMENT_PATH, fragmentHashes.filter(Boolean), { allowMissing });
  if (!incomplete) {
    const caddyMain = readRegularFile(receipt.caddy.mainPath, { maxBytes: 4 * 1024 * 1024, ownerUid: ROOT_UID });
    if (!caddyMain || !caddyMain.toString('utf8').includes('# KCODER-RELAY-IMPORT-BEGIN v1')) {
      fail('Managed Caddy import is missing', EXIT.conflict);
    }
  }
  if (incomplete) {
    const state = receipt.transaction?.state === 'rollback-pending' || receipt.state === 'rollback-pending'
      ? 'rollback-pending'
      : 'incomplete';
    return { result: cleanStatus(state, { receiptState: receipt.state }), status: 0 };
  }
  const relayActive = isActive(UNIT_NAME);
  const caddyActive = isActive('caddy.service');
  const state = relayActive && caddyActive ? 'active' : relayActive ? 'unhealthy' : 'inactive';
  return {
    result: cleanStatus(state, {
      relayUnit: UNIT_NAME,
      relayActive,
      caddyActive,
      healthy: relayActive && caddyActive,
      publicUrl: receipt.publicUrl,
      registrationStore: existsSync(REGISTRATION_STORE) ? { state: 'present' } : { state: 'not-created' },
    }),
    status: 0,
  };
}

function relayUnit(nodePath) {
  return [
    '[Unit]',
    'Description=KCoder public reverse relay',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'User=kcoder-relay',
    'Group=kcoder-relay',
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=${ENV_PATH}`,
    'StateDirectory=kcoder-relay',
    'StateDirectoryMode=0700',
    'UMask=0077',
    `ExecStart=${nodePath} ${ROOT}/src/server.mjs`,
    'Restart=always',
    'RestartSec=3',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'LimitNOFILE=4096',
    'MemoryMax=256M',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function relayAccountInfo() {
  const group = run('getent', ['group', 'kcoder-relay'], { allowFailure: true });
  const user = run('getent', ['passwd', 'kcoder-relay'], { allowFailure: true });
  if (group.status !== 0 || user.status !== 0) return undefined;
  const groupFields = group.stdout.trim().split(':');
  const userFields = user.stdout.trim().split(':');
  const gid = Number(groupFields[2]);
  const uid = Number(userFields[2]);
  if (groupFields[0] !== 'kcoder-relay' || !Number.isInteger(gid) || gid <= 0 || gid >= 65534
      || userFields[0] !== 'kcoder-relay' || !Number.isInteger(uid) || uid <= 0 || uid >= 65534
      || Number(userFields[3]) !== gid || userFields[5] !== '/var/lib/kcoder-relay'
      || !['/usr/sbin/nologin', '/sbin/nologin'].includes(userFields[6])) {
    fail('The existing kcoder-relay account does not match the locked service identity', EXIT.conflict);
  }
  const byUid = run('getent', ['passwd', String(uid)], { allowFailure: true });
  const byGid = run('getent', ['group', String(gid)], { allowFailure: true });
  if (byUid.status !== 0 || byUid.stdout.trim().split(':')[0] !== 'kcoder-relay'
      || byGid.status !== 0 || byGid.stdout.trim().split(':')[0] !== 'kcoder-relay') {
    fail('The kcoder-relay UID or GID is shared by another account', EXIT.conflict);
  }
  const supplementary = run('id', ['-G', 'kcoder-relay'], { allowFailure: true });
  const groups = supplementary.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  if (supplementary.status !== 0 || groups.length !== 1 || groups[0] !== gid) {
    fail('The kcoder-relay account has unexpected supplementary groups', EXIT.conflict);
  }
  return { uid, gid };
}

function ensureRelayAccount(adoptExisting) {
  let identity = relayAccountInfo();
  const group = run('getent', ['group', 'kcoder-relay'], { allowFailure: true });
  const user = run('getent', ['passwd', 'kcoder-relay'], { allowFailure: true });
  if (!identity && (group.status === 0 || user.status === 0) && !adoptExisting && !readReceipt()) {
    fail('The kcoder-relay account already exists; pass --adopt-existing after verifying its service identity', EXIT.conflict);
  }
  if (group.status !== 0) run('groupadd', ['--system', 'kcoder-relay']);
  if (user.status !== 0) {
    const nologin = existsSync('/usr/sbin/nologin') ? '/usr/sbin/nologin' : '/sbin/nologin';
    run('useradd', ['--system', '--gid', 'kcoder-relay', '--home-dir', '/var/lib/kcoder-relay', '--shell', nologin, 'kcoder-relay']);
  }
  identity = relayAccountInfo();
  if (!identity) fail('Could not verify the kcoder-relay service identity');
  return identity;
}

function nodePathForUnit() {
  const paths = TEST_ROOT
    ? [process.env.KCODER_RELAY_INTERNAL_TEST_NODE]
    : [hostPath('/opt/kcoder-relay/runtime/node'), '/usr/bin/node', '/usr/bin/nodejs'];
  for (const path of paths) {
    if (!path) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== ROOT_UID || (stat.mode & 0o022) !== 0) continue;
      if (TEST_ROOT && path === process.env.KCODER_RELAY_INTERNAL_TEST_NODE) validateTestExecutable(path);
      else if (TEST_ROOT) continue;
      const version = TEST_ROOT
        ? process.versions.node
        : run(path, ['--eval', 'process.stdout.write(process.versions.node)']).stdout.trim();
      const major = Number(version.split('.')[0]);
      if (Number.isInteger(major) && major >= 18) return path;
    } catch { /* Continue to the next controlled runtime path. */ }
  }
  fail('No supported controlled Node.js runtime is available for the Relay unit');
}

function caddyInfo() {
  const active = systemctl(['is-active', '--quiet', 'caddy.service'], { allowFailure: true }).status === 0;
  const start = systemctl(['show', 'caddy.service', '--property=ExecStart', '--value'], { allowFailure: true });
  if (start.status !== 0) fail('A managed caddy.service is required; refusing to install or replace Caddy');
  const path = start.stdout.match(/(?:^|[;{]\s*)path=([^ ;}]+)/)?.[1]
    || start.stdout.match(/(?:^|\s)(\/[^\s;]+caddy[^\s;]*)(?:\s|$)/)?.[1];
  if (!path) fail('Could not identify the active Caddy executable');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== ROOT_UID || (stat.mode & 0o022) !== 0) {
    fail('Caddy executable is not a controlled root-owned file', EXIT.conflict);
  }
  const argsText = start.stdout.match(/argv\[\]=([^;}]*)/)?.[1] || '';
  const configMatch = argsText.match(/(?:^|\s)--config\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const configPath = configMatch ? (configMatch[1] || configMatch[2] || configMatch[3]) : CADDY_PATH;
  const adapterMatch = argsText.match(/(?:^|\s)--adapter\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (configPath !== CADDY_PATH || (adapterMatch && (adapterMatch[1] || adapterMatch[2] || adapterMatch[3]) !== 'caddyfile')) {
    fail('Caddy must use the supported /etc/caddy/Caddyfile Caddyfile adapter');
  }
  const mainContents = readRegularFile(CADDY_PATH, { maxBytes: 4 * 1024 * 1024, ownerUid: ROOT_UID });
  if (mainContents === undefined) {
    fail('The active Caddy service must have a persistent /etc/caddy/Caddyfile; refusing to create or replace its main configuration', EXIT.conflict);
  }
  return {
    path,
    active,
    mainContents: mainContents?.toString('utf8') || '',
    mainFileExists: mainContents !== undefined,
    mainHash: mainContents === undefined ? null : sha256(mainContents),
  };
}

function caddyEnvironment() {
  if (TEST_ROOT) {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => (
      ['CADDY_BIN', 'CADDY_CONFIG', 'TEST_STATE_DIR'].includes(key)
      || key === 'KCODER_RELAY_INTERNAL_TEST_ROOT'
    )));
  }
  const pid = Number(systemctl(['show', 'caddy.service', '--property=MainPID', '--value'], { allowFailure: true }).stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) return process.env;
  let contents;
  try { contents = readFileSync(`/proc/${pid}/environ`); }
  catch { return process.env; }
  const env = { ...process.env };
  for (const item of contents.toString('utf8').split('\0')) {
    const separator = item.indexOf('=');
    if (separator > 0) env[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return env;
}

function adaptCaddy({ caddy, mainContents, fragmentContents }) {
  const temporaryBase = `${CADDY_PATH}.kcoder-candidate-${process.pid}-${randomBytes(5).toString('hex')}`;
  const temporaryFragment = `${CADDY_FRAGMENT_PATH}.candidate-${process.pid}-${randomBytes(5).toString('hex')}`;
  const markerImport = `import ${CADDY_FRAGMENT_PATH}`;
  const candidateMain = mainContents.replaceAll(markerImport, `import ${temporaryFragment}`);
  try {
    safeDirectory(hostPath('/etc/caddy'), { create: true, mode: 0o755 });
    atomicWrite(temporaryFragment, fragmentContents, 0o600);
    atomicWrite(temporaryBase, candidateMain, 0o600);
    const env = caddyEnvironment();
    const adaptedResult = run(caddy.path, ['adapt', '--config', temporaryBase, '--adapter', 'caddyfile', '--pretty'], { env });
    let adapted;
    try { adapted = JSON.parse(adaptedResult.stdout); }
    catch { fail('Caddy adapt returned invalid JSON'); }
    run(caddy.path, ['validate', '--config', temporaryBase, '--adapter', 'caddyfile'], { env });
    return adapted;
  } finally {
    rmSync(temporaryBase, { force: true });
    rmSync(temporaryFragment, { force: true });
  }
}

function validateCaddyListener(adapted, settings) {
  const servers = adapted?.apps?.http?.servers;
  const expectedPort = String(settings.publicPort);
  const found = Object.values(servers || {}).some((server) => (server.listen || []).some((listener) => {
    const value = String(listener);
    const match = value.match(/:(\d+)$/);
    return match?.[1] === expectedPort;
  }));
  if (!found) fail('Caddy adaptation does not include the canonical Relay HTTPS port');
}

function makeReceiptDirectory() {
  safeDirectory(hostPath('/var/lib'), { create: false });
  safeDirectory(RECEIPT_DIR, { create: true, mode: 0o700 });
}

function currentHash(path) {
  const contents = readRegularFile(path, { maxBytes: 64 * 1024 * 1024 });
  return contents ? sha256(contents) : undefined;
}

function verifyExpectedExistingFiles(files, oldReceipt, adoptExisting) {
  const oldHashes = oldReceipt?.files || {};
  for (const [path, item] of files) {
    const presentHash = currentHash(path);
    if (presentHash === undefined) continue;
    const expected = sha256(item.contents);
    const owned = oldHashes[path];
    if (owned && presentHash === owned) continue;
    if (presentHash === expected && adoptExisting) continue;
    if (adoptExisting) fail(`Existing Relay file does not match the staged deployment: ${path}`, EXIT.conflict);
    fail(`Existing Relay file is not owned by this deployment: ${path}`, EXIT.conflict);
  }
}

function validateAdoptableRegistry(contents, authority) {
  let registry;
  try { registry = JSON.parse(contents.toString('utf8')); }
  catch { fail('Existing Relay registry is invalid JSON', EXIT.conflict); }
  if (!registry || Array.isArray(registry) || Object.keys(registry).sort().join(',') !== 'gateways,sharedHosts'
      || !Array.isArray(registry.sharedHosts) || registry.sharedHosts.length !== 1 || registry.sharedHosts[0] !== authority
      || !Array.isArray(registry.gateways) || registry.gateways.length === 0 || registry.gateways.length > 256) {
    fail('Existing Relay registry does not match the canonical Relay host', EXIT.conflict);
  }
  const ids = new Set();
  const credentials = new Set();
  for (const gateway of registry.gateways) {
    const keys = ['id', 'secret', 'gatewaySecret', 'maxConnections', 'maxBytesPerWindow', 'trafficWindowMs'];
    if (!gateway || Array.isArray(gateway) || Object.keys(gateway).sort().join(',') !== keys.sort().join(',')
        || typeof gateway.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(gateway.id)
        || typeof gateway.secret !== 'string' || gateway.secret.length < 32
        || typeof gateway.gatewaySecret !== 'string' || gateway.gatewaySecret.length < 32
        || gateway.secret === gateway.gatewaySecret
        || !Number.isSafeInteger(gateway.maxConnections) || gateway.maxConnections < 1
        || !Number.isSafeInteger(gateway.maxBytesPerWindow) || gateway.maxBytesPerWindow < 1
        || !Number.isSafeInteger(gateway.trafficWindowMs) || gateway.trafficWindowMs < 1) {
      fail('Existing Relay registry does not match the supported schema', EXIT.conflict);
    }
    const normalizedId = gateway.id.toLowerCase();
    if (ids.has(normalizedId) || credentials.has(gateway.secret) || credentials.has(gateway.gatewaySecret)) {
      fail('Existing Relay registry contains duplicate identities or credentials', EXIT.conflict);
    }
    ids.add(normalizedId);
    credentials.add(gateway.secret);
    credentials.add(gateway.gatewaySecret);
  }
}

function validateOldReceiptResources(receipt) {
  if (!receipt) return;
  for (const [path, oldHash] of Object.entries(receipt.files)) {
    validateManagedFile(path, [oldHash, receipt.previousFiles?.[path]].filter(Boolean), {
      ownerUid: Number(receipt.fileOwners?.[path] ?? ROOT_UID),
      allowMissing: true,
      privateMode: path === REGISTRY_PATH,
    });
  }
  const environmentHash = currentHash(ENV_PATH);
  if (environmentHash !== undefined && ![receipt.environmentHash, ...(receipt.previousEnvironmentHashes || [])].includes(environmentHash)) fail('Owned Relay environment has drifted', EXIT.conflict);
  if (receipt.registryHash) validateManagedFile(REGISTRY_PATH, [receipt.registryHash, ...(receipt.previousRegistryHashes || [])].filter(Boolean), {
    ownerUid: Number(receipt.fileOwners?.[REGISTRY_PATH] ?? ROOT_UID), allowMissing: true, privateMode: true,
  });
  const unitHash = currentHash(UNIT_PATH);
  if (unitHash !== undefined && ![receipt.unitHash, ...(receipt.previousUnitHashes || [])].includes(unitHash)) fail('Owned Relay unit has drifted', EXIT.conflict);
  if (receipt.caddy.fragmentHashes && !receipt.caddy.fragmentHashes.includes(currentHash(CADDY_FRAGMENT_PATH))) {
    fail('Owned Caddy fragment has drifted', EXIT.conflict);
  }
  const main = readRegularFile(receipt.caddy.mainPath, { maxBytes: 4 * 1024 * 1024, ownerUid: ROOT_UID });
  if (!main?.toString('utf8').includes('# KCODER-RELAY-IMPORT-BEGIN v1')) fail('Owned Caddy import has drifted', EXIT.conflict);
}

function caddyFiles({ caddy, settings, receipt, fragment, adoptExisting }) {
  if (!caddy.active) fail('The shared Caddy service must be active before Relay can manage its site');
  const oldFragmentBuffer = readRegularFile(CADDY_FRAGMENT_PATH, { maxBytes: 1024 * 1024, ownerUid: ROOT_UID });
  const oldFragment = oldFragmentBuffer?.toString('utf8');
  const oldFragmentHash = oldFragmentBuffer === undefined ? null : sha256(oldFragmentBuffer);
  assertFileRevision(CADDY_PATH, caddy.mainHash);
  assertFileRevision(CADDY_FRAGMENT_PATH, oldFragmentHash);
  const priorFragmentOwned = Boolean(receipt && receipt.caddy.fragmentHashes?.includes(oldFragmentHash));
  const plan = createCaddyInstallPlan({
    mainContents: caddy.mainContents,
    mainFileExists: caddy.mainFileExists,
    existingFragment: oldFragment,
    fragmentHashOwned: priorFragmentOwned,
    globalOwned: Boolean(receipt?.caddy?.globalCreated),
    settings,
    fragmentContents: fragment,
    adoptExisting,
  });
  const baseline = adaptCaddy({ caddy, mainContents: caddy.mainContents, fragmentContents: oldFragment || '' });
  const adapted = adaptCaddy({ caddy, mainContents: plan.mainContents, fragmentContents: plan.fragmentContents });
  try { assertPort80ListenerStateUnchanged(baseline, adapted); }
  catch (error) { fail(error.message, EXIT.conflict); }
  validateCaddyListener(adapted, settings);
  try { validateRelayOnDemandTls(adapted, settings); }
  catch (error) { fail(error.message, EXIT.conflict); }
  return {
    ...plan,
    previousFragmentHash: oldFragmentHash || undefined,
    baselineMainHash: caddy.mainHash,
    baselineFragmentHash: oldFragmentHash,
  };
}

function clearObsoleteOwnedFiles(oldReceipt, newFiles) {
  if (!oldReceipt) return;
  for (const [path, oldHash] of Object.entries(oldReceipt.files)) {
    if (path === REGISTRY_PATH) continue;
    if (newFiles.has(path)) continue;
    const actual = currentHash(path);
    if (actual === undefined) continue;
    if (actual !== oldHash) fail(`Obsolete Relay file has drifted: ${path}`, EXIT.conflict);
    rmSync(path);
  }
}

function installFiles(files, oldReceipt, serviceIdentity) {
  const hashes = hashPlan(files);
  const oldHashes = oldReceipt?.files || {};
  for (const [path, item] of files) {
    const existing = currentHash(path);
    const hash = hashes[path];
    if (existing === hash) {
      if (path === REGISTRY_PATH) {
        chmodSync(path, item.mode);
        run('chown', [`${serviceIdentity.uid}:${serviceIdentity.gid}`, path]);
      }
      continue;
    }
    if (existing !== undefined && existing !== oldHashes[path] && existing !== oldReceipt?.previousFiles?.[path]) fail(`Refusing to replace an unowned file: ${path}`, EXIT.conflict);
    atomicWrite(path, item.contents, item.mode);
    if (path === REGISTRY_PATH) run('chown', [`${serviceIdentity.uid}:${serviceIdentity.gid}`, path]);
  }
  clearObsoleteOwnedFiles(oldReceipt, files);
  return hashes;
}

function installCaddy(plan) {
  safeDirectory(hostPath('/etc/caddy'), { create: true, mode: 0o755 });
  assertFileRevision(CADDY_PATH, plan.baselineMainHash);
  assertFileRevision(CADDY_FRAGMENT_PATH, plan.baselineFragmentHash);
  atomicWriteIfRevision(CADDY_FRAGMENT_PATH, plan.fragmentContents, 0o644, plan.baselineFragmentHash);
  assertFileRevision(CADDY_FRAGMENT_PATH, sha256(plan.fragmentContents));
  atomicWriteIfRevision(CADDY_PATH, plan.mainContents, 0o644, plan.baselineMainHash);
  run('systemctl', ['reload', 'caddy.service']);
}

function removeOwnedEmptyDirectories(files) {
  const directories = new Set();
  for (const path of Object.keys(files || {})) {
    if (!path.startsWith(`${ROOT}/`)) continue;
    let directory = dirname(path);
    while (directory.startsWith(`${ROOT}/`)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try { rmdirSync(directory); }
    catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
  }
}

function relayInstall(options) {
  let oldReceipt = readReceipt();
  if (oldReceipt?.transaction) {
    recoverTransaction(oldReceipt);
    oldReceipt = readReceipt();
  }
  if (options.action === 'install' && oldReceipt?.state === 'active') {
    fail('Relay is already installed; use upgrade to replace it', EXIT.conflict);
  }
  if (options.action === 'upgrade' && !oldReceipt && !options.adoptExisting && hasUnmanagedRelayResources()) {
    fail('Existing Relay resources require explicit --adopt-existing after strict validation', EXIT.conflict);
  }
  if (oldReceipt) validateOldReceiptResources(oldReceipt);
  if (!oldReceipt && hasUnmanagedRelayResources() && !options.adoptExisting) {
    fail('Existing Relay resources require explicit --adopt-existing after strict validation', EXIT.conflict);
  }

  const cloud = validateCloudEnvironment(options.stageDir);
  const caddyEnvBuffer = readRegularFile(join(options.stageDir, 'caddy.env'), { maxBytes: 64 * 1024, privateMode: true });
  if (!caddyEnvBuffer) fail('Private Caddy environment file is missing', EXIT.conflict);
  const settings = parseRelayCaddySettings(caddyEnvBuffer.toString('utf8'));
  if (settings.controlPort !== cloud.controlPort || settings.proxyPort !== cloud.proxyPort) {
    fail('Relay and Caddy ports do not match', EXIT.conflict);
  }
  const publicUrlText = cloud.values.get('KCODER_RELAY_PUBLIC_URL');
  let publicUrl;
  try { publicUrl = new URL(publicUrlText); }
  catch { fail('Relay cloud environment must contain its canonical public URL', EXIT.conflict); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash
      || (publicUrl.pathname !== '' && publicUrl.pathname !== '/') || publicUrl.hostname.toLowerCase() !== settings.domain
      || Number(publicUrl.port || 443) !== settings.publicPort) {
    fail('Relay public URL and Caddy site do not match', EXIT.conflict);
  }
  if (new Set([settings.publicPort, settings.controlPort, settings.proxyPort]).size !== 3) fail('Relay ports must be distinct', EXIT.conflict);

  const registryFile = join(options.stageDir, 'registry.json');
  let registryContents = existsSync(registryFile) ? readRegularFile(registryFile, { maxBytes: 256 * 1024, privateMode: true }) : undefined;
  if (!oldReceipt && !registryContents && existsSync(REGISTRY_PATH)) {
    if (!options.adoptExisting) fail('Existing Relay registry requires explicit --adopt-existing', EXIT.conflict);
    const existing = readRegularFile(REGISTRY_PATH, { maxBytes: 256 * 1024, privateMode: true });
    const stat = lstatSync(REGISTRY_PATH);
    const existingIdentity = relayAccountInfo();
    if (stat.uid !== ROOT_UID && stat.uid !== existingIdentity?.uid) fail('Existing Relay registry has an unsupported owner', EXIT.conflict);
    validateAdoptableRegistry(existing, settings.publicPort === 443 ? settings.domain : `${settings.domain}:${settings.publicPort}`);
    registryContents = existing;
  }
  if (!registryContents && oldReceipt?.registryHash) {
    registryContents = readRegularFile(REGISTRY_PATH, {
      maxBytes: 256 * 1024,
      ownerUid: Number(oldReceipt.fileOwners?.[REGISTRY_PATH] ?? ROOT_UID),
      privateMode: true,
    });
    if (!registryContents || ![oldReceipt.registryHash, ...(oldReceipt.previousRegistryHashes || [])].includes(sha256(registryContents))) {
      fail('The existing Relay registry cannot be retained safely', EXIT.conflict);
    }
  }
  if (registryContents) {
    validateAdoptableRegistry(registryContents, settings.publicPort === 443 ? settings.domain : `${settings.domain}:${settings.publicPort}`);
  }

  const nodePath = nodePathForUnit();
  const files = sourceFiles(options.stageDir);
  const environment = Buffer.from(formatEnvironment(cloud.values));
  const unitContents = relayUnit(nodePath);
  const caddy = caddyInfo();
  const fragment = buildRelayCaddySnippet(settings);
  const caddyPlan = caddyFiles({ caddy, settings, receipt: oldReceipt, fragment, adoptExisting: options.adoptExisting });
  const targetFiles = new Map(files);
  targetFiles.set(ENV_PATH, { contents: environment, mode: 0o600 });
  targetFiles.set(UNIT_PATH, { contents: Buffer.from(unitContents), mode: 0o644 });
  if (registryContents) targetFiles.set(REGISTRY_PATH, { contents: registryContents, mode: 0o600 });
  verifyExpectedExistingFiles(targetFiles, oldReceipt, options.adoptExisting);
  makeReceiptDirectory();
  const serviceIdentity = ensureRelayAccount(options.adoptExisting);
  safeDirectory(ROOT, { create: true, mode: 0o755 });
  const receipt = {
    version: 1,
    component: 'relay',
    action: options.action,
    state: 'installing',
    publicUrl: settings.publicPort === 443 ? `https://${settings.domain}` : `https://${settings.domain}:${settings.publicPort}`,
    publicPort: settings.publicPort,
    files: { ...oldReceipt?.files, ...hashPlan(targetFiles) },
    fileOwners: {
      ...oldReceipt?.fileOwners,
      ...Object.fromEntries([...targetFiles.keys()].map((path) => [path, path === REGISTRY_PATH ? serviceIdentity.uid : ROOT_UID])),
    },
    previousFiles: oldReceipt?.files || {},
    environmentHash: sha256(environment),
    previousEnvironmentHashes: [...new Set([oldReceipt?.environmentHash, ...(oldReceipt?.previousEnvironmentHashes || [])].filter(Boolean))],
    registryHash: registryContents ? sha256(registryContents) : undefined,
    previousRegistryHashes: [...new Set([oldReceipt?.registryHash, ...(oldReceipt?.previousRegistryHashes || [])].filter(Boolean))],
    unitHash: sha256(unitContents),
    previousUnitHashes: [...new Set([oldReceipt?.unitHash, ...(oldReceipt?.previousUnitHashes || [])].filter(Boolean))],
    registrationStore: { path: REGISTRATION_STORE, state: existsSync(REGISTRATION_STORE) ? 'present' : 'not-created' },
    caddy: {
      mainPath: CADDY_PATH,
      fragmentHash: sha256(caddyPlan.fragmentContents),
      fragmentHashes: [...new Set([...(oldReceipt?.caddy?.fragmentHashes || []), ...(caddyPlan.previousFragmentHash ? [caddyPlan.previousFragmentHash] : []), sha256(caddyPlan.fragmentContents)])],
      mainFileCreated: oldReceipt?.caddy?.mainFileCreated ?? !caddy.mainFileExists,
      globalCreated: oldReceipt?.caddy?.globalCreated ?? caddyPlan.createdGlobal,
    },
    adoptedExisting: Boolean(options.adoptExisting || oldReceipt?.adoptedExisting),
  };
  const expectedWrites = { ...hashPlan(targetFiles) };
  for (const oldPath of Object.keys(oldReceipt?.files || {})) {
    if (oldPath !== REGISTRY_PATH && !targetFiles.has(oldPath)) expectedWrites[oldPath] = null;
  }
  for (const [path, hash] of [
    [CADDY_PATH, sha256(caddyPlan.mainContents)],
    [CADDY_FRAGMENT_PATH, sha256(caddyPlan.fragmentContents)],
  ]) {
    expectedWrites[path] = hash;
  }
  receipt.transaction = beginTransaction({
    paths: Object.keys(expectedWrites),
    expectedWrites,
    unitState: captureRelayUnitState(),
    preconditionHashes: {
      [CADDY_PATH]: caddyPlan.baselineMainHash,
      [CADDY_FRAGMENT_PATH]: caddyPlan.baselineFragmentHash,
    },
  });

  try {
    atomicJson(RECEIPT_PATH, receipt);
    assertFileRevision(CADDY_PATH, caddyPlan.baselineMainHash);
    assertFileRevision(CADDY_FRAGMENT_PATH, caddyPlan.baselineFragmentHash);
    const fileHashes = installFiles(targetFiles, oldReceipt, serviceIdentity);
    receipt.files = fileHashes;
    receipt.fileOwners = Object.fromEntries([...targetFiles.keys()].map((path) => [path, path === REGISTRY_PATH ? serviceIdentity.uid : ROOT_UID]));
    receipt.environmentHash = fileHashes[ENV_PATH];
    receipt.unitHash = fileHashes[UNIT_PATH];
    receipt.registryHash = fileHashes[REGISTRY_PATH];
    installCaddy(caddyPlan);
    systemctl(['daemon-reload']);
    systemctl(['enable', '--now', UNIT_NAME]);
    if (options.action === 'upgrade') systemctl(['restart', UNIT_NAME]);
    const relayActive = isActive(UNIT_NAME);
    const caddyActive = isActive('caddy.service');
    if (!relayActive || !caddyActive) fail('Relay or Caddy did not become active');
    receipt.state = 'active';
    receipt.registrationStore = { path: REGISTRATION_STORE, state: existsSync(REGISTRATION_STORE) ? 'present' : 'not-created' };
    completeTransaction(receipt);
    return {
      component: 'relay', action: options.action, state: 'active', publicUrl: receipt.publicUrl,
      relayUnit: UNIT_NAME, caddyMode: caddyPlan.adoptedSite ? 'adopted-site-fragment' : 'managed-import',
      registrationStore: receipt.registrationStore,
    };
  } catch (error) {
    recoverTransaction(receipt);
    throw error;
  }
}

function verifyCleanupResources(receipt) {
  if (!receipt) return;
  for (const [path, expected] of Object.entries(receipt.files)) {
    validateManagedFile(path, [expected, receipt.previousFiles?.[path]].filter(Boolean), {
      ownerUid: Number(receipt.fileOwners?.[path] ?? ROOT_UID),
      allowMissing: true,
      privateMode: path === REGISTRY_PATH,
    });
  }
  for (const [path, accepted] of [
    [ENV_PATH, [receipt.environmentHash, ...(receipt.previousEnvironmentHashes || [])]],
    [UNIT_PATH, [receipt.unitHash, ...(receipt.previousUnitHashes || [])]],
  ]) {
    validateManagedFile(path, accepted.filter(Boolean), { allowMissing: true, privateMode: path === ENV_PATH });
  }
  if (receipt.registryHash) validateManagedFile(REGISTRY_PATH, [receipt.registryHash, ...(receipt.previousRegistryHashes || [])].filter(Boolean), {
    ownerUid: Number(receipt.fileOwners?.[REGISTRY_PATH] ?? ROOT_UID), allowMissing: true, privateMode: true,
  });
  const fragmentHash = currentHash(CADDY_FRAGMENT_PATH);
  if (fragmentHash !== undefined && !receipt.caddy.fragmentHashes?.includes(fragmentHash)) fail('Owned Caddy fragment drifted; refusing cleanup', EXIT.conflict);
  const main = readRegularFile(receipt.caddy.mainPath, { maxBytes: 4 * 1024 * 1024, ownerUid: ROOT_UID })?.toString('utf8');
  if (receipt.state === 'active' && !main?.includes('# KCODER-RELAY-IMPORT-BEGIN v1')) fail('Owned Caddy import is missing; refusing cleanup', EXIT.conflict);
}

function cleanupRelay(options) {
  let receipt = readReceipt();
  if (receipt?.transaction) {
    recoverTransaction(receipt);
    receipt = readReceipt();
  }
  if (!receipt) {
    if (hasUnmanagedRelayResources()) fail('Unmanaged Relay resources are present; refusing cleanup', EXIT.conflict);
    return { component: 'relay', action: 'cleanup', state: 'absent', registrationStore: { state: 'present' } };
  }
  verifyCleanupResources(receipt);

  const caddy = caddyInfo();
  const caddyMain = caddy.mainContents;
  const fragmentBuffer = readRegularFile(CADDY_FRAGMENT_PATH, { maxBytes: 1024 * 1024, ownerUid: ROOT_UID });
  const fragmentContents = fragmentBuffer?.toString('utf8') || '';
  const baselineFragmentHash = fragmentBuffer === undefined ? null : sha256(fragmentBuffer);
  assertFileRevision(receipt.caddy.mainPath, caddy.mainHash);
  assertFileRevision(CADDY_FRAGMENT_PATH, baselineFragmentHash);
  const plan = createCaddyCleanupPlan({
    mainContents: caddyMain,
    expectedFragmentHash: receipt.caddy.fragmentHash,
    expectedFragmentHashes: receipt.caddy.fragmentHashes,
    actualFragmentHash: baselineFragmentHash || undefined,
    mainFileCreatedByKcoder: receipt.caddy.mainFileCreated,
  });
  plan.baselineMainHash = caddy.mainHash;
  plan.baselineFragmentHash = baselineFragmentHash;
  if (!caddy.active) fail('The shared Caddy service must be active before Relay cleanup');
  const baseline = adaptCaddy({ caddy, mainContents: caddyMain, fragmentContents });
  const adapted = adaptCaddy({ caddy, mainContents: plan.mainContents, fragmentContents: '' });
  try { assertPort80ListenerStateUnchanged(baseline, adapted); }
  catch (error) { fail(error.message, EXIT.conflict); }

  if (options.purgeData && existsSync(REGISTRATION_STORE)) {
    const identity = relayAccountInfo();
    if (!identity) fail('Cannot safely purge registration data without the managed service identity', EXIT.conflict);
    readRegularFile(REGISTRATION_STORE, { maxBytes: 64 * 1024 * 1024, ownerUid: identity.uid, privateMode: true });
  }

  const expectedWrites = {};
  for (const path of Object.keys(receipt.files)) {
    if (path === REGISTRY_PATH && !options.purgeData) continue;
    expectedWrites[path] = null;
  }
  expectedWrites[ENV_PATH] = null;
  expectedWrites[UNIT_PATH] = null;
  expectedWrites[CADDY_PATH] = sha256(plan.mainContents || '\n');
  if (existsSync(CADDY_FRAGMENT_PATH)) expectedWrites[CADDY_FRAGMENT_PATH] = null;
  if (options.purgeData && existsSync(REGISTRATION_STORE)) expectedWrites[REGISTRATION_STORE] = null;
  receipt.action = 'cleanup';
  receipt.state = 'cleaning';
  receipt.transaction = beginTransaction({
    paths: Object.keys(expectedWrites),
    expectedWrites,
    unitState: captureRelayUnitState(),
    preconditionHashes: {
      [CADDY_PATH]: plan.baselineMainHash,
      [CADDY_FRAGMENT_PATH]: plan.baselineFragmentHash,
    },
  });
  try { atomicJson(RECEIPT_PATH, receipt); }
  catch (error) {
    rmSync(receipt.transaction.directory, { recursive: true, force: true });
    throw error;
  }

  try {
    if (existsSync(UNIT_PATH)) {
      if (relayUnitActiveState()) systemctl(['stop', UNIT_NAME]);
      if (relayUnitEnabledState()) systemctl(['disable', UNIT_NAME]);
      verifyRelayUnitState({ active: false, enabled: false }, { unitFileExists: true });
    } else {
      if (relayUnitActiveState()) systemctl(['stop', UNIT_NAME]);
      if (relayUnitEnabledState()) systemctl(['disable', UNIT_NAME]);
      systemctl(['daemon-reload']);
      verifyRelayUnitState({ active: false, enabled: false }, { unitFileExists: false });
    }
    if (options.purgeData && receipt.transaction.snapshots[REGISTRATION_STORE]?.exists) {
      const identity = relayAccountInfo();
      if (!identity) fail('Cannot safely purge registration data without the managed service identity', EXIT.conflict);
      refreshTransactionSnapshot(receipt, REGISTRATION_STORE, identity.uid);
    }
    systemctl(['daemon-reload']);

    if (expectedWrites[CADDY_PATH] !== undefined) {
      atomicWriteIfRevision(receipt.caddy.mainPath, plan.mainContents || '\n', 0o644, plan.baselineMainHash);
    }
    if (expectedWrites[CADDY_FRAGMENT_PATH] === null) {
      assertFileRevision(CADDY_FRAGMENT_PATH, plan.baselineFragmentHash);
      rmSync(CADDY_FRAGMENT_PATH);
    }
    if (expectedWrites[CADDY_PATH] !== undefined || expectedWrites[CADDY_FRAGMENT_PATH] === null) {
      systemctl(['reload', 'caddy.service']);
    }

    for (const [path, expectedHash] of Object.entries(receipt.files)) {
      if (path === REGISTRY_PATH && !options.purgeData) continue;
      const contents = readRegularFile(path, {
        maxBytes: 64 * 1024 * 1024,
        ownerUid: Number(receipt.fileOwners?.[path] ?? ROOT_UID),
        privateMode: path === REGISTRY_PATH,
      });
      if (contents && [expectedHash, receipt.previousFiles?.[path]].includes(sha256(contents))) rmSync(path);
    }
    for (const [path, hashes] of [
      [UNIT_PATH, [receipt.unitHash, ...(receipt.previousUnitHashes || [])]],
      [ENV_PATH, [receipt.environmentHash, ...(receipt.previousEnvironmentHashes || [])]],
    ]) {
      const contents = readRegularFile(path, { maxBytes: 4 * 1024 * 1024, ownerUid: ROOT_UID });
      if (contents && hashes.includes(sha256(contents))) rmSync(path);
    }
    systemctl(['daemon-reload']);
    verifyRelayUnitState({ active: false, enabled: false }, { unitFileExists: false });
    if (options.purgeData && receipt.registryHash) {
      const contents = readRegularFile(REGISTRY_PATH, {
        maxBytes: 256 * 1024,
        ownerUid: Number(receipt.fileOwners?.[REGISTRY_PATH] ?? ROOT_UID),
        privateMode: true,
      });
      if (contents && [receipt.registryHash, ...(receipt.previousRegistryHashes || [])].includes(sha256(contents))) rmSync(REGISTRY_PATH);
    }
    if (options.purgeData && existsSync(REGISTRATION_STORE)) {
      const identity = relayAccountInfo();
      if (!identity) fail('Cannot safely purge registration data without the managed service identity', EXIT.conflict);
      readRegularFile(REGISTRATION_STORE, { maxBytes: 64 * 1024 * 1024, ownerUid: identity.uid, privateMode: true });
      rmSync(REGISTRATION_STORE);
    }
    removeOwnedEmptyDirectories(receipt.files);
    rmSync(RECEIPT_PATH);
    const transaction = receipt.transaction;
    rmSync(transaction.directory, { recursive: true, force: true });
    try { rmSync(RECEIPT_DIR); } catch { /* Keep the private state directory if any item remains. */ }
  } catch (error) {
    rollbackTransaction(receipt);
    throw error;
  }
  return {
    component: 'relay', action: 'cleanup', state: 'resources-removed',
    registrationStore: { state: options.purgeData ? 'purged' : (existsSync(REGISTRATION_STORE) ? 'present' : 'not-created') },
  };
}

function prepare(options) {
  if (options.checkOnly) return;
  for (const relativePath of ['deploy/stun-host.sh', 'deploy/stun-lifecycle.mjs', 'deploy/relay-lifecycle.mjs', 'deploy/caddy-lifecycle.mjs']) {
    const path = join(options.stageDir, relativePath);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Required staged helper is unsafe: ${relativePath}`, EXIT.conflict);
  }
}

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function runRelayHostLifecycle(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); }
  catch (error) {
    console.error(error.message);
    return EXIT.usage;
  }
  try {
    if (options.action === 'prepare') {
      prepare(options);
      return 0;
    }
    if (options.action === 'status') {
      const outcome = statusRelay();
      printJson(outcome.result);
      return outcome.status;
    }
    if (options.action === 'cleanup') {
      const result = cleanupRelay(options);
      printJson(result);
      return 0;
    }
    const result = relayInstall(options);
    printJson(result);
    return 0;
  } catch (error) {
    if (error instanceof LifecycleError && error.code === EXIT.conflict) {
      const component = options.action === 'cleanup' || options.action === 'status' ? 'relay' : 'relay';
      printJson({ component, action: options.action, state: 'conflict' });
      console.error(error.message);
      return EXIT.conflict;
    }
    if (['install', 'upgrade'].includes(options.action) && readReceipt()?.state === 'installing') {
      try {
        const receipt = readReceipt();
        receipt.state = 'incomplete';
        atomicJson(RECEIPT_PATH, receipt);
      } catch { /* Leave the last valid owner receipt in place. */ }
    }
    printJson({ component: 'relay', action: options.action, state: options.action === 'cleanup' ? 'incomplete' : 'partial' });
    console.error(error.message);
    return error instanceof LifecycleError ? error.code : EXIT.host;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runRelayHostLifecycle();
}
