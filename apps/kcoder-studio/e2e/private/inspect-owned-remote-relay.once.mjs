import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildMarkedPythonSource, createSshStageObserver, startOwnedSshControlMaster } from "../harness/owned-ssh-control-master.mjs";

assert.equal(process.version, "v22.17.0");
const parentRunRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-071249.150Z");
const parentArtifact = resolve(parentRunRoot, "artifacts/remote-relay-ready.json");
const sshTarget = "aliyun";
const sshConfig = "/home/hyf/.ssh/config";
const knownHosts = "/home/hyf/.ssh/known_hosts";
const relay = JSON.parse(await readFile(parentArtifact, "utf8"));
assert.equal(relay.runId, "bc941b1bd1829a03da112192");
assert.equal(relay.runRoot, "/tmp/kc-phone-ux-relay-bc941b1bd1829a03da112192");
assert.equal(relay.pid, 279975);
assert.deepEqual(relay.ports, { ingress: 32552, control: 44689, proxy: 40923 });

const inspectPython = String.raw`import json,os,pathlib,re,stat,subprocess,sys
p=json.loads(sys.argv[1]); root=pathlib.Path(p['runRoot']); result={'inspectionCompleted':True}
def private_file(path, uid):
 q=os.lstat(path)
 return stat.S_ISREG(q.st_mode) and not stat.S_ISLNK(q.st_mode) and q.st_uid==uid and q.st_nlink==1 and stat.S_IMODE(q.st_mode)==0o600
if not os.path.lexists(root):
 result['rootState']='absent'
else:
 st=os.lstat(root)
 root_shape=stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==p['euid'] and stat.S_IMODE(st.st_mode)==0o700
 result['rootState']='present-owned-shape' if root_shape else 'present-unexpected-shape'
 if root_shape:
  owner_path=root/'.owner.json'
  try:
   if private_file(owner_path,st.st_uid):
    owner=json.loads(owner_path.read_bytes())
    result['ownerMarkerMatches']=owner=={'version':1,'runId':p['runId'],'uid':st.st_uid,'dev':st.st_dev,'ino':st.st_ino}
   else: result['ownerMarkerMatches']=False
  except (OSError,ValueError): result['ownerMarkerMatches']=False
result['recordedProcess']={'state':'absent','pid':p['pid']}
proc=pathlib.Path('/proc')/str(p['pid'])
try:
 raw=(proc/'stat').read_text(); tail=raw[raw.rfind(')')+2:].split()
 uidline=next(x for x in (proc/'status').read_text().splitlines() if x.startswith('Uid:')).split()
 argv=[x.decode() for x in (proc/'cmdline').read_bytes().split(b'\0') if x]
 ex=os.stat(proc/'exe'); cwd=os.path.realpath(proc/'cwd'); exe=os.path.realpath(proc/'exe')
 actual={'starttime':int(tail[19]),'euid':int(uidline[2]),'argv':argv,'cwd':cwd,'exe':exe,'exeDev':ex.st_dev,'exeIno':ex.st_ino,'pgid':os.getpgid(p['pid'])}
 expected={k:p[k] for k in ('starttime','euid','argv','cwd','exe','exeDev','exeIno','processGroup')}
 expected['pgid']=expected.pop('processGroup')
 result['recordedProcess']={'state':'exact-match' if actual==expected else 'pid-present-different-identity','pid':p['pid']}
except FileNotFoundError: pass
except (ProcessLookupError,PermissionError,OSError): result['recordedProcess']={'state':'present-or-unreadable','pid':p['pid']}
ports=[]
for port in (p['ports']['ingress'],p['ports']['control'],p['ports']['proxy']):
 q=subprocess.run(['ss','-H','-ltnp',f'sport = :{port}'],capture_output=True,text=True,timeout=3)
 if q.returncode: raise RuntimeError('listener-query-failed')
 listeners=sorted({int(x) for x in re.findall(r'pid=(\d+),',q.stdout)})
 ports.append({'port':port,'listenerCount':len(listeners),'listenerPids':listeners})
result['ports']=ports
print(json.dumps(result,separators=(',',':')))`;

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

await runE2E(import.meta.url, {
  testId: "public-rust-baseline-remote-relay-readonly-inspect",
  tier: "manual-live",
  modelPolicy: "one bounded read-only SSH inspection of the exact prior Relay run identity and three listener ports; no remote mutation or Browser",
  cleanupTimeoutMs: 45_000,
}, async context => {
  const relayArtifactSha256 = createHash("sha256").update(await readFile(parentArtifact)).digest("hex");
  const scriptSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
  const transport = await startOwnedSshControlMaster(context, {
    binary: "/usr/bin/ssh", target: sshTarget, configPath: sshConfig, knownHostsPath: knownHosts, cwd: repoRoot,
  });
  const request = {
    runRoot: relay.runRoot, runId: relay.runId, pid: relay.pid, processGroup: relay.processGroup,
    euid: relay.euid, starttime: relay.starttime, exe: relay.exe, exeDev: relay.exeDev, exeIno: relay.exeIno,
    argv: relay.argv, cwd: relay.cwd, ports: relay.ports,
  };
  const command = `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(inspectPython))} ${shellQuote(JSON.stringify(request))}`;
  const child = await transport.spawnManaged("inspect-exact-owned-remote-relay", command, {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
  });
  const observer = createSshStageObserver(performance.now());
  const out = [];
  let bytes = 0, close = null, spawnError = null;
  child.once("error", error => { spawnError = error; });
  child.once("close", (code, signal) => { close = { code, signal }; });
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes <= 32_768) out.push(Buffer.from(chunk)); });
  child.stderr.on("data", chunk => observer.push(chunk));
  await waitFor(() => close !== null || spawnError !== null, 15_000, "read-only Relay owner inspection", 25, context.abortSignal);
  const stage = observer.finish();
  assert.equal(spawnError, null);
  assert.deepEqual(close, { code: 0, signal: null });
  assert.ok(bytes > 0 && bytes <= 32_768);
  assert.equal(stage.valid, true);
  assert.deepEqual(stage.markers.map(x => x.stage), ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"]);
  const result = JSON.parse(Buffer.concat(out).toString("utf8"));
  await context.writeArtifactJson("remote-relay-readonly-inspection.json", {
    parentRunRoot, parentRelayArtifactSha256: relayArtifactSha256, scriptSha256, stageMarkers: stage.markers, result,
  });
  return result;
});
