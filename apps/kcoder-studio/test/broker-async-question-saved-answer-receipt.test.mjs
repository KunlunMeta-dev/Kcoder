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

const timestamps = [
  ['missing', undefined], ['null', null], ['negative', -1], ['string', '2'], ['fractional', 2.5], ['valid', 2],
];
const question = (answers, acceptedAtMs) => ({
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }],
  answer: { submissionId: 'submission', acceptedAtMs, answers },
});

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const [name, timestamp] of timestamps) {
      test(`${name} saved-answer timestamp fences ownership and cleanup (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), answerer = f.join();
        const answers = { item: { text: 'original answer' } };
        const request = f.send(answerer, 'asyncQuestion/answer', {
          threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1, answers,
        });
        if (lifecycle.includes('expired')) f.broker.expireRequest(request.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        f.reply(request, { threadId: 'thread', question: question(answers, timestamp), accepted: true,
          duplicate: false, startedTurn: { threadId: 'thread', id: 'answer-turn', status: 'running' } });
        const valid = name === 'valid', detached = lifecycle.includes('disconnected');
        assert.equal(f.broker.threadOwners.get('thread'), valid && !detached ? answerer : original,
          'a malformed saved answer cannot certify a new task controller');
        assert.equal(f.broker.activeTurns.has('thread'), valid && !detached);
        assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
          valid && detached && !lifetime ? [{ threadId: 'thread', turnId: 'answer-turn' }] : [],
          'disconnect must not interrupt execution certified only by an invalid receipt');
        assert.equal(f.broker.threadDrains.has('thread'), valid && detached && !lifetime);
        if (lifecycle === 'connected') {
          if (valid) assert.equal(answerer.messages.at(-1).result.accepted, true);
          else assert.equal(answerer.messages.at(-1).error?.code, -32001);
        } else assert.equal(answerer.messages.length, deliveries);
        const saved = question(answers, 2);
        f.reply(f.send(original, 'asyncQuestion/list', { threadId: 'thread' }), { threadId: 'thread', questions: [saved] });
        assert.deepEqual(original.messages.at(-1).result.questions, [saved]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'recovery reads the original answer without replaying input');
      });
    }
  }
}
