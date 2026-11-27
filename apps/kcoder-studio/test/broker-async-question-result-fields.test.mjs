import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { isContract } from '../shared/generated/validator.mjs';

const question = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
  answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'Original answer' } } },
};
const answerResult = { threadId: 'thread', accepted: true, duplicate: false, question,
  startedTurn: { threadId: 'thread', id: 'answer-turn', status: 'running' } };

function fixture(t, lifetime = false) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  return { broker, upstream, send, reply, join };
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    test(`client-rejected result fields cannot certify answer execution (${lifecycle}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime), original = f.join(), answerer = f.join();
      const request = f.send(answerer, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
        expectedRevision: 1, submissionId: 'submission', answers: question.answer.answers });
      if (lifecycle.includes('expired')) f.broker.expireRequest(request.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
      const deliveries = answerer.messages.length;
      const result = { ...answerResult, obsoleteDelivery: 'legacy metadata' };
      assert.equal(isContract('AsyncQuestionAnswerResult', answerResult), true);
      assert.equal(isContract('AsyncQuestionAnswerResult', result), false);
      f.reply(request, result);
      assert.equal(f.broker.threadOwners.get('thread'), original,
        'a result rejected by the card cannot transfer task control');
      assert.equal(f.broker.activeTurns.size, 0, 'unconfirmed execution cannot become active');
      assert.equal(f.broker.threadDrains.size, 0, 'unconfirmed execution cannot block recovery');
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
        'an unconfirmed result cannot authorize disconnect cleanup');
      if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
      else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
      f.reply(f.send(original, 'asyncQuestion/list', { threadId: 'thread' }), {
        threadId: 'thread', questions: [question],
      });
      assert.deepEqual(original.messages.at(-1).result.questions, [question]);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
        'readback never replays the answer');
    });
  }
}

for (const [method, contract, result] of [
  ['asyncQuestion/list', 'AsyncQuestionListResult', { threadId: 'thread', questions: [question] }],
  ['asyncQuestion/cancel', 'AsyncQuestionCancelResult', { threadId: 'thread', question: { ...question, status: 'cancelled' } }],
  ['asyncQuestion/answer', 'AsyncQuestionAnswerResult', answerResult],
]) {
  test(`${method} rejects unknown result fields and preserves the original readback path`, t => {
    const f = fixture(t), client = f.join();
    for (const extension of [{ obsoleteDelivery: false }, { params: null }]) {
      const invalid = { ...result, ...extension };
      assert.equal(isContract(contract, invalid), false);
      f.reply(f.send(client, method, { threadId: 'thread', questionId: 'question', expectedRevision: 1,
        submissionId: 'submission', answers: question.answer.answers }), invalid);
      assert.equal(client.messages.at(-1).error?.code, -32001);
    }
    // Keep compatible older snapshots that omit fields, without adding defaults.
    const questions = [{ threadId: 'thread', questionId: 'question', revision: 2 }];
    f.reply(f.send(client, 'asyncQuestion/list', { threadId: 'thread' }), { threadId: 'thread', questions });
    assert.deepEqual(client.messages.at(-1).result.questions, questions);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
  });
}

test('a valid answer result still confirms execution and transfers task control', t => {
  const f = fixture(t);
  f.join();
  const answerer = f.join();
  f.reply(f.send(answerer, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
    expectedRevision: 1, submissionId: 'submission', answers: question.answer.answers }), answerResult);
  assert.deepEqual(answerer.messages.at(-1).result, answerResult);
  assert.equal(f.broker.threadOwners.get('thread'), answerer);
  assert.deepEqual(f.broker.activeTurns.get('thread'), { owner: answerer, turnId: 'answer-turn' });
});

test('a refresh rejects two question IDs for the same original tool call', t => {
  const f = fixture(t), client = f.join();
  const conflicting = { ...question, questionId: 'other-question', requestId: 'other-request' };
  const list = { threadId: 'thread', questions: [question, conflicting] };
  assert.equal(isContract('AsyncQuestionListResult', list), true);
  f.reply(f.send(client, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), list);
  const invalid = client.messages.at(-1);

  const validList = { threadId: 'thread', questions: [
    question,
    { ...conflicting, toolCallId: 'other-tool' },
    { ...question, questionId: 'later-question', requestId: 'later-request', sourceTurnId: 'later-turn' },
  ] };
  f.reply(f.send(client, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), validList);
  assert.deepEqual(client.messages.at(-1).result, validList);
  assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
  assert.equal(invalid.error?.code, -32001);
  assert.equal(invalid.result, undefined);
});

test('a refresh rejects two source calls claiming the same original request', t => {
  const f = fixture(t), client = f.join();
  const read = () => f.send(client, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
  const other = { ...question, questionId: 'other-question', toolCallId: 'other-tool' };
  const conflict = { threadId: 'thread', questions: [question, other] };
  assert.equal(isContract('AsyncQuestionListResult', conflict), true);
  f.reply(read(), conflict);
  const invalid = client.messages.at(-1);

  const recovered = { threadId: 'thread', questions: [
    question,
    { ...other, requestId: 'other-request' },
    { threadId: 'thread', questionId: 'legacy-without-request' },
  ] };
  f.reply(read(), recovered);
  assert.deepEqual(client.messages.at(-1).result, recovered);
  assert.equal(f.broker.threadOwners.get('thread'), client);
  assert.ok(f.upstream.every(message => ['thread/resume', 'asyncQuestion/list'].includes(message.method)));
  assert.equal(invalid.error?.code, -32001);
  assert.equal(invalid.result, undefined);
});

test('an oversized question list is rejected and a full valid ledger can still refresh', t => {
  const f = fixture(t), client = f.join();
  const refresh = questions => {
    const request = f.send(client, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
    f.reply(request, { threadId: 'thread', questions });
    return client.messages.at(-1);
  };
  const questions = Array.from({ length: 513 }, (_, index) => ({
    ...question, questionId: `question-${index}`, requestId: `request-${index}`, toolCallId: `tool-${index}`,
  }));

  const oversized = refresh(questions);
  const valid = questions.slice(0, 512);
  assert.deepEqual(refresh(valid).result?.questions, valid);
  assert.equal(f.broker.threadOwners.get('thread'), client);
  assert.equal(f.broker.activeTurns.size, 0);
  assert.equal(f.broker.threadDrains.size, 0);
  assert.ok(f.upstream.every(message => ['thread/resume', 'asyncQuestion/list'].includes(message.method)));
  assert.equal(oversized.result, undefined, 'oversized readback must not be forwarded as a valid list');
  assert.equal(oversized.error?.code, -32001);
});
