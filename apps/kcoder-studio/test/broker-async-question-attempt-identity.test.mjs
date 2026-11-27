import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, lifetime, { terminalBeforeAnswer = false, legacyActive = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', targetTransport: 'local', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
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
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  const owner = join(), answerer = join();
  const turn = { id: 'turn', threadId: 'thread', attemptId: legacyActive ? undefined : 'current', status: 'running' };
  reply(send(owner, 'turn/start', { threadId: 'thread' }), { turn });
  emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'ordinary-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } });
  if (terminalBeforeAnswer) {
    emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
      turn: { ...turn, status: 'completed' } } });
  }
  const answer = send(answerer, 'asyncQuestion/answer', {
    threadId: 'thread', questionId: 'saved-question', expectedRevision: 1,
    submissionId: 'submission', answers: { item: { text: 'saved answer' } },
  });
  const question = {
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
    questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'saved-question', revision: 2, status: 'queued',
    answer: { acceptedAtMs: 2, submissionId: 'submission', answers: answer.params.answers } };
  const receipt = attemptId => reply(answer, { threadId: 'thread', accepted: true, duplicate: true,
    question, startedTurn: { ...turn, attemptId } });
  return { broker, upstream, emit, send, reply, owner, answerer, turn, answer, question, receipt };
}

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    if (lifetime && lifecycle.includes('disconnected')) continue;
    for (const attemptId of ['', '   ', 7]) {
      test(`invalid answer attempt ${JSON.stringify(attemptId)} preserves original input and terminal (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime);
        if (lifecycle.includes('expired')) f.broker.expireRequest(f.answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
        const active = f.broker.activeTurns.get('thread');
        const deliveries = f.answerer.messages.length;
        f.receipt(attemptId);
        assert.equal(f.broker.threadOwners.get('thread'), f.owner,
          'an unusable attempt cannot take over the original task');
        assert.equal(f.broker.activeTurns.get('thread'), active,
          'an unusable attempt cannot replace the original execution');
        assert.equal(f.broker.threadDrains.size, 0);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'a disconnected answerer cannot interrupt a peer using an invalid attempt receipt');
        if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
        else assert.equal(f.answerer.messages.length, deliveries, 'late receipts are not delivered again');
        assert.equal(f.broker.serverRequests.get(500), f.owner, 'the original question still has its answerer');

        f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
          turn: { ...f.turn, status: 'completed' } } });
        assert.equal(f.broker.activeTurns.has('thread'), false,
          'the original terminal must not be discarded as a superseded attempt');
        assert.equal(f.broker.serverRequests.has(500), false, 'completion releases the original question');
        assert.equal(f.owner.messages.at(-1).method, 'turn/completed');
        f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [f.question],
        });
        assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'readback does not repeat the answer');
      });
    }
  }
}

test('an invalid answer attempt cannot strand the original question after its turn completes', t => {
  const f = fixture(t, true);
  f.receipt('');
  f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
    turn: { ...f.turn, status: 'completed' } } });
  assert.equal(f.broker.activeTurns.has('thread'), false,
    'the real current attempt must not be marked superseded by an empty attempt');
  assert.equal(f.broker.serverRequests.has(500), false, 'completion must release the original input');
  assert.equal(f.owner.messages.at(-1).method, 'turn/completed');
});

for (const attemptId of [undefined, null, 'new-attempt']) {
  test(`valid optional answer attempt ${JSON.stringify(attemptId)} still admits execution`, t => {
    const f = fixture(t, true, { legacyActive: attemptId == null, terminalBeforeAnswer: attemptId == null });
    f.receipt(attemptId);
    assert.equal(f.broker.threadOwners.get('thread'), f.answerer);
    assert.equal(f.broker.activeTurns.get('thread')?.owner, f.answerer);
    assert.equal(f.answerer.messages.at(-1).result.accepted, true);
  });
}

test('a late start cannot reopen an ended attempt during answer delivery', t => {
  const f = fixture(t, true);
  f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', sequence: 10,
    turn: { ...f.turn, status: 'completed' } } });
  assert.equal(f.broker.activeTurns.has('thread'), false);
  assert.equal(f.broker.serverRequests.has(500), false);

  const peers = [f.owner, f.answerer];
  const deliveries = peers.map(client => client.messages.length);
  f.emit({ method: 'turn/started', params: { threadId: 'thread', turnId: 'turn', sequence: 11, turn: f.turn } });
  assert.deepEqual(peers.map(client => client.messages.length), deliveries,
    'a late start for the ended attempt cannot reach either client');

  f.emit({ method: 'turn/started', params: { threadId: 'thread', turnId: 'turn', sequence: 12,
    turn: { ...f.turn, attemptId: 'new-attempt' } } });
  f.receipt('new-attempt');
  assert.equal(f.answerer.messages.at(-1).result.accepted, true);
  assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'new-attempt');
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
});

test('a saved answer receipt cannot reclaim an attempt completed before submission', t => {
  const f = fixture(t, true, { terminalBeforeAnswer: true });
  f.receipt('current');
  assert.equal(f.answerer.messages.at(-1).result.accepted, true);
  assert.deepEqual(f.answerer.messages.at(-1).result.question, f.question);
  assert.equal(f.broker.activeTurns.has('thread'), false);
  assert.equal(f.broker.threadOwners.get('thread'), f.owner);
});

test('a disconnected answerer cannot drain an attempt completed before submission', t => {
  const f = fixture(t, false, { terminalBeforeAnswer: true });
  f.broker.detach(f.answerer);
  f.receipt('current');
  assert.equal(f.broker.threadDrains.size, 0);
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
});

test('an answer can admit a fresh attempt with the same turn ID as an earlier terminal', t => {
  const f = fixture(t, true, { terminalBeforeAnswer: true });
  f.receipt('new-attempt');
  assert.equal(f.answerer.messages.at(-1).result.accepted, true);
  assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'new-attempt');
  assert.equal(f.broker.activeTurns.get('thread')?.owner, f.answerer);
});

for (const attemptId of ['unobserved-old-attempt', undefined]) {
  test(`detached answer receipt cannot interrupt a peer attempt (${attemptId ?? 'legacy receipt'})`, t => {
    const f = fixture(t, false);
    f.broker.detach(f.answerer);
    f.receipt(attemptId);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
      'legacy interrupt addresses only the turn ID and would stop the peer attempt');
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
    assert.equal(f.broker.serverRequests.get(500), f.owner);

    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
      turn: { ...f.turn, status: 'completed' } } });
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
      threadId: 'thread', questions: [f.question],
    });
    assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const attemptId of [undefined, null]) {
  test(`a connected answer receipt with attempt ${String(attemptId)} preserves the confirmed execution`, t => {
    const f = fixture(t, false);
    f.receipt(attemptId);
    assert.equal(f.answerer.messages.at(-1).result.accepted, true);
    assert.deepEqual(f.answerer.messages.at(-1).result.question, f.question);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.deepEqual(f.broker.activeTurns.get('thread'), { owner: f.owner, turnId: 'turn', attemptId: 'current' });
    assert.equal(f.broker.serverRequests.get(500), f.owner);

    f.broker.detach(f.answerer);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    assert.equal(f.broker.threadDrains.size, 0);
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
      turn: { ...f.turn, status: 'completed' } } });
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const disconnected of [false, true]) {
  test(`a saved answer receipt cannot take control of an already tracked attempt (disconnected=${disconnected})`, t => {
    const f = fixture(t, false);
    if (disconnected) f.broker.detach(f.answerer);
    f.receipt('current');

    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.deepEqual(f.broker.activeTurns.get('thread'), { owner: f.owner, turnId: 'turn', attemptId: 'current' });
    assert.equal(f.broker.serverRequests.get(500), f.owner);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    if (!disconnected) assert.deepEqual(f.answerer.messages.at(-1).result.question, f.question);
    f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
      threadId: 'thread', questions: [f.question],
    });
    assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);

    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
      turn: { ...f.turn, status: 'completed' } } });
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const [lifecycle, attemptId] of [['connected', undefined], ['connected', 'unverified-attempt'], ['disconnected', undefined],
  ['expired-disconnected', 'unverified-attempt']]) {
  test(`an ambiguous answer receipt preserves the active legacy peer turn (${lifecycle}, ${attemptId ?? "no attempt"})`, t => {
    const f = fixture(t, false, { legacyActive: true });
    if (lifecycle.startsWith('expired')) f.broker.expireRequest(f.answer.id);
    if (lifecycle.includes('disconnected')) f.broker.detach(f.answerer);
    f.receipt(attemptId);

    assert.equal(f.broker.threadOwners.get('thread') === f.owner, true);
    assert.deepEqual(f.broker.activeTurns.get('thread'), { owner: f.owner, turnId: 'turn' });
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    if (lifecycle === 'connected') assert.deepEqual(f.answerer.messages.at(-1).result.question, f.question);

    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
      turn: { ...f.turn, status: 'completed' } } });
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
      threadId: 'thread', questions: [f.question],
    });
    assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const method of ['turn/start', 'computerUse/recover']) {
  test(`a different attempt completing during ${method} preserves the active question`, t => {
    const f = fixture(t, true);
    f.owner.computerUseRecoveryV1 = true;
    const start = f.send(f.owner, method, { threadId: 'thread' });
    const otherAttempt = { ...f.turn, attemptId: 'other-attempt' };
    const terminal = turn => f.emit({ method: 'turn/completed', params: {
      threadId: 'thread', turnId: turn.id, turn: { ...turn, status: 'completed' },
    } });
    const ownerDeliveries = f.owner.messages.length;
    const answererDeliveries = f.answerer.messages.length;
    terminal(otherAttempt);

    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
    assert.equal(f.broker.serverRequests.get(500), f.owner);
    assert.equal(f.owner.messages.length, ownerDeliveries);
    assert.equal(f.answerer.messages.length, answererDeliveries);

    f.reply(start, { turn: otherAttempt });
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
    f.receipt('current');
    assert.deepEqual(f.answerer.messages.at(-1).result.question, f.question);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
    assert.equal(f.broker.serverRequests.get(500), f.owner);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);

    terminal(f.turn);
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(f.owner.messages.at(-1).method, 'turn/completed');
  });
}

test('a late desktop recovery receipt cannot resurrect its completed turn', t => {
  const f = fixture(t, true);
  f.owner.computerUseRecoveryV1 = true;
  const recovery = f.send(f.owner, 'computerUse/recover', {
    threadId: 'thread', previousTurnId: 'previous',
  });
  f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
    turn: { ...f.turn, status: 'completed' } } });
  assert.equal(f.broker.activeTurns.has('thread'), false);
  assert.equal(f.broker.serverRequests.has(500), false);
  assert.equal(f.answerer.messages.at(-1).method, 'turn/completed');

  f.reply(recovery, { threadId: 'thread', previousTurnId: 'previous', turnId: 'turn', status: 'running' });
  assert.equal(f.owner.messages.at(-1).result.turnId, 'turn', 'the original receipt still reaches its requester');
  assert.equal(f.broker.activeTurns.has('thread'), false, 'the terminal takes precedence over the late running receipt');
  assert.equal(f.broker.serverRequests.has(500), false);
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);

  f.receipt('current');
  assert.deepEqual(f.answerer.messages.at(-1).result.question, f.question);
  assert.equal(f.broker.activeTurns.has('thread'), false, 'the saved answer remains readable without reopening execution');
});

test('a completed desktop recovery receipt clears the detached drain without interrupting', t => {
  const f = fixture(t, false, { terminalBeforeAnswer: true });
  const threadId = 'thread';
  f.reply(f.answer, { threadId, accepted: true, duplicate: true, question: f.question });
  f.owner.computerUseRecoveryV1 = true;
  const recovery = f.send(f.owner, 'computerUse/recover', { threadId, previousTurnId: 'previous' });
  f.broker.detach(f.owner);
  assert.equal(f.broker.threadDrains.has(threadId), true);

  // A repeat recovery may return a saved terminal receipt without a notification.
  f.reply(recovery, { threadId, previousTurnId: 'previous', turnId: 'recovered', status: 'completed' });
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  assert.equal(f.broker.threadDrains.has(threadId), false);
  assert.equal(f.broker.activeTurns.has(threadId), false);

  const read = f.send(f.answerer, 'asyncQuestion/list', { threadId, includeTerminal: true });
  const result = { threadId, questions: [f.question] };
  f.reply(read, result);
  assert.deepEqual(f.answerer.messages.at(-1).result, result);
});
