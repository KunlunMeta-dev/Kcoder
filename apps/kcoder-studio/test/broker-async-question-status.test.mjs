import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { projectAsyncQuestionResponse } from '../src/broker-async-questions.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
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

// A saved-answer payload can match while its status is unusable by both clients.
// Validate before Gateway task control or disconnect cleanup changes anything.
for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const status of [null, '', 'unknown_status', 1, false, {}, []]) {
      test(`invalid answer status ${JSON.stringify(status)} cannot certify task control (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), answerer = f.join();
        const answer = f.send(answerer, 'asyncQuestion/answer', {
          threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
          answers: { item: { text: 'original answer' } },
        });
        if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        const question = {
          requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
          questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question', revision: 2, status,
          answer: { submissionId: 'submission', acceptedAtMs: 2, answers: answer.params.answers } };
        f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false,
          startedTurn: { id: 'unconfirmed-turn', status: 'running' } });
        assert.equal(f.broker.threadOwners.get('thread'), original, 'an unusable card cannot transfer task control');
        assert.equal(f.broker.activeTurns.size, 0, 'an invalid saved state cannot certify execution');
        assert.equal(f.broker.threadDrains.size, 0, 'an invalid receipt cannot block refresh');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'disconnect cannot interrupt an execution certified only by an invalid receipt');
        if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
        else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
        const saved = { ...question, status: 'queued' };
        f.reply(f.send(original, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [saved],
        });
        assert.deepEqual(original.messages.at(-1).result.questions, [saved]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      });
    }
  }
}

for (const method of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
  for (const status of [null, '', 'unknown_status', 1, false, {}, []]) {
    test(`${method} rejects explicit invalid status ${JSON.stringify(status)}`, () => {
      const params = { threadId: 'thread', questionId: 'question', submissionId: 'submission', answers: { item: { text: 'saved' } } };
      const question = {
        requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1,
        questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question', status,
        answer: { submissionId: params.submissionId, acceptedAtMs: 2, answers: params.answers } };
      const response = { id: 1, result: { threadId: 'thread',
        ...(method === 'asyncQuestion/answer' ? { accepted: true, duplicate: false } : {}),
        ...(method === 'asyncQuestion/list' ? { questions: [question] } : { question }) } };
      assert.equal(projectAsyncQuestionResponse(response, { method, params }).error?.code, -32001);
    });
  }
  for (const status of [undefined, 'pending', 'answer_saved', 'queued', 'context_applied',
    'delivery_failed', 'delivery_unknown', 'cancelled', 'stale']) {
    // Losing answers carry the saved winner; pending cannot certify an answer.
    // Lists may carry every known status, while cancellation confirms withdrawal.
    test(`${method} reconciles known or omitted status ${status}`, () => {
      const params = method === 'asyncQuestion/list' ? { threadId: 'thread', includeTerminal: true }
        : { threadId: 'thread', questionId: 'question' };
      const hasDeliveryError = status === 'delivery_failed' || status === 'delivery_unknown';
      const revision = status === 'cancelled' || status === 'stale' || hasDeliveryError || status === 'context_applied' ? 3 : 2;
      const question = { threadId: 'thread', questionId: 'question', status,
        ...(method === 'asyncQuestion/answer' ? { requestId: 'request', sourceTurnId: 'source',
          toolCallId: 'tool', revision, createdAtMs: 1,
          ...(hasDeliveryError ? { deliveryError: 'Original delivery error' } : {}),
          questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
          answer: { submissionId: 'winner', acceptedAtMs: 2,
          answers: { item: { text: 'Peer answer' } } } } : {}) };
      const response = { id: 1, result: { threadId: 'thread',
        ...(method === 'asyncQuestion/answer' ? { accepted: false, duplicate: false } : {}),
        ...(method === 'asyncQuestion/list' ? { questions: [question] } : { question }) } };
      const projected = projectAsyncQuestionResponse(response, { method, params });
      if ((method === 'asyncQuestion/cancel' && status !== undefined && status !== 'cancelled') ||
          (method === 'asyncQuestion/answer' && (status === undefined || status === 'pending')))
        assert.equal(projected.error?.code, -32001);
      else assert.equal(projected, response);
    });
  }
}
