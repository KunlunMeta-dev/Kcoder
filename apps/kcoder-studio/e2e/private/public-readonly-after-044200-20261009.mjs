import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const outputDir = resolve(repoRoot, "target/private-phone-ux-validation/public-readonly-after-044200-20261009");
const suitePath = resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs");
const suiteSha256 = "f3a2d5a4b2433035252c2de8039dcfec8469662f78587affdf997e1ee0ddabed";
const sidecarConfigPath = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile";
const sidecarConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const historicalSidecarPid = 278586;
const productionConfigPath = "/etc/caddy/Caddyfile";
const productionConfigSha256 = "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511";
const productionPid = 200738;
const staticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const staticTreeSha256 = "8f414deda3c4aa5807078dab4ee6520b4cd96298e34dfc40368e06ff7371a92e";
const staticFileCount = 37;

const remoteScript = String.raw`import hashlib,json,os,pathlib,re,subprocess
SIDE='/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile'
SIDE_SHA='520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c'
PROD='/etc/caddy/Caddyfile'
PROD_SHA='05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511'
STATIC='/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root'
OWNED_ROOT='__OWNED_ROUTE_ROOT__'
sha=lambda b:hashlib.sha256(b).hexdigest()
def file_sha(path):
 p=pathlib.Path(path)
 try:
  st=p.lstat()
  if p.is_symlink() or not p.is_file(): return {'present':True,'regular':False,'sha256':None}
  return {'present':True,'regular':True,'sha256':sha(p.read_bytes()),'uid':st.st_uid,'mode':st.st_mode&0o777}
 except FileNotFoundError: return {'present':False,'regular':False,'sha256':None}
def listeners(port):
 cp=subprocess.run(['ss','-H','-ltnp','sport = :'+str(port)],capture_output=True,text=True,timeout=5,check=False)
 text=cp.stdout
 pids=sorted({int(x) for x in re.findall(r'pid=(\d+),',text)})
 return {'exitCode':cp.returncode,'present':bool(text.strip()),'lineCount':len([x for x in text.splitlines() if x.strip()]),'pids':pids,'stdoutBytes':len(cp.stdout.encode())}
def proc(pid,config):
 q=pathlib.Path('/proc')/str(pid)
 try:
  av=q.joinpath('cmdline').read_bytes().split(b'\0')
  if av and not av[-1]: av=av[:-1]
  argv=[os.fsdecode(x) for x in av]
  status=q.joinpath('status').read_text()
  uid=re.search(r'^Uid:\s+(\d+)\s+(\d+)',status,re.M)
  exe=os.readlink(q/'exe')
  configMatch=any(argv[i]=='--config' and i+1<len(argv) and argv[i+1]==config for i in range(len(argv)-1))
  exactArgv=argv==['/usr/bin/caddy','run','--config',config,'--adapter','caddyfile']
  return {'pid':pid,'present':True,'exe':exe,'exeMatches':exe=='/usr/bin/caddy','euid':int(uid.group(2)) if uid else None,'configArgMatches':configMatch,'exactArgvMatches':exactArgv,'argvSha256':sha(b'\0'.join(av))}
 except FileNotFoundError: return {'pid':pid,'present':False}
def config_projection(path,expected):
 row=file_sha(path); row['expectedShaMatches']=row.get('sha256')==expected
 return row
try:
 pathlib.Path(OWNED_ROOT).lstat(); owned_root_absent=False
except FileNotFoundError:
 owned_root_absent=True
except Exception:
 owned_root_absent=False
side_cfg=config_projection(SIDE,SIDE_SHA); prod_cfg=config_projection(PROD,PROD_SHA)
side_l=listeners(443); prod_l=listeners(8451); fwd_l=listeners(32552)
side_rows=[proc(pid,SIDE) for pid in side_l['pids']]
prod_rows=[proc(pid,PROD) for pid in prod_l['pids']]
adapt=None; adapt_error=None; roots=set(); rows=[]; tree_sha=None; tree_error=None
try:
 cp=subprocess.run(['/usr/bin/caddy','adapt','--config',SIDE,'--adapter','caddyfile'],capture_output=True,timeout=8,check=True)
 doc=json.loads(cp.stdout)
 def visit(node):
  if isinstance(node,dict):
   if node.get('handler') in ('vars','file_server'):
    root=node.get('root')
    if isinstance(root,str) and root.startswith('/'): roots.add(root)
   for value in node.values(): visit(value)
  elif isinstance(node,list):
   for value in node: visit(value)
 visit(doc); adapt={'exitCode':cp.returncode,'staticRootsMatch':roots=={STATIC}}
 root=pathlib.Path(STATIC); rst=root.lstat()
 if root.is_symlink() or not root.is_dir(): raise RuntimeError('static-root-type')
 for current,dirs,files in os.walk(root,topdown=True,followlinks=False):
  dirs.sort(); files.sort()
  for name in list(dirs)+files:
   path=pathlib.Path(current)/name; st=path.lstat()
   if path.is_symlink(): raise RuntimeError('static-symlink')
   if name in dirs:
    if not path.is_dir(): raise RuntimeError('static-dir-type')
   else:
    if not path.is_file(): raise RuntimeError('static-file-type')
    h=hashlib.sha256()
    with open(path,'rb') as stream:
     for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
    rows.append([path.relative_to(root).as_posix(),st.st_size,str(st.st_mtime_ns),h.hexdigest()])
 rows.sort(); tree_sha=sha(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode())
except Exception as exc:
 adapt_error=type(exc).__name__
out={'schemaVersion':1,'ownedRouteRoot':{'absent':owned_root_absent},'sidecarConfig':side_cfg,'productionConfig':prod_cfg,
 'sidecar443':{'listener':side_l,'owners':side_rows,'historicalPidMatches':side_l['pids']==[278586]},
 'production8451':{'listener':prod_l,'owners':prod_rows,'expectedPidMatches':prod_l['pids']==[200738]},
 'reverseForward32552':{'listener':fwd_l,'free':not fwd_l['present']},
 'staticRoot':{'fileCount':len(rows),'expectedFiles':37,'treeSha256':tree_sha,'expectedTreeMatches':tree_sha=='8f414deda3c4aa5807078dab4ee6520b4cd96298e34dfc40368e06ff7371a92e','adapt':adapt,'errorKind':adapt_error}}
print(json.dumps(out,separators=(',',':')))
`;

const argv = ["ssh", "-T", "-F", "/home/hyf/.ssh/config", "-o", "UserKnownHostsFile=/home/hyf/.ssh/known_hosts",
  "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
  "-o", "ConnectTimeout=15", "aliyun", "sudo -n python3 -"];

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const rawWrite = async (path, bytes) => {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
};

await runE2E(import.meta.url, {
  testId: "public-readonly-after-044200-20261009", tier: "manual-live", retainSuccessLogs: true,
  bodyAbortTimeoutMs: 60_000, cleanupTimeoutMs: 60_000,
  modelPolicy: "Read-only Caddy owner/config/static-root preflight; no HTTP business request or mutation",
}, async context => {
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const directoryInfo = await stat(outputDir);
  assert.ok(directoryInfo.isDirectory() && directoryInfo.uid === process.getuid() && (directoryInfo.mode & 0o777) === 0o700);
  const suiteBytes = await readFile(suitePath);
  assert.equal(hash(suiteBytes), suiteSha256, "approved suite source changed before read-only preflight");
  const ownedRouteRoot = `/tmp/kc-phone-ux-rust-baseline-${createHash("sha256").update(context.seed).digest("hex").slice(0, 24)}`;
  const actualRemoteScript = remoteScript.replace("__OWNED_ROUTE_ROOT__", ownedRouteRoot);
  assert.ok(!actualRemoteScript.includes("__OWNED_ROUTE_ROOT__"));
  const remoteScriptPath = resolve(outputDir, "readonly-caddy-static-projection.py");
  await rawWrite(remoteScriptPath, Buffer.from(actualRemoteScript));
  await context.writeArtifactJson("preflight-input.json", {
    suitePath, suiteSha256, remoteScriptPath, remoteScriptSha256: hash(Buffer.from(actualRemoteScript)),
    ownedRouteRootDerivedFromCurrentRunSeed: true,
    argv, timeoutMs: 45_000,
    expected: { sidecarConfigPath, sidecarConfigSha256, historicalSidecarPid, productionConfigPath,
      productionConfigSha256, productionPid, staticRoot, staticFileCount, staticTreeSha256, reverseForwardPort: 32552 },
    operation: "single readonly sudo python projection; no service signal, validate/start, directory mutation, HTTP, Browser, Gateway, Relay, or Provider",
  });
  console.log(JSON.stringify({ stage: "ssh-preflight-starting", runRoot: context.runRoot, ownerPid: process.pid }));
  const label = "public-readonly-caddy-preflight-ssh";
  const child = context.spawnOwned(label, "ssh", argv.slice(1), {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]), stdin: "pipe",
  });
  const stdoutParts = [], stderrParts = [];
  let stdoutBytes = 0, stderrBytes = 0, closeInfo = null, spawnError = null, timedOut = false;
  const cap = 128 * 1024;
  const collect = (parts, chunk, side) => {
    const bytes = Buffer.from(chunk);
    if (side === "stdout") stdoutBytes += bytes.length; else stderrBytes += bytes.length;
    const count = side === "stdout" ? stdoutBytes : stderrBytes;
    if (count <= cap) parts.push(bytes);
    else void context.stopOwned(label).catch(() => {});
  };
  child.stdout.on("data", chunk => collect(stdoutParts, chunk, "stdout"));
  child.stderr.on("data", chunk => collect(stderrParts, chunk, "stderr"));
  child.once("error", error => { spawnError = error; });
  child.once("close", (code, signal) => { closeInfo = { code, signal }; });
  child.stdin.on("error", () => {});
  child.stdin.end(actualRemoteScript);
  const startedAt = performance.now();
  try { await waitFor(() => closeInfo !== null || spawnError !== null, 45_000, "readonly Caddy preflight SSH", 25, context.abortSignal); }
  catch { timedOut = true; }
  if (closeInfo === null) {
    await context.stopOwned(label).catch(() => {});
    try { await waitFor(() => closeInfo !== null, 5_000, "readonly SSH terminal", 25); } catch {}
  }
  const stdout = Buffer.concat(stdoutParts), stderr = Buffer.concat(stderrParts);
  const stdoutPath = resolve(outputDir, "ssh.stdout.raw");
  const stderrPath = resolve(outputDir, "ssh.stderr.raw");
  await rawWrite(stdoutPath, stdout);
  await rawWrite(stderrPath, stderr);
  const terminal = closeInfo !== null;
  let projection = null, parseError = null;
  if (terminal && closeInfo.code === 0 && stdout.length <= cap) {
    try { projection = JSON.parse(stdout.toString("utf8")); } catch { parseError = "invalid-json"; }
  }
  const sidecar = projection?.sidecar443;
  const production = projection?.production8451;
  const statics = projection?.staticRoot;
  const exactCurrent = Boolean(projection &&
    projection.sidecarConfig?.expectedShaMatches && sidecar?.listener?.present &&
    sidecar.owners?.length === 1 && sidecar.owners[0]?.exeMatches && sidecar.owners[0]?.euid === 0 &&
    sidecar.owners[0]?.configArgMatches && projection.productionConfig?.expectedShaMatches &&
    production?.listener?.present && production.owners?.length === 1 && production.owners[0]?.exeMatches &&
    production.owners[0]?.euid === 996 && production.owners[0]?.configArgMatches &&
    projection.reverseForward32552?.free && statics?.fileCount === staticFileCount &&
    statics?.expectedTreeMatches && statics?.adapt?.staticRootsMatch && projection?.ownedRouteRoot?.absent === true);
  const historicalIdentityMatch = Boolean(sidecar?.historicalPidMatches && production?.expectedPidMatches);
  const status = !terminal || closeInfo?.code !== 0 || timedOut || !projection ? "UNVERIFIED" :
    exactCurrent && historicalIdentityMatch ? "PASS" : "UNVERIFIED";
  const result = {
    status, operation: "readonly-only", ownerPid: process.pid, childPid: child.pid ?? null,
    exitCode: closeInfo?.code ?? child.exitCode ?? null, signal: closeInfo?.signal ?? child.signalCode ?? null,
    terminalObserved: terminal, timedOut, spawnErrorName: spawnError?.name ?? null,
    elapsedMs: performance.now() - startedAt, stdoutBytes, stderrBytes,
    stdoutSha256: hash(stdout), stderrSha256: hash(stderr), stdoutPath, stderrPath, parseError,
    exactCurrentIdentityAndStaticMatch: exactCurrent,
    historicalPidMatch: historicalIdentityMatch,
    projection,
  };
  await context.writeArtifactJson("preflight-result.json", result);
  console.log(JSON.stringify({ stage: "ssh-preflight-terminal", runRoot: context.runRoot,
    ownerPid: process.pid, childPid: child.pid ?? null, status, exitCode: result.exitCode, timedOut }));
  assert.equal(terminal, true, "SSH terminal state must be observed; timeout is not remote completion proof");
  assert.equal(closeInfo.code, 0, "readonly SSH projection must exit successfully");
  assert.equal(status, "PASS", "all exact current/historical Caddy, forward, and static-root gates must match");
  return result;
});
