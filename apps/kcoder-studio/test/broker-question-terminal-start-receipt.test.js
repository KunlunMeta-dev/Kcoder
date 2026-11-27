import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

function fixture(t, shared, lifetime, status) {
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
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const send = (client, method, params = {}) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} must reach the original task`);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume'), { thread: { id: 'thread' } });
    return client;
  };
  const owner = join();
  reply(send(owner, 'turn/start'), { turn: { id: 'old-turn', status: 'running' } });
  emit({ id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'old-turn', questionId: 'old-question', appServerEpoch: 'epoch',
  } });
  emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: 'old-turn' } });
  return { broker, upstream, owner, emit, send, reply, join };
}

for (const status of ['completed', 'failed', 'interrupted']) {
  for (const shared of [false, true]) {
    for (const lifetime of [false, true]) {
      for (const detached of [false, true]) {
        test(`${status} retry receipt cannot revive a question turn (shared=${shared}, lifetime=${lifetime}, detached=${detached})`, t => {
          const f = fixture(t, shared, lifetime, status), retrying = shared ? f.join() : f.owner;
          // Native returns the saved terminal turn when a retry operation was
          // already accepted. Reading this receipt starts no new execution.
          const retry = f.send(retrying, 'turn/start', {
            retryFromTurnId: 'failed-turn', retryOperationId: 'original-retry',
          });
          if (detached) f.broker.detach(retrying);
          const delivered = retrying.messages.length;
          f.reply(retry, { turn: { id: 'old-turn', threadId: 'thread', status } });
          assert.equal(f.broker.activeTurns.size, 0, 'a historical receipt cannot recreate an active question turn');
          assert.equal(f.broker.threadDrains.size, 0, 'a terminal receipt must settle any provisional disconnect drain');
          assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
            'receipt recovery cannot cancel historical execution');
          if (detached) assert.equal(retrying.messages.length, delivered, 'a departed client receives no late response');
          else assert.equal(retrying.messages.at(-1).result.turn.status, status, 'the original receipt remains visible');
          if (shared) assert.equal(f.broker.threadOwners.get('thread'), f.owner,
            'a receipt-only retry must release its provisional control');
          const next = detached && !shared ? f.join() : f.owner;
          const start = f.send(next, 'turn/start');
          f.reply(start, { turn: { id: 'next-turn', status: 'running' } });
          f.emit({ id: 600, method: 'question/request', params: {
            threadId: 'thread', turnId: 'next-turn', questionId: 'next-question',
          } });
          assert.equal(f.broker.serverRequests.get(600), next, 'the next question keeps its actual input client');
          f.broker.receive(next, JSON.stringify({ id: 600, result: { answers: {} } }));
          assert.equal(f.upstream.at(-1).id, 600, 'the original client can answer the next question');
        });
      }
    }
  }

  test(`${status} retry readback preserves an async answer admitted during its reservation`, t => {
    const f = fixture(t, true, true, status), retrying = f.join();
    const retry = f.send(retrying, 'turn/start', { retryFromTurnId: 'failed-turn', retryOperationId: 'original-retry' });
    const answer = f.send(f.owner, 'asyncQuestion/answer', { questionId: 'async-question', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'original answer' } } });
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
      question: answeredAsyncQuestion(answer.params), startedTurn: { id: 'answer-turn', status: 'running' } });
    f.reply(retry, { turn: { id: 'old-turn', status } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner, 'readback cannot steal the answer turn');
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: f.owner });
    f.emit({ id: 600, method: 'question/request', params: {
      threadId: 'thread', turnId: 'answer-turn', questionId: 'follow-up-question',
    } });
    assert.equal(f.broker.serverRequests.get(600), f.owner, 'the follow-up belongs to the async answering client');
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}


for (const status of ['completed', 'failed', 'interrupted']) {
  for (const shared of [false, true]) {
    for (const lifetime of [false, true]) {
      for (const detached of [false, true]) {
        test(`${status} before a running start receipt cannot revive its question turn (shared=${shared}, lifetime=${lifetime}, detached=${detached})`, t => {
          const f = fixture(t, shared, lifetime, status), starting = shared ? f.join() : f.owner;
          const start = f.send(starting, 'turn/start', {
            retryFromTurnId: 'quick-turn', retryOperationId: 'original-retry',
          });
          f.emit({ id: 700, method: 'question/request', params: {
            threadId: 'thread', turnId: 'quick-turn', questionId: 'quick-question',
          } });
          f.emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: 'quick-turn' } });
          if (detached) f.broker.detach(starting);
          f.reply(start, { turn: { id: 'quick-turn', threadId: 'thread', status: 'running' } });
          assert.equal(f.broker.activeTurns.size, 0, 'a late admission receipt cannot undo the observed terminal');
          assert.equal(f.broker.threadDrains.size, 0, 'the completed question turn needs no disconnect drain');
          assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
            'the original terminal already proves that no cleanup interrupt is needed');
          if (shared) assert.equal(f.broker.threadOwners.get('thread'), f.owner,
            'the finished admission must release its provisional controller');
          const next = detached && !shared ? f.join() : f.owner;
          f.reply(f.send(next, 'turn/start'), { turn: { id: 'next-turn', status: 'running' } });
          f.emit({ id: 701, method: 'question/request', params: {
            threadId: 'thread', turnId: 'next-turn', questionId: 'next-question',
          } });
          assert.equal(f.broker.serverRequests.get(701), next, 'the next original question remains answerable');
          f.broker.receive(next, JSON.stringify({ id: 701, result: { answers: {} } }));
          assert.equal(f.upstream.at(-1).id, 701);
        });
      }
    }
  }

  test(`${status} before a running start receipt preserves a newer async answer and its question owner`, t => {
    const f = fixture(t, true, true, status), starting = f.join();
    const start = f.send(starting, 'turn/start', {
      retryFromTurnId: 'quick-turn', retryOperationId: 'original-retry',
    });
    f.emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: 'quick-turn' } });
    const answer = f.send(f.owner, 'asyncQuestion/answer', { questionId: 'async-question', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'original answer' } } });
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
      question: answeredAsyncQuestion(answer.params), startedTurn: { id: 'answer-turn', status: 'running' } });
    f.reply(start, { turn: { id: 'quick-turn', status: 'running' } });
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: f.owner });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    f.emit({ id: 702, method: 'question/request', params: {
      threadId: 'thread', turnId: 'answer-turn', questionId: 'follow-up-question',
    } });
    assert.equal(f.broker.serverRequests.get(702), f.owner, 'follow-up must retain the actual answering client');
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}


test('a terminal from an earlier attempt cannot suppress a fresh retry with the same turn ID', t => {
  const f = fixture(t, true, true, 'failed'), retrying = f.join();
  const retry = f.send(retrying, 'turn/start', {
    retryFromTurnId: 'old-turn', retryOperationId: 'fresh-retry',
  });
  f.reply(retry, { turn: { id: 'old-turn', threadId: 'thread', status: 'running' } });
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'old-turn', owner: retrying });
  assert.equal(f.broker.threadOwners.get('thread'), retrying);
});
