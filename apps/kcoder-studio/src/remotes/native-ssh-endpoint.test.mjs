import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createNativeSshEndpointFactory } from './native-ssh-endpoint.mjs';
import { captureNativeRemoteSourceClient } from './source-client-owner.mjs';
import { workspaceCwdObservationTargetIdentity } from '../workspace-cwd-observation.js';

function fixture() {
  const source = { id: 'source', runtime: 'kcoder', transport: 'local' };
  const target = { id: 'receiver', runtime: 'kcoder', transport: 'ssh', host: 'owned-alias',
    command: '/opt/owned/kcoder', remoteCwd: '/tmp/owned-receiver' };
  const targets = new Map([[source.id, source], [target.id, target]]);
  const client = { initialized: true, authorizationOwner: 'owned-login' };
  const broker = { closed: false, clients: new Set([client]) };
  const session = { allowedServerIds: new Set(targets.keys()) };
  const owner = captureNativeRemoteSourceClient({ client, broker, sourceTarget: source, session,
    authorizationOwner: client.authorizationOwner, verifySession: () => true,
    getTarget: id => targets.get(id), targetSignature: JSON.stringify,
    accountIdentity: () => null, accountGeneration: () => 1 });
  const sourceChild = {};
  const params = { operationId: 'owned-operation', endpointInstanceId: 'owned-endpoint',
    sourceAcceptedSha256: 'a'.repeat(64), sourceAttempt: { threadId: 'original-thread', turnId: 'original-turn', attemptId: 'original-attempt' },
    deadlineUtcMs: Date.now() + 30000, target: { targetId: target.id,
      targetRevision: workspaceCwdObservationTargetIdentity(JSON.stringify(target)),
      targetPlatform: 'linux', expectedNativeSha256: 'b'.repeat(64) } };
  return { sourceChild, target, targets, session, owner, params, base: { child: sourceChild, serverId: source.id } };
}

function ownedNodeChild(ready) {
  // Real owned OS pipes, synthetic gate. This proves byte/lifecycle behavior;
  // it does not claim SSH authentication or Native Receiver authority.
  const code = `process.stdout.write(${JSON.stringify(ready + '\n')}+JSON.stringify({jsonrpc:'2.0',method:'owned/ready'})+'\\n');
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result:{owned:true}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
  return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
}

test('uncaptured source and unapproved target are rejected before an SSH process exists', async () => {
  for (const uncaptured of [true, false]) {
    const f = fixture(); let spawned = 0;
    if (!uncaptured) f.session.allowedServerIds.delete(f.target.id);
    const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {},
      sourceClientForAttempt: () => uncaptured ? { verify() {} } : f.owner,
      spawnChild() { spawned++; throw new Error('not reached'); } });
    await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params }));
    assert.equal(spawned, 0);
    await factory.close();
  }
});

test('owned endpoint consumes one image gate, preserves tail frames and never replays a write', async () => {
  const f = fixture(); let spawned = 0; let nativeActive = true;
  const factory = createNativeSshEndpointFactory({
    assertSourceNativeChild({ child, serverId }) { assert.equal(child, f.sourceChild); assert.equal(serverId, 'source'); assert.ok(nativeActive); },
    sourceClientForAttempt: () => f.owner,
    spawnChild(command, args, options) {
      spawned++; assert.equal(command, 'ssh');
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.ok(Object.keys(options.env).every(name => !name.toUpperCase().startsWith('KCODER_')));
      return ownedNodeChild('kcoder-native-acp-image-v1:' + 'b'.repeat(64) + ':linux');
    } });
  try {
    assert.equal((await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params })).state, 'opened');
    const read = await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/exchange', params: {
      ...f.params, direction: 'frame_read', acknowledgeThrough: 0, maximumFrames: 16, waitMs: 500 } });
    assert.equal(read.frames[0].frame.method, 'owned/ready');
    const write = { ...f.params, direction: 'frame_write', sequence: 1, frame: { jsonrpc: '2.0', id: 7, method: 'owned/check' } };
    assert.equal((await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/exchange', params: write })).state, 'transport_written');
    await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/exchange', params: write }), /RECONCILE_ORIGINAL/);
    await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params }));
    assert.equal(spawned, 1);
    nativeActive = false;
    const closed = await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/close', params: f.params });
    assert.equal(closed.nativeOwnerCleanupConfirmed, false);
  } finally { await factory.close(); }
});

test('a wrong image gate cannot expose ACP bytes and its exact child is closed', async () => {
  const f = fixture(); let sshChild;
  const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {}, sourceClientForAttempt: () => f.owner,
    spawnChild() { return sshChild = ownedNodeChild('wrong-image'); } });
  await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params }), /UNCONFIRMED/);
  assert.notEqual(sshChild.exitCode, null);
  await factory.close();
});

test('target revocation after opening blocks another write and still permits owned cleanup', async () => {
  const f = fixture();
  const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {}, sourceClientForAttempt: () => f.owner,
    spawnChild: () => ownedNodeChild('kcoder-native-acp-image-v1:' + 'b'.repeat(64) + ':linux') });
  await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params });
  f.session.allowedServerIds.delete(f.target.id);
  await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/exchange', params: {
    ...f.params, direction: 'frame_write', sequence: 1, frame: { jsonrpc: '2.0', id: 1, method: 'never-written' } } }));
  const result = await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/close', params: f.params });
  assert.equal(result.nativeOwnerCleanupConfirmed, false);
  await factory.close();
});

test('closed transport retains only a current owner observation and never spawns a replacement', async () => {
  const f=fixture();let count=0;
  const factory=createNativeSshEndpointFactory({assertSourceNativeChild() {},sourceClientForAttempt:()=>f.owner,
    spawnChild:()=>{count++;return ownedNodeChild('kcoder-native-acp-image-v1:'+'b'.repeat(64)+':linux');}});
  await factory.handleOwnedRequest({...f.base,method:'server/nativeRemote/open',params:f.params});
  await factory.handleOwnedRequest({...f.base,method:'server/nativeRemote/close',params:f.params});
  const request={...f.base,method:'server/nativeRemote/exchange',params:{...f.params,direction:'owner_observe'}};
  assert.equal((await factory.handleOwnedRequest(request)).state,'owner_observed');
  assert.equal(count,1);
  f.session.allowedServerIds.delete(f.target.id);
  await assert.rejects(factory.handleOwnedRequest(request));
  assert.equal(count,1);
  await factory.close();
});


test('open diagnostics separate original source, target, launch and image gate rejections', async () => {
  for (const expected of ['source_socket_owner', 'selected_target_owner', 'pinned_launch_spec', 'ssh_image_gate']) {
    const f = fixture(); const diagnostics = []; let spawned = 0;
    if (expected === 'selected_target_owner') f.params.target.targetRevision = 'changed-revision';
    if (expected === 'pinned_launch_spec') {
      f.target.remoteCwd = 'invalid-private-path';
      f.params.target.targetRevision = workspaceCwdObservationTargetIdentity(JSON.stringify(f.target));
    }
    const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {},
      sourceClientForAttempt() {
        if (expected === 'source_socket_owner') throw new Error('REMOTE_HOST_SOURCE_CLIENT_CHANGED');
        return f.owner;
      },
      diagnosticSink: value => diagnostics.push(value),
      spawnChild() { spawned++; return ownedNodeChild('wrong-image'); },
    });
    await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params }));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, expected);
    assert.equal(diagnostics[0].state, 'rejected');
    assert.ok(!JSON.stringify(diagnostics).includes('invalid-private-path'));
    assert.equal(spawned, expected === 'ssh_image_gate' ? 1 : 0);
    if (expected === 'source_socket_owner' || expected === 'selected_target_owner')
      assert.equal(diagnostics[0].code, 'REMOTE_HOST_SOURCE_CLIENT_CHANGED');
    await factory.close();
  }
});

test('current management lane launches only a fixed reader without another ACP invocation or endpoint record', async () => {
  const f = fixture(); let spawned = 0; let stopped = 0;
  const original = { requestId: 'read-original', operationId: f.params.operationId,
    endpointInstanceId: f.params.endpointInstanceId };
  const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {},
    sourceClientForAttempt: () => assert.fail('terminal turn must not be resolved'),
    sourceClientForManagement: () => f.owner,
    spawnChild(command, args) {
      spawned++; assert.equal(command, 'ssh');
      const script = args.at(-1);
      assert.match(script, /--internal-native-remote-read-v1/);
      assert.doesNotMatch(script, /'acp'/);
      const ready = 'kcoder-native-acp-image-v1:' + f.params.target.expectedNativeSha256 + ':linux';
      const code = `process.stdout.write(${JSON.stringify(ready + '\n')});let buffer='';process.stdin.on('data',b=>buffer+=b);process.stdin.on('end',()=>{const original=JSON.parse(buffer);process.stdout.write(JSON.stringify({original,outcome:'completed',finishedAtMs:17})+'\\n');});`;
      return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    }, async stopChild(child) { stopped++; child.kill(); } });
  try {
    const reply = await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/readOriginal',
      params: { managementRpcId: 17, original, target: f.params.target, deadlineUtcMs: Date.now() + 3000 } });
    assert.deepEqual(reply, { original, outcome: 'completed', finishedAtMs: 17 });
    assert.equal(spawned, 1); assert.equal(stopped, 1);
    await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/exchange',
      params: { ...f.params, direction: 'owner_observe' } }));
  } finally { await factory.close(); }
});

test('a reader rejects changed current access and invalid bytes while stopping only its captured child', async () => {
  for (const mode of ['revoke', 'oversize', 'invalid-utf8']) {
    const f = fixture(); let stopped = 0;
    const original = { requestId: 'read-original', operationId: f.params.operationId,
      endpointInstanceId: f.params.endpointInstanceId };
    const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {}, sourceClientForAttempt: () => f.owner,
      sourceClientForManagement: () => f.owner,
      spawnChild() {
        const ready = 'kcoder-native-acp-image-v1:' + f.params.target.expectedNativeSha256 + ':linux';
        const code = `process.stdout.write(${JSON.stringify(ready + '\n')});process.stdin.on('data',()=>{});process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(${mode === 'oversize' ? "'x'.repeat(32769)" : mode === 'invalid-utf8' ? "Buffer.from([0xc0,0xaf,0x0a])" : JSON.stringify(JSON.stringify({ original, outcome: 'completed', finishedAtMs: 1 }) + '\n')}),40));`;
        const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
        if (mode === 'revoke') child.stdin.once('finish', () => f.session.allowedServerIds.delete(f.target.id));
        return child;
      }, async stopChild(child) { stopped++; child.kill(); } });
    try {
      await assert.rejects(factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/readOriginal',
        params: { managementRpcId: 17, original, target: f.params.target, deadlineUtcMs: Date.now() + 3000 } }));
      assert.equal(stopped, 1);
    } finally { await factory.close(); }
  }
});

test('management polling leaves a live original transport and its cancellation owner intact', async () => {
  const f = fixture(); let spawned = 0;
  const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {},
    sourceClientForAttempt: () => f.owner, sourceClientForManagement: () => f.owner,
    spawnChild() { spawned++; return ownedNodeChild('kcoder-native-acp-image-v1:' + f.params.target.expectedNativeSha256 + ':linux'); } });
  try {
    await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/open', params: f.params });
    const original = { requestId: 'poll-live-original', operationId: f.params.operationId,
      endpointInstanceId: f.params.endpointInstanceId };
    const reply = await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/readOriginal',
      params: { managementRpcId: 91, original, target: f.params.target, deadlineUtcMs: Date.now() + 3000 } });
    assert.deepEqual(reply, { original, outcome: null, finishedAtMs: null });
    assert.equal(spawned, 1);
    const closed = await factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/close', params: f.params });
    assert.equal(closed.transportCleanupConfirmed, true);
  } finally { await factory.close(); }
});

test('factory shutdown awaits the specific pending readonly SSH child cleanup', async () => {
  const f = fixture(); let announceRead; let announceCleanup; let releaseCleanup;
  const readStarted = new Promise(resolve => { announceRead = resolve; });
  const cleanupStarted = new Promise(resolve => { announceCleanup = resolve; });
  const release = new Promise(resolve => { releaseCleanup = resolve; });
  const factory = createNativeSshEndpointFactory({ assertSourceNativeChild() {},
    sourceClientForAttempt: () => f.owner, sourceClientForManagement: () => f.owner,
    spawnChild() {
      const ready = 'kcoder-native-acp-image-v1:' + f.params.target.expectedNativeSha256 + ':linux';
      const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(ready + '\n')});process.stdin.on('data',()=>{});process.stdin.on('end',()=>setTimeout(()=>{},10000));`],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.once('finish', announceRead);
      return child;
    }, async stopChild(child) { announceCleanup(); await release; child.kill(); } });
  const request = factory.handleOwnedRequest({ ...f.base, method: 'server/nativeRemote/readOriginal', params: {
    managementRpcId: 19, original: { requestId: 'read-original', operationId: f.params.operationId,
      endpointInstanceId: f.params.endpointInstanceId }, target: f.params.target, deadlineUtcMs: Date.now() + 3000,
  } }).then(() => assert.fail('closed reader cannot publish a result'), () => {});
  try {
    await readStarted;
    let closed = false;
    const closing = factory.close().then(() => { closed = true; });
    await cleanupStarted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown owns and awaits this reader cleanup');
    releaseCleanup();
    await Promise.all([closing, request]);
    assert.equal(closed, true);
  } finally { releaseCleanup(); await factory.close(); }
});
