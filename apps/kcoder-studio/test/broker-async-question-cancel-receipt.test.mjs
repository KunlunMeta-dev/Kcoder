import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { compactRequestParams } from '../src/broker-request-budget.js';
import { projectAsyncQuestionResponse } from '../src/broker-async-questions.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
  let sequence = 0;
  const send = (method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (request, result) => emit({ id: request.id, result });
  reply(send('thread/resume'), { thread: { id: 'thread' } });
  return { broker, client, upstream, send, reply, emit };
}

for (const question of [
  { status: 'pending', revision: 1 },
  { status: 'queued', revision: 2 },
  ...['answer_saved', 'context_applied', 'delivery_failed', 'delivery_unknown', 'stale']
    .map(status => ({ status, revision: 4 })),
  { status: 'cancelled', revision: 2 },
]) {
  test(`cancellation cannot confirm ${question.status} revision ${question.revision}`, t => {
    const f = fixture(t);
    const expectedRevision = question.status === 'cancelled' ? 3 : Math.min(question.revision, 3);
    const request = f.send('asyncQuestion/cancel', { questionId: 'question', expectedRevision });
    const saved = { threadId: 'thread', questionId: 'question', ...question };
    f.reply(request, { threadId: 'thread', question: saved });
    assert.equal(f.client.messages.at(-1).error?.code, -32001,
      'a matching task/question ID does not prove cancellation of the displayed revision');
    f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), { threadId: 'thread', questions: [saved] });
    assert.deepEqual(f.client.messages.at(-1).result.questions, [saved], 'readback preserves the actual outcome');
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
    assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'turn/start', 'turn/interrupt'].includes(message.method)), false);
    assert.equal(f.broker.activeTurns.size, 0);
  });
}

for (const fields of [{ status: 'cancelled', revision: 3 }, { status: 'cancelled', revision: 4 }, {}]) {
  test(`committed, idempotent and legacy cancellation remain compatible: ${JSON.stringify(fields)}`, t => {
    const f = fixture(t);
    const request = f.send('asyncQuestion/cancel', { questionId: 'question', expectedRevision: 3 });
    const result = { threadId: 'thread', question: { threadId: 'thread', questionId: 'question', ...fields } };
    f.reply(request, result);
    assert.deepEqual(f.client.messages.at(-1).result, result);
  });
}

test('cancel revision survives timeout and repeated compaction without answer content', () => {
  const params = { threadId: 'thread', questionId: 'question', expectedRevision: 3 };
  const compact = compactRequestParams(compactRequestParams(params));
  assert.deepEqual(compact, params);
  const response = { id: 1, result: { threadId: 'thread', question: {
    threadId: 'thread', questionId: 'question', status: 'cancelled', revision: 2,
  } } };
  assert.equal(projectAsyncQuestionResponse(response, { method: 'asyncQuestion/cancel', params: compact }).error?.code, -32001);
});

test('a sparse cancellation receipt cannot report the initial revision', t => {
  const f = fixture(t);
  const cancel = f.send('asyncQuestion/cancel', { questionId: 'question', expectedRevision: 1 });
  f.reply(cancel, { threadId: 'thread', question: {
    threadId: 'thread', questionId: 'question', status: 'cancelled', revision: 1,
  } });
  assert.equal(f.client.messages.at(-1).error?.code, -32001);
  const read = f.send('asyncQuestion/list', { includeTerminal: true });
  const saved = { threadId: 'thread', questionId: 'question', status: 'cancelled', revision: 2 };
  f.reply(read, { threadId: 'thread', questions: [saved] });
  assert.deepEqual(f.client.messages.at(-1).result.questions, [saved]);
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
});

test('a full cancellation receipt must advance the displayed revision', t => {
  const f = fixture(t);
  const pending = { threadId: 'thread', questionId: 'question', requestId: 'request',
    sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1, revision: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }] };
  const cancel = f.send('asyncQuestion/cancel', { questionId: pending.questionId, expectedRevision: pending.revision });
  f.reply(cancel, { threadId: 'thread', question: { ...pending, status: 'cancelled' } });
  assert.equal(f.client.messages.at(-1).error?.code, -32001,
    'State cannot cancel a pending card without advancing its revision');
  const read = f.send('asyncQuestion/list', { includeTerminal: true });
  f.reply(read, { threadId: 'thread', questions: [pending] });
  assert.deepEqual(f.client.messages.at(-1).result.questions, [pending]);
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
});

const queued = { threadId: 'thread', questionId: 'question', requestId: 'request',
  sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1, revision: 2, status: 'queued',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
  answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'Saved answer' } } } };

for (const question of [queued, { ...queued, questions: undefined }]) {
  test(`an answered cancellation must advance past the save (${question.questions ? 'full' : 'sparse'})`, t => {
    const f = fixture(t);
    const cancel = f.send('asyncQuestion/cancel', { questionId: question.questionId, expectedRevision: question.revision });
    f.reply(cancel, { threadId: 'thread', question: { ...question, status: 'cancelled' } });
    assert.equal(f.client.messages.at(-1).error?.code, -32001,
      'the save and the withdrawal cannot occupy the same initial answer revision');

    const read = f.send('asyncQuestion/list', { includeTerminal: true });
    const cancelled = { ...queued, status: 'cancelled', revision: 3 };
    f.reply(read, { threadId: 'thread', questions: [cancelled] });
    assert.deepEqual(f.client.messages.at(-1).result.questions, [cancelled]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
  });
}

test('a full cancellation receipt cannot reuse the displayed revision of an answered card', t => {
  const f = fixture(t);
  const cancelled = { ...queued, status: 'cancelled', revision: 3 };
  // The obsolete receipt still satisfies the shape and minimum revision checks.
  const params = { questionId: queued.questionId, expectedRevision: cancelled.revision };
  const cancel = f.send('asyncQuestion/cancel', params);
  f.reply(cancel, { threadId: queued.threadId, question: cancelled });
  assert.equal(f.client.messages.at(-1).error?.code, -32001);

  const read = f.send('asyncQuestion/list', { includeTerminal: true });
  f.reply(read, { threadId: queued.threadId, questions: [cancelled] });
  assert.deepEqual(f.client.messages.at(-1).result.questions, [cancelled]);
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
  assert.equal(f.broker.activeTurns.size, 0);
});

test('a full cancellation receipt can advance the displayed queued revision', t => {
  const f = fixture(t);
  const cancel = f.send('asyncQuestion/cancel', { questionId: queued.questionId, expectedRevision: queued.revision });
  const result = { threadId: queued.threadId, question: { ...queued, status: 'cancelled', revision: 3 } };
  f.reply(cancel, result);
  assert.deepEqual(f.client.messages.at(-1).result, result);
});

test('a stale snapshot with a saved answer needs a separate transition revision', t => {
  const f = fixture(t);
  const notify = question => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread', question } });
  const stale = { ...queued, status: 'stale' };
  const before = f.client.messages.length;
  f.emit(notify(stale));
  assert.equal(f.client.messages.length, before, 'the invalid stale snapshot cannot settle a live question');
  f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), { threadId: 'thread', questions: [stale] });
  assert.equal(f.client.messages.at(-1).error?.code, -32001, 'the invalid stale snapshot cannot certify a read');

  const staleUpdate = notify({ ...stale, revision: 3 });
  f.emit(staleUpdate);
  assert.deepEqual(f.client.messages.at(-1), staleUpdate);
  assert.equal(f.upstream.filter(message => message.method.startsWith('asyncQuestion/')).length, 1);
});

for (const status of ['context_applied', 'delivery_failed', 'delivery_unknown']) {
  test(`a full ${status} snapshot cannot reuse the saved-answer revision`, t => {
    const f = fixture(t);
    const { threadId, questionId, revision, answer } = queued;
    const update = { ...queued, status,
      ...(status === 'context_applied' ? {} : { deliveryError: 'Delivery was not confirmed' }) };
    const notify = question => ({ method: 'asyncQuestion/changed', params: { threadId, question } });
    const before = f.client.messages.length;
    f.emit(notify(update));
    assert.equal(f.client.messages.length, before, 'the saved revision cannot certify a delivery transition');

    const readParams = { includeTerminal: true };
    f.reply(f.send('asyncQuestion/list', readParams), { threadId, questions: [update] });
    assert.equal(f.client.messages.at(-1).error?.code, -32001);

    const question = { ...update, revision: revision + 1 };
    f.emit(notify(question));
    assert.deepEqual(f.client.messages.at(-1), notify(question));
    f.reply(f.send('asyncQuestion/list', readParams), { threadId, questions: [question] });
    assert.deepEqual(f.client.messages.at(-1).result.questions, [question]);

    const request = f.send('asyncQuestion/answer', { questionId, expectedRevision: 1,
      submissionId: answer.submissionId, answers: answer.answers });
    f.reply(request, { threadId, question: update, accepted: true, duplicate: false,
      startedTurn: { id: 'unconfirmed-turn', status: 'running' } });
    assert.equal(f.client.messages.at(-1).error?.code, -32001);
    assert.equal(f.broker.activeTurns.size, 0);
  });
}
