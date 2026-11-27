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
  const result = kind === 'question' ? { answers: { item: { answers: ['继续 😀'] } } } : { decision: 'accept' };
  const reply = response => broker.receive(owner, JSON.stringify({ id: 500, ...response }));
  const resolve = () => {
    const receipt = { method: `${kind}/resolved`, params: { ...binding, requestId: 500, reason: 'client_response' } };
    emit(receipt);
    assert.deepEqual(owner.messages.at(-1), receipt);
    if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
  };
  return { broker, owner, upstream, binding, result, reply, resolve };
}

const invalidReplies = [
  ['error data string', () => ({ error: { code: -32800, message: 'cancel', data: '\ud800' } })],
  ['nested error data value', () => ({ error: { code: -32800, message: 'cancel', data: { details: ['\udfff'] } } })],
  ['nested error data key', () => ({ error: { code: -32800, message: 'cancel', data: { details: { '\ud800': true } } } })],
  ['unknown error field', () => ({ error: { code: -32800, message: 'cancel', extra: '\udfff' } })],
  ['unknown result value', result => ({ result: { ...result, extra: { details: ['\ud800'] } } })],
  ['unknown result key', result => ({ result: { ...result, extra: { '\udfff': true } } })],
  ['unknown envelope value', result => ({ result, extra: '\ud800' })],
];

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const [name, makeReply] of invalidReplies) {
      test(`${kind}: ${name} cannot consume original input (shared=${shared})`, t => {
        const f = fixture(t, shared, kind), writes = f.upstream.length;
        f.reply(makeReply(f.result));
        assert.equal(f.upstream.length, writes, 'the whole frame must be readable by Rust before forwarding');
        assert.equal(f.broker.serverRequests.get(500), f.owner);
        assert.equal(f.broker.repliedServerRequests.has(500), false);
        assert.deepEqual(f.owner.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
          params: { ...f.binding, requestId: 500, reason: 'invalid_response' } });
        f.reply({ result: f.result });
        assert.equal(f.upstream.length, writes + 1, 'only the corrected original reply reaches the waiter');
        assert.equal(f.upstream.at(-1).id, 500);
        assert.equal(f.broker.serverRequests.has(500), false);
        f.resolve();
        assert.equal(f.upstream.length, writes + 1, 'the receipt never replays input');
      });
    }

    test(`${kind}: valid nested Unicode data is preserved (shared=${shared})`, t => {
      const f = fixture(t, shared, kind), writes = f.upstream.length;
      const error = { code: -32800, message: '用户取消 😀', data: { '详情 😀': ['中文', '\\ud800', null, 42, true] } };
      f.reply({ error });
      assert.equal(f.upstream.length, writes + 1);
      assert.deepEqual(f.upstream.at(-1).error, error, 'do not sanitize data or reject literal escape text');
    });
  }
}
