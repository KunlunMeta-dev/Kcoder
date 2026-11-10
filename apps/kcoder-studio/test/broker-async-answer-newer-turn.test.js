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
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    assert.ok(upstream.length > before, `${method} must reach the backend`);
    return upstream.at(-1);
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume');
    broker.routeServerMessage({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), answerer = join();
  const answer = send(answerer, 'asyncQuestion/answer', { questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'answer' } } });
  const answerReceipt = () => broker.routeServerMessage({ id: answer.id, result: {
    threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'question', answer: { submissionId: 'submission', answers: answer.params.answers } },
    startedTurn: { id: 'earlier-answer-turn', status: 'running' },
  } });
  const startLaterTurn = client => {
    const request = send(client, 'turn/start');
    broker.routeServerMessage({ id: request.id, result: { turn: { id: 'current-turn', status: 'running' } } });
  };
  return { broker, upstream, owner, answerer, startLaterTurn, answerReceipt };
}

for (const sameDevice of [false, true]) {
  test(`a late answer receipt preserves the ${sameDevice ? 'answering' : 'peer'} device's current turn and disconnect cleanup`, t => {
    const f = fixture(t);
    const currentOwner = sameDevice ? f.answerer : f.owner;
    f.startLaterTurn(currentOwner);
    f.answerReceipt();
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'current-turn', owner: currentOwner });
    assert.equal(f.broker.threadOwners.get('thread'), currentOwner);
    assert.equal(f.answerer.messages.at(-1).result?.accepted, true, 'the original answer receipt is still delivered');
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'current-turn', questionId: 'current-question',
    } };
    f.broker.routeServerMessage(request);
    assert.equal(f.broker.serverRequests.get(request.id), currentOwner, 'the current input client owns its next question');
    const beforeReply = f.upstream.length;
    f.broker.receive(currentOwner, JSON.stringify({ id: request.id,
      result: { answers: { choice: { answers: ['yes'] } } } }));
    assert.equal(f.upstream.length, beforeReply + 1, 'the current client can answer its own question');
    assert.equal(f.upstream.at(-1).result.turnId, 'current-turn');
    assert.equal(f.upstream.at(-1).result.questionId, 'current-question');
    f.broker.detach(currentOwner);
    const interrupted = f.upstream.filter(message => message.method === 'turn/interrupt');
    assert.deepEqual(interrupted.map(message => message.params.turnId), ['current-turn']);
  });
}

test('a disconnected answerer late receipt cannot put a peer current turn into an obsolete drain', t => {
  const f = fixture(t);
  f.broker.detach(f.answerer);
  f.startLaterTurn(f.owner);
  f.answerReceipt();
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'current-turn', owner: f.owner });
  assert.equal(f.broker.threadDrains.has('thread'), false);
  assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params.turnId),
    ['earlier-answer-turn'], 'only the disconnected client admission is cancelled');
  f.broker.detach(f.owner);
  assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params.turnId),
    ['earlier-answer-turn', 'current-turn']);
});
