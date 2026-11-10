import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = index => ({ id: 1000 + index, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', [field]: `interaction-${index}`,
  } });
  const receipt = message => ({ method: `${kind}/resolved`, params: { ...message.params,
    requestId: message.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } });
  for (let index = 0; index < 512; index++) emit(request(index));
  const rejected = request(512);
  emit(rejected);
  assert.equal(upstream.at(-1).id, rejected.id);
  assert.equal(upstream.at(-1).error.code, -32040);
  return { broker, upstream, emit, join, owner, viewer, field, request, receipt, rejected };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [true, false]) {
    const label = `${kind}: ${shared ? 'shared' : 'exclusive'}`;
    test(`${label} capacity rejection is not repeated for duplicate transport frames`, t => {
      const f = fixture(t, kind, shared);
      const sent = f.upstream.length;
      f.emit(f.rejected);
      assert.equal(f.upstream.length, sent, 'the same waiter must receive at most one rejection');
      assert.equal(f.broker.serverRequests.has(f.rejected.id), false);
    });

    test(`${label} a refused request cannot reopen a card after capacity is released`, t => {
      const f = fixture(t, kind, shared);
      f.emit(f.receipt(f.request(0)));
      const before = [f.owner, f.viewer].filter(Boolean).map(client => client.messages.length);
      const sent = f.upstream.length;
      f.emit(f.rejected);
      assert.deepEqual([f.owner, f.viewer].filter(Boolean).map(client => client.messages.length), before,
        'a definite refusal must survive capacity becoming available');
      assert.equal(f.broker.serverRequests.has(f.rejected.id), false);
      assert.equal(f.upstream.length, sent);
      const fresh = f.request(513);
      f.emit(fresh);
      assert.deepEqual(f.owner.messages.at(-1), fresh, 'a new request may use the released capacity');
      assert.equal(f.broker.serverRequests.get(fresh.id), f.owner);
    });

    test(`${label} a refused binding survives disconnect and rejects mismatched terminal receipts`, t => {
      const f = fixture(t, kind, shared);
      f.broker.detach(f.owner);
      if (f.viewer) f.broker.detach(f.viewer);
      const late = f.join();
      const delivered = late.messages.length, sent = f.upstream.length;
      f.emit({ ...f.rejected, params: { ...f.rejected.params, [f.field]: 'conflicting' } });
      assert.equal(late.messages.length, delivered, 'a new client cannot acquire a refused transport ID');
      assert.equal(f.upstream.length, sent);
      const receipt = f.receipt(f.rejected);
      f.emit({ ...receipt, params: { ...receipt.params, appServerEpoch: 'wrong-epoch' } });
      f.emit({ ...receipt, params: { ...receipt.params, [f.field]: 'wrong-identity' } });
      assert.equal(late.messages.length, delivered, 'the original refused binding still fences receipts');
      f.emit(receipt);
      assert.deepEqual(late.messages.at(-1), receipt, 'the first authoritative receipt remains observable');
      const settled = late.messages.length;
      f.emit(f.rejected);
      f.emit({ ...receipt, params: { ...receipt.params, reason: 'cancelled' } });
      assert.equal(late.messages.length, settled, 'terminal receipt and request replays remain fenced');
    });
  }
}
