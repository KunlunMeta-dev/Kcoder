import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
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
  const peer = join(), answerer = join();
  reply(send(peer, 'turn/start', { threadId: 'thread' }), { turn: { id: 'peer-turn' } });
  const answer = send(answerer, 'asyncQuestion/answer', {
    threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
    answers: { item: { text: 'original answer' } },
  });
  const question = { threadId: 'thread', questionId: 'question', answer: {
    submissionId: 'submission', answers: answer.params.answers,
  } };
  const receipt = startedTurn => reply(answer, {
    threadId: 'thread', question, accepted: true, duplicate: false, startedTurn,
  });
  return { broker, upstream, peer, answerer, answer, send, reply, question, receipt };
}

for (const lifecycle of ['connected', 'disconnected', 'expired-disconnected']) {
  test(`a conflicting startedTurn alias cannot take over or interrupt a peer (${lifecycle})`, t => {
    const f = fixture(t);
    if (lifecycle.includes('expired')) f.broker.expireRequest(f.answer.id);
    if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
    const deliveries = f.answerer.messages.length;
    f.receipt({ threadId: 'thread', id: 'answer-turn', turnId: 'peer-turn', status: 'running' });
    assert.equal(f.broker.threadOwners.get('thread'), f.peer, 'the original peer keeps task control');
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'peer-turn', owner: f.peer });
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
      'an ambiguous answer receipt must not cancel the peer');
    assert.equal(f.broker.threadDrains.size, 0, 'the peer must remain usable');
    if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
    else assert.equal(f.answerer.messages.length, deliveries, 'a late receipt is not redelivered');

    const read = f.send(f.peer, 'asyncQuestion/list', { threadId: 'thread' });
    f.reply(read, { threadId: 'thread', questions: [f.question] });
    assert.deepEqual(f.peer.messages.at(-1).result.questions, [f.question]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const alias of [undefined, 'answer-turn']) {
  test(`an unambiguous answer turn keeps legacy disconnect cleanup (alias=${alias})`, t => {
    const f = fixture(t);
    f.broker.detach(f.answerer);
    f.receipt({ id: 'answer-turn', ...(alias === undefined ? {} : { turnId: alias }), status: 'running' });
    const interrupts = f.upstream.filter(message => message.method === 'turn/interrupt');
    assert.deepEqual(interrupts.map(message => message.params), [{ threadId: 'thread', turnId: 'answer-turn' }]);
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'peer-turn', owner: f.peer });
    assert.equal(f.broker.threadDrains.size, 0);
  });
}
