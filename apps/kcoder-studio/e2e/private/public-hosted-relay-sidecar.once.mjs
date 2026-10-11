// Private adapter for the one hosted Relay run. It uses the existing exact-owner
// stop/wait and restore helpers; no command runs until the exported functions are called.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { removeRoutesOnlyMarker }
  from "../suites/mobile/routes-only-sidecar-config.candidate.mjs";
import { stopAndWaitForOriginalSidecarOnce }
  from "../harness/single-ssh-sidecar-stop-wait.mjs";
import { restoreRoutesOnlySidecarOnce }
  from "../harness/single-ssh-sidecar-restore.mjs";
import { buildMarkedPythonSource } from "../harness/owned-ssh-control-master.mjs";

export const HOSTED_SIDECAR_PINS = Object.freeze({
  originalConfigPath: "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile",
  originalConfigSha256: "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c",
  expectedOriginalPid: 288005,
  productionConfigPath: "/etc/caddy/Caddyfile",
  productionConfigSha256: "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511",
  productionPid: 200738,
  expectedStaticRoot: "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root",
  expectedStaticFiles: 37,
  ingressPort: 32552,
});

const ROUTE_ANCHOR = "\t@test_gateway_prefix path /g/*";

export function buildHostedSidecarCandidate(base, { marker, targetPort, gatewayId }) {
  assert.equal(typeof base, "string");
  assert.match(marker, /^kc_route_[a-f0-9]{16,64}$/);
  assert.equal(targetPort, HOSTED_SIDECAR_PINS.ingressPort);
  assert.match(gatewayId, /^[a-f0-9]{32}$/);
  assert.equal(base.includes(marker), false, "the owned route marker must be absent from the original config");
  assert.equal(base.split(ROUTE_ANCHOR).length - 1, 1, "the isolated gateway route anchor must be unique");

  const block = [
    `\t# BEGIN ${marker}_routes`,
    `\t@${marker}_register path /_relay/register`,
    `\thandle @${marker}_register {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t}",
    "\t}",
    `\t@${marker}_control path /_relay/control`,
    `\thandle @${marker}_control {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t@${marker}_data path /_relay/data`,
    `\thandle @${marker}_data {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t@${marker}_gateway_0 path /g/${gatewayId} /g/${gatewayId}/*`,
    `\thandle @${marker}_gateway_0 {`,
    `\t\treverse_proxy 127.0.0.1:${targetPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t# END ${marker}_routes`,
    "",
  ].join("\n");
  assert.equal((block.match(/\bpath\s+\/_relay\//g) || []).length, 3);
  assert.equal((block.match(/\bpath\s+\/g\//g) || []).length, 1);
  assert.doesNotMatch(block, /path\s+\/g\/\*/);

  const candidate = base.replace(ROUTE_ANCHOR, `${block}${ROUTE_ANCHOR}`);
  assert.equal(removeRoutesOnlyMarker(candidate, marker), base,
    "removing only this owned route block must restore the original config bytes");
  return { candidate, block, candidateSha256: sha256(candidate), baseSha256: sha256(base), marker, gatewayId };
}

export async function inspectHostedSidecar(context, remoteOutput) {
  const p = HOSTED_SIDECAR_PINS;
  const payload = JSON.stringify({
    sidecarConfigPath: p.originalConfigPath,
    sidecarConfigSha256: p.originalConfigSha256,
    expectedSidecarPid: p.expectedOriginalPid,
    productionConfigPath: p.productionConfigPath,
    productionConfigSha256: p.productionConfigSha256,
    productionPid: p.productionPid,
  });
  const python = `import pathlib,hashlib,json,subprocess,re,os
p=json.loads(${JSON.stringify(payload)})
sha=lambda b:hashlib.sha256(b).hexdigest()
def process(pid,config):
 q=pathlib.Path('/proc')/str(pid); av=q.joinpath('cmdline').read_bytes().split(b'\\0')
 if av and not av[-1]: av=av[:-1]
 uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',q.joinpath('status').read_text(),re.M)
 raw=q.joinpath('stat').read_text(); start=int(raw[raw.rfind(')')+2:].split()[19])
 return dict(pid=pid,exe=os.readlink(q/'exe'),euid=int(uid.group(2)) if uid else None,
   argvConfigMatch=any(av[i]==b'--config' and i+1<len(av) and av[i+1].decode()==config for i in range(len(av)-1)),
   argvSha256=sha(b'\\0'.join(av)),startTicks=start)
def listener(port): return subprocess.check_output(['ss','-H','-ltnp','sport = :'+str(port)],text=True)
def pids(text): return sorted({int(x) for x in re.findall(r'pid=(\\d+),',text)})
cfg=pathlib.Path(p['sidecarConfigPath']); cfgsha=sha(cfg.read_bytes()); assert cfgsha==p['sidecarConfigSha256']
tls=listener(443); sidecarPids=pids(tls); assert tls and len(sidecarPids)==1
sidecarPid=sidecarPids[0]; assert sidecarPid==p['expectedSidecarPid']
sidecar=process(sidecarPid,p['sidecarConfigPath']); assert sidecar['exe']=='/usr/bin/caddy' and sidecar['euid']==0 and sidecar['argvConfigMatch']
prodCfg=pathlib.Path(p['productionConfigPath']); prodsha=sha(prodCfg.read_bytes()); assert prodsha==p['productionConfigSha256']
prod=listener(8451); prodPids=pids(prod); assert prod and prodPids==[p['productionPid']]
production=process(prodPids[0],p['productionConfigPath']); assert production['exe']=='/usr/bin/caddy' and production['euid']==996 and production['argvConfigMatch']
forward=listener(32552); forwardPids=pids(forward); assert len(forwardPids)<=1
if forwardPids: assert 'sshd' in (pathlib.Path('/proc')/str(forwardPids[0])/'comm').read_text()
print(json.dumps(dict(forwardFree=not bool(forward),productionOwners=[production],productionListenerSha256=sha(prod.encode()),
 sidecar=dict(pid=sidecarPid,exeMatches=True,euid=sidecar['euid'],configSha256=cfgsha,argvConfigMatch=True,startTicks=sidecar['startTicks'])),separators=(',',':')))
`;
  const remote = parseObject(await remoteOutput(context, "hosted-sidecar-before", sudoPython(python, []), 20_000));
  const staticRoot = await inspectStaticRoot(context, remoteOutput, {
    configPath: p.originalConfigPath, configSha256: p.originalConfigSha256,
  });
  assert.equal(staticRoot.fileCount, p.expectedStaticFiles);
  assert.equal(remote.forwardFree, true, "test Relay ingress must be free before this once run");
  return { remote, staticRoot };
}

export async function installHostedSidecar(context, transaction, before, {
  remoteOutput, sshTransport, repoRoot, waitFor,
}) {
  const p = HOSTED_SIDECAR_PINS;
  assert.match(transaction.gatewayId || "", /^[a-f0-9]{32}$/);
  const stub = "\t@test_gateway_prefix path /g/*\n";
  const preview = buildHostedSidecarCandidate(stub, {
    marker: transaction.marker, targetPort: p.ingressPort, gatewayId: transaction.gatewayId,
  });
  assert.equal(removeRoutesOnlyMarker(preview.candidate, transaction.marker), stub);
  const anchor = "\t@test_gateway_prefix path /g/*";
  const block = preview.block;
  assert.ok(block.startsWith(`\t# BEGIN ${transaction.marker}_routes\n`));

  const ownerScript = `import json,os,re,stat,sys
root=sys.argv[1]; marker=sys.argv[2]
owner_bytes=(marker+'\\n').encode('utf-8')
parent_fd=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 parent=os.fstat(parent_fd)
 if parent.st_uid!=0 or not stat.S_ISDIR(parent.st_mode) or not (parent.st_mode&stat.S_ISVTX): raise SystemExit(71)
 name=os.path.basename(root)
 if os.path.dirname(root)!='/tmp' or not re.fullmatch(r'kc-phone-ux-rust-baseline-[0-9a-f]{24}',name): raise SystemExit(72)
 os.mkdir(name,0o700,dir_fd=parent_fd); os.fsync(parent_fd)
 root_fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent_fd)
 try:
  root_st=os.fstat(root_fd)
  if not stat.S_ISDIR(root_st.st_mode) or root_st.st_uid!=0 or stat.S_IMODE(root_st.st_mode)!=0o700: raise SystemExit(73)
  owner_fd=os.open('.owner',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=root_fd)
  try:
   view=memoryview(owner_bytes)
   while view:
    written=os.write(owner_fd,view)
    if written<=0: raise OSError('owner marker write made no progress')
    view=view[written:]
   os.fsync(owner_fd); owner_st=os.fstat(owner_fd)
   if not stat.S_ISREG(owner_st.st_mode) or owner_st.st_uid!=0 or stat.S_IMODE(owner_st.st_mode)!=0o600 or owner_st.st_nlink!=1: raise SystemExit(74)
  finally: os.close(owner_fd)
  os.fsync(root_fd)
  print(json.dumps({'state':'owner-durable','rootUid':root_st.st_uid,'rootMode':stat.S_IMODE(root_st.st_mode),'ownerUid':owner_st.st_uid,'ownerMode':stat.S_IMODE(owner_st.st_mode)},separators=(',',':')))
 finally: os.close(root_fd)
finally: os.close(parent_fd)
`;
  const owner = parseObject(await remoteOutput(context, "create-hosted-sidecar-owner",
    sudoPython(ownerScript, [transaction.root, transaction.marker])));
  assert.deepEqual(owner, { state: "owner-durable", rootUid: 0, rootMode: 0o700, ownerUid: 0, ownerMode: 0o600 });
  const candidatePayload = JSON.stringify({ root: transaction.root, marker: transaction.marker,
    originalPath: transaction.original.configPath, originalSha256: transaction.original.configSha256,
    candidatePath: transaction.configPath, gatewayId: transaction.gatewayId, block });
  const candidateScript = `import hashlib,json,os,pathlib,re,stat,sys
p=json.loads(sys.argv[1]); root=pathlib.Path(p['root']); marker=root/'.owner'
st=os.lstat(root); assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
owner=marker.lstat(); assert stat.S_ISREG(owner.st_mode) and owner.st_uid==0 and owner.st_nlink==1 and stat.S_IMODE(owner.st_mode)==0o600 and marker.read_text()==p['marker']+'\\n'
assert re.fullmatch(r'[a-f0-9]{32}',p['gatewayId'])
basePath=pathlib.Path(p['originalPath']); bs=basePath.lstat(); assert stat.S_ISREG(bs.st_mode) and not basePath.is_symlink()
base=basePath.read_bytes(); assert hashlib.sha256(base).hexdigest()==p['originalSha256']
anchor=b'\\t@test_gateway_prefix path /g/*'; block=p['block'].encode(); assert base.count(anchor)==1 and p['marker'].encode() not in base
gateway_path=b'/g/'+p['gatewayId'].encode(); assert block.count(gateway_path)==2 and b'path /g/*' not in block
candidate=base.replace(anchor,block+anchor,1); assert candidate.count(block)==1 and candidate.replace(block,b'',1)==base
path=pathlib.Path(p['candidatePath']); fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
try:
 os.fchown(fd,0,0); view=memoryview(candidate)
 while view:
  written=os.write(fd,view)
  if written<=0: raise OSError('candidate write made no progress')
  view=view[written:]
 os.fsync(fd); out=os.fstat(fd); assert stat.S_ISREG(out.st_mode) and out.st_uid==0 and out.st_nlink==1 and stat.S_IMODE(out.st_mode)==0o600
finally: os.close(fd)
dirfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); os.fsync(dirfd); os.close(dirfd)
print(json.dumps({'baseSha256':hashlib.sha256(base).hexdigest(),'candidateSha256':hashlib.sha256(candidate).hexdigest(),'removedBlockRestoresBase':True},separators=(',',':')))
`;
  const candidateReceipt = parseObject(await remoteOutput(context, "build-owned-hosted-sidecar-candidate",
    sudoPython(candidateScript, [candidatePayload])));
  assert.equal(candidateReceipt.baseSha256, transaction.original.configSha256);
  assert.equal(candidateReceipt.removedBlockRestoresBase, true);
  transaction.candidateSha256 = candidateReceipt.candidateSha256;
  const validation = await remoteOutput(context, "validate-hosted-sidecar-candidate",
    `sudo -n /usr/bin/caddy validate --config ${shellQuote(transaction.configPath)} --adapter caddyfile`, 45_000);
  assert.match(validation, /Valid configuration/);

  const fresh = await inspectHostedSidecar(context, remoteOutput);
  assert.deepEqual(fresh, before, "443 owner, production 8451, or public static root drifted before switch");
  transaction.originalStopRequested = true;
  const stopped = await stopAndWaitForOriginalSidecarOnce(context, transaction.original, before.remote.sidecar,
    { sshTransport, repoRoot, waitFor });
  assert.equal(stopped.state, "original-exited-443-free");
  assert.equal(stopped.port443Free, true);

  const launch = [
    "set -eu",
    `sudo -n bash -c ${shellQuote(`umask 077; nohup /usr/bin/caddy run --config ${transaction.configPath} --adapter caddyfile </dev/null >>${transaction.logPath} 2>&1 & echo $! > ${transaction.pidPath}`)}`,
    `pid=$(sudo -n cat ${shellQuote(transaction.pidPath)})`,
    `case "$pid" in ''|*[!0-9]*) exit 71 ;; esac`,
    `test "$pid" -gt 1`,
    `exe=$(sudo -n readlink "/proc/$pid/exe")`,
    `test "$exe" = /usr/bin/caddy`,
    `argv=$(sudo -n tr '\\000' ' ' < "/proc/$pid/cmdline")`,
    `case "$argv" in *${transaction.configPath}*) ;; *) exit 72 ;; esac`,
    `printf 'candidatePid=%s\\n' "$pid"`,
  ].join("; ");
  transaction.candidateStartRequested = true;
  const started = await remoteOutput(context, "start-owned-hosted-sidecar", launch, 15_000);
  transaction.candidatePid = parseCandidatePid(started);
  await waitFor(async () => {
    const count = Number((await remoteOutput(context, "wait-hosted-sidecar-443",
      "sudo -n ss -H -ltnp 'sport = :443' | wc -l")).trim());
    if (!count) return null;
    const observed = await inspectSidecarAt(context, remoteOutput, transaction);
    return observed.sidecar.pid === transaction.candidatePid ? true : null;
  }, 15_000, "owned hosted Caddy sidecar on 443", 150, context.abortSignal);
  const candidateStatic = await inspectStaticRoot(context, remoteOutput, {
    configPath: transaction.configPath, configSha256: transaction.candidateSha256,
  });
  assert.deepEqual(candidateStatic, before.staticRoot, "Caddy route-only candidate must preserve static-root bytes");
}

export async function restoreHostedSidecar(context, transaction, before, {
  repoRoot, sshOptions, sshTarget, remoteOutput, waitFor,
}) {
  const p = HOSTED_SIDECAR_PINS;
  if (transaction.candidateStartRequested && transaction.candidatePid === null) {
    let observed = null;
    await waitFor(async () => {
      observed = await recoverHostedCandidateOwner(context, remoteOutput, transaction);
      if (observed.state === "owned") {
        transaction.candidatePid = observed.pid;
        return true;
      }
      if (observed.state === "absent") {
        transaction.candidateStartRequested = false;
        return true;
      }
      return null;
    }, 15_000, "recover exact hosted-sidecar process identity after ambiguous launch", 1_000, context.abortSignal);
  }
  return restoreRoutesOnlySidecarOnce(context, transaction, before.remote, {
    repoRoot, sshOptions, sshTarget,
    productionConfigPath: p.productionConfigPath,
    productionConfigSha256: p.productionConfigSha256,
    expectedStaticRoot: p.expectedStaticRoot,
    expectedStaticFiles: p.expectedStaticFiles,
  });
}

async function inspectSidecarAt(context, remoteOutput, transaction) {
  const payload = JSON.stringify({
    sidecarConfigPath: transaction.configPath, sidecarConfigSha256: transaction.candidateSha256,
    expectedSidecarPid: transaction.candidatePid, privateSidecarConfig: true,
    productionConfigPath: HOSTED_SIDECAR_PINS.productionConfigPath,
    productionConfigSha256: HOSTED_SIDECAR_PINS.productionConfigSha256,
    productionPid: HOSTED_SIDECAR_PINS.productionPid,
    productionArgvSha256: transaction.productionArgvSha256,
    productionStartTicks: transaction.productionStartTicks,
  });
  const python = `import pathlib,hashlib,json,subprocess,re,os,stat
p=json.loads(${JSON.stringify(payload)}); sha=lambda b:hashlib.sha256(b).hexdigest()
cfg=pathlib.Path(p['sidecarConfigPath']); st=cfg.lstat(); assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600 and sha(cfg.read_bytes())==p['sidecarConfigSha256']
def owner(port):
 text=subprocess.check_output(['ss','-H','-ltnp','sport = :'+str(port)],text=True); ids=sorted({int(x) for x in re.findall(r'pid=(\\d+),',text)}); return text,ids
text,ids=owner(443); assert ids==[p['expectedSidecarPid']]
q=pathlib.Path('/proc')/str(ids[0]); av=q.joinpath('cmdline').read_bytes().split(b'\\0'); av=av[:-1] if av and not av[-1] else av
uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',q.joinpath('status').read_text(),re.M); assert os.readlink(q/'exe')=='/usr/bin/caddy' and uid and int(uid.group(2))==0
assert av==[b'/usr/bin/caddy',b'run',b'--config',p['sidecarConfigPath'].encode(),b'--adapter',b'caddyfile']
prod=pathlib.Path(p['productionConfigPath']); assert sha(prod.read_bytes())==p['productionConfigSha256']
prodText,prodIds=owner(8451); assert prodIds==[p['productionPid']]
pq=pathlib.Path('/proc')/str(prodIds[0]); puid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',pq.joinpath('status').read_text(),re.M)
av=pq.joinpath('cmdline').read_bytes().split(b'\\0'); av=av[:-1] if av and not av[-1] else av
assert os.readlink(pq/'exe')=='/usr/bin/caddy' and puid and int(puid.group(2))==996
assert av.count(b'--config')==1
config_index=av.index(b'--config'); assert config_index+1<len(av) and av[config_index+1]==p['productionConfigPath'].encode()
assert sha(b'\\0'.join(av))==p['productionArgvSha256']
raw=pq.joinpath('stat').read_text(); start=int(raw[raw.rfind(')')+2:].split()[19]); assert start==p['productionStartTicks']
print(json.dumps({'sidecar':{'pid':ids[0]},'productionPid':prodIds[0]},separators=(',',':')))
`;
  return parseObject(await remoteOutput(context, "inspect-owned-hosted-sidecar", sudoPython(python, []), 20_000));
}

async function recoverHostedCandidateOwner(context, remoteOutput, transaction) {
  const payload = JSON.stringify({ root: transaction.root, marker: transaction.marker,
    configPath: transaction.configPath, configSha256: transaction.candidateSha256 });
  const python = `import hashlib,json,os,pathlib,re,stat,subprocess
p=json.loads(${JSON.stringify(payload)}); root=pathlib.Path(p['root']); cfg=pathlib.Path(p['configPath'])
st=os.lstat(root); assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
owner=root/'.owner'; osst=os.lstat(owner); assert stat.S_ISREG(osst.st_mode) and osst.st_uid==0 and osst.st_nlink==1 and stat.S_IMODE(osst.st_mode)==0o600 and owner.read_text()==p['marker']+'\\n'
cs=cfg.lstat(); assert stat.S_ISREG(cs.st_mode) and cs.st_uid==0 and cs.st_nlink==1 and stat.S_IMODE(cs.st_mode)==0o600
assert hashlib.sha256(cfg.read_bytes()).hexdigest()==p['configSha256']
expected=[b'/usr/bin/caddy',b'run',b'--config',p['configPath'].encode(),b'--adapter',b'caddyfile']; found=[]
for item in pathlib.Path('/proc').iterdir():
 if not item.name.isdigit(): continue
 try:
  if os.readlink(item/'exe')!='/usr/bin/caddy': continue
  av=item.joinpath('cmdline').read_bytes().split(b'\\0'); av=av[:-1] if av and not av[-1] else av
  if av!=expected: continue
  uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',item.joinpath('status').read_text(),re.M)
  if not uid or int(uid.group(2))!=0: raise RuntimeError('candidate-euid-mismatch')
  found.append(int(item.name))
 except FileNotFoundError: continue
assert len(found)<=1
listeners=subprocess.check_output(['ss','-H','-ltnp','sport = :443'],text=True,timeout=5)
owners=sorted({int(x) for x in re.findall(r'pid=(\\d+),',listeners)})
if found and owners==found: state='owned'
elif found and not owners: state='starting'
elif not found and not owners: state='absent'
else: raise RuntimeError('unknown-443-owner-during-candidate-recovery')
print(json.dumps({'state':state,'pid':found[0] if found else None},separators=(',',':')))
`;
  return parseObject(await remoteOutput(context, "recover-exact-hosted-sidecar-candidate",
    sudoPython(python, []), 20_000));
}

async function inspectStaticRoot(context, remoteOutput, expectation) {
  const p = HOSTED_SIDECAR_PINS;
  const payload = JSON.stringify({ configPath: expectation.configPath, configSha256: expectation.configSha256,
    staticRoot: p.expectedStaticRoot, expectedFiles: p.expectedStaticFiles });
  const python = `import pathlib,hashlib,json,subprocess,os,stat
p=json.loads(${JSON.stringify(payload)}); sha=lambda b:hashlib.sha256(b).hexdigest()
cfg=pathlib.Path(p['configPath']); assert sha(cfg.read_bytes())==p['configSha256']
adapt=subprocess.run(['/usr/bin/caddy','adapt','--config',str(cfg),'--adapter','caddyfile'],capture_output=True,timeout=8,check=True)
doc=json.loads(adapt.stdout); roots=set()
def visit(node):
 if isinstance(node,dict):
  if node.get('handler') in ('vars','file_server') and isinstance(node.get('root'),str) and node['root'].startswith('/'): roots.add(node['root'])
  for value in node.values(): visit(value)
 elif isinstance(node,list):
  for value in node: visit(value)
visit(doc); assert roots=={p['staticRoot']}
root=pathlib.Path(p['staticRoot']); info=os.lstat(root); assert stat.S_ISDIR(info.st_mode) and not root.is_symlink()
rows=[]
for current,dirs,files in os.walk(root,topdown=True,followlinks=False):
 dirs.sort(); files.sort()
 for name in list(dirs)+files:
  path=pathlib.Path(current)/name; st=os.lstat(path); assert not path.is_symlink()
  if name in dirs: assert stat.S_ISDIR(st.st_mode)
  else:
   assert stat.S_ISREG(st.st_mode); h=hashlib.sha256()
   with open(path,'rb') as stream:
    for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
   rows.append([path.relative_to(root).as_posix(),st.st_size,str(st.st_mtime_ns),h.hexdigest()])
rows.sort(); assert len(rows)==p['expectedFiles']
print(json.dumps({'fileCount':len(rows),'treeSha256':sha(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode())},separators=(',',':')))
`;
  return parseObject(await remoteOutput(context, "hosted-static-root-projection", sudoPython(python, []), 20_000));
}

function sudoPython(source, args) {
  return `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(source))}` +
    (args.length ? ` ${args.map(shellQuote).join(" ")}` : "");
}
function parseObject(text) { try { const value = JSON.parse(text); assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value; } catch { throw new Error("hosted sidecar receipt was invalid"); } }
function parseCandidatePid(text) { const match = /^candidatePid=([1-9][0-9]{0,9})$/.exec(String(text).trim()); assert.ok(match); const pid = Number(match[1]); assert.ok(Number.isSafeInteger(pid) && pid > 1); return pid; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
