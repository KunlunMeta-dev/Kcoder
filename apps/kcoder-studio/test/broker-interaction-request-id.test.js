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
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, join };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    test(`${kind}: invalid request IDs cannot open unresolvable cards (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : null;
      const params = { threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
        [kind === 'question' ? 'questionId' : 'approvalId']: 'original' };
      const counts = [owner.messages.length, viewer?.messages.length];
      const writes = f.upstream.length;
      for (const id of [null, true, {}, [], -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', ' ']) {
        f.emit({ id, method: `${kind}/request`, params });
        assert.deepEqual([owner.messages.length, viewer?.messages.length], counts,
          `unresolvable ID ${JSON.stringify(id)} must not become a card`);
        assert.equal(f.broker.serverRequests.size, 0, 'invalid IDs must not reserve reply ownership');
        assert.equal(f.upstream.length, writes, 'an invalid ID cannot certify a waiter to reject');
      }
      // Rejected input must not consume the bounded interaction capacity.
      for (let index = 0; index < 513; index++)
        f.emit({ id: index + 0.5, method: `${kind}/request`, params });
      const prompt = { id: 500, method: `${kind}/request`, params };
      f.emit(prompt);
      assert.deepEqual(owner.messages.at(-1), prompt, 'the original valid question remains available');
      if (viewer) assert.deepEqual(viewer.messages.at(-1), prompt);
      f.broker.receive(owner, JSON.stringify({ id: prompt.id,
        result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
      assert.equal(f.upstream.length, writes + 1, 'the valid reply reaches only its original waiter');
      const receipt = { method: `${kind}/resolved`, params: { ...params, requestId: prompt.id,
        reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
      f.emit(receipt);
      assert.deepEqual(owner.messages.at(-1), receipt);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
    });

    for (const id of [0, Number.MAX_SAFE_INTEGER, 'legacy-request']) {
      test(`${kind}: valid request ID ${id} retains reply and receipt binding (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join();
        const params = { threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
          [kind === 'question' ? 'questionId' : 'approvalId']: 'original' };
        const prompt = { id, method: `${kind}/request`, params };
        f.emit(prompt);
        assert.deepEqual(owner.messages.at(-1), prompt);
        const writes = f.upstream.length;
        f.broker.receive(owner, JSON.stringify({ id,
          result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
        assert.equal(f.upstream.length, writes + 1);
        const receipt = { method: `${kind}/resolved`, params: { ...params, requestId: id,
          reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
        f.emit(receipt);
        assert.deepEqual(owner.messages.at(-1), receipt);
      });
    }
  }
}
