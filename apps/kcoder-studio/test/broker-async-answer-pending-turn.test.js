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
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`;
    // Exercise the bounded JSONL decoder as well as response ownership routing.
    const middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle));
    child.stdout.write(line.slice(middle));
  };
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
    serverMessage({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), answerer = join();
  const answer = send(answerer, 'asyncQuestion/answer', { questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'answer' } } });
  const answerReceipt = () => serverMessage({ id: answer.id, result: {
    threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'question', answer: { submissionId: 'submission', answers: answer.params.answers } },
    startedTurn: { id: 'earlier-answer-turn', status: 'running' },
  } });
  const startLaterTurn = (client, confirm = true) => {
    const request = send(client, 'turn/start');
    const complete = () => serverMessage({ id: request.id, result: { turn: { id: 'current-turn', status: 'running' } } });
    if (confirm) complete();
    return complete;
  };
  return { broker, upstream, owner, answerer, startLaterTurn, answerReceipt, serverMessage };
}

for (const kind of ['question', 'approval']) {
  test(`a confirmed newer turn retains its ${kind} owner after an older answer receipt races admission`, t => {
    const f = fixture(t);
    const confirmStart = f.startLaterTurn(f.owner, false);
    f.answerReceipt();
    confirmStart();
    const field = kind === 'question' ? 'questionId' : 'approvalId';
    const request = { id: 500, method: `${kind}/request`, params: {
      threadId: 'thread', turnId: 'current-turn', [field]: 'current-interaction',
    } };
    f.serverMessage(request);
    assert.equal(f.broker.serverRequests.get(request.id), f.owner,
      'the confirmed input client, rather than the earlier answerer, must own the interaction');
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'current-turn', owner: f.owner });
    const before = f.upstream.length;
    f.broker.receive(f.answerer, JSON.stringify({ id: request.id,
      result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
    assert.equal(f.upstream.length, before, 'the previous answerer cannot answer the new client interaction');
    assert.equal(f.answerer.messages.at(-1).params.reason, 'not_original_client');
    f.broker.receive(f.owner, JSON.stringify({ id: request.id,
      result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
    assert.equal(f.upstream.length, before + 1);
    assert.equal(f.upstream.at(-1).result.turnId, 'current-turn');
    assert.equal(f.upstream.at(-1).result[field], 'current-interaction');
    f.broker.detach(f.owner);
    assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt')
      .map(message => message.params.turnId), ['current-turn']);
  });
}

test('a rejected newer admission preserves the earlier answer admission and its disconnect owner', t => {
  const f = fixture(t);
  f.startLaterTurn(f.owner, false);
  const start = f.upstream.at(-1);
  f.answerReceipt();
  f.serverMessage({ id: start.id, error: { code: -32003, message: 'already running' } });
  assert.equal(f.broker.threadOwners.get('thread'), f.answerer);
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'earlier-answer-turn', owner: f.answerer });
  f.broker.detach(f.answerer);
  assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt')
    .map(message => message.params.turnId), ['earlier-answer-turn']);
});

test('a newer admission confirmed after its input client disconnects cannot restore that client owner', t => {
  const f = fixture(t);
  const confirmStart = f.startLaterTurn(f.owner, false);
  f.broker.detach(f.owner);
  f.answerReceipt();
  confirmStart();
  assert.notEqual(f.broker.threadOwners.get('thread'), f.owner);
  assert.notEqual(f.broker.activeTurns.get('thread')?.owner, f.owner);
  assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt')
    .map(message => message.params.turnId), ['current-turn']);
});
