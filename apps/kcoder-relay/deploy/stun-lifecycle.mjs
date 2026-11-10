import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STUN_PORT = 8452;
export const STUN_CONFIG_PATH = '/etc/coturn/kcoder-stun.conf';
export const STUN_UNIT_PATH = '/etc/systemd/system/kcoder-stun.service';
export const STUN_UNIT_NAME = 'kcoder-stun.service';
export const STUN_RECEIPT_PATH = '/var/lib/kcoder-relay-stun/owner.json';
export const STUN_HOST_SCRIPT_PATH = '/opt/kcoder-relay/deploy/stun-host.sh';

const OWNER_ID = 'kcoder-relay-stun';
const RECEIPT_SCHEMA = 1;
const CONFIG_KEYS = new Set([
  'listening-port', 'listening-ip', 'stun-only', 'no-auth', 'no-tcp', 'no-tls', 'no-dtls', 'no-cli',
  'no-udp-relay', 'no-tcp-relay',
]);
const ADOPTABLE_UNIT_KEYS = new Map([
  ['Unit', new Set(['Description', 'After', 'Wants'])],
  ['Service', new Set([
    'Type', 'DynamicUser', 'User', 'Group', 'ExecStart', 'Restart', 'RestartSec', 'NoNewPrivileges',
    'PrivateTmp', 'ProtectSystem', 'ProtectHome', 'RestrictAddressFamilies', 'RuntimeDirectory',
    'RuntimeDirectoryMode',
  ])],
  ['Install', new Set(['WantedBy'])],
]);

export function validateStunPort(value, { min = 1024 } = {}) {
  let port;
  if (typeof value === 'number' && Number.isInteger(value)) {
    port = value;
  } else if (typeof value === 'string' && /^[0-9]{1,5}$/.test(value)) {
    port = Number(value);
  }
  if (!Number.isInteger(port) || port < min || port > 65535) {
    throw new Error(`Invalid STUN UDP port: ${String(value)}`);
  }
  return port;
}

function validateConfigPath(value) {
  if (typeof value !== 'string' || !/^\/etc\/coturn\/[A-Za-z0-9_.-]+\.conf$/.test(value)) {
    throw new Error('STUN config path must be a file directly under /etc/coturn');
  }
  return value;
}

function validateUnitName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.@-]+\.service$/.test(value)) {
    throw new Error('Invalid STUN systemd unit name');
  }
  return value;
}

export function buildStunConfig({ port = DEFAULT_STUN_PORT, configPath = STUN_CONFIG_PATH } = {}) {
  port = validateStunPort(port);
  validateConfigPath(configPath);
  return [
    '# Managed by KCoder Relay: UDP STUN binding only.',
    `# Dedicated config: ${configPath}`,
    `listening-port=${port}`,
    'listening-ip=0.0.0.0',
    'stun-only',
    'no-auth',
    'no-tcp',
    'no-tls',
    'no-dtls',
    'no-cli',
    '',
  ].join('\n');
}

export function validateStunConfig(contents, { port = DEFAULT_STUN_PORT, configPath = STUN_CONFIG_PATH } = {}) {
  port = validateStunPort(port);
  validateConfigPath(configPath);
  const directives = parseConfig(contents);
  const expected = new Map([
    ['listening-port', String(port)], ['listening-ip', '0.0.0.0'], ['stun-only', ''], ['no-auth', ''],
    ['no-tcp', ''], ['no-tls', ''], ['no-dtls', ''], ['no-cli', ''],
  ]);
  if (directives.size !== expected.size || [...expected].some(([key, value]) => directives.get(key) !== value)) {
    throw new Error('STUN config does not match the required UDP-only STUN policy');
  }
  return { port, configPath, directives: [...directives.keys()] };
}

function parseConfig(contents) {
  if (typeof contents !== 'string') throw new Error('STUN config must be text');
  const directives = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/^[a-z][a-z0-9-]*(?:=[A-Za-z0-9.:_-]+)?$/.test(line)) {
      throw new Error('Invalid STUN config directive syntax');
    }
    const separator = line.indexOf('=');
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (!CONFIG_KEYS.has(key) || directives.has(key)) {
      throw new Error(`Unsupported or duplicate STUN config directive: ${key}`);
    }
    directives.set(key, value);
  }
  return directives;
}

export function buildStunUnit({
  configPath = STUN_CONFIG_PATH,
  unitName = STUN_UNIT_NAME,
  runtimeDirectory = unitName.replace(/\.service$/, ''),
} = {}) {
  validateConfigPath(configPath);
  validateUnitName(unitName);
  if (typeof runtimeDirectory !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(runtimeDirectory)) {
    throw new Error('Invalid STUN runtime directory name');
  }
  return [
    '[Unit]',
    'Description=KCoder Relay STUN-only service',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'DynamicUser=yes',
    `RuntimeDirectory=${runtimeDirectory}`,
    'RuntimeDirectoryMode=0700',
    `ExecStart=/usr/bin/turnserver -c ${configPath}`,
    'Restart=on-failure',
    'RestartSec=3',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function validateStunUnit(contents, {
  configPath = STUN_CONFIG_PATH,
  unitName = STUN_UNIT_NAME,
  runtimeDirectory = unitName.replace(/\.service$/, ''),
} = {}) {
  if (typeof contents !== 'string') throw new Error('STUN unit must be text');
  const expected = buildStunUnit({ configPath, unitName, runtimeDirectory });
  if (normalizeUnit(contents) !== normalizeUnit(expected)) {
    throw new Error('STUN unit does not match the dedicated KCoder service policy');
  }
  return { unitName, configPath };
}

function normalizeUnit(contents) {
  return contents.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .join('\n');
}

export function createStunLifecycleCommand({
  action,
  scriptPath = STUN_HOST_SCRIPT_PATH,
  port,
  adoptExisting = false,
  testNamespace,
} = {}) {
  if (!['install', 'upgrade', 'status', 'cleanup'].includes(action)) {
    throw new Error(`Unsupported STUN lifecycle action: ${action}`);
  }
  if (typeof scriptPath !== 'string' || !scriptPath.startsWith('/') || /[\u0000-\u001f\u007f]/.test(scriptPath)) {
    throw new Error('STUN host script path must be an absolute path');
  }
  if (adoptExisting && !['install', 'upgrade'].includes(action)) {
    throw new Error('--adopt-existing is only valid for install or upgrade');
  }
  if (testNamespace !== undefined && (typeof testNamespace !== 'string' || !/^[a-f0-9]{12}$/.test(testNamespace))) {
    throw new Error('STUN test namespace must be 12 lowercase hexadecimal characters');
  }

  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const args = ['sudo', '-n', 'bash', quote(scriptPath), action];
  if (['install', 'upgrade'].includes(action)) {
    args.push('--port', String(validateStunPort(port ?? DEFAULT_STUN_PORT)));
    if (adoptExisting) args.push('--adopt-existing');
  } else if (port !== undefined) {
    throw new Error('Status and cleanup read the deployed port from the owner receipt');
  }
  if (testNamespace !== undefined) args.push('--test-namespace', testNamespace);
  return args.join(' ');
}

class LifecycleError extends Error {
  constructor(message, code = 4) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

function usage(message = 'invalid lifecycle arguments') {
  throw new LifecycleError(message, 2);
}

function conflict(message) {
  throw new LifecycleError(`STUN ownership conflict: ${message}`, 3);
}

function hostError(message) {
  throw new LifecycleError(`STUN host operation failed: ${message}`, 4);
}

function parseHostArgs(args) {
  const [action, ...rest] = args;
  if (!['install', 'upgrade', 'status', 'cleanup'].includes(action)) usage();
  let port;
  let adoptExisting = false;
  let testNamespace;
  while (rest.length) {
    const key = rest.shift();
    if (key === '--port') {
      if (port !== undefined || !rest.length) usage();
      const raw = rest.shift();
      if (!/^[0-9]{1,5}$/.test(raw)) usage('port must be a decimal integer from 1024 through 65535');
      try { port = validateStunPort(raw); } catch { usage('port must be a decimal integer from 1024 through 65535'); }
    } else if (key === '--adopt-existing') {
      if (adoptExisting) usage();
      adoptExisting = true;
    } else if (key === '--test-namespace') {
      if (testNamespace !== undefined || !rest.length) usage();
      testNamespace = rest.shift();
      if (!/^[a-f0-9]{12}$/.test(testNamespace)) usage('test namespace must be 12 lowercase hexadecimal characters');
    } else {
      usage(`unknown option: ${key}`);
    }
  }
  if (['install', 'upgrade'].includes(action)) {
    if (port === undefined) usage('install and upgrade require --port');
  } else if (port !== undefined || adoptExisting) {
    usage('status and cleanup do not accept --port or --adopt-existing');
  }
  if (adoptExisting && !['install', 'upgrade'].includes(action)) usage();
  if (testNamespace && process.env.KCODER_STUN_FIXTURE_ROOT) usage('test namespace cannot be combined with fixture root');
  return { action, port, adoptExisting, testNamespace };
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function checkDirectoryChain(directory, { from = path.parse(directory).root, expectedOwner = 0, allowWritable = false } = {}) {
  const relative = path.relative(from, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) conflict(`path escapes trusted root: ${directory}`);
  let cursor = from;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink()) conflict(`unsafe directory in managed path: ${cursor}`);
    if (stat.uid !== expectedOwner) conflict(`unexpected owner for directory: ${cursor}`);
    if (!allowWritable && (stat.mode & 0o022) !== 0) conflict(`group/world-writable directory in managed path: ${cursor}`);
  }
}

function assertOwnedRegular(file, { owner = 0, mode, executable = false, allowSymlink = false } = {}) {
  checkDirectoryChain(path.dirname(file), { expectedOwner: owner });
  const original = lstatOrNull(file);
  if (!original) conflict(`required file is missing: ${file}`);
  if (original.isSymbolicLink()) {
    if (!allowSymlink) conflict(`symlink is not allowed: ${file}`);
    if (original.uid !== owner) conflict(`unexpected symlink owner: ${file}`);
  } else if (!original.isFile()) {
    conflict(`not a regular file: ${file}`);
  }
  const resolved = fs.realpathSync(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.uid !== owner) conflict(`unexpected owner or file type: ${file}`);
  if (stat.nlink !== 1) conflict(`file has multiple hard links: ${file}`);
  if ((stat.mode & 0o022) !== 0) conflict(`group/world-writable executable: ${file}`);
  if (mode !== undefined && (stat.mode & 0o777) !== mode) conflict(`unexpected mode: ${file}`);
  if (executable && (stat.mode & 0o111) === 0) conflict(`not executable: ${file}`);
  const parent = path.dirname(resolved);
  checkDirectoryChain(parent, { expectedOwner: owner });
  return resolved;
}

function validateFixtureRoot(input) {
  if (!input || !path.isAbsolute(input) || !/^\/tmp\/kcoder-stun-fixture-[a-z0-9-]+$/.test(input)) {
    hostError('fixture root must be a private /tmp/kcoder-stun-fixture-* directory');
  }
  const stat = lstatOrNull(input);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    hostError('fixture root must be caller-owned mode 0700 and must not be a symlink');
  }
  const canonical = fs.realpathSync(input);
  if (canonical !== input) hostError('fixture root must be canonical');
  const bin = path.join(canonical, 'bin');
  const binStat = lstatOrNull(bin);
  if (!binStat || !binStat.isDirectory() || binStat.isSymbolicLink() || binStat.uid !== process.getuid() || (binStat.mode & 0o022) !== 0) {
    hostError('fixture root must contain a private bin directory');
  }
  return canonical;
}

function makeContext(args) {
  const fixtureRoot = process.env.KCODER_STUN_FIXTURE_ROOT
    ? validateFixtureRoot(process.env.KCODER_STUN_FIXTURE_ROOT)
    : null;
  if (!fixtureRoot && process.getuid() !== 0) hostError('must run as root');
  if (fixtureRoot && args.testNamespace) usage('--test-namespace cannot be combined with a fixture root');
  const namespace = args.testNamespace;
  let configLogical = STUN_CONFIG_PATH;
  let unitName = STUN_UNIT_NAME;
  let unitLogical = STUN_UNIT_PATH;
  let stateLogical = '/var/lib/kcoder-relay-stun';
  if (namespace) {
    configLogical = `/etc/coturn/kcoder-stun-test-${namespace}.conf`;
    unitName = `kcoder-stun-test-${namespace}.service`;
    unitLogical = `/etc/systemd/system/${unitName}`;
    stateLogical = `/var/lib/kcoder-relay-stun-test-${namespace}`;
  }
  const mapPath = (logical) => fixtureRoot ? path.join(fixtureRoot, logical.slice(1)) : logical;
  const configFile = mapPath(configLogical);
  const unitFile = mapPath(unitLogical);
  const stateDir = mapPath(stateLogical);
  const scratch = namespace ? `/var/tmp/kcoder-stun-test-${namespace}` : null;
  if (namespace) {
    const scratchStat = lstatOrNull(scratch);
    if (['install', 'upgrade'].includes(args.action)) {
      if (!scratchStat || !scratchStat.isDirectory() || scratchStat.isSymbolicLink() || scratchStat.uid !== 0 || (scratchStat.mode & 0o777) !== 0o700) {
        conflict(`namespace scratch must already be root-owned mode 0700: ${scratch}`);
      }
      if (fs.realpathSync(scratch) !== scratch) conflict('namespace scratch path is not canonical');
    }
  }
  return {
    ...args,
    fixtureRoot,
    isFixture: Boolean(fixtureRoot),
    namespace,
    configLogical,
    configFile,
    unitName,
    unitLogical,
    unitFile,
    stateLogical,
    stateDir,
    receiptFile: path.join(stateDir, 'owner.json'),
    ownerUid: fixtureRoot ? process.getuid() : 0,
    maskFile: mapPath('/etc/systemd/system/coturn.service'),
    turnserverFile: mapPath('/usr/bin/turnserver'),
  };
}

const COMMAND_PATHS = {
  systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
  'systemd-analyze': ['/usr/bin/systemd-analyze', '/bin/systemd-analyze'],
  'apt-get': ['/usr/bin/apt-get'],
  dnf: ['/usr/bin/dnf'],
  rpm: ['/usr/bin/rpm', '/bin/rpm'],
  'dpkg-query': ['/usr/bin/dpkg-query'],
};

function resolveSystemCommand(name) {
  for (const candidate of COMMAND_PATHS[name] ?? []) {
    if (!lstatOrNull(candidate)) continue;
    try { return assertOwnedRegular(candidate, { owner: 0, executable: true, allowSymlink: true }); } catch (error) {
      if (error instanceof LifecycleError) throw error;
      hostError(`cannot validate ${name} executable`);
    }
  }
  hostError(`required host executable is unavailable: ${name}`);
}

function runTool(ctx, name, args, { acceptFailure = false, timeout = 10 * 60 * 1000 } = {}) {
  let executable;
  if (ctx.isFixture) {
    executable = path.join(ctx.fixtureRoot, 'bin', name);
    const stat = lstatOrNull(executable);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== ctx.ownerUid || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
      hostError(`fixture shim is missing or unsafe: ${name}`);
    }
  } else {
    executable = resolveSystemCommand(name);
  }
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: {
      HOME: '/root',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: ctx.isFixture ? path.join(ctx.fixtureRoot, 'bin') : '/usr/sbin:/usr/bin:/sbin:/bin',
      ...(ctx.isFixture ? {
        KCODER_STUN_FIXTURE_ROOT: ctx.fixtureRoot,
        ...(process.env.KCODER_STUN_TEST_SYSTEMCTL_FAIL
          ? { KCODER_STUN_TEST_SYSTEMCTL_FAIL: process.env.KCODER_STUN_TEST_SYSTEMCTL_FAIL }
          : {}),
      } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) hostError(`${name} failed to execute: ${result.error.message}`);
  const output = { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (output.code !== 0 && !acceptFailure) {
    hostError(`${name} ${args.join(' ')} failed: ${(output.stderr || output.stdout).trim() || `exit ${output.code}`}`);
  }
  return output;
}

function resetFailedIfLoaded(ctx) {
  const result = runTool(ctx, 'systemctl', ['reset-failed', ctx.unitName], { acceptFailure: true });
  if (result.code === 0) return;
  const detail = (result.stderr || result.stdout).trim();
  const unit = ctx.unitName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expectedNotLoaded = new RegExp(`^Failed to reset failed state of unit ${unit}: Unit ${unit} not loaded\\.$`);
  if (expectedNotLoaded.test(detail)) return;
  hostError(`systemctl reset-failed ${ctx.unitName} failed: ${detail || `exit ${result.code}`}`);
}

function failAt(ctx, phase) {
  const injected = (process.env.KCODER_STUN_TEST_FAIL_AT ?? '').split(',').map((value) => value.trim());
  if (ctx.isFixture && injected.includes(phase)) {
    throw new LifecycleError(`injected fixture failure at ${phase}`, 4);
  }
}

function exists(ctx, file) {
  const trustedRoot = ctx.fixtureRoot ?? '/';
  const parent = path.dirname(file);
  const relative = path.relative(trustedRoot, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) conflict(`managed path escapes its root: ${file}`);
  let cursor = trustedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const parentStat = lstatOrNull(cursor);
    if (!parentStat) return false;
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) conflict(`symlink or non-directory in managed path: ${cursor}`);
    if (parentStat.uid !== ctx.ownerUid || (parentStat.mode & 0o022) !== 0) conflict(`unsafe parent directory: ${cursor}`);
  }
  return lstatOrNull(file) !== null;
}

function ensureDirectory(ctx, directory, { privateDirectory = false } = {}) {
  const trustedRoot = ctx.fixtureRoot ?? '/';
  const relative = path.relative(trustedRoot, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) conflict(`managed directory escapes its root: ${directory}`);
  let cursor = trustedRoot;
  const owner = ctx.ownerUid;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat = lstatOrNull(cursor);
    let createdMode;
    if (!stat) {
      const mode = privateDirectory && cursor === directory ? 0o700 : 0o755;
      try { fs.mkdirSync(cursor, { mode }); createdMode = mode; } catch (error) {
        if (error.code !== 'EEXIST') hostError(`cannot create managed directory ${cursor}: ${error.message}`);
      }
      stat = lstatOrNull(cursor);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) conflict(`unsafe managed directory: ${cursor}`);
    if (stat.uid !== owner) conflict(`unexpected owner for managed directory: ${cursor}`);
    if ((stat.mode & 0o022) !== 0) conflict(`group/world-writable managed directory: ${cursor}`);
    // A private caller umask must not hide the public STUN config from DynamicUser.
    if (createdMode !== undefined) { fs.chmodSync(cursor, createdMode); stat = fs.lstatSync(cursor); }
    if (privateDirectory && cursor === directory && (stat.mode & 0o777) !== 0o700) {
      conflict(`private state directory must have mode 0700: ${cursor}`);
    }
  }
}

function validateManagedFile(ctx, file, { mode, owner = ctx.ownerUid } = {}) {
  const stat = lstatOrNull(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) conflict(`managed path is not a regular file: ${file}`);
  if (stat.uid !== owner) conflict(`managed file has an unexpected owner: ${file}`);
  if (stat.nlink !== 1) conflict(`managed file has multiple hard links: ${file}`);
  if (mode !== undefined && (stat.mode & 0o777) !== mode) conflict(`managed file has an unexpected mode: ${file}`);
  return stat;
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function fileHash(ctx, file) {
  validateManagedFile(ctx, file);
  return sha256(fs.readFileSync(file));
}

function safeAtomicWrite(ctx, file, contents, mode) {
  const parent = path.dirname(file);
  ensureDirectory(ctx, parent);
  const temp = path.join(parent, `.${path.basename(file)}.kcoder-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temp, mode);
    if (ctx.ownerUid === 0) fs.chownSync(temp, 0, 0);
    fs.renameSync(temp, file);
    const directoryFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temp); } catch {}
    hostError(`atomic write failed for ${file}: ${error.message}`);
  }
}

function safeUnlink(ctx, file) {
  if (!exists(ctx, file)) return;
  const stat = lstatOrNull(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.uid !== ctx.ownerUid || stat.nlink !== 1) {
    conflict(`refusing to remove an unsafe managed file: ${file}`);
  }
  fs.unlinkSync(file);
}

function atomicSymlink(ctx, target, linkPath) {
  const parent = path.dirname(linkPath);
  ensureDirectory(ctx, parent);
  const temp = path.join(parent, `.${path.basename(linkPath)}.kcoder-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.symlinkSync(target, temp);
    fs.renameSync(temp, linkPath);
    const directoryFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    hostError(`cannot install default coturn mask: ${error.message}`);
  }
}

function writeReceipt(ctx, receipt) {
  ensureDirectory(ctx, ctx.stateDir, { privateDirectory: true });
  safeAtomicWrite(ctx, ctx.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
}

function readReceipt(ctx) {
  if (!exists(ctx, ctx.receiptFile)) return null;
  validateManagedFile(ctx, ctx.receiptFile, { mode: 0o600 });
  const raw = fs.readFileSync(ctx.receiptFile, 'utf8');
  let receipt;
  try { receipt = JSON.parse(raw); } catch { conflict('owner receipt is not valid JSON'); }
  validateReceipt(ctx, receipt);
  return receipt;
}

function validateReceipt(ctx, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) conflict('owner receipt must be a JSON object');
  const expectedKeys = [
    'schema', 'owner', 'port', 'unitName', 'unitPath', 'configPath', 'unitSha256', 'configSha256',
    'packageManager', 'packageInstalledByKcoder', 'packageVersion', 'defaultCoturn', 'adoptedExisting',
    'state', 'transaction',
  ];
  if (Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')) conflict('owner receipt fields do not match the supported schema');
  if (value.schema !== RECEIPT_SCHEMA || value.owner !== OWNER_ID) conflict('owner receipt identity is invalid');
  if (value.unitName !== ctx.unitName || value.unitPath !== ctx.unitLogical || value.configPath !== ctx.configLogical) {
    conflict('owner receipt paths do not match this lifecycle instance');
  }
  try { validateStunPort(value.port); } catch { conflict('owner receipt contains an invalid UDP port'); }
  if (!/^[a-f0-9]{64}$/.test(value.unitSha256) || !/^[a-f0-9]{64}$/.test(value.configSha256)) conflict('owner receipt contains an invalid asset hash');
  if (!['apt', 'dnf', 'test'].includes(value.packageManager)) conflict('owner receipt package manager is invalid');
  if (typeof value.packageInstalledByKcoder !== 'boolean' || typeof value.adoptedExisting !== 'boolean') conflict('owner receipt ownership flags are invalid');
  if (value.packageInstalledByKcoder && value.packageManager === 'test') conflict('test namespace cannot own a system package');
  if (value.packageVersion !== null && (typeof value.packageVersion !== 'string' || !/^[A-Za-z0-9.+:~_-]{1,160}$/.test(value.packageVersion))) {
    conflict('owner receipt package version is invalid');
  }
  if (!value.defaultCoturn || typeof value.defaultCoturn !== 'object' || Array.isArray(value.defaultCoturn)
      || Object.keys(value.defaultCoturn).sort().join(',') !== 'maskOwned,priorState'
      || typeof value.defaultCoturn.maskOwned !== 'boolean'
      || !['not-found', 'masked'].includes(value.defaultCoturn.priorState)) {
    conflict('owner receipt default coturn state is invalid');
  }
  if (!['active', 'resources-removed', 'installing', 'upgrading', 'cleaning', 'rollback-pending'].includes(value.state)) {
    conflict('owner receipt state is invalid');
  }
  if (value.state === 'active' || value.state === 'resources-removed') {
    if (value.transaction !== null) conflict('committed owner receipt has a pending transaction');
  } else if (!value.transaction || typeof value.transaction !== 'object' || Array.isArray(value.transaction)) {
    conflict('incomplete owner transaction journal');
  }
  if (ctx.namespace && value.packageManager !== 'test') conflict('namespace receipt has unexpected package manager');
}

function makeReceipt(ctx, {
  port,
  unitText,
  configText,
  packageManager,
  packageInstalledByKcoder,
  packageVersion,
  defaultCoturn,
  adoptedExisting,
  state = 'active',
  transaction = null,
}) {
  return {
    schema: RECEIPT_SCHEMA,
    owner: OWNER_ID,
    port,
    unitName: ctx.unitName,
    unitPath: ctx.unitLogical,
    configPath: ctx.configLogical,
    unitSha256: sha256(unitText),
    configSha256: sha256(configText),
    packageManager,
    packageInstalledByKcoder,
    packageVersion,
    defaultCoturn,
    adoptedExisting,
    state,
    transaction,
  };
}

function writeJsonResult(ctx, state, receipt, receiptState = 'none') {
  const port = receipt?.port ?? null;
  const packageManager = receipt?.packageManager ?? (ctx.namespace ? 'test' : 'none');
  const packageOwned = receipt?.packageInstalledByKcoder ?? false;
  process.stdout.write(`${JSON.stringify({
    component: 'stun',
    action: ctx.action,
    state,
    unit: ctx.unitName,
    config: ctx.configLogical,
    port,
    packageManager,
    packageInstalledByKcoder: packageOwned,
    receiptState,
  })}\n`);
}

function writeStatusResult(ctx, state, receipt, healthy) {
  const port = receipt?.port ?? null;
  const packageManager = receipt?.packageManager ?? (ctx.namespace ? 'test' : 'none');
  const packageOwned = receipt?.packageInstalledByKcoder ?? false;
  process.stdout.write(`${JSON.stringify({
    component: 'stun',
    action: ctx.action,
    state,
    healthy,
    unit: ctx.unitName,
    config: ctx.configLogical,
    port,
    packageManager,
    packageInstalledByKcoder: packageOwned,
    receiptState: receipt?.state ?? 'none',
  })}\n`);
}

function getOsRelease(ctx) {
  const file = ctx.fixtureRoot ? path.join(ctx.fixtureRoot, 'etc/os-release') : '/etc/os-release';
  let contents;
  try { contents = fs.readFileSync(file, 'utf8'); } catch { hostError('cannot read /etc/os-release'); }
  const fields = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    fields.set(match[1], match[2].replace(/^"|"$/g, ''));
  }
  return fields;
}

function selectPackageManager(ctx) {
  if (ctx.namespace) return 'test';
  const fields = getOsRelease(ctx);
  const ids = [fields.get('ID') ?? '', ...(fields.get('ID_LIKE') ?? '').split(/\s+/)].join(' ').toLowerCase();
  if (/(^|\s)(debian|ubuntu)(\s|$)/.test(ids)) return 'apt';
  if (/(^|\s)(rhel|centos|fedora|rocky|almalinux|opencloudos|ol)(\s|$)/.test(ids)) return 'dnf';
  hostError(`unsupported Linux package family: ${fields.get('ID') ?? 'unknown'}`);
}

function packageVersion(ctx, manager) {
  if (manager === 'test') return null;
  if (manager === 'apt') {
    const status = runTool(ctx, 'dpkg-query', ['-W', '-f=${db:Status-Status}', 'coturn'], { acceptFailure: true });
    if (status.code !== 0 || status.stdout.trim() !== 'installed') return null;
  }
  const result = manager === 'apt'
    ? runTool(ctx, 'dpkg-query', ['-W', '-f=${Version}', 'coturn'], { acceptFailure: true })
    : runTool(ctx, 'rpm', ['-q', '--qf', '%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}', 'coturn'], { acceptFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  if (!value || !/^[A-Za-z0-9.+:~_-]{1,160}$/.test(value)) hostError('package manager returned an invalid coturn version');
  return value;
}

function runPackageAction(ctx, manager, action, version = null) {
  if (manager === 'test') return;
  if (manager === 'apt') {
    if (action === 'install') runTool(ctx, 'apt-get', ['install', '-y', 'coturn']);
    else if (action === 'upgrade') runTool(ctx, 'apt-get', ['install', '-y', '--only-upgrade', 'coturn']);
    else if (action === 'remove') runTool(ctx, 'apt-get', ['remove', '-y', 'coturn']);
    else if (action === 'restore') runTool(ctx, 'apt-get', ['install', '-y', `coturn=${version}`]);
    return;
  }
  if (action === 'install') runTool(ctx, 'dnf', ['install', '-y', 'coturn']);
  else if (action === 'upgrade') runTool(ctx, 'dnf', ['upgrade', '-y', 'coturn']);
  else if (action === 'remove') runTool(ctx, 'dnf', ['remove', '-y', 'coturn']);
  else if (action === 'restore') runTool(ctx, 'dnf', ['install', '-y', `coturn-${version}`]);
}

function checkTurnserver(ctx) {
  const stat = lstatOrNull(ctx.turnserverFile);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    hostError(`coturn server executable is unavailable at ${ctx.namespace || ctx.isFixture ? ctx.turnserverFile : '/usr/bin/turnserver'}`);
  }
  if (!ctx.isFixture && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) conflict('coturn executable is not root-owned and protected');
}

function systemctlUnitState(ctx, unitName) {
  const load = runTool(ctx, 'systemctl', ['show', '--property=LoadState', '--value', unitName], { acceptFailure: true });
  if (load.code !== 0) hostError(`cannot inspect ${unitName} LoadState`);
  const fragment = runTool(ctx, 'systemctl', ['show', '--property=FragmentPath', '--value', unitName], { acceptFailure: true });
  if (fragment.code !== 0) hostError(`cannot inspect ${unitName} FragmentPath`);
  const active = runTool(ctx, 'systemctl', ['is-active', unitName], { acceptFailure: true });
  const enabled = runTool(ctx, 'systemctl', ['is-enabled', unitName], { acceptFailure: true });
  const mainPidResult = runTool(ctx, 'systemctl', ['show', '--property=MainPID', '--value', unitName], { acceptFailure: true });
  if (mainPidResult.code !== 0) hostError(`cannot inspect ${unitName} MainPID`);
  const mainPidText = mainPidResult.stdout.trim();
  return {
    loadState: load.stdout.trim(),
    fragmentPath: fragment.stdout.trim(),
    activeState: active.stdout.trim() || 'unknown',
    enabledState: enabled.stdout.trim() || 'unknown',
    active: active.code === 0 && active.stdout.trim() === 'active',
    mainPid: /^[0-9]+$/.test(mainPidText) ? Number(mainPidText) : null,
  };
}

function inspectDefaultCoturn(ctx) {
  const state = systemctlUnitState(ctx, 'coturn.service');
  const maskStat = lstatOrNull(ctx.maskFile);
  const symlinkMasked = Boolean(maskStat?.isSymbolicLink() && fs.readlinkSync(ctx.maskFile) === '/dev/null');
  const masked = symlinkMasked || state.loadState === 'masked' || state.enabledState === 'masked';
  if (state.active) conflict('default coturn.service is active; preserving it and refusing a second coturn instance');
  if (state.loadState === 'not-found' || state.loadState === '') {
    if (maskStat && !symlinkMasked) conflict('default coturn.service path is occupied by an unmanaged resource');
    return { state, masked, priorState: masked ? 'masked' : 'not-found' };
  }
  if (masked) return { state, masked: true, priorState: 'masked' };
  conflict(`default coturn.service is present but not masked (enabled state: ${state.enabledState})`);
}

function inspectPortAvailable(ctx, port) {
  const procRoot = ctx.fixtureRoot ? path.join(ctx.fixtureRoot, 'proc/net') : '/proc/net';
  for (const fileName of ['udp', 'udp6']) {
    const file = path.join(procRoot, fileName);
    let contents;
    try { contents = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    for (const line of contents.split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[1]?.endsWith(`:${hex}`)) conflict(`UDP port ${port} is already bound by another process`);
    }
  }
}

function setDefaultMask(ctx, receipt) {
  if (ctx.namespace || receipt.defaultCoturn.priorState === 'masked') return;
  if (exists(ctx, ctx.maskFile)) conflict('default coturn.service path changed before package install');
  atomicSymlink(ctx, '/dev/null', ctx.maskFile);
  receipt.defaultCoturn.maskOwned = true;
  writeReceipt(ctx, receipt);
  runTool(ctx, 'systemctl', ['daemon-reload']);
}

function clearOwnedDefaultMask(ctx, receipt) {
  if (!receipt.defaultCoturn.maskOwned) return;
  const stat = lstatOrNull(ctx.maskFile);
  if (!stat?.isSymbolicLink() || fs.readlinkSync(ctx.maskFile) !== '/dev/null' || stat.uid !== ctx.ownerUid) {
    conflict('KCoder-owned default coturn mask has drifted; preserving it');
  }
  fs.unlinkSync(ctx.maskFile);
  runTool(ctx, 'systemctl', ['daemon-reload']);
}

function validateAdoptConfig(contents, port) {
  const directives = parseConfig(contents);
  const required = new Map([
    ['listening-port', String(port)], ['listening-ip', '0.0.0.0'], ['stun-only', ''], ['no-auth', ''],
    ['no-tcp', ''], ['no-tls', ''], ['no-dtls', ''], ['no-cli', ''],
  ]);
  if ([...required].some(([key, value]) => directives.get(key) !== value)
      || [...directives.keys()].some((key) => !required.has(key) && !['no-udp-relay', 'no-tcp-relay'].includes(key))) {
    conflict('existing config is not an explicit KCoder STUN-only policy');
  }
  return directives;
}

function parseAdoptableUnit(contents, { configPath, unitName }) {
  validateUnitName(unitName);
  validateConfigPath(configPath);
  if (typeof contents !== 'string') conflict('existing STUN unit is not text');
  const sections = new Map();
  let section = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([A-Za-z]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!ADOPTABLE_UNIT_KEYS.has(section) || sections.has(section)) conflict(`unsupported unit section: ${section}`);
      sections.set(section, new Map());
      continue;
    }
    if (!section || !line.includes('=')) conflict('malformed existing STUN unit');
    const [key, ...valueParts] = line.split('=');
    const value = valueParts.join('=').trim();
    const values = sections.get(section);
    if (!ADOPTABLE_UNIT_KEYS.get(section).has(key) || values.has(key)) conflict(`unsafe or duplicate unit directive: ${key}`);
    values.set(key, value);
  }
  if (sections.size !== 3 || !['Unit', 'Service', 'Install'].every((name) => sections.has(name))) {
    conflict('existing unit must have exactly Unit, Service and Install sections');
  }
  const unit = sections.get('Unit');
  const service = sections.get('Service');
  const install = sections.get('Install');
  const expectedExec = `/usr/bin/turnserver -c ${configPath}`;
  if (service.get('ExecStart') !== expectedExec || service.get('Type') !== 'simple') {
    conflict('existing unit ExecStart or service type does not match this STUN config');
  }
  const dynamicUser = service.get('DynamicUser') === 'yes';
  const staticUser = service.get('User') === 'kcoder-stun' && service.get('Group') === 'kcoder-stun';
  if ((!dynamicUser && !staticUser) || (dynamicUser && (service.has('User') || service.has('Group')))) {
    conflict('existing unit must run as DynamicUser or the dedicated kcoder-stun user/group');
  }
  if (service.get('NoNewPrivileges') !== 'yes' || service.get('PrivateTmp') !== 'yes'
      || !['strict', 'full'].includes(service.get('ProtectSystem')) || service.get('ProtectHome') !== 'yes') {
    conflict('existing unit is missing required process hardening');
  }
  const families = (service.get('RestrictAddressFamilies') ?? '').split(/\s+/).filter(Boolean);
  if (families.length === 0 || families.some((name) => !['AF_INET', 'AF_INET6', 'AF_UNIX'].includes(name))) {
    conflict('existing unit permits an unsupported address family');
  }
  if (service.get('Restart') && service.get('Restart') !== 'on-failure') conflict('existing unit has an unexpected restart policy');
  if (service.get('RuntimeDirectory') && service.get('RuntimeDirectory') !== unitName.replace(/\.service$/, '')) {
    conflict('existing unit runtime directory does not match the dedicated unit');
  }
  if (unit.get('Description') && !/KCoder.*STUN/i.test(unit.get('Description'))) conflict('existing unit description is not KCoder STUN');
  if (unit.get('After') && unit.get('After') !== 'network-online.target') conflict('existing unit has unexpected ordering dependencies');
  if (unit.get('Wants') && unit.get('Wants') !== 'network-online.target') conflict('existing unit has unexpected dependencies');
  if (install.get('WantedBy') !== 'multi-user.target') conflict('existing unit has unexpected install target');
  return { unitName, configPath };
}

function validateReceiptAssets(ctx, receipt) {
  if (receipt.state === 'resources-removed') {
    if (exists(ctx, ctx.configFile) || exists(ctx, ctx.unitFile)) conflict('removed STUN resources reappeared without an owner transaction');
    return;
  }
  if (!exists(ctx, ctx.configFile) || !exists(ctx, ctx.unitFile)) conflict('a receipt-owned STUN asset is missing');
  validateManagedFile(ctx, ctx.configFile, { mode: 0o644 });
  validateManagedFile(ctx, ctx.unitFile, { mode: 0o644 });
  if (fileHash(ctx, ctx.configFile) !== receipt.configSha256 || fileHash(ctx, ctx.unitFile) !== receipt.unitSha256) {
    conflict('a receipt-owned STUN asset changed after installation');
  }
  try {
    validateStunConfig(fs.readFileSync(ctx.configFile, 'utf8'), { port: receipt.port, configPath: ctx.configLogical });
    validateStunUnit(fs.readFileSync(ctx.unitFile, 'utf8'), { configPath: ctx.configLogical, unitName: ctx.unitName });
  } catch (error) {
    conflict(`receipt-owned STUN asset does not match its policy: ${error.message}`);
  }
}

function assertNoUnitDropIns(ctx) {
  const info = systemctlUnitState(ctx, ctx.unitName);
  if (info.loadState !== 'not-found' && info.loadState !== 'loaded' && info.loadState !== '') {
    conflict(`dedicated service has unexpected LoadState: ${info.loadState}`);
  }
  if (info.fragmentPath && info.fragmentPath !== ctx.unitFile) {
    conflict(`dedicated unit resolves to an unexpected path: ${info.fragmentPath}`);
  }
  const dropIns = runTool(ctx, 'systemctl', ['show', '--property=DropInPaths', '--value', ctx.unitName], { acceptFailure: true });
  if (dropIns.code !== 0) hostError(`cannot inspect drop-ins for ${ctx.unitName}`);
  if (dropIns.stdout.trim()) conflict(`dedicated unit has unowned drop-ins: ${dropIns.stdout.trim()}`);
  return info;
}

function packageDefaultState(ctx, receipt) {
  if (ctx.namespace) return;
  const current = inspectDefaultCoturn(ctx);
  if (receipt) {
    if (receipt.defaultCoturn.maskOwned) {
      if (!current.masked || !fs.lstatSync(ctx.maskFile).isSymbolicLink() || fs.readlinkSync(ctx.maskFile) !== '/dev/null') {
        conflict('KCoder-owned default coturn mask has drifted');
      }
    } else if (receipt.defaultCoturn.priorState === 'masked' && !current.masked) {
      conflict('pre-existing coturn mask was removed outside KCoder');
    } else if (receipt.defaultCoturn.priorState === 'not-found' && current.state.loadState !== 'not-found') {
      conflict('default coturn service appeared outside KCoder');
    }
    return;
  }
  return current;
}

async function serviceStatus(ctx, receipt) {
  validateReceiptAssets(ctx, receipt);
  const info = assertNoUnitDropIns(ctx);
  if (info.fragmentPath && info.fragmentPath !== ctx.unitFile) conflict('dedicated unit is not loaded from the owned unit path');
  if (info.loadState === 'masked') conflict('receipt-owned STUN unit is masked outside lifecycle ownership');
  if (!info.active || info.enabledState !== 'enabled' || info.fragmentPath !== ctx.unitFile) {
    return { state: info.active ? 'unhealthy' : 'inactive', healthy: false };
  }
  try {
    await probeStun(ctx, receipt.port);
    return { state: 'active', healthy: true };
  } catch {
    return { state: 'unhealthy', healthy: false };
  }
}

function makeStunRequest() {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(0x2112a442, 4);
  crypto.randomBytes(12).copy(request, 8);
  return request;
}

function probeStun(ctx, port, { timeoutMs = 9000 } = {}) {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    const request = makeStunRequest();
    const transaction = request.subarray(8);
    let settled = false;
    let deadlineTimer;
    let retryTimer;
    let retryDelayMs = 250;
    let lastSocketError = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(retryTimer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    socket.on('message', (message) => {
      if (message.length < 20 || message.readUInt32BE(4) !== 0x2112a442
          || !message.subarray(8, 20).equals(transaction)) return;
      if (message.readUInt16BE(0) !== 0x0101) {
        finish(new Error('invalid STUN Binding response'));
        return;
      }
      finish();
    });
    socket.on('error', (error) => { lastSocketError = error; });
    const sendRequest = () => {
      socket.send(request, port, '127.0.0.1', (error) => { if (error) lastSocketError = error; });
    };
    const scheduleRetry = () => {
      if (settled) return;
      retryTimer = setTimeout(() => {
        sendRequest();
        retryDelayMs = Math.min(retryDelayMs * 2, 1000);
        scheduleRetry();
      }, retryDelayMs);
    };
    deadlineTimer = setTimeout(() => {
      const detail = lastSocketError ? ` (${lastSocketError.message})` : '';
      finish(new Error(`no STUN Binding response on UDP ${port}${detail}`));
    }, timeoutMs);
    sendRequest();
    scheduleRetry();
  });
}

function backupAsset(ctx, file, label, txid) {
  if (!exists(ctx, file)) return { exists: false, name: null, sha256: null, mode: null };
  const stat = validateManagedFile(ctx, file);
  const name = `backup-${txid}-${label}`;
  const backupPath = path.join(ctx.stateDir, name);
  const bytes = fs.readFileSync(file);
  safeAtomicWrite(ctx, backupPath, bytes, stat.mode & 0o777);
  return { exists: true, name, sha256: sha256(bytes), mode: stat.mode & 0o777 };
}

function validateBackup(ctx, descriptor) {
  if (!descriptor?.exists) return;
  if (typeof descriptor.name !== 'string' || !/^backup-[a-f0-9]{16}-(config|unit)$/.test(descriptor.name)) {
    conflict('transaction backup name is unsafe');
  }
  const file = path.join(ctx.stateDir, descriptor.name);
  validateManagedFile(ctx, file, { mode: descriptor.mode });
  if (fileHash(ctx, file) !== descriptor.sha256) conflict(`transaction backup changed: ${descriptor.name}`);
}

function restoreAsset(ctx, target, descriptor) {
  if (!descriptor.exists) {
    if (exists(ctx, target)) safeUnlink(ctx, target);
    return;
  }
  validateBackup(ctx, descriptor);
  const backup = path.join(ctx.stateDir, descriptor.name);
  safeAtomicWrite(ctx, target, fs.readFileSync(backup), descriptor.mode);
}

function removeBackup(ctx, descriptor) {
  if (!descriptor?.exists) return;
  validateBackup(ctx, descriptor);
  safeUnlink(ctx, path.join(ctx.stateDir, descriptor.name));
}

function cleanupBackups(ctx, transaction) {
  if (!transaction?.backups) return;
  removeBackup(ctx, transaction.backups.config);
  removeBackup(ctx, transaction.backups.unit);
}

function acquireLock(ctx) {
  ensureDirectory(ctx, ctx.stateDir, { privateDirectory: true });
  const lockDir = path.join(ctx.stateDir, 'lifecycle.lock');
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') conflict('another STUN lifecycle operation holds the owner lock');
    hostError(`cannot create lifecycle lock: ${error.message}`);
  }
  try {
    fs.chmodSync(lockDir, 0o700);
    const ownerFile = path.join(lockDir, 'owner');
    const body = `${process.pid}\n${Date.now()}\n`;
    fs.writeFileSync(ownerFile, body, { flag: 'wx', mode: 0o600 });
    if (ctx.ownerUid === 0) fs.chownSync(ownerFile, 0, 0);
  } catch (error) {
    try { fs.unlinkSync(path.join(lockDir, 'owner')); } catch {}
    try { fs.rmdirSync(lockDir); } catch {}
    hostError(`cannot initialize lifecycle lock: ${error.message}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const ownerFile = path.join(lockDir, 'owner');
    const stat = lstatOrNull(ownerFile);
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.uid === ctx.ownerUid) fs.unlinkSync(ownerFile);
    try { fs.rmdirSync(lockDir); } catch (error) {
      if (error.code !== 'ENOENT') hostError(`cannot release lifecycle lock: ${error.message}`);
    }
    try { fs.rmdirSync(ctx.stateDir); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) hostError(`cannot remove empty owner directory: ${error.message}`);
    }
  };
}

function currentServiceSnapshot(ctx) {
  const state = systemctlUnitState(ctx, ctx.unitName);
  return {
    active: state.active,
    enabled: state.enabledState === 'enabled',
  };
}

function managedTurnProcesses(ctx) {
  const procRoot = ctx.fixtureRoot ? path.join(ctx.fixtureRoot, 'proc') : '/proc';
  let entries = [];
  try { entries = fs.readdirSync(procRoot); } catch { return []; }
  const matches = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let command;
    try { command = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8').replaceAll('\0', ' '); } catch { continue; }
    if (/\bturnserver\b/i.test(command) && command.includes(ctx.configLogical)) matches.push(Number(entry));
  }
  return matches;
}

function assertDedicatedServiceStopped(ctx, { allowNotLoaded = false } = {}) {
  const state = systemctlUnitState(ctx, ctx.unitName);
  if (allowNotLoaded && state.loadState === 'not-found' && !state.fragmentPath) {
    if (state.active || state.mainPid !== 0) hostError(`removed STUN unit still has a process (MainPID: ${state.mainPid ?? 'unknown'})`);
    if (!['disabled', 'not-found', 'unknown'].includes(state.enabledState)) {
      hostError(`removed STUN unit is still enabled (state: ${state.enabledState})`);
    }
    const processes = managedTurnProcesses(ctx);
    if (processes.length) hostError(`dedicated STUN process remains after unit removal: ${processes.join(', ')}`);
    return;
  }
  if (state.active || state.activeState !== 'inactive') {
    hostError(`dedicated STUN unit did not become inactive (state: ${state.activeState})`);
  }
  if (state.enabledState !== 'disabled') {
    hostError(`dedicated STUN unit was not disabled (state: ${state.enabledState})`);
  }
  if (state.mainPid !== 0) hostError(`dedicated STUN unit still has a process (MainPID: ${state.mainPid ?? 'unknown'})`);
  const processes = managedTurnProcesses(ctx);
  if (processes.length) hostError(`dedicated STUN process remains after stop: ${processes.join(', ')}`);
}

function makeTransaction(ctx, operation, previousReceipt, backups, packageVersionBefore, oldService) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    operation,
    phase: 'prepared',
    backups,
    previousReceipt,
    packageVersionBefore,
    packageAction: 'none',
    oldService,
    maskCreated: false,
  };
}

function writeTransaction(ctx, receipt, phase, extra = {}) {
  receipt.transaction = { ...receipt.transaction, ...extra, phase };
  writeReceipt(ctx, receipt);
}

function safeRemoveStage(ctx, stageDir, unitStage, configStage) {
  for (const file of [unitStage, configStage]) {
    if (exists(ctx, file)) safeUnlink(ctx, file);
  }
  if (exists(ctx, stageDir)) {
    const stat = lstatOrNull(stageDir);
    if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === ctx.ownerUid) {
      try { fs.rmdirSync(stageDir); } catch {}
    }
  }
}

function checkSystemdSyntax(ctx, stageDir, unitText, unitStage) {
  ensureDirectory(ctx, stageDir, { privateDirectory: true });
  safeAtomicWrite(ctx, unitStage, unitText, 0o600);
  runTool(ctx, 'systemd-analyze', ['verify', unitStage]);
}

function isPackageInstalled(ctx, manager) {
  if (manager === 'test') {
    checkTurnserver(ctx);
    return true;
  }
  return packageVersion(ctx, manager) !== null;
}

function assertPackageAndDefault(ctx, receipt, manager) {
  const version = packageVersion(ctx, manager);
  if (!version) conflict('coturn package recorded by KCoder is no longer installed');
  packageDefaultState(ctx, receipt);
  return version;
}

function checkUnmanagedAssets(ctx) {
  const configExists = exists(ctx, ctx.configFile);
  const unitExists = exists(ctx, ctx.unitFile);
  if (configExists !== unitExists) conflict('only one of the expected STUN config/unit files exists');
  return { configExists, unitExists };
}

function prepareAdoption(ctx, port, filesExist, adoptExisting) {
  if (!filesExist.configExists) return false;
  if (!adoptExisting) conflict('same-name STUN assets are unmanaged; pass --adopt-existing after reviewing them');
  validateManagedFile(ctx, ctx.configFile, { mode: 0o644 });
  validateManagedFile(ctx, ctx.unitFile, { mode: 0o644 });
  try {
    validateAdoptConfig(fs.readFileSync(ctx.configFile, 'utf8'), port);
    parseAdoptableUnit(fs.readFileSync(ctx.unitFile, 'utf8'), { configPath: ctx.configLogical, unitName: ctx.unitName });
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    conflict(`existing STUN assets cannot be adopted: ${error.message}`);
  }
  return true;
}

function assertReceiptReady(ctx, receipt, requestedPort, action) {
  if (!receipt) return;
  if (!['active', 'resources-removed'].includes(receipt.state)) conflict(`owner receipt requires recovery from state ${receipt.state}`);
  if (receipt.state === 'resources-removed') conflict('STUN resources were removed but an owned package remains; run cleanup before install or upgrade');
  validateReceiptAssets(ctx, receipt);
  if (action === 'install' && receipt.port !== requestedPort) {
    conflict(`install cannot change the owned port (${receipt.port}); use upgrade`);
  }
  packageDefaultState(ctx, receipt);
  if (receipt.packageInstalledByKcoder) {
    const actual = assertPackageAndDefault(ctx, receipt, receipt.packageManager);
    if (receipt.packageVersion && actual !== receipt.packageVersion) {
      conflict('KCoder-owned coturn package version changed outside the lifecycle manager');
    }
  } else if (receipt.packageManager !== 'test' && !packageVersion(ctx, receipt.packageManager)) {
    conflict('shared coturn package is missing; preserving receipt-owned STUN resources');
  }
}

function previousReceiptClone(receipt) {
  return receipt ? JSON.parse(JSON.stringify(receipt)) : null;
}

function readOtherTurnConsumers(ctx) {
  const matches = [];
  const roots = ctx.fixtureRoot
    ? ['etc/systemd/system', 'usr/lib/systemd/system', 'lib/systemd/system'].map((entry) => path.join(ctx.fixtureRoot, entry))
    : ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'];
  const seen = new Set();
  const inspectFile = (file, depth = 0) => {
    if (depth > 2 || seen.has(file)) return;
    seen.add(file);
    const stat = lstatOrNull(file);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      let resolved;
      try { resolved = fs.realpathSync(file); } catch { return; }
      inspectFile(resolved, depth + 1);
      return;
    }
    if (stat.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(file); } catch { return; }
      for (const name of names) {
        if (name.endsWith('.service') || name.endsWith('.conf') || name.endsWith('.service.d')) inspectFile(path.join(file, name), depth + 1);
      }
      return;
    }
    if (!stat.isFile() || stat.size > 256 * 1024) return;
    const base = path.basename(file);
    if (base === 'coturn.service' || base === ctx.unitName) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (/\b(?:turnserver|coturn)\b/i.test(text)) matches.push(file);
  };
  for (const root of roots) inspectFile(root);

  const procRoot = ctx.fixtureRoot ? path.join(ctx.fixtureRoot, 'proc') : '/proc';
  let procEntries = [];
  try { procEntries = fs.readdirSync(procRoot); } catch {}
  for (const entry of procEntries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const cmdline = path.join(procRoot, entry, 'cmdline');
    let command;
    try { command = fs.readFileSync(cmdline, 'utf8').replaceAll('\0', ' '); } catch { continue; }
    if (/\b(?:turnserver|coturn)\b/i.test(command)) matches.push(`pid:${entry}`);
  }
  return [...new Set(matches)];
}

function removeCreatedMaskIfSafe(ctx, transaction, receipt) {
  if (!transaction.maskCreated) return;
  const stat = lstatOrNull(ctx.maskFile);
  if (!stat) return;
  if (!stat.isSymbolicLink() || fs.readlinkSync(ctx.maskFile) !== '/dev/null' || stat.uid !== ctx.ownerUid) {
    conflict('new default coturn mask changed during rollback; preserving it');
  }
  fs.unlinkSync(ctx.maskFile);
  runTool(ctx, 'systemctl', ['daemon-reload']);
  if (receipt) receipt.defaultCoturn.maskOwned = false;
}

function restoreServiceState(ctx, snapshot) {
  runTool(ctx, 'systemctl', ['daemon-reload']);
  const unitExists = exists(ctx, ctx.unitFile);
  let state = systemctlUnitState(ctx, ctx.unitName);
  if (!unitExists) {
    if (snapshot?.active || snapshot?.enabled || state.active || state.mainPid !== 0
        || state.enabledState === 'enabled' || managedTurnProcesses(ctx).length) {
      hostError('cannot restore an absent dedicated unit while it is active, enabled or has a process');
    }
    return;
  }
  if (state.loadState === 'not-found' || !state.fragmentPath) {
    runTool(ctx, 'systemctl', ['daemon-reload']);
    state = assertNoUnitDropIns(ctx);
  }
  if (state.loadState !== 'loaded' || state.fragmentPath !== ctx.unitFile) {
    conflict('cannot restore service state from an unexpected dedicated unit path');
  }
  if (snapshot?.enabled) runTool(ctx, 'systemctl', ['enable', ctx.unitName]);
  else runTool(ctx, 'systemctl', ['disable', ctx.unitName]);
  if (snapshot?.active) runTool(ctx, 'systemctl', ['restart', ctx.unitName]);
  else {
    runTool(ctx, 'systemctl', ['stop', ctx.unitName]);
    resetFailedIfLoaded(ctx);
  }

  state = systemctlUnitState(ctx, ctx.unitName);
  const expectedActive = snapshot?.active ? 'active' : 'inactive';
  const expectedEnabled = snapshot?.enabled ? 'enabled' : 'disabled';
  if (state.loadState !== 'loaded' || state.fragmentPath !== ctx.unitFile
      || state.activeState !== expectedActive || state.enabledState !== expectedEnabled
      || state.mainPid === null || (snapshot?.active ? state.mainPid === 0 : state.mainPid !== 0)) {
    hostError(`dedicated STUN service state did not roll back (active=${state.activeState}, enabled=${state.enabledState}, MainPID=${state.mainPid ?? 'unknown'})`);
  }
  if (!snapshot?.active) {
    const processes = managedTurnProcesses(ctx);
    if (processes.length) hostError(`dedicated STUN process remains after rollback: ${processes.join(', ')}`);
  }
}

function stopServiceForRollback(ctx) {
  let state = systemctlUnitState(ctx, ctx.unitName);
  const unitExists = exists(ctx, ctx.unitFile);
  if (!unitExists && (state.loadState === 'not-found' || !state.fragmentPath)) {
    if (state.active || state.mainPid !== 0 || state.enabledState === 'enabled' || managedTurnProcesses(ctx).length) {
      hostError('dedicated STUN service is active without its receipt-owned unit file');
    }
    return;
  }
  if (state.loadState === 'not-found' || !state.fragmentPath) {
    runTool(ctx, 'systemctl', ['daemon-reload']);
    state = assertNoUnitDropIns(ctx);
  }
  if (state.loadState !== 'loaded' || state.fragmentPath !== ctx.unitFile) {
    conflict('rollback found the dedicated unit loaded from an unexpected path');
  }
  if (state.active || state.activeState !== 'inactive' || state.mainPid !== 0) {
    runTool(ctx, 'systemctl', ['stop', ctx.unitName]);
    resetFailedIfLoaded(ctx);
  }
  state = systemctlUnitState(ctx, ctx.unitName);
  if (state.activeState !== 'inactive' || state.mainPid !== 0) {
    hostError(`cannot stop dedicated STUN service for rollback (active=${state.activeState}, MainPID=${state.mainPid ?? 'unknown'})`);
  }
  if (state.enabledState === 'enabled') runTool(ctx, 'systemctl', ['disable', ctx.unitName]);
  else if (state.enabledState !== 'disabled') hostError(`cannot disable dedicated STUN service for rollback (state: ${state.enabledState})`);
  state = systemctlUnitState(ctx, ctx.unitName);
  if (state.activeState !== 'inactive' || state.enabledState !== 'disabled' || state.mainPid !== 0) {
    hostError(`dedicated STUN service did not stop before rollback (active=${state.activeState}, enabled=${state.enabledState}, MainPID=${state.mainPid ?? 'unknown'})`);
  }
  const processes = managedTurnProcesses(ctx);
  if (processes.length) hostError(`dedicated STUN process remains before rollback: ${processes.join(', ')}`);
}

function restorePackageVersion(ctx, manager, expectedVersion) {
  if (!expectedVersion) hostError('cannot restore coturn package because its prior version is unknown');
  if (packageVersion(ctx, manager) !== expectedVersion) {
    runPackageAction(ctx, manager, 'restore', expectedVersion);
  }
  const restoredVersion = packageVersion(ctx, manager);
  if (restoredVersion !== expectedVersion) {
    hostError(`coturn package version was not restored exactly (expected ${expectedVersion}, got ${restoredVersion ?? 'absent'})`);
  }
}

function rollbackLifecycle(ctx, pendingReceipt, originalError) {
  const transaction = pendingReceipt.transaction;
  try {
    failAt(ctx, 'rollback');
    stopServiceForRollback(ctx);
    restoreAsset(ctx, ctx.configFile, transaction.backups.config);
    restoreAsset(ctx, ctx.unitFile, transaction.backups.unit);
    runTool(ctx, 'systemctl', ['daemon-reload']);

    if (transaction.packageAction === 'upgrade-attempted') {
      restorePackageVersion(ctx, pendingReceipt.packageManager, transaction.packageVersionBefore);
    } else if (transaction.packageAction === 'install-attempted') {
      const currentVersion = packageVersion(ctx, pendingReceipt.packageManager);
      if (currentVersion) {
        const consumers = readOtherTurnConsumers(ctx);
        if (consumers.length) hostError(`new coturn package has consumers after rollback: ${consumers.join(', ')}`);
        runPackageAction(ctx, pendingReceipt.packageManager, 'remove');
        if (packageVersion(ctx, pendingReceipt.packageManager)) hostError('new coturn package remained installed after rollback');
      }
    } else if (transaction.packageAction === 'remove-attempted') {
      restorePackageVersion(ctx, pendingReceipt.packageManager, transaction.packageVersionBefore);
    }

    const stageDir = path.join(ctx.stateDir, `stage-${transaction.id}`);
    safeRemoveStage(ctx, stageDir, path.join(stageDir, ctx.unitName), path.join(stageDir, `${ctx.unitName}.conf`));
    removeCreatedMaskIfSafe(ctx, transaction, pendingReceipt);
    if (transaction.maskRemoved) {
      const mask = lstatOrNull(ctx.maskFile);
      if (!mask) atomicSymlink(ctx, '/dev/null', ctx.maskFile);
      else if (!mask.isSymbolicLink() || fs.readlinkSync(ctx.maskFile) !== '/dev/null') conflict('default coturn mask changed during cleanup rollback');
      runTool(ctx, 'systemctl', ['daemon-reload']);
    }
    restoreServiceState(ctx, transaction.oldService);
    const oldReceipt = transaction.previousReceipt;
    if (oldReceipt) writeReceipt(ctx, oldReceipt);
    else safeUnlink(ctx, ctx.receiptFile);
    cleanupBackups(ctx, transaction);
  } catch (rollbackError) {
    pendingReceipt.state = 'rollback-pending';
    pendingReceipt.transaction = {
      ...transaction,
      phase: 'rollback-pending',
      failure: String(originalError?.message ?? originalError).slice(0, 400),
      rollbackFailure: String(rollbackError?.message ?? rollbackError).slice(0, 400),
    };
    try { writeReceipt(ctx, pendingReceipt); } catch {}
    throw new LifecycleError(
      `STUN operation failed and rollback is pending: ${String(rollbackError?.message ?? rollbackError)}`,
      4,
    );
  }
  throw originalError;
}

function removeStageBeforeCommit(ctx, stageDir, unitStage, configStage) {
  if (!exists(ctx, stageDir)) return;
  ensureDirectory(ctx, stageDir, { privateDirectory: true });
  const allowed = new Set([path.basename(unitStage), path.basename(configStage)]);
  for (const name of fs.readdirSync(stageDir)) {
    if (!allowed.has(name)) conflict(`unexpected file in private staging directory: ${name}`);
  }
  safeRemoveStage(ctx, stageDir, unitStage, configStage);
  if (exists(ctx, stageDir)) hostError(`cannot remove private staging directory before commit: ${stageDir}`);
}

function postCommitFailure(action, error) {
  return new LifecycleError(
    `STUN ${action} committed but post-commit cleanup or reporting failed: ${String(error?.message ?? error)}`,
    4,
  );
}

function removeOwnedPackageAndMask(ctx, receipt, transaction) {
  if (!receipt.packageInstalledByKcoder || receipt.packageManager === 'test') return { removed: false, consumers: [] };
  const actualVersion = packageVersion(ctx, receipt.packageManager);
  if (!actualVersion) conflict('KCoder-owned coturn package is already missing');
  if (receipt.packageVersion && actualVersion !== receipt.packageVersion) {
    conflict('KCoder-owned coturn package version drifted; preserving it');
  }
  packageDefaultState(ctx, receipt);
  const consumers = readOtherTurnConsumers(ctx);
  if (consumers.length) return { removed: false, consumers };

  transaction.packageAction = 'remove-attempted';
  writeTransaction(ctx, receipt, 'package-remove-pending', { packageAction: 'remove-attempted' });
  runPackageAction(ctx, receipt.packageManager, 'remove');
  failAt(ctx, 'package-remove');
  if (packageVersion(ctx, receipt.packageManager)) hostError('coturn package remains installed after cleanup');
  if (receipt.defaultCoturn.maskOwned) {
    transaction.maskRemoved = true;
    writeTransaction(ctx, receipt, 'mask-remove-pending', { maskRemoved: true });
    clearOwnedDefaultMask(ctx, receipt);
    failAt(ctx, 'mask-remove');
  }
  return { removed: true, consumers: [] };
}

async function cleanupLifecycle(ctx) {
  let receipt = readReceipt(ctx);
  if (!receipt) {
    const assets = checkUnmanagedAssets(ctx);
    if (assets.configExists || assets.unitExists) conflict('unmanaged STUN config/unit exists without an owner receipt');
    writeJsonResult(ctx, 'absent', null, 'none');
    return;
  }
  if (!['active', 'resources-removed'].includes(receipt.state)) conflict(`owner receipt requires recovery from state ${receipt.state}`);
  if (receipt.state === 'active') validateReceiptAssets(ctx, receipt);

  const release = acquireLock(ctx);
  try {
    receipt = readReceipt(ctx);
    if (!receipt || !['active', 'resources-removed'].includes(receipt.state)) conflict('owner receipt changed before cleanup acquired the lock');
    if (receipt.state === 'active') validateReceiptAssets(ctx, receipt);
    if (receipt.packageInstalledByKcoder && receipt.packageManager !== 'test') {
      const version = packageVersion(ctx, receipt.packageManager);
      if (!version) conflict('KCoder-owned coturn package is missing; refusing destructive cleanup');
      if (receipt.packageVersion && version !== receipt.packageVersion) conflict('KCoder-owned coturn package version drifted; refusing cleanup');
      packageDefaultState(ctx, receipt);
    } else if (!receipt.packageInstalledByKcoder && receipt.packageManager !== 'test'
        && !packageVersion(ctx, receipt.packageManager)) {
      conflict('shared coturn package is missing; refusing to clean only part of its owner receipt');
    }

    if (receipt.state === 'resources-removed') {
      assertDedicatedServiceStopped(ctx, { allowNotLoaded: true });
      const cleanupTx = {
        id: crypto.randomBytes(8).toString('hex'),
        operation: 'cleanup',
        phase: 'resources-removed',
        backups: { config: { exists: false }, unit: { exists: false } },
        previousReceipt: previousReceiptClone(receipt),
        packageVersionBefore: receipt.packageVersion,
        packageAction: 'none',
        oldService: { active: false, enabled: false },
        maskCreated: false,
        maskRemoved: false,
      };
      receipt.state = 'cleaning';
      receipt.transaction = cleanupTx;
      writeReceipt(ctx, receipt);
      try {
        const outcome = removeOwnedPackageAndMask(ctx, receipt, cleanupTx);
        if (outcome.consumers.length) {
          const retained = { ...receipt, state: 'resources-removed', transaction: null };
          writeReceipt(ctx, retained);
          writeJsonResult(ctx, 'resources-removed', retained, 'retained-package');
        } else {
          safeUnlink(ctx, ctx.receiptFile);
          cleanupBackups(ctx, cleanupTx);
          writeJsonResult(ctx, 'absent', null, 'none');
        }
      } catch (error) {
        rollbackLifecycle(ctx, receipt, error);
      }
      return;
    }

    let unitInfo = assertNoUnitDropIns(ctx);
    if (unitInfo.loadState === 'not-found' || !unitInfo.fragmentPath) {
      runTool(ctx, 'systemctl', ['daemon-reload']);
      unitInfo = assertNoUnitDropIns(ctx);
    }
    if (unitInfo.loadState !== 'loaded' || unitInfo.fragmentPath !== ctx.unitFile) {
      conflict('dedicated STUN unit is not loaded from the receipt-owned unit path');
    }
    const oldService = currentServiceSnapshot(ctx);
    const txid = crypto.randomBytes(8).toString('hex');
    const backups = {
      config: backupAsset(ctx, ctx.configFile, 'config', txid),
      unit: backupAsset(ctx, ctx.unitFile, 'unit', txid),
    };
    const transaction = makeTransaction(ctx, 'cleanup', previousReceiptClone(receipt), backups, receipt.packageVersion, oldService);
    transaction.id = txid;
    transaction.maskRemoved = false;
    const pending = { ...receipt, state: 'cleaning', transaction };
    writeReceipt(ctx, pending);

    let cleanupCommitted = false;
    try {
      runTool(ctx, 'systemctl', ['stop', ctx.unitName]);
      failAt(ctx, 'cleanup-stop');
      runTool(ctx, 'systemctl', ['disable', ctx.unitName]);
      resetFailedIfLoaded(ctx);
      failAt(ctx, 'cleanup-disable');
      assertDedicatedServiceStopped(ctx);
      safeUnlink(ctx, ctx.unitFile);
      failAt(ctx, 'cleanup-unit-remove');
      safeUnlink(ctx, ctx.configFile);
      failAt(ctx, 'cleanup-config-remove');
      runTool(ctx, 'systemctl', ['daemon-reload']);
      failAt(ctx, 'cleanup-daemon-reload');

      const outcome = removeOwnedPackageAndMask(ctx, pending, transaction);
      if (outcome.consumers.length) {
        const retained = { ...pending, state: 'resources-removed', transaction: null };
        failAt(ctx, 'consumer-receipt-write');
        writeReceipt(ctx, retained);
        cleanupCommitted = true;
        failAt(ctx, 'backup-cleanup');
        cleanupBackups(ctx, transaction);
        writeJsonResult(ctx, 'resources-removed', retained, 'retained-package');
        return;
      }
      safeUnlink(ctx, ctx.receiptFile);
      cleanupCommitted = true;
      failAt(ctx, 'backup-cleanup');
      cleanupBackups(ctx, transaction);
      writeJsonResult(ctx, 'absent', null, 'none');
    } catch (error) {
      if (cleanupCommitted) throw postCommitFailure('cleanup', error);
      rollbackLifecycle(ctx, pending, error);
    }
  } finally {
    release();
  }
}

async function statusLifecycle(ctx) {
  const receipt = readReceipt(ctx);
  if (!receipt) {
    const assets = checkUnmanagedAssets(ctx);
    if (assets.configExists || assets.unitExists) conflict('unmanaged STUN config/unit exists without an owner receipt');
    writeJsonResult(ctx, 'absent', null, 'none');
    return;
  }
  if (receipt.state === 'rollback-pending' || ['installing', 'upgrading', 'cleaning'].includes(receipt.state)) {
    hostError(`owner receipt is in incomplete state ${receipt.state}; refusing status claims`);
  }
  if (receipt.state === 'resources-removed') {
    validateReceiptAssets(ctx, receipt);
    if (receipt.packageInstalledByKcoder && receipt.packageManager !== 'test') {
      const version = packageVersion(ctx, receipt.packageManager);
      if (!version) conflict('receipt-owned coturn package is missing');
      if (receipt.packageVersion && version !== receipt.packageVersion) conflict('receipt-owned coturn package version drifted');
      packageDefaultState(ctx, receipt);
    }
    writeStatusResult(ctx, 'resources-removed', receipt, false);
    return;
  }
  validateReceiptAssets(ctx, receipt);
  if (receipt.packageManager !== 'test') {
    const version = packageVersion(ctx, receipt.packageManager);
    if (!version) conflict('coturn package recorded in the owner receipt is missing');
    if (receipt.packageInstalledByKcoder && receipt.packageVersion && version !== receipt.packageVersion) {
      conflict('KCoder-owned coturn package version changed outside the lifecycle manager');
    }
    packageDefaultState(ctx, receipt);
  } else {
    checkTurnserver(ctx);
  }
  const operational = await serviceStatus(ctx, receipt);
  writeStatusResult(ctx, operational.state, receipt, operational.healthy);
}

export async function runStunHostLifecycle(argv = process.argv.slice(2)) {
  let ctx;
  try {
    if (argv[0] !== '--host') usage('host lifecycle must be invoked through stun-host.sh');
    const parsed = parseHostArgs(argv.slice(1));
    ctx = makeContext(parsed);
    if (ctx.namespace && !ctx.isFixture && process.getuid() !== 0) hostError('test namespace requires root');
    if (ctx.action === 'status') await statusLifecycle(ctx);
    else if (ctx.action === 'cleanup') await cleanupLifecycle(ctx);
    else await installOrUpgrade(ctx);
    return 0;
  } catch (error) {
    const code = error instanceof LifecycleError ? error.code : 4;
    process.stderr.write(`${error instanceof LifecycleError ? error.message : `STUN host operation failed: ${error.message}`}\n`);
    return code;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--host') {
  process.exitCode = await runStunHostLifecycle(process.argv.slice(2));
}

async function installOrUpgrade(ctx) {
  let existingReceipt = readReceipt(ctx);
  if (existingReceipt) assertReceiptReady(ctx, existingReceipt, ctx.port, ctx.action);
  else {
    const files = checkUnmanagedAssets(ctx);
    if (ctx.action === 'upgrade' && !files.unitExists) conflict('upgrade requires an owned installation or --adopt-existing assets');
    if (files.unitExists) prepareAdoption(ctx, ctx.port, files, ctx.adoptExisting);
  }

  const release = acquireLock(ctx);
  try {
    existingReceipt = readReceipt(ctx);
    if (existingReceipt) assertReceiptReady(ctx, existingReceipt, ctx.port, ctx.action);
    assertNoUnitDropIns(ctx);
    const fileState = existingReceipt ? { configExists: true, unitExists: true } : checkUnmanagedAssets(ctx);
    const adopted = existingReceipt ? existingReceipt.adoptedExisting : prepareAdoption(ctx, ctx.port, fileState, ctx.adoptExisting);
    if (ctx.action === 'upgrade' && !existingReceipt && !adopted) conflict('upgrade requires an owned installation or explicit adoption');

    const manager = existingReceipt?.packageManager ?? selectPackageManager(ctx);
    const priorPackageVersion = manager === 'test' ? null : packageVersion(ctx, manager);
    let packageOwned = existingReceipt?.packageInstalledByKcoder ?? false;
    let packageVersionBefore = existingReceipt?.packageVersion ?? priorPackageVersion;
    let defaultCoturn = existingReceipt?.defaultCoturn;
    if (!existingReceipt && !ctx.namespace) {
      if (!priorPackageVersion && lstatOrNull(ctx.turnserverFile)) {
        conflict('unmanaged /usr/bin/turnserver exists while the package database reports coturn absent');
      }
      const defaultState = inspectDefaultCoturn(ctx);
      defaultCoturn = { maskOwned: false, priorState: defaultState.priorState };
      if (!priorPackageVersion) {
        packageOwned = true;
        if (defaultState.priorState === 'not-found') defaultCoturn.maskOwned = true;
      }
    } else if (!existingReceipt && ctx.namespace) {
      manager === 'test' || hostError('namespace package manager selection failed');
      packageOwned = false;
      defaultCoturn = { maskOwned: false, priorState: 'masked' };
      checkTurnserver(ctx);
    }
    if (existingReceipt && manager !== 'test') {
      if (!priorPackageVersion) conflict('coturn package disappeared before lifecycle operation');
      if (existingReceipt.packageInstalledByKcoder && existingReceipt.packageVersion !== priorPackageVersion) {
        conflict('KCoder-owned coturn package version changed outside lifecycle manager');
      }
    }
    if (!defaultCoturn) defaultCoturn = { maskOwned: false, priorState: 'not-found' };

    const adoptedInput = adopted && !existingReceipt;
    if (adoptedInput) {
      validateAdoptConfig(fs.readFileSync(ctx.configFile, 'utf8'), ctx.port);
      parseAdoptableUnit(fs.readFileSync(ctx.unitFile, 'utf8'), { configPath: ctx.configLogical, unitName: ctx.unitName });
    }
    const oldService = currentServiceSnapshot(ctx);
    if (ctx.action === 'upgrade' && existingReceipt?.packageInstalledByKcoder && manager !== 'test') {
      const consumers = readOtherTurnConsumers(ctx);
      if (consumers.length) conflict(`coturn package has other consumers; refusing package upgrade: ${consumers.join(', ')}`);
    }
    if (!ctx.isFixture && (!oldService.active
        || (existingReceipt && existingReceipt.port !== ctx.port)
        || (!existingReceipt && !adoptedInput))) {
      inspectPortAvailable(ctx, ctx.port);
    }
    const configText = buildStunConfig({ port: ctx.port, configPath: ctx.configLogical });
    const unitText = buildStunUnit({ configPath: ctx.configLogical, unitName: ctx.unitName });
    validateStunConfig(configText, { port: ctx.port, configPath: ctx.configLogical });
    validateStunUnit(unitText, { configPath: ctx.configLogical, unitName: ctx.unitName });

    const txid = crypto.randomBytes(8).toString('hex');
    const backups = {
      config: backupAsset(ctx, ctx.configFile, 'config', txid),
      unit: backupAsset(ctx, ctx.unitFile, 'unit', txid),
    };
    const transaction = makeTransaction(
      ctx,
      ctx.action,
      previousReceiptClone(existingReceipt),
      backups,
      packageVersionBefore,
      oldService,
    );
    transaction.id = txid;
    const receipt = makeReceipt(ctx, {
      port: ctx.port,
      unitText,
      configText,
      packageManager: manager,
      packageInstalledByKcoder: packageOwned,
      packageVersion: existingReceipt?.packageVersion ?? priorPackageVersion,
      defaultCoturn: { ...defaultCoturn },
      adoptedExisting: existingReceipt?.adoptedExisting ?? Boolean(adoptedInput),
      state: ctx.action === 'upgrade' ? 'upgrading' : 'installing',
      transaction,
    });
    writeReceipt(ctx, receipt);

    let operationCommitted = false;
    try {
      if (!ctx.namespace && !priorPackageVersion && !existingReceipt) {
        if (defaultCoturn.maskOwned) {
          transaction.maskCreated = true;
          writeTransaction(ctx, receipt, 'mask-pending', { maskCreated: true });
          atomicSymlink(ctx, '/dev/null', ctx.maskFile);
          runTool(ctx, 'systemctl', ['daemon-reload']);
          failAt(ctx, 'default-mask');
          writeTransaction(ctx, receipt, 'default-masked');
        }
        transaction.packageAction = 'install-attempted';
        writeTransaction(ctx, receipt, 'package-install-pending', { packageAction: 'install-attempted' });
        runPackageAction(ctx, manager, 'install');
        failAt(ctx, 'package-install');
        checkTurnserver(ctx);
        const installedVersion = packageVersion(ctx, manager);
        if (!installedVersion) hostError('coturn package installation did not produce an installed package');
        receipt.packageInstalledByKcoder = true;
        receipt.packageVersion = installedVersion;
        writeTransaction(ctx, receipt, 'package-installed', { packageAction: 'install-attempted' });
      }

      if (ctx.namespace) checkTurnserver(ctx);
      if (!ctx.namespace && manager !== 'test' && packageVersion(ctx, manager) === null) hostError('coturn package is unavailable');
      const stageDir = path.join(ctx.stateDir, `stage-${txid}`);
      const unitStage = path.join(stageDir, ctx.unitName);
      const configStage = path.join(stageDir, `${ctx.unitName}.conf`);
      checkSystemdSyntax(ctx, stageDir, unitText, unitStage);
      safeAtomicWrite(ctx, configStage, configText, 0o600);
      validateStunConfig(fs.readFileSync(configStage, 'utf8'), { port: ctx.port, configPath: ctx.configLogical });
      failAt(ctx, 'syntax-verify');

      if (ctx.action === 'upgrade' && existingReceipt?.packageInstalledByKcoder) {
        transaction.packageAction = 'upgrade-attempted';
        writeTransaction(ctx, receipt, 'package-upgrade-pending', { packageAction: 'upgrade-attempted' });
        runPackageAction(ctx, manager, 'upgrade');
        failAt(ctx, 'package-upgrade');
        const upgradedVersion = packageVersion(ctx, manager);
        if (!upgradedVersion) hostError('coturn package disappeared during upgrade');
        receipt.packageVersion = upgradedVersion;
        writeTransaction(ctx, receipt, 'package-upgraded', { packageAction: 'upgrade-attempted' });
      }

      safeAtomicWrite(ctx, ctx.configFile, configText, 0o644);
      failAt(ctx, 'config-rename');
      writeTransaction(ctx, receipt, 'config-installed');
      safeAtomicWrite(ctx, ctx.unitFile, unitText, 0o644);
      failAt(ctx, 'unit-rename');
      writeTransaction(ctx, receipt, 'unit-installed');
      runTool(ctx, 'systemctl', ['daemon-reload']);
      failAt(ctx, 'daemon-reload');
      writeTransaction(ctx, receipt, 'daemon-reloaded');
      runTool(ctx, 'systemctl', ['enable', ctx.unitName]);
      failAt(ctx, 'enable');
      writeTransaction(ctx, receipt, 'enabled');
      if (ctx.action === 'upgrade') {
        runTool(ctx, 'systemctl', ['restart', ctx.unitName]);
        failAt(ctx, 'restart');
        writeTransaction(ctx, receipt, 'restarted');
      } else {
        runTool(ctx, 'systemctl', ['start', ctx.unitName]);
        failAt(ctx, 'start');
        writeTransaction(ctx, receipt, 'started');
      }
      failAt(ctx, 'probe');
      await probeStun(ctx, ctx.port);
      const state = assertNoUnitDropIns(ctx);
      if (!state.active || state.enabledState !== 'enabled' || state.fragmentPath !== ctx.unitFile) {
        hostError('dedicated STUN unit did not reach active/enabled state from its owned unit file');
      }
      const committed = makeReceipt(ctx, {
        port: ctx.port,
        unitText,
        configText,
        packageManager: manager,
        packageInstalledByKcoder: receipt.packageInstalledByKcoder,
        packageVersion: receipt.packageVersion,
        defaultCoturn: receipt.defaultCoturn,
        adoptedExisting: receipt.adoptedExisting,
      });
      removeStageBeforeCommit(ctx, stageDir, unitStage, configStage);
      failAt(ctx, 'receipt-commit');
      writeReceipt(ctx, committed);
      operationCommitted = true;
      failAt(ctx, 'backup-cleanup');
      cleanupBackups(ctx, transaction);
      writeJsonResult(ctx, 'active', committed, 'active');
    } catch (error) {
      if (operationCommitted) throw postCommitFailure(ctx.action, error);
      rollbackLifecycle(ctx, receipt, error);
    }
  } finally {
    release();
  }
}
