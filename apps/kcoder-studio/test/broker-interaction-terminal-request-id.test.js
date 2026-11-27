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
  const receipt = { method: `${kind}/resolved`, params: {
    threadId: 'thread', turnId: 'turn', [field]: 'original', appServerEpoch: 'epoch',
    requestId: 500, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}),
  } };
  return { broker, upstream, emit, resume, receipt };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const requestId of [undefined, null, true, {}, [], -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', ' ']) {
      test(`${kind}: invalid requestId=${JSON.stringify(requestId)} cannot overflow ${shared ? 'shared' : 'exclusive'} refresh`, t => {
        const f = fixture(t, kind, shared);
        if (shared) { const owner = f.resume(); owner.finish(); }
        const pending = f.resume();
        // Distinct frames must be rejected by identity, not hidden by deduplication.
        for (let index = 0; index < 66; index++) f.emit({ ...f.receipt, params: {
          ...f.receipt.params, requestId, reason: `invalid-${index}`,
        } });
        f.emit(f.receipt); pending.finish();
        assert.ok(pending.client.messages[0]?.result?.thread, 'invalid transport IDs cannot cause -32047');
        assert.deepEqual(pending.client.messages.filter(message => message.method === `${kind}/resolved`), [f.receipt]);
        assert.equal(f.upstream.some(message => message.method !== 'thread/resume'), false, 'recovery submits no answers or turns');
      });
    }

    for (const requestId of [0, 500, 'legacy-request']) {
      test(`${kind}: valid requestId=${requestId} retains ${shared ? 'shared' : 'exclusive'} restored receipt replay`, t => {
        const f = fixture(t, kind, shared);
        if (shared) { const owner = f.resume(); owner.finish(); }
        const pending = f.resume();
        const receipt = { ...f.receipt, params: { ...f.receipt.params, requestId } };
        f.emit(receipt); pending.finish();
        assert.deepEqual(pending.client.messages.filter(message => message.method === `${kind}/resolved`), [receipt]);
        const delivered = pending.client.messages.length;
        f.emit(receipt);
        f.emit({ id: requestId, method: `${kind}/request`, params: receipt.params });
        assert.equal(pending.client.messages.length, delivered, 'replay cannot reopen the original card');
      });
    }
  }
}
