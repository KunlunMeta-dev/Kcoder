import assert from 'node:assert/strict';

// Generates one remote Python program. This module never opens SSH or a service.
export function buildSingleConnectionRestore(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input));
  const { transaction: t, original: o, production: prod, staticRoot: tree } = input;
  const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
  const pid = value => assert.ok(Number.isSafeInteger(value) && value > 1);
  assert.match(t.root, /^\/tmp\/kc-phone-ux-rust-baseline-[a-f0-9]{24}$/);
  assert.equal(t.marker, `kc_route_${t.root.slice(t.root.lastIndexOf('-') + 1)}`);
  assert.equal(t.configPath, `${t.root}/isolated-443-front.Caddyfile`);
  if (t.candidatePid !== null) { pid(t.candidatePid); digest(t.candidateSha256); }
  else assert.ok(t.candidateSha256 === null || /^[a-f0-9]{64}$/.test(t.candidateSha256));
  assert.equal(typeof t.candidateStartRequested, 'boolean');
  assert.ok(!(t.candidateStartRequested && t.candidatePid === null), 'unknown candidate start requires an independent read-only owner observation');
  assert.equal(o.configPath, '/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile');
  assert.equal(o.configSha256, '520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c');
  assert.deepEqual(o.argv, ['/usr/bin/caddy', 'run', '--config', o.configPath, '--adapter', 'caddyfile']);
  pid(o.pid); if (o.startTicks !== undefined) assert.ok(Number.isSafeInteger(o.startTicks) && o.startTicks > 0);
  assert.equal(prod.pid, 200738); assert.equal(prod.euid, 996); assert.equal(prod.exe, '/usr/bin/caddy');
  assert.equal(prod.configPath, '/etc/caddy/Caddyfile');
  assert.equal(prod.configSha256, '05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511');
  digest(prod.argvSha256); digest(prod.listenerSha256);
  if (prod.startTicks !== undefined) assert.ok(Number.isSafeInteger(prod.startTicks) && prod.startTicks > 0);
  assert.equal(tree.path, '/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root');
  assert.equal(tree.fileCount, 37); digest(tree.treeSha256);
  const payload = { transaction: { root: t.root, marker: t.marker, configPath: t.configPath,
    candidatePid: t.candidatePid, candidateSha256: t.candidateSha256, candidateStartRequested: t.candidateStartRequested },
    original: o, production: prod, staticRoot: tree };
  return 'import os,stat,pathlib,hashlib,json,subprocess,re,signal,select,time\n' +
    `p=json.loads(${JSON.stringify(JSON.stringify(payload))})\n` + String.raw`
root=pathlib.Path(p['transaction']['root']); orig=pathlib.Path(p['original']['configPath'])
cand=pathlib.Path(p['transaction']['configPath'])
allowed={'.owner','isolated-443-front.Caddyfile','candidate.pid','candidate.log','original-restored.pid'}
def sha(b): return hashlib.sha256(b).hexdigest()
def emit(stage,**kw): print(json.dumps(dict(stage=stage,**kw),separators=(',',':')),flush=True)
def filecheck(q,h):
 st=os.lstat(q); assert stat.S_ISREG(st.st_mode) and st.st_nlink==1
 assert sha(q.read_bytes())==h
 return st
def listener(port): return subprocess.check_output(['ss','-H','-ltnp','sport = :'+str(port)],text=True,timeout=5)
def pids(text): return sorted({int(x) for x in re.findall(r'pid=(\d+),',text)})
def identity(pid,argv=None):
 q=pathlib.Path('/proc')/str(pid); exe=os.readlink(q/'exe'); assert exe=='/usr/bin/caddy'
 rawargv=q.joinpath('cmdline').read_bytes().split(b'\0'); rawargv=rawargv[:-1] if rawargv and not rawargv[-1] else rawargv
 if argv is not None: assert rawargv==[s.encode() for s in argv]
 u=next(l for l in (q/'status').read_text().splitlines() if l.startswith('Uid:')).split()
 raw=(q/'stat').read_text(); start=int(raw[raw.rfind(')')+2:].split()[19])
 cfg=argv[3] if argv is not None else p['production']['configPath']
 config_match=rawargv.count(b'--config')==1 and rawargv.index(b'--config')+1<len(rawargv) and rawargv[rawargv.index(b'--config')+1]==cfg.encode()
 return dict(pid=pid,exe=exe,euid=int(u[2]),startTicks=start,argvConfigMatch=config_match,argvSha256=sha(b'\0'.join(rawargv)))
def owned_root():
 if not os.path.lexists(root): return False
 st=os.lstat(root); assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o700
 owner=root/'.owner'; st=os.lstat(owner)
 assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600
 assert owner.read_text()==p['transaction']['marker']+'\n'
 assert {q.name for q in root.iterdir()}<=allowed
 for q in root.iterdir():
  st=os.lstat(q); assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1
 return True
def protected():
 prod=p['production']; filecheck(pathlib.Path(prod['configPath']),prod['configSha256'])
 text=listener(8451); assert pids(text)==[prod['pid']] and sha(text.encode())==prod['listenerSha256']
 production_identity=identity(prod['pid'])
 assert all(production_identity[key]==prod[key] for key in ('pid','euid','argvSha256','exe')) and production_identity['argvConfigMatch']
 if 'startTicks' in prod: assert production_identity['startTicks']==prod['startTicks']
 forward=listener(32552); assert not forward
 tree=p['staticRoot']; base=pathlib.Path(tree['path']); st=os.lstat(base); assert stat.S_ISDIR(st.st_mode)
 adapted=subprocess.run(['/usr/bin/caddy','adapt','--config',str(orig),'--adapter','caddyfile'],capture_output=True,timeout=8,check=True)
 roots=set()
 def visit(node):
  if isinstance(node,dict):
   if node.get('handler') in ('vars','file_server') and isinstance(node.get('root'),str) and node['root'].startswith('/'): roots.add(node['root'])
   for value in node.values(): visit(value)
  elif isinstance(node,list):
   for value in node: visit(value)
 visit(json.loads(adapted.stdout)); assert roots=={tree['path']}
 rows=[]
 for walk_current,dirs,files in os.walk(base,followlinks=False):
  dirs.sort(); files.sort()
  for name in dirs+files:
   q=pathlib.Path(walk_current)/name; st=os.lstat(q)
   if name in dirs: assert stat.S_ISDIR(st.st_mode)
   else:
    assert stat.S_ISREG(st.st_mode)
    rows.append([q.relative_to(base).as_posix(),st.st_size,str(st.st_mtime_ns),sha(q.read_bytes())])
 rows.sort(); actual_tree_sha=sha(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode())
 assert len(rows)==tree['fileCount'] and actual_tree_sha==tree['treeSha256']
 return dict(staticRoot=dict(fileCount=len(rows),treeSha256=actual_tree_sha),productionIdentity=production_identity,productionListenerSha256=sha(text.encode()),forwardFree=not bool(forward))
def classify_listener(owners,candidate_pid,original_pid):
 if not owners: return 'free'
 if candidate_pid is not None and owners==[candidate_pid]: return 'candidate'
 if original_pid is not None and owners==[original_pid]: return 'original'
 raise RuntimeError('unknown-443-owner')
def stop_candidate(pid,argv):
 try: fd=os.pidfd_open(pid,0)
 except ProcessLookupError:
  emit('candidate-already-exited',pid=pid,sigkillFallbackUsed=False); return False
 try:
  poll=select.poll(); poll.register(fd,select.POLLIN)
  if poll.poll(0):
   emit('candidate-already-exited',pid=pid,sigkillFallbackUsed=False); return False
  before=identity(pid,argv); assert before['euid']==0 and pids(listener(443))==[pid]
  signal.pidfd_send_signal(fd,signal.SIGTERM); emit('candidate-term-sent',pid=pid,pidfd=True)
  killed=False
  if not poll.poll(10000):
   assert identity(pid,argv)==before
   signal.pidfd_send_signal(fd,signal.SIGKILL); killed=True
   emit('candidate-kill-fallback-sent',pid=pid,pidfd=True,sigkillFallbackUsed=True)
   assert poll.poll(5000), 'candidate-exit-deadline'
  emit('candidate-exit-confirmed',pid=pid,sigkillFallbackUsed=killed)
  return killed
 finally: os.close(fd)
def original_process():
 # Never discover/signals by a broad name: only the exact original argv qualifies.
 found=[]
 for q in pathlib.Path('/proc').iterdir():
  if not q.name.isdigit(): continue
  try:
   av=(q/'cmdline').read_bytes().split(b'\0'); av=av[:-1] if av and not av[-1] else av
   if av!=[s.encode() for s in p['original']['argv']]: continue
   item=identity(int(q.name),p['original']['argv']); assert item['euid']==0; found.append(item)
  except FileNotFoundError: continue
 assert len(found)<=1, 'ambiguous-original'
 if found and found[0]['pid']==p['original']['pid'] and 'startTicks' in p['original']: assert found[0]['startTicks']==p['original']['startTicks']
 return found[0] if found else None
def restore():
 assert not (p['transaction']['candidateStartRequested'] and p['transaction']['candidatePid'] is None), 'unknown-candidate-start'
 static=protected(); filecheck(orig,p['original']['configSha256']); exists=owned_root()
 emit('protected-prechecks-pass',ownedRootPresent=exists)
 transaction=p['transaction']; original=original_process()
 owners=pids(listener(443)); state=classify_listener(owners,transaction['candidatePid'],original['pid'] if original else None)
 killed=False
 if transaction['candidatePid'] is not None:
  # A stale PID that is still alive but isn't this candidate fails identity,
  # even when an original listener is already running. Never signal it.
  if state=='candidate':
   assert exists and transaction['candidateSha256'] is not None
   filecheck(cand,transaction['candidateSha256'])
   killed=stop_candidate(transaction['candidatePid'],['/usr/bin/caddy','run','--config',str(cand),'--adapter','caddyfile'])
  elif os.path.exists('/proc/'+str(transaction['candidatePid'])):
   q=pathlib.Path('/proc')/str(transaction['candidatePid']); raw=(q/'stat').read_text()
   assert raw[raw.rfind(')')+2:].split()[0]=='Z', 'candidate-pid-alive-without-owned-listener'
  else: emit('candidate-already-exited',pid=transaction['candidatePid'],sigkillFallbackUsed=False)
 else:
  assert not (state=='candidate')
  # Unknown-start outcome may not signal any PID: exact original or free only.
  emit('candidate-not-observed',sigkillFallbackUsed=False)
 original=original_process(); owners=pids(listener(443))
 if original is None:
  assert not owners, 'unknown-443-owner'
  subprocess.run(['/usr/bin/caddy','validate','--config',str(orig),'--adapter','caddyfile'],check=True,capture_output=True,timeout=15)
  # Restoration must not leave a logging FD into the soon-deleted root.
  child=subprocess.Popen(p['original']['argv'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
  emit('original-started',pid=child.pid)
  end=time.monotonic()+15
  while time.monotonic()<end:
   assert child.poll() is None
   if pids(listener(443))==[child.pid]: break
   time.sleep(.1)
  else: raise RuntimeError('original-listener-deadline')
  original=identity(child.pid,p['original']['argv']); assert original['euid']==0
 else:
  assert owners==[original['pid']], 'original-not-sole-listener'
  emit('original-still-running',pid=original['pid'])
 after=protected(); assert after==static, 'protected-identity-changed-during-restore'
 filecheck(orig,p['original']['configSha256']); assert pids(listener(443))==[original['pid']]
 emit('original-and-protected-verified',restoredPid=original['pid'],sigkillFallbackUsed=killed,
      originalConfigSha256=p['original']['configSha256'],productionPid=p['production']['pid'],staticRoot=static['staticRoot'])
 if exists:
  assert owned_root()
  # Exact owned leaves only; no recursive deletion/symlink traversal.
  for q in root.iterdir(): q.unlink()
  root.rmdir(); assert not os.path.lexists(root)
 emit('restored-and-owned-root-removed',rootWasAbsent=not exists,sigkillFallbackUsed=killed)
 fresh_original=identity(original['pid'],p['original']['argv']); assert fresh_original['euid']==0 and fresh_original['argvConfigMatch']
 assert pids(listener(443))==[fresh_original['pid']]
 remote=dict(forwardFree=after['forwardFree'],productionListenerSha256=after['productionListenerSha256'],
  productionOwners=[{key:after['productionIdentity'][key] for key in ('pid','exe','euid','argvConfigMatch','argvSha256')}],
  sidecar=dict(pid=fresh_original['pid'],exeMatches=fresh_original['exe']=='/usr/bin/caddy',euid=fresh_original['euid'],configSha256=sha(orig.read_bytes()),argvConfigMatch=fresh_original['argvConfigMatch']))
 result=dict(remote=remote,staticRoot=after['staticRoot'],restoredSidecarPid=fresh_original['pid'],rootRemoval='confirmed-absent',rootWasAbsent=not exists,killUsed=killed)
 emit('restore-complete',result=result)
 return result
if __name__=='__main__':
 try: restore()
 except Exception as e:
  emit('recovery-failed',errorType=type(e).__name__); raise
`;
}

export const SINGLE_SSH_RESTORE_TIMEOUT_MS = 90_000;
export const RESTORE_CLEANUP_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 32 * 1024;

export function buildObservedRestoreInput(transaction, before, {
  productionConfigPath, productionConfigSha256, expectedStaticRoot, expectedStaticFiles,
}) {
  assert.equal(before.productionOwners?.length, 1);
  assert.equal(before.sidecar.pid, transaction.original.pid);
  assert.equal(before.sidecar.configSha256, transaction.original.configSha256);
  const owner = before.productionOwners[0];
  assert.equal(owner.argvConfigMatch, true);
  return { transaction, original: { ...transaction.original,
    argv: ['/usr/bin/caddy', 'run', '--config', transaction.original.configPath, '--adapter', 'caddyfile'] },
    production: { ...owner, configPath: productionConfigPath, configSha256: productionConfigSha256,
      listenerSha256: before.productionListenerSha256 },
    staticRoot: { path: expectedStaticRoot, fileCount: expectedStaticFiles, treeSha256: transaction.staticRootSha256 } };
}

export function parseRestoreReceipt(stdout, input) {
  assert.ok(Buffer.byteLength(stdout) > 0 && Buffer.byteLength(stdout) <= OUTPUT_LIMIT);
  const lines = stdout.trim().split('\n'); assert.ok(lines.length <= 32);
  const stages = lines.map(line => { assert.ok(Buffer.byteLength(line) <= 4096); return JSON.parse(line); });
  const allowed = new Set(['protected-prechecks-pass', 'candidate-term-sent', 'candidate-kill-fallback-sent',
    'candidate-already-exited', 'candidate-exit-confirmed', 'candidate-not-observed', 'original-started',
    'original-still-running', 'original-and-protected-verified', 'restored-and-owned-root-removed', 'restore-complete']);
  assert.ok(stages.every(row => row && typeof row === 'object' && !Array.isArray(row) && allowed.has(row.stage)));
  assert.equal(stages.filter(row => row.stage === 'restore-complete').length, 1);
  assert.equal(stages.at(-1).stage, 'restore-complete');
  const result = stages.at(-1).result;
  assert.deepEqual(Object.keys(result).sort(), ['killUsed', 'remote', 'restoredSidecarPid', 'rootRemoval', 'rootWasAbsent', 'staticRoot'].sort());
  assert.equal(result.rootRemoval, 'confirmed-absent');
  assert.equal(typeof result.killUsed, 'boolean'); assert.equal(typeof result.rootWasAbsent, 'boolean');
  assert.equal(result.killUsed, stages.some(row => row.stage === 'candidate-kill-fallback-sent' && row.sigkillFallbackUsed === true));
  const remote = result.remote;
  assert.deepEqual(Object.keys(remote).sort(), ['forwardFree', 'productionListenerSha256', 'productionOwners', 'sidecar'].sort());
  assert.equal(remote.forwardFree, true); assert.equal(remote.productionListenerSha256, input.production.listenerSha256);
  const { pid, exe, euid, argvSha256 } = input.production;
  assert.deepEqual(remote.productionOwners, [{ pid, exe, euid, argvConfigMatch: true, argvSha256 }]);
  assert.deepEqual(Object.keys(remote.sidecar).sort(), ['pid', 'exeMatches', 'euid', 'configSha256', 'argvConfigMatch'].sort());
  assert.ok(Number.isSafeInteger(remote.sidecar.pid) && remote.sidecar.pid > 1);
  assert.equal(remote.sidecar.pid, result.restoredSidecarPid);
  assert.equal(remote.sidecar.exeMatches, true); assert.equal(remote.sidecar.euid, 0); assert.equal(remote.sidecar.argvConfigMatch, true);
  assert.equal(remote.sidecar.configSha256, input.original.configSha256);
  assert.deepEqual(result.staticRoot, { fileCount: input.staticRoot.fileCount, treeSha256: input.staticRoot.treeSha256 });
  return result;
}

/** One owned SSH child, one stdin program. No retry or follow-up SSH probe. */
export async function restoreRoutesOnlySidecarOnce(context, transaction, before, options) {
  const input = buildObservedRestoreInput(transaction, before, options);
  const python = buildSingleConnectionRestore(input); // Fail invalid/unknown-start before spawn.
  assert.equal(options.sshTarget, 'aliyun');
  assert.deepEqual(options.sshOptions, ['-F', '/home/hyf/.ssh/config', '-o', 'UserKnownHostsFile=/home/hyf/.ssh/known_hosts',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15']);
  const label = 'ssh-single-connection-sidecar-restore';
  const child = context.spawnOwned(label, 'ssh', ['-T', ...options.sshOptions, options.sshTarget, 'sudo -n python3 -'],
    { cwd: options.repoRoot, stdin: 'pipe', env: context.isolatedEnvironment({}, ['SSH_AUTH_SOCK']) });
  let stdoutBytes = 0, stderrBytes = 0; const stdout = [];
  let overflow = false, stdinFailed = false, closeInfo = null;
  let timer, onAbort;
  try {
    await new Promise((resolve, reject) => {
      const fail = message => reject(new Error(message));
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= OUTPUT_LIMIT) stdout.push(Buffer.from(chunk));
        else { overflow = true; fail('single SSH recovery stdout exceeded limit'); }
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > OUTPUT_LIMIT) { overflow = true; fail('single SSH recovery stderr exceeded limit'); }
      });
      child.once('error', () => fail('single SSH recovery spawn failed'));
      child.once('close', (code, signal) => { closeInfo = { code, signal }; resolve(); });
      child.stdin.on('error', () => { stdinFailed = true; fail('single SSH recovery stdin failed'); });
      onAbort = () => fail('single SSH recovery aborted; remote outcome unknown');
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail('single SSH recovery deadline; remote outcome unknown'), SINGLE_SSH_RESTORE_TIMEOUT_MS);
      if (context.abortSignal?.aborted) onAbort(); else child.stdin.end(python);
    });
    assert.ok(closeInfo !== null, 'actual child close is required');
    assert.equal(closeInfo.code, 0, 'single SSH recovery remote exit must be zero');
    assert.equal(closeInfo.signal, null); assert.equal(overflow, false); assert.equal(stdinFailed, false);
    const result = parseRestoreReceipt(Buffer.concat(stdout).toString('utf8'), input);
    await context.writeArtifactJson('single-ssh-sidecar-restoration.json', { status: 'confirmed', sshPid: child.pid,
      timeoutMs: SINGLE_SSH_RESTORE_TIMEOUT_MS, stdoutBytes, stderrBytes, exit: closeInfo, result });
    return result;
  } catch (failure) {
    // Stopping this local owned SSH is not proof that the remote Python ended.
    // Never start another recovery child or turn a timeout into success.
    try { await context.stopOwned(label); }
    catch (cleanupFailure) { throw new AggregateError([failure, cleanupFailure], 'single SSH recovery and owned cleanup failed'); }
    throw failure;
  } finally {
    clearTimeout(timer); if (onAbort) context.abortSignal?.removeEventListener('abort', onAbort);
  }
}
