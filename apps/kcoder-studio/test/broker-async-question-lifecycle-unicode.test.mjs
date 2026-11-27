import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

function fixture(t, shared = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
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
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume', { threadId: 'thread' });
    return { client, finish: () => reply(request, { thread: { id: 'thread' } }) };
  };
  return { broker, upstream, emit, send, reply, resume };
}

for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
  for (const nested of [false, true]) {
    test(`${method}: invalid ${nested ? 'nested' : 'top-level'} attempt cannot close original input during async answering`, t => {
      const f = fixture(t), owner = f.resume(), answerer = f.resume();
      owner.finish(); answerer.finish();
      const turn = { threadId: 'thread', id: 'turn', attemptId: 'original', status: 'running' };
      f.reply(f.send(owner.client, 'turn/start', { threadId: 'thread' }), { turn });
      f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
        questionId: 'ordinary',
        questions: [{ id: 'ordinary-item', prompt: 'Continue the original task?', options: [], allowsFreeform: true }] } });
      assert.equal(f.broker.serverRequests.get(500), owner.client, 'the original question is pending before the invalid terminal');
      const answer = f.send(answerer.client, 'asyncQuestion/answer', { threadId: 'thread',
        questionId: 'saved', submissionId: 'submission', expectedRevision: 1,
        answers: { item: { text: 'original answer' } } });
      const active = f.broker.activeTurns.get('thread'), deliveries = owner.client.messages.length;
      f.emit({ method, params: { threadId: 'thread', turnId: 'turn',
        ...(nested ? { turn: { ...turn, status: 'completed', attemptId: '\ud800' } } : { attemptId: '\udfff' }) } });
      assert.equal(f.broker.activeTurns.get('thread'), active, 'an impossible Rust attempt cannot finish the original execution');
      assert.equal(f.broker.serverRequests.get(500), owner.client, 'the original input retains its answerer');
      assert.equal(owner.client.messages.length, deliveries, 'invalid lifecycle is not projected to a card');
      f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
        turn: { ...turn, status: 'completed' } } });
      assert.equal(f.broker.activeTurns.has('thread'), false);
      assert.equal(f.broker.serverRequests.has(500), false, 'the real terminal still closes input');
      f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
        question: {
          requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
          questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'saved', status: 'queued', revision: 2,
          answer: { submissionId: 'submission', acceptedAtMs: 2, answers: answer.params.answers } },
        startedTurn: { id: 'next-turn', status: 'running', attemptId: '新尝试-😀' } });
      assert.equal(f.broker.activeTurns.get('thread')?.owner, answerer.client,
        'the real asynchronous admission remains usable');
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: invalid lifecycle attempts cannot exhaust original-task recovery`, t => {
    const f = fixture(t, shared), recovering = f.resume();
    for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++) {
      f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: `invalid-${sequence}`,
        attemptId: '\ud800', sequence } });
    }
    const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread', question: {
      threadId: 'thread', questionId: 'saved', revision: 1 } } };
    const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: 'real',
      attemptId: '新尝试-😀', sequence: 500 } };
    f.emit(changed); f.emit(terminal); recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'unsavable lifecycle identities cannot turn resume into -32047');
    assert.deepEqual(recovering.client.messages.slice(1), [changed, terminal]);
    assert.ok(f.upstream.every(message => ['thread/resume', 'thread/attach'].includes(message.method)),
      'recovery never resubmits an answer or interrupts a task');
  });
}

test('valid Unicode and optional legacy attempts retain original lifecycle delivery', t => {
  const f = fixture(t), owner = f.resume();
  owner.finish();
  const notifications = [];
  for (const attemptId of [undefined, null, '新尝试-😀']) {
    for (const method of ['turn/started', 'turn/completed']) {
      const notification = { method, params: { threadId: 'thread', turnId: 'turn',
        ...(attemptId === undefined ? {} : { attemptId }) } };
      f.emit(notification);
      notifications.push(notification);
    }
  }
  assert.deepEqual(owner.client.messages.slice(1), notifications);
});

// Turn locators are Rust strings too, independently of optional attempt IDs.
for (const shared of [false, true]) {
  for (const nested of [false, true]) {
    test(`${shared ? 'shared' : 'exclusive'}: invalid ${nested ? 'nested' : 'top-level'} turn IDs cannot block question recovery`, t => {
      const f = fixture(t, shared), recovering = f.resume();
      for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++) {
        f.emit({ method: 'turn/completed', params: { threadId: 'thread',
          ...(nested ? { turn: { id: '\ud800' } } : { turnId: '\udfff' }), sequence } });
      }
      const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread', question: {
        threadId: 'thread', questionId: 'saved', revision: 1 } } };
      const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: '原轮次-😀' } };
      f.emit(changed); f.emit(terminal); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread,
        'impossible turn locators cannot exhaust recovery and replace resume with -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [changed, terminal]);
      assert.ok(f.upstream.every(message => ['thread/resume', 'thread/attach'].includes(message.method)),
        'question recovery remains read-only without answer replay or task interruption');
    });
  }
}

for (const [name, locator] of [
  ['threadId', { threadId: '\ud800' }],
  ['turnId', { turnId: '\ud800' }],
]) {
  test(`invalid original question locator ${name} does not reserve its transport waiter`, t => {
    const f = fixture(t), owner = f.resume(); owner.finish();
    const request = { id: 700, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'question',
      questions: [{ id: 'item', prompt: 'Continue the original task?', options: [], allowsFreeform: true }] } };
    const before = owner.client.messages.length;
    f.emit({ ...request, params: { ...request.params, ...locator } });
    assert.equal(owner.client.messages.length, before, 'unusable original bindings cannot display a question');
    assert.equal(f.broker.serverRequests.has(request.id), false, 'invalid input cannot consume its transport identity');
    f.emit(request);
    assert.equal(f.broker.serverRequests.get(request.id), owner.client, 'the corrected original question stays answerable');
    assert.deepEqual(owner.client.messages.at(-1), request);
  });
}

for (const method of ['turn/completed', 'turn/interrupted']) {
  test(`${method} with an attempt but no turn ID cannot fence an in-flight answer`, t => {
    const f = fixture(t), owner = f.resume(), answerer = f.resume();
    owner.finish(); answerer.finish();
    const answer = f.send(answerer.client, 'asyncQuestion/answer', { threadId: 'thread',
      questionId: 'saved', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'original answer' } } });
    const turn = { threadId: 'thread', id: 'answer-turn', attemptId: 'answer-attempt', status: 'running' };
    f.emit({ method, params: { threadId: 'thread', attemptId: 'unrelated-attempt' } });
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
      question: answeredAsyncQuestion(answer.params), startedTurn: turn });
    assert.equal(answerer.client.messages.at(-1).result?.accepted, true);
    assert.equal(f.broker.activeTurns.get('thread')?.owner, answerer.client,
      'an unbound attempt must not suppress the confirmed answer turn');
    f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
      attemptId: turn.attemptId, questionId: 'follow-up' } });
    assert.equal(f.broker.serverRequests.get(500), answerer.client);
    const terminal = { method: 'turn/completed',
      params: { threadId: 'thread', turnId: turn.id, turn: { ...turn, status: 'interrupted' } } };
    f.emit(terminal);
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.deepEqual(owner.client.messages.at(-1), terminal);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}
