import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current',
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const sendFrom = (client, method, params) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.at(-1);
    assert.equal(request.method, method);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    reply(sendFrom(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : owner;
  return { broker, upstream, emit, owner, viewer, send: (method, params) => sendFrom(owner, method, params), reply };
}

for (const shared of [false, true]) {
  for (const variation of ['method', 'omitted server', 'added server']) {
    test(`ended attempt retains its terminal identity across ${variation} (shared=${shared})`, t => {
      const f = fixture(t, shared);
      const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
      f.reply(f.send('turn/start', { threadId: 'thread' }), { turn });
      const terminal = { method: 'turn/failed', params: { threadId: 'thread', turnId: turn.id,
        ...(variation === 'added server' ? {} : { serverId: 'server-current' }),
        turn: { ...turn, status: 'failed' } } };
      f.emit(terminal);
      assert.equal(f.broker.activeTurns.has('thread'), false);
      f.reply(f.send('turn/start', { threadId: 'thread', retryFromTurnId: turn.id,
        retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'retry' } });
      const prompt = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
        questionId: 'retry-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } };
      f.emit(prompt);
      const answer = f.send('asyncQuestion/answer', { threadId: 'thread', questionId: 'saved-question',
        expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'saved answer' } } });
      const replay = structuredClone(terminal);
      if (variation === 'method') replay.method = 'turn/completed';
      if (variation === 'omitted server') delete replay.params.serverId;
      if (variation === 'added server') replay.params.serverId = 'server-current';
      const deliveries = new Map([...new Set([f.owner, f.viewer])].map(client => [client, client.messages.length]));
      f.emit(replay);
      assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'retry',
        'optional transport metadata cannot revive the ended attempt');
      assert.equal(f.broker.serverRequests.get(prompt.id), f.owner, 'the retry keeps its original question');
      for (const [client, count] of deliveries)
        assert.equal(client.messages.length, count, 'the old terminal cannot close either displayed card');
      f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
        question: { threadId: 'thread', questionId: 'saved-question', revision: 2, status: 'queued',
          answer: { acceptedAtMs: 2, submissionId: 'submission', answers: answer.params.answers } } });
      f.broker.receive(f.owner, JSON.stringify({ id: prompt.id,
        result: { answers: { choice: { answers: ['current answer'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === prompt.id && message.result).length, 1);
      f.emit({ ...replay, params: { ...replay.params, turn: { ...turn, attemptId: 'retry', status: 'failed' } } });
      assert.equal(f.broker.activeTurns.has('thread'), false, 'the real current terminal still settles');
      assert.equal(f.broker.serverRequests.has(prompt.id), false);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}

for (const shared of [false, true]) {
  test(`a sequenced legacy terminal cannot close retry input when replay adds the server ID (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const turn = { id: 'turn', threadId: 'thread', status: 'running' };
    f.reply(f.send('turn/start', { threadId: 'thread' }), { turn });
    const terminal = { method: 'turn/failed', params: { threadId: 'thread', turnId: turn.id, sequence: 10 } };
    f.emit(terminal);
    assert.equal(f.broker.activeTurns.has('thread'), false);

    f.reply(f.send('turn/start', { threadId: 'thread', retryFromTurnId: turn.id,
      retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'retry' } });
    const prompt = { id: 501, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
      questionId: 'retry-question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] } };
    f.emit(prompt);
    assert.equal(f.broker.serverRequests.get(prompt.id), f.owner);
    const deliveries = new Map([...new Set([f.owner, f.viewer])].map(client => [client, client.messages.length]));

    const replay = { ...terminal, params: { ...terminal.params, serverId: 'server-current' } };
    f.emit(replay);
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'retry');
    assert.equal(f.broker.serverRequests.get(prompt.id), f.owner);
    for (const [client, count] of deliveries) assert.equal(client.messages.length, count);

    f.broker.receive(f.owner, JSON.stringify({ id: prompt.id,
      result: { answers: { choice: { answers: ['current answer'] } } } }));
    assert.equal(f.upstream.filter(message => message.id === prompt.id && message.result).length, 1);
    f.emit({ ...replay, params: { ...replay.params, sequence: 11, attemptId: 'retry' } });
    assert.equal(f.broker.activeTurns.has('thread'), false);
    assert.equal(f.broker.serverRequests.has(prompt.id), false);
  });
}
