import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
  broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  const resume = upstream.find(message => message.method === 'thread/resume');
  assert.ok(resume);
  return { broker, client, upstream, emit,
    finish: () => emit({ id: resume.id, result: { thread: { id: 'thread' } } }) };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    const binding = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original', appServerEpoch: 'epoch' };
    const terminal = { method: `${kind}/resolved`, params: { ...binding, requestId: 500,
      reason: '已完成 😀', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };

    test(`${kind}: invalid Unicode reason cannot settle original input (shared=${shared})`, t => {
      const f = fixture(t, shared); f.finish();
      f.emit({ id: 500, method: `${kind}/request`, params: { ...binding,
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Which?' }] } : {}) } });
      const deliveries = f.client.messages.length, writes = f.upstream.length;
      for (const reason of ['\ud800', '\udfff']) f.emit({ ...terminal, params: { ...terminal.params, reason } });
      assert.equal(f.broker.serverRequests.get(500), f.client, 'unrepresentable outcomes cannot retire input');
      assert.equal(f.client.messages.length, deliveries, 'malformed outcomes cannot close a card');
      f.broker.receive(f.client, JSON.stringify({ id: 500, result: kind === 'question'
        ? { answers: { item: { answers: ['original answer'] } } } : { decision: 'accept' } }));
      assert.equal(f.upstream.length, writes + 1, 'the original waiter remains answerable exactly once');
      f.emit(terminal);
      assert.deepEqual(f.client.messages.at(-1), terminal, 'the real receipt remains deliverable without text replacement');
      assert.equal(f.broker.serverRequests.has(500), false);
    });

    test(`${kind}: invalid Unicode reasons cannot exhaust recovery (shared=${shared})`, t => {
      const f = fixture(t, shared);
      for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++)
        f.emit({ ...terminal, params: { ...terminal.params, requestId: sequence + 1000, reason: '\ud800' } });
      f.emit(terminal); f.finish();
      assert.ok(f.client.messages[0]?.result?.thread, 'malformed outcomes cannot cause -32047 on resume');
      assert.deepEqual(f.client.messages.slice(1), [terminal], 'the valid original receipt survives refresh');
      assert.ok(f.upstream.every(message => ['thread/resume', 'thread/attach'].includes(message.method)),
        'read-only recovery never replays an answer or interrupts a turn');
    });
  }
}
