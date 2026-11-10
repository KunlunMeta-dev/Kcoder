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
  const reply = (request, result) => broker.routeServerMessage({ id: request.id, result });
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId }), { thread: { id: threadId } });
    return client;
  };
  return { broker, upstream, send, reply, join };
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    test(`a nested response envelope cannot reroute answer ownership or cleanup (${lifecycle}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime), owner = f.join('original'), answerer = f.join('original');
      const peer = f.join('peer');
      // Turn IDs need only identify execution within their own thread.
      f.reply(f.send(peer, 'turn/start', { threadId: 'peer' }), { turn: { id: 'turn-1' } });
      const answer = f.send(answerer, 'asyncQuestion/answer', {
        threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
        answers: { item: { text: 'original answer' } },
      });
      if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
      const deliveries = answerer.messages.length;
      const question = { threadId: 'original', questionId: 'question', answer: {
        submissionId: 'submission', answers: answer.params.answers,
      } };
      f.reply(answer, { threadId: 'original', question, accepted: true, duplicate: false,
        params: { threadId: 'peer' }, startedTurn: { id: 'turn-1', status: 'running' } });
      assert.equal(f.broker.threadOwners.get('peer'), peer, 'an envelope cannot transfer a different task');
      assert.deepEqual(f.broker.activeTurns.get('peer'), { turnId: 'turn-1', owner: peer });
      assert.equal(f.broker.threadOwners.get('original'), owner);
      assert.equal(f.broker.activeTurns.has('original'), false, 'an ambiguous receipt cannot register execution');
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
        'disconnect cleanup cannot interrupt the peer named by an extra envelope');
      if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
      else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');

      f.reply(f.send(owner, 'asyncQuestion/list', { threadId: 'original' }), {
        threadId: 'original', questions: [question],
      });
      assert.deepEqual(owner.messages.at(-1).result.questions, [question]);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
        'readback never repeats the original answer');
    });
  }
}
