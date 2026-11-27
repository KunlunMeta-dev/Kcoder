import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function changed(submissionId = 'submission', itemId = 'item', optionId = 'yes') {
  return { method: 'asyncQuestion/changed', params: { threadId: 'thread', question: {
    threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
    toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
    questions: [{ id: itemId, header: 'Mode', question: 'Continue?', multiSelect: false,
      options: [{ id: optionId, label: 'Yes', description: '' }] }],
    answer: { submissionId, acceptedAtMs: 2, answers: { [itemId]: { selectedOptionIds: [optionId] } } },
  } } };
}

const invalid = [
  ['submission bytes', changed('x'.repeat(257))],
  ['UTF-8 submission bytes', changed('问'.repeat(86))],
  ['item identity bytes', changed('submission', '问'.repeat(86))],
  ['option identity bytes', changed('submission', 'item', 'x'.repeat(257))],
  ['legacy blank item', changed('submission', ' \t')],
  ['legacy blank option', changed('submission', 'item', ' \t')],
];
// Older notifications can omit prompts; saved-answer identities still have
// State's limits even when prompt membership cannot be checked locally.
for (const [name, message] of invalid) if (name.startsWith('legacy')) delete message.params.question.questions;

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
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const owner = shared ? join() : null;
  owner?.finish();
  return { broker, upstream, emit, owner, recovering: join() };
}

for (const shared of [false, true]) for (const [name, message] of invalid) {
  test(`${shared ? 'shared' : 'exclusive'}: ${name} cannot block original-task recovery`, t => {
    const f = fixture(t, shared);
    for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
      f.emit({ ...message, params: { ...message.params, question: { ...message.params.question, revision } } });
    const valid = changed();
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(progress); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread,
      'State-invalid answer identities must not turn successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
    assert.ok(f.upstream.every(request => request.method === 'thread/resume'), 'recovery never replays input');
  });
}

for (const detached of [false, true]) for (const [name, message] of invalid) {
  test(`${name} cannot certify answer ownership (detached=${detached})`, t => {
    const f = fixture(t, true);
    f.recovering.finish();
    const answerer = f.recovering.client;
    const answer = message.params.question.answer;
    f.broker.receive(answerer, JSON.stringify({ id: 2, method: 'asyncQuestion/answer', params: {
      threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: answer.submissionId, answers: answer.answers,
    } }));
    const request = f.upstream.find(request => request.method === 'asyncQuestion/answer');
    assert.ok(request);
    if (detached) { f.broker.expireRequest(request.id); f.broker.detach(answerer); }
    const deliveries = answerer.messages.length;
    f.emit({ id: request.id, result: { threadId: 'thread', question: message.params.question,
      accepted: true, duplicate: false, startedTurn: { id: 'unconfirmed', status: 'running' } } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(request => request.method === 'turn/interrupt'), false);
    if (detached) assert.equal(answerer.messages.length, deliveries);
    else assert.equal(answerer.messages.at(-1).error?.code, -32001);
    // A later original-task read remains available without resubmitting an answer.
    f.broker.receive(f.owner.client, JSON.stringify({ id: 3, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    f.emit({ id: read.id, result: { threadId: 'thread', questions: [changed().params.question] } });
    assert.deepEqual(f.owner.client.messages.at(-1).result.questions, [changed().params.question]);
    assert.equal(f.upstream.filter(request => request.method === 'asyncQuestion/answer').length, 1);
  });
}

test('Office invalid saved identities leave capacity for the original question', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const [name, message] of invalid) assert.equal(handoff.capture(message, [pending]), false, name);
  const valid = changed();
  const prompt = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn', questionId: 'ordinary' } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(prompt, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, prompt]);
  assert.deepEqual(refused, []);
});

test('exact 256-byte identities, Unicode and omitted legacy prompts preserve answer bytes', () => {
  const identifier = '问'.repeat(85) + 'a';
  assert.equal(Buffer.byteLength(identifier), 256);
  for (const legacy of [false, true]) {
    const message = changed(identifier, identifier, identifier);
    message.params.question.answer.answers[identifier].text = ' exact answer ';
    if (legacy) delete message.params.question.questions;
    const before = structuredClone(message);
    assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true);
    assert.deepEqual(message, before, 'validation cannot truncate or normalize saved identities/answers');
  }
});
