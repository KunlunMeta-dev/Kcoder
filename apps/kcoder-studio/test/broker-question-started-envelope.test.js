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
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: {} } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: threadId } } }) };
  };
  return { broker, upstream, emit, resume };
}

const started = threadId => ({ method: 'turn/started', params: {
  serverId: 'server-current', threadId, turnId: 'turn',
  turn: { id: 'turn', threadId, status: 'running' },
} });

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const kind of ['question', 'approval']) {
    for (const id of [500, 'request-500']) {
      test(`${mode}: turn start request cannot replace a different task's ${kind} waiter (${id})`, t => {
        const f = fixture(t, shared), original = f.resume('original'), peer = f.resume('peer');
        original.finish(); peer.finish();
        const prompt = { id, method: `${kind}/request`, params: {
          threadId: 'original', turnId: 'turn', [`${kind}Id`]: kind,
          ...(kind === 'question' ? { questions: [] } : {}),
        } };
        f.emit(prompt);
        const before = peer.client.messages.length, writes = f.upstream.length;
        f.emit({ ...started('peer'), id });
        assert.equal(f.broker.serverRequests.get(id), original.client,
          'a notification request must not overwrite the original input owner');
        assert.equal(peer.client.messages.length, before, 'the peer receives no malformed turn start');
        assert.equal(f.upstream.length, writes, 'never respond to another interaction\'s transport ID');

        const result = kind === 'question' ? { answers: {} } : { decision: 'accept' };
        f.broker.receive(original.client, JSON.stringify({ id, result }));
        assert.equal(f.upstream.filter(message => message.id === id && message.result).length, 1,
          'the original input remains answerable exactly once');
        const receipt = { method: `${kind}/resolved`, params: {
          ...prompt.params, requestId: id, reason: 'client_response',
        } };
        f.emit(receipt);
        assert.deepEqual(original.client.messages.at(-1), receipt);
        const valid = started('original');
        f.emit(valid);
        assert.deepEqual(original.client.messages.at(-1), valid, 'valid turn notifications still arrive');
        assert.equal(peer.client.messages.length, before);
      });
    }
  }

  for (const id of [null, 500, 'request-500']) {
    test(`${mode}: turn start request cannot settle an unseen waiter during recovery (${id})`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume('original') : null;
      owner?.finish();
      const recovering = f.resume('original');
      const writes = f.upstream.length, ownerMessages = owner?.client.messages.length;
      f.emit({ ...started('original'), id });
      assert.equal(f.upstream.length, writes, 'an unowned update cannot reject a live Native waiter');
      assert.equal(f.broker.serverRequests.has(id), false);
      const valid = started('original');
      f.emit(valid); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread, 'the original task resumes');
      assert.deepEqual(recovering.client.messages.slice(1), [valid]);
      if (owner) assert.deepEqual(owner.client.messages.slice(ownerMessages), [valid]);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}
