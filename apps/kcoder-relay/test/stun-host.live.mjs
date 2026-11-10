#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_CONSENT_ENV = 'KCODER_STUN_HOST_LIVE_ACCEPT';
const MAX_LIFECYCLE_STDERR_CHARS = 2048;
const SSH_OPTIONS = [
  '-T',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'ConnectionAttempts=1',
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
  '-o', 'ForwardAgent=no',
];
const HOST_SCRIPT = fileURLToPath(new URL('../deploy/stun-host.sh', import.meta.url));
const HOST_MODULE = fileURLToPath(new URL('../deploy/stun-lifecycle.mjs', import.meta.url));
const STAGE_FILES = [
  ['deploy/stun-host.sh', HOST_SCRIPT],
  ['deploy/stun-lifecycle.mjs', HOST_MODULE],
];
const PRODUCTION_UNITS = [
  'kcoder-relay.service',
  'caddy.service',
  'kcoder-stun.service',
  'myapp.service',
];
const SNAPSHOT_UNITS = [...PRODUCTION_UNITS, 'coturn.service'];

export const SNAPSHOT_PY = String.raw`
import hashlib, json, os, re, subprocess

def run(args):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, check=False, timeout=10)
        return result.returncode, result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 127, ''

def prop(unit, name):
    code, value = run(['systemctl', 'show', '--property=' + name, '--value', unit])
    return value if code == 0 and value else None

def file_state(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    state = {'type': 'symlink' if os.path.islink(path) else ('file' if os.path.isfile(path) else 'other'),
             'mode': format(info.st_mode & 0o7777, '04o'), 'uid': info.st_uid,
             'links': info.st_nlink}
    if os.path.islink(path):
        state['linkTarget'] = os.readlink(path)
    try:
        with open(path, 'rb') as source:
            digest = hashlib.sha256()
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        state['sha256'] = digest.hexdigest()
    except (OSError, IsADirectoryError):
        state['sha256'] = None
    return state

def referenced_paths(raw):
    if not raw:
        return []
    return sorted(set(re.findall(r'(?<![^\s(])(/[A-Za-z0-9_./@+=:-]+)', raw)))

units = {}
expected_units = ${JSON.stringify(SNAPSHOT_UNITS)}
required_unit_fields = ('LoadState', 'ActiveState', 'SubState', 'MainPID', 'UnitFileState',
                        'FragmentPath', 'DropInPaths', 'EnvironmentFiles')
config_paths = {
    '/etc/caddy/Caddyfile',
    '/etc/kcoder-relay.env',
    '/etc/kcoder-relay-registry.json',
    '/etc/coturn/kcoder-stun.conf',
    '/etc/coturn/turnserver.conf',
    '/etc/turnserver.conf',
    '/etc/myapp/myapp.conf',
    '/etc/myapp/.env',
}
for name in expected_units:
    fields = {key: prop(name, key) for key in
              required_unit_fields}
    units[name] = fields
    for key in ('FragmentPath', 'DropInPaths', 'EnvironmentFiles'):
        config_paths.update(referenced_paths(fields.get(key)))

if set(units) != set(expected_units):
    raise RuntimeError('production unit snapshot is incomplete')
load_states = {'stub', 'loaded', 'not-found', 'bad-setting', 'error', 'merged', 'masked'}
active_states = {'active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating',
                 'maintenance', 'refreshing'}
for unit in expected_units:
    fields = units[unit]
    if set(fields) != set(required_unit_fields) or any(
            value is not None and not isinstance(value, str) for value in fields.values()):
        raise RuntimeError('production unit snapshot has invalid fields')
    if fields['LoadState'] not in load_states or fields['ActiveState'] not in active_states:
        raise RuntimeError('production unit snapshot has an invalid systemd state')
    if not fields['MainPID'] or not fields['MainPID'].isdigit():
        raise RuntimeError('production unit snapshot has an invalid MainPID')

package_states = {}
code, value = run(['dpkg-query', '-W', '-f=\x24{db:Status-Status}', 'coturn'])
package_states['dpkg'] = code == 0 and value == 'installed'
code, value = run(['rpm', '-q', 'coturn'])
package_states['rpm'] = code == 0 and value.startswith('coturn-')
package_versions = {}
code, value = run(['dpkg-query', '-W', '-f=\x24{Version}', 'coturn'])
package_versions['dpkg'] = value if package_states['dpkg'] and code == 0 else None
code, value = run(['rpm', '-q', '--qf', '%{NEVRA}', 'coturn'])
package_versions['rpm'] = value if package_states['rpm'] and code == 0 else None

enabled_code, enabled_value = run(['systemctl', 'is-enabled', 'coturn.service'])
active_code, active_value = run(['systemctl', 'is-active', 'coturn.service'])
default_unit = {
    'isEnabled': enabled_value if enabled_code == 0 or enabled_value else 'not-found',
    'isActive': active_value if active_code == 0 or active_value else 'not-found',
    'maskPath': file_state('/etc/systemd/system/coturn.service'),
}
print(json.dumps({
    'units': units,
    'unitConfigFiles': {path: file_state(path) for path in sorted(config_paths)},
    'coturnPackage': package_states,
    'coturnPackageVersion': package_versions,
    'defaultCoturnUnit': default_unit,
}, sort_keys=True, separators=(',', ':')))
`;

const NODE_PREFLIGHT_PY = String.raw`
import json, os, re, shutil, stat, subprocess

def safe_node(candidate):
    if not candidate or not os.path.isabs(candidate):
        return None
    resolved = os.path.realpath(candidate)
    try:
        info = os.stat(resolved)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or not (info.st_mode & 0o111) or (info.st_mode & 0o022):
        return None
    current = os.path.dirname(resolved)
    while current != '/':
        try:
            directory = os.stat(current)
        except OSError:
            return None
        if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or (directory.st_mode & 0o022):
            return None
        current = os.path.dirname(current)
    try:
        result = subprocess.run([resolved, '--version'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, check=False, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', result.stdout.strip())
    if result.returncode != 0 or not match or int(match.group(1)) < 18:
        return None
    return {'path': resolved, 'version': result.stdout.strip()}

candidates = ['/opt/kcoder-relay/runtime/node', '/usr/bin/node', shutil.which('node')]
for candidate in candidates:
    result = safe_node(candidate)
    if result:
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        raise SystemExit(0)
print(json.dumps({'error': 'no safe Node.js 18+ executable'}))
raise SystemExit(1)
`;

const NAMESPACE_PREFLIGHT_PY = String.raw`
import json, os, socket, subprocess, sys
namespace = sys.argv[1]
port = int(sys.argv[2])
unit = 'kcoder-stun-test-' + namespace + '.service'
paths = [
    '/etc/systemd/system/' + unit,
    '/etc/coturn/kcoder-stun-test-' + namespace + '.conf',
    '/var/lib/kcoder-relay-stun-test-' + namespace,
    '/var/tmp/kcoder-stun-test-' + namespace,
    '/run/kcoder-stun-test-' + namespace,
]
try:
    for entry in os.scandir('/etc/systemd/system'):
        if entry.name.endswith(('.wants', '.requires')) and entry.is_dir(follow_symlinks=True):
            paths.append(os.path.join(entry.path, unit))
except OSError:
    print(json.dumps({'absent': False, 'error': 'cannot inspect systemd enablement paths'}, separators=(',', ':')))
    raise SystemExit(0)
existing = [path for path in paths if os.path.lexists(path)]
if existing:
    print(json.dumps({'absent': False, 'existing': existing}, sort_keys=True, separators=(',', ':')))
    raise SystemExit(0)
try:
    result = subprocess.run(['ss', '-Hlun', 'sport = :' + str(port)], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, check=False, timeout=5)
    if result.returncode == 0:
        available = not result.stdout.strip()
    else:
        available = None
except (OSError, subprocess.TimeoutExpired):
    available = None
if available is None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(('0.0.0.0', port))
        available = True
    except OSError:
        available = False
    finally:
        sock.close()
print(json.dumps({'absent': True, 'portAvailable': available}, sort_keys=True, separators=(',', ':')))
`;

const NAMESPACE_PATHS_PY = String.raw`
import json, os, sys
namespace = sys.argv[1]
unit = 'kcoder-stun-test-' + namespace + '.service'
paths = {
    'unit': '/etc/systemd/system/' + unit,
    'config': '/etc/coturn/kcoder-stun-test-' + namespace + '.conf',
    'ownerState': '/var/lib/kcoder-relay-stun-test-' + namespace,
    'runtime': '/run/kcoder-stun-test-' + namespace,
}
try:
    links = [os.path.join(entry.path, unit) for entry in os.scandir('/etc/systemd/system')
             if entry.name.endswith(('.wants', '.requires')) and entry.is_dir(follow_symlinks=True)]
    enablement_links_absent = not any(os.path.lexists(path) for path in links)
except OSError:
    enablement_links_absent = False
result = {key: not os.path.lexists(path) for key, path in paths.items()}
result['enablementLinks'] = enablement_links_absent
print(json.dumps(result,
                 sort_keys=True, separators=(',', ':')))
`;

const STAGE_CREATE_PY = String.raw`
import base64, hashlib, json, os, stat
created_root = False
created_deploy = False
written = []
root_identity = None
deploy_identity = None
expected = {name: hashlib.sha256(base64.b64decode(data)).hexdigest() for name, data in files.items()}
if set(files) != {'deploy/stun-host.sh', 'deploy/stun-lifecycle.mjs'}:
    raise RuntimeError('unexpected staged file set')

def owned_directory(path, identity=None):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or (info.st_mode & 0o7777) != 0o700:
        raise RuntimeError('stage directory ownership or mode mismatch')
    if identity and (info.st_dev != identity['device'] or info.st_ino != identity['inode']):
        raise RuntimeError('stage directory identity changed')
    return info

try:
    os.mkdir(root, 0o700)
    created_root = True
    root_info = os.lstat(root)
    root_identity = {'device': root_info.st_dev, 'inode': root_info.st_ino}
    os.chown(root, owner_uid, -1)
    os.chmod(root, 0o700)
    root_info = owned_directory(root)
    deploy = os.path.join(root, 'deploy')
    os.mkdir(deploy, 0o700)
    created_deploy = True
    deploy_info = os.lstat(deploy)
    deploy_identity = {'device': deploy_info.st_dev, 'inode': deploy_info.st_ino}
    os.chown(deploy, owner_uid, -1)
    os.chmod(deploy, 0o700)
    deploy_info = owned_directory(deploy)
    for relative, encoded in files.items():
        if relative not in ('deploy/stun-host.sh', 'deploy/stun-lifecycle.mjs'):
            raise RuntimeError('unexpected staged file')
        path = os.path.join(root, relative)
        data = base64.b64decode(encoded, validate=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, 'O_NOFOLLOW'):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        opened = os.fstat(descriptor)
        written.append((path, {'device': opened.st_dev, 'inode': opened.st_ino}))
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(descriptor, view):]
            os.fchown(descriptor, owner_uid, -1)
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        info = os.lstat(path)
        files[relative] = {'sha256': expected[relative], 'device': info.st_dev, 'inode': info.st_ino,
                           'uid': info.st_uid, 'mode': format(info.st_mode & 0o7777, '04o'),
                           'links': info.st_nlink}
    result = {'root': {'device': root_info.st_dev, 'inode': root_info.st_ino},
              'deploy': {'device': deploy_info.st_dev, 'inode': deploy_info.st_ino},
              'files': files}
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
except Exception:
    for path, identity in written:
        try:
            info = os.lstat(path)
            if (stat.S_ISREG(info.st_mode) and info.st_uid == owner_uid and info.st_nlink == 1 and
                    info.st_dev == identity['device'] and info.st_ino == identity['inode']):
                os.unlink(path)
        except OSError:
            pass
    if created_deploy:
        try:
            owned_directory(os.path.join(root, 'deploy'), deploy_identity)
            os.rmdir(os.path.join(root, 'deploy'))
        except OSError:
            pass
    if created_root:
        try:
            owned_directory(root, root_identity)
            os.rmdir(root)
        except OSError:
            pass
    raise
`;

const STAGE_CLEANUP_PY = String.raw`
import hashlib, json, os, stat, sys
root = sys.argv[1]
identity = json.loads(sys.argv[2])
expected = json.loads(sys.argv[3])
owner_uid = int(sys.argv[4])

def check_directory(path, wanted):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or (info.st_mode & 0o7777) != 0o700:
        raise RuntimeError('directory ownership mismatch')
    if info.st_dev != wanted['device'] or info.st_ino != wanted['inode']:
        raise RuntimeError('directory identity mismatch')

try:
    check_directory(root, identity['root'])
    deploy = os.path.join(root, 'deploy')
    check_directory(deploy, identity['deploy'])
    if set(os.listdir(root)) != {'deploy'} or set(os.listdir(deploy)) != {os.path.basename(path) for path in expected}:
        raise RuntimeError('unexpected stage entries')
    for relative, wanted in expected.items():
        path = os.path.join(root, relative)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or info.st_nlink != 1 or (info.st_mode & 0o7777) != 0o600:
            raise RuntimeError('stage file ownership mismatch')
        if info.st_uid != wanted['uid'] or format(info.st_mode & 0o7777, '04o') != wanted['mode'] or info.st_nlink != wanted['links']:
            raise RuntimeError('stage file attributes changed')
        if info.st_dev != wanted['device'] or info.st_ino != wanted['inode']:
            raise RuntimeError('stage file identity mismatch')
        actual = hashlib.sha256()
        with open(path, 'rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                actual.update(block)
        if actual.hexdigest() != wanted['sha256']:
            raise RuntimeError('stage file hash mismatch')
    for relative in expected:
        os.unlink(os.path.join(root, relative))
    os.rmdir(deploy)
    check_directory(root, identity['root'])
    os.rmdir(root)
    print(json.dumps({'removed': True}, sort_keys=True, separators=(',', ':')))
except Exception:
    print(json.dumps({'removed': False, 'reason': 'ownership_or_hash_check_failed'},
                     sort_keys=True, separators=(',', ':')))
`;

function usage() {
  return `Usage: ${process.argv[1]} --host SSH_TARGET --port UDP_PORT --namespace 12HEX\n` +
    `Set ${LIVE_CONSENT_ENV}=1 to authorize the live acceptance run.`;
}

export function parseLiveOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!['--host', '--port', '--namespace'].includes(flag) || values[flag]) {
      throw new Error('Invalid or duplicate live acceptance option');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) throw new Error('Missing live acceptance option value');
    values[flag] = value;
    index += 1;
  }
  if (!values['--host'] || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,252}$/.test(values['--host'])) {
    throw new Error('A valid SSH host or alias is required');
  }
  if (!values['--port'] || !/^\d{1,5}$/.test(values['--port'])) {
    throw new Error('A numeric UDP port is required');
  }
  const port = Number(values['--port']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('UDP port must be between 1024 and 65535');
  if (!values['--namespace'] || !/^[a-f0-9]{12}$/.test(values['--namespace'])) {
    throw new Error('Namespace must be 12 lowercase hexadecimal characters');
  }
  return { help: false, host: values['--host'], port, namespace: values['--namespace'] };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function lifecycleSshFailureDetails(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const raw = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr || '');
  const cleaned = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  const truncated = cleaned.length > MAX_LIFECYCLE_STDERR_CHARS;
  const stderr = truncated ? cleaned.slice(-MAX_LIFECYCLE_STDERR_CHARS) : cleaned;
  return {
    exitStatus: status,
    ...(stderr ? { stderr, stderrTruncated: truncated } : {}),
  };
}

function remoteCommand(host, command, { input, timeout = 60_000, captureStderr = false } = {}) {
  try {
    return execFileSync('ssh', [...SSH_OPTIONS, host, command], {
      input,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failure = new Error('SSH transport or remote command failed');
    if (captureStderr) failure.lifecycleDiagnostic = lifecycleSshFailureDetails(error);
    throw failure;
  }
}

function remotePython(host, source, args = [], { timeout = 60_000 } = {}) {
  const command = ['sudo', '-n', 'python3', '-', ...args.map(shellQuote)].join(' ');
  const output = remoteCommand(host, command, { input: source, timeout });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Remote Python probe did not return one JSON object');
  }
}

function lifecycle(host, stagePath, action, namespace, port) {
  const script = `${stagePath}/deploy/stun-host.sh`;
  const args = [action];
  if (action === 'install' || action === 'upgrade') args.push('--port', String(port));
  args.push('--test-namespace', namespace);
  const command = ['sudo', '-n', 'bash', shellQuote(script), ...args.map(shellQuote)].join(' ');
  let output;
  try {
    output = remoteCommand(host, command, { timeout: 120_000, captureStderr: true });
  } catch (error) {
    error.message = 'Remote STUN lifecycle command failed';
    throw error;
  }
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('Remote lifecycle did not return exactly one JSON line');
  let result;
  try {
    result = JSON.parse(lines[0]);
  } catch {
    throw new Error('Remote lifecycle returned invalid JSON');
  }
  if (!result || result.component !== 'stun' || result.action !== action || typeof result.state !== 'string') {
    throw new Error('Remote lifecycle returned an unexpected result schema');
  }
  return result;
}

export function makeStagePayload() {
  const buffers = Object.fromEntries(STAGE_FILES.map(([relative, path]) => [relative, readFileSync(path)]));
  return {
    files: Object.fromEntries(Object.entries(buffers).map(([relative, bytes]) => [relative, bytes.toString('base64')])),
    hashes: Object.fromEntries(Object.entries(buffers).map(([relative, bytes]) => [relative, sha256(bytes)])),
  };
}

export function buildStageCreateProgram(stagePath, files, ownerUid = 0) {
  if (!Number.isSafeInteger(Number(ownerUid)) || Number(ownerUid) < 0) throw new Error('Invalid stage owner');
  const prefix = `import json\nroot = ${JSON.stringify(stagePath)}\nfiles = json.loads(${JSON.stringify(JSON.stringify(files))})\nowner_uid = ${Number(ownerUid)}\n`;
  return prefix + STAGE_CREATE_PY;
}

function stageDirectory(namespace) {
  return `/var/tmp/kcoder-stun-test-${namespace}`;
}

function createRemoteStage(host, stagePath, payload) {
  const output = remoteCommand(host, 'sudo -n python3 -', {
    input: buildStageCreateProgram(stagePath, payload.files, 0),
    timeout: 60_000,
  });
  let identity;
  try {
    identity = JSON.parse(output);
  } catch {
    throw new Error('Remote stage creation did not return one JSON object');
  }
  return identity;
}

function assertStageReceipt(identity, payload) {
  if (!identity?.root || !identity?.deploy || !identity?.files || Object.keys(identity.files).length !== STAGE_FILES.length) {
    throw new Error('Remote stage ownership receipt is incomplete');
  }
  for (const [relative, expectedHash] of Object.entries(payload.hashes)) {
    const file = identity.files[relative];
    if (!file || file.sha256 !== expectedHash || file.uid !== 0 || file.mode !== '0600' || file.links !== 1 ||
        !Number.isInteger(file.device) || !Number.isInteger(file.inode)) {
      throw new Error('Remote stage file hash or ownership receipt did not match');
    }
  }
}

export function buildStageCleanupInvocation(stagePath, identity, ownerUid = 0) {
  if (!Number.isSafeInteger(Number(ownerUid)) || Number(ownerUid) < 0) throw new Error('Invalid stage owner');
  const identityJson = JSON.stringify(identity);
  const filesJson = JSON.stringify(identity.files);
  return {
    source: STAGE_CLEANUP_PY,
    args: [stagePath, identityJson, filesJson, String(Number(ownerUid))],
  };
}

function cleanupRemoteStage(host, stagePath, identity) {
  const invocation = buildStageCleanupInvocation(stagePath, identity, 0);
  const command = `sudo -n python3 - ${invocation.args.map(shellQuote).join(' ')}`;
  const output = remoteCommand(host, command, { input: invocation.source, timeout: 30_000 });
  const result = JSON.parse(output);
  return { ...result, fileCount: Object.keys(identity.files).length };
}

function assertLifecycle(result, { action, state, namespace, port }) {
  if (result.state !== state) throw new Error(`Lifecycle ${action} did not reach ${state}`);
  if (result.unit !== `kcoder-stun-test-${namespace}.service`) throw new Error(`Lifecycle ${action} returned the wrong unit`);
  if (result.config !== `/etc/coturn/kcoder-stun-test-${namespace}.conf`) throw new Error(`Lifecycle ${action} returned the wrong config`);
  if (result.packageManager !== 'test' || result.packageInstalledByKcoder !== false) {
    throw new Error(`Lifecycle ${action} reported unexpected package ownership`);
  }
  if (action === 'install' || action === 'upgrade') {
    if (result.port !== port || result.receiptState !== 'active') {
      throw new Error(`Lifecycle ${action} did not preserve isolated package ownership`);
    }
  } else {
    const expectedReceiptState = state === 'absent' ? 'none' : state;
    if (result.receiptState !== expectedReceiptState) {
      throw new Error(`Lifecycle ${action} did not report receipt state ${expectedReceiptState}`);
    }
  }
}

function makeUdpProbe(port) {
  // Prove the isolated listener answers Binding before and after a TURN-only request.
  return String.raw`
import ipaddress, json, os, socket, struct
MAGIC = 0x2112A442
MAGIC_BYTES = struct.pack('!I', MAGIC)
PORT = ${port}
TIMEOUT = 3.0

def transact(message_type, attributes=b''):
    transaction_id = os.urandom(12)
    request = struct.pack('!HHI12s', message_type, len(attributes), MAGIC, transaction_id) + attributes
    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    client.settimeout(TIMEOUT)
    try:
        client.sendto(request, ('127.0.0.1', PORT))
        packet, _ = client.recvfrom(2048)
    finally:
        client.close()
    if len(packet) < 20:
        raise ValueError('short STUN response')
    response_type, length, cookie, response_id = struct.unpack('!HHI12s', packet[:20])
    if cookie != MAGIC or response_id != transaction_id or len(packet) != 20 + length:
        raise ValueError('STUN cookie, transaction id, or length mismatch')
    attrs = []
    offset = 20
    while offset < len(packet):
        if offset + 4 > len(packet):
            raise ValueError('truncated STUN attribute header')
        kind, size = struct.unpack('!HH', packet[offset:offset + 4])
        start = offset + 4
        end = start + size
        padded_end = start + ((size + 3) & ~3)
        if end > len(packet) or padded_end > len(packet):
            raise ValueError('truncated STUN attribute value')
        attrs.append((kind, packet[start:end]))
        offset = padded_end
    return transaction_id, response_type, attrs

def binding():
    transaction_id, response_type, attrs = transact(0x0001)
    if response_type != 0x0101:
        raise ValueError('STUN Binding did not return success')
    xor = next((value for kind, value in attrs if kind == 0x0020), None)
    if xor is None or len(xor) not in (8, 20):
        raise ValueError('STUN Binding response lacks a valid XOR-MAPPED-ADDRESS')
    family = xor[1]
    mapped_port = struct.unpack('!H', xor[2:4])[0] ^ (MAGIC >> 16)
    if not 1 <= mapped_port <= 65535:
        raise ValueError('XOR-MAPPED-ADDRESS port is invalid')
    if family == 1 and len(xor) == 8:
        mapped_bytes = bytes(a ^ b for a, b in zip(xor[4:8], MAGIC_BYTES))
    elif family == 2 and len(xor) == 20:
        mask = MAGIC_BYTES + transaction_id
        mapped_bytes = bytes(a ^ b for a, b in zip(xor[4:20], mask))
    else:
        raise ValueError('XOR-MAPPED-ADDRESS family and length mismatch')
    ipaddress.ip_address(mapped_bytes)
    return {'state': 'success', 'cookieValidated': True,
            'transactionIdValidated': True, 'xorMappedAddressValidated': True,
            'addressFamily': 'ipv4' if family == 1 else 'ipv6'}

binding_before = binding()
requested_transport = struct.pack('!HH', 0x0019, 4) + bytes((17, 0, 0, 0))
try:
    _, allocate_type, allocate_attrs = transact(0x0003, requested_transport)
except socket.timeout:
    allocate = {'state': 'ignored', 'success': False}
else:
    if allocate_type == 0x0103:
        raise ValueError('TURN Allocate unexpectedly succeeded')
    if allocate_type != 0x0113:
        raise ValueError('TURN Allocate did not return a STUN error response')
    error_attr = next((value for kind, value in allocate_attrs if kind == 0x0009), None)
    if error_attr is None or len(error_attr) < 4 or error_attr[0:2] != b'\x00\x00' or error_attr[2] & 0xF8:
        raise ValueError('TURN Allocate rejection lacks a valid ERROR-CODE')
    error_code = (error_attr[2] & 0x07) * 100 + error_attr[3]
    if error_code < 400 or error_code > 699:
        raise ValueError('TURN Allocate rejection has an invalid ERROR-CODE')
    allocate = {'state': 'rejected', 'success': False, 'errorCode': error_code,
                'cookieValidated': True, 'transactionIdValidated': True}

binding_after = binding()
result = {'bindingBefore': binding_before, 'turnAllocate': allocate, 'bindingAfter': binding_after}
print(json.dumps(result,
                 sort_keys=True, separators=(',', ':')))
`;
}

function parsePid(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function readUnitPid(host, unit) {
  const code = `import json, subprocess\n` +
    `p=subprocess.run(['systemctl','show','--property=MainPID','--value',${JSON.stringify(unit)}],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)\n` +
    `print(json.dumps({'mainPid':p.stdout.strip() if p.returncode == 0 else None},separators=(',',':')))\n`;
  return remotePython(host, code).mainPid;
}

function assertNamespaceAbsent(paths) {
  if (!paths || Object.values(paths).some(value => value !== true)) {
    throw new Error('Namespace resources remain after cleanup');
  }
}

export function sharedCoturnUnchanged(before, after) {
  return JSON.stringify(before?.coturnPackage) === JSON.stringify(after?.coturnPackage) &&
    JSON.stringify(before?.coturnPackageVersion) === JSON.stringify(after?.coturnPackageVersion) &&
    JSON.stringify(before?.units?.['coturn.service']) === JSON.stringify(after?.units?.['coturn.service']) &&
    JSON.stringify(before?.defaultCoturnUnit) === JSON.stringify(after?.defaultCoturnUnit);
}

function remoteStageAbsent(host, stagePath) {
  const code = `import json, os\np=${JSON.stringify(stagePath)}\nprint(json.dumps({'absent': not os.path.lexists(p)},separators=(',',':')))\n`;
  return remotePython(host, code).absent === true;
}

function runAcceptance(options) {
  const { host, port, namespace } = options;
  const stagePath = stageDirectory(namespace);
  const report = {
    component: 'stun-live-acceptance',
    state: 'running',
    host,
    port,
    namespace,
    consent: 'explicit',
    stages: {},
  };
  const payload = makeStagePayload();
  let stageIdentity;
  let lifecycleMayExist = false;
  let stageAttempted = false;
  let phase = 'preflight';
  let failure;
  let protocolComplete = false;

  try {
    const before = remotePython(host, SNAPSHOT_PY);
    report.stages.productionBefore = before;
    if (!Object.values(before.coturnPackage || {}).some(Boolean)) {
      throw new Error('coturn package must already be installed');
    }
    for (const [manager, installed] of Object.entries(before.coturnPackage)) {
      if (installed && typeof before.coturnPackageVersion?.[manager] !== 'string') {
        throw new Error(`coturn ${manager} package version could not be recorded`);
      }
    }
    const node = remotePython(host, NODE_PREFLIGHT_PY);
    report.stages.remoteNode = node;
    const namespacePreflight = remotePython(host, NAMESPACE_PREFLIGHT_PY, [namespace, String(port)]);
    report.stages.namespacePreflight = namespacePreflight;
    if (!namespacePreflight.absent) throw new Error('Namespace paths already exist; choose a fresh namespace');
    if (!namespacePreflight.portAvailable) throw new Error('Requested UDP port is already in use');

    phase = 'stage';
    stageAttempted = true;
    stageIdentity = createRemoteStage(host, stagePath, payload);
    assertStageReceipt(stageIdentity, payload);
    report.stages.remoteStage = {
      path: stagePath,
      root: stageIdentity.root,
      deploy: stageIdentity.deploy,
      fileSha256: payload.hashes,
    };

    phase = 'initial-status';
    const initialStatus = lifecycle(host, stagePath, 'status', namespace);
    assertLifecycle(initialStatus, { action: 'status', state: 'absent', namespace, port });
    report.stages.initialStatus = initialStatus;

    phase = 'install';
    lifecycleMayExist = true;
    const installed = lifecycle(host, stagePath, 'install', namespace, port);
    assertLifecycle(installed, { action: 'install', state: 'active', namespace, port });
    report.stages.install = installed;

    phase = 'udp-probe';
    const udpProbe = remotePython(host, makeUdpProbe(port), [], { timeout: 15_000 });
    report.stages.udpProbe = udpProbe;
    for (const binding of [udpProbe.bindingBefore, udpProbe.bindingAfter]) {
      if (binding?.state !== 'success' || binding.cookieValidated !== true ||
          binding.transactionIdValidated !== true || binding.xorMappedAddressValidated !== true) {
        throw new Error('UDP STUN Binding verification failed');
      }
    }
    if (udpProbe.turnAllocate?.success !== false ||
        !['ignored', 'rejected'].includes(udpProbe.turnAllocate?.state)) {
      throw new Error('TURN Allocate did not remain unsuccessful');
    }
    if (udpProbe.turnAllocate.state === 'rejected' &&
        (udpProbe.turnAllocate.cookieValidated !== true || udpProbe.turnAllocate.transactionIdValidated !== true ||
         !Number.isInteger(udpProbe.turnAllocate.errorCode) || udpProbe.turnAllocate.errorCode < 400 || udpProbe.turnAllocate.errorCode > 699)) {
      throw new Error('TURN Allocate error response was invalid');
    }

    phase = 'status-before-upgrade';
    const beforeUpgradeStatus = lifecycle(host, stagePath, 'status', namespace);
    assertLifecycle(beforeUpgradeStatus, { action: 'status', state: 'active', namespace, port });
    report.stages.statusBeforeUpgrade = beforeUpgradeStatus;
    const pidBeforeUpgrade = readUnitPid(host, `kcoder-stun-test-${namespace}.service`);

    phase = 'upgrade';
    const upgraded = lifecycle(host, stagePath, 'upgrade', namespace, port);
    assertLifecycle(upgraded, { action: 'upgrade', state: 'active', namespace, port });
    const pidAfterUpgrade = readUnitPid(host, `kcoder-stun-test-${namespace}.service`);
    report.stages.upgrade = { result: upgraded, mainPidBefore: parsePid(pidBeforeUpgrade), mainPidAfter: parsePid(pidAfterUpgrade) };
    if (!parsePid(pidBeforeUpgrade) || !parsePid(pidAfterUpgrade) || parsePid(pidBeforeUpgrade) === parsePid(pidAfterUpgrade)) {
      throw new Error('Upgrade did not replace the isolated service process');
    }

    phase = 'status-after-upgrade';
    const afterUpgradeStatus = lifecycle(host, stagePath, 'status', namespace);
    assertLifecycle(afterUpgradeStatus, { action: 'status', state: 'active', namespace, port });
    report.stages.statusAfterUpgrade = afterUpgradeStatus;
    protocolComplete = true;
    phase = 'cleanup';
  } catch (error) {
    failure = { phase, message: error.message || 'acceptance phase failed' };
    if (error.lifecycleDiagnostic) failure.remote = error.lifecycleDiagnostic;
  } finally {
    let namespaceCleanupConfirmed = false;
    if (lifecycleMayExist && stageIdentity) {
      try {
        const cleaned = lifecycle(host, stagePath, 'cleanup', namespace);
        report.stages.cleanup = cleaned;
        assertLifecycle(cleaned, { action: 'cleanup', state: 'absent', namespace, port });
        const paths = remotePython(host, NAMESPACE_PATHS_PY, [namespace]);
        assertNamespaceAbsent(paths);
        report.stages.namespacePathsAbsent = paths;
        namespaceCleanupConfirmed = true;
        lifecycleMayExist = false;
      } catch (error) {
        report.cleanupConfirmed = false;
        report.cleanupError = 'namespace_cleanup_or_absence_check_failed';
        if (error?.lifecycleDiagnostic) report.cleanupErrorRemote = error.lifecycleDiagnostic;
      }
    } else {
      try {
        const paths = remotePython(host, NAMESPACE_PATHS_PY, [namespace]);
        assertNamespaceAbsent(paths);
        report.stages.namespacePathsAbsent = paths;
        namespaceCleanupConfirmed = true;
      } catch {
        report.cleanupConfirmed = false;
        report.cleanupError = 'namespace_absence_check_failed';
      }
    }

    if (stageIdentity && namespaceCleanupConfirmed) {
      try {
        const cleanup = cleanupRemoteStage(host, stagePath, stageIdentity);
        report.remoteStageCleanup = cleanup;
        if (!cleanup.removed || !remoteStageAbsent(host, stagePath)) {
          report.remoteStageCleanup = { removed: false, reason: 'owned_stage_cleanup_not_confirmed' };
          report.cleanupConfirmed = false;
        } else {
          report.stages.remoteStageAbsent = true;
          report.cleanupConfirmed = true;
          stageIdentity = undefined;
        }
      } catch {
        report.remoteStageCleanup = { removed: false, reason: 'owner_hash_or_transport_check_failed' };
        report.cleanupConfirmed = false;
      }
    } else if (stageAttempted && !stageIdentity) {
      try {
        report.stages.remoteStageAbsent = remoteStageAbsent(host, stagePath);
        if (!report.stages.remoteStageAbsent) {
          report.cleanupConfirmed = false;
          report.cleanupError = 'stage_creation_rollback_not_confirmed';
        } else {
          report.cleanupConfirmed = namespaceCleanupConfirmed;
        }
      } catch {
        report.stages.remoteStageAbsent = false;
        report.cleanupConfirmed = false;
        report.cleanupError = 'stage_absence_check_failed';
      }
    } else if (stageIdentity && !namespaceCleanupConfirmed) {
      report.remoteStageCleanup = { removed: false, reason: 'namespace_cleanup_not_confirmed' };
      report.cleanupConfirmed = false;
    }

    if (report.stages.productionBefore) {
      try {
        const after = remotePython(host, SNAPSHOT_PY);
        report.stages.productionAfter = after;
        const before = report.stages.productionBefore;
        report.productionFingerprintEqual = JSON.stringify(before) === JSON.stringify(after);
        report.sharedCoturnUnchanged = sharedCoturnUnchanged(before, after);
      } catch {
        report.productionFingerprintEqual = false;
        report.sharedCoturnUnchanged = false;
      }
    }
  }

  if (failure) report.error = failure;
  if (failure) {
    report.state = 'failed';
  } else if (report.cleanupConfirmed !== true || report.productionFingerprintEqual !== true ||
      report.sharedCoturnUnchanged !== true || !protocolComplete) {
    report.state = report.productionFingerprintEqual === false && report.cleanupConfirmed === true
      ? 'inconclusive'
      : 'failed';
    if (!report.error && report.productionFingerprintEqual === false) {
      report.error = { phase: 'final-fingerprint', message: 'Production fingerprint changed during acceptance' };
    } else if (!report.error && report.cleanupConfirmed !== true) {
      report.error = { phase: 'cleanup', message: report.cleanupError || 'Owned cleanup was not confirmed' };
    }
  } else {
    report.state = 'passed';
  }
  return report;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseLiveOptions(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ component: 'stun-live-acceptance', state: 'failed', error: error.message })}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (env[LIVE_CONSENT_ENV] !== '1') {
    process.stdout.write(`${JSON.stringify({
      component: 'stun-live-acceptance',
      state: 'blocked',
      code: 'LIVE_CONSENT_REQUIRED',
      requiredEnv: LIVE_CONSENT_ENV,
      host: options.host,
      port: options.port,
      namespace: options.namespace,
    })}\n`);
    return 2;
  }
  let result;
  try {
    result = runAcceptance(options);
  } catch (error) {
    result = {
      component: 'stun-live-acceptance',
      state: 'failed',
      host: options.host,
      port: options.port,
      namespace: options.namespace,
      consent: 'explicit',
      error: { phase: 'local-preflight', message: error.message || 'local preflight failed' },
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.state === 'passed' ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
