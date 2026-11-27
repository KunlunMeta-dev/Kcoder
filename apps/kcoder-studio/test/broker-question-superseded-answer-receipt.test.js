import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

function fixture(t, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  const answerParams = { threadId: 'thread', questionId: 'saved-question', expectedRevision: 1,
    submissionId: 'submission', answers: { item: { text: 'saved answer' } } };
  const answerReceipt = attemptId => ({ threadId: 'thread', accepted: true, duplicate: true,
    question: answeredAsyncQuestion(answerParams),
    startedTurn: { threadId: 'thread', id: 'turn', attemptId, status: 'running' } });
  return { broker, upstream, emit, send, reply, join, answerParams, answerReceipt };
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const finished of [false, true]) {
      test(`superseded answer receipt cannot reclaim or interrupt a retry (${lifecycle}, finished=${finished}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), owner = f.join(), answerer = f.join();
        const turn = { id: 'turn', threadId: 'thread', attemptId: 'old', status: 'running' };
        f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
        const answer = f.send(answerer, 'asyncQuestion/answer', f.answerParams);
        // A terminal may have been missed. A later authoritative retry receipt
        // supersedes the old attempt even while its answer RPC remains in transit.
        f.reply(f.send(owner, 'turn/start', { threadId: 'thread', retryFromTurnId: 'turn',
          retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'new' } });
        if (finished) f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
          turn: { ...turn, attemptId: 'new', status: 'completed' } } });
        if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        const active = f.broker.activeTurns.get('thread');
        f.reply(answer, f.answerReceipt('old'));
        assert.equal(f.broker.threadOwners.get('thread'), owner, 'old admission cannot take task control');
        assert.equal(f.broker.activeTurns.get('thread'), active, 'old receipt cannot replace or revive execution');
        assert.equal(f.broker.threadDrains.size, 0, 'a stale attempt cannot block the current task');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'turn-level interruption would cancel the newer attempt sharing this turn ID');
        if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).result.accepted, true,
          'the saved answer fact is still delivered');
        else assert.equal(answerer.messages.length, deliveries, 'late receipts are not delivered twice');
        if (!finished) {
          f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
            questionId: 'retry-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } });
          assert.equal(f.broker.serverRequests.get(500), owner, 'retry input stays with its actual client');
          f.broker.receive(owner, JSON.stringify({ id: 500,
            result: { answers: { choice: { answers: ['current answer'] } } } }));
          assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
        }
        const read = f.send(owner, 'asyncQuestion/list', { threadId: 'thread' });
        f.reply(read, { threadId: 'thread', questions: [f.answerReceipt('old').question] });
        assert.equal(owner.messages.at(-1).result.questions[0].answer.submissionId, 'submission');
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      });
    }
  }
}

test('a newly admitted answer retry still replaces the old attempt', t => {
  const f = fixture(t, true), owner = f.join(), answerer = f.join();
  f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), {
    turn: { id: 'turn', threadId: 'thread', attemptId: 'old', status: 'running' },
  });
  f.reply(f.send(answerer, 'asyncQuestion/answer', f.answerParams), f.answerReceipt('new'));
  assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'new');
  assert.equal(f.broker.activeTurns.get('thread')?.owner, answerer);
  assert.equal(f.broker.threadOwners.get('thread'), answerer);
});
