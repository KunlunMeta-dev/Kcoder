import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelWorker } from '../src/channels/worker-client.mjs';
import { readUploadBuffer } from '../src/adapters/file-buffer.mjs';
import { mediaBufferBudget } from '../src/media-budget.mjs';
import { platformBinaryUpload } from '../src/upload-transport.mjs';
import { QQGateway } from '../src/adapters/qq-sdk.mjs';
import { BoundedPlatformEvents } from '../src/adapters/sdk-guards.mjs';

test('an IPC error during shutdown is not an exit receipt', { timeout: 2000 }, async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null });
  child.send = (message, callback) => {
    callback?.(null);
    queueMicrotask(() => child.emit('message', { id: message.id, result: { state: 'connected' } }));
  };
  let exited = false;
  child.kill = signal => {
    child.emit('error', new Error('owned IPC failure'));
    setTimeout(() => {
      exited = true;
      child.signalCode = signal;
      child.emit('exit', null, signal);
    }, 20);
    return true;
  };
  const worker = new ChannelWorker({ id: 'owned-fixture', platform: 'feishu' }, {}, '/unused', { forkWorker: () => child });
  await worker.start(async () => ({ accepted: true }));
  await worker.stop();
  assert.equal(exited, true);
  assert.equal(worker.pending.size, 0);
});

test('cancelling a stalled media read settles and releases its reservation', { timeout: 2000 }, async () => {
  const owner = new AbortController();
  const before = mediaBufferBudget.reserved;
  const file = { expectedBytes: 1, sha256: 'a'.repeat(64), byteStream: () => ({
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
  }) };
  const pending = readUploadBuffer(file, { signal: owner.signal });
  owner.abort(new Error('owned media cancellation'));
  await assert.rejects(pending, /owned media cancellation|aborted/i);
  assert.equal(mediaBufferBudget.reserved, before);
});

test('a caller cancellation signal cannot remove the upload deadline', async t => {
  const deadline = new AbortController(), owner = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.ok(milliseconds >= 30000 && milliseconds <= 300000);
    return deadline.signal;
  });
  const pending = platformBinaryUpload('https://open.feishu.cn/fixture', {
    hosts: ['open.feishu.cn'], expectedBytes: 1, signal: owner.signal,
    byteStream: (async function* () { yield Buffer.from('x'); })(),
    fetchImpl: async (_url, options) => {
      assert.notEqual(options.signal, owner.signal);
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  });
  deadline.abort(new Error('owned upload deadline'));
  await assert.rejects(pending, error => error.code === 'PLATFORM_UPLOAD_UNCONFIRMED'
    && error.externalOutcome === 'unknown' && error.cause.message === 'owned upload deadline');
  assert.equal(owner.signal.aborted, false);
});

test('QQ RESUME waits for both message and raw-event callbacks from one dispatch', async () => {
  const events = new BoundedPlatformEvents(), owner = new AbortController();
  let accept;
  const durable = new Promise(resolve => { accept = resolve; });
  const gateway = new QQGateway({ account: { accountId: 'owned', appId: 'fixture', clientSecret: 'fixture' },
    events, abortSignal: owner.signal, getAccessToken: async () => 'fixture',
    getGatewayUrl: async () => 'wss://api.sgroup.qq.com/fixture',
    onMessage: () => durable, onRawEvent: async () => {},
  });
  const socket = { terminate() {} }; gateway.currentWs = socket; gateway.lastSeq = 1;
  try {
    gateway.handlePayload(socket, { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2,
      d: { id: 'owned-input', author: { user_openid: 'owned-user' }, content: 'fixture' } }, 'fixture');
    await new Promise(setImmediate);
    assert.equal(gateway.lastSeq, 1, 'an unrelated completed callback is not an ingress receipt');
    accept(); await new Promise(setImmediate);
    assert.equal(gateway.lastSeq, 2);
  } finally { accept(); events.close(); }
});
