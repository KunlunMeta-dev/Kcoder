import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelWorker } from '../src/channels/worker-client.mjs';

async function fixture(ingest, platform = 'feishu') {
  const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null });
  const replies = [];
  child.send = (message, callback) => {
    if (message.method === 'start') queueMicrotask(() => child.emit('message', { id: message.id, result: { state: 'connected' } }));
    else if (!message.method) { replies.push(message); assert.equal(typeof callback, 'function'); callback(new Error('fixture IPC lost')); }
    return true;
  };
  const worker = new ChannelWorker({ id: 'fixture', platform }, {}, '/unused', { forkWorker: () => child });
  await worker.start(ingest);
  return { child, worker, replies };
}

test('repeated owned child errors settle pending requests without losing the error observer', async () => {
  const { child, worker } = await fixture(async () => ({ accepted: true }));
  const pending = worker.request('state', {}, 1000);
  assert.doesNotThrow(() => child.emit('error', new Error('fixture first IPC error')));
  await assert.rejects(pending, /CHANNEL_WORKER_EXITED/);
  assert.doesNotThrow(() => child.emit('error', new Error('fixture second IPC error')));
  assert.equal(worker.pending.size, 0);
  assert.equal(worker.connectionState(), 'stopped');
});

test('both ingress success and failure replies observe asynchronous IPC send errors', async () => {
  for (const accepted of [true, false]) {
    const { child, replies } = await fixture(async () => {
      if (!accepted) throw new Error('fixture ingestion failed');
      return { accepted: true };
    });
    child.emit('message', { id: 'ingress', method: 'event', params: { event: {} } });
    await new Promise(setImmediate);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, 'ingress');
    assert.equal(replies[0].error, accepted ? undefined : 'CHANNEL_INGRESS_FAILED');
  }
});

test('late ingress completion cannot publish to a disconnected child', async () => {
  let finish;
  const { child, replies } = await fixture(() => new Promise(resolve => { finish = resolve; }));
  child.emit('message', { id: 'ingress', method: 'event', params: { event: {} } });
  child.connected = false; child.emit('exit', 0);
  finish({ accepted: true }); await new Promise(setImmediate);
  assert.deepEqual(replies, []);
});

test('owned state diagnostics allow only the approved code and stay sticky without changing connected', async () => {
  const { child, worker } = await fixture(async () => ({ accepted: true }));
  const state = params => child.emit('message', { method: 'state', params: { state: 'connected', connectionId: 'fixture', generation: worker.generation, ...params } });
  state({ reasonCode: 'PRIVATE_REASON_CANARY', packet: 'PRIVATE_PACKET_CANARY' });
  assert.equal(worker.connectionFailureReason(), null);
  state({ state: 'degraded', reasonCode: 'CHANNEL_INGRESS_FAILED', connectionId: 'peer' });
  state({ state: 'degraded', reasonCode: 'CHANNEL_INGRESS_FAILED', generation: worker.generation - 1 });
  assert.equal(worker.connectionState(), 'connected');
  assert.equal(worker.connectionFailureReason(), null);
  state({ reasonCode: 'CHANNEL_INGRESS_FAILED' });
  state({ reasonCode: null });
  assert.equal(worker.connectionState(), 'connected');
  assert.equal(worker.connectionFailureReason(), 'CHANNEL_INGRESS_FAILED');
  assert.equal(JSON.stringify({ state: worker.connectionState(), reasonCode: worker.connectionFailureReason() }).includes('CANARY'), false);
});

test('state RPC strips diagnostic payloads and rejects a response for another generation', async () => {
  const { child, worker } = await fixture(async () => ({ accepted: true }));
  const pending = worker.request('state', {}, 1000);
  child.emit('message', { id: worker.sequence, result: { state: 'connected', connectionId: 'fixture', generation: worker.generation,
    reasonCode: 'CHANNEL_INGRESS_FAILED', packet: 'PRIVATE_PACKET_CANARY', replyRef: 'PRIVATE_REPLY_CANARY' } });
  assert.deepEqual(await pending, { state: 'connected', reasonCode: 'CHANNEL_INGRESS_FAILED' });
  const stale = worker.request('state', {}, 1000);
  child.emit('message', { id: worker.sequence, result: { state: 'degraded', connectionId: 'fixture', generation: worker.generation - 1,
    reasonCode: 'CHANNEL_INGRESS_FAILED' } });
  await assert.rejects(stale, /CHANNEL_WORKER_SCOPE_CHANGED/);
  assert.equal(worker.connectionState(), 'connected');
});

test('late failure from an exited child cannot set a reason or state on the next owned generation', async () => {
  let rejectIngress;
  const { child, worker, replies } = await fixture(() => new Promise((_resolve, reject) => { rejectIngress = reject; }));
  const oldGeneration = worker.generation;
  child.emit('message', { id: 'old-ingress', method: 'event', params: { event: {} } });
  child.connected = false; child.exitCode = 0; child.emit('exit', 0);
  const next = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null });
  next.send = message => { if (message.method === 'start') queueMicrotask(() => next.emit('message', { id: message.id,
    result: { state: 'connected', connectionId: 'fixture', generation: message.params.generation } })); return true; };
  worker.forkWorker = () => next;
  await worker.start(async () => ({ accepted: true }));
  rejectIngress(new Error('PRIVATE_OLD_INGRESS_CANARY'));
  child.emit('message', { method: 'state', params: { state: 'degraded', reasonCode: 'CHANNEL_INGRESS_FAILED', connectionId: 'fixture', generation: oldGeneration } });
  await new Promise(setImmediate);
  assert.equal(worker.connectionState(), 'connected');
  assert.equal(worker.connectionFailureReason(), null);
  assert.deepEqual(replies, []);
  next.connected = false; next.exitCode = 0; next.emit('exit', 0);
});

test('an already exited start response cannot republish connected or leave pending requests', async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null });
  child.send = message => { queueMicrotask(() => {
    child.emit('message', { id: message.id, result: { state: 'connected', connectionId: 'fixture', generation: message.params.generation } });
    child.exitCode = 0; child.connected = false; child.emit('exit', 0);
  }); return true; };
  const worker = new ChannelWorker({ id: 'fixture' }, {}, '/unused', { forkWorker: () => child });
  await assert.rejects(worker.start(async () => ({})), /CHANNEL_WORKER_EXITED/);
  assert.equal(worker.connectionState(), 'stopped');
  assert.equal(worker.pending.size, 0);
});

test('the parent independently filters RPC error codes and outcome payloads from an owned child', async () => {
  const { child, worker } = await fixture(async () => ({ accepted: true }));
  for (const [code, suppliedOutcome, expectedCode, outcome] of [
    ['PRIVATE_RPC_CANARY', 'failed', 'CHANNEL_WORKER_FAILED', 'unknown'],
    [{ packet: 'PRIVATE_PACKET_CANARY' }, { body: 'PRIVATE_OUTCOME_CANARY' }, 'CHANNEL_WORKER_FAILED', 'unknown'],
    ['PLATFORM_CONTEXT_EXPIRED', 'failed', 'PLATFORM_CONTEXT_EXPIRED', 'failed'],
    ['PLATFORM_HTTP_REJECTED', 'unknown', 'PLATFORM_HTTP_REJECTED', 'unknown'],
    ['PLATFORM_HTTP_REJECTED', { body: 'PRIVATE_OUTCOME_CANARY' }, 'PLATFORM_HTTP_REJECTED', 'unknown'],
  ]) {
    const pending = worker.request('send', {}, 1000);
    child.emit('message', { id: worker.sequence, error: code, externalOutcome: suppliedOutcome });
    await assert.rejects(pending, error => error.code === expectedCode && error.externalOutcome === outcome && !JSON.stringify(error).includes('CANARY'));
  }
});

test('published Weixin reasons are preserved and cleared without clearing sticky ingress uncertainty', async () => {
  const { child, worker } = await fixture(async () => ({ accepted: true }), 'weixin');
  const state = reasonCode => child.emit('message', { method: 'state', params: { state: 'connected', connectionId: 'fixture', generation: worker.generation, reasonCode } });
  state('WEIXIN_CHECKPOINT_FAILED'); assert.equal(worker.connectionFailureReason(), 'WEIXIN_CHECKPOINT_FAILED');
  state('PRIVATE_REASON_CANARY'); assert.equal(worker.connectionFailureReason(), 'WEIXIN_CHECKPOINT_FAILED');
  state(null); assert.equal(worker.connectionFailureReason(), null);
  state('CHANNEL_INGRESS_FAILED'); state(null); assert.equal(worker.connectionFailureReason(), 'CHANNEL_INGRESS_FAILED');
  assert.equal(worker.connectionState(), 'connected');
});
