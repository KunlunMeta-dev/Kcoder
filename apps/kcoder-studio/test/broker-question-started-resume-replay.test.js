import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerResumeNotificationBuffer, RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const started = { method: 'turn/started', params: { threadId: 'thread', turnId: 'turn', sequence: 0,
  turn: { id: 'turn', threadId: 'thread', attemptId: 'attempt', status: 'running' } } };

for (const mode of ['exclusive', 'shared', 'shared-first-owner']) {
  test(`${mode}: replayed starts cannot prevent original-question recovery and answering`, t => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
      maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
        toUpstream: message => ({ upstream: [message], client: [] }),
        fromUpstream: message => ({ upstream: [], client: [message] }) } });
    broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
    t.after(() => broker.clearTransientState());
    const upstream = []; let sequence = 0;
    child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
    const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    const send = (client, method, params) => {
      broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
      assert.equal(upstream.at(-1).method, method);
      return upstream.at(-1);
    };
    const reply = (request, result) => emit({ id: request.id, result });
    const resume = () => {
      const client = { channel: 'runtime', messages: [],
        send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
      broker.attach(client);
      Object.assign(client, { initialized: true, gatewaySharedThreadsV1: mode !== 'exclusive', asyncUserQuestionsV1: true });
      return { client, request: send(client, 'thread/resume', { threadId: 'thread' }) };
    };
    const owner = mode === 'shared' ? resume() : null;
    if (owner) reply(owner.request, { thread: { id: 'thread' } });
    const recovering = resume();
    const progress = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 2 },
      (_, index) => ({ method: 'item/delta', params: { threadId: 'thread', delta: { text: String(index) } } }));
    for (const message of progress) emit(message);
    for (let count = 0; count <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; count++) emit(started);
    emit({ ...started, jsonrpc: '2.0', params: { ...started.params, serverId: 'server-current' } });
    emit({ ...started, params: { ...started.params, serverId: 'server-previous' } });
    const question = { threadId: 'thread', questionId: 'question', requestId: 'request', revision: 1,
      sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1, status: 'pending',
      questions: [{ id: 'item', header: 'Choice', question: 'Continue?', options: [], multiSelect: false }] };
    const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread', question } };
    emit(changed);
    reply(recovering.request, { thread: { id: 'thread' } });
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'one start replay must not turn a successful resume into -32047');
    assert.deepEqual(recovering.client.messages.slice(1), [...progress, started, changed]);
    assert.equal(broker.threadOwners.get('thread'), owner?.client ?? recovering.client);
    reply(send(recovering.client, 'asyncQuestion/list', { threadId: 'thread' }), { threadId: 'thread', questions: [question] });
    const answer = send(recovering.client, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
      expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'Continue' } } });
    reply(answer, { threadId: 'thread', accepted: true, duplicate: false, question: { ...question,
      revision: 2, status: 'queued', answer: { submissionId: 'submission', acceptedAtMs: 2, answers: answer.params.answers } } });
    assert.equal(recovering.client.messages.at(-1).result?.accepted, true);
    assert.equal(upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}

test('sequenced start deduplication preserves attempts, content, order and real capacity limits', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const retry = { ...started, params: { ...started.params, turn: { ...started.params.turn, attemptId: 'retry' } } };
  const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
  const next = { ...started, params: { ...started.params, sequence: 1 } };
  for (const message of [started, progress, retry, next, structuredClone(started), structuredClone(retry)])
    assert.equal(buffer.capture(pending, message), true);
  assert.deepEqual(buffer.take(pending), { messages: [started, progress, retry, next], overflowed: false });
  assert.equal(buffer.capture(pending, structuredClone(started)), true, 'a new handoff retains its own first copy');
  buffer.discard(pending);
  for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++)
    assert.equal(buffer.capture(pending, { ...started, params: { ...started.params, sequence } }),
      sequence < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
  assert.equal(buffer.take(pending).overflowed, true, 'distinct starts still enforce the real frame limit');
});

for (const sequence of [undefined, null, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
  test(`start without a valid sequence (${sequence}) retains the recovery frame limit`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    for (let count = 0; count <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; count++)
      assert.equal(buffer.capture(pending, { ...started, params: { ...started.params, sequence } }),
        count < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
    assert.equal(buffer.take(pending).overflowed, true);
  });
}
