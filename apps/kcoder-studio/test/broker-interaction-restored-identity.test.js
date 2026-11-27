import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared) {
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
    threadId: 'thread', turnId: 'turn', [field]: 'original', appServerEpoch: 'epoch',
  } };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  return { broker, upstream, emit, resume, field, request, receipt };
}

for (const kind of ['question', 'approval']) {
  for (const field of ['threadId', 'turnId', kind === 'question' ? 'questionId' : 'approvalId']) {
    for (const value of [undefined, null, 42, '', ' ']) {
      test(`${kind}: restored ${field}=${value} cannot retire an unseen original prompt`, t => {
        const f = fixture(t, kind, true), owner = f.resume(); owner.finish();
        const delivered = owner.client.messages.length;
        f.emit({ ...f.receipt, params: { ...f.receipt.params, [field]: value } });
        assert.equal(owner.client.messages.length, delivered, 'an incomplete receipt cannot close a card');
        f.emit(f.request);
        assert.deepEqual(owner.client.messages.at(-1), f.request, 'the original restored prompt remains available');
        assert.equal(f.broker.serverRequests.get(500), owner.client);
        const before = f.upstream.length;
        f.broker.receive(owner.client, JSON.stringify({ id: 500,
          result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
        assert.equal(f.upstream.length, before + 1, 'the original answer still reaches its waiter once');
        f.emit(f.receipt);
        assert.deepEqual(owner.client.messages.at(-1), f.receipt);
      });
    }
  }

  for (const shared of [false, true]) {
    test(`${kind}: incomplete restored identities cannot exhaust ${shared ? 'shared' : 'exclusive'} recovery`, t => {
      const f = fixture(t, kind, shared);
      if (shared) { const owner = f.resume(); owner.finish(); }
      const pending = f.resume();
      for (let index = 0; index < 66; index++) f.emit({ ...f.receipt, params: {
        ...f.receipt.params, requestId: 900 + index, [f.field]: undefined,
      } });
      f.emit(f.receipt); pending.finish();
      assert.ok(pending.client.messages[0]?.result?.thread, 'invalid identities cannot turn refresh into buffer overflow');
      assert.deepEqual(pending.client.messages.filter(message => message.method === `${kind}/resolved`), [f.receipt]);
      assert.equal(f.upstream.some(message => message.method !== 'thread/resume'), false, 'recovery sends no answers or turns');
    });
  }
}
