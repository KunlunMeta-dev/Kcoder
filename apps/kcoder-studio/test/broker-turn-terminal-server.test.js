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
  broker.initializeResponse = { result: { sessionId: 'original', capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  return { broker, upstream, emit, send, reply, join };
}


for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
  for (const shared of [false, true]) {
    for (const kind of ['question', 'approval']) {
      test(`${method}: foreign server preserves ${kind} during ${shared ? 'shared refresh' : 'exclusive input'}`, t => {
        const f = fixture(t), owner = f.join();
        owner.client.gatewaySharedThreadsV1 = shared; owner.finish();
        f.reply(f.send(owner.client, 'turn/start', { threadId: 'original' }), { turn: { id: 'turn' } });
        const request = { id: 500, method: `${kind}/request`, params: {
          threadId: 'original', turnId: 'turn', appServerEpoch: 'epoch',
          [kind === 'question' ? 'questionId' : 'approvalId']: 'interaction',
        } };
        f.emit(request);
        const viewer = shared ? f.join() : null;
        const delivered = owner.client.messages.length;
        // Distinct bogus completions would overflow recovery if buffered. They
        // must neither settle the visible waiter nor consume handoff capacity.
        for (let index = 0; index < 66; index++) f.emit({ method, params: {
          serverId: 'server-replaced', threadId: 'original', turnId: index ? `foreign-${index}` : 'turn',
        } });
        assert.equal(f.broker.activeTurns.get('original')?.owner, owner.client);
        assert.equal(f.broker.serverRequests.get(500), owner.client);
        assert.equal(owner.client.messages.length, delivered, 'foreign terminal cannot close the card');
        if (viewer) {
          viewer.finish();
          assert.ok(viewer.client.messages[0]?.result?.thread, 'refresh must not overflow');
          assert.deepEqual(viewer.client.messages.at(-1), request, 'original card remains recoverable');
        }
        const terminal = { method, params: { serverId: 'server-original', threadId: 'original', turnId: 'turn' } };
        f.emit(terminal);
        assert.equal(f.broker.activeTurns.has('original'), false);
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.deepEqual(owner.client.messages.at(-1), terminal);
        if (viewer) assert.deepEqual(viewer.client.messages.at(-1), terminal);
        assert.equal(f.upstream.some(message => message.id === 500), false, 'recovery never answers the prompt');
      });
    }
  }
  test(`${method}: foreign terminals cannot exhaust exclusive resume buffering`, t => {
    const f = fixture(t), owner = f.join();
    owner.client.gatewaySharedThreadsV1 = false;
    for (let index = 0; index < 66; index++) f.emit({ method, params: {
      serverId: 'server-replaced', threadId: 'original', turnId: `foreign-${index}`,
    } });
    const terminal = { method, params: { serverId: 'server-original', threadId: 'original', turnId: 'turn' } };
    f.emit(terminal); owner.finish();
    assert.ok(owner.client.messages[0]?.result?.thread, 'foreign frames cannot cause -32047');
    assert.deepEqual(owner.client.messages.filter(message => message.method === method), [terminal]);
    assert.equal(f.upstream.every(message => message.method === 'thread/resume'), true,
      'refresh sends no answer, cancel or additional turn');
  });
  test(`${method}: old producers omitting serverId still settle the original input`, t => {
    const f = fixture(t), owner = f.join(); owner.finish();
    f.reply(f.send(owner.client, 'turn/start', { threadId: 'original' }), { turn: { id: 'turn' } });
    f.emit({ id: 500, method: 'question/request', params: {
      threadId: 'original', turnId: 'turn', questionId: 'question',
    } });
    f.emit({ method, params: { threadId: 'original', turnId: 'turn' } });
    assert.equal(f.broker.activeTurns.has('original'), false);
    assert.equal(f.broker.serverRequests.has(500), false);
  });
}
for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  test(`foreign terminal cannot suppress an async answer admission (${lifecycle})`, t => {
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
      serverId: 'server-replaced', threadId: 'original', turnId: 'answer-turn',
    } });
    assert.equal(f.broker.pending.get(answer.id).asyncQuestionTerminalTurns?.has('answer-turn') ?? false, false);
    f.reply(answer, { threadId: 'original', accepted: true, duplicate: false,
      question: { threadId: 'original', questionId: 'question', answer: {
        submissionId: 'submission', answers: answer.params.answers,
      } }, startedTurn: { id: 'answer-turn', status: 'running' } });
    const detached = lifecycle.includes('disconnected');
    assert.equal(f.broker.threadOwners.get('original'), detached ? owner.client : answerer.client);
    assert.equal(f.broker.activeTurns.get('original')?.owner, detached ? undefined : answerer.client);
    assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
      detached ? [{ threadId: 'original', turnId: 'answer-turn' }] : []);
    if (lifecycle !== 'connected') assert.equal(answerer.client.messages.length, delivered);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}
