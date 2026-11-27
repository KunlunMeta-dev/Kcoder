import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';
import { RESUME_NOTIFICATION_BUFFER_LIMITS as LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, admission) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: true,
  } } } };
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
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    return { client, request: send(client, 'thread/resume', { threadId: 'thread' }) };
  };
  const join = () => { const joined = resume(); reply(joined.request, { thread: { id: 'thread' } }); return joined.client; };
  const owner = join(), peer = join();
  const turn = { id: 'turn', threadId: 'thread', attemptId: 'old', status: 'running' };
  reply(send(owner, 'turn/start', { threadId: 'thread' }), { turn });
  if (admission === 'answer') {
    const params = { threadId: 'thread', questionId: 'saved', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'Saved answer' } } };
    reply(send(peer, 'asyncQuestion/answer', params), {
      threadId: 'thread', accepted: true, duplicate: false,
      question: answeredAsyncQuestion(params),
      startedTurn: { ...turn, attemptId: 'new' },
    });
  } else {
    reply(send(owner, 'turn/start', { threadId: 'thread', retryFromTurnId: 'turn',
      retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'new' } });
  }
  const controller = admission === 'answer' ? peer : owner;
  const started = (attemptId, sequence) => ({ method: 'turn/started', params: {
    serverId: 'server-current', threadId: 'thread', turnId: 'turn', sequence,
    turn: { ...turn, attemptId },
  } });
  const completeAndAnswer = () => {
    emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
      questionId: 'current-question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] } });
    assert.equal(broker.serverRequests.get(500), controller, 'current input keeps its actual answerer');
    broker.receive(controller, JSON.stringify({ id: 500, result: { answers: { choice: { answers: ['Continue'] } } } }));
    assert.equal(upstream.filter(message => message.id === 500 && message.result).length, 1);
    emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
      turn: { ...turn, attemptId: 'new', status: 'completed' } } });
    assert.equal(broker.activeTurns.size, 0);
    assert.equal(broker.serverRequests.size, 0, 'the real terminal settles input');
    assert.equal(upstream.some(message => message.method === 'turn/interrupt'), false);
  };
  return { broker, emit, reply, resume, owner, peer, controller, started, completeAndAnswer };
}

for (const admission of ['answer', 'retry']) {
  test(`${admission}: a superseded start cannot rebind either client's current question attempt`, t => {
    const f = fixture(t, admission), counts = [f.owner.messages.length, f.peer.messages.length];
    f.emit(f.started('old', 10));
    assert.deepEqual([f.owner.messages.length, f.peer.messages.length], counts,
      'a known superseded start cannot replace the attempt consumed by the clients');
    const current = f.started('new', 11);
    f.emit(current);
    for (const client of [f.owner, f.peer]) assert.deepEqual(client.messages.at(-1), current);
    assert.equal(f.broker.activeTurns.get('thread').attemptId, 'new');
    f.completeAndAnswer();
  });

  test(`${admission}: superseded starts cannot exhaust original-question resume capacity`, t => {
    const f = fixture(t, admission), recovering = f.resume();
    for (let sequence = 0; sequence <= LIMITS.perPendingFrames; sequence++) f.emit(f.started('old', sequence));
    const current = f.started('new', 100);
    f.emit(current);
    f.reply(recovering.request, { thread: { id: 'thread' } });
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'known superseded starts cannot turn successful resume into -32047');
    assert.deepEqual(recovering.client.messages.slice(1), [current]);
    assert.equal(f.broker.threadOwners.get('thread'), f.controller);
    f.completeAndAnswer();
  });
}
