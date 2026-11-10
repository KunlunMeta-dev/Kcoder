import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const status of ['pending', 'queued']) {
      test(`${status} answer state fences ownership and cleanup (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), answerer = f.join();
        const answer = f.send(answerer, 'asyncQuestion/answer', {
          threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
          answers: { item: { text: 'original answer' } },
        });
        if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        const question = { threadId: 'thread', questionId: 'question', requestId: 'request',
          sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1, status,
          questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }],
          answer: { submissionId: 'submission', acceptedAtMs: 2, answers: answer.params.answers } };
        f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false,
          startedTurn: { threadId: 'thread', id: 'answer-turn', status: 'running' } });
        const detached = lifecycle.includes('disconnected');
        const valid = status === 'queued';
        assert.equal(f.broker.threadOwners.get('thread'), valid && !detached ? answerer : original,
          'an answer still marked pending cannot certify a new task controller');
        assert.equal(f.broker.activeTurns.has('thread'), valid && !detached,
          'contradictory saved answers cannot register execution');
        const interrupts = f.upstream.filter(message => message.method === 'turn/interrupt');
        assert.deepEqual(interrupts.map(message => message.params), valid && detached && !lifetime
          ? [{ threadId: 'thread', turnId: 'answer-turn' }] : [],
        'disconnect cleanup requires a consistent saved-answer receipt');
        assert.equal(f.broker.threadDrains.has('thread'), valid && detached && !lifetime);
        if (lifecycle === 'connected') {
          if (valid) assert.equal(answerer.messages.at(-1).result.accepted, true);
          else assert.equal(answerer.messages.at(-1).error?.code, -32001);
        } else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
        // Explicit readback can recover the actual saved answer without replay.
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
