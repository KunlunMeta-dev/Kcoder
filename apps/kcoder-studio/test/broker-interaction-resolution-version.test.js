import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: {
    interactionBindingV1: true,
  } } } };
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
  const owner = resume(); owner.finish();
  const binding = { serverId: 'server-current', threadId: 'thread', turnId: 'turn',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original', appServerEpoch: 'epoch' };
  const request = { id: 500, method: `${kind}/request`, params: { ...binding,
    ...(kind === 'question' ? { questions: [{ id: 'item' }] } : { availableDecisions: ['accept'] }) } };
  const terminal = { jsonrpc: '2.0', method: `${kind}/resolved`, params: { ...binding, requestId: 500,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  return { broker, upstream, emit, resume, owner: owner.client, request, terminal };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const jsonrpc of ['1.0', null, 2]) {
      test(`${kind} resolution version ${JSON.stringify(jsonrpc)} cannot close input (shared=${shared})`, t => {
        const f = fixture(t, shared, kind);
        const viewer = shared ? f.resume() : null; viewer?.finish();
        f.emit(f.request);
        const deliveries = f.owner.messages.length, writes = f.upstream.length;
        f.emit({ ...f.terminal, jsonrpc });
        assert.equal(f.broker.serverRequests.get(500), f.owner, 'invalid envelope must preserve the original waiter');
        assert.equal(f.owner.messages.length, deliveries, 'invalid receipt cannot close the card');
        assert.equal(f.upstream.length, writes);
        f.broker.receive(f.owner, JSON.stringify({ id: 500, result: kind === 'question'
          ? { answers: { item: { answers: ['original answer'] } } } : { decision: 'accept' } }));
        assert.equal(f.upstream.length, writes + 1, 'original input remains answerable once');
        f.emit(f.terminal);
        assert.deepEqual(f.owner.messages.at(-1), f.terminal, 'valid receipt still settles the original input');
        if (viewer) assert.deepEqual(viewer.client.messages.at(-1), f.terminal);
      });
    }

    test(`${kind} invalid resolutions cannot exhaust recovery before the prompt (shared=${shared})`, t => {
      const f = fixture(t, shared, kind);
      if (!shared) f.broker.detach(f.owner);
      const recovering = f.resume();
      for (let requestId = 0; requestId < 513; requestId++)
        f.emit({ ...f.terminal, jsonrpc: '1.0', params: { ...f.terminal.params, requestId } });
      f.emit(f.terminal);
      recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread, 'invalid receipts must not fail the original task refresh');
      assert.deepEqual(recovering.client.messages.slice(1), [f.terminal], 'only the valid receipt crosses recovery');
      const deliveries = recovering.client.messages.length;
      f.emit(f.request);
      assert.equal(recovering.client.messages.length, deliveries, 'valid receipt keeps the restored prompt closed');
    });

    test(`${kind} legacy resolution may omit the version (shared=${shared})`, t => {
      const f = fixture(t, shared, kind);
      f.emit(f.request);
      const { jsonrpc, ...legacy } = f.terminal;
      f.emit(legacy);
      assert.equal(f.broker.serverRequests.has(500), false);
      assert.deepEqual(f.owner.messages.at(-1), legacy);
    });
  }
}
