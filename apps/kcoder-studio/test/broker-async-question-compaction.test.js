import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { compactRequestParams } from '../src/broker-request-budget.js';

function fixture(t, lifetime, thread, method = 'asyncQuestion/answer') {
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
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId }), { thread: { id: threadId } });
    return client;
  };
  const originalOwner = join('original'), peer = join('peer'), answerer = join('original');
  const answer = send(answerer, method, method === 'turn/start'
    ? { threadId: 'original', thread, input: [{ type: 'text', text: 'original question' }] }
    : { threadId: 'original', thread, questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'original answer' } } });
  const receipt = threadId => reply(answer, { threadId, accepted: true, duplicate: false,
    question: { threadId, questionId: 'question', answer: {
      submissionId: 'submission', answers: answer.params.answers,
    } }, startedTurn: { threadId, id: 'answer-turn', status: 'running' } });
  return { broker, upstream, originalOwner, peer, answerer, answer, receipt, reply };
}

for (const lifetime of [false, true]) {
  for (const detached of [false, true]) {
    test(`ordinary question turn receipts retain their original task (detached=${detached}, lifetime=${lifetime})`, t => {
      // TurnStartParams accepts unknown compatibility fields. Its canonical
      // response names the task inside turn, so cleanup relies on saved params.
      const f = fixture(t, lifetime, { id: 'peer' }, 'turn/start');
      if (detached) f.broker.detach(f.answerer);
      f.broker.expireRequest(f.answer.id);
      f.reply(f.answer, { turn: { id: 'answer-turn', threadId: 'original', status: 'running' } });
      assert.equal(f.broker.activeTurns.has('peer'), false);
      assert.equal(f.broker.threadDrains.has('peer'), false, 'an unrelated task must remain usable');
      assert.equal(f.broker.threadOwners.get('peer'), f.peer);
      const interrupts = f.upstream.filter(message => message.method === 'turn/interrupt');
      assert.deepEqual(interrupts.map(message => message.params), detached && !lifetime ? [
        { threadId: 'original', turnId: 'answer-turn' },
      ] : []);
      if (!detached) assert.deepEqual(f.broker.activeTurns.get('original'), { turnId: 'answer-turn', owner: f.answerer });
      assert.equal(f.upstream.filter(message => message.method === 'turn/start').length, 1);
    });
  }
}

for (const thread of [{ id: 'peer' }, { threadId: 'peer' }]) {
  for (const lifetime of [false, true]) {
    test(`expired answers keep their explicit original task (${JSON.stringify(thread)}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime, thread);
      f.broker.expireRequest(f.answer.id);
      const deliveries = f.answerer.messages.length;
      f.receipt('original');
      assert.deepEqual(f.broker.activeTurns.get('original'), { turnId: 'answer-turn', owner: f.answerer });
      assert.equal(f.broker.threadOwners.get('original'), f.answerer);
      assert.equal(f.broker.threadOwners.get('peer'), f.peer);
      assert.equal(f.answerer.messages.length, deliveries, 'timeout receipts are not delivered twice');
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });

    test(`detached answers clean up only the confirmed original task (${JSON.stringify(thread)}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime, thread);
      f.broker.detach(f.answerer);
      f.broker.expireRequest(f.answer.id);
      f.receipt('original');
      const interrupts = f.upstream.filter(message => message.method === 'turn/interrupt');
      assert.deepEqual(interrupts.map(message => message.params), lifetime ? [] : [
        { threadId: 'original', turnId: 'answer-turn' },
      ]);
      assert.equal(f.broker.threadOwners.get('peer'), f.peer);
      assert.equal(f.broker.threadDrains.has('peer'), false);
      assert.equal(f.broker.sharedThreads.has('original', f.originalOwner), true);
    });

    test(`a nested alias cannot certify a foreign late answer (${JSON.stringify(thread)}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime, thread);
      f.broker.expireRequest(f.answer.id);
      f.receipt('peer');
      assert.equal(f.broker.threadOwners.get('peer'), f.peer, 'the unrelated task must keep its owner');
      assert.equal(f.broker.activeTurns.size, 0, 'a foreign receipt cannot register execution');
      f.broker.detach(f.answerer);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}

test('compaction preserves routing precedence, fallback bounds and repeated compaction', () => {
  for (const params of [
    { threadId: 'original', thread_id: 'snake', thread: { threadId: 'nested', id: 'last' } },
    { thread_id: 'snake', thread: { threadId: 'nested', id: 'last' } },
    { thread: { threadId: 'nested', id: 'last' } },
    { thread: { id: 'last' } },
  ]) {
    const compact = compactRequestParams(params);
    assert.equal(compact.threadId ?? compact.thread_id,
      params.threadId ?? params.thread_id ?? params.thread.threadId ?? params.thread.id);
    assert.deepEqual(compactRequestParams(compact), compact);
  }
  assert.deepEqual(compactRequestParams({ thread: { id: 'x'.repeat(32769) } }), {});
});
