import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind = 'question', active = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: {
    interactionBindingV1: true, asyncUserQuestionsV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const send = (client, method, params = {}) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.at(-1);
    assert.equal(request.method, method);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume');
    return { client, finish: () => reply(request, { thread: { id: 'thread' } }) };
  };
  const owner = resume(); owner.finish();
  if (active) reply(send(owner.client, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
  const binding = { serverId: 'server-current', threadId: 'thread', turnId: 'turn',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original', appServerEpoch: 'epoch' };
  const request = { id: 500, method: `${kind}/request`, params: { ...binding,
    ...(kind === 'question' ? { questions: [{ id: 'item' }] } : { availableDecisions: ['accept'] }) } };
  const terminal = { method: `${kind}/resolved`, params: { ...binding, requestId: 500,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  return { broker, upstream, emit, send, reply, resume, owner: owner.client, request, terminal };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const id of [null, 500]) {
      test(`${kind} terminal request envelope cannot consume the original receipt (shared=${shared}, id=${id})`, t => {
        const f = fixture(t, shared, kind);
        f.emit(f.request);
        const deliveries = f.owner.messages.length, writes = f.upstream.length;
        f.emit({ ...f.terminal, id });
        assert.equal(f.broker.serverRequests.get(500), f.owner, 'invalid terminal must not retire the original waiter');
        assert.equal(f.owner.messages.length, deliveries, 'a terminal request is not a card or notification');
        assert.equal(f.upstream.length, writes, 'do not answer an invalid terminal envelope');
        f.broker.receive(f.owner, JSON.stringify({ id: 500, result: kind === 'question'
          ? { answers: { item: { answers: ['original answer'] } } } : { decision: 'accept' } }));
        assert.equal(f.upstream.length, writes + 1, 'the original input remains answerable exactly once');
        f.emit(f.terminal);
        assert.deepEqual(f.owner.messages.at(-1), f.terminal, 'the real Native receipt must still settle the card');
      });
    }
  }

  for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
    test(`${method} request envelope cannot end question input or poison an answer admission (shared=${shared})`, t => {
      const f = fixture(t, shared);
      f.emit(f.request);
      const answer = f.send(f.owner, 'asyncQuestion/answer', { questionId: 'async', submissionId: 'submission',
        expectedRevision: 1, answers: { item: { text: 'answer' } } });
      const deliveries = f.owner.messages.length, writes = f.upstream.length;
      const terminal = { method, params: { threadId: 'thread', turnId: 'turn' } };
      f.emit({ ...terminal, id: 500 });
      assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'turn', 'requests cannot certify completion');
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      assert.equal(f.broker.pending.get(answer.id).asyncQuestionTerminalTurns?.has('turn') ?? false, false);
      assert.equal(f.owner.messages.length, deliveries);
      assert.equal(f.upstream.length, writes);
      f.emit(terminal);
      assert.equal(f.broker.activeTurns.size, 0, 'a genuine notification still ends the turn');
      assert.equal(f.broker.serverRequests.has(500), false);
      assert.equal(f.broker.pending.get(answer.id).asyncQuestionTerminalTurns.has('turn'), true);
      assert.deepEqual(f.owner.messages.at(-1), terminal);
    });
  }

  test(`a terminal request before its restored question cannot swallow the real receipt (shared=${shared})`, t => {
    const f = fixture(t, shared, 'question', false);
    f.broker.detach(f.owner);
    const recovering = f.resume(), writes = f.upstream.length;
    f.emit({ ...f.terminal, id: 500 });
    assert.equal(f.upstream.length, writes, 'recovery cannot respond to a terminal notification with an ID');
    f.emit(f.terminal);
    recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread, 'the original task resumes');
    assert.deepEqual(recovering.client.messages.slice(1), [f.terminal], 'the authoritative receipt survives recovery');
    const deliveries = recovering.client.messages.length;
    f.emit(f.request);
    assert.equal(recovering.client.messages.length, deliveries, 'the restored question stays terminal');
  });
}
