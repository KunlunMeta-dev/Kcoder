import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => broker.routeServerMessage(message);
  let sequence = 0;
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: threadId } } });
    return client;
  };
  return { broker, upstream, emit, join };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const terminal of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
      for (const params of [
        { threadId: 'thread' }, { thread_id: 'thread' },
        { turnId: 'original-turn' }, { turn: { id: 'original-turn' } },
      ]) test(`${kind} ${shared ? 'shared' : 'exclusive'}: ${terminal} ${JSON.stringify(params)} before the first prompt fences late input`, t => {
        const f = fixture(t, shared), owner = f.join('thread');
        const viewer = shared ? f.join('thread') : null;
        const peer = f.join('other-thread');
        f.broker.activeTurns.set('thread', { turnId: 'original-turn', owner });
        f.broker.activeTurns.set('other-thread', { turnId: 'peer-turn', owner: peer });
        f.emit({ method: terminal, params });
        assert.equal(f.broker.activeTurns.has('thread'), false);
        const field = kind === 'question' ? 'questionId' : 'approvalId';
        const request = { id: 500, method: `${kind}/request`, params: {
          threadId: 'thread', turnId: 'original-turn', appServerEpoch: 'epoch', [field]: 'original',
        } };
        const recipients = [owner, viewer, peer].filter(Boolean);
        const counts = recipients.map(client => client.messages.length);
        f.emit(request);
        assert.deepEqual(recipients.map(client => client.messages.length), counts,
          'the first delayed prompt cannot reopen a completed turn');
        assert.equal(f.broker.serverRequests.has(request.id), false);
        assert.equal(f.upstream.at(-1).id, request.id);
        assert.equal(f.upstream.at(-1).error?.code, -32040);
        const sent = f.upstream.length;
        f.emit(request);
        assert.equal(f.upstream.length, sent, 'a refused prompt is not answered twice');
        assert.throws(() => f.broker.receive(owner, JSON.stringify({ id: request.id, result: {
          ...request.params, ...(kind === 'question' ? { answers: {} } : { decision: 'accept' }),
        } })), /unsolicited app-server response/);
        assert.equal(f.upstream.length, sent, 'a stale client reply cannot enter the next turn');
        // Original Native resolution remains available with its full binding.
        const receipt = { method: `${kind}/resolved`, params: { ...request.params,
          requestId: request.id, reason: 'cancelled', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
        f.emit(receipt);
        assert.deepEqual(owner.messages.at(-1), receipt);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
        assert.equal(f.broker.activeTurns.get('other-thread').owner, peer);
        const fresh = { ...request, id: 501, params: { ...request.params, turnId: 'next-turn', [field]: 'next' } };
        f.emit(fresh);
        assert.deepEqual(owner.messages.at(-1), fresh, 'the original task can receive a new turn prompt');
        const peerRequest = { ...request, id: 502, params: { ...request.params,
          threadId: 'other-thread', turnId: 'peer-turn', [field]: 'peer' } };
        f.emit(peerRequest);
        assert.deepEqual(peer.messages.at(-1), peerRequest, 'unrelated task input remains available');
      });
    }
  }
}
