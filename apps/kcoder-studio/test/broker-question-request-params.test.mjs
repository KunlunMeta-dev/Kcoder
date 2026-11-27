import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = (...messages) => child.stdout.write(`${messages.map(JSON.stringify).join('\n')}\n`);
  const join = id => {
    const client = { channel: 'runtime', messages: [], closed: false,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closed = true; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(1), viewer = shared ? join(2) : null;
  broker.activeTurns.set('thread', { owner, turnId: 'turn' });
  return { broker, upstream, emit, owner, viewer };
}

for (const shared of [false, true]) for (const method of ['question/request', 'approval/request']) {
  for (const params of [undefined, null, [], 'invalid', 0, false]) {
    test(`${method}: invalid params ${JSON.stringify(params)} cannot reserve the original waiter (shared=${shared})`, t => {
      const f = fixture(t, shared);
      const before = [f.upstream.length, f.owner.messages.length, f.viewer?.messages.length];
      // Legacy top-level routing used to deliver missing/null params and reserve
      // an unbound waiter, suppressing the subsequent original request.
      f.emit({ id: 500, method, threadId: 'thread', turnId: 'turn',
        ...(params === undefined ? {} : { params }) });
      assert.equal(f.broker.serverRequests.has(500), false, 'invalid params cannot own a waiter');
      assert.deepEqual([f.upstream.length, f.owner.messages.length, f.viewer?.messages.length], before,
        'do not publish an unbound card or answer an unconfirmed transport ID');

      const field = method === 'question/request' ? 'questionId' : 'approvalId';
      const request = { id: 500, method, params: { threadId: 'thread', turnId: 'turn',
        [field]: 'original', appServerEpoch: 'epoch',
        ...(method === 'question/request' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
          : { availableDecisions: ['accept'] }) } };
      f.emit(request);
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      assert.deepEqual(f.owner.messages.at(-1), request);
      if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), request);
      f.broker.receive(f.owner, JSON.stringify({ id: 500, result: { threadId: 'thread', turnId: 'turn',
        [field]: 'original', ...(method === 'question/request' ? { answers: { item: { answers: ['yes'] } } }
          : { decision: 'accept' }) } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      f.emit({ method: method.replace('/request', '/resolved'), params: { threadId: 'thread', turnId: 'turn',
        [field]: 'original', appServerEpoch: 'epoch', requestId: 500, reason: 'client_response' } });
      assert.equal(f.broker.serverRequests.has(500), false);
      assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
      assert.equal(f.owner.closed || f.viewer?.closed || false, false);
    });
  }
}
