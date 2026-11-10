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
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches app-server`);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume', { threadId: 'original' });
    return { client, finish: () => reply(request, { thread: { id: 'original' } }) };
  };
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  return { broker, upstream, emit, send, reply, join };
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  test(`a conflicting terminal cannot suppress async answer ownership (${lifecycle})`, t => {
    const f = fixture(t), owner = f.join(); owner.finish();
    const answerer = f.join(); answerer.finish();
    const answer = f.send(answerer.client, 'asyncQuestion/answer', {
      threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'saved answer' } },
    });
    if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
    if (lifecycle.includes('disconnected')) f.broker.detach(answerer.client);
    const delivered = answerer.client.messages.length;
    f.emit({ method: 'turn/completed', params: {
      threadId: 'original', turnId: 'turn', turn: { id: 'turn', threadId: 'peer' },
    } });
    assert.equal(f.broker.pending.get(answer.id).asyncQuestionTerminalTurns?.has('turn') ?? false, false,
      'a conflicting task cannot consume the pending answer completion identity');
    f.reply(answer, { threadId: 'original', accepted: true, duplicate: false,
      question: { threadId: 'original', questionId: 'question', answer: {
        submissionId: 'submission', answers: answer.params.answers,
      } }, startedTurn: { id: 'turn', status: 'running' } });
    const detached = lifecycle.includes('disconnected');
    assert.equal(f.broker.threadOwners.get('original'), detached ? owner.client : answerer.client);
    assert.equal(f.broker.activeTurns.get('original')?.owner, detached ? undefined : answerer.client);
    assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
      detached ? [{ threadId: 'original', turnId: 'turn' }] : []);
    if (lifecycle !== 'connected') assert.equal(answerer.client.messages.length, delivered, 'late receipts are not redelivered');
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

const conflicts = [
  { thread_id: 'peer' }, { thread: { id: 'peer' } }, { thread: { threadId: 'peer' } },
  { widget: { threadId: 'peer' } }, { turn: { id: 'turn', threadId: 'peer' } },
  { turn_id: 'different-turn' }, { turn: { id: 'different-turn' } },
  { turn: { turnId: 'different-turn' } },
];

for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
  for (const conflict of conflicts) {
    for (const refreshing of [false, true]) {
      test(`${method} conflicting ${JSON.stringify(conflict)} preserves input (refreshing=${refreshing})`, t => {
        const f = fixture(t), owner = f.join(); owner.finish();
        f.reply(f.send(owner.client, 'turn/start', { threadId: 'original' }), { turn: { id: 'turn' } });
        const request = { id: 500, method: 'question/request', params: {
          threadId: 'original', turnId: 'turn', questionId: 'question', appServerEpoch: 'epoch',
          questions: [{ id: 'item', header: 'Choice', question: 'Choose?' }],
        } };
        f.emit(request);
        const viewer = f.join();
        if (!refreshing) viewer.finish();
        const counts = [owner.client.messages.length, viewer.client.messages.length];
        f.emit({ method, params: { threadId: 'original', turnId: 'turn', ...conflict } });
        assert.equal(f.broker.activeTurns.get('original')?.owner, owner.client,
          'a conflicting identity cannot certify completion');
        assert.equal(f.broker.serverRequests.get(500), owner.client, 'the original question remains answerable');
        assert.deepEqual([owner.client.messages.length, viewer.client.messages.length], counts,
          'neither client receives the ambiguous terminal');
        if (refreshing) {
          viewer.finish();
          assert.equal(viewer.client.messages.some(message => message.method === method), false,
            'refresh cannot replay a rejected terminal');
          assert.deepEqual(viewer.client.messages.at(-1), request, 'refresh still restores the original question');
        }
        f.emit({ method, params: { threadId: 'original', turnId: 'turn' } });
        assert.equal(f.broker.activeTurns.has('original'), false);
        assert.equal(f.broker.serverRequests.has(500), false);
        for (const client of [owner.client, viewer.client]) assert.equal(client.messages.at(-1).method, method,
          'the subsequent authoritative terminal reaches both clients');
        assert.equal(f.upstream.some(message => message.id === 500 || message.method === 'asyncQuestion/answer'), false,
          'recovery neither fabricates nor resubmits answers');
      });
    }
  }

  test(`${method} matching aliases retain compatibility`, t => {
    const f = fixture(t), owner = f.join(); owner.finish();
    f.reply(f.send(owner.client, 'turn/start', { threadId: 'original' }), { turn: { id: 'turn' } });
    f.emit({ id: 500, method: 'question/request', params: {
      threadId: 'original', turnId: 'turn', questionId: 'question',
    } });
    f.emit({ method, params: { threadId: 'original', thread_id: 'original', thread: { id: 'original', threadId: 'original' },
      widget: { threadId: 'original' }, turnId: 'turn', turn_id: 'turn', turn: { id: 'turn', turnId: 'turn', threadId: 'original' } } });
    assert.equal(f.broker.activeTurns.has('original'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(owner.client.messages.at(-1).method, method);
  });
}

const malformedIdentities = [
  { turnId: 42 }, { turnId: {} }, { turnId: '' }, { turnId: ' ' },
  { threadId: 42 }, { threadId: '' },
  { turn_id: false }, { turn: { id: 42 } }, { turn: { threadId: [] } },
];

for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
  for (const invalid of malformedIdentities) {
    for (const refreshing of [false, true]) {
      test(`${method} malformed ${JSON.stringify(invalid)} cannot end original input (refreshing=${refreshing})`, t => {
        const f = fixture(t), owner = f.join(); owner.finish();
        f.reply(f.send(owner.client, 'turn/start', { threadId: 'original' }), { turn: { id: 'turn' } });
        const request = { id: 500, method: 'question/request', params: {
          threadId: 'original', turnId: 'turn', questionId: 'question', appServerEpoch: 'epoch',
        } };
        f.emit(request);
        const viewer = f.join();
        if (!refreshing) viewer.finish();
        const counts = [owner.client.messages.length, viewer.client.messages.length];
        f.emit({ method, params: { threadId: 'original', turnId: 'turn', ...invalid } });
        assert.equal(f.broker.serverRequests.get(500), owner.client,
          'a malformed identity cannot be interpreted as a missing compatibility identity');
        assert.equal(f.broker.activeTurns.get('original')?.owner, owner.client);
        assert.deepEqual([owner.client.messages.length, viewer.client.messages.length], counts);
        if (refreshing) {
          viewer.finish();
          assert.deepEqual(viewer.client.messages.at(-1), request,
            'recovery must retain the original pending question');
          assert.equal(viewer.client.messages.some(message => message.method === method), false);
        }
        const writes = f.upstream.length;
        f.broker.receive(owner.client, JSON.stringify({ id: request.id, result: { answers: {} } }));
        assert.equal(f.upstream.length, writes + 1, 'the preserved original question can still be answered once');
        f.emit({ method, params: { threadId: 'original', turnId: 'turn' } });
        assert.equal(f.broker.activeTurns.has('original'), false);
        for (const client of [owner.client, viewer.client]) assert.equal(client.messages.at(-1).method, method);
      });
    }
  }
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  test(`malformed terminal cannot hide an async answer admission (${lifecycle})`, t => {
    const f = fixture(t), owner = f.join(); owner.finish();
    const answerer = f.join(); answerer.finish();
    const answer = f.send(answerer.client, 'asyncQuestion/answer', {
      threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'saved answer' } },
    });
    if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
    if (lifecycle.includes('disconnected')) f.broker.detach(answerer.client);
    f.emit({ method: 'turn/completed', params: { threadId: 'original', turnId: 42 } });
    assert.equal(f.broker.pending.get(answer.id).asyncQuestionTerminalUnknown, undefined,
      'invalid turn IDs cannot become a task-wide completion fence');
    f.reply(answer, { threadId: 'original', accepted: true, duplicate: false,
      question: { threadId: 'original', questionId: 'question', answer: {
        submissionId: 'submission', answers: answer.params.answers,
      } }, startedTurn: { id: 'answer-turn', status: 'running' } });
    const detached = lifecycle.includes('disconnected');
    assert.equal(f.broker.threadOwners.get('original'), detached ? owner.client : answerer.client);
    assert.equal(f.broker.activeTurns.get('original')?.owner, detached ? undefined : answerer.client);
    assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
      detached ? [{ threadId: 'original', turnId: 'answer-turn' }] : []);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const params of [
  { threadId: 'original' },
  { threadId: 'original', turnId: null },
  { turnId: 'turn' },
  { threadId: 'original', turnId: 'turn', turn_id: null, thread: null },
]) {
  test(`valid compatibility terminal ${JSON.stringify(params)} still ends its original question`, t => {
    const f = fixture(t), owner = f.join(); owner.finish();
    f.reply(f.send(owner.client, 'turn/start', { threadId: 'original' }), { turn: { id: 'turn' } });
    f.emit({ id: 500, method: 'question/request', params: {
      threadId: 'original', turnId: 'turn', questionId: 'question',
    } });
    f.emit({ method: 'turn/completed', params });
    assert.equal(f.broker.activeTurns.has('original'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(owner.client.messages.at(-1).method, 'turn/completed');
    assert.equal(f.upstream.some(message => message.id === 500), false);
  });
}
