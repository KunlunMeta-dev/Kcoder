import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerResumeNotificationBuffer, RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

for (const shared of [false, true]) {
  for (const status of ['completed', 'failed', 'interrupted']) {
    test(`replayed ${status} preserves question recovery (shared=${shared})`, t => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
        maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
          toUpstream: message => ({ upstream: [message], client: [] }),
          fromUpstream: message => ({ upstream: [], client: [message] }) } });
      broker.initializeResponse = { result: { sessionId: 'current', capabilities: {
        experimental: { asyncUserQuestionsV1: true },
      } } };
      t.after(() => broker.clearTransientState());
      const upstream = [];
      child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
      const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
      const resume = () => {
        const client = { channel: 'runtime', messages: [],
          send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
        broker.attach(client);
        Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
        broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
        const request = upstream.at(-1);
        assert.equal(request.method, 'thread/resume');
        return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
      };
      if (shared) resume().finish();
      const recovering = resume();
      const terminal = { method: `turn/${status}`, params: { serverId: 'server-current',
        threadId: 'thread', turnId: 'source', sequence: 42,
        turn: { id: 'source', threadId: 'thread', attemptId: 'original-attempt', status } } };
      const started = { method: 'turn/started', params: { ...terminal.params, sequence: 41,
        turn: { ...terminal.params.turn, status: 'running' } } };
      emit(started);
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) emit(terminal);
      emit({ ...started, params: { ...started.params, sequence: 43 } });
      const question = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
        question: { threadId: 'thread', questionId: 'question', revision: 2 } } };
      emit(question);
      recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread,
        'one terminal event replayed many times cannot exhaust the recovery budget');
      assert.deepEqual(recovering.client.messages.slice(1), [started, terminal, question],
        'retain the original start and terminal order without replaying the late start');
      assert.equal(broker.sharedThreads.has('thread', recovering.client), shared);
      assert.equal(broker.activeTurns.size, 0);
      assert.equal(broker.threadDrains.size, 0);
      assert.ok(upstream.every(message => message.method === 'thread/resume'),
        'recovery does not answer, cancel, interrupt or replay input');
    });
  }
}

for (const sequence of [undefined, null, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
  test(`unsequenced or invalid terminal sequence ${sequence} retains the frame cap`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', sequence } };
    for (let index = 0; index < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
      assert.equal(buffer.capture(pending, structuredClone(terminal)), true);
    assert.equal(buffer.capture(pending, structuredClone(terminal)), false);
    assert.equal(buffer.take(pending).overflowed, true);
  });
}

test('separate sequenced terminal events still exhaust real recovery capacity', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++) {
    const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', sequence } };
    assert.equal(buffer.capture(pending, terminal), sequence < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
  }
  assert.equal(buffer.take(pending).overflowed, true);
});

test('retry attempts retain their ordered terminal receipts', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const first = { method: 'turn/failed', params: { threadId: 'thread', turnId: 'turn', sequence: 10,
    turn: { id: 'turn', attemptId: 'first', status: 'failed' } } };
  const started = { method: 'turn/started', params: { threadId: 'thread', turnId: 'turn', sequence: 11,
    turn: { id: 'turn', attemptId: 'retry', status: 'running' } } };
  const retried = { ...first, params: { ...first.params,
    turn: { ...first.params.turn, attemptId: 'retry' } } };
  for (const message of [first, started, retried, structuredClone(first), structuredClone(retried)])
    assert.equal(buffer.capture(pending, message), true);
  assert.deepEqual(buffer.take(pending), { messages: [first, started, retried], overflowed: false });
  assert.equal(buffer.capture(pending, structuredClone(first)), true, 'taking a handoff releases replay identities');
  assert.deepEqual(buffer.take(pending), { messages: [first], overflowed: false });
});
