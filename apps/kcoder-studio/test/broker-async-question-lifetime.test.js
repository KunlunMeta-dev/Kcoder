import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, lifetime, method) {
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
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} must reach the original app-server`);
    return request;
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  const peer = join(), answerer = join();
  const answer = send(answerer, method, method === 'asyncQuestion/answer'
    ? { threadId: 'thread', questionId: 'question', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'original answer' } } }
    : { threadId: 'thread', input: [{ type: 'text', text: 'original input' }] });
  const answerReply = () => reply(answer, method === 'turn/start'
    ? { turn: { threadId: 'thread', id: 'answer-turn', status: 'running' } }
    : { threadId: 'thread', accepted: true, duplicate: false,
    question: {
      requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
      questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question', answer: { acceptedAtMs: 2,
      submissionId: 'submission', answers: answer.params.answers,
    } }, startedTurn: { threadId: 'thread', id: 'answer-turn', status: 'running' } });
  return { broker, upstream, peer, answerer, answer, answerReply };
}

for (const method of ['asyncQuestion/answer', 'turn/start']) {
  for (const lifetime of [true, false]) {
    for (const order of ['detach-expire', 'expire-detach', 'expire-receipt-detach']) {
      test(`${method} timeout ${order} preserves negotiated session survival (lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime, method);
        if (order === 'detach-expire') f.broker.detach(f.answerer);
        f.broker.expireRequest(f.answer.id);
        if (order === 'expire-detach') f.broker.detach(f.answerer);
        const deliveries = f.answerer.messages.length;
        f.answerReply();
        assert.equal(f.answerer.messages.length, deliveries, 'an expired answer receipt is never delivered twice');
        if (order === 'expire-receipt-detach') f.broker.detach(f.answerer);
        const interrupts = f.upstream.filter(message => message.method === 'turn/interrupt');
        assert.equal(interrupts.length, lifetime ? 0 : 1,
          'the app-server owns survival when negotiated; legacy cleanup still cancels the exact answer admission');
        if (!lifetime) assert.deepEqual(interrupts[0].params, { threadId: 'thread', turnId: 'answer-turn' });
        assert.equal(f.broker.threadDrains.has('thread'), !lifetime);
        assert.equal(f.broker.sharedThreads.has('thread', f.peer), true, 'a joined peer remains attached');
        assert.equal(f.upstream.filter(message => message.method === method).length, 1,
          'timeout and disconnect must never replay the original input');
      });
    }
  }
}

for (const lifetime of [true, false]) {
  for (const expired of [false, true]) {
    test(`non-forced detach respects a pending answer (lifetime=${lifetime}, expired=${expired})`, async t => {
      const f = fixture(t, lifetime, 'asyncQuestion/answer');
      if (expired) f.broker.expireRequest(f.answer.id);
      f.broker.receive(f.answerer, JSON.stringify({ jsonrpc: '2.0', id: 90,
        method: 'gateway/client/detach', params: { confirm: true, force: false } }));
      await new Promise(resolve => setImmediate(resolve));
      f.answerReply();

      assert.equal(f.broker.clients.has(f.answerer), !lifetime);
      const detachReceipt = f.answerer.messages.find(message => message.id === 90);
      if (lifetime) assert.deepEqual(detachReceipt?.result, { detached: true });
      else {
        assert.equal(detachReceipt?.error?.code, -32043);
        assert.equal(f.broker.activeTurns.get('thread')?.owner, f.answerer);
      }
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      assert.equal(f.broker.sharedThreads.has('thread', f.peer), true);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}

for (const lifetime of [true, false]) {
  for (const expired of [false, true]) {
    test(`forced detach reports unconfirmed legacy answer cleanup (lifetime=${lifetime}, expired=${expired})`, async t => {
      const f = fixture(t, lifetime, 'asyncQuestion/answer');
      if (expired) f.broker.expireRequest(f.answer.id);
      f.broker.receive(f.answerer, JSON.stringify({ jsonrpc: '2.0', id: 90,
        method: 'gateway/client/detach', params: { confirm: true, force: true } }));
      await new Promise(resolve => setImmediate(resolve));

      const receipt = f.answerer.messages.find(message => message.id === 90);
      assert.equal(f.broker.clients.has(f.answerer), false);
      assert.equal(f.broker.sharedThreads.has('thread', f.peer), true);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
        'without a confirmed admission Gateway cannot interrupt any turn');
      if (lifetime) assert.deepEqual(receipt?.result, { detached: true });
      else {
        assert.equal(receipt?.error?.code, -32043,
          'legacy detach cannot confirm termination before a pending answer identifies its turn');
        assert.equal(receipt.result, undefined);
      }

      const deliveries = f.answerer.messages.length;
      f.answerReply();
      const interrupts = f.upstream.filter(message => message.method === 'turn/interrupt');
      assert.deepEqual(interrupts.map(message => message.params),
        lifetime ? [] : [{ threadId: 'thread', turnId: 'answer-turn' }]);
      assert.equal(f.answerer.messages.length, deliveries);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}
