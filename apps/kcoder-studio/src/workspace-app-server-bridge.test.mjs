import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkspaceAppServerBridge } from './workspace-app-server-bridge.mjs';
import { requireCapturedNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';

function fixture() {
  const socket = new EventEmitter();
  Object.assign(socket, { writable: true, destroyed: false, write: () => true,
    pause() {}, resume() {}, isPaused: () => false,
    end() { this.writable = false; }, destroy() { this.destroyed = true; } });
  const calls = { detached: 0, idle: 0, stopped: 0, blocked: 0, released: 0, received: [] };
  const target = { id: 'source', runtime: 'kcoder', transport: 'local' };
  const session = { allowedServerIds: new Set(['source']) };
  let sessionActive = true;
  const broker = { closed: false, clients: new Set(), attach(client) { client.initialized = true; this.clients.add(client); },
    detach(client) { calls.detached++; this.clients.delete(client); },
    receive(client, raw) { calls.received.push({ client, raw }); },
    blockStdout() { calls.blocked++; }, releaseStdout() { calls.released++; } };
  const retention = Object.freeze({ marker: 'original-retention-capability' });
  const bridge = createWorkspaceAppServerBridge({
    captureRetentionAuthority: () => retention, mobileDeviceFamilies: new Map(),
    serversById: new Map([['source', target]]), workspaceBrokerKey: () => 'original-broker-selection',
    loginContexts: { identity: () => null, generation: () => 1 },
    mcpCallbacks: { create() {} }, maxMessageBytes: 1024,
    frame: value => value, decodeFrames: value => ({ rest: Buffer.alloc(0), controls: [], messages: [value.toString()] }),
    WebSocketLivenessLease: class { start() {} stop() { calls.stopped++; } pong() {} },
    scheduleWorkspaceBrokerIdle() { calls.idle++; }, targetSignature: JSON.stringify,
    serverHealthSignature: JSON.stringify,
    verifySession: (id, observed) => id === 'original-session' && observed === session && sessionActive,
  });
  bridge(socket, target, 'runtime', { broker, key: 'original-broker-selection' }, Buffer.alloc(0),
    'https://owned-gateway.example', 'original-login-owner', session, '/owned-workspace', 'original-session');
  return { socket, broker, calls, client: [...broker.clients][0], retention,
    revoke() { sessionActive = false; } };
}

test('existing socket attachment keeps its retention authority and captures only the actual session', () => {
  const f = fixture();
  assert.equal(f.client.retentionAuthority, f.retention);
  assert.equal(requireCapturedNativeRemoteSourceClient(f.client.nativeRemoteSourceOwner), f.client.nativeRemoteSourceOwner);
  f.revoke();
  assert.throws(() => f.client.nativeRemoteSourceOwner.verify());
  f.socket.emit('close');
});

test('socket frame delivery stays bound to the original attached broker client', () => {
  const f = fixture();
  f.socket.emit('data', Buffer.from('original-frame'));
  assert.deepEqual(f.calls.received, [{ client: f.client, raw: 'original-frame' }]);
  f.socket.emit('close');
});

test('send distinguishes an unwritable socket from a queued frame under backpressure', () => {
  const f = fixture();
  let writes = 0;
  f.socket.writable = false;
  f.socket.write = () => { writes++; return false; };
  assert.deepEqual(f.client.sendWithQueueStatus({ value: 1 }), { queued: false, writable: false });
  assert.equal(writes, 0);
  f.socket.writable = true;
  assert.deepEqual(f.client.sendWithQueueStatus({ value: 1 }), { queued: true, writable: false });
  assert.equal(writes, 1);
  assert.equal(f.calls.blocked, 1);
  f.socket.emit('drain');
  assert.equal(f.calls.released, 1);
  f.socket.emit('close');
});

test('end, error and close detach only once and do not stop the shared broker', () => {
  const f = fixture();
  f.socket.emit('end'); f.socket.emit('close'); f.socket.emit('error', new Error('owned disconnect'));
  assert.equal(f.calls.detached, 1);
  assert.equal(f.calls.idle, 1);
  assert.equal(f.calls.stopped, 1);
  assert.equal(f.broker.closed, false);
  assert.equal(f.broker.clients.size, 0);
  assert.throws(() => f.client.nativeRemoteSourceOwner.verify());
});
