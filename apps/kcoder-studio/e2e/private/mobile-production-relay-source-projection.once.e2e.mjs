import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { repoRoot, runE2E } from "../harness/run-context.mjs";
import { createOwnedSshDispatcher, runOwnedSshOperation, startOwnedSshControlMaster } from "../harness/owned-ssh-control-master.mjs";

const NODE_PIN = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const SSH_BIN = "/usr/bin/ssh";
const RUN_FLAG = "KCODER_E2E_PUBLIC_RELAY_SOURCE_PROJECTION_ONCE";
const SERVER_PATH = "/opt/kcoder-relay/src/server.mjs";
const SERVER_SHA256 = "00b67c45f48fd3759c744bc8ab38d0980b3c31765c279d71b0f81557991ce499";
const SERVER_BYTES = 54_992;
const OPTIMIZED_SOURCE_PINS = Object.freeze({
  "src/server.mjs": "9e0297d571e3962c5b88bea2971dd3924e253a84b03fad034960b0be9a97d455",
  "src/transport.mjs": "6a56287394425ce297a2c87534c739645cd85eb99efc707ffe9d1ce6a8277d7c",
  "src/http-get-pool.mjs": "1ac7a3e9806c0e57a86300497139d34be9c6143d68d1b18f57e49ba72742c923",
  "src/server-routing.mjs": "b0f4c2519d75c464227d4b2d7bbc5b9d8cdc19e26690daf0fb1644d13893c4bb",
  "src/config.mjs": "b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335",
  "src/registration-store.mjs": "ea310dd7a31a4e1d4f8a62ecedff84dba219cefa08ab64b89fd38c4fb186cf78",
  "package.json": "9c9899c86c106b0ccbce4c635f6a8df0128559ab5bcedff5ed72cca84db095cb",
});
const WS_VERSION = "8.22.0";
const WS_TREE_SHA256 = "3271cba667fdc4721ed9fe275eae78247d07ded06cddd52b824359880aeb4c1d";

assert.equal(process.execPath, NODE_PIN);
assert.equal(process.version, "v22.17.0");

function requiredAbsolute(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.startsWith("/"), name + " must be an absolute path");
  return value;
}

async function checkPrivateInput(path) {
  const info = await lstat(path);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.nlink, 1);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
}

function sourceProjectionProgram() {
  return [
    "import hashlib,json,os,re,stat,subprocess",
    "root='/opt/kcoder-relay'; server=root+'/src/server.mjs'",
    "candidate=" + JSON.stringify(OPTIMIZED_SOURCE_PINS),
    "paths=sorted(candidate)",
    "def read_file(path,limit=1048576):",
    " try: info=os.lstat(path)",
    " except FileNotFoundError: return {'path':path,'exists':False}",
    " if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size>limit: return {'path':path,'exists':True,'safeFile':False,'bytes':info.st_size}",
    " fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)",
    " try:",
    "  opened=os.fstat(fd)",
    "  if (opened.st_dev,opened.st_ino)!=(info.st_dev,info.st_ino): return {'path':path,'exists':True,'safeFile':False,'bytes':info.st_size}",
    "  data=bytearray()",
    "  while True:",
    "   chunk=os.read(fd,65536)",
    "   if not chunk: break",
    "   data.extend(chunk)",
    "   if len(data)>limit: return {'path':path,'exists':True,'safeFile':False,'bytes':len(data)}",
    "  after=os.fstat(fd); again=os.lstat(path)",
    "  stable=(opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns,opened.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)==(again.st_dev,again.st_ino,again.st_size,again.st_mtime_ns,again.st_ctime_ns)",
    "  return {'path':path,'exists':True,'safeFile':True,'stable':stable,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'uid':opened.st_uid,'gid':opened.st_gid,'mode':format(stat.S_IMODE(opened.st_mode),'04o'),'data':bytes(data)}",
    " finally: os.close(fd)",
    "def project(rel):",
    " try: row=read_file(root+'/'+rel)",
    " except OSError as exc: return {'path':root+'/'+rel,'exists':None,'errorType':type(exc).__name__}",
    " if row.get('safeFile'): row['matchesOptimizedCandidate']=row['sha256']==candidate[rel]",
    " return row",
    "def identity():",
    " unit=subprocess.run(['/usr/bin/systemctl','show','kcoder-relay.service','--property=ActiveState','--property=SubState','--property=MainPID'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=4,check=False)",
    " fields=dict(line.split('=',1) for line in unit.stdout.splitlines() if '=' in line); pid=int(fields.get('MainPID','0'))",
    " assert unit.returncode==0 and fields.get('ActiveState')=='active' and fields.get('SubState')=='running' and pid>1",
    " proc='/proc/'+str(pid); status=open(proc+'/status',encoding='utf-8').read(); euid=int(re.search(r'^Uid:\\s+\\d+\\s+(\\d+)',status,re.M).group(1))",
    " argv_bytes=open(proc+'/cmdline','rb').read(); argv=[os.fsdecode(part) for part in argv_bytes.split(bytes([0])) if part]",
    " exe=os.path.realpath(proc+'/exe'); stat_fields=open(proc+'/stat',encoding='utf-8').read(); tail=stat_fields[stat_fields.rfind(')')+2:].split()",
    " assert euid==995 and exe.endswith('/node') and argv.count(server)==1 and len(tail)>19",
    " return {'pid':pid,'euid':euid,'startTicks':tail[19],'exe':exe,'serverArgvCount':1,'argvSha256':hashlib.sha256(argv_bytes).hexdigest(),'proc':proc}",
    "def ws_runtime(proc):",
    " try:",
    "  version=subprocess.run([proc+'/exe','--version'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=4,check=False)",
    "  code='const{createRequire}=require(\\\"node:module\\\");const r=createRequire(\\\"/opt/kcoder-relay/src/server.mjs\\\");const p=r.resolve(\\\"ws\\\");const q=r.resolve(\\\"ws/package.json\\\");const f=require(\\\"node:fs\\\");const j=JSON.parse(f.readFileSync(q,\\\"utf8\\\"));console.log(JSON.stringify({entry:p,packagePath:q,version:j.version}));'",
    "  probe=subprocess.run([proc+'/exe','-e',code],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=4,check=False)",
    "  if version.returncode!=0 or probe.returncode!=0: return {'nodeVersion':None,'wsProbeOk':False,'probeExitCode':probe.returncode}",
    "  parsed=json.loads(probe.stdout.strip()); ws_entry=os.path.realpath(parsed['entry']); package_path=os.path.realpath(parsed['packagePath']); ws_root=os.path.dirname(package_path)",
    "  if not ws_entry.startswith(ws_root+os.sep) or not os.path.isfile(ws_entry): return {'nodeVersion':version.stdout.strip(),'wsProbeOk':False}",
    "  package=read_file(package_path,262144)",
    "  if not package.get('safeFile'): return {'nodeVersion':version.stdout.strip(),'wsProbeOk':False}",
    "  package_json=json.loads(package['data'].decode('utf-8')); rows=[]; total=0",
    "  def walk(directory):",
    "   nonlocal total",
    "   if len(rows)>512: raise ValueError('tree-limit')",
    "   for entry in sorted(os.scandir(directory),key=lambda item:item.name):",
    "    info=entry.stat(follow_symlinks=False)",
    "    if stat.S_ISLNK(info.st_mode): raise ValueError('symlink')",
    "    if stat.S_ISDIR(info.st_mode): walk(entry.path)",
    "    elif stat.S_ISREG(info.st_mode):",
    "     row=read_file(entry.path,10485760)",
    "     if not row.get('safeFile') or not row.get('stable'): raise ValueError('unsafe-file')",
    "     total+=row['bytes']; rows.append((os.path.relpath(entry.path,ws_root).replace(os.sep,'/'),row['sha256']))",
    "     if total>20971520: raise ValueError('tree-bytes-limit')",
    "    else: raise ValueError('special-file')",
    "  walk(ws_root); rows.sort()",
    "  digest=hashlib.sha256(''.join(path+'\\0'+sha+'\\n' for path,sha in rows).encode()).hexdigest()",
    "  return {'nodeVersion':version.stdout.strip(),'exe':os.path.realpath(proc+'/exe'),'wsProbeOk':True,'wsEntry':ws_entry,'wsPackageRoot':ws_root,'wsVersion':package_json.get('version'),'wsFileCount':len(rows),'wsPackageTreeSha256':digest}",
    " except Exception as exc: return {'nodeVersion':None,'wsProbeOk':False,'errorType':type(exc).__name__}",
    "before=identity(); rows=[project(path) for path in paths]; runtime=ws_runtime(before['proc']); after_rows=[project(path) for path in paths]; after=identity()",
    "stable_files=all(a.get('exists')==b.get('exists') and a.get('sha256')==b.get('sha256') and (not a.get('exists') or (a.get('stable') is True and b.get('stable') is True)) for a,b in zip(rows,after_rows))",
    "source_data={row['path']:row.get('data',b'') for row in rows}",
    "server_bytes=source_data.get(server,b''); transport_bytes=source_data.get(root+'/src/transport.mjs',b'')",
    "package_row=next((row for row in rows if row['path']==root+'/package.json'),{})",
    "package_json=json.loads(package_row['data'].decode('utf-8')) if package_row.get('safeFile') else {}",
    "features={'mobileMountProof':b'kcoder-mobile-mount-v1' in server_bytes,'getPoolImport':b'http-get-pool.mjs' in server_bytes,'getPoolModulePresent':next((row.get('exists') is True for row in rows if row['path']==root+'/src/http-get-pool.mjs'),False),'transportEofDrain':b'RELAY_EOF_DRAIN_TIMEOUT_MS' in transport_bytes}",
    "public_rows=[{k:v for k,v in row.items() if k!='data'} for row in rows]",
    "print(json.dumps({'state':'READONLY_SOURCE_PROJECTION','service':{'active':True,'pid':before['pid'],'euid':before['euid'],'startTicks':before['startTicks'],'exe':before['exe'],'serverArgvCount':before['serverArgvCount'],'argvSha256':before['argvSha256']},'sourceFiles':public_rows,'packageMetadata':{'exists':package_row.get('exists'),'sha256':package_row.get('sha256'),'name':package_json.get('name'),'version':package_json.get('version'),'type':package_json.get('type'),'wsDependency':package_json.get('dependencies',{}).get('ws')},'nodeAndWs':runtime,'features':features,'stableBeforeAfter':before==after and stable_files,'remoteWrites':False,'serviceChanged':False,'sourceContentsPersisted':False},separators=(',',':')))",
  ].join("\n");
}

if (process.argv[2] === "--static-check") {
  assert.equal(process.argv.length, 3);
  const check = spawnSync("/usr/bin/python3", ["-c", "import sys; compile(sys.stdin.read(), '<relay-source-projection>', 'exec')"], {
    input: sourceProjectionProgram(), encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.equal(check.status, 0, "remote source projection Python syntax failed");
  assert.equal(check.error, undefined);
  process.stdout.write(JSON.stringify({ state: "STATIC_PASS", remoteActions: false, secretReads: false }) + "\n");
} else {
assert.equal(process.argv[2], "--production-relay-source-readonly");
assert.equal(process.argv.length, 3);
assert.equal(process.env[RUN_FLAG], "1");
await runE2E(import.meta.url, {
  testId: "mobile-production-relay-source-projection-readonly",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "read-only projection of the running Relay process, server source import closure, package metadata, and Node/ws resolution; no registration store, config values, environment values, service changes, or writes",
}, async context => {
  const configPath = requiredAbsolute("KCODER_E2E_PUBLIC_SSH_CONFIG");
  const knownHostsPath = requiredAbsolute("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS");
  await Promise.all([configPath, knownHostsPath].map(checkPrivateInput));
  const target = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
  assert.match(target, /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/);
  const directOptions = ["-F", configPath, "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ControlMaster=no",
    "-o", "ControlPath=none", "-o", "ConnectTimeout=15"];
  const managed = await startOwnedSshControlMaster(context, {
    binary: SSH_BIN, target, configPath, knownHostsPath, cwd: repoRoot,
  });
  const dispatcher = createOwnedSshDispatcher({ primaryContext: context, managedTransport: managed,
    binary: SSH_BIN, target, directOptions });
  const result = await runOwnedSshOperation({
    context, dispatcher, label: "production-relay-source-readonly-projection", cwd: repoRoot,
    command: "sudo -n python3 -", stdin: Buffer.from(sourceProjectionProgram()),
    timeoutMs: 15_000, maxStdoutBytes: 4096, maxStderrBytes: 2048,
  });
  const projection = JSON.parse(result.stdout.toString("utf8").trim());
  await context.writeArtifactJson("production-relay-source-projection.json", projection);
  assert.equal(projection.state, "READONLY_SOURCE_PROJECTION");
  assert.equal(projection.service.active, true);
  const source = projection.sourceFiles.find(row => row.path === SERVER_PATH);
  assert.ok(source);
  assert.equal(source.bytes, SERVER_BYTES);
  assert.equal(source.sha256, SERVER_SHA256);
  assert.equal(source.matchesOptimizedCandidate, false);
  assert.equal(projection.nodeAndWs.wsProbeOk, true);
  assert.equal(projection.nodeAndWs.wsVersion, WS_VERSION);
  assert.equal(projection.nodeAndWs.wsPackageTreeSha256, WS_TREE_SHA256);
  assert.equal(projection.stableBeforeAfter, true);
  assert.equal(projection.remoteWrites, false);
  assert.equal(projection.serviceChanged, false);
  return projection;
});
}
