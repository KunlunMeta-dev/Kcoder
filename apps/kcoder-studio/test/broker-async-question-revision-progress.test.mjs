import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { compactRequestParams } from '../src/broker-request-budget.js';

function fixture(t, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
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
  return { broker, upstream, send, reply, join };
}

// State increments the revision when it accepts the first answer. Exact retries
// are different: they return the saved winner before comparing expectedRevision.
for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const revision of [2, 3, 4]) {
      test(`first answer from a non-pending revision cannot certify saved revision ${revision} (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), answerer = f.join();
        const answer = f.send(answerer, 'asyncQuestion/answer', {
          threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 3,
          answers: { item: { text: 'saved answer' } },
        });
        if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        const question = {
          requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
          questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question', revision, status: 'queued',
          answer: { acceptedAtMs: 2, submissionId: 'submission', answers: answer.params.answers } };
        f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false,
          startedTurn: { id: 'answer-turn', status: 'running' } });
        assert.equal(f.broker.threadOwners.get('thread'), original,
          'a first-save receipt for a non-pending revision cannot transfer task control');
        assert.equal(f.broker.activeTurns.size, 0, 'a first-save receipt for a non-pending revision cannot certify execution');
        assert.equal(f.broker.threadDrains.size, 0, 'an inconsistent receipt cannot block task recovery');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'disconnect cleanup requires a consistent saved-answer revision');
        if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
        else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
        const saved = { ...question, revision: 2 };
        f.reply(f.send(original, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [saved],
        });
        assert.deepEqual(original.messages.at(-1).result.questions, [saved]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'readback never repeats the submitted answer');
      });
    }
  }
}

for (const [name, revision, duplicate] of [
  ['first saved answer', 2, false],
  ['exact retry can start delivery at the saved revision', 2, true],
  ['omitted revision cannot certify admission', undefined, false],
]) {
  test(`${name} preserves answer admission after repeated compaction`, t => {
    const f = fixture(t, false), original = f.join(), answerer = f.join();
    const answer = f.send(answerer, 'asyncQuestion/answer', {
      threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: duplicate ? 2 : 1,
      answers: { item: { text: 'saved answer' } },
    });
    f.broker.expireRequest(answer.id);
    f.broker.detach(answerer);
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate,
      question: {
        requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
        questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question', revision, status: 'queued',
        answer: { acceptedAtMs: 2, submissionId: 'submission', answers: answer.params.answers } },
      startedTurn: { id: 'answer-turn', status: 'running' } });
    assert.equal(f.broker.threadOwners.get('thread'), original);
    assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt')
      .map(message => message.params), revision === undefined ? [] : [{ threadId: 'thread', turnId: 'answer-turn' }]);
  });
}

test('repeated compaction preserves the original revision without retaining answer content', () => {
  const params = { threadId: 'thread', questionId: 'question', submissionId: 'submission',
    expectedRevision: 3, answers: { item: { text: 'private answer' } } };
  const compact = compactRequestParams(params);
  assert.equal(compact.expectedRevision, 3);
  assert.equal(compact.answers, undefined);
  assert.deepEqual(compactRequestParams(compact), compact);
});

for (const disconnected of [false, true]) {
  test(`a duplicate at the pre-answer revision cannot confirm execution (disconnected=${disconnected})`, t => {
    const f = fixture(t, false), owner = f.join(), answerer = f.join();
    const answer = f.send(answerer, 'asyncQuestion/answer', {
      threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'saved answer' } },
    });
    if (disconnected) {
      f.broker.expireRequest(answer.id);
      f.broker.detach(answerer);
    }
    const question = {
      threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
      toolCallId: 'tool', createdAtMs: 1, revision: 1, status: 'queued',
      questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
      answer: { acceptedAtMs: 2, submissionId: 'submission', answers: answer.params.answers },
    };
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: true, question,
      startedTurn: { id: 'answer-turn', status: 'running' } });

    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
      'an impossible saved revision cannot authorize an interrupt');
    assert.equal(f.broker.threadOwners.get('thread') === owner, true,
      'an impossible saved revision cannot transfer ownership');
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    if (!disconnected) assert.equal(answerer.messages.at(-1).error?.code, -32001);

    const saved = { ...question, revision: 2 };
    const read = f.send(owner, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
    f.reply(read, { threadId: 'thread', questions: [saved] });
    assert.deepEqual(owner.messages.at(-1).result.questions, [saved]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const disconnected of [false, true]) {
  test(`a future-revision retry confirms only the saved answer (disconnected=${disconnected})`, t => {
    const f = fixture(t, false), owner = f.join(), answerer = f.join();
    const params = {
      threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 3,
      answers: { item: { text: 'saved answer' } },
    };
    const question = {
      threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
      toolCallId: 'tool', createdAtMs: 1, revision: 2, status: 'queued',
      questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
      answer: { acceptedAtMs: 2, submissionId: 'submission', answers: params.answers },
    };
    const saved = { threadId: 'thread', accepted: true, duplicate: true, question };
    f.reply(f.send(answerer, 'asyncQuestion/answer', params), saved);
    assert.deepEqual(answerer.messages.at(-1).result, saved);

    const request = f.send(answerer, 'asyncQuestion/answer', params);
    if (disconnected) {
      f.broker.expireRequest(request.id);
      f.broker.detach(answerer);
    }
    f.reply(request, { ...saved, startedTurn: { id: 'answer-turn', status: 'running' } });

    if (!disconnected) assert.equal(answerer.messages.at(-1).error?.code, -32001);
    assert.equal(f.broker.threadOwners.get('thread') === owner, true, 'original owner retains control');
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    const read = f.send(owner, 'asyncQuestion/list', { threadId: 'thread' });
    f.reply(read, { threadId: 'thread', questions: [question] });
    assert.deepEqual(owner.messages.at(-1).result.questions, [question]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 2);
  });
}

for (const duplicate of [false, true]) {
  for (const disconnected of [false, true]) {
    test(`a later queued revision cannot certify a new turn (duplicate=${duplicate}, disconnected=${disconnected})`, t => {
      const f = fixture(t, false), owner = f.join(), answerer = f.join();
      const request = f.send(answerer, 'asyncQuestion/answer', {
        threadId: 'thread', questionId: 'question', submissionId: 'submission',
        expectedRevision: duplicate ? 2 : 1, answers: { item: { text: 'saved answer' } },
      });
      if (disconnected) {
        f.broker.expireRequest(request.id);
        f.broker.detach(answerer);
      }
      const question = {
        threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
        toolCallId: 'tool', createdAtMs: 1, revision: 3, status: 'queued',
        questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
        answer: { acceptedAtMs: 2, submissionId: 'submission', answers: request.params.answers },
      };
      f.reply(request, { threadId: 'thread', question, accepted: true, duplicate,
        startedTurn: { id: 'answer-turn', status: 'running' } });

      if (!disconnected) assert.equal(answerer.messages.at(-1).error?.code, -32001);
      assert.equal(f.broker.threadOwners.get('thread') === owner, true);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);

      const saved = { ...question, revision: 2 };
      const read = f.send(owner, 'asyncQuestion/list', { threadId: 'thread' });
      f.reply(read, { threadId: 'thread', questions: [saved] });
      assert.deepEqual(owner.messages.at(-1).result.questions, [saved]);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}
