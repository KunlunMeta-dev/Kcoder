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
  const send = (client, method) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread' } }));
    return upstream.at(-1);
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    emit({ id: send(client, 'thread/resume').id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, send, join };
}

for (const shared of [false, true]) {
  for (const method of ['turn/started', 'turn/completed']) {
    for (const locator of ['outer', 'nested']) {
      test(`${method}: Rust-blank ${locator} turn bindings cannot block question recovery (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
        const turn = { id: 'turn', threadId: 'thread', status: 'running' };
        f.emit({ id: f.send(owner, 'turn/start').id, result: { turn } });
        f.emit({ id: 500, method: 'question/request', params: {
          threadId: 'thread', turnId: 'turn', questionId: 'original',
          questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
        } });
        assert.equal(f.broker.serverRequests.get(500), owner);
        const refresh = f.send(viewer, 'thread/resume');
        // Invalid lifecycle frames must not replace execution or reserve the
        // bounded handoff queue before the client rejects their empty identity.
        for (let sequence = 0; sequence < 513; sequence++) f.emit({ method, params: {
          threadId: 'thread', sequence,
          ...(locator === 'outer' ? { turnId: ' \u0085\t' }
            : { turn: { id: ' \u0085\t', status: method === 'turn/started' ? 'running' : 'completed' } }),
        } });
        f.emit({ id: refresh.id, result: { thread: { id: 'thread' } } });
        assert.equal(viewer.messages.some(message => message.error?.code === -32047), false,
          'unusable lifecycle bindings must not exhaust original-task recovery');
        assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'turn',
          'the original execution remains current');
        assert.equal(f.broker.serverRequests.get(500), owner);
        f.emit({ method: 'turn/completed', params: {
          threadId: 'thread', turnId: 'turn', sequence: 514, turn: { ...turn, status: 'completed' },
        } });
        assert.equal(f.broker.activeTurns.has('thread'), false);
        assert.equal(f.broker.serverRequests.has(500), false, 'the real completion closes the original card');
        f.broker.receive(owner, JSON.stringify({ id: 500,
          result: { answers: { item: { answers: ['late answer'] } } } }));
        assert.equal(f.upstream.some(message => message.id === 500 && message.result), false,
          'a completed task cannot consume a late answer');
      });
    }
  }
}

test('lifecycle aliases use Rust whitespace without rewriting opaque identities', () => {
  for (const method of ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const binding of [value => ({ threadId: value }), value => ({ thread_id: value }),
      value => ({ thread: { id: value } }), value => ({ thread: { threadId: value } }),
      value => ({ widget: { threadId: value } }), value => ({ turn: { threadId: value } }),
      value => ({ turnId: value }), value => ({ turn_id: value }),
      value => ({ turn: { id: value } }), value => ({ turn: { turnId: value } })]) {
      assert.equal(hasConflictingTurnIdentity({ method, params: binding(' \u0085\t') }), true);
      assert.equal(hasConflictingTurnIdentity({ method, params: binding('\uFEFF') }), false);
    }
  }
});
