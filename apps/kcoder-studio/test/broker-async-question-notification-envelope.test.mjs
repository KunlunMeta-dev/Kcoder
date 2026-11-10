import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current',
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const resume = (threadId, async = true) => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: async });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: threadId } } }) };
  };
  return { broker, upstream, emit, resume };
}

const changed = (threadId, serverId = 'server-current') => ({ method: 'asyncQuestion/changed', params: {
  serverId, threadId, question: { threadId, questionId: 'async-question', revision: 1 },
} });

for (const shared of [false, true]) {
  for (const id of [null, 500, 'request-500']) {
    test(`${shared ? 'shared' : 'exclusive'}: async update request id=${id} cannot replace an original question owner`, t => {
      const f = fixture(t, shared), original = f.resume('original'), peer = f.resume('peer', false);
      original.finish(); peer.finish();
      const question = { id, method: 'question/request', params: {
        threadId: 'original', turnId: 'turn', questionId: 'question', questions: [],
      } };
      // Null is not a valid original request ID; it must still never be registered by an update.
      if (id !== null) f.emit(question);
      const before = peer.client.messages.length, writes = f.upstream.length;
      for (const serverId of ['server-current', 'server-previous'])
        f.emit({ ...changed('peer', serverId), id });
      assert.equal(peer.client.messages.length, before, 'request envelopes cannot bypass notification capability checks');
      assert.equal(f.broker.serverRequests.get(id), id === null ? undefined : original.client,
        'an update cannot overwrite the waiter of another task');
      assert.equal(f.upstream.length, writes, 'never reply to the update ID, which may belong to a real waiter');
      if (id !== null) {
        f.broker.receive(original.client, JSON.stringify({ id, result: { answers: {} } }));
        assert.equal(f.upstream.filter(message => message.id === id && message.result).length, 1,
          'the original question remains answerable exactly once');
      }
      const valid = changed('original');
      f.emit(valid);
      assert.deepEqual(original.client.messages.at(-1), valid, 'later valid notifications remain deliverable');
      assert.equal(peer.client.messages.length, before);
    });

    test(`${shared ? 'shared' : 'exclusive'}: async update request id=${id} cannot be refused or delivered during recovery`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume('original') : null;
      owner?.finish();
      const recovering = f.resume('original');
      const writes = f.upstream.length, ownerMessages = owner?.client.messages.length;
      f.emit({ ...changed('original'), id });
      assert.equal(f.upstream.length, writes, 'unowned recovery must not send an error to a potentially live request ID');
      assert.equal(f.broker.serverRequests.has(id), false);
      const valid = changed('original');
      f.emit(valid); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread, 'the original task still resumes');
      assert.deepEqual(recovering.client.messages.slice(1), [valid]);
      if (owner) assert.deepEqual(owner.client.messages.slice(ownerMessages), [valid]);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}
