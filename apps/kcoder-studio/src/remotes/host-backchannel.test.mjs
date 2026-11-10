import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNativeRemoteHostBackchannel, isNativeRemoteHostMethod } from './host-backchannel.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = (id = 'original-request', method = 'open') => ({ jsonrpc: '2.0', id, method: `server/nativeRemote/${method}`, params: { operationId: 'original-operation' } });

test('host routing requires actual callbacks and never treats a JSON owner claim as a capture', async () => {
  assert.throws(() => createNativeRemoteHostBackchannel({ child: {}, serverId: 'source', owner: true }));
  const child = new EventEmitter(); const replies = []; let calls = 0;
  const host = createNativeRemoteHostBackchannel({ child, serverId: 'source', assertSourceOwner: () => { throw new Error('not captured'); },
    handleOwnedRequest: () => { calls += 1; }, reply: value => replies.push(value) });
  host.receiveBackend({ ...frame(), authority: true }); await tick();
  assert.equal(calls, 0); assert.equal(replies[0].error.message, 'REMOTE_HOST_RECONCILE_ORIGINAL'); host.close();
});

test('original request IDs cannot replay effects and source child identity is checked around awaits', async () => {
  const child = new EventEmitter(); const replies = []; let checks = 0; let calls = 0;
  const host = createNativeRemoteHostBackchannel({ child, serverId: 'source', assertSourceOwner: observed => {
    assert.equal(observed.child, child); assert.equal(observed.serverId, 'source'); checks += 1;
  }, handleOwnedRequest: async () => { calls += 1; return { operationId: 'original-operation' }; }, reply: value => replies.push(value) });
  assert.equal(host.receiveBackend(frame()), true); await tick(); host.receiveBackend(frame()); await tick();
  assert.equal(calls, 1); assert.equal(checks, 2); assert.ok(replies.some(value => value.error?.message === 'REMOTE_HOST_RECONCILE_ORIGINAL')); host.close();
});

test('child close aborts owned work and late results do not escape to a replacement connection', async () => {
  const child = new EventEmitter(); const replies = []; let finish; let signal;
  const host = createNativeRemoteHostBackchannel({ child, serverId: 'source', assertSourceOwner: () => {},
    handleOwnedRequest: input => { signal = input.signal; return new Promise(resolve => { finish = resolve; }); }, reply: value => replies.push(value) });
  host.receiveBackend(frame()); await tick(); child.emit('close'); assert.equal(signal.aborted, true);
  finish({ ignored: 'late' }); await tick(); assert.deepEqual(replies, []);
});

test('unknown private methods and no-id requests cannot execute and ordinary messages stay outside this lane', async () => {
  const child = new EventEmitter(); let calls = 0; const replies = [];
  const host = createNativeRemoteHostBackchannel({ child, serverId: 'source', assertSourceOwner: () => {},
    handleOwnedRequest: () => { calls += 1; }, reply: value => replies.push(value) });
  host.receiveBackend(frame('x', 'arbitrary')); const noId = frame(); delete noId.id; host.receiveBackend(noId);
  assert.equal(host.receiveBackend({ method: 'turn/completed' }), false); await tick(); assert.equal(calls, 0);
  assert.equal(replies.length, 2); assert.equal(isNativeRemoteHostMethod('thread/start'), false); host.close();
});


test('private open observations reveal only fixed stages and closed codes without changing receipts', async () => {
  const child = new EventEmitter(); const replies = []; const diagnostics = [];
  const host = createNativeRemoteHostBackchannel({ child, serverId: 'source',
    assertSourceOwner() {}, handleOwnedRequest() { throw new Error('secret-account-path-and-token'); },
    diagnosticSink: value => diagnostics.push(value), reply: value => replies.push(value) });
  const request = frame(); request.params.secret = 'must-never-be-logged';
  host.receiveBackend(request); await tick();
  assert.deepEqual(diagnostics, [
    { event: 'native-remote-host', stage: 'open_received', state: 'observed', code: null },
    { event: 'native-remote-host', stage: 'backchannel_owned_request', state: 'rejected', code: 'REMOTE_HOST_UNCLASSIFIED' },
  ]);
  assert.equal(replies[0].error.message, 'REMOTE_HOST_RECONCILE_ORIGINAL');
  assert.ok(!JSON.stringify(diagnostics).includes('secret'));
  host.close();
});
