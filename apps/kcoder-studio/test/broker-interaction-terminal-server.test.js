import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  // Native sessionId identifies app-server; the Gateway target ID is different.
  broker.initializeResponse = { result: { sessionId: 'original-app-server' } };
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    serverId: 'server-original-app-server', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', [field]: 'original',
  } };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  const foreign = { ...receipt, params: { ...receipt.params, serverId: 'another-app-server' } };
  return { broker, upstream, emit, resume, request, receipt, foreign };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    test(`${kind}: foreign server cannot consume ${shared ? 'shared' : 'exclusive'} input or its real receipt`, t => {
      const f = fixture(t, kind, shared), owner = f.resume(); owner.finish();
      f.emit(f.request);
      const delivered = owner.client.messages.length;
      f.emit(f.foreign);
      assert.equal(f.broker.serverRequests.get(500), owner.client, 'foreign terminal cannot consume the waiter');
      assert.equal(owner.client.messages.length, delivered, 'foreign terminal cannot close the visible card');
      const before = f.upstream.length;
      const reply = () => f.broker.receive(owner.client, JSON.stringify({ id: 500,
        result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
      reply();
      assert.equal(f.upstream.length, before + 1);
      f.emit(f.receipt);
      if (shared) reply();
      f.emit(f.receipt);
      assert.deepEqual(owner.client.messages.at(-1), f.receipt);
      assert.equal(f.upstream.length, before + 1, 'receipt replay sends no second answer');
    });

    test(`${kind}: foreign restored receipts cannot overflow ${shared ? 'shared' : 'exclusive'} refresh`, t => {
      const f = fixture(t, kind, shared);
      if (shared) { const owner = f.resume(); owner.finish(); }
      const pending = f.resume();
      for (let index = 0; index < 66; index++) f.emit({ ...f.foreign, params: {
        ...f.foreign.params, requestId: 900 + index,
      } });
      f.emit(f.receipt); pending.finish();
      assert.ok(pending.client.messages[0]?.result?.thread, 'foreign receipts cannot cause -32047');
      assert.deepEqual(pending.client.messages.filter(message => message.method === `${kind}/resolved`), [f.receipt]);
      assert.equal(f.upstream.some(message => message.method !== 'thread/resume'), false);
    });
  }

  for (const legacy of [false, true]) {
    test(`${kind}: foreign early terminal cannot retire a prompt; legacy receipt=${legacy}`, t => {
      const f = fixture(t, kind, true), owner = f.resume(); owner.finish();
      const delivered = owner.client.messages.length;
      f.emit(f.foreign);
      assert.equal(owner.client.messages.length, delivered);
      f.emit(f.request);
      assert.deepEqual(owner.client.messages.at(-1), f.request);
      // Older authoritative receipts omit serverId; keep that compatibility.
      const { serverId: _serverId, ...params } = f.receipt.params;
      const receipt = legacy ? { ...f.receipt, params } : f.receipt;
      f.emit(receipt);
      assert.deepEqual(owner.client.messages.at(-1), receipt);
    });
  }
}
