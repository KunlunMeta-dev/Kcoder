import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime });
    return value;
  };
  const send = (peer, method, params = { threadId: 'thread' }) => {
    const id = ++sequence;
    broker.receive(peer, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  };
  const respond = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = peer => {
    send(peer, 'thread/resume');
    const request = upstream.at(-1);
    respond({ id: request.id, result: { thread: { id: 'thread' } } });
  };
  const controller = client(); resume(controller);
  const reader = shared ? client() : controller;
  if (shared) resume(reader);
  return { broker, upstream, client, send, respond, controller, reader };
}

for (const lifetime of [false, true]) {
  for (const shared of [false, true]) {
    const mode = `${shared ? 'shared viewer' : 'exclusive owner'} (sessionLifetimeV1=${lifetime})`;
    for (const timedOut of [false, true]) {
      test(`${mode}: question refresh reaches the original task during drain (timedOut=${timedOut})`, t => {
        const f = fixture(t, shared, lifetime);
        f.broker.activeTurns.set('thread', { turnId: 'ending-turn', owner: f.controller });
        f.broker.beginThreadDrain('thread', 'ending-turn');
        if (timedOut) f.broker.finishThreadDrain('thread', false);
        const before = f.upstream.length;
        const id = f.send(f.reader, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
        assert.equal(f.upstream.length, before + 1, 'refresh must not wait for an ending turn or fail with -32043');
        const request = f.upstream.at(-1);
        assert.equal(request.method, 'asyncQuestion/list');
        assert.deepEqual(request.params, { threadId: 'thread', includeTerminal: true });
        const result = { threadId: 'thread', questions: [{ threadId: 'thread', questionId: 'original-question' }] };
        f.respond({ id: request.id, result });
        assert.deepEqual(f.reader.messages.at(-1), { id, result });
        assert.equal(f.broker.threadDrains.get('thread').queue.length, 0);
        assert.equal(f.broker.activeTurns.get('thread').turnId, 'ending-turn');
        assert.equal(f.broker.threadOwners.get('thread'), f.controller);
        assert.equal(f.upstream.slice(before).some(message => message.method !== 'asyncQuestion/list'), false);
      });
    }

    test(`${mode}: refresh admission still requires the original subscription and capability during drain`, t => {
      const f = fixture(t, shared, lifetime), stranger = f.client();
      f.broker.beginThreadDrain('thread', 'ending-turn');
      f.broker.finishThreadDrain('thread', false);
      const before = f.upstream.length;
      f.send(stranger, 'asyncQuestion/list');
      assert.equal(stranger.messages.at(-1).error?.code, -32023);
      f.reader.asyncUserQuestionsV1 = false;
      f.send(f.reader, 'asyncQuestion/list');
      assert.equal(f.reader.messages.at(-1).error?.code, -32602);
      f.reader.asyncUserQuestionsV1 = true;
      f.send(f.reader, 'asyncQuestion/list', { threadId: 'foreign-thread' });
      assert.equal(f.reader.messages.at(-1).error?.code, -32023);
      assert.equal(f.upstream.length, before);
    });

    for (const method of ['asyncQuestion/answer', 'asyncQuestion/cancel', 'turn/start', 'thread/resume']) {
      test(`${mode}: ${method} remains fenced until the exact draining turn ends`, async t => {
        const f = fixture(t, shared, lifetime);
        f.broker.beginThreadDrain('thread', 'ending-turn');
        const before = f.upstream.length;
        const params = { threadId: 'thread', questionId: 'question', expectedRevision: 1,
          submissionId: 'submission', answers: { item: { text: 'answer' } } };
        const queuedId = f.send(f.reader, method, params);
        assert.equal(f.upstream.length, before);
        assert.equal(f.broker.threadDrains.get('thread').queue.length, 1);
        f.broker.finishThreadDrain('thread', false);
        assert.equal(f.reader.messages.at(-1).id, queuedId);
        assert.equal(f.reader.messages.at(-1).error?.code, -32043);
        f.send(f.reader, method, params);
        assert.equal(f.reader.messages.at(-1).error?.code, -32043);
        f.respond({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'unrelated-turn' } });
        assert.equal(f.broker.threadDrains.has('thread'), true);
        assert.equal(f.upstream.length, before);
        f.respond({ method: 'turn/interrupted', params: { threadId: 'thread', turnId: 'ending-turn' } });
        assert.equal(f.broker.threadDrains.has('thread'), false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.upstream.length, before, 'a rejected mutation is never automatically replayed');
      });
    }
  }
}

for (const attemptId of ['current-attempt', undefined]) {
  test(`a stale retry terminal cannot release a queued answer before the original drain (${attemptId ?? 'legacy terminal'})`, async t => {
    const f = fixture(t, true, false);
    const threadId = 'thread', turnId = 'ending-turn';
    f.send(f.controller, 'turn/start');
    f.respond({ id: f.upstream.at(-1).id, result: {
      turn: { threadId, id: turnId, attemptId: 'current-attempt', status: 'running' },
    } });
    assert.equal(f.broker.activeTurns.get(threadId)?.attemptId, 'current-attempt');
    f.broker.detach(f.controller);
    assert.equal(f.upstream.at(-1).method, 'turn/interrupt');
    assert.equal(f.broker.threadOwners.get(threadId), f.reader);
    f.send(f.reader, 'asyncQuestion/answer', {
      threadId, questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers: { item: { text: 'answer' } },
    });
    assert.equal(f.broker.threadDrains.get(threadId)?.queue.length, 1);
    const emitTerminal = attempt => f.respond({ method: 'turn/interrupted',
      params: { threadId, turnId, attemptId: attempt } });
    const delivered = f.reader.messages.length;
    emitTerminal('old-attempt');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 0,
      'a different attempt cannot admit the queued answer');
    assert.equal(f.broker.threadDrains.get(threadId)?.queue.length, 1);
    assert.equal(f.reader.messages.length, delivered, 'a stale terminal cannot settle the original view');

    emitTerminal(attemptId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.broker.threadDrains.has(threadId), false);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.at(-1).params.submissionId, 'submission');
  });
}

test('a stalled question refresh releases its owner at the read deadline without expiring an answer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, true, true);
  const threadId = 'thread';
  const refreshId = f.send(f.reader, 'asyncQuestion/list', { threadId, includeTerminal: true });
  const expiredRead = f.upstream.at(-1);
  const answerId = f.send(f.controller, 'asyncQuestion/answer', {
    threadId, questionId: 'original-question', expectedRevision: 1,
    submissionId: 'submission', answers: { item: { text: 'answer' } },
  });
  const pendingAnswer = f.upstream.at(-1);
  assert.equal(pendingAnswer.method, 'asyncQuestion/answer');
  t.mock.timers.tick(29_999);
  assert.equal(f.broker.pending.get(expiredRead.id)?.client, f.reader);
  t.mock.timers.tick(1);
  assert.equal(f.reader.messages.at(-1).id, refreshId);
  assert.equal(f.reader.messages.at(-1).error?.data?.outcome, 'unknown');
  assert.equal(f.broker.pending.has(expiredRead.id), false);
  assert.equal(f.broker.pending.get(pendingAnswer.id)?.client, f.controller);
  assert.equal(f.controller.messages.some(message => message.id === answerId), false);

  const newReadId = f.send(f.reader, 'asyncQuestion/list', { threadId, includeTerminal: true });
  const newRead = f.upstream.at(-1);
  const snapshot = { threadId, questions: [] };
  f.respond({ id: newRead.id, result: snapshot });
  f.respond({ id: expiredRead.id, result: {
    threadId, questions: [{ threadId, questionId: 'original-question' }],
  } });
  assert.deepEqual(f.reader.messages.at(-1), { id: newReadId, result: snapshot });
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
});

for (const mode of ['throw', 'unqueued', 'queued backpressure']) {
  test(`drain deadline settles the peer's question request after ${mode}`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, true, false);
    const threadId = 'thread';
    f.broker.beginThreadDrain(threadId, 'ending-turn');
    const before = f.upstream.length;
    const params = { threadId, questionId: 'question', expectedRevision: 1 };
    const answer = f.send(f.reader, 'asyncQuestion/answer', {
      ...params, submissionId: 'submission', answers: { item: { text: 'answer' } },
    });
    const cancel = f.send(f.controller, 'asyncQuestion/cancel', params);
    if (mode === 'throw') {
      f.reader.send = () => { throw new Error('question socket write failed'); };
    } else {
      const queued = mode === 'queued backpressure';
      f.reader.sendWithQueueStatus = message => {
        if (queued) f.reader.messages.push(message);
        return { queued, writable: false };
      };
      f.reader.send = message => f.reader.sendWithQueueStatus(message).writable;
    }
    t.mock.timers.tick(15_000);

    assert.equal(f.broker.closed, false);
    assert.equal(f.broker.clients.has(f.reader), mode === 'queued backpressure');
    if (mode === 'queued backpressure') {
      assert.equal(f.reader.messages.at(-1).id, answer);
      assert.equal(f.reader.messages.at(-1).error?.code, -32043);
    }
    assert.equal(f.controller.messages.at(-1).id, cancel);
    assert.equal(f.controller.messages.at(-1).error?.code, -32043);
    assert.deepEqual(f.upstream.slice(before), []);
    const refresh = f.send(f.controller, 'asyncQuestion/list');
    f.respond({ id: f.upstream.at(-1).id, result: { threadId, questions: [] } });
    assert.deepEqual(f.controller.messages.at(-1), { id: refresh, result: { threadId, questions: [] } });
  });
}
