import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared, legacy = false) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  // Exercise the actual JSONL decoder and broker routing, without a model or service.
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = (threadId = 'thread') => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: threadId } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = index => ({ id: 1000 + index, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'old-turn', [field]: `interaction-${index}`,
    ...(legacy ? {} : { appServerEpoch: 'original-epoch' }),
  } });
  for (let index = 0; index < 512; index++) {
    const message = request(index);
    emit(message);
    if (legacy) broker.receive(owner, JSON.stringify({ id: message.id,
      result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
  }
  if (!legacy) emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'old-turn' } });
  const next = { ...request(512), params: { ...request(512).params, turnId: 'new-turn' } };
  emit(next);
  assert.deepEqual(owner.messages.at(-1), next, 'capacity eviction must still admit the next interaction');
  const original = request(0);
  const receipt = { method: `${kind}/resolved`, params: { ...original.params, requestId: original.id,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  return { broker, upstream, owner, viewer, join, emit, field, original, receipt };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [true, false]) {
    for (const mismatch of ['identity', 'missing identity', 'type', 'turn', 'thread', 'epoch', 'missing epoch']) {
      test(`${kind}: evicted ended ${shared ? 'shared' : 'exclusive'} binding rejects ${mismatch}`, t => {
        const f = fixture(t, kind, shared);
        const unrelated = f.join('other-thread');
        const clients = [f.owner, f.viewer, unrelated].filter(Boolean);
        const invalid = structuredClone(f.receipt);
        if (mismatch === 'identity') invalid.params[f.field] = 'another-interaction';
        if (mismatch === 'missing identity') delete invalid.params[f.field];
        if (mismatch === 'type') invalid.method = kind === 'question' ? 'approval/resolved' : 'question/resolved';
        if (mismatch === 'turn') invalid.params.turnId = 'another-turn';
        if (mismatch === 'thread') invalid.params.threadId = 'other-thread';
        if (mismatch === 'epoch') invalid.params.appServerEpoch = 'another-epoch';
        if (mismatch === 'missing epoch') delete invalid.params.appServerEpoch;
        const before = clients.map(client => client.messages.length);
        f.emit(invalid);
        assert.deepEqual(clients.map(client => client.messages.length), before,
          'freeing pending capacity must preserve the original receipt binding');
        f.emit(f.receipt);
        assert.deepEqual(f.owner.messages.at(-1), f.receipt, 'a mismatch cannot consume the true late outcome');
        const after = clients.map(client => client.messages.length);
        f.emit({ ...f.receipt, params: { ...f.receipt.params, reason: 'cancelled' } });
        f.emit(f.original);
        assert.deepEqual(clients.map(client => client.messages.length), after);
        assert.equal(f.broker.serverRequests.has(f.original.id), false);
      });
    }

    test(`${kind}: evicted ${shared ? 'shared' : 'exclusive'} binding fences a reused request ID before any receipt`, t => {
      const f = fixture(t, kind, shared);
      const before = f.owner.messages.length, sent = f.upstream.length;
      f.emit({ ...f.original, params: { ...f.original.params, turnId: 'new-turn', [f.field]: 'conflicting' } });
      assert.equal(f.owner.messages.length, before, 'an evicted transport ID cannot reopen a conflicting card');
      assert.equal(f.upstream.length, sent, 'a collision cannot settle the original waiter');
      assert.equal(f.broker.serverRequests.has(f.original.id), false);
      f.broker.detach(f.owner);
      if (f.viewer) f.broker.detach(f.viewer);
      const late = f.join();
      const delivered = late.messages.length;
      f.emit({ ...f.receipt, params: { ...f.receipt.params, appServerEpoch: 'wrong-epoch' } });
      assert.equal(late.messages.length, delivered, 'the evicted binding also survives recipient disconnect');
      f.emit(f.receipt);
      assert.deepEqual(late.messages.at(-1), f.receipt);
    });
  }

  test(`${kind}: evicted legacy reply retains its identity and absent epoch`, t => {
    const f = fixture(t, kind, false, true);
    const before = f.owner.messages.length;
    f.emit({ ...f.receipt, params: { ...f.receipt.params, appServerEpoch: 'new-epoch' } });
    assert.equal(f.owner.messages.length, before);
    f.emit(f.receipt);
    assert.deepEqual(f.owner.messages.at(-1), f.receipt);
    assert.equal(f.broker.serverRequests.size, 1);
  });
}
