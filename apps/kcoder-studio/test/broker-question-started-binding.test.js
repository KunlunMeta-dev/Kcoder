import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: {} } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  return { broker, upstream, emit, resume };
}

const started = override => ({ method: 'turn/started', params: {
  serverId: 'server-current', threadId: 'thread', turnId: 'turn',
  turn: { id: 'turn', threadId: 'thread', status: 'running' }, ...override,
} });

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const [name, override] of [
    ['task alias', { thread_id: 'other-thread' }],
    ['nested task', { turn: { id: 'turn', threadId: 'other-thread', status: 'running' } }],
    ['turn alias', { turn_id: 'other-turn' }],
    ['nested turn', { turn: { id: 'other-turn', threadId: 'thread', status: 'running' } }],
    ['invalid task alias', { thread_id: 7 }],
    ['invalid turn alias', { turn_id: ' ' }],
  ]) {
    test(`${mode}: a conflicting ${name} start cannot rebind question clients`, t => {
      const f = fixture(t, shared), owner = f.resume(); owner.finish();
      const viewer = shared ? f.resume() : null; viewer?.finish();
      const question = { id: 500, method: 'question/request', params: {
        threadId: 'thread', turnId: 'turn', questionId: 'question', questions: [],
      } };
      f.emit(question);
      const clients = [owner.client, ...(viewer ? [viewer.client] : [])];
      const counts = clients.map(client => client.messages.length);
      f.emit(started(override));
      assert.deepEqual(clients.map(client => client.messages.length), counts,
        'ambiguous starts cannot replace the task or turn used by the original card');
      assert.equal(f.broker.serverRequests.get(500), owner.client);
      f.emit(started());
      for (const client of clients) assert.deepEqual(client.messages.at(-1), started());
      f.broker.receive(owner.client, JSON.stringify({ id: 500, result: { answers: {} } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      const receipt = { method: 'question/resolved', params: {
        ...question.params, requestId: 500, reason: 'client_response',
      } };
      f.emit(receipt);
      for (const client of clients) assert.deepEqual(client.messages.at(-1), receipt);
    });

    test(`${mode}: a conflicting ${name} start cannot exhaust question recovery`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume() : null; owner?.finish();
      const recovering = f.resume();
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.emit(started(override));
      const valid = started();
      f.emit(valid); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread,
        'unusable turn bindings must not turn successful resume into -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [valid]);
      if (owner) assert.deepEqual(owner.client.messages.slice(1), [valid]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'recovery never answers, cancels or replays task input');
    });
  }

  test(`${mode}: matching and nullable compatibility aliases preserve original start delivery`, t => {
    const f = fixture(t, shared), recovering = f.resume();
    const valid = [started({ thread_id: 'thread', thread: { id: 'thread' },
      widget: { threadId: 'thread' }, turn_id: 'turn', turn: { id: 'turn', turnId: 'turn', threadId: 'thread' } }),
    started({ thread_id: null, turn_id: null }),
    { method: 'turn/started', params: { thread_id: 'thread', turn_id: 'turn' } }];
    for (const message of valid) f.emit(message);
    recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(recovering.client.messages.slice(1), valid);
  });
}
