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
  const join = (threadId = 'thread') => {
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
    for (const field of ['accepted', 'duplicate']) {
      // Only connected clients observe malformed acceptance flags; legacy
      // targets also expose bad duplicate flags through disconnect cleanup.
      if (field === 'accepted' && lifecycle !== 'connected') continue;
      if (lifetime && lifecycle.includes('disconnected')) continue;
      for (const value of [undefined, null, 'true']) {
        test(`invalid ${field}=${value} cannot bind or cancel an answer turn (${lifecycle}, lifetime=${lifetime})`, t => {
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
          f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false, [field]: value,
            startedTurn: { threadId: 'thread', id: 'unconfirmed-turn', status: 'running' } });
          assert.equal(f.broker.threadOwners.get('thread'), peer, 'an invalid receipt cannot transfer the original task');
          assert.equal(f.broker.activeTurns.size, 0, 'an invalid receipt cannot register execution');
          assert.equal(f.broker.threadDrains.size, 0, 'an invalid receipt cannot block the task');
          assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
            'disconnected clients cannot cancel an unconfirmed admission');
          if (lifecycle === 'connected') {
            assert.equal(answerer.messages.at(-1).error?.code, -32001);
            assert.match(answerer.messages.at(-1).error.message, /unknown/i);
          } else assert.equal(answerer.messages.length, deliveries, 'late receipts are never delivered twice');

          const read = f.send(peer, 'asyncQuestion/list', { threadId: 'thread' });
          f.reply(read, { threadId: 'thread', questions: [question] });
          assert.deepEqual(peer.messages.at(-1).result.questions, [question], 'explicit original-task read recovers');
          assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
            'recovery never repeats the answer');
        });
      }
    }
  }
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    test(`result method metadata cannot reroute an answer admission (${lifecycle}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime), original = f.join('original'), peer = f.join('peer');
      const answerer = f.join('original');
      f.reply(f.send(peer, 'turn/start', { threadId: 'peer' }), { turn: { id: 'answer-turn' } });
      const answer = f.send(answerer, 'asyncQuestion/answer', {
        threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
        answers: { item: { text: 'original answer' } },
      });
      if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
      const deliveries = answerer.messages.length;
      f.reply(answer, { threadId: 'original', accepted: true, duplicate: false,
        method: 'runtime.worktrees.comparison.read', ownerThreadId: 'peer',
        question: { threadId: 'original', questionId: 'question', answer: {
          submissionId: 'submission', answers: answer.params.answers,
        } }, startedTurn: { id: 'answer-turn', status: 'running' } });
      assert.equal(f.broker.threadOwners.get('peer'), peer, 'result metadata cannot transfer a peer task');
      assert.deepEqual(f.broker.activeTurns.get('peer'), { turnId: 'answer-turn', owner: peer });
      assert.equal(f.broker.threadDrains.has('peer'), false);
      const detached = lifecycle.includes('disconnected');
      assert.equal(f.broker.threadOwners.get('original'), detached ? original : answerer);
      assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
        detached && !lifetime ? [{ threadId: 'original', turnId: 'answer-turn' }] : []);
      if (!detached) assert.deepEqual(f.broker.activeTurns.get('original'), { turnId: 'answer-turn', owner: answerer });
      if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).result.accepted, true);
      else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}
