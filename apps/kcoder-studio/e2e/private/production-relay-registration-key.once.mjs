import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const SSH_ARGS = [
  "-T", "-F", "/home/hyf/.ssh/config",
  "-o", "UserKnownHostsFile=/home/hyf/.ssh/known_hosts",
  "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
  "-o", "ControlMaster=no", "-o", "ControlPath=none",
  "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
  "-o", "LogLevel=ERROR", "aliyun", "sudo", "-n", "python3", "-",
];

const REMOTE_PYTHON_REGISTRATION_KEY = String.raw`import hashlib, os, pathlib, re, subprocess, sys
def fail(code): sys.exit(code)
try:
    unit = subprocess.run(['/usr/bin/systemctl','show','kcoder-relay.service','--property=LoadState','--property=ActiveState','--property=MainPID'], capture_output=True, timeout=3, check=True, text=True).stdout
    fields = dict(line.split('=',1) for line in unit.splitlines() if '=' in line)
    pid = int(fields.get('MainPID','0'))
    if fields.get('LoadState') != 'loaded' or fields.get('ActiveState') != 'active' or pid <= 0: fail(41)
    proc = pathlib.Path('/proc') / str(pid)
    status = (proc/'status').read_text()
    uid = next((int(line.split()[2]) for line in status.splitlines() if line.startswith('Uid:')), -1)
    if uid != 995: fail(42)
    exe = os.path.realpath(proc/'exe')
    argv = [os.fsdecode(x) for x in (proc/'cmdline').read_bytes().split(b'\0') if x]
    scripts = [x for x in argv if x == '/opt/kcoder-relay/src/server.mjs']
    if not exe.endswith('/node') or len(scripts) != 1: fail(43)
    config = pathlib.Path(scripts[0]).with_name('config.mjs')
    if not config.is_file() or hashlib.sha256(config.read_bytes()).hexdigest() != 'b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335': fail(44)
    env = {}
    for item in (proc/'environ').read_bytes().split(b'\0'):
        if b'=' in item:
            k,v = item.split(b'=',1); env[os.fsdecode(k)] = os.fsdecode(v)
    result = subprocess.run([exe,'--input-type=module','-e',"try { const c=await import('node:url').then(({pathToFileURL})=>import(pathToFileURL(process.argv[1]).href)); c.loadEnv(); const v=c.relayServerConfig().registrationKey; if(typeof v!=='string'||!/^[A-Za-z0-9._~-]{32,512}$/.test(v)) process.exit(45); process.stdout.write(v); } catch { process.exit(46); }", str(config)], cwd=str(proc/'cwd'), env=env, capture_output=True, timeout=6, check=False)
    if result.returncode != 0 or not re.fullmatch(rb'[A-Za-z0-9._~-]{32,512}', result.stdout): fail(47)
    final_pid = subprocess.run(['/usr/bin/systemctl','show','kcoder-relay.service','--property=MainPID','--value'], capture_output=True, timeout=3, check=True, text=True).stdout.strip()
    final_argv = [os.fsdecode(x) for x in (proc/'cmdline').read_bytes().split(b'\0') if x]
    if final_pid != str(pid) or os.path.realpath(proc/'exe') != exe or final_argv != argv: fail(50)
    sys.stdout.buffer.write(result.stdout)
except SystemExit: raise
except subprocess.TimeoutExpired: fail(48)
except Exception: fail(49)
`;

function remotePythonOwnedIdentity(expectedIdFingerprint) {
  if (!/^[a-f0-9]{16}$/.test(expectedIdFingerprint)) throw identityError("RELAY_IDENTITY_INVALID");
  return String.raw`import hashlib, json, os, pathlib, re, stat, subprocess, sys
SERVER = '/opt/kcoder-relay/src/server.mjs'
CONFIG = '/opt/kcoder-relay/src/config.mjs'
CONFIG_SHA256 = 'b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335'
EXPECTED_UID = 995
EXPECTED_FINGERPRINT = __EXPECTED_FINGERPRINT__
MAX_STORE_BYTES = 262144
def fail(code): sys.exit(code)
def service_identity():
    unit = subprocess.run(['/usr/bin/systemctl','show','kcoder-relay.service','--property=LoadState','--property=ActiveState','--property=MainPID'], capture_output=True, timeout=3, check=True, text=True).stdout
    fields = dict(line.split('=',1) for line in unit.splitlines() if '=' in line)
    pid = int(fields.get('MainPID','0'))
    if fields.get('LoadState') != 'loaded' or fields.get('ActiveState') != 'active' or pid <= 0: fail(61)
    proc = pathlib.Path('/proc') / str(pid)
    status = (proc/'status').read_text()
    uid = next((int(line.split()[2]) for line in status.splitlines() if line.startswith('Uid:')), -1)
    if uid != EXPECTED_UID: fail(62)
    exe = os.path.realpath(proc/'exe')
    argv = [os.fsdecode(x) for x in (proc/'cmdline').read_bytes().split(b'\0') if x]
    if not exe.endswith('/node') or argv.count(SERVER) != 1: fail(63)
    config = pathlib.Path(CONFIG)
    if not config.is_file() or hashlib.sha256(config.read_bytes()).hexdigest() != CONFIG_SHA256: fail(64)
    stat_text = (proc/'stat').read_text()
    close_index = stat_text.rfind(')')
    if close_index < 0: fail(65)
    fields = stat_text[close_index+1:].split()
    if len(fields) <= 19: fail(65)
    return {'pid':pid,'uid':uid,'exe':exe,'argv':argv,'startTicks':fields[19],'configSha256':CONFIG_SHA256}, proc
def read_process_env(proc):
    env = {}
    for item in (proc/'environ').read_bytes().split(b'\0'):
        if b'=' in item:
            k,v = item.split(b'=',1); env[os.fsdecode(k)] = os.fsdecode(v)
    return env
def configured_store_path(identity, proc):
    source = "try { const u=await import('node:url'); const p=await import('node:path'); const c=await import(u.pathToFileURL(process.argv[1]).href); c.loadEnv(); const f=c.relayServerConfig().registrationStoreFile; if(typeof f!=='string'||!p.isAbsolute(f)||f.includes('\\n')||f.includes('\\0')) process.exit(66); process.stdout.write(f); } catch { process.exit(67); }"
    result = subprocess.run([identity['exe'],'--input-type=module','-e',source,CONFIG], cwd=str(proc/'cwd'), env=read_process_env(proc), capture_output=True, timeout=6, check=False)
    if result.returncode != 0 or not result.stdout or len(result.stdout) > 4096 or b'\n' in result.stdout or b'\0' in result.stdout: fail(68)
    try: path = pathlib.Path(os.fsdecode(result.stdout))
    except Exception: fail(68)
    if not path.is_absolute(): fail(68)
    return path
def object_no_duplicates(pairs):
    result = {}
    for key,value in pairs:
        if key in result: raise ValueError('duplicate JSON field')
        result[key] = value
    return result
def safe_parent(path, uid):
    current = pathlib.Path(path.anchor)
    for part in path.parent.parts[1:]:
        current = current / part
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode): fail(69)
    info = os.lstat(path.parent)
    if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700: fail(69)
def read_store(path, uid):
    safe_parent(path, uid)
    if not hasattr(os, 'O_NOFOLLOW'): fail(70)
    try: path_info = os.lstat(path)
    except Exception: fail(71)
    if not stat.S_ISREG(path_info.st_mode) or path_info.st_uid != uid or stat.S_IMODE(path_info.st_mode) != 0o600 or path_info.st_nlink != 1 or path_info.st_size > MAX_STORE_BYTES: fail(71)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | getattr(os,'O_NONBLOCK',0))
    try:
        before = os.fstat(fd)
        path_identity = (path_info.st_dev,path_info.st_ino,path_info.st_uid,path_info.st_mode,path_info.st_nlink,path_info.st_size)
        open_identity = (before.st_dev,before.st_ino,before.st_uid,before.st_mode,before.st_nlink,before.st_size)
        if not stat.S_ISREG(before.st_mode) or open_identity != path_identity or before.st_uid != uid or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1 or before.st_size > MAX_STORE_BYTES: fail(71)
        chunks = []; total = 0
        while True:
            block = os.read(fd, min(8192, MAX_STORE_BYTES + 1 - total))
            if not block: break
            total += len(block)
            if total > MAX_STORE_BYTES: fail(71)
            chunks.append(block)
        after = os.fstat(fd)
        identity_before = (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
        identity_after = (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
        if identity_before != identity_after or total != before.st_size: fail(72)
        try: document = json.loads(b''.join(chunks).decode('utf-8','strict'), object_pairs_hook=object_no_duplicates)
        except Exception: fail(73)
    finally:
        os.close(fd)
    if not isinstance(document,dict) or set(document) != {'version','gateways'} or type(document['version']) is not int or document['version'] != 1 or not isinstance(document['gateways'],list) or len(document['gateways']) > 256: fail(73)
    matches = []
    for record in document['gateways']:
        if not isinstance(record,dict) or set(record) != {'id','secret','pairingToken','enrollmentTokenHash'}: fail(73)
        rid = record['id']; secret = record['secret']; pairing = record['pairingToken']; proof_hash = record['enrollmentTokenHash']
        if not isinstance(rid,str) or not re.fullmatch(r'[a-f0-9]{32}',rid): fail(73)
        if not isinstance(secret,str) or not re.fullmatch(r'[a-f0-9]{64}',secret): fail(73)
        if not isinstance(pairing,str) or not re.fullmatch(r'[A-Za-z0-9._~-]{32,512}',pairing): fail(73)
        if not isinstance(proof_hash,str) or not re.fullmatch(r'[a-f0-9]{64}',proof_hash): fail(73)
        if len({rid,secret,pairing}) != 3: fail(73)
        if hashlib.sha256(rid.encode('ascii')).hexdigest()[:16] == EXPECTED_FINGERPRINT: matches.append(record)
    if len(matches) != 1: fail(74)
    record = matches[0]
    return {'id':record['id'],'secret':record['secret'],'pairingToken':record['pairingToken']}
try:
    before, proc = service_identity()
    store_path = configured_store_path(before, proc)
    selected = read_store(store_path, before['uid'])
    store_path_after = configured_store_path(before, proc)
    after, _ = service_identity()
    if before != after or store_path != store_path_after: fail(75)
    encoded = json.dumps(selected,separators=(',',':')).encode('utf-8')
    if len(encoded) > 512: fail(74)
    sys.stdout.buffer.write(encoded)
except SystemExit: raise
except subprocess.TimeoutExpired: fail(76)
except Exception: fail(77)
`.replace("__EXPECTED_FINGERPRINT__", JSON.stringify(expectedIdFingerprint));
}

async function runPrivateRelayProbe(context, python, cleanupLabel) {
  const child = spawn("/usr/bin/ssh", SSH_ARGS, {
    cwd: "/home/hyf",
    env: { PATH: "/usr/bin:/bin", HOME: "/home/hyf", ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false, exitCode = null, exitSignal = null, timedOut = false, overflow = false;
  let stdout = Buffer.alloc(0), stdoutBytes = 0;
  let resolveClose;
  const closedPromise = new Promise(resolve => { resolveClose = resolve; });
  const close = (code, signal) => { if (closed) return; closed = true; exitCode = code; exitSignal = signal; resolveClose(); };
  child.once("close", close);
  child.stdout.on("data", chunk => {
    if (overflow) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > 512) { overflow = true; child.kill("SIGTERM"); }
    else stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});
  let timer;
  const terminate = async () => {
    if (closed) return;
    child.kill("SIGTERM");
    await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (!closed) child.kill("SIGKILL");
    await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 2000))]);
  };
  context.addCleanup(cleanupLabel, terminate);
  child.once("error", () => close(null, "spawn-error"));
  timer = setTimeout(() => { timedOut = true; void terminate(); }, 27_000);
  child.stdin.end(python);
  await closedPromise;
  clearTimeout(timer);
  if (!closed) await terminate();
  return { exitCode, exitSignal, timedOut, overflow, stdout };
}

function probeError(name, code, result = {}) {
  const error = new Error(`Production Relay credential probe failed (${code})`);
  error.name = name;
  error.code = code;
  error.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  error.exitSignal = typeof result.exitSignal === "string" ? result.exitSignal : null;
  return error;
}

function identityError(code, result) {
  return probeError("RelayIdentityReadError", code, result);
}

function requireProbeSuccess(result, errorName, failureCode) {
  let errorCode = null;
  if (result.timedOut) errorCode = "SSH_TIMEOUT";
  else if (result.overflow) errorCode = "SSH_OUTPUT_LIMIT";
  else if (result.exitCode !== 0 || result.exitSignal !== null) errorCode = failureCode;
  if (errorCode !== null) {
    result.stdout.fill(0);
    throw probeError(errorName, errorCode, result);
  }
}

export async function loadProductionRegistrationKey(context) {
  const result = await runPrivateRelayProbe(context, REMOTE_PYTHON_REGISTRATION_KEY, "stop private Relay key SSH");
  requireProbeSuccess(result, "RelayRegistrationKeyError", "RELAY_KEY_UNAVAILABLE");
  const key = result.stdout.toString("ascii");
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(key)) {
    result.stdout.fill(0);
    throw probeError("RelayRegistrationKeyError", "RELAY_KEY_UNAVAILABLE", result);
  }
  context.registerSecret(key);
  result.stdout.fill(0);
  return key;
}

export async function loadOwnedProductionRelayIdentity(context, { expectedIdFingerprint } = {}) {
  if (!/^[a-f0-9]{16}$/.test(expectedIdFingerprint ?? "")) throw identityError("RELAY_IDENTITY_INVALID");
  const result = await runPrivateRelayProbe(context, remotePythonOwnedIdentity(expectedIdFingerprint), "stop private Relay identity SSH");
  requireProbeSuccess(result, "RelayIdentityReadError", "RELAY_IDENTITY_UNAVAILABLE");
  let identity;
  try { identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)); }
  catch {
    result.stdout.fill(0);
    throw identityError("RELAY_IDENTITY_INVALID", result);
  }
  const keys = identity && typeof identity === "object" && !Array.isArray(identity) ? Object.keys(identity).sort() : [];
  const valid = JSON.stringify(keys) === JSON.stringify(["id", "pairingToken", "secret"])
    && typeof identity.id === "string" && /^[a-f0-9]{32}$/.test(identity.id)
    && typeof identity.secret === "string" && /^[a-f0-9]{64}$/.test(identity.secret)
    && typeof identity.pairingToken === "string" && /^[A-Za-z0-9._~-]{32,512}$/.test(identity.pairingToken)
    && createHash("sha256").update(identity.id, "ascii").digest("hex").slice(0, 16) === expectedIdFingerprint;
  if (!valid) {
    result.stdout.fill(0);
    throw identityError("RELAY_IDENTITY_INVALID", result);
  }
  context.registerSecret(identity.id);
  context.registerSecret(identity.secret);
  context.registerSecret(identity.pairingToken);
  result.stdout.fill(0);
  return { id: identity.id, secret: identity.secret, pairingToken: identity.pairingToken };
}
