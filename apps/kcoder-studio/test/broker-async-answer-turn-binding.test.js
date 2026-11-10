import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, sessionLifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: sessionLifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const respond = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'original', ...params } }));
    assert.ok(upstream.length > before, `${method} must reach the backend`);
    return upstream.at(-1);
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true,
      asyncUserQuestionsV1: true, sessionLifetimeV1: sessionLifetime });
    respond(send(client, 'thread/resume'), { thread: { id: 'original' } });
    return client;
  };
  const originalOwner = join(), answerer = join();
  return { broker, upstream, respond, send, originalOwner, answerer };
}

for (const sessionLifetime of [false, true]) {
  test(`${sessionLifetime ? 'resident lifetime' : 'legacy'}: a matching answer turn retains normal ownership`, t => {
    const f = fixture(t, sessionLifetime);
    const request = f.send(f.answerer, 'asyncQuestion/answer', {
      questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'original answer' } },
    });
    f.respond(request, {
      threadId: 'original', accepted: true, duplicate: false,
      question: { threadId: 'original', questionId: 'question', answer: {
        submissionId: 'submission', answers: request.params.answers,
      } },
      startedTurn: { threadId: 'original', id: 'answer-turn', status: 'running' },
    });
    assert.equal(f.answerer.messages.at(-1).result?.accepted, true);
    assert.equal(f.broker.threadOwners.get('original'), f.answerer);
    assert.deepEqual(f.broker.activeTurns.get('original'), { owner: f.answerer, turnId: 'answer-turn' });
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });

  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    test(`${sessionLifetime ? 'resident lifetime' : 'legacy'}: ${lifecycle} answer cannot bind a foreign started turn`, t => {
      const f = fixture(t, sessionLifetime);
      const request = f.send(f.answerer, 'asyncQuestion/answer', {
        questionId: 'question', submissionId: 'submission', expectedRevision: 1,
        answers: { item: { text: 'original answer' } },
      });
      if (lifecycle.includes('expired')) f.broker.expireRequest(request.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
      const before = f.answerer.messages.length;
      f.respond(request, {
        threadId: 'original', accepted: true, duplicate: false,
        question: { threadId: 'original', questionId: 'question', answer: {
          submissionId: 'submission', answers: request.params.answers,
        } },
        startedTurn: { threadId: 'another-task', id: 'foreign-turn', status: 'running' },
      });
      assert.equal(f.broker.threadOwners.get('original'), f.originalOwner,
        'a correct outer task and answer do not certify the nested turn task');
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
      else assert.equal(f.answerer.messages.length, before, 'unknown outcomes are not redelivered');
    });
  }
}
