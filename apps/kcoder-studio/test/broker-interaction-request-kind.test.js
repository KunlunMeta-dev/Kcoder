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
    assert.equal(request.method, 'thread/resume');
    emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, join };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    test(`${kind}: a mixed-kind prompt cannot reserve the original input (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : null;
      const field = kind === 'question' ? 'questionId' : 'approvalId';
      const otherField = kind === 'question' ? 'approvalId' : 'questionId';
      const prompt = { id: 500, method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'turn', [field]: 'original', appServerEpoch: 'epoch',
        ...(kind === 'question' ? { questions: [{ id: 'item', header: 'Choice', prompt: 'Continue?',
          options: [], allowsFreeform: true, multiSelect: false }] }
          : { action: { type: 'command', command: 'echo fixture' }, reason: 'Controlled approval' }),
      } };
      const counts = [owner.messages.length, viewer?.messages.length], writes = f.upstream.length;
      for (const identity of ['foreign-input', '', 7, false, {}]) {
        f.emit({ ...prompt, params: { ...prompt.params, [otherField]: identity } });
        assert.deepEqual([owner.messages.length, viewer?.messages.length], counts,
          'ambiguous input cannot open a card before the real prompt');
        assert.equal(f.broker.serverRequests.has(prompt.id), false, 'ambiguous input cannot reserve the waiter');
        assert.equal(f.upstream.length, writes, 'do not reject an ID that may belong to a real waiter');
      }
      // Omission and explicit null retain their existing compatibility behavior.
      for (const [index, extra] of [{}, { [otherField]: null }].entries()) {
        const original = { ...prompt, id: prompt.id + index, params: { ...prompt.params, ...extra } };
        f.emit(original);
        assert.deepEqual(owner.messages.at(-1), original);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), original);
        f.broker.receive(owner, JSON.stringify({ id: original.id,
          result: kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' } }));
        assert.equal(f.upstream.at(-1).id, original.id);
        const receipt = { method: `${kind}/resolved`, params: { ...original.params,
          requestId: original.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
        f.emit(receipt);
        assert.deepEqual(owner.messages.at(-1), receipt);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
        const settled = owner.messages.length;
        f.emit(original); f.emit(receipt);
        assert.equal(owner.messages.length, settled, 'the first terminal receipt keeps input closed');
      }
      assert.equal(f.upstream.length, writes + 2, 'only the two original replies reach the app-server');
    });
  }
}
