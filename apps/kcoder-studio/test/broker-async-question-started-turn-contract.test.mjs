import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { isContract } from '../shared/generated/validator.mjs';

function fixture(t, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
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
  const owner = join(), answerer = join();
  const question = { threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
    toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
    questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
    answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'Original answer' } } } };
  const request = send(answerer, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
    expectedRevision: 1, submissionId: 'submission', answers: question.answer.answers });
  const result = startedTurn => ({ threadId: 'thread', accepted: true, duplicate: false, question, startedTurn });
  return { broker, upstream, send, reply, owner, answerer, question, request, result };
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired-disconnected']) {
    for (const field of ['requestId', 'sourceTurnId', 'toolCallId', 'revision', 'createdAtMs', 'status', 'questions']) {
      test(`full answer receipt missing ${field} cannot certify execution (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime);
        if (lifecycle.includes('expired')) f.broker.expireRequest(f.request.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
        const deliveries = f.answerer.messages.length;
        const result = f.result({ threadId: 'thread', id: 'answer-turn', status: 'running' });
        result.question = { ...result.question };
        delete result.question[field];
        assert.equal(isContract('AsyncQuestionAnswerResult', result), false);
        f.reply(f.request, result);
        assert.equal(f.broker.threadOwners.get('thread'), f.owner);
        assert.equal(f.broker.activeTurns.size, 0);
        assert.equal(f.broker.threadDrains.size, 0);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'a client-rejected receipt cannot authorize disconnect cleanup');
        if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
        else assert.equal(f.answerer.messages.length, deliveries);
        f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [f.question],
        });
        assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      });
    }
  }
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const memorySnapshotId of [7, {}, '\ud800']) {
      test(`invalid answer turn snapshot ${JSON.stringify(memorySnapshotId)} cannot confirm execution (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime);
        if (lifecycle.includes('expired')) f.broker.expireRequest(f.request.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
        const deliveries = f.answerer.messages.length;
        const result = f.result({ threadId: 'thread', id: 'answer-turn', status: 'running', memorySnapshotId });
        assert.equal(isContract('AsyncQuestionAnswerResult', result), false,
          'the actual client contract rejects this complete receipt');
        f.reply(f.request, result);
        assert.equal(f.broker.threadOwners.get('thread'), f.owner, 'unconfirmed execution cannot transfer control');
        assert.equal(f.broker.activeTurns.size, 0, 'unconfirmed execution cannot become active');
        assert.equal(f.broker.threadDrains.size, 0, 'unconfirmed execution cannot block recovery');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'a client-rejected receipt cannot authorize disconnect cleanup');
        if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
        else assert.equal(f.answerer.messages.length, deliveries, 'late receipts are not redelivered');
        f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [f.question],
        });
        assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'readback never replays the saved answer');
      });
    }
  }
}

for (const locator of [{}, { threadId: 'thread' }, { turnId: 'answer-turn' },
  { threadId: 'thread', turnId: 'answer-turn' }]) {
  test(`a bound legacy answer turn reaches clients in canonical form (${JSON.stringify(locator)})`, t => {
    const f = fixture(t, true);
    const startedTurn = { id: 'answer-turn', status: 'running', memorySnapshotId: '原快照-😀' };
    f.reply(f.request, f.result({ ...startedTurn, ...locator }));
    const result = f.answerer.messages.at(-1).result;
    assert.equal(isContract('AsyncQuestionAnswerResult', result), true,
      'the actual client contract can consume the accepted answer');
    assert.deepEqual(result, f.result({ ...startedTurn, threadId: 'thread' }));
    assert.equal(f.broker.threadOwners.get('thread'), f.answerer);
    assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'answer-turn');
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const memorySnapshotId of [undefined, null]) {
  test(`a canonical answer turn preserves optional snapshot ${JSON.stringify(memorySnapshotId)}`, t => {
    const f = fixture(t, true);
    const result = f.result({ id: 'answer-turn', threadId: 'thread', status: 'running', memorySnapshotId });
    f.reply(f.request, result);
    assert.deepEqual(f.answerer.messages.at(-1).result, JSON.parse(JSON.stringify(result)));
    assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'answer-turn');
  });
}

for (const status of [undefined, null, 'unknown']) {
  test(`unusable explicit answer turn status ${JSON.stringify(status)} returns outcome unknown`, t => {
    const f = fixture(t, true);
    f.reply(f.request, f.result({ threadId: 'thread', id: 'answer-turn', status }));
    assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.equal(f.broker.activeTurns.size, 0);
  });
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    test(`unknown nested turn fields cannot certify answer execution (${lifecycle}, lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime);
      if (lifecycle.includes('expired')) f.broker.expireRequest(f.request.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
      const deliveries = f.answerer.messages.length;
      const result = f.result({ id: 'answer-turn', status: 'running', obsoleteDelivery: false });
      assert.equal(isContract('AsyncQuestionAnswerResult', result), false,
        'both clients reject the complete receipt with this nested field');
      f.reply(f.request, result);
      assert.equal(f.broker.threadOwners.get('thread'), f.owner,
        'a client-rejected turn cannot transfer task control');
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
        'a client-rejected turn cannot authorize disconnect cleanup');
      if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
      else assert.equal(f.answerer.messages.length, deliveries);
      f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
        threadId: 'thread', questions: [f.question],
      });
      assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
        'original-task readback never replays the saved answer');
    });
  }
}

for (const status of ['cancelled', 'stale', 'delivery_failed', 'delivery_unknown', 'context_applied']) {
  const settled = ['delivery_failed', 'delivery_unknown'].includes(status)
    ? { status, deliveryError: 'Delivery was not confirmed' } : { status };
  for (const disconnected of [false, true]) {
    test(`a ${status} answer cannot certify a new turn (disconnected=${disconnected})`, t => {
      const f = fixture(t, false);
      if (disconnected) f.broker.detach(f.answerer);
      const result = f.result({ id: 'answer-turn', status: 'running' });
      const terminal = { ...f.question, ...settled, revision: 3 };
      f.reply(f.request, { ...result, question: terminal });

      assert.equal(f.broker.threadOwners.get('thread'), f.owner);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      if (!disconnected) assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
      f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), {
        threadId: 'thread', questions: [terminal],
      });
      assert.deepEqual(f.owner.messages.at(-1).result.questions, [terminal]);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }

  test(`an exact retry can still report the saved ${status} answer`, t => {
    const f = fixture(t, false);
    const result = { threadId: 'thread', accepted: true, duplicate: true,
      question: { ...f.question, ...settled, revision: 3 } };
    f.reply(f.request, result);
    assert.deepEqual(f.answerer.messages.at(-1).result, result);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.equal(f.broker.activeTurns.size, 0);
  });
}

for (const status of ['completed', 'interrupted', 'failed']) {
  test(`terminal startedTurn status ${status} requires original-task readback`, t => {
    const f = fixture(t, true);
    const result = f.result({ id: 'answer-turn', threadId: 'thread', status });
    assert.equal(isContract('AsyncQuestionAnswerResult', result), true,
      'the generic Turn schema permits terminal snapshots');
    f.reply(f.request, result);
    assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);

    const read = f.send(f.answerer, 'asyncQuestion/list', { threadId: 'thread' });
    f.reply(read, { threadId: 'thread', questions: [f.question] });
    assert.deepEqual(f.answerer.messages.at(-1).result.questions, [f.question]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}
