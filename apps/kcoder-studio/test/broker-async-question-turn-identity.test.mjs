import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, lifetime) {
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
    for (const id of [undefined, null, 7, '', '   ']) {
      test(`an invalid canonical answer turn ${JSON.stringify(id)} cannot change ownership (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), peer = f.join(), answerer = f.join();
        const answer = f.send(answerer, 'asyncQuestion/answer', {
          threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
          answers: { item: { text: 'original answer' } },
        });
        if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        const question = { threadId: 'thread', questionId: 'question', answer: {
          submissionId: 'submission', answers: answer.params.answers,
        } };
        f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false,
          startedTurn: { id, status: 'running' } });
        assert.equal(f.broker.threadOwners.get('thread'), peer, 'unconfirmed execution cannot transfer the task');
        assert.equal(f.broker.activeTurns.size, 0, 'an invalid turn cannot register execution');
        assert.equal(f.broker.threadDrains.size, 0, 'an invalid turn cannot block recovery');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'disconnect cleanup needs a confirmed turn identity');
        if (lifecycle === 'connected') {
          assert.equal(answerer.messages.at(-1).error?.code, -32001);
          assert.match(answerer.messages.at(-1).error.message, /unknown/i);
        } else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
        const read = f.send(peer, 'asyncQuestion/list', { threadId: 'thread' });
        f.reply(read, { threadId: 'thread', questions: [question] });
        assert.deepEqual(peer.messages.at(-1).result.questions, [question], 'original answer remains readable');
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'reconciliation never replays the answer');
      });
    }
  }
}
