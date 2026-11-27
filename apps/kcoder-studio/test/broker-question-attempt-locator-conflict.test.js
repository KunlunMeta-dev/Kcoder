import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { hasConflictingTurnIdentity } from '../src/broker-shared-interactions.js';

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
  for (const method of ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const [outer, nested] of [['current', 'old'], ['old', 'current']]) {
      test(`conflicting ${method} attempts (${outer}/${nested}, shared=${shared}) cannot close original input`, t => {
        const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
        const turn = { id: 'turn', threadId: 'thread', attemptId: 'current', status: 'running' };
        f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
        f.emit({ id: 500, method: 'question/request', params: {
          threadId: 'thread', turnId: turn.id, questionId: 'question',
          questions: [{ id: 'choice', prompt: 'Which?', options: [] }],
        } });
        const deliveries = new Map([...new Set([owner, viewer])].map(client => [client, client.messages.length]));
        f.emit({ method, params: { threadId: 'thread', turnId: turn.id, sequence: 42,
          attemptId: outer, turn: { ...turn, attemptId: nested, status: 'completed' } } });
        assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
        assert.equal(f.broker.serverRequests.get(500), owner, 'a contradictory attempt cannot retire the waiter');
        for (const [client, count] of deliveries) assert.equal(client.messages.length, count);
        f.broker.receive(owner, JSON.stringify({ id: 500,
          result: { answers: { choice: { answers: ['original answer'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
        f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: turn.id, sequence: 42,
          turn: { ...turn, status: 'completed' } } });
        assert.equal(f.broker.activeTurns.has('thread'), false, 'the genuine terminal still settles');
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      });
    }
  }
}

test('attempt locators preserve nullable legacy omissions and reject explicit invalid identities', () => {
  for (const method of ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const value of ['', ' ', 7, {}, false]) {
      assert.equal(hasConflictingTurnIdentity({ method, params: { attemptId: value } }), true);
      assert.equal(hasConflictingTurnIdentity({ method, params: { turn: { attemptId: value } } }), true);
    }
    for (const params of [{}, { attemptId: null }, { turn: { attemptId: null } },
      { attemptId: 'current' }, { turn: { attemptId: 'current' } },
      { attemptId: 'current', turn: { attemptId: 'current' } }]) {
      assert.equal(hasConflictingTurnIdentity({ method, params }), false);
    }
  }
});

for (const method of ['turn/started', 'turn/completed']) {
  test(`${method} attempt conflicts cannot exhaust original-task resume capacity`, t => {
    const f = fixture(t, true), owner = f.join(), viewer = f.join();
    const turn = { id: 'turn', threadId: 'thread', attemptId: 'current', status: 'running' };
    f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    const refresh = f.send(viewer, 'thread/resume', { threadId: 'thread' });
    for (let sequence = 0; sequence < 513; sequence++) f.emit({ method, params: {
      threadId: 'thread', turnId: turn.id, sequence, attemptId: 'old', turn,
    } });
    f.reply(refresh, { thread: { id: 'thread' } });
    assert.equal(viewer.messages.some(message => message.error?.code === -32047), false);
    assert.equal(viewer.messages.filter(message => message.method === method).length, 0);
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current');
    f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
      questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
    assert.equal(f.broker.serverRequests.get(500), owner);
    assert.equal(viewer.messages.at(-1).method, 'question/request');
  });
}
