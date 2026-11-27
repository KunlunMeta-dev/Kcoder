import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
  broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  const resume = upstream.find(message => message.method === 'thread/resume');
  assert.ok(resume);
  return { broker, client, upstream, emit,
    finish: () => emit({ id: resume.id, result: { thread: { id: 'thread' } } }) };
}


for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const field of ['requestId', `${kind}Id`, 'appServerEpoch']) {
      test(`${kind}: Rust-blank ${field} cannot consume task recovery (shared=${shared})`, t => {
        const f = fixture(t, shared);
        for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++) {
          f.emit({ method: `${kind}/resolved`, params: { threadId: 'thread', turnId: 'turn',
            [`${kind}Id`]: 'card', requestId: sequence + 10, appServerEpoch: 'epoch',
            reason: 'answered', [field]: ' \u0085\t' } });
        }
        f.finish();
        assert.ok(f.client.messages[0]?.result?.thread,
          'unusable terminal identities must not make thread/resume fail with -32047');
        assert.equal(f.client.messages.some(message => message.method === `${kind}/resolved`), false);
        const original = { id: 1000, method: `${kind}/request`, params: {
          threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'card', appServerEpoch: 'epoch',
          ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } : {}) } };
        f.emit(original);
        assert.equal(f.broker.serverRequests.get(original.id), f.client);
        const answer = kind === 'question' ? { answers: {} } : { decision: 'accept' };
        f.broker.receive(f.client, JSON.stringify({ id: original.id, result: answer }));
        assert.equal(f.upstream.filter(message => message.id === original.id && message.result).length, 1);
        f.emit({ method: `${kind}/resolved`, params: { ...original.params, requestId: original.id, reason: 'answered' } });
        assert.equal(f.broker.serverRequests.has(original.id), false);
      });
    }
  }
}

for (const kind of ['question', 'approval']) {
  for (const field of ['id', `${kind}Id`, 'appServerEpoch']) {
    test(`${kind}: Rust-blank request ${field} cannot occupy the original waiter`, t => {
      const f = fixture(t); f.finish();
      const original = { id: 1000, method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'card', appServerEpoch: 'epoch',
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } : {}) } };
      const invalid = field === 'id' ? { ...original, id: ' \u0085\t' }
        : { ...original, params: { ...original.params, [field]: ' \u0085\t' } };
      const writes = f.upstream.length, deliveries = f.client.messages.length;
      f.emit(invalid);
      assert.equal(f.broker.serverRequests.size, 0);
      assert.equal(f.client.messages.length, deliveries);
      assert.equal(f.upstream.length, writes);
      f.emit(original);
      assert.equal(f.broker.serverRequests.get(original.id), f.client);
    });
  }
}

for (const kind of ['question', 'approval']) {
  test(`${kind}: client-blank FEFF identities remain rejected without replacing input`, t => {
    const f = fixture(t); f.finish();
    f.emit({ id: '\uFEFF', method: `${kind}/request`, params: {
      threadId: 'thread', turnId: 'turn', [`${kind}Id`]: '\uFEFF', appServerEpoch: '\uFEFF' } });
    assert.equal(f.broker.serverRequests.size, 0);
    assert.equal(f.client.messages.some(message => message.method === `${kind}/request`), false);
  });
}
