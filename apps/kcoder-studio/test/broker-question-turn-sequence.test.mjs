import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const invalidSequences = [null, -1, 1.5, '42', {}, Number.MAX_SAFE_INTEGER + 1];
const methods = ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted'];

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let id = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emitRaw = line => child.stdout.write(`${line}\n`);
  const emit = message => emitRaw(JSON.stringify(message));
  const send = (client, method, params = {}) => {
    broker.receive(client, JSON.stringify({ id: ++id, method, params: { threadId: 'thread', ...params } }));
    assert.equal(upstream.at(-1).method, method);
    return upstream.at(-1);
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = (finish = true) => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume');
    if (finish) reply(request, { thread: { id: 'thread' } });
    return { client, request };
  };
  return { broker, upstream, emit, emitRaw, send, reply, join };
}

for (const shared of [false, true]) {
  for (const method of methods) {
    test(`${method}: invalid explicit sequence preserves the original question (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join().client, viewer = shared ? f.join().client : owner;
      f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
      f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
        questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
      const active = f.broker.activeTurns.get('thread');
      const counts = [owner.messages.length, viewer.messages.length];
      for (const sequence of invalidSequences) {
        f.emit({ method, params: { threadId: 'thread', turnId: 'turn', sequence } });
        assert.equal(f.broker.serverRequests.get(500), owner, 'invalid ordering cannot retire the original waiter');
        assert.equal(f.broker.activeTurns.get('thread'), active, 'invalid ordering cannot replace the active turn');
        assert.deepEqual([owner.messages.length, viewer.messages.length], counts);
      }
      f.broker.receive(owner, JSON.stringify({ id: 500, result: { answers: { item: { answers: ['yes'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', sequence: 42 } });
      assert.equal(f.broker.activeTurns.has('thread'), false);
      assert.equal(f.broker.serverRequests.has(500), false);
      assert.equal(viewer.messages.at(-1).method, 'turn/completed');
    });

    test(`${method}: invalid sequences cannot block question recovery (shared=${shared})`, t => {
      const f = fixture(t, shared);
      if (shared) f.join();
      const recovering = f.join(false);
      for (let index = 0; index < 513; index++) f.emit({ method,
        params: { threadId: 'thread', turnId: 'turn', sequence: invalidSequences[index % invalidSequences.length] } });
      const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
        question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
      f.emit(changed);
      f.reply(recovering.request, { thread: { id: 'thread' } });
      assert.ok(recovering.client.messages[0]?.result?.thread, 'invalid frames must not cause -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [changed]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'readback never replays input');
    });
  }

  for (const sequence of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
    test(`legacy omission and valid sequence ${sequence} still settle original input (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join().client;
      f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn' } });
      const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', sequence } };
      f.emit(terminal);
      assert.equal(f.broker.activeTurns.has('thread'), false);
      assert.equal(owner.messages.at(-1).method, terminal.method);
    });
  }
}

for (const shared of [false, true]) {
  for (const [kind, sequence] of [
    ['rounded fraction', '42.00000000000000001'],
    ['duplicate sequence', '41,"sequence":42'],
  ]) {
    test(`invalid wire terminal (${kind}) cannot close the original question (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join().client;
      const recovering = shared ? f.join(false) : null;
      f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
      f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
        questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
      const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', sequence: 42 } };
      const active = f.broker.activeTurns.get('thread');
      const delivered = owner.messages.length;
      f.emitRaw(JSON.stringify(terminal).replace('"sequence":42', `"sequence":${sequence}`));

      assert.equal(f.broker.activeTurns.get('thread'), active);
      assert.equal(f.broker.serverRequests.get(500), owner);
      assert.equal(owner.messages.length, delivered);
      f.broker.receive(owner, JSON.stringify({ id: 500, result: { answers: { item: { answers: ['yes'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);

      const progress = { method: 'item/delta', params: { threadId: 'thread', turnId: 'turn', delta: { text: 'progress' } } };
      f.emit(progress);
      f.emit(terminal);
      assert.equal(f.broker.activeTurns.has('thread'), false);
      assert.deepEqual(owner.messages.slice(delivered), [progress, terminal]);
      if (recovering) {
        f.reply(recovering.request, { thread: { id: 'thread' } });
        assert.ok(recovering.client.messages[0]?.result?.thread);
        assert.deepEqual(recovering.client.messages.slice(-2), [progress, terminal],
          'resume must preserve arrival order relative to valid progress');
      }
    });
  }
}

for (const shared of [false, true]) {
  for (const variant of ['signed zero', 'optional turn metadata', 'optional start attempt']) {
    test(`equivalent turn replay preserves recovery capacity (${variant}, shared=${shared})`, t => {
      const f = fixture(t, shared);
      if (shared) f.join();
      const recovering = f.join(false);
      const start = { method: 'turn/started', params: { threadId: 'thread', turnId: 'turn', sequence: 0 } };
      if (variant !== 'signed zero') {
        start.params.turn = { id: 'turn', threadId: 'thread', status: 'running' };
      }
      f.emit(start);
      if (variant === 'signed zero') {
        f.emitRaw(JSON.stringify(start).replace('"sequence":0', '"sequence":-0'));
      } else if (variant === 'optional start attempt') {
        f.emit({ ...start, params: { ...start.params, attemptId: null } });
      } else {
        f.emit({ ...start, params: { ...start.params, turn: {
          ...start.params.turn, attemptId: null, memorySnapshotId: null,
        } } });
      }
      const deltas = Array.from({ length: 62 }, (_, index) => ({
        method: 'item/delta', params: { threadId: 'thread', turnId: 'turn', sequence: index + 1, delta: { text: 'progress' } },
      }));
      for (const delta of deltas) f.emit(delta);
      const question = { method: 'asyncQuestion/changed', params: { threadId: 'thread', sequence: 63,
        question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
      f.emit(question);
      f.reply(recovering.request, { thread: { id: 'thread' } });

      assert.ok(recovering.client.messages[0]?.result?.thread, 'the duplicate start must not crowd out the question');
      assert.deepEqual(recovering.client.messages.slice(1), [start, ...deltas, question]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
    });
  }
}
