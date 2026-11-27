import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const changed = (deliveryError, revision = 3) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    ...(deliveryError === undefined ? {} : { deliveryError }) },
} });
const invalid = [
  ['number', 1], ['object', {}], ['array', []], ['boolean', false],
  ['ASCII overflow', 'a'.repeat(2047)],
  ['UTF-8 overflow', '问'.repeat(683)],
  ['escaped overflow', '\u0001'.repeat(342)],
];

function fixture(t, shared) {
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
  const owner = shared ? resume() : null;
  owner?.finish();
  return { broker, upstream, emit, owner, recovering: resume() };
}

for (const shared of [false, true]) {
  for (const [name, value] of invalid) test(`${shared ? 'shared' : 'exclusive'}: ${name} delivery error cannot block recovery`, t => {
    const f = fixture(t, shared);
    // Different revisions prevent replay deduplication from hiding the defect.
    for (let revision = 3; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 3; revision++)
      f.emit(changed(value, revision));
    const valid = changed('original failure', 100);
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(progress); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread,
      'invalid error metadata must not turn successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery is read-only');
  });
}

test('Office rejects invalid error metadata without displacing the original interaction', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const [name, value] of invalid) assert.equal(handoff.capture(changed(value), [pending]), false, name);
  const valid = changed('original failure');
  const request = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'ordinary-question', questions: [] } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(request, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, request]);
  assert.deepEqual(refused, []);
});

test('serialized error boundaries and nullable legacy metadata remain unchanged', () => {
  for (const value of [undefined, null, '', 'a'.repeat(2046), '问'.repeat(682), '\u0001'.repeat(341)]) {
    assert.equal(hasValidAsyncQuestionNotificationBinding(changed(value).params), true);
  }
  for (const value of ['a'.repeat(2046), '问'.repeat(682), '\u0001'.repeat(341)])
    assert.equal(Buffer.byteLength(JSON.stringify(value)), 2048);
});

for (const lifecycle of ['connected', 'expired-disconnected']) for (const deliveryError of [{}, 'stale failure']) {
  test(`an unusable saved delivery error (${typeof deliveryError}) cannot certify an answer turn (${lifecycle})`, t => {
    const f = fixture(t, true);
    f.recovering.finish();
    const answerer = f.recovering.client;
    const answers = { item: { text: 'original answer' } };
    f.broker.receive(answerer, JSON.stringify({ id: 2, method: 'asyncQuestion/answer', params: {
      threadId: 'thread', questionId: 'question', expectedRevision: 1, submissionId: 'submission', answers,
    } }));
    const request = f.upstream.find(message => message.method === 'asyncQuestion/answer');
    assert.ok(request);
    if (lifecycle === 'expired-disconnected') {
      f.broker.expireRequest(request.id);
      f.broker.detach(answerer);
    }
    const deliveries = answerer.messages.length;
    f.emit({ id: request.id, result: { threadId: 'thread', accepted: true, duplicate: false,
      question: { threadId: 'thread', questionId: 'question', revision: 2, status: 'queued',
        deliveryError, answer: { submissionId: 'submission', acceptedAtMs: 2, answers } },
      startedTurn: { id: 'unconfirmed-turn', status: 'running' } } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
    else assert.equal(answerer.messages.length, deliveries);
    f.broker.receive(f.owner.client, JSON.stringify({ id: 3, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    f.emit({ id: read.id, result: { threadId: 'thread', questions: [] } });
    assert.deepEqual(f.owner.client.messages.at(-1).result.questions, []);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

const statusesWithoutError = ['pending', 'answer_saved', 'queued', 'context_applied', 'cancelled', 'stale'];
function withStatus(status, deliveryError, revision = 1) {
  const message = changed(deliveryError, revision);
  Object.assign(message.params.question, { status,
    ...(['pending', 'cancelled', 'stale'].includes(status) ? {} : {
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'original answer' } } },
    }),
  });
  return message;
}

for (const shared of [false, true]) for (const status of statusesWithoutError) {
  test(`${shared ? 'shared' : 'exclusive'}: stale ${status} delivery errors cannot exhaust original-task recovery`, t => {
    const f = fixture(t, shared);
    const revision = RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1;
    const fixedRevision = status === 'pending' ? 1 : status === 'queued' ? 2 : null;
    for (let i = 1; i <= revision; i++) {
      const invalid = withStatus(status, 'stale failure', fixedRevision ?? i + 2);
      if (fixedRevision !== null && i < revision) invalid.params.question.questionId = `${status}-${i}`;
      f.emit(invalid);
    }
    // Same revision: rejecting stale metadata must leave the corrected receipt usable.
    const valid = withStatus(status, null, fixedRevision ?? revision + 2);
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(progress); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread,
      'contradictory delivery state must not turn successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never resubmits answers');
  });
}

test('Office handoff rejects stale delivery state before reserving recovery capacity', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const status of statusesWithoutError)
    assert.equal(handoff.capture(withStatus(status, 'stale failure', status === 'pending' ? 1 : status === 'queued' ? 2 : 3), [pending]), false, status);
  const valid = withStatus('delivery_failed', 'original failure', 3);
  assert.equal(handoff.capture(valid, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid]);
  assert.deepEqual(refused, []);
});

test('failed/unknown delivery errors and omitted legacy status remain readable', () => {
  for (const status of ['delivery_failed', 'delivery_unknown', undefined])
    for (const error of ['original failure', '', null, undefined])
      assert.equal(hasValidAsyncQuestionNotificationBinding(withStatus(status, error, 3).params), true);
});

function fullDeliveryUpdate(status, error, questionId = 'question') {
  const message = withStatus(status, error, 3);
  Object.assign(message.params.question, {
    questionId, requestId: `request-${questionId}`, sourceTurnId: 'source',
    toolCallId: `tool-${questionId}`, createdAtMs: 1,
    questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
  });
  return message;
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: incomplete delivery snapshots cannot exhaust resume capacity`, t => {
    const f = fixture(t, shared);
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) {
      f.emit(fullDeliveryUpdate(index % 2 ? 'delivery_failed' : 'delivery_unknown',
        index % 2 ? null : undefined, `question-${index}`));
    }
    const updates = [
      fullDeliveryUpdate('delivery_failed', 'original failure'),
      fullDeliveryUpdate('delivery_unknown', '', 'other-question'),
      withStatus('delivery_unknown', undefined, 3),
    ];
    for (const update of updates) f.emit(update);
    f.recovering.finish();
    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, 'thread',
      'malformed full snapshots must not turn a successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), updates);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), updates);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

test('a delivery snapshot without its error cannot confirm an original-task read', t => {
  const f = fixture(t, false);
  f.recovering.finish();
  const client = f.recovering.client;
  const read = (id, question) => {
    f.broker.receive(client, JSON.stringify({ id, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
    const request = f.upstream.at(-1);
    assert.equal(request.method, 'asyncQuestion/list');
    f.emit({ id: request.id, result: { threadId: 'thread', questions: [question] } });
    return client.messages.at(-1);
  };
  const invalid = fullDeliveryUpdate('delivery_unknown', null).params.question;
  assert.equal(read(2, invalid).error?.code, -32001);
  const valid = { ...invalid, deliveryError: 'original delivery not confirmed' };
  assert.deepEqual(read(3, valid).result?.questions, [valid]);
});
