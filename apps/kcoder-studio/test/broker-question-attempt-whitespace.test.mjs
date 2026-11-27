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
  test(`a Rust-valid FEFF attempt completion closes the original question (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
    const turn = { id: 'turn', threadId: 'thread', attemptId: '\uFEFF', status: 'running' };
    f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: turn.id,
      questionId: 'original', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
    assert.equal(f.broker.serverRequests.get(500), owner);
    f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: turn.id, sequence: 42,
      turn: { ...turn, status: 'completed' } } });
    assert.equal(f.broker.activeTurns.has('thread'), false, 'valid completion cannot strand the running task');
    assert.equal(f.broker.serverRequests.has(500), false, 'the original question must close');
    assert.equal(viewer.messages.at(-1).method, 'turn/completed');
    f.broker.receive(owner, JSON.stringify({ id: 500, result: { answers: { item: { answers: ['late'] } } } }));
    assert.equal(f.upstream.some(message => message.id === 500 && message.result), false,
      'completion must prevent stale answers');
  });

  test(`Rust-whitespace attempts cannot exhaust question recovery (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
    const refresh = f.send(viewer, 'thread/resume', { threadId: 'thread' });
    for (let sequence = 0; sequence < 513; sequence++) f.emit({ method: 'turn/started', params: {
      threadId: 'thread', turnId: 'turn', sequence,
      turn: { id: 'turn', status: 'running', attemptId: ' \u0085\t' },
    } });
    f.reply(refresh, { thread: { id: 'thread' } });
    assert.equal(viewer.messages.some(message => message.error?.code === -32047), false);
    assert.equal(viewer.messages.some(message => message.method === 'turn/started'), false);
    f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
      questionId: 'original', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
    assert.equal(f.broker.serverRequests.get(500), owner, 'original question remains recoverable');
  });
}

for (const method of ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted']) {
  test(`${method} uses Rust whitespace for attempt identities`, () => {
    for (const value of ['\u0085', ' \u0085\t'])
      assert.equal(hasConflictingTurnIdentity({ method, params: { attemptId: value } }), true);
    for (const value of ['\uFEFF', '尝试-😀', null, undefined])
      assert.equal(hasConflictingTurnIdentity({ method, params: { turn: { attemptId: value } } }), false);
  });
}
