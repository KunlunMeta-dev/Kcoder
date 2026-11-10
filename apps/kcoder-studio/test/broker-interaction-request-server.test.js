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
  broker.initializeResponse = { result: { sessionId: 'current' } };
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
    const mode = shared ? 'shared' : 'exclusive';
    const field = kind === 'question' ? 'questionId' : 'approvalId';
    const request = { id: 500, method: `${kind}/request`, params: {
      serverId: 'server-current', threadId: 'thread', turnId: 'turn',
      appServerEpoch: 'epoch', [field]: 'original',
    } };

    test(`${kind}: a foreign producer cannot reserve ${mode} input before its original prompt`, t => {
      const f = fixture(t, shared), owner = f.join();
      const viewer = shared ? f.join() : null;
      const counts = [owner.messages.length, viewer?.messages.length];
      const writes = f.upstream.length;
      for (const serverId of ['server-previous', 'gateway-target', null])
        f.emit({ ...request, params: { ...request.params, serverId, [field]: 'foreign' } });
      assert.deepEqual([owner.messages.length, viewer?.messages.length], counts,
        'stale prompts cannot become visible cards');
      assert.equal(f.broker.serverRequests.has(request.id), false, 'a foreign producer cannot reserve the request ID');
      assert.equal(f.upstream.length, writes,
        'rejecting a foreign prompt must not settle a current waiter with the same transport ID');

      f.emit(request);
      assert.deepEqual(owner.messages.at(-1), request, 'the real prompt is still admitted');
      if (viewer) assert.deepEqual(viewer.messages.at(-1), request);
      f.broker.receive(owner, JSON.stringify({ id: request.id,
        result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
      assert.equal(f.upstream.length, writes + 1, 'the original prompt remains answerable exactly once');
      const receipt = { method: `${kind}/resolved`, params: { ...request.params,
        requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
      f.emit(receipt);
      assert.deepEqual(owner.messages.at(-1), receipt);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
    });

    for (const legacy of [false, true]) {
      test(`${kind}: ${mode} original producer still delivers and replays input (legacy=${legacy})`, t => {
        const f = fixture(t, shared), owner = f.join();
        const prompt = structuredClone(request);
        if (legacy) delete prompt.params.serverId;
        f.emit(prompt);
        assert.deepEqual(owner.messages.at(-1), prompt);
        assert.equal(f.broker.serverRequests.get(request.id), owner);
        const counts = owner.messages.length, writes = f.upstream.length;
        f.emit({ ...request, params: { ...request.params, serverId: 'server-previous' } });
        assert.equal(owner.messages.length, counts, 'a stale collision cannot redeliver or replace the card');
        assert.equal(f.upstream.length, writes);
        if (shared) {
          const viewer = f.join();
          assert.deepEqual(viewer.messages.at(-1), prompt, 'late viewers receive only the original producer');
        }
      });
    }
  }
}
