import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

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
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original',
  } };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  return { broker, upstream, emit, resume, request, receipt };
}

const invalidEpochs = [false, 7, {}, [], '', ' '];

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const appServerEpoch of invalidEpochs) {
      test(`${kind}: invalid restored epoch ${JSON.stringify(appServerEpoch)} cannot retire unseen input (shared=${shared})`, t => {
        const f = fixture(t, kind, shared), owner = f.resume(); owner.finish();
        const delivered = owner.client.messages.length, writes = f.upstream.length;
        f.emit({ ...f.receipt, params: { ...f.receipt.params, appServerEpoch } });
        assert.equal(owner.client.messages.length, delivered, 'an invalid lifetime cannot certify a terminal receipt');
        f.emit(f.request);
        assert.deepEqual(owner.client.messages.at(-1), f.request, 'the later original prompt must stay available');
        assert.equal(f.broker.serverRequests.get(500), owner.client);
        f.broker.receive(owner.client, JSON.stringify({ id: 500,
          result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
        assert.equal(f.upstream.length, writes + 1, 'the original input reaches its waiter once');
        f.emit(f.receipt);
        assert.deepEqual(owner.client.messages.at(-1), f.receipt, 'the real receipt still settles the card');
        const settled = owner.client.messages.length;
        f.emit(f.request); f.emit(f.receipt);
        assert.equal(owner.client.messages.length, settled, 'confirmed input cannot reopen or be redelivered');
        assert.equal(f.upstream.length, writes + 1, 'reconciliation never repeats the answer');
      });
    }

    test(`${kind}: invalid restored epochs cannot exhaust recovery (shared=${shared})`, t => {
      const f = fixture(t, kind, shared), owner = shared ? f.resume() : null;
      owner?.finish();
      const recovering = f.resume();
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.emit({ ...f.receipt, params: { ...f.receipt.params,
          requestId: 900 + index, appServerEpoch: invalidEpochs[index % invalidEpochs.length] } });
      f.emit(f.receipt); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread, 'invalid epochs cannot cause handoff overflow');
      assert.deepEqual(recovering.client.messages.slice(1), [f.receipt]);
      if (owner) assert.deepEqual(owner.client.messages.slice(1), [f.receipt]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery performs only task reads');
    });

    for (const appServerEpoch of [undefined, null, 'epoch']) {
      test(`${kind}: compatible restored epoch ${appServerEpoch} still fences late input (shared=${shared})`, t => {
        const f = fixture(t, kind, shared), owner = f.resume(); owner.finish();
        const receipt = { ...f.receipt, params: { ...f.receipt.params, appServerEpoch } };
        f.emit(receipt);
        // Frames pass through JSONL, where omitted optional fields stay omitted.
        assert.deepEqual(owner.client.messages.at(-1), JSON.parse(JSON.stringify(receipt)));
        const delivered = owner.client.messages.length, writes = f.upstream.length;
        f.emit({ ...f.request, params: { ...f.request.params, appServerEpoch } });
        assert.equal(owner.client.messages.length, delivered, 'a valid early receipt still prevents reopening');
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.equal(f.upstream.length, writes);
      });
    }
  }
}
