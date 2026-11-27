import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding, projectAsyncQuestionResponse } from '../src/broker-async-questions.js';

const item = { id: 'item', header: 'Mode', question: 'Continue?', multiSelect: false,
  options: [{ id: 'yes', label: 'Yes', description: '' }] };
const changed = (questions = [item], answer) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision: answer ? 2 : 1,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status: answer ? 'queued' : 'pending', questions, ...(answer ? { answer } : {}) },
} });
const savedAnswer = text => ({ submissionId: 'submission', acceptedAtMs: 2,
  answers: { item: { selectedOptionIds: [], text } } });
const invalid = [
  ['prompt bytes', changed([{ ...item, question: '问'.repeat(5462) }])],
  ['header bytes', changed([{ ...item, header: '问'.repeat(86) }])],
  ['label bytes', changed([{ ...item, options: [{ ...item.options[0], label: '问'.repeat(86) }] }])],
  ['description bytes', changed([{ ...item, options: [{ ...item.options[0], description: '问'.repeat(683) }] }])],
  ['aggregate request', changed(Array.from({ length: 8 }, (_, i) => ({ ...item, id: `item-${i}`,
    question: 'x'.repeat(8192) })))],
  ['escaped request', changed([{ ...item, question: '\u0001'.repeat(12000) }])],
  ['answer bytes', changed([item], savedAnswer('x'.repeat(16 * 1024)))],
  ['escaped answer', changed([item], savedAnswer('\u0001'.repeat(3000)))],
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
  for (const [name, message] of invalid) {
    test(`${shared ? 'shared' : 'exclusive'}: oversized ${name} cannot exhaust original-task recovery`, t => {
      const f = fixture(t, shared);
      // These are structurally valid snapshots, but State cannot save them.
      // Distinct questions defeat replay deduplication and fill the byte budget.
      for (let i = 0; i < 65; i++) {
        const frame = structuredClone(message);
        frame.params.question.questionId = `invalid-${i}`;
        f.emit(frame);
      }
      const valid = changed();
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'unsavable content must not turn a successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
      assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(request => request.method === 'thread/resume'),
        'read recovery cannot replay an answer or input');
    });
  }
}

test('Office rejects oversized content before it consumes original-interaction capacity', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const [name, message] of invalid) assert.equal(handoff.capture(message, [pending]), false, name);
  const valid = changed();
  const request = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'ordinary-question', questions: [] } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(request, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, request]);
  assert.deepEqual(refused, []);
});

for (const lifecycle of ['connected', 'expired-disconnected']) {
  test(`oversized saved answers preserve the original task controller (${lifecycle})`, t => {
    const f = fixture(t, true);
    f.recovering.finish();
    const answerer = f.recovering.client;
    const answer = savedAnswer('x'.repeat(16 * 1024));
    f.broker.receive(answerer, JSON.stringify({ id: 2, method: 'asyncQuestion/answer', params: {
      threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: answer.submissionId, answers: answer.answers,
    } }));
    const request = f.upstream.find(message => message.method === 'asyncQuestion/answer');
    assert.ok(request);
    if (lifecycle === 'expired-disconnected') {
      f.broker.expireRequest(request.id);
      f.broker.detach(answerer);
    }
    const deliveries = answerer.messages.length;
    f.emit({ id: request.id, result: { threadId: 'thread', accepted: true, duplicate: false,
      question: changed([item], answer).params.question,
      startedTurn: { id: 'answer-turn', status: 'running' } } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
    else assert.equal(answerer.messages.length, deliveries);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const [name, message] of invalid) {
  test(`oversized ${name} in an accepted receipt cannot certify execution or ownership`, () => {
    const answer = message.params.question.answer ?? { submissionId: 'submission', acceptedAtMs: 2,
      answers: Object.fromEntries(message.params.question.questions.map(item => [item.id, { text: 'yes' }])) };
    const question = { ...message.params.question, status: 'queued', revision: 2, answer };
    const response = { id: 1, result: { threadId: 'thread', question, accepted: true, duplicate: false,
      startedTurn: { id: 'answer-turn', status: 'running' } } };
    const pending = { method: 'asyncQuestion/answer', params: { threadId: 'thread', questionId: 'question',
      submissionId: 'submission', expectedRevision: 1, answers: question.answer.answers } };
    assert.equal(projectAsyncQuestionResponse(response, pending).error?.code, -32001, name);
  });
}

test('exact UTF-8 field and serialized-answer boundaries remain readable without truncation', () => {
  const boundary = { ...item, header: '问'.repeat(85) + 'a', question: '问'.repeat(5461) + 'a',
    options: [{ id: 'yes', label: '问'.repeat(85) + 'a', description: '问'.repeat(682) + 'ab' }] };
  const answer = savedAnswer('');
  const overhead = Buffer.byteLength(JSON.stringify(answer.answers));
  answer.answers.item.text = 'x'.repeat(16 * 1024 - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(answer.answers)), 16 * 1024);
  assert.equal(hasValidAsyncQuestionNotificationBinding(changed([boundary], answer).params), true);
  delete answer.answers.item.selectedOptionIds;
  assert.equal(hasValidAsyncQuestionNotificationBinding(changed([boundary], answer).params), true,
    'omitted Rust defaults keep the same serialized budget');
  answer.answers.item.text += 'x';
  assert.equal(hasValidAsyncQuestionNotificationBinding(changed([boundary], answer).params), false);
  const legacy = changed().params; delete legacy.question.questions;
  assert.equal(hasValidAsyncQuestionNotificationBinding(legacy), true);
});

test('the exact serialized request boundary excludes generated IDs with valid headers', () => {
  const questions = Array.from({ length: 4 }, (_, i) => ({ ...item, id: `item-${i}`, header: 'Mode',
    question: 'x'.repeat(16 * 1024), options: [] }));
  const message = changed(questions);
  const draft = () => ({ sourceTurnId: 'turn', toolCallId: 'tool',
    questions: questions.map(({ id, ...value }) => value) });
  const excess = Buffer.byteLength(JSON.stringify(draft())) - 64 * 1024;
  questions[3].question = questions[3].question.slice(excess);
  assert.equal(Buffer.byteLength(JSON.stringify(draft())), 64 * 1024);
  assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true);
  questions[3].question += 'x';
  assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), false);
});
