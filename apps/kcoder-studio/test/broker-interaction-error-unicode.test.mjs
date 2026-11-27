import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const binding = { threadId: 'thread', turnId: 'turn',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original', appServerEpoch: 'epoch' };
  emit({ id: 500, method: `${kind}/request`, params: { ...binding, ...(kind === 'question'
    ? { questions: [{ id: 'item', prompt: 'Continue?' }] } : { availableDecisions: ['accept'] }) } });
  assert.equal(broker.serverRequests.get(500), owner);
  const reply = response => broker.receive(owner, JSON.stringify({ id: 500, ...response }));
  const resolve = reason => {
    const receipt = { method: `${kind}/resolved`, params: { ...binding, requestId: 500, reason } };
    emit(receipt);
    assert.deepEqual(owner.messages.at(-1), receipt);
    if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
    assert.equal(broker.serverRequests.has(500), false);
  };
  return { broker, owner, upstream, binding, reply, resolve };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const message of ['\ud800', 'cancel \udfff']) {
      test(`${kind}: invalid Unicode error ${JSON.stringify(message)} retains original input (shared=${shared})`, t => {
        const f = fixture(t, shared, kind), writes = f.upstream.length;
        f.reply({ error: { code: -32800, message } });
        assert.equal(f.upstream.length, writes, 'Rust cannot parse this error; it must not consume the original waiter');
        assert.equal(f.broker.serverRequests.get(500), f.owner);
        assert.deepEqual(f.owner.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
          params: { ...f.binding, requestId: 500, reason: 'invalid_response' } });
        const result = kind === 'question'
          ? { answers: { item: { answers: ['继续 😀'] } } } : { decision: 'accept' };
        f.reply({ result });
        assert.equal(f.upstream.length, writes + 1, 'the corrected original reply is forwarded exactly once');
        assert.equal(f.upstream.at(-1).id, 500);
        if (kind === 'question') assert.deepEqual(f.upstream.at(-1).result.answers, result.answers);
        else assert.equal(f.upstream.at(-1).result.decision, 'accept');
        f.resolve('client_response');
        assert.equal(f.upstream.length, writes + 1, 'the receipt does not replay input');
      });
    }

    test(`${kind}: valid Unicode cancellation still settles original input (shared=${shared})`, t => {
      const f = fixture(t, shared, kind), writes = f.upstream.length;
      const error = { code: -32800, message: '用户取消 😀' };
      f.reply({ error });
      assert.equal(f.upstream.length, writes + 1);
      assert.deepEqual(f.upstream.at(-1).error, error, 'preserve the original cancellation text');
      f.resolve('client_error');
      assert.equal(f.upstream.length, writes + 1);
    });
  }
}
