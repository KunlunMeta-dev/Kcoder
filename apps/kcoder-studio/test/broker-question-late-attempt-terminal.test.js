import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';
import { BrokerSharedInteractions } from '../src/broker-shared-interactions.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current' } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
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
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  return { broker, upstream, emit, send, reply, join };
}

for (const shared of [false, true]) {
  for (const status of ['failed', 'interrupted']) {
    for (const admission of ['turn/start', 'asyncQuestion/answer']) {
      for (const sequenced of [false, true]) {
        test(`first late ${status} from an old attempt cannot close a confirmed retry (shared=${shared}, admission=${admission}, sequenced=${sequenced})`, t => {
          const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
          const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
          f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
          // The previous terminal was missed. The authoritative retry receipt
          // confirms a new attempt under the same turn ID before it arrives.
          if (admission === 'turn/start') {
            f.reply(f.send(owner, 'turn/start', { threadId: 'thread',
              retryFromTurnId: turn.id, retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'retry' } });
          } else {
            f.broker.initializeResponse.result.capabilities = { experimental: { asyncUserQuestionsV1: true } };
            owner.asyncUserQuestionsV1 = true;
            const params = { threadId: 'thread', questionId: 'saved-question', expectedRevision: 1,
              submissionId: 'submission', answers: { item: { text: 'saved answer' } } };
            f.reply(f.send(owner, admission, params), { threadId: 'thread', accepted: true, duplicate: true,
              question: answeredAsyncQuestion(params),
              startedTurn: { ...turn, attemptId: 'retry' } });
          }
          const question = { id: 500, method: 'question/request', params: {
            serverId: 'server-current', threadId: 'thread', turnId: turn.id, questionId: 'retry-question',
            questions: [{ id: 'choice', prompt: 'Retry choice?', options: [], allowsFreeform: true }],
          } };
          f.emit(question);
          const deliveries = new Map([...new Set([owner, viewer])].map(client => [client, client.messages.length]));
          const terminal = { method: `turn/${status}`, params: { serverId: 'server-current',
            ...(sequenced ? { sequence: 10 } : { threadId: 'thread' }), turnId: turn.id,
            ...(sequenced ? { turn: { ...turn, status } } : { attemptId: 'first' }) } };
          f.emit(terminal);
          assert.equal(f.broker.activeTurns.get('thread')?.owner, owner,
            'a first late terminal must not settle the confirmed retry');
          assert.equal(f.broker.serverRequests.get(question.id), owner,
            'the retry question retains its original waiter');
          for (const [client, count] of deliveries)
            assert.equal(client.messages.length, count, 'the old attempt cannot close a displayed card');
          f.broker.receive(owner, JSON.stringify({ id: question.id,
            result: { answers: { choice: { answers: ['retry answer'] } } } }));
          assert.equal(f.upstream.filter(message => message.id === question.id && message.result).length, 1);
          f.emit({ ...terminal, params: { ...terminal.params, ...(sequenced ? { sequence: 20 } : {}),
            ...(sequenced ? { turn: { ...turn, attemptId: 'retry', status } } : { attemptId: 'retry' }) } });
          assert.equal(f.broker.activeTurns.has('thread'), false, 'the current attempt still settles');
          assert.equal(f.broker.serverRequests.has(question.id), false);
          assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
        });
      }
    }
  }
}

for (const shared of [false, true]) {
  test(`a new attempt's terminal before its admission receipt still wins (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join();
    const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
    f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    const retry = f.send(owner, 'turn/start', { threadId: 'thread',
      retryFromTurnId: turn.id, retryOperationId: 'retry' });
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: turn.id,
      turn: { ...turn, attemptId: 'retry', status: 'completed' } } });
    f.reply(retry, { turn: { ...turn, attemptId: 'retry' } });
    assert.equal(f.broker.activeTurns.has('thread'), false,
      'an in-flight admission makes the previous attempt insufficient to reject a new terminal');
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}

for (const shared of [false, true]) {
  test(`an old terminal during retry admission cannot mark the new attempt completed (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join();
    const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
    f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    const retry = f.send(owner, 'turn/start', { threadId: 'thread',
      retryFromTurnId: turn.id, retryOperationId: 'retry' });
    f.emit({ method: 'turn/failed', params: { threadId: 'thread', turnId: turn.id,
      turn: { ...turn, status: 'failed' } } });
    f.reply(retry, { turn: { ...turn, attemptId: 'retry' } });
    f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
      questionId: 'retry-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } });
    assert.equal(f.broker.activeTurns.get('thread')?.owner, owner);
    assert.equal(f.broker.serverRequests.get(500), owner, 'only the matching attempt can close retry input');
    f.broker.receive(owner, JSON.stringify({ id: 500, result: { answers: { choice: { answers: ['answer'] } } } }));
    assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
  });
}

for (const shared of [false, true]) {
  test(`an old terminal during async answer admission cannot suppress its new attempt (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join();
    f.broker.initializeResponse.result.capabilities = { experimental: { asyncUserQuestionsV1: true } };
    owner.asyncUserQuestionsV1 = true;
    const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
    f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    const params = { threadId: 'thread', questionId: 'saved-question', expectedRevision: 1,
      submissionId: 'submission', answers: { item: { text: 'saved answer' } } };
    const answer = f.send(owner, 'asyncQuestion/answer', params);
    f.emit({ method: 'turn/failed', params: { threadId: 'thread', turnId: turn.id,
      turn: { ...turn, status: 'failed' } } });
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: true,
      question: answeredAsyncQuestion(params),
      startedTurn: { ...turn, attemptId: 'retry' } });
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'retry');
    f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
      questionId: 'retry-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } });
    assert.equal(f.broker.serverRequests.get(500), owner);
    f.broker.receive(owner, JSON.stringify({ id: 500, result: { answers: { choice: { answers: ['answer'] } } } }));
    assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
      'receipt reconciliation never resubmits the saved answer');
  });
}

for (const terminalCount of [64, 65]) {
  test(`in-flight terminal budget counts ${terminalCount} attempts sharing one turn ID`, t => {
    const f = fixture(t, false), owner = f.join();
    const retry = f.send(owner, 'turn/start', { threadId: 'thread', retryFromTurnId: 'turn', retryOperationId: 'retry' });
    for (let index = 0; index < terminalCount; index++) {
      f.emit({ method: 'turn/failed', params: { threadId: 'thread', turnId: 'turn',
        turn: { id: 'turn', attemptId: `old-${index}`, status: 'failed' } } });
    }
    f.reply(retry, { turn: { id: 'turn', threadId: 'thread', attemptId: 'retry', status: 'running' } });
    assert.equal(f.broker.activeTurns.has('thread'), terminalCount === 64,
      'an exhausted observation budget must not certify execution from an incomplete history');
    assert.equal(f.upstream.filter(message => message.method === 'turn/start').length, 1);
  });
}

for (const shared of [false, true]) {
  for (const admission of ['turn/start', 'asyncQuestion/answer']) {
    for (const status of ['completed', 'failed', 'interrupted']) {
      test(`superseded attempt cannot close current input while another answer waits (shared=${shared}, admission=${admission}, status=${status})`, t => {
        const f = fixture(t, shared), owner = f.join();
        f.broker.initializeResponse.result.capabilities = { experimental: { asyncUserQuestionsV1: true } };
        owner.asyncUserQuestionsV1 = true;
        const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
        f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
        if (admission === 'turn/start') {
          f.reply(f.send(owner, admission, { threadId: 'thread',
            retryFromTurnId: turn.id, retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'retry' } });
        } else {
          const params = { threadId: 'thread', questionId: 'first-saved-question', expectedRevision: 1,
            submissionId: 'first-submission', answers: { item: { text: 'first saved answer' } } };
          f.reply(f.send(owner, admission, params), { threadId: 'thread', accepted: true, duplicate: true,
            question: answeredAsyncQuestion(params),
            startedTurn: { ...turn, attemptId: 'retry' } });
        }
        f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
          questionId: 'current-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } });
        const answer = f.send(owner, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'saved-question',
          expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'saved answer' } } });
        const delivered = owner.messages.length;
        f.emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: turn.id,
          turn: { ...turn, status } } });
        assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'retry',
          'an unrelated in-flight answer cannot revive a superseded attempt');
        assert.equal(f.broker.serverRequests.get(500), owner, 'current input keeps its waiter');
        assert.equal(owner.messages.length, delivered, 'the current card receives no stale terminal');
        f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
          question: answeredAsyncQuestion(answer.params) });
        f.broker.receive(owner, JSON.stringify({ id: 500,
          result: { answers: { choice: { answers: ['current answer'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1,
          'the original question can still be answered exactly once');
        f.emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: turn.id,
          turn: { ...turn, attemptId: 'retry', status } } });
        assert.equal(f.broker.activeTurns.has('thread'), false, 'the actual current terminal settles');
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length,
          admission === 'asyncQuestion/answer' ? 2 : 1, 'no saved answer is replayed');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      });
    }
  }
}

test('superseded attempt identities are task-local, bounded and released with the broker', () => {
  const broker = { activeTurns: new Map(), pending: new Map([[1,
    { method: 'turn/start', params: { threadId: 'thread' } }]]) };
  const interactions = new BrokerSharedInteractions(broker);
  const terminal = (attemptId, threadId = 'thread') => ({ method: 'turn/failed',
    params: { threadId, turnId: 'turn', attemptId } });
  for (let index = 0; index <= 2048; index++) {
    broker.activeTurns.set('thread', { turnId: 'turn', attemptId: `old-${index}` });
    interactions.rememberSupersededAttempt('thread', 'turn', `new-${index}`);
  }
  broker.activeTurns.set('thread', { turnId: 'turn', attemptId: 'current' });
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal('old-2048')), true);
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal('old-0')), false,
    'the oldest identity leaves the bounded window');
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal('old-2048', 'peer-thread')), false);
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal('unconfirmed-new-attempt')), false,
    'a new admission may settle before its receipt');
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal(undefined)), false,
    'legacy terminals keep their existing semantics');
  interactions.clear();
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal('old-2048')), false,
    'broker teardown releases every retained identity');
});


for (const shared of [false, true]) {
  for (const sequenced of [false, true]) {
    test(`a previously ended attempt cannot close retry input while an answer waits (shared=${shared}, sequenced=${sequenced})`, t => {
      const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
      f.broker.initializeResponse.result.capabilities = { experimental: { asyncUserQuestionsV1: true } };
      owner.asyncUserQuestionsV1 = true;
      const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
      f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
      const terminal = { method: 'turn/failed', params: { threadId: 'thread', turnId: turn.id,
        ...(sequenced ? { sequence: 10 } : {}), turn: { ...turn, status: 'failed' } } };
      f.emit(terminal);
      assert.equal(f.broker.activeTurns.has('thread'), false);
      f.reply(f.send(owner, 'turn/start', { threadId: 'thread', retryFromTurnId: turn.id,
        retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'retry' } });
      f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
        questionId: 'retry-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } });
      const answer = f.send(owner, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'saved-question',
        expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'saved answer' } } });
      const deliveries = new Map([...new Set([owner, viewer])].map(client => [client, client.messages.length]));
      f.emit({ ...terminal, params: { ...terminal.params, ...(sequenced ? { sequence: 20 } : {}) } });
      assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'retry',
        'a completed predecessor remains ended after its active record was cleared');
      assert.equal(f.broker.serverRequests.get(500), owner, 'the current question retains its waiter');
      for (const [client, count] of deliveries) assert.equal(client.messages.length, count);
      f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
        question: answeredAsyncQuestion(answer.params) });
      f.broker.receive(owner, JSON.stringify({ id: 500,
        result: { answers: { choice: { answers: ['current answer'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      f.emit({ ...terminal, params: { ...terminal.params, ...(sequenced ? { sequence: 30 } : {}),
        turn: { ...turn, attemptId: 'retry', status: 'failed' } } });
      assert.equal(f.broker.activeTurns.has('thread'), false, 'the actual retry terminal still closes input');
      assert.equal(f.broker.serverRequests.has(500), false);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}

for (const shared of [false, true]) {
  test(`a different attempt's terminal cannot close current input while an async answer waits (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join(), answerer = shared ? f.join() : owner;
    f.broker.initializeResponse.result.capabilities = { experimental: { asyncUserQuestionsV1: true } };
    answerer.asyncUserQuestionsV1 = true;
    const turn = { id: 'turn', threadId: 'thread', attemptId: 'current', status: 'running' };
    f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    f.emit({ id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: turn.id, attemptId: turn.attemptId, questionId: 'current-question',
      questions: [{ id: 'choice', prompt: 'Which?', options: [] }],
    } });
    const answer = f.send(answerer, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'saved-question',
      expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'saved answer' } } });
    const clients = [...new Set([owner, answerer])];
    const deliveries = clients.map(client => client.messages.length);
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: turn.id, sequence: 10,
      turn: { ...turn, attemptId: 'unobserved', status: 'completed' } } });
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
    assert.equal(f.broker.serverRequests.get(500), owner);
    assert.deepEqual(clients.map(client => client.messages.length), deliveries);

    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: true,
      question: answeredAsyncQuestion(answer.params), startedTurn: { ...turn, attemptId: 'unobserved' } });
    assert.equal(answerer.messages.at(-1).result.accepted, true, 'the saved answer remains confirmed');
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current',
      'the terminal remains available to fence an exact late admission receipt');
    assert.equal(f.broker.threadOwners.get('thread'), owner);
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: turn.id, sequence: 11,
      turn: { ...turn, status: 'completed' } } });
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}
