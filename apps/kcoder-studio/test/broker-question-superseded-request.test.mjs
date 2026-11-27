import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

function fixture(t, shared, admission) {
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
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    return { client, request: send(client, 'thread/resume', { threadId: 'thread' }) };
  };
  const join = () => { const joined = resume(); reply(joined.request, { thread: { id: 'thread' } }); return joined.client; };
  const owner = join(), viewer = shared ? join() : null;
  const turn = { threadId: 'thread', id: 'turn', attemptId: 'old', status: 'running' };
  reply(send(owner, 'turn/start', { threadId: 'thread' }), { turn });
  if (admission === 'answer') {
    const params = { threadId: 'thread', questionId: 'saved', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'Saved answer' } } };
    reply(send(owner, 'asyncQuestion/answer', params), {
      threadId: 'thread', accepted: true, duplicate: false, question: answeredAsyncQuestion(params),
      startedTurn: { ...turn, attemptId: 'new' },
    });
  } else {
    reply(send(owner, 'turn/start', { threadId: 'thread', retryFromTurnId: 'turn',
      retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'new' } });
  }
  const prompt = (kind, attemptId, nested = false, id = 500) => ({ id, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [`${kind}Id`]: `card-${id}`,
    ...(nested ? { turn: { attemptId } } : { attemptId }),
    ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
      : { availableDecisions: ['accept', 'decline'] }),
  } });
  return { broker, upstream, emit, send, reply, resume, owner, viewer, prompt };
}

for (const shared of [false, true]) {
  for (const admission of ['retry', 'answer']) {
    for (const kind of ['question', 'approval']) {
      for (const nested of [false, true]) {
        test(`${kind}: superseded request cannot reserve current input (${admission}, shared=${shared}, nested=${nested})`, t => {
          const f = fixture(t, shared, admission);
          const counts = [f.owner.messages.length, f.viewer?.messages.length, f.upstream.length];
          f.emit(f.prompt(kind, 'old', nested));
          assert.equal(f.broker.serverRequests.has(500), false, 'known superseded input cannot reserve a waiter');
          assert.deepEqual([f.owner.messages.length, f.viewer?.messages.length, f.upstream.length], counts,
            'stale input cannot open either card or reply to a potentially reused transport ID');
          f.emit(f.prompt(kind, 'new', nested));
          assert.equal(f.broker.serverRequests.get(500), f.owner, 'current attempt may use the same transport ID');
          const result = kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' };
          f.broker.receive(f.owner, JSON.stringify({ id: 500, result }));
          assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
          f.emit({ method: `${kind}/resolved`, params: { threadId: 'thread', turnId: 'turn',
            [`${kind}Id`]: 'card-500', requestId: 500, reason: 'client_response', attemptId: 'new' } });
          assert.equal(f.owner.messages.at(-1).method, `${kind}/resolved`);
          assert.equal(f.broker.activeTurns.get('thread').attemptId, 'new');
          assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
        });
      }
    }
  }
}

for (const admission of ['retry', 'answer']) {
  test(`${admission}: superseded questions cannot replay on resume`, t => {
    const f = fixture(t, true, admission), recovering = f.resume();
    const writes = f.upstream.length;
    for (let index = 0; index < 3; index++)
      f.emit(f.prompt('question', 'old', false, 500 + index));
    assert.equal(f.upstream.length, writes, 'no stale waiter is answered');
    f.reply(recovering.request, { thread: { id: 'thread' } });
    assert.ok(recovering.client.messages[0]?.result?.thread, 'the original task still resumes');
    assert.equal(recovering.client.messages.length, 1, 'rejoining cannot replay superseded questions');
    assert.equal(f.broker.serverRequests.size, 0);
  });
}

for (const attemptId of [undefined, null, 'new', 'not-yet-observed']) {
  test(`unproven or legacy attempt ${JSON.stringify(attemptId)} keeps existing admission`, t => {
    const f = fixture(t, true, 'retry');
    f.emit(f.prompt('question', attemptId));
    assert.equal(f.broker.serverRequests.get(500), f.owner,
      'only an attempt already superseded by a confirmed admission is rejected');
  });
}
