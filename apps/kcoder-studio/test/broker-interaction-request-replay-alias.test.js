import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current' } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: threadId } } });
    return client;
  };
  const owner = join('original'), peer = join('peer');
  const viewer = shared ? join('original') : null;
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    serverId: 'server-current', threadId: 'original', turnId: 'turn', [field]: 'original-card',
    appServerEpoch: 'epoch',
  } };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params, requestId: request.id,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  const reply = () => broker.receive(owner, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
  return { broker, upstream, emit, owner, peer, viewer, request, receipt, reply };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const state of ['pending', 'resolved', 'refused', 'detached']) {
      test(`${kind}: alias replay preserves ${state} request identity (shared=${shared})`, t => {
        const f = fixture(t, shared, kind);
        if (state === 'refused') f.broker.beginThreadDrain('original', 'turn');
        f.emit(f.request);
        if (state === 'refused') f.broker.finishThreadDrain('original');
        if (state === 'resolved') { f.reply(); f.emit(f.receipt); }
        if (state === 'detached') f.broker.detach(f.owner);
        const clients = [f.owner, f.peer, f.viewer].filter(Boolean);
        const counts = clients.map(client => client.messages.length), writes = f.upstream.length;
        const { threadId: _threadId, ...params } = f.request.params;
        for (const locator of [
          { thread_id: 'peer' }, { thread: { id: 'peer' } }, { widget: { threadId: 'peer' } },
          { threadId: null, thread_id: 'peer' }, {},
        ]) f.emit({ ...f.request, params: { ...params, ...locator } });
        assert.deepEqual(clients.map(client => client.messages.length), counts,
          'a reused transport ID cannot deliver another card through compatibility routing');
        assert.equal(f.upstream.length, writes,
          'a replay cannot reject or consume the app-server original waiter');
        assert.equal(f.broker.serverRequests.get(500), state === 'pending' ? f.owner : undefined,
          'replays preserve pending ownership and cannot reopen retired input');
        if (state === 'pending') {
          f.reply();
          assert.equal(f.upstream.length, writes + 1, 'the original client can still answer once');
        }
        if (state !== 'resolved') {
          f.emit(f.receipt);
          assert.deepEqual(f.peer.messages.length, counts[1], 'original receipts cannot leak to the peer task');
          if (state !== 'detached') assert.deepEqual(f.owner.messages.at(-1), f.receipt);
          if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), f.receipt);
        }
      });
    }

    test(`${kind}: a new legacy alias request still reaches its original task (shared=${shared})`, t => {
      const f = fixture(t, shared, kind);
      const { threadId: _threadId, ...params } = f.request.params;
      const legacy = { ...f.request, params: { ...params, thread_id: 'original' } };
      f.emit(legacy);
      assert.deepEqual(f.owner.messages.at(-1), legacy);
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      const writes = f.upstream.length;
      f.reply();
      assert.equal(f.upstream.length, writes + 1, 'first delivery preserves legacy reply compatibility');
      assert.equal(f.peer.messages.length, 1);
    });
  }
}
