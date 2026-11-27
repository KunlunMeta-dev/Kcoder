import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const invalidSequences = [null, -1, 1.5, '42', {}, Number.MAX_SAFE_INTEGER + 1];

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: {
    experimental: { asyncUserQuestionsV1: true },
  } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let id = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method) => {
    broker.receive(client, JSON.stringify({ id: ++id, method, params: { threadId: 'thread' } }));
    assert.equal(upstream.at(-1).method, method);
    return upstream.at(-1);
  };
  const join = (finish = true) => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume');
    if (finish) emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return { client, request };
  };
  return { broker, upstream, emit, send, join };
}

const receipt = (kind, sequence, requestId = 500) => ({ method: `${kind}/resolved`, params: {
  serverId: 'server-current', threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original',
  requestId, reason: 'client_response', sequence,
} });

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    test(`${kind}: invalid terminal sequences preserve original input (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join().client, viewer = shared ? f.join().client : owner;
      f.emit({ id: f.send(owner, 'turn/start').id, result: { turn: { id: 'turn', status: 'running' } } });
      f.emit({ id: 500, method: `${kind}/request`, params: { threadId: 'thread', turnId: 'turn',
        [`${kind}Id`]: 'original',
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } : {}),
      } });
      const counts = [owner.messages.length, viewer.messages.length];
      for (const sequence of invalidSequences) {
        f.emit(receipt(kind, sequence));
        assert.equal(f.broker.serverRequests.get(500), owner, 'invalid ordering cannot retire original input');
        assert.deepEqual([owner.messages.length, viewer.messages.length], counts);
      }
      const result = kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' };
      f.broker.receive(owner, JSON.stringify({ id: 500, result }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      const terminal = receipt(kind, 42);
      f.emit(terminal);
      assert.equal(f.broker.serverRequests.has(500), false);
      assert.deepEqual(viewer.messages.at(-1), terminal, 'the valid receipt still settles the original card');
      f.emit(terminal);
      assert.equal(viewer.messages.filter(message => message.method === `${kind}/resolved`).length, 1);
    });

    test(`${kind}: invalid terminal sequences cannot exhaust async question recovery (shared=${shared})`, t => {
      const f = fixture(t, shared);
      if (shared) f.join();
      const recovering = f.join(false);
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.emit(receipt(kind, invalidSequences[index % invalidSequences.length], 500 + index));
      const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
        question: { threadId: 'thread', questionId: 'async-original', revision: 1 } } };
      f.emit(changed);
      f.emit({ id: recovering.request.id, result: { thread: { id: 'thread' } } });
      assert.ok(recovering.client.messages[0]?.result?.thread, 'invalid receipts cannot cause -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [changed]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never replays input');
    });

    test(`${kind}: omitted and boundary terminal sequences remain compatible (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join().client;
      for (const [index, sequence] of [undefined, 0, Number.MAX_SAFE_INTEGER].entries()) {
        const terminal = receipt(kind, sequence, 500 + index);
        f.emit(terminal);
        assert.deepEqual(owner.messages.at(-1), JSON.parse(JSON.stringify(terminal)));
      }
    });
  }
}
