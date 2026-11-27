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
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, join };
}

for (const shared of [false, true]) {
  for (const availableDecisions of [{}, true, 1, 'accept', [], ['decline'], undefined, null]) {
    test(`question answers ignore approval-only metadata ${JSON.stringify(availableDecisions)} (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : null;
      const prompt = { id: 500, method: 'question/request', params: {
        threadId: 'thread', turnId: 'turn', questionId: 'original', appServerEpoch: 'epoch', availableDecisions,
        questions: [{ id: 'item', header: 'Mode', prompt: 'Which mode?', options: [], allowsFreeform: true }],
      } };
      f.emit(prompt);
      assert.equal(owner.messages.at(-1).id, prompt.id);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), owner.messages.at(-1));
      const writes = f.upstream.length;
      const answer = { id: prompt.id, result: { answers: { item: { value: 'original answer' } } } };
      if (viewer) {
        assert.doesNotThrow(() => f.broker.receive(viewer, JSON.stringify(answer)));
        assert.equal(viewer.messages.at(-1).params.reason, 'not_original_client');
        assert.equal(f.upstream.length, writes);
      }
      // Approval metadata must not bypass the original task/turn fences either.
      assert.doesNotThrow(() => f.broker.receive(owner, JSON.stringify({
        ...answer, result: { ...answer.result, turnId: 'foreign-turn' },
      })));
      assert.equal(owner.messages.at(-1).params.reason, 'invalid_response');
      assert.equal(f.upstream.length, writes);
      assert.equal(f.broker.serverRequests.get(prompt.id), owner);
      assert.doesNotThrow(() => f.broker.receive(owner, JSON.stringify(answer)));
      assert.equal(f.upstream.length, writes + 1, 'one original answer reaches the app-server');
      assert.equal(f.upstream.at(-1).id, prompt.id);
      assert.deepEqual(f.upstream.at(-1).result.answers, answer.result.answers);
      const receipt = { method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
        questionId: 'original', appServerEpoch: 'epoch', requestId: prompt.id, reason: 'client_response' } };
      f.emit(receipt);
      assert.deepEqual(owner.messages.at(-1), receipt);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
      assert.equal(f.broker.serverRequests.has(prompt.id), false);
    });
  }
}
