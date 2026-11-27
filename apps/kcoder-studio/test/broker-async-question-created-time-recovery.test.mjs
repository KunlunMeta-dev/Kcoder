import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isContract } from '../shared/generated/validator.mjs';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const changed = (createdAtMs, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    createdAtMs, requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Continue?', options: [], multiSelect: false }] },
} });
const invalid = [
  ['null', null], ['negative', -1], ['fraction', 1.5], ['string', '1'],
  ['object', {}], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
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
  for (const [name, value] of invalid) test(`${shared ? 'shared' : 'exclusive'}: ${name} creation timestamp cannot block recovery`, t => {
    const f = fixture(t, shared);
    assert.equal(isContract('AsyncQuestionRecord', changed(value).params.question), false);
    // Distinct questions prevent replay deduplication from hiding the defect.
    for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++) {
      const frame = changed(value);
      frame.params.question.questionId = `invalid-${i}`;
      f.emit(frame);
    }
    const valid = changed(1);
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(progress); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread,
      'invalid creation timestamp must not turn successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery is read-only');
  });
}

test('Office rejects invalid creation timestamp without displacing the original interaction', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const [name, value] of invalid) assert.equal(handoff.capture(changed(value), [pending]), false, name);
  const valid = changed(1);
  const request = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'ordinary-question', questions: [] } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(request, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, request]);
  assert.deepEqual(refused, []);
});

test('creation timestamps follow the generated unsigned integer contract and preserve legacy omission', () => {
  for (const value of [undefined, 0, 1, Number.MAX_SAFE_INTEGER]) {
    const params = changed(value).params;
    // Legacy refresh hints omit the full prompt snapshot, as clients require.
    if (value === undefined) delete params.question.questions;
    assert.equal(hasValidAsyncQuestionNotificationBinding(params), true);
    if (value !== undefined) assert.equal(isContract('AsyncQuestionRecord', params.question), true);
  }
});

for (const lifecycle of ['connected', 'expired-disconnected']) {
  test(`an unusable saved creation timestamp cannot certify an answer turn (${lifecycle})`, t => {
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
        createdAtMs: -1, answer: { submissionId: 'submission', acceptedAtMs: 2, answers } },
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
    const saved = { ...changed(1, 2).params.question, status: 'queued',
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers } };
    f.emit({ id: read.id, result: { threadId: 'thread', questions: [saved] } });
    assert.deepEqual(f.owner.client.messages.at(-1).result.questions, [saved]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}
