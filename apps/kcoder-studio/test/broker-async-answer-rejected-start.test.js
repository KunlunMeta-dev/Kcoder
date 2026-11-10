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
    const middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle));
    child.stdout.write(line.slice(middle));
  };
  let sequence = 0;
  const send = (client, method, params = {}) => {
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
    const resume = send(client, 'thread/resume');
    serverMessage({ id: resume.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const original = join(), answerer = join();
  const answer = send(answerer, 'asyncQuestion/answer', { questionId: 'saved-question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'answer' } } });
  const start = send(answerer, 'turn/start');
  const acceptAnswer = () => serverMessage({ id: answer.id, result: {
    threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'saved-question', answer: { submissionId: 'submission', answers: answer.params.answers } },
    startedTurn: { id: 'answer-turn', status: 'running' },
  } });
  const rejectStart = () => serverMessage({ id: start.id, error: { code: -32003, message: 'already running' } });
  return { broker, upstream, serverMessage, original, answerer, acceptAnswer, rejectStart };
}

for (const kind of ['question', 'approval']) {
  for (const order of ['answer first', 'rejection first']) {
    test(`${kind}: ${order} preserves the answerer's interaction owner after its competing start is rejected`, t => {
      const f = fixture(t);
      if (order === 'answer first') { f.acceptAnswer(); f.rejectStart(); }
      else { f.rejectStart(); f.acceptAnswer(); }
      assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: f.answerer });
      assert.equal(f.broker.threadOwners.get('thread'), f.answerer,
        'a rejected reservation must not undo a confirmed answer admission by the same client');
      const field = kind === 'question' ? 'questionId' : 'approvalId';
      const request = { id: 500, method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'answer-turn', [field]: 'answer-interaction',
      } };
      f.serverMessage(request);
      assert.equal(f.broker.serverRequests.get(request.id), f.answerer);
      const result = kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' };
      const before = f.upstream.length;
      f.broker.receive(f.original, JSON.stringify({ id: request.id, result }));
      assert.equal(f.upstream.length, before, 'the original viewer cannot answer the admitted client question');
      assert.equal(f.original.messages.at(-1).params.reason, 'not_original_client');
      f.broker.receive(f.answerer, JSON.stringify({ id: request.id, result }));
      assert.equal(f.upstream.length, before + 1);
      assert.equal(f.upstream.at(-1).result.turnId, 'answer-turn');
      assert.equal(f.upstream.at(-1).result[field], 'answer-interaction');
      f.broker.detach(f.answerer);
      assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt')
        .map(message => message.params.turnId), ['answer-turn']);
    });
  }
}
