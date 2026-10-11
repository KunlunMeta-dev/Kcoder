import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildMarkedPythonSource, createSshStageObserver, startOwnedSshControlMaster } from "../harness/owned-ssh-control-master.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const parentRunRoot = `${repoRoot}/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-080452.409Z`;
const restoreRunRoot = `${repoRoot}/target/test/apps/kcoder-studio/e2e/private/restore-exact-test443-after-failure.once.mjs/20261009-082251.660Z`;
const expected = Object.freeze({
  originalConfigPath: "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile",
  originalConfigSha256: "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c",
  staticRoot: "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root",
  staticFileCount: 37,
  staticTreeSha256: "8f414deda3c4aa5807078dab4ee6520b4cd96298e34dfc40368e06ff7371a92e",
  productionConfigPath: "/etc/caddy/Caddyfile",
  productionConfigSha256: "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511",
  productionPid: 200738,
  productionEuid: 996,
  productionArgvSha256: "626a004e20430eca69818647d5102f62bf953632ce3e06e0d4016ac2b32099fd",
  productionListenerSha256: "dc50003e06a3fb199d513a16b89f4b2e8c8f5604463aa27214dc93d8402a1f19",
  previousOriginalSidecarPid: 280123,
  candidateSidecarPid: 281219,
  candidateConfigSha256: "46af4f57dce92f2e76cb6d68d6781cd041ad1d215eb0041bb84812e7f06f3e91",
  relayRoot: "/tmp/kc-phone-ux-relay-d4b4ffcf2484ce2202e49eb1",
  relayPid: 281264,
  relayPorts: [32552, 43849, 37717],
});

const remotePython = String.raw`import hashlib,json,os,pathlib,re,stat,subprocess,sys
p=json.loads(sys.argv[1]); sha=lambda b:hashlib.sha256(b).hexdigest()
def safe_file(path):
 q=pathlib.Path(path)
 try:
  st=q.lstat()
  if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode): return {'state':'unexpected-type'}
  h=hashlib.sha256()
  with q.open('rb') as f:
   for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
  return {'state':'regular','sha256':h.hexdigest(),'uid':st.st_uid,'mode':stat.S_IMODE(st.st_mode),'nlink':st.st_nlink,'size':st.st_size}
 except FileNotFoundError: return {'state':'absent'}
def listen(port):
 cp=subprocess.run(['ss','-H','-ltnp','sport = :'+str(port)],capture_output=True,text=True,timeout=4)
 if cp.returncode: return {'query':'error','pids':[],'lineCount':0}
 lines=[x for x in cp.stdout.splitlines() if x.strip()]
 return {'query':'ok','pids':sorted({int(x) for x in re.findall(r'pid=(\d+),',cp.stdout)}),'lineCount':len(lines),'sha256':sha(cp.stdout.encode())}
def proc(pid):
 q=pathlib.Path('/proc')/str(pid)
 try:
  exe=os.readlink(q/'exe'); raw=(q/'cmdline').read_bytes().split(b'\0'); raw=raw[:-1] if raw and not raw[-1] else raw
  argv=[os.fsdecode(x) for x in raw]; status=(q/'status').read_text(); uid=re.search(r'^Uid:\s+(\d+)\s+(\d+)',status,re.M)
  start=(q/'stat').read_text(); starttime=int(start[start.rfind(')')+2:].split()[19])
  cfg=None
  if argv.count('--config')==1:
   ix=argv.index('--config'); cfg=argv[ix+1] if ix+1<len(argv) else None
  return {'state':'present','pid':pid,'exeMatches':exe=='/usr/bin/caddy','euid':int(uid.group(2)) if uid else None,
    'argvCaddyRun':len(argv)>=2 and argv[0]=='/usr/bin/caddy' and argv[1]=='run','configPath':cfg,
    'candidateArgvExact':argv==['/usr/bin/caddy','run','--config',p['candidateConfigPath'],'--adapter','caddyfile'],
    'originalArgvExact':argv==['/usr/bin/caddy','run','--config',p['originalConfigPath'],'--adapter','caddyfile'],
    'starttime':starttime}
 except FileNotFoundError: return {'state':'absent','pid':pid}
 except (PermissionError,OSError,ValueError,IndexError): return {'state':'unreadable','pid':pid}
root=pathlib.Path(p['candidateRoot']); marker=p['marker']; root_state={'state':'absent'}; root_names=[]
if os.path.lexists(root):
 st=os.lstat(root); root_state={'state':'unexpected-shape','uid':st.st_uid,'mode':stat.S_IMODE(st.st_mode),'nlink':st.st_nlink}
 if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700:
  names=sorted(x.name for x in root.iterdir()); root_names=names
  owner=safe_file(root/'.owner'); config=safe_file(root/'isolated-443-front.Caddyfile')
  try:
   owner_bytes=(root/'.owner').read_bytes(); marker_matches=owner_bytes==(marker+'\n').encode() and owner['uid']==0 and owner['mode']==0o600 and owner['nlink']==1
  except OSError: marker_matches=False
  allowed={'.owner','isolated-443-front.Caddyfile','candidate.pid','candidate.log','original-restored.pid'}
  root_state={'state':'owned-shape','uid':st.st_uid,'mode':stat.S_IMODE(st.st_mode),'names':names,
    'namesAllowed':set(names)<=allowed,'ownerMarkerMatches':marker_matches,'owner':owner,'candidateConfig':config,
    'candidateConfigMatches':config.get('sha256')==p['candidateConfigSha256'] and config.get('uid')==0 and config.get('mode')==0o600 and config.get('nlink')==1,
    'candidatePidFileMatches':safe_file(root/'candidate.pid').get('state')=='regular' and (root/'candidate.pid').read_text().strip()==str(p['candidatePid'])}
orig_file=safe_file(p['originalConfigPath']); cand_file=safe_file(p['candidateConfigPath']); prod_file=safe_file(p['productionConfigPath'])
listeners={str(x):listen(x) for x in (443,8451,32552,43849,37717)}
sidecar_pids=listeners['443']['pids']; sidecar_procs=[proc(x) for x in sidecar_pids]
candidate_proc=proc(p['candidatePid']); original_proc=proc(p['originalSidecarPid']); production_proc=proc(p['productionPid'])
if sidecar_pids==[p['candidatePid']] and candidate_proc.get('candidateArgvExact') and cand_file.get('sha256')==p['candidateConfigSha256']:
 state='candidate-exact'
elif sidecar_pids==[p['originalSidecarPid']] and original_proc.get('originalArgvExact') and orig_file.get('sha256')==p['originalConfigSha256']:
 state='original-exact'
elif not sidecar_pids: state='no-443-listener'
else: state='unexpected-or-ambiguous'
relay_root=pathlib.Path(p['relayRoot']); relay_root_state='absent' if not os.path.lexists(relay_root) else 'present'
static_result={'state':'unavailable','fileCount':None,'treeSha256':None,'matchesExpected':False}
try:
 base=pathlib.Path(p['staticRoot']); rst=base.lstat()
 if stat.S_ISDIR(rst.st_mode) and not stat.S_ISLNK(rst.st_mode):
  rows=[]; total=0
  for current,dirs,files in os.walk(base,topdown=True,followlinks=False):
   dirs.sort(); files.sort()
   for name in list(dirs)+files:
    q=pathlib.Path(current)/name; st=q.lstat()
    if q.is_symlink(): raise RuntimeError('static-symlink')
    if name in dirs:
     if not stat.S_ISDIR(st.st_mode): raise RuntimeError('static-dir-type')
    else:
     if not stat.S_ISREG(st.st_mode): raise RuntimeError('static-file-type')
     total+=st.st_size
     if total>536870912 or len(rows)>=128: raise RuntimeError('static-projection-bound')
     h=hashlib.sha256()
     with q.open('rb') as f:
      for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
     rows.append([q.relative_to(base).as_posix(),st.st_size,str(st.st_mtime_ns),h.hexdigest()])
  rows.sort(); tree=sha(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode())
  static_result={'state':'observed','fileCount':len(rows),'treeSha256':tree,
    'matchesExpected':len(rows)==p['staticFileCount'] and tree==p['staticTreeSha256']}
except Exception as exc: static_result={'state':'inspection-error','errorType':type(exc).__name__,'fileCount':None,'treeSha256':None,'matchesExpected':False}
out={'inspection':'completed','sidecarState':state,'candidateRoot':root_state,'sidecar443':{'listener':listeners['443'],'owners':sidecar_procs},
 'candidateProcess':candidate_proc,'originalProcess':original_proc,'candidateConfigFile':cand_file,'originalConfigFile':orig_file,
 'production8451':{'listener':listeners['8451'],'owner':production_proc,'configFile':prod_file,
   'configMatchesExpected':prod_file.get('sha256')==p['productionConfigSha256'],'listenerMatchesExpected':listeners['8451'].get('pids')==[p['productionPid']] and listeners['8451'].get('sha256')==p['productionListenerSha256'] and production_proc.get('euid')==996 and production_proc.get('argvCaddyRun') and production_proc.get('configPath')==p['productionConfigPath']},
 'staticRoot':static_result,'forward32552':listeners['32552'],'relayDynamicPorts':{str(x):listeners[str(x)] for x in (43849,37717)},
 'relayRootState':relay_root_state,'relayProcess':proc(p['relayPid']),
 'production8451Touched':False,'mutationsAttempted':False}
print(json.dumps(out,separators=(',',':')))
`;

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

await runE2E(import.meta.url, {
  testId: "mobile-public-rust-relay-postfailure-readonly-owner-inspection",
  tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 60_000,
  modelPolicy: "bounded read-only SSH inspection of exact failed-run isolated 443, production 8451, static root, and Relay ownership; no mutation",
}, async context => {
  assert.equal(process.version, "v22.17.0");
  const parentManifestBytes = await readFile(`${parentRunRoot}/manifest.json`);
  const parentManifest = JSON.parse(parentManifestBytes.toString("utf8"));
  assert.equal(parentManifest.status, "failed");
  const artifactDir = `${parentRunRoot}/artifacts`;
  const candidate = JSON.parse(await readFile(`${artifactDir}/routes-only-sidecar-candidate.json`, "utf8"));
  const relay = JSON.parse(await readFile(`${artifactDir}/remote-relay-ready.json`, "utf8"));
  const relayCleanup = JSON.parse(await readFile(`${repoRoot}/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-080519.253Z/artifacts/remote-relay-cleanup.json`, "utf8"));
  const restorationBytes = await readFile(`${restoreRunRoot}/artifacts/single-ssh-sidecar-restoration.json`);
  const restoration = JSON.parse(restorationBytes.toString("utf8"));
  const restoredPid = restoration.result?.restoredSidecarPid;
  assert.equal(restoration.status, "confirmed");
  assert.equal(restoration.exit?.code, 0);
  assert.equal(restoration.exit?.signal, null);
  assert.equal(restoration.result?.rootRemoval, "confirmed-absent");
  assert.equal(restoration.result?.killUsed, false);
  assert.equal(restoration.result?.remote?.productionListenerSha256, expected.productionListenerSha256);
  assert.deepEqual(restoration.result?.remote?.productionOwners?.map(row => ({
    pid: row.pid, exe: row.exe, euid: row.euid, argvConfigMatch: row.argvConfigMatch, argvSha256: row.argvSha256,
  })), [{ pid: expected.productionPid, exe: "/usr/bin/caddy", euid: expected.productionEuid,
    argvConfigMatch: true, argvSha256: expected.productionArgvSha256 }]);
  assert.equal(restoration.result?.staticRoot?.treeSha256, expected.staticTreeSha256);
  assert.equal(restoredPid, 281568);
  assert.notEqual(restoredPid, expected.previousOriginalSidecarPid);
  assert.equal(candidate.candidateConfigSha256, expected.candidateConfigSha256);
  assert.equal(candidate.candidatePid, expected.candidateSidecarPid);
  assert.equal(candidate.productionPid, expected.productionPid);
  assert.equal(relay.pid, expected.relayPid);
  assert.equal(relayCleanup.remoteRootRemoved, true);
  assert.equal(relayCleanup.rootReceiptRecovered, false);
  const suffix = createHash("sha256").update(parentManifest.seed).digest("hex").slice(0, 24);
  const marker = `kc_route_${suffix}`;
  const candidateRoot = `/tmp/kc-phone-ux-rust-baseline-${suffix}`;
  const payload = {
    candidateRoot, marker, candidatePid: expected.candidateSidecarPid,
    candidateConfigPath: `${candidateRoot}/isolated-443-front.Caddyfile`,
    candidateConfigSha256: expected.candidateConfigSha256,
    originalConfigPath: expected.originalConfigPath, originalConfigSha256: expected.originalConfigSha256,
    originalSidecarPid: restoredPid,
    productionConfigPath: expected.productionConfigPath, productionConfigSha256: expected.productionConfigSha256,
    productionPid: expected.productionPid, productionListenerSha256: expected.productionListenerSha256,
    staticRoot: expected.staticRoot, staticFileCount: expected.staticFileCount, staticTreeSha256: expected.staticTreeSha256,
    relayRoot: relay.runRoot, relayPid: expected.relayPid,
  };
  const python = buildMarkedPythonSource(remotePython);
  const compileResult = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<readonly-owner-inspection>', 'exec')"],
    { input: python, cwd: repoRoot, encoding: "utf8", maxBuffer: 8192 });
  assert.equal(compileResult.status, 0, `generated read-only remote Python must compile locally (${compileResult.error?.code ?? compileResult.stderr ?? "unknown"})`);
  const suitePath = `${repoRoot}/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs`;
  const restorePath = `${repoRoot}/apps/kcoder-studio/e2e/harness/single-ssh-sidecar-restore.mjs`;
  await context.writeArtifactJson("inspection-input.json", {
    parentRunRoot, parentManifestSha256: hash(parentManifestBytes), restoreRunRoot,
    restorationArtifactSha256: hash(restorationBytes), restoredPid,
    candidatePins: { candidatePid: expected.candidateSidecarPid, candidateConfigSha256: expected.candidateConfigSha256,
      originalConfigSha256: expected.originalConfigSha256, staticRootPreserved: candidate.staticRootPreserved },
    relayPins: { runRoot: relay.runRoot, pid: expected.relayPid, ports: expected.relayPorts },
    relayCleanup: { remoteRootRemoved: relayCleanup.remoteRootRemoved, relayStopState: relayCleanup.relayStopState,
      rootReceiptRecovered: relayCleanup.rootReceiptRecovered, pid: relayCleanup.pid, portsFree: relayCleanup.portsFree },
    suiteSha256: hash(await readFile(suitePath)), restoreHelperSha256: hash(await readFile(restorePath)),
    remotePythonSha256: hash(Buffer.from(python)), sshTarget: "aliyun", transport: "owned foreground ControlMaster + one fail-closed managed read-only command",
    gates: { strictHostKeyChecking: true, noDirectFallback: true, oneReadOnlyCommand: true, noServiceSignal: true,
      noConfigWrite: true, noStaticExchange: true, noProduction8451Mutation: true },
  });
  const transport = await startOwnedSshControlMaster(context, {
    binary: "/usr/bin/ssh", target: "aliyun", configPath: "/home/hyf/.ssh/config",
    knownHostsPath: "/home/hyf/.ssh/known_hosts", cwd: repoRoot,
  });
  const remoteCommand = `sudo -n python3 -c ${shellQuote(python)} ${shellQuote(JSON.stringify(payload))}`;
  const child = await transport.spawnManaged("inspect-current-isolated443-after-failure", remoteCommand, {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
  });
  const stdout = [], stderrObserver = createSshStageObserver(performance.now(), 8, 16_384);
  let stdoutBytes = 0, stderrBytes = 0, spawnError = null;
  child.once("error", error => { spawnError = error.message; });
  child.stdout.on("data", chunk => { stdoutBytes += chunk.length; if (stdoutBytes <= 64 * 1024) stdout.push(Buffer.from(chunk)); });
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; stderrObserver.push(chunk); });
  let close = null;
  child.once("close", (code, signal) => { close = { code, signal }; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void context.stopOwned("inspect-current-isolated443-after-failure").catch(() => undefined); }, 35_000);
  try { await waitFor(() => close !== null || spawnError !== null, 40_000, "read-only current 443 owner inspection", 25, context.abortSignal); }
  finally { clearTimeout(timer); }
  const markers = stderrObserver.finish();
  let remote = null;
  if (close?.code === 0 && stdoutBytes <= 64 * 1024) {
    try { remote = JSON.parse(Buffer.concat(stdout).toString("utf8").trim()); } catch {}
  }
  const summary = { status: "READ_ONLY_POST_RESTORE_INSPECTION", parentRunRoot, restoreRunRoot, restoredPid, childPid: child.pid,
    childClose: close, spawnError: spawnError ? "spawn-error" : null, timedOut, stdoutBytes, stderrBytes,
    markers, remote: remote ?? { state: "no-valid-remote-projection" },
    production8451Touched: false, mutationsAttempted: false };
  await context.writeArtifactJson("current-test443-owner-inspection.json", summary);
  assert.equal(timedOut, false, "read-only SSH inspection must finish within bound");
  assert.equal(spawnError, null);
  assert.deepEqual(close, { code: 0, signal: null });
  assert.equal(markers.valid, true);
  assert.deepEqual(markers.markers.map(row => row.stage), ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"]);
  assert.equal(remote?.inspection, "completed");
  assert.equal(remote.sidecarState, "original-exact");
  assert.equal(remote.sidecar443.listener.query, "ok");
  assert.deepEqual(remote.sidecar443.listener.pids, [restoredPid]);
  assert.equal(remote.originalProcess.pid, restoredPid);
  assert.equal(remote.originalProcess.exeMatches, true);
  assert.equal(remote.originalProcess.euid, 0);
  assert.equal(remote.originalProcess.originalArgvExact, true);
  assert.ok(Number.isSafeInteger(remote.originalProcess.starttime) && remote.originalProcess.starttime > 0);
  assert.equal(remote.originalConfigFile.sha256, expected.originalConfigSha256);
  assert.equal(remote.candidateRoot.state, "absent", "the exact run-owned candidate root must be absent after restore");
  assert.equal(remote.candidateProcess.state, "absent");
  assert.equal(remote.candidateConfigFile.state, "absent");
  assert.equal(remote.production8451.listener.query, "ok");
  assert.deepEqual(remote.production8451.listener.pids, [expected.productionPid]);
  assert.equal(remote.production8451.owner.pid, expected.productionPid);
  assert.equal(remote.production8451.owner.exeMatches, true);
  assert.equal(remote.production8451.owner.argvCaddyRun, true);
  assert.equal(remote.production8451.owner.configPath, expected.productionConfigPath);
  assert.equal(remote.production8451.owner.euid, 996);
  assert.equal(remote.production8451.configFile.sha256, expected.productionConfigSha256);
  assert.equal(remote.production8451.configMatchesExpected, true);
  assert.equal(remote.production8451.listenerMatchesExpected, true);
  assert.equal(remote.staticRoot.fileCount, expected.staticFileCount);
  assert.equal(remote.staticRoot.treeSha256, expected.staticTreeSha256);
  for (const portProjection of [remote.forward32552, remote.relayDynamicPorts["43849"], remote.relayDynamicPorts["37717"]]) {
    assert.equal(portProjection.query, "ok");
    assert.equal(portProjection.lineCount, 0);
    assert.deepEqual(portProjection.pids, []);
  }
  assert.equal(remote.relayRootState, "absent");
  assert.equal(remote.relayProcess.state, "absent");
  assert.equal(remote.production8451Touched, false);
  assert.equal(remote.mutationsAttempted, false);
  console.log(JSON.stringify({ runRoot: context.runRoot, ownerPid: process.pid, sshPid: child.pid,
    status: summary.status, sidecarState: remote.sidecarState, restoredPid, restoredStarttime: remote.originalProcess.starttime,
    productionOwnerMatches: remote.production8451.configMatchesExpected && remote.production8451.listenerMatchesExpected,
    candidateRootState: remote.candidateRoot.state, staticTreeSha256: remote.staticRoot?.treeSha256 ?? null, relayRootState: remote.relayRootState,
    mutationsAttempted: false }));
  return summary;
});
