import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared, reason) {
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
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'original-turn', appServerEpoch: 'epoch', [field]: 'original-interaction',
  } };
  if (reason === 'draining') broker.threadDrains.set('thread', {});
  if (reason === 'stale turn') broker.activeTurns.set('thread', { turnId: 'new-turn', owner });
  if (reason === 'disconnected owner') broker.activeTurns.set('thread', { turnId: 'original-turn', owner: {} });
  if (reason === 'ended turn') emit({ method: 'turn/completed', params: request.params });
  emit(request);
  assert.equal(upstream.at(-1).id, request.id);
  assert.equal(upstream.at(-1).error.code, -32040);
  assert.equal(owner.messages.some(message => message.id === request.id), false);
  const releaseGate = () => {
    broker.threadDrains.delete('thread'); broker.activeTurns.delete('thread');
    // The turn fence is independently bounded; expiry must not revive a refused request.
    if (reason === 'ended turn') for (let index = 0; index < 2048; index++)
      emit({ method: 'turn/completed', params: { threadId: 'other-thread', turnId: `ended-${index}` } });
  };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'cancelled', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
  return { broker, upstream, emit, join, owner, viewer, field, request, receipt, releaseGate };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [true, false]) {
    for (const reason of ['draining', 'stale turn', 'disconnected owner', 'ended turn']) {
      const label = `${kind}: ${shared ? 'shared' : 'exclusive'} ${reason}`;
      test(`${label} refusal answers duplicate transport frames only once`, t => {
        const f = fixture(t, kind, shared, reason), sent = f.upstream.length;
        f.emit(f.request);
        assert.equal(f.upstream.length, sent, 'a refusal already settled the original waiter');
        assert.equal(f.broker.serverRequests.has(f.request.id), false);
      });

      test(`${label} refusal cannot reopen a card after the gate clears and clients reconnect`, t => {
        const f = fixture(t, kind, shared, reason);
        f.releaseGate();
        f.broker.detach(f.owner);
        if (f.viewer) f.broker.detach(f.viewer);
        const late = f.join(), delivered = late.messages.length, sent = f.upstream.length;
        f.emit(f.request);
        assert.equal(late.messages.length, delivered, 'the refused original question must stay closed');
        assert.equal(f.broker.serverRequests.has(f.request.id), false);
        assert.equal(f.upstream.length, sent);
        const fresh = { ...f.request, id: 501, params: { ...f.request.params, turnId: 'fresh-turn', [f.field]: 'fresh' } };
        f.emit(fresh);
        assert.deepEqual(late.messages.at(-1), fresh, 'new interactions remain available');
        assert.equal(f.broker.serverRequests.get(fresh.id), late);
      });

      test(`${label} refusal retains the complete receipt binding and first native outcome`, t => {
        const f = fixture(t, kind, shared, reason);
        f.releaseGate();
        const clients = [f.owner, f.viewer].filter(Boolean);
        const delivered = clients.map(client => client.messages.length);
        const wrongKind = kind === 'question' ? 'approval/resolved' : 'question/resolved';
        for (const invalid of [
          { ...f.receipt, method: wrongKind },
          ...[{ [f.field]: 'wrong' }, { threadId: 'wrong' }, { turnId: 'wrong' }, { appServerEpoch: 'wrong' }]
            .map(params => ({ ...f.receipt, params: { ...f.receipt.params, ...params } })),
        ]) {
          f.emit(invalid);
          assert.deepEqual(clients.map(client => client.messages.length), delivered,
            'a refused transport ID still belongs to its original interaction');
        }
        f.emit(f.receipt);
        for (const client of clients) assert.deepEqual(client.messages.at(-1), f.receipt);
        const settled = clients.map(client => client.messages.length);
        f.emit({ ...f.receipt, params: { ...f.receipt.params, reason: 'client_response' } });
        f.emit(f.request);
        assert.deepEqual(clients.map(client => client.messages.length), settled);
        assert.equal(f.broker.serverRequests.has(f.request.id), false);
      });
    }
  }
}
