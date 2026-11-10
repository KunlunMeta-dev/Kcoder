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
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId }), { thread: { id: threadId } });
    return client;
  };
  return { broker, upstream, emit, send, reply, join };
}

const terminals = ['turn/completed', 'turn/failed', 'turn/interrupted'];
for (const method of terminals) {
  for (const params of [
    { turnId: 'turn-1' }, { turn_id: 'turn-1' },
    { turn: { id: 'turn-1' } }, { turn: { turnId: 'turn-1' } },
  ]) test(`${method} ${JSON.stringify(params)} cannot close two tasks sharing a turn ID`, t => {
    const f = fixture(t), first = f.join('first'), second = f.join('second');
    for (const [threadId, owner, requestId] of [['first', first, 500], ['second', second, 600]]) {
      f.reply(f.send(owner, 'turn/start', { threadId }), { turn: { id: 'turn-1' } });
      f.emit({ id: requestId, method: 'question/request', params: {
        threadId, turnId: 'turn-1', questionId: `question-${threadId}`, appServerEpoch: 'epoch',
      } });
    }
    const counts = [first.messages.length, second.messages.length];
    f.emit({ method, params });
    assert.deepEqual([...f.broker.activeTurns.keys()], ['first', 'second'],
      'a turn-only collision cannot certify either task completion');
    assert.deepEqual([...f.broker.serverRequests.keys()], [500, 600], 'both original questions stay answerable');
    assert.deepEqual([first.messages.length, second.messages.length], counts,
      'an ambiguous terminal cannot close cards through a threadless broadcast');
    f.emit({ method, params: { threadId: 'first', turnId: 'turn-1' } });
    assert.equal(f.broker.activeTurns.has('first'), false);
    assert.equal(f.broker.activeTurns.get('second').owner, second);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(f.broker.serverRequests.get(600), second);
  });

  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    test(`${method} without a task cannot poison a pending answer (${lifecycle})`, t => {
      const f = fixture(t), peer = f.join('peer'), owner = f.join('original'), answerer = f.join('original');
      f.reply(f.send(peer, 'turn/start', { threadId: 'peer' }), { turn: { id: 'turn-1' } });
      const answer = f.send(answerer, 'asyncQuestion/answer', {
        threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
        answers: { item: { text: 'saved answer' } },
      });
      if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
      f.emit({ method, params: { turnId: 'turn-1' } });
      assert.equal(f.broker.pending.get(answer.id).asyncQuestionTerminalTurns?.has('turn-1') ?? false, false,
        'a terminal without the original task cannot settle its in-flight answer');
      assert.equal(f.broker.activeTurns.get('peer')?.owner, peer,
        'an in-flight answer in another task makes the terminal ambiguous');
      f.emit({ method, params: { threadId: 'peer', turnId: 'turn-1' } });
      const deliveries = answerer.messages.length;
      f.reply(answer, { threadId: 'original', accepted: true, duplicate: false,
        question: { threadId: 'original', questionId: 'question', answer: {
          submissionId: 'submission', answers: answer.params.answers,
        } }, startedTurn: { id: 'turn-1', status: 'running' } });
      const detached = lifecycle.includes('disconnected');
      assert.equal(f.broker.threadOwners.get('original'), detached ? owner : answerer);
      assert.equal(f.broker.activeTurns.get('original')?.owner, detached ? undefined : answerer,
        'the peer completion cannot suppress the original answer admission');
      assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
        detached ? [{ threadId: 'original', turnId: 'turn-1' }] : []);
      if (lifecycle !== 'connected') assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
        'terminal reconciliation never replays the saved answer');
    });
  }
}

test('an unambiguous compatibility terminal reaches only its task, including shared viewers', t => {
  const f = fixture(t), owner = f.join('original'), viewer = f.join('original'), peer = f.join('peer');
  f.reply(f.send(owner, 'turn/start', { threadId: 'original' }), { turn: { id: 'original-turn' } });
  f.reply(f.send(peer, 'turn/start', { threadId: 'peer' }), { turn: { id: 'peer-turn' } });
  const peerCount = peer.messages.length;
  f.emit({ method: 'turn/completed', params: { turnId: 'original-turn' } });
  assert.equal(f.broker.activeTurns.has('original'), false);
  assert.equal(f.broker.activeTurns.get('peer').owner, peer);
  for (const client of [owner, viewer]) assert.deepEqual(client.messages.at(-1), {
    method: 'turn/completed', params: { turnId: 'original-turn', threadId: 'original' },
  });
  assert.equal(peer.messages.length, peerCount, 'a unique compatibility terminal is never broadcast to a peer');
});

test('a typed nested terminal task disambiguates equal turn IDs', t => {
  const f = fixture(t), first = f.join('first'), second = f.join('second');
  for (const [threadId, owner] of [['first', first], ['second', second]])
    f.reply(f.send(owner, 'turn/start', { threadId }), { turn: { id: 'turn-1' } });
  f.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', threadId: 'first', status: 'completed' } } });
  assert.equal(f.broker.activeTurns.has('first'), false);
  assert.equal(f.broker.activeTurns.get('second').owner, second);
  assert.equal(first.messages.at(-1).params.threadId, 'first');
  assert.equal(second.messages.at(-1).method, undefined, 'the peer receives no terminal notification');
});

for (const detached of [false, true]) test(`original interaction bindings disambiguate terminal routing without active turns (detached=${detached})`, t => {
  const f = fixture(t), first = f.join('first'), second = f.join('second');
  for (const [threadId, requestId] of [['first', 500], ['second', 600]])
    f.emit({ id: requestId, method: 'question/request', params: {
      threadId, turnId: 'turn-1', questionId: `question-${threadId}`, appServerEpoch: 'epoch',
    } });
  if (detached) f.broker.detach(first);
  const count = second.messages.length;
  f.emit({ method: 'turn/completed', params: { turnId: 'turn-1' } });
  assert.equal(f.broker.serverRequests.get(600), second, 'a live or retired peer binding prevents ambiguous completion');
  assert.equal(second.messages.length, count);
  f.emit({ method: 'turn/completed', params: { threadId: 'second', turnId: 'turn-1' } });
  assert.equal(f.broker.serverRequests.has(600), false, 'an explicit terminal still closes the original question');
});
