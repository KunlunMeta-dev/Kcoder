import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitFor } from "./run-context.mjs";

export const SSH_STAGE_MARKERS = Object.freeze([
  "REMOTE_PYTHON_ENTERED",
  "REMOTE_IDENTITY_PREFLIGHT_PASSED",
  "REMOTE_OWNER_DURABLE",
  "REMOTE_CANDIDATE_WRITE_DURABLE",
  "REMOTE_VALIDATION_PASSED",
  "REMOTE_ORIGINAL_TERM_SENT",
  "REMOTE_ORIGINAL_EXIT_CONFIRMED",
  "REMOTE_CANDIDATE_PID_CONFIRMED",
  "REMOTE_PROGRAM_COMPLETE",
]);
const MARKER_SET = new Set(SSH_STAGE_MARKERS);
const SOCKET_PATH_MAX_BYTES = 80;
const OWNER_ERROR = "SSH control master ownership/readiness gate failed";

export function buildSshMasterArgs({ target, configPath, knownHostsPath, controlPath }) {
  assert.ok(target && configPath && knownHostsPath && controlPath);
  return [
    "-T", "-M", "-N", "-F", configPath, "-S", controlPath,
    "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ControlMaster=yes",
    "-o", "ControlPath=" + controlPath,
    "-o", "ControlPersist=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    target,
  ];
}

export function buildManagedSshArgs({ target, configPath, knownHostsPath, controlPath }, remoteCommand) {
  assert.ok(target && configPath && knownHostsPath && controlPath);
  assert.equal(typeof remoteCommand, "string");
  assert.ok(remoteCommand.length > 0 && !remoteCommand.includes("\0"));
  return [
    "-T", "-F", configPath, "-S", controlPath,
    "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=" + controlPath,
    "-o", "ControlPersist=no",
    "-o", "ProxyCommand=/bin/false",
    "-o", "ProxyJump=none",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    target, remoteCommand,
  ];
}

export function buildControlCheckArgs({ target, configPath, knownHostsPath, controlPath }) {
  return [
    "-T", "-F", configPath, "-S", controlPath,
    "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=" + controlPath,
    "-o", "ControlPersist=no",
    "-o", "ProxyCommand=/bin/false",
    "-o", "ProxyJump=none",
    "-O", "check", target,
  ];
}

export function buildFreshSshArgs({ target, directOptions }, remoteCommand) {
  assert.ok(target && Array.isArray(directOptions));
  assert.equal(typeof remoteCommand, "string");
  assert.ok(remoteCommand.length > 0 && !remoteCommand.includes("\0"));
  const controlMaster = [];
  const controlPath = [];
  for (let index = 0; index < directOptions.length; index += 1) {
    const value = directOptions[index];
    assert.equal(typeof value, "string");
    assert.ok(value !== "-S" && !value.startsWith("-S"), "fresh recovery cannot receive a ControlPath through -S");
    let option = null;
    if (value === "-o") {
      assert.ok(index + 1 < directOptions.length, "SSH -o requires an option value");
      option = directOptions[++index];
    } else if (value.startsWith("-o") && value.length > 2) option = value.slice(2);
    if (typeof option === "string") {
      const equals = option.indexOf("=");
      if (equals !== -1) {
        const key = option.slice(0, equals).toLowerCase();
        const setting = option.slice(equals + 1);
        if (key === "controlmaster") controlMaster.push(setting.toLowerCase());
        if (key === "controlpath") controlPath.push(setting.toLowerCase());
      }
    }
  }
  assert.deepEqual(controlMaster, ["no"], "fresh recovery must not borrow a master");
  assert.deepEqual(controlPath, ["none"], "fresh recovery must not use a control socket");
  return ["-T", ...directOptions, target, remoteCommand];
}

export function createOwnedSshDispatcher({ primaryContext, managedTransport, binary = "/usr/bin/ssh", target, directOptions }) {
  assert.ok(primaryContext && managedTransport && typeof managedTransport.spawnManaged === "function");
  assert.ok(resolve(binary) === binary);
  assert.ok(target && Array.isArray(directOptions));
  let recoveryContext = null;
  const attachRecoveryContext = context => {
    assert.ok(context && context !== primaryContext);
    assert.equal(recoveryContext, null, "fresh recovery context can only be attached once");
    recoveryContext = context;
  };
  const spawn = async (context, label, remoteCommand, options = {}) => {
    assert.ok(context && typeof context.spawnOwned === "function");
    const ownedOptions = {
      ...options,
      env: options.env ?? context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    };
    if (context === primaryContext) {
      return await managedTransport.spawnManaged(label, remoteCommand, ownedOptions);
    }
    if (recoveryContext && context === recoveryContext) {
      return context.spawnOwned(label, binary, buildFreshSshArgs({ target, directOptions }, remoteCommand), ownedOptions);
    }
    throw new Error("SSH context is not owned by this transaction");
  };
  return Object.freeze({ attachRecoveryContext, spawn });
}

export function parseSshStageMarkers(stderrText, receivedAtMs = null) {
  assert.equal(typeof stderrText, "string");
  const events = [];
  for (const line of stderrText.split(/\r?\n/)) {
    const prefix = "KCUX_STAGE:";
    if (!line.startsWith(prefix)) continue;
    const stage = line.slice(prefix.length);
    assert.ok(MARKER_SET.has(stage), "unknown SSH stage marker");
    events.push({ stage, receivedAtMs });
  }
  return events;
}

export function createSshStageObserver(startedAtMs = performance.now(), maxMarkers = 32, maxBytes = 65_536) {
  assert.ok(Number.isFinite(startedAtMs) && startedAtMs >= 0);
  assert.ok(Number.isSafeInteger(maxMarkers) && maxMarkers > 0 && maxMarkers <= 64);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 131_072);
  let pending = "";
  let bytesSeen = 0;
  let invalidMarkerCount = 0;
  let droppedMarkerCount = 0;
  let droppedBytes = 0;
  const markers = [];
  let finished = false;
  const consume = line => {
    if (!line.startsWith("KCUX_STAGE:")) return;
    try {
      const parsed = parseSshStageMarkers(line, performance.now() - startedAtMs);
      if (markers.length + parsed.length > maxMarkers) droppedMarkerCount += parsed.length;
      else markers.push(...parsed);
    } catch {
      invalidMarkerCount += 1;
    }
  };
  return Object.freeze({
    push(chunk) {
      assert.equal(finished, false, "SSH stage observer is already finished");
      const bytes = Buffer.from(chunk);
      if (bytesSeen + bytes.length > maxBytes) {
        droppedBytes += bytes.length;
        return;
      }
      bytesSeen += bytes.length;
      pending += bytes.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    finish() {
      if (!finished) {
        if (pending) consume(pending);
        pending = "";
        finished = true;
      }
      return Object.freeze({
        markers: markers.map(marker => ({ ...marker })),
        invalidMarkerCount,
        droppedMarkerCount,
        droppedBytes,
        valid: invalidMarkerCount === 0 && droppedMarkerCount === 0 && droppedBytes === 0,
      });
    },
  });
}

export function buildMarkedPythonSource(source) {
  assert.equal(typeof source, "string");
  assert.ok(!source.includes("KCUX_STAGE:"), "source already contains a stage marker");
  return [
    "import sys",
    "print('KCUX_STAGE:REMOTE_PYTHON_ENTERED', file=sys.stderr, flush=True)",
    source,
    "print('KCUX_STAGE:REMOTE_PROGRAM_COMPLETE', file=sys.stderr, flush=True)",
  ].join("\n") + "\n";
}

/** Python-side exact owner gates shared by private remote-resource once-runs. */
export function remoteOwnedProcessGuardSource() {
  return [
    "import hashlib,json,os,stat",
    "def _private_regular(path, uid, mode):",
    " st=os.lstat(path)",
    " assert stat.S_ISREG(st.st_mode) and st.st_uid==uid and stat.S_IMODE(st.st_mode)==mode and st.st_nlink==1",
    " return st",
    "def _read_owner_marker(root, run_id, marker_name, uid):",
    " rs=os.lstat(root)",
    " assert stat.S_ISDIR(rs.st_mode) and not stat.S_ISLNK(rs.st_mode) and rs.st_uid==uid and stat.S_IMODE(rs.st_mode)==0o700",
    " marker=os.path.join(root,marker_name)",
    " ms=_private_regular(marker,uid,0o600)",
    " assert ms.st_size<=512",
    " fd=os.open(marker,os.O_RDONLY|os.O_NOFOLLOW)",
    " try:",
    "  fs=os.fstat(fd)",
    "  assert (fs.st_dev,fs.st_ino,fs.st_uid,stat.S_IMODE(fs.st_mode),fs.st_nlink)==(ms.st_dev,ms.st_ino,uid,0o600,1)",
    "  body=os.read(fd,513)",
    " finally: os.close(fd)",
    " assert len(body)<=512",
    " value=json.loads(body.decode('utf-8'))",
    " assert set(value)=={'version','runId','uid','dev','ino'}",
    " assert value=={'version':1,'runId':run_id,'uid':uid,'dev':rs.st_dev,'ino':rs.st_ino}",
    " return rs,value",
    "def _read_owned_json(root, name, uid, max_bytes=4096):",
    " assert type(name) is str and os.path.basename(name)==name and name not in ('','.','..')",
    " assert type(max_bytes) is int and 0<max_bytes<=65536",
    " path=os.path.join(root,name); st=_private_regular(path,uid,0o600)",
    " assert st.st_size<=max_bytes",
    " fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)",
    " try:",
    "  before=os.fstat(fd); assert (before.st_dev,before.st_ino,before.st_uid,stat.S_IMODE(before.st_mode),before.st_nlink)==(st.st_dev,st.st_ino,uid,0o600,1)",
    "  body=os.read(fd,max_bytes+1); after=os.fstat(fd)",
    "  assert (after.st_dev,after.st_ino,after.st_uid,stat.S_IMODE(after.st_mode),after.st_nlink,after.st_size,after.st_mtime_ns,after.st_ctime_ns)==(before.st_dev,before.st_ino,uid,0o600,1,before.st_size,before.st_mtime_ns,before.st_ctime_ns)",
    " finally: os.close(fd)",
    " assert len(body)==st.st_size and len(body)<=max_bytes",
    " return json.loads(body.decode('utf-8'))",
    "def _assert_owned_tree(root, uid, allowed_root_names, max_files=256, max_bytes=8*1024*1024):",
    " assert set(os.listdir(root))<=allowed_root_names",
    " count=0; total=0",
    " for current,dirs,files in os.walk(root,topdown=True,followlinks=False):",
    "  for name in dirs:",
    "   path=os.path.join(current,name); st=os.lstat(path)",
    "   assert stat.S_ISDIR(st.st_mode) and st.st_uid==uid and stat.S_IMODE(st.st_mode)==0o700",
    "  for name in files:",
    "   path=os.path.join(current,name); st=os.lstat(path)",
    "   assert stat.S_ISREG(st.st_mode) and st.st_uid==uid and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1",
    "   count+=1; total+=st.st_size; assert count<=max_files and total<=max_bytes",
    " return {'fileCount':count,'totalBytes':total}",
    "def _read_process(pid):",
    " assert type(pid) is int and 1<pid<2**31",
    " base='/proc/'+str(pid)",
    " raw=open(base+'/cmdline','rb').read()",
    " argv=[x.decode('utf-8','strict') for x in raw.split(b'\\0') if x]",
    " status=open(base+'/status','r',encoding='utf-8').read().splitlines()",
    " uidline=next(x for x in status if x.startswith('Uid:')).split()",
    " statline=open(base+'/stat','r',encoding='utf-8').read()",
    " right=statline.rfind(')')",
    " fields=statline[right+2:].split()",
    " return {'pid':pid,'euid':int(uidline[2]),'startTicks':int(fields[19]),'exe':os.path.realpath(base+'/exe'),",
    "  'cwd':os.path.realpath(base+'/cwd'),'argv':argv,'argvSha256':hashlib.sha256(raw).hexdigest()}",
    "def assert_owned_process(receipt, root, run_id, marker_name, uid, executable, config_sha256, expected_argv):",
    " _read_owner_marker(root,run_id,marker_name,uid)",
    " expected={'runId','pid','startTicks','euid','exe','argvSha256','cwd','configSha256'}",
    " assert type(receipt) is dict and set(receipt)==expected and receipt['runId']==run_id",
    " assert receipt['euid']==uid and receipt['exe']==os.path.realpath(executable) and receipt['cwd']==root",
    " assert receipt['configSha256']==config_sha256 and len(config_sha256)==64",
    " assert type(expected_argv) is list and len(expected_argv)<=16 and all(type(x) is str for x in expected_argv)",
    " assert type(receipt['startTicks']) is int and receipt['startTicks']>0 and type(receipt['pid']) is int and receipt['pid']>1",
    " actual=_read_process(receipt['pid'])",
    " assert actual['pid']==receipt['pid'] and actual['startTicks']==receipt['startTicks'] and actual['euid']==uid",
    " assert actual['exe']==os.path.realpath(executable) and actual['cwd']==root and actual['argv']==expected_argv",
    " assert actual['argvSha256']==receipt['argvSha256']",
    " return actual",
  ].join("\n") + "\n";
}

/** Run one bounded command through an already-owned SSH dispatcher. */
export async function runOwnedSshOperation({ context, dispatcher, label, command, cwd, timeoutMs = 30_000,
  maxStdoutBytes = 16_384, maxStderrBytes = 32_768, stdin }) {
  assert.ok(context && typeof context.spawnOwned === "function");
  assert.ok(dispatcher && typeof dispatcher.spawn === "function");
  assert.match(label, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
  assert.equal(typeof command, "string");
  assert.ok(command.length > 0 && !command.includes("\0"));
  assert.ok(typeof cwd === "string" && cwd.startsWith("/"));
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180_000);
  assert.ok(Number.isSafeInteger(maxStdoutBytes) && maxStdoutBytes > 0 && maxStdoutBytes <= 1_048_576);
  assert.ok(Number.isSafeInteger(maxStderrBytes) && maxStderrBytes > 0 && maxStderrBytes <= 131_072);
  assert.ok(stdin === undefined || Buffer.isBuffer(stdin));
  const processLabel = "ssh-op-" + label;
  const observer = createSshStageObserver(performance.now(), 16, maxStderrBytes);
  const child = await dispatcher.spawn(context, processLabel, command, {
    cwd,
    env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    ...(stdin === undefined ? {} : { stdin: "pipe" }),
  });
  let close = null, spawnError = false, overflow = false, stdoutBytes = 0, stderrBytes = 0;
  const stdout = [];
  child.once("error", () => { spawnError = true; });
  child.once("close", (code, signal) => { close = { code, signal }; });
  child.stdout.on("data", chunk => {
    const bytes = Buffer.from(chunk);
    stdoutBytes += bytes.length;
    if (stdoutBytes > maxStdoutBytes) {
      overflow = true;
      void context.stopOwned(processLabel).catch(() => {});
    } else stdout.push(bytes);
  });
  child.stderr.on("data", chunk => {
    const bytes = Buffer.from(chunk);
    stderrBytes += bytes.length;
    if (stderrBytes > maxStderrBytes) overflow = true;
    else observer.push(bytes);
  });
  if (stdin !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(stdin); }
  try {
    await waitFor(() => close !== null || spawnError, timeoutMs, "owned SSH operation " + label, 25, context.abortSignal);
  } catch (error) {
    await context.stopOwned(processLabel).catch(() => {});
    throw new Error("owned SSH operation timed out: " + label, { cause: error });
  }
  const stage = observer.finish();
  assert.equal(close?.code, 0, "owned SSH operation failed: " + label);
  assert.equal(close?.signal, null);
  assert.equal(spawnError, false);
  assert.equal(overflow, false, "owned SSH operation exceeded its output bound: " + label);
  assert.equal(stage.valid, true, "owned SSH operation stage stream was invalid: " + label);
  const expectsMarkers = command.includes("KCUX_STAGE:REMOTE_PYTHON_ENTERED");
  assert.deepEqual(stage.markers.map(row => row.stage), expectsMarkers
    ? ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"] : []);
  return Object.freeze({ stdout: Buffer.concat(stdout), stderrBytes, stage });
}

function identityFromStat(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o7777 };
}

export function assertPrivateDirectoryStat(stat, expected, uid) {
  assert.ok(stat && typeof stat.isDirectory === "function" && stat.isDirectory(), OWNER_ERROR);
  assert.equal(stat.isSymbolicLink?.() ?? false, false, OWNER_ERROR);
  assert.equal(stat.uid, uid, OWNER_ERROR);
  assert.equal(stat.mode & 0o7777, 0o700, OWNER_ERROR);
  if (expected) {
    assert.equal(String(stat.dev), expected.dev, OWNER_ERROR);
    assert.equal(String(stat.ino), expected.ino, OWNER_ERROR);
    assert.equal(stat.uid, expected.uid, OWNER_ERROR);
    assert.equal(stat.mode & 0o7777, expected.mode, OWNER_ERROR);
  }
}

export function assertOwnedSocketStat(stat, expected, uid) {
  assert.ok(stat && typeof stat.isSocket === "function" && stat.isSocket(), OWNER_ERROR);
  assert.equal(stat.isSymbolicLink?.() ?? false, false, OWNER_ERROR);
  assert.equal(stat.uid, uid, OWNER_ERROR);
  assert.ok(expected, OWNER_ERROR);
  assert.equal(String(stat.dev), expected.dev, OWNER_ERROR);
  assert.equal(String(stat.ino), expected.ino, OWNER_ERROR);
  assert.equal(stat.uid, expected.uid, OWNER_ERROR);
  assert.equal(stat.mode & 0o7777, expected.mode, OWNER_ERROR);
}

async function readLinuxProcessIdentity(pid) {
  const proc = "/proc/" + pid;
  const [exe, cmdlineBuffer, status, statText] = await Promise.all([
    realpath(proc + "/exe"),
    readFile(proc + "/cmdline"),
    readFile(proc + "/status", "utf8"),
    readFile(proc + "/stat", "utf8"),
  ]);
  const cmdline = cmdlineBuffer.toString("utf8").split("\0").filter(Boolean);
  const uidLine = status.split(/\r?\n/).find(line => line.startsWith("Uid:"));
  assert.ok(uidLine, "SSH child uid unavailable");
  const uid = Number(uidLine.trim().split(/\s+/)[2]);
  const rightParen = statText.lastIndexOf(")");
  assert.ok(rightParen > 0, "SSH child stat malformed");
  const fieldsFromState = statText.slice(rightParen + 2).trim().split(/\s+/);
  const startTicks = Number(fieldsFromState[19]);
  assert.ok(Number.isSafeInteger(startTicks) && startTicks > 0, "SSH child start time unavailable");
  return {
    pid, exe, uid, startTicks,
    argvSha256: createHash("sha256").update(cmdlineBuffer).digest("hex"),
    cmdline,
  };
}

function assertProcessSame(actual, expected) {
  assert.equal(actual.pid, expected.pid, OWNER_ERROR);
  assert.equal(actual.exe, expected.exe, OWNER_ERROR);
  assert.equal(actual.uid, expected.uid, OWNER_ERROR);
  assert.equal(actual.startTicks, expected.startTicks, OWNER_ERROR);
  assert.equal(actual.argvSha256, expected.argvSha256, OWNER_ERROR);
}

async function assertMasterProcessGone(child, masterIdentity, readIdentity = readLinuxProcessIdentity) {
  if (!child || (child.exitCode === null && child.signalCode === null)) {
    throw new Error("SSH control master child has not exited");
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("SSH control master child PID is unavailable at socket cleanup");
  }
  try {
    const actual = await readIdentity(child.pid);
    if (masterIdentity) assertProcessSame(actual, masterIdentity);
    throw new Error("SSH control master PID still exists after child close");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function waitChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      reject(new Error("local SSH control check timed out"));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal });
    };
    child.once("close", onClose);
  });
}

async function runControlCheck(context, binary, config, cwd, env, sequence, timeoutMs) {
  const label = "ssh-control-check-" + sequence;
  const child = context.spawnOwned(label, binary, buildControlCheckArgs(config), { cwd, env });
  let stderrBytes = 0, overflow = false;
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 8192) overflow = true;
  });
  try {
    const result = await waitChildClose(child, timeoutMs);
    return result.code === 0 && result.signal === null && !overflow && stderrBytes <= 8192;
  } catch {
    await context.stopOwned(label).catch(() => {});
    return false;
  }
}

export function createManagedSshTransport({
  context, binary, config, controlPath, controlDirectory,
  masterChild, masterIdentity, directoryIdentity, socketIdentity,
  checkControl, assertMasterOwner = async () => {
    const actual = await readLinuxProcessIdentity(masterChild.pid);
    assertProcessSame(actual, masterIdentity);
  },
  assertMasterGone = async () => assertMasterProcessGone(masterChild, masterIdentity),
  fsOps = { lstat, readdir, unlink, rmdir },
}) {
  let sequence = 0;

  async function assertReady() {
    if (masterChild.exitCode !== null || masterChild.signalCode !== null) throw new Error(OWNER_ERROR);
    const directoryStat = await fsOps.lstat(controlDirectory);
    assertPrivateDirectoryStat(directoryStat, directoryIdentity, process.getuid());
    const socketStat = await fsOps.lstat(controlPath);
    assertOwnedSocketStat(socketStat, socketIdentity(), process.getuid());
    await assertMasterOwner();
    const ready = await checkControl(++sequence);
    if (!ready) {
      const error = new Error(OWNER_ERROR);
      error.code = "SSH_CONTROL_CHECK_NOT_READY";
      throw error;
    }
    if (masterChild.exitCode !== null || masterChild.signalCode !== null) throw new Error(OWNER_ERROR);
    const directoryAfter = await fsOps.lstat(controlDirectory);
    assertPrivateDirectoryStat(directoryAfter, directoryIdentity, process.getuid());
    await assertMasterOwner();
    if (masterChild.exitCode !== null || masterChild.signalCode !== null) throw new Error(OWNER_ERROR);
    const socketAfter = await fsOps.lstat(controlPath);
    assertOwnedSocketStat(socketAfter, socketIdentity(), process.getuid());
  }

  async function spawnManaged(label, remoteCommand, options = {}) {
    await assertReady();
    return context.spawnOwned(label, binary, buildManagedSshArgs({ ...config, controlPath }, remoteCommand), options);
  }

  async function removeOwnedSocketDirectory() {
    if (masterChild.exitCode === null && masterChild.signalCode === null) {
      throw new Error("SSH control master must be stopped before socket cleanup");
    }
    await assertMasterGone();
    const directoryStat = await fsOps.lstat(controlDirectory);
    assertPrivateDirectoryStat(directoryStat, directoryIdentity, process.getuid());
    const names = await fsOps.readdir(controlDirectory);
    assert.ok(names.every(name => name === "c"), "unexpected entry in owned SSH control directory");
    if (names.includes("c")) {
      const socketStat = await fsOps.lstat(controlPath);
      assertOwnedSocketStat(socketStat, socketIdentity(), process.getuid());
      await fsOps.unlink(controlPath);
    }
    assert.deepEqual(await fsOps.readdir(controlDirectory), [], "owned SSH control directory must be empty");
    const directoryAfter = await fsOps.lstat(controlDirectory);
    assertPrivateDirectoryStat(directoryAfter, directoryIdentity, process.getuid());
    await fsOps.rmdir(controlDirectory);
  }

  return Object.freeze({ assertReady, spawnManaged, removeOwnedSocketDirectory });
}

export async function cleanupOwnedControlSocketDirectory({
  directory, directoryIdentity, child, spawnFailure, masterIdentity, socketIdentity,
  assertMasterGone = async () => assertMasterProcessGone(child, masterIdentity),
  fsOps = { lstat, readdir, unlink, rmdir },
  uid = process.getuid(),
}) {
  const controlPath = join(directory, "c");
  if (!child) {
    const current = await fsOps.lstat(directory);
    assertPrivateDirectoryStat(current, directoryIdentity, uid);
    assert.deepEqual(await fsOps.readdir(directory), []);
    await fsOps.rmdir(directory);
    return;
  }
  if (spawnFailure && !Number.isSafeInteger(child.pid)) {
    const currentDirectory = await fsOps.lstat(directory);
    assertPrivateDirectoryStat(currentDirectory, directoryIdentity, uid);
    assert.deepEqual(await fsOps.readdir(directory), [], "failed SSH spawn must not leave an entry in its owned socket directory");
    await fsOps.rmdir(directory);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("SSH control master process still active at socket cleanup");
  }
  await assertMasterGone();
  const currentDirectory = await fsOps.lstat(directory);
  assertPrivateDirectoryStat(currentDirectory, directoryIdentity, uid);
  const current = await fsOps.lstat(controlPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current) assertOwnedSocketStat(current, socketIdentity, uid);
  const names = await fsOps.readdir(directory);
  assert.ok(names.every(name => name === "c"), "unexpected entry in owned SSH control directory");
  if (current) await fsOps.unlink(controlPath);
  assert.deepEqual(await fsOps.readdir(directory), [], "owned SSH control directory must be empty");
  const directoryAfter = await fsOps.lstat(directory);
  assertPrivateDirectoryStat(directoryAfter, directoryIdentity, uid);
  await fsOps.rmdir(directory);
}

export async function startOwnedSshControlMaster(context, {
  binary = "/usr/bin/ssh",
  target,
  configPath,
  knownHostsPath,
  socketParent = "/tmp",
  startupTimeoutMs = 15_000,
  checkTimeoutMs = 1_000,
  cwd,
  env = context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
}) {
  assert.equal(process.platform, "linux", "the reviewed private ControlMaster owner uses /proc identity");
  assert.equal(typeof process.getuid, "function");
  assert.ok(resolve(binary) === binary, "SSH executable path must be absolute");
  assert.ok(await realpath(binary) === binary, "SSH executable must resolve without a symlink alias");
  const parent = await lstat(socketParent);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
  assert.ok((parent.mode & 0o1000) !== 0, "socket parent must be sticky and prevent foreign directory replacement");
  const directory = await mkdtemp(join(socketParent, "kcsm-"));
  await chmod(directory, 0o700);
  const directoryStat = await lstat(directory);
  assertPrivateDirectoryStat(directoryStat, null, process.getuid());
  const directoryIdentity = identityFromStat(directoryStat);
  const controlPath = join(directory, "c");
  assert.ok(Buffer.byteLength(controlPath) <= SOCKET_PATH_MAX_BYTES, "ControlPath exceeds conservative Unix socket path limit");
  const config = { target, configPath, knownHostsPath, controlPath };
  const args = buildSshMasterArgs(config);
  const cleanupLabel = "ssh-control-socket-directory";
  let child = null;
  let spawnFailure = null;
  let masterIdentity = null;
  let socketIdentity = null;
  let transport = null;
  context.addCleanup(cleanupLabel, () => cleanupOwnedControlSocketDirectory({
    directory, directoryIdentity, child, spawnFailure, masterIdentity, socketIdentity,
  }));

  child = context.spawnOwned("ssh-control-master", binary, args, { cwd, env });
  child.once("error", error => { spawnFailure = error; });
  const actualBinary = await realpath(binary);
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    if (spawnFailure) throw new Error("SSH control master spawn failed", { cause: spawnFailure });
    try {
      const actual = await readLinuxProcessIdentity(child.pid);
      assert.equal(actual.exe, actualBinary, OWNER_ERROR);
      assert.deepEqual(actual.cmdline.slice(1), args, OWNER_ERROR);
      masterIdentity = actual;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  if (spawnFailure) throw new Error("SSH control master spawn failed", { cause: spawnFailure });
  assert.ok(masterIdentity, "owned SSH master process identity did not become available");

  let checkSequence = 0;
  transport = createManagedSshTransport({
    context, binary, config, controlPath, controlDirectory: directory,
    masterChild: child, masterIdentity, directoryIdentity,
    socketIdentity: () => socketIdentity,
    checkControl: async () => runControlCheck(context, binary, config, cwd, env, ++checkSequence, checkTimeoutMs),
  });
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("SSH control master exited before becoming ready");
    const currentSocket = await lstat(controlPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (currentSocket) {
      assert.ok(currentSocket.isSocket() && currentSocket.uid === process.getuid(), OWNER_ERROR);
      socketIdentity ??= identityFromStat(currentSocket);
      try {
        await transport.assertReady();
        return transport;
      } catch (error) {
        if (error?.code !== "SSH_CONTROL_CHECK_NOT_READY") throw error;
      }
    }
    await delay(50);
  }
  throw new Error("SSH control master readiness deadline exceeded");
}
