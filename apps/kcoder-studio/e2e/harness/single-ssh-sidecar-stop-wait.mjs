import assert from "node:assert/strict";
import { buildMarkedPythonSource, createSshStageObserver } from "./owned-ssh-control-master.mjs";

export const ORIGINAL_SIDECAR_EXIT_WAIT_MS = 10_000;
export const SIDE_CAR_STOP_SSH_TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT = 8192;

export function buildStopAndWaitForOriginalSidecarProgram(original, observed) {
  assert.ok(original && typeof original === "object" && !Array.isArray(original));
  assert.ok(observed && typeof observed === "object" && !Array.isArray(observed));
  assert.ok(Number.isSafeInteger(original.pid) && original.pid > 1);
  assert.equal(observed.pid, original.pid);
  assert.equal(observed.exeMatches, true);
  assert.equal(observed.euid, 0);
  assert.equal(observed.argvConfigMatch, true);
  assert.equal(observed.configSha256, original.configSha256);
  assert.match(original.configPath, /^\/tmp\/kc-phone-ux-443-[0-9]{8}-[0-9]{6}\/isolated-443-front\.Caddyfile$/);
  assert.match(original.configSha256, /^[a-f0-9]{64}$/);
  if (original.startTicks !== undefined) assert.ok(Number.isSafeInteger(original.startTicks) && original.startTicks > 0);
  const payload = {
    original: {
      pid: original.pid,
      configPath: original.configPath,
      configSha256: original.configSha256,
      expectedStartTicks: original.startTicks ?? null,
      expectedExe: "/usr/bin/caddy",
      expectedEuid: 0,
      argv: ["/usr/bin/caddy", "run", "--config", original.configPath, "--adapter", "caddyfile"],
    },
  };
  return `import hashlib,json,os,pathlib,re,select,signal,stat,subprocess,sys
p=json.loads(${JSON.stringify(JSON.stringify(payload))})
def sha(data): return hashlib.sha256(data).hexdigest()
def read_identity(pid):
 q=pathlib.Path('/proc')/str(pid)
 raw=q.joinpath('stat').read_text(); start_ticks=int(raw[raw.rfind(')')+2:].split()[19])
 exe=os.readlink(q/'exe'); exe_stat=os.stat(q/'exe')
 argv=q.joinpath('cmdline').read_bytes().split(b'\\0')
 if argv and not argv[-1]: argv=argv[:-1]
 uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',q.joinpath('status').read_text(),re.M)
 if not uid: raise RuntimeError('original-euid-unavailable')
 return {'pid':pid,'startTicks':start_ticks,'exe':exe,'exeDev':exe_stat.st_dev,'exeIno':exe_stat.st_ino,
         'argv':argv,'argvSha256':sha(b'\\0'.join(argv)),'euid':int(uid.group(2))}
def listener_text(port):
 return subprocess.check_output(['ss','-H','-ltnp','sport = :'+str(port)],text=True,timeout=5)
def listener_pids(text): return sorted({int(x) for x in re.findall(r'pid=(\\d+),',text)})
def config_sha(path):
 q=pathlib.Path(path); st=q.lstat()
 if not stat.S_ISREG(st.st_mode) or q.is_symlink(): raise RuntimeError('original-config-not-regular')
 return sha(q.read_bytes())
class LinuxOps:
 config_sha=staticmethod(config_sha)
 read_identity=staticmethod(read_identity)
 listener_text=staticmethod(listener_text)
 listener_pids=staticmethod(listener_pids)
 pidfd_open=staticmethod(os.pidfd_open)
 pidfd_send_signal=staticmethod(signal.pidfd_send_signal)
 pidfd_close=staticmethod(os.close)
 @staticmethod
 def pidfd_exited(fd):
  poller=select.poll(); poller.register(fd,select.POLLIN)
  return bool(poller.poll(0))
 @staticmethod
 def wait_pidfd(fd,timeout_ms):
  poller=select.poll(); poller.register(fd,select.POLLIN)
  return bool(poller.poll(timeout_ms))
def run_transition(expected,ops):
 o=expected['original']; pid=o['pid']; cfg=o['configPath']
 if ops.config_sha(cfg)!=o['configSha256']: raise RuntimeError('original-config-sha-mismatch')
 before=ops.listener_text(443)
 if not before.strip() or ops.listener_pids(before)!=[pid]: raise RuntimeError('original-not-sole-443-owner')
 try: fd=ops.pidfd_open(pid,0)
 except ProcessLookupError: raise RuntimeError('original-owner-absent-before-pidfd')
 try:
  if ops.pidfd_exited(fd): raise RuntimeError('original-exited-before-identity-check')
  actual=ops.read_identity(pid)
  if actual['pid']!=pid or actual['exe']!=o['expectedExe'] or actual['euid']!=o['expectedEuid']:
   raise RuntimeError('original-process-identity-mismatch')
  if actual['argv']!=[part.encode() for part in o['argv']]: raise RuntimeError('original-argv-mismatch')
  if o['expectedStartTicks'] is not None and actual['startTicks']!=o['expectedStartTicks']:
   raise RuntimeError('original-startticks-mismatch')
  if ops.pidfd_exited(fd): raise RuntimeError('original-exited-before-term')
  if ops.config_sha(cfg)!=o['configSha256']: raise RuntimeError('original-config-changed-before-term')
  rechecked=ops.listener_text(443)
  if not rechecked.strip() or ops.listener_pids(rechecked)!=[pid]: raise RuntimeError('original-not-sole-443-owner-before-term')
  ops.pidfd_send_signal(fd,0,None,0)
  ops.pidfd_send_signal(fd,signal.SIGTERM,None,0)
  if not ops.wait_pidfd(fd,${ORIGINAL_SIDECAR_EXIT_WAIT_MS}): raise RuntimeError('original-term-exit-timeout')
  after=ops.listener_text(443)
  if after.strip(): raise RuntimeError('unknown-443-listener-after-original-exit')
  return {'state':'original-exited-443-free','pid':pid,'startTicks':actual['startTicks'],
    'startTicksSource':'observed-after-pidfd-open','exe':actual['exe'],'exeDev':actual['exeDev'],'exeIno':actual['exeIno'],
    'euid':actual['euid'],'argvSha256':actual['argvSha256'],'configSha256':o['configSha256'],
    'pidfd':True,'termSent':True,'exitConfirmed':True,'exitWaitMs':${ORIGINAL_SIDECAR_EXIT_WAIT_MS},'port443Free':True}
 finally: ops.pidfd_close(fd)
if __name__=='__main__':
 try:
  result=run_transition(p,LinuxOps())
  print(json.dumps(result,separators=(',',':')))
 except Exception as error:
  print(json.dumps({'state':'failed','reason':str(error)[:96]},separators=(',',':')),file=sys.stderr)
  raise
`;
}

export function parseStopAndWaitForOriginalSidecarReceipt(stdout, original) {
  assert.ok(Buffer.byteLength(stdout) > 0 && Buffer.byteLength(stdout) <= OUTPUT_LIMIT);
  const receipt = JSON.parse(stdout.trim());
  assert.deepEqual(Object.keys(receipt).sort(), ["argvSha256", "configSha256", "euid", "exe", "exeDev", "exeIno", "exitConfirmed",
    "exitWaitMs", "pid", "pidfd", "port443Free", "startTicks", "startTicksSource", "state", "termSent"].sort());
  assert.equal(receipt.state, "original-exited-443-free");
  assert.equal(receipt.pid, original.pid);
  assert.ok(Number.isSafeInteger(receipt.startTicks) && receipt.startTicks > 0);
  if (original.startTicks !== undefined) assert.equal(receipt.startTicks, original.startTicks);
  assert.equal(receipt.startTicksSource, "observed-after-pidfd-open");
  assert.equal(receipt.exe, "/usr/bin/caddy");
  assert.ok(Number.isSafeInteger(receipt.exeDev) && receipt.exeDev >= 0);
  assert.ok(Number.isSafeInteger(receipt.exeIno) && receipt.exeIno > 0);
  assert.equal(receipt.euid, 0);
  assert.match(receipt.argvSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.configSha256, original.configSha256);
  assert.equal(receipt.pidfd, true); assert.equal(receipt.termSent, true); assert.equal(receipt.exitConfirmed, true);
  assert.equal(receipt.exitWaitMs, ORIGINAL_SIDECAR_EXIT_WAIT_MS); assert.equal(receipt.port443Free, true);
  return receipt;
}

/** Performs only exact-old-owner TERM, bounded same-pidfd wait, and port-free confirmation. */
export async function stopAndWaitForOriginalSidecarOnce(context, original, observed, {
  sshTransport, repoRoot, waitFor, timeoutMs = SIDE_CAR_STOP_SSH_TIMEOUT_MS,
}) {
  assert.ok(sshTransport && typeof sshTransport.spawnManaged === "function");
  assert.equal(typeof waitFor, "function");
  const program = buildMarkedPythonSource(buildStopAndWaitForOriginalSidecarProgram(original, observed));
  const label = "ssh-single-connection-stop-original-sidecar";
  const child = await sshTransport.spawnManaged(label, "sudo -n python3 -", {
    cwd: repoRoot, stdin: "pipe", env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
  });
  const startedAt = Date.now();
  let output = "", stderr = "", outputBytes = 0, stderrBytes = 0, overflow = false, closeInfo = null, spawnError = null;
  const stageObserver = createSshStageObserver(performance.now());
  let stopPromise = null;
  const requestStop = () => {
    if (!stopPromise) stopPromise = context.stopOwned(label);
    return stopPromise;
  };
  const collect = (target, chunk) => {
    const bytes = Buffer.from(chunk);
    if (target === "stdout") outputBytes += bytes.length; else stderrBytes += bytes.length;
    if (outputBytes > OUTPUT_LIMIT || stderrBytes > OUTPUT_LIMIT) {
      overflow = true; void requestStop().catch(() => {}); return;
    }
    if (target === "stdout") output += bytes.toString("utf8"); else { stderr += bytes.toString("utf8"); stageObserver.push(bytes); }
  };
  child.stdout.on("data", chunk => collect("stdout", chunk));
  child.stderr.on("data", chunk => collect("stderr", chunk));
  child.once("error", error => { spawnError = error; });
  child.once("close", (code, signal) => { closeInfo = { code, signal }; });
  child.stdin.on("error", () => {}); child.stdin.end(program);
  const writeFailure = async reason => {
    try {
      const stage = stageObserver.finish();
      await context.writeArtifactJson("routes-only-stop-wait-remote-failure.json", {
        sshPid: child.pid ?? null, exitCode: closeInfo?.code ?? child.exitCode ?? null,
        signal: closeInfo?.signal ?? child.signalCode ?? null, terminalObserved: closeInfo !== null,
        spawnErrorKind: spawnError?.name ?? null, elapsedMs: Date.now() - startedAt,
        stdoutBytes: outputBytes, stderrBytes, overflow,
        safeOutput: context.redactText(`${stderr}\n${output}`).slice(0, 2048), reason,
        remoteStageMarkers: stage.markers, invalidStageMarkerCount: stage.invalidMarkerCount,
        droppedStageMarkerCount: stage.droppedMarkerCount,
      });
    } catch {}
  };
  try {
    await waitFor(() => closeInfo !== null || spawnError !== null, timeoutMs, "single bounded sidecar stop/wait/free SSH", 25, context.abortSignal);
  } catch (failure) {
    try { await requestStop(); }
    catch (stopFailure) { throw new AggregateError([failure, stopFailure], "sidecar stop/wait SSH and owned cleanup failed"); }
    if (closeInfo === null) {
      try { await waitFor(() => closeInfo !== null, 5_000, "single stop/wait SSH local child close"); } catch {}
    }
    await writeFailure("ssh-timeout-or-abort-remote-outcome-unknown");
    throw failure;
  }
  if (closeInfo?.code !== 0 || closeInfo?.signal !== null || overflow || spawnError) {
    await writeFailure("ssh-nonzero-or-output-invalid");
    throw new Error("single stop/wait SSH did not return a bounded successful receipt");
  }
  const stage = stageObserver.finish();
  assert.equal(stage.valid, true, "SSH stop/wait stage markers must be well-formed and bounded");
  assert.deepEqual(stage.markers.map(marker => marker.stage), ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"]);
  try { return parseStopAndWaitForOriginalSidecarReceipt(output, original); }
  catch (failure) { await writeFailure("ssh-receipt-invalid"); throw failure; }
}
