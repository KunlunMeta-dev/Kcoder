// Local generation/AST-isolated lifecycle contracts only. No SSH, /proc, ss,
// Caddy, signal, listener, actual root mutation or live recovery is exercised.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildSingleConnectionRestore } from './single-ssh-sidecar-restore.mjs';

function fixture() {
  const root = '/tmp/kc-phone-ux-rust-baseline-111111111111111111111111';
  const configPath = '/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile';
  return { transaction: { root, marker: 'kc_route_111111111111111111111111', configPath: `${root}/isolated-443-front.Caddyfile`,
      candidatePid: 12345, candidateSha256: '1'.repeat(64), candidateStartRequested: true },
    original: { pid: 12344, configPath, configSha256: '520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c',
      argv: ['/usr/bin/caddy', 'run', '--config', configPath, '--adapter', 'caddyfile'] },
    production: { pid: 200738, exe: '/usr/bin/caddy', euid: 996, configPath: '/etc/caddy/Caddyfile',
      configSha256: '05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511',
      argvSha256: '2'.repeat(64), listenerSha256: '3'.repeat(64) },
    staticRoot: { path: '/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root', fileCount: 37, treeSha256: '4'.repeat(64) } };
}
function python(program, scenario) {
  const result = spawnSync('python3', ['-c', program], { input: JSON.stringify({ source: buildSingleConnectionRestore(fixture()), scenario }),
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
const lifecycle = String.raw`
import ast,json,sys,types,signal
record=json.load(sys.stdin); scenario=record['scenario']; events=[]; calls=[]
module=ast.parse(record['source']); names={'classify_listener','stop_candidate'}
ns={'signal':types.SimpleNamespace(SIGTERM=signal.SIGTERM,SIGKILL=signal.SIGKILL),
    'emit':lambda stage,**kw:events.append(dict(stage=stage,**kw)),
    'identity':lambda pid,argv:dict(pid=pid,euid=scenario.get('uid',0),startTicks=77,argvSha256='exact'),
    'listener':lambda port:'owned','pids':lambda text:scenario.get('owners',[12345])}
class Poll:
 def register(self,fd,flags): calls.append(['register',fd,flags])
 def poll(self,deadline):
  calls.append(['poll',deadline])
  if deadline==0: return [1] if scenario.get('exited') else []
  if deadline==10000: return [] if scenario.get('needsKill') else [1]
  if deadline==5000: return [] if scenario.get('neverExit') else [1]
  raise AssertionError('unexpected deadline')
def openfd(pid,flags):
 if scenario.get('absent'): raise ProcessLookupError()
 calls.append(['open',pid,flags]); return 12
def send(fd,sig): calls.append(['signal',fd,int(sig)])
ns['os']=types.SimpleNamespace(pidfd_open=openfd,close=lambda fd:calls.append(['close',fd]))
ns['select']=types.SimpleNamespace(poll=Poll,POLLIN=1); ns['signal'].pidfd_send_signal=send
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),'actual-generated-functions','exec'),ns)
try:
 killed=ns['stop_candidate'](12345,['exact-owned-argv']); result=dict(ok=True,killed=killed)
except Exception as e: result=dict(ok=False,errorType=type(e).__name__)
result.update(events=events,calls=calls)
print(json.dumps(result))
`;

test('actual JS generated Python compiles, contains no NUL, consumes minimal real projection fields', () => {
  const source = buildSingleConnectionRestore(fixture());
  assert.equal(source.includes('\0'), false);
  python("import json,sys; p=json.load(sys.stdin); compile(p['source'],'generated-restoration','exec')", {});
  assert.match(source, /subprocess\.DEVNULL/);
  assert.doesNotMatch(source, /single-connection-restoration\.log/);
  assert.doesNotMatch(source, /ssh|pkill|killall|shell=True/);
});

test('input rejects production/root/marker/static/config identity ambiguities', () => {
  for (const mutate of [p => { p.transaction.root = '/tmp/unowned'; }, p => { p.transaction.marker = 'wrong'; },
    p => { p.transaction.configPath = '/etc/caddy/Caddyfile'; }, p => { p.production.pid = 1; },
    p => { p.production.argvSha256 = null; }, p => { p.original.argv.push('--resume'); },
    p => { p.staticRoot.fileCount = 36; }, p => { p.original.configSha256 = '0'.repeat(64); }]) {
    const input = fixture(); mutate(input); assert.throws(() => buildSingleConnectionRestore(input));
  }
});

test('TERM success records no SIGKILL fallback and closes the exact pidfd once', () => {
  const result = python(lifecycle, {});
  assert.equal(result.ok, true); assert.equal(result.killed, false);
  assert.deepEqual(result.calls.filter(row => row[0] === 'signal'), [['signal', 12, 15]]);
  assert.deepEqual(result.calls.filter(row => row[0] === 'close'), [['close', 12]]);
  assert.equal(result.events.at(-1).sigkillFallbackUsed, false);
});

test('bounded TERM timeout records actual fallback SIGKILL and waits on the same pidfd', () => {
  const result = python(lifecycle, { needsKill: true });
  assert.equal(result.ok, true); assert.equal(result.killed, true);
  assert.deepEqual(result.calls.filter(row => row[0] === 'signal'), [['signal', 12, 15], ['signal', 12, 9]]);
  assert.ok(result.calls.some(row => row[0] === 'poll' && row[1] === 5000));
  assert.equal(result.events.find(row => row.stage === 'candidate-kill-fallback-sent').sigkillFallbackUsed, true);
});

test('already-exited candidate is never signaled; unknown listener/UID and final timeout fail closed', () => {
  for (const scenario of [{ absent: true }, { exited: true }]) {
    const result = python(lifecycle, scenario); assert.equal(result.ok, true); assert.equal(result.killed, false);
    assert.equal(result.calls.filter(row => row[0] === 'signal').length, 0);
  }
  for (const scenario of [{ owners: [99999] }, { uid: 996 }]) {
    const result = python(lifecycle, scenario); assert.equal(result.ok, false);
    assert.equal(result.calls.filter(row => row[0] === 'signal').length, 0);
  }
  assert.equal(python(lifecycle, { needsKill: true, neverExit: true }).ok, false);
});

test('443 classification supports original already running/free/candidate and rejects unknown owners', () => {
  python(String.raw`import ast,json,sys
p=json.load(sys.stdin); module=ast.parse(p['source']); ns={}
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='classify_listener'],type_ignores=[]),'actual-classification','exec'),ns)
f=ns['classify_listener']; assert f([12344],12345,12344)=='original'; assert f([],None,None)=='free'; assert f([12345],12345,None)=='candidate'
for owners in ([99999],[12344,12345]):
 try: f(owners,12345,12344)
 except RuntimeError: pass
 else: raise AssertionError('unknown listener accepted')`, {});
});

test('actual generated listener parser and partial-root marker checks reject unowned leaves', () => {
  python(String.raw`import ast,json,sys,types,stat,re
record=json.load(sys.stdin); module=ast.parse(record['source']); ns={'stat':stat,'re':re}
state={'absent':False,'marker':'kc_route_111111111111111111111111\n','extra':False,'missingOwner':False,'ownerMode':0o100600}
class Leaf:
 def __init__(self,name): self.name=name
 def read_text(self): return state['marker']
class Root:
 def __truediv__(self,name): return Leaf(name)
 def iterdir(self): return [Leaf('.owner'),Leaf('candidate.log')]+([Leaf('unknown')] if state['extra'] else [])
root=Root()
def lstat(path):
 if path is root: return types.SimpleNamespace(st_mode=0o40700,st_uid=0,st_nlink=1)
 if path.name=='.owner' and state['missingOwner']: raise FileNotFoundError()
 return types.SimpleNamespace(st_mode=state['ownerMode'] if path.name=='.owner' else 0o100600,st_uid=0,st_nlink=1)
ns.update(root=root,p={'transaction':{'marker':'kc_route_111111111111111111111111'}},allowed={'.owner','candidate.log'},
          os=types.SimpleNamespace(lstat=lstat,path=types.SimpleNamespace(lexists=lambda root:not state['absent'])))
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in ('owned_root','pids')],type_ignores=[]),'actual-owned-root','exec'),ns)
assert ns['pids']('users:(("caddy",pid=12345,fd=8))')==[12345]
assert ns['owned_root']() is True
state['absent']=True; assert ns['owned_root']() is False; state['absent']=False
for key,value in [('marker','wrong\n'),('extra',True),('missingOwner',True),('ownerMode',0o120600)]:
 old=state[key];state[key]=value
 try: ns['owned_root']()
 except (AssertionError,FileNotFoundError): pass
 else: raise AssertionError('unowned root accepted')
 state[key]=old`, {});
});

// This contract executes the guard from actual JS-generated Python, not a
// mirrored assertion. The fake protected() would record any attempted work.
test('ACK-lost unknown start is rejected before remote work even if JS input validation is bypassed', () => {
  const input = fixture(); input.transaction.candidatePid = null;
  assert.throws(() => buildSingleConnectionRestore(input), /unknown candidate start/);
  input.transaction.candidateStartRequested = false;
  assert.equal(typeof buildSingleConnectionRestore(input), 'string');
  python(String.raw`import ast,json,sys
record=json.load(sys.stdin); module=ast.parse(record['source']); calls=[]
ns={'p':{'transaction':{'candidateStartRequested':True,'candidatePid':None}},'protected':lambda:calls.append('protected')}
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='restore'],type_ignores=[]),'actual-generated-restore','exec'),ns)
try: ns['restore']()
except AssertionError as error: assert str(error)=='unknown-candidate-start'
else: raise AssertionError('unknown start permitted')
assert calls==[]`, {});
});

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { buildObservedRestoreInput, parseRestoreReceipt, restoreRoutesOnlySidecarOnce,
  SINGLE_SSH_RESTORE_TIMEOUT_MS, RESTORE_CLEANUP_TIMEOUT_MS } from './single-ssh-sidecar-restore.mjs';
function observed() {
  const f = fixture();
  return { transaction: { ...f.transaction, original: { pid: f.original.pid, configPath: f.original.configPath,
      configSha256: f.original.configSha256 }, staticRootSha256: f.staticRoot.treeSha256 },
    before: { sidecar: { pid: f.original.pid, configSha256: f.original.configSha256 },
      productionOwners: [{ pid: f.production.pid, exe: f.production.exe, euid: f.production.euid,
        argvConfigMatch: true, argvSha256: f.production.argvSha256 }], productionListenerSha256: f.production.listenerSha256 },
    options: { productionConfigPath: f.production.configPath, productionConfigSha256: f.production.configSha256,
      expectedStaticRoot: f.staticRoot.path, expectedStaticFiles: f.staticRoot.fileCount, repoRoot: '/fixture/repo', sshTarget: 'aliyun',
      sshOptions: ['-F', '/home/hyf/.ssh/config', '-o', 'UserKnownHostsFile=/home/hyf/.ssh/known_hosts',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15'] } };
}
function receiptFixture() {
  const f = fixture();
  return { remote: { forwardFree: true, productionListenerSha256: f.production.listenerSha256,
      productionOwners: [{ pid: f.production.pid, exe: f.production.exe, euid: f.production.euid, argvConfigMatch: true, argvSha256: f.production.argvSha256 }],
      sidecar: { pid: 34567, exeMatches: true, euid: 0, configSha256: f.original.configSha256, argvConfigMatch: true } },
    staticRoot: { fileCount: 37, treeSha256: f.staticRoot.treeSha256 }, restoredSidecarPid: 34567,
    rootRemoval: 'confirmed-absent', rootWasAbsent: true, killUsed: false };
}
function memoryContext(result, failureMode) {
  const spawns = [], writes = [], stops = [], stdin = [];
  const child = new EventEmitter(); child.pid = 98765; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { stdin.push(Buffer.from(chunk)); done(); }, final(done) {
    done(); queueMicrotask(() => {
      if (failureMode === 'overflow') child.stdout.write(Buffer.alloc(32 * 1024 + 1));
      else if (failureMode === 'stderr-overflow') child.stderr.write(Buffer.alloc(32 * 1024 + 1));
      else child.stdout.write(JSON.stringify({ stage: 'restore-complete', result }) + '\n');
      child.stdout.end(); child.stderr.end(); child.emit('close', failureMode === 'nonzero' ? 1 : 0, null);
    });
  } });
  return { spawns, writes, stops, stdin, context: {
    isolatedEnvironment: () => ({ SYNTHETIC: '1' }),
    spawnOwned: (...args) => { spawns.push(args); return child; },
    stopOwned: async label => { stops.push(label); },
    writeArtifactJson: async (...args) => { writes.push(args); },
  } };
}

test('actual observed input adapter compiles and preserves optional missing ticks without fabricating them', () => {
  const { transaction, before, options } = observed();
  const input = buildObservedRestoreInput(transaction, before, options);
  assert.equal(input.production.startTicks, undefined); assert.equal(input.original.startTicks, undefined);
  const source = buildSingleConnectionRestore(input); assert.equal(source.includes('\0'), false);
  const compile = spawnSync('python3', ['-c', 'import sys;compile(sys.stdin.read(),"actual-adapter-payload","exec")'],
    { input: source, encoding: 'utf8', timeout: 5_000 });
  assert.equal(compile.status, 0, compile.stderr);
  assert.equal(SINGLE_SSH_RESTORE_TIMEOUT_MS, 90_000); assert.equal(RESTORE_CLEANUP_TIMEOUT_MS, 120_000);
});

test('actual generated restore control flow returns fresh legacy shape and actual restored PID', () => {
  const raw = spawnSync('python3', ['-c', String.raw`import ast,json,sys,types
record=json.load(sys.stdin); module=ast.parse(record['source']); ns={}; events=[]; probes=[]
# Execute the generated p=json.loads(...) assignment, then the actual restore
# and classification definitions. Only OS/proc/Caddy operations are simulated.
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='p' for t in n.targets)],type_ignores=[]),'actual-payload','exec'),{'json':json},ns)
p=ns['p']
def protected():
 probes.append('fresh-protected')
 return {'staticRoot':{'fileCount':37,'treeSha256':p['staticRoot']['treeSha256']},'productionIdentity':{'pid':200738,'exe':'/usr/bin/caddy','euid':996,'startTicks':77,'argvConfigMatch':True,'argvSha256':p['production']['argvSha256']},'productionListenerSha256':p['production']['listenerSha256'],'forwardFree':True}
original={'pid':34567,'exe':'/usr/bin/caddy','euid':0,'startTicks':88,'argvConfigMatch':True,'argvSha256':'exact'}
ns.update(protected=protected,filecheck=lambda *args:None,owned_root=lambda:False,original_process=lambda:dict(original),
 listener=lambda port:'fresh-listener',pids=lambda text:[34567],identity=lambda *args:dict(original),
 root=types.SimpleNamespace(),orig=types.SimpleNamespace(read_bytes=lambda:b'fresh-original-config'),
 os=types.SimpleNamespace(path=types.SimpleNamespace(exists=lambda path:False)),
 sha=lambda data:p['original']['configSha256'],emit=lambda stage,**kw:events.append({'stage':stage,**kw}))
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in ('restore','classify_listener')],type_ignores=[]),'actual-generated-flow','exec'),ns)
result=ns['restore'](); assert probes==['fresh-protected','fresh-protected'];assert result['restoredSidecarPid']==34567
assert result['remote']['sidecar']['pid']!=p['original']['pid'];assert events[-1]['stage']=='restore-complete'
print(json.dumps(events[-1]))`], { input: JSON.stringify({ source: buildSingleConnectionRestore(fixture()) }), encoding: 'utf8', timeout: 5_000 });
  assert.equal(raw.status, 0, raw.stderr);
  const result = parseRestoreReceipt(raw.stdout, fixture());
  assert.equal(result.remote.sidecar.pid, 34567); assert.equal(result.staticRoot.fileCount, 37);
});

test('one memory-owned SSH stdin call requires real close/zero exit and maps the final result without extra probes', async () => {
  const { transaction, before, options } = observed(); const expected = receiptFixture();
  const memory = memoryContext(expected);
  const result = await restoreRoutesOnlySidecarOnce(memory.context, transaction, before, options);
  assert.deepEqual(result, expected); assert.notEqual(result.remote, before);
  assert.equal(memory.spawns.length, 1); const [label, command, argv, spawnOptions] = memory.spawns[0];
  assert.equal(command, 'ssh'); assert.equal(argv.at(-1), 'sudo -n python3 -');
  assert.equal(spawnOptions.stdin, 'pipe'); assert.equal(memory.stdin.length, 1);
  assert.equal(Buffer.concat(memory.stdin).includes(0), false);
  assert.equal(memory.stops.length, 0); assert.equal(memory.writes[0][1].exit.code, 0);
});

test('invalid input, overflow and nonzero remote exit never spawn a second SSH or return success', async () => {
  const { transaction, before, options } = observed();
  const invalid = memoryContext(receiptFixture());
  await assert.rejects(restoreRoutesOnlySidecarOnce(invalid.context, { ...transaction, candidatePid: null }, before, options), /unknown candidate start/);
  assert.equal(invalid.spawns.length, 0);
  for (const mode of ['overflow', 'stderr-overflow', 'nonzero']) {
    const memory = memoryContext(receiptFixture(), mode);
    await assert.rejects(restoreRoutesOnlySidecarOnce(memory.context, transaction, before, options));
    assert.equal(memory.spawns.length, 1); assert.equal(memory.stops.length, 1); assert.equal(memory.writes.length, 0);
  }
  const input = buildSingleConnectionRestore(fixture()); assert.ok(input.length > 0);
  const expected = fixture(); const output = receiptFixture(); output.remote.sidecar.pid = 999;
  assert.throws(() => parseRestoreReceipt(JSON.stringify({ stage: 'restore-complete', result: output }), expected));
});

// Exercises actual protected() over a real 37-file temporary tree. Only
// external process/listener/identity/Caddy-adapt boundaries are simulated;
// this is a local generated-code contract, not a remote recovery proof.
test('actual protected tree walk retains production identity and final receipt parses', () => {
  const raw = spawnSync('python3', ['-c', String.raw`import ast,json,sys,types,tempfile,pathlib,os,stat,hashlib,re
record=json.load(sys.stdin); module=ast.parse(record['source']); ns={'json':json}; events=[]; walks=[]; probes=[]
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='p' for t in n.targets)],type_ignores=[]),'actual-payload','exec'),ns)
p=ns['p']
with tempfile.TemporaryDirectory(prefix='kc-restore-protected-contract-') as directory:
 base=pathlib.Path(directory); tree=base/'tree'; tree.mkdir()
 for index in range(37):
  parent=tree/('nested' if index%2 else 'top'); parent.mkdir(exist_ok=True)
  (parent/('file-'+str(index))).write_bytes(('synthetic-static-'+str(index)).encode())
 cfg=base/'original.Caddyfile'; cfg.write_bytes(b'synthetic-original-config')
 prodcfg=base/'production.Caddyfile'; prodcfg.write_bytes(b'synthetic-production-config')
 digest=lambda data:hashlib.sha256(data).hexdigest()
 rows=[]
 for q in sorted(tree.rglob('*')):
  if q.is_file():
   st=q.stat(); rows.append([q.relative_to(tree).as_posix(),st.st_size,str(st.st_mtime_ns),digest(q.read_bytes())])
 rows.sort(); tree_sha=digest(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode())
 p['staticRoot'].update(path=str(tree),treeSha256=tree_sha)
 p['original'].update(configPath=str(cfg),configSha256=digest(cfg.read_bytes()))
 p['original']['argv']=['/usr/bin/caddy','run','--config',str(cfg),'--adapter','caddyfile']
 p['production'].update(configPath=str(prodcfg),configSha256=digest(prodcfg.read_bytes()))
 p['transaction'].update(candidatePid=None,candidateStartRequested=False)
 listener_text='users:(("caddy",pid=200738,fd=8))\n'
 p['production']['listenerSha256']=digest(listener_text.encode())
 original={'pid':34567,'exe':'/usr/bin/caddy','euid':0,'startTicks':88,'argvConfigMatch':True,'argvSha256':'exact'}
 production={'pid':200738,'exe':'/usr/bin/caddy','euid':996,'startTicks':77,'argvConfigMatch':True,'argvSha256':p['production']['argvSha256']}
 def listener(port):
  probes.append(port)
  return listener_text if port==8451 else ('users:(("caddy",pid=34567,fd=9))\n' if port==443 else '')
 def adapt(argv,**kwargs):
  assert argv==['/usr/bin/caddy','adapt','--config',str(cfg),'--adapter','caddyfile']
  assert kwargs==dict(capture_output=True,timeout=8,check=True)
  return types.SimpleNamespace(stdout=json.dumps({'handler':'file_server','root':str(tree)}))
 def walk(*args,**kwargs):
  walks.append(str(args[0])); return os.walk(*args,**kwargs)
 # Keep real lstat/path operations and real os.walk; the wrapper only records
 # that the generated function traversed the physical temporary tree.
 os_boundary=types.SimpleNamespace(lstat=os.lstat,walk=walk,path=os.path)
 ns.update(os=os_boundary,stat=stat,pathlib=pathlib,hashlib=hashlib,re=re,
  subprocess=types.SimpleNamespace(run=adapt),root=base/'absent-owned-root',orig=cfg,
  allowed={'.owner','isolated-443-front.Caddyfile','candidate.pid','candidate.log','original-restored.pid'},
  listener=listener,identity=lambda pid,argv=None:dict(production if pid==200738 else original),
  original_process=lambda:dict(original),emit=lambda stage,**kw:events.append(dict(stage=stage,**kw)))
 names={'sha','filecheck','pids','owned_root','protected','classify_listener','restore'}
 exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),'actual-generated-protected-and-restore','exec'),ns)
 observed=ns['protected']()
 assert isinstance(observed['productionIdentity'],dict), 'tree walk overwrote production identity'
 assert observed['productionIdentity']==production
 result=ns['restore']()
 assert walks==[str(tree)]*3 and probes.count(8451)==3 and probes.count(32552)==3
 assert result['remote']['productionOwners']==[{key:production[key] for key in ('pid','exe','euid','argvConfigMatch','argvSha256')}]
 assert result['staticRoot']=={'fileCount':37,'treeSha256':tree_sha}
 assert events[-1]['stage']=='restore-complete'
 print(json.dumps({'input':p,'stdout':'\n'.join(json.dumps(event) for event in events)+'\n'}))`],
    { input: JSON.stringify({ source: buildSingleConnectionRestore(fixture()) }), encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.equal(raw.error, undefined);
  assert.equal(raw.status, 0, raw.stderr);
  const observed = JSON.parse(raw.stdout);
  const result = parseRestoreReceipt(observed.stdout, observed.input);
  assert.equal(result.remote.productionOwners[0].pid, 200738);
  assert.equal(result.restoredSidecarPid, 34567);
  assert.equal(result.staticRoot.fileCount, 37);
  assert.equal(result.rootRemoval, 'confirmed-absent');
});
