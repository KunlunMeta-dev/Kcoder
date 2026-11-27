import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

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
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  const join = (threadId = 'thread') => {
    const client = { channel: 'runtime', messages: [], closes: 0,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closes++; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId }), { thread: { id: threadId } });
    return client;
  };
  return { broker, child, upstream, send, reply, join };
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const result of [undefined, null]) {
      test(`empty answer result ${result} isolates its request (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), answerer = f.join(), peer = f.join('peer');
        const question = { threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
          toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
          questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
          answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'Saved answer' } } } };
        const request = f.send(answerer, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
          expectedRevision: 1, submissionId: 'submission', answers: question.answer.answers });
        const peerRead = f.send(peer, 'asyncQuestion/list', { threadId: 'peer' });
        if (lifecycle.includes('expired')) f.broker.expireRequest(request.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        // One bad receipt must not stop the decoder before the next peer frame.
        f.child.stdout.write([
          JSON.stringify({ id: request.id, result }),
          JSON.stringify({ id: peerRead.id, result: { threadId: 'peer', questions: [] } }),
          '',
        ].join('\n'));
        assert.equal(f.broker.closed, false, 'a malformed answer result must not close the shared transport');
        assert.equal(original.closes + peer.closes + answerer.closes, 0);
        assert.equal(f.broker.threadOwners.get('thread'), original);
        assert.equal(f.broker.activeTurns.size, 0);
        assert.equal(f.broker.threadDrains.size, 0);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
        if (lifecycle === 'connected') {
          assert.equal(answerer.messages.at(-1).error?.code, -32001);
          assert.match(answerer.messages.at(-1).error.message, /unknown/i);
        } else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
        assert.deepEqual(peer.messages.at(-1).result, { threadId: 'peer', questions: [] });
        f.reply(f.send(original, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [question],
        });
        assert.deepEqual(original.messages.at(-1).result.questions, [question]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'original-task readback never replays the answer');
      });
    }
  }
}
