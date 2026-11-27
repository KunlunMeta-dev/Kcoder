import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createChannelWorkerController } from '../src/channels/worker.mjs';
import { ChannelWorker } from '../src/channels/worker-client.mjs';
import { ChannelRuntime } from '../src/channels/runtime.mjs';
import { sdkWorkerEnvironment } from '../src/sdk-worker-env.mjs';
import { ChannelError } from '../src/errors.mjs';
import { FeishuReceiptFeedback } from '../src/adapters/feishu-receipt-feedback.mjs';
import { WEIXIN_CONNECTION_REASON_CODES } from '../src/adapters/weixin.mjs';

class Port extends EventEmitter {
  connected = true;
  frames = [];
  send(frame, callback) { this.frames.push(frame); this.emit('sent', frame); callback?.(); }
  disconnect() { this.connected = false; this.emit('disconnect'); }
  exit() { this.connected = false; }
}
let sequence = 100;
function rpc(port, method, params = {}) {
  const id = ++sequence;
  return new Promise(resolve => {
    const sent = frame => { if (frame.id === id && !frame.method) { port.off('sent', sent); resolve(frame); } };
    port.on('sent', sent); port.emit('message', { id, method, params });
  });
}

test('the production worker handlers project only an approved scoped reason in observer/start/state paths', async t => {
  const port = new Port(); let observer, reason = 'CHANNEL_INGRESS_FAILED', reconnects = 0;
  const adapter = { connectionState: () => 'connected', connectionFailureReason: () => reason,
    setConnectionObserver(value) { observer = value; }, async start() { observer(new Error('PRIVATE_SDK_CANARY')); },
    async stop() {}, async reconnect() { reconnects++; } };
  const worker = createChannelWorkerController({ port, adapters: () => new Map([['feishu', () => adapter]]), openStore: () => ({ close() {} }) });
  t.after(() => worker.close());
  const started = await rpc(port, 'start', { connection: { id: 'owned', platform: 'feishu', configuration: { appId: 'public-id' } },
    credentials: { appSecret: 'PRIVATE_CREDENTIAL_CANARY' }, directory: '/unused', generation: 7 });
  assert.deepEqual(started.result, { state: 'connected', connectionId: 'owned', generation: 7, reasonCode: 'CHANNEL_INGRESS_FAILED' });
  assert.deepEqual(port.frames.find(frame => frame.method === 'state').params, started.result);
  assert.deepEqual((await rpc(port, 'state')).result, started.result);
  assert.equal(JSON.stringify(port.frames).includes('CANARY'), false);
  assert.equal(reconnects, 0);
  reason = 'PRIVATE_REASON_CANARY'; observer({ packet: 'PRIVATE_PACKET_CANARY' });
  assert.equal((await rpc(port, 'state')).result.reasonCode, 'CHANNEL_INGRESS_FAILED');
  assert.equal(JSON.stringify(port.frames).includes('CANARY'), false);
  const count = port.frames.length; await worker.close(); observer();
  assert.equal(port.frames.length, count);
});

test('the real owned worker entry answers state over private IPC without starting an SDK or exposing stderr', async t => {
  const child = fork(fileURLToPath(new URL('../src/channels/worker.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: sdkWorkerEnvironment(),
  });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.connected) child.disconnect(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  let timer;
  try {
    const result = new Promise(resolve => child.on('message', frame => { if (frame.id === 1) resolve(frame); }));
    child.send({ id: 1, method: 'state', params: {} });
    const frame = await Promise.race([result, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('owned worker state timeout')), 3000); })]);
    assert.deepEqual(frame.result, { state: 'stopped' });
    child.disconnect();
    assert.equal((await exit)[0], 0);
  } finally { clearTimeout(timer); }
});

test('a lost ingress ACK exposes only the fixed reason and the original platform ID executes once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-ingress-diagnostic-'));
  const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null });
  let worker, executions = 0, sends = 0, lost = false;
  child.send = (frame, callback) => {
    if (frame.method === 'start') queueMicrotask(() => child.emit('message', { id: frame.id,
      result: { state: 'connected', connectionId: 'bot', generation: frame.params.generation } }));
    else if (frame.method === 'send') { sends++; queueMicrotask(() => child.emit('message', { id: frame.id, result: { state: 'accepted' } })); }
    else if (frame.method === 'stop') queueMicrotask(() => { child.emit('message', { id: frame.id, result: { stopped: true } }); child.connected = false; child.exitCode = 0; child.emit('exit', 0); });
    else if (!frame.method) { if (!lost) { lost = true; callback?.(new Error('PRIVATE_ACK_CANARY')); } else callback?.(); }
    return true;
  };
  const runtime = new ChannelRuntime({ directory, tasks: { run: async () => { executions++; return { text: 'answer' }; }, recover: async () => assert.fail('no replay/recovery') },
    workerFactory: (...args) => { worker = new ChannelWorker(...args, { forkWorker: () => child }); return worker; } });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  runtime.store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Fixture', configuration: { appId: 'public-id' } }, { appSecret: 'PRIVATE_CREDENTIAL_CANARY' });
  const event = { platform: 'feishu', botId: 'public-id', eventId: 'original-message', conversationId: 'chat', senderId: 'user', text: 'input', replyRef: 'PRIVATE_REPLY_CANARY' };
  const historical = runtime.store.receive('bot', { ...event, eventId: 'historical' }, { historical: true });
  runtime.bind(historical.chatId, { serverId: 'local', threadId: 'original-task' });
  await runtime.connect('bot');
  child.emit('message', { id: 'first-ingress', method: 'event', params: { event } });
  await new Promise(setImmediate);
  while (runtime.jobs.size) await Promise.all(runtime.jobs);
  child.emit('message', { id: 'redelivery', method: 'event', params: { event } });
  await new Promise(setImmediate);
  while (runtime.jobs.size) await Promise.all(runtime.jobs);
  assert.equal(executions, 1); assert.equal(sends, 1);
  assert.equal(worker.connectionState(), 'connected');
  assert.equal(worker.connectionFailureReason(), 'CHANNEL_INGRESS_FAILED');
  assert.equal(JSON.stringify({ state: worker.connectionState(), reasonCode: worker.connectionFailureReason() }).includes('CANARY'), false);
});

test('worker RPC failures never pass arbitrary SDK messages, codes or outcome objects', async t => {
  const port = new Port(); let rejected;
  const adapter = { connectionState: () => 'connected', setConnectionObserver() {}, async start() {}, async stop() {}, async send() { throw rejected; } };
  const worker = createChannelWorkerController({ port, adapters: () => new Map([['feishu', () => adapter]]), openStore: () => ({ close() {} }) });
  t.after(() => worker.close());
  await rpc(port, 'start', { connection: { id: 'owned', platform: 'feishu', configuration: {} }, directory: '/unused', generation: 1 });
  for (const value of [Object.assign(new Error('PRIVATE_MESSAGE_CANARY'), { code: 'PRIVATE_CODE_CANARY', externalOutcome: { packet: 'PRIVATE_OUTCOME_CANARY' } }),
    { message: 'PRIVATE_MESSAGE_CANARY', code: 'PLATFORM_AUTHORIZATION_FAILED', externalOutcome: 'failed' },
    new ChannelError('PRIVATE_TYPED_CODE_CANARY'), new Error('PLATFORM_AUTHORIZATION_FAILED')]) {
    rejected = value;
    const response = await rpc(port, 'send', { payload: {}, deliveryId: 'original-intent' });
    assert.equal(response.error, 'CHANNEL_WORKER_FAILED');
    assert.equal(response.externalOutcome, 'unknown');
    assert.equal(JSON.stringify(response).includes('CANARY'), false);
  }
});

test('approved local status, context and deadline errors retain only their defined outcomes', async t => {
  const port = new Port(); let rejected;
  const adapter = { connectionState: () => 'connected', setConnectionObserver() {}, async start() {}, async stop() {}, async send() { throw rejected; } };
  const worker = createChannelWorkerController({ port, adapters: () => new Map([['feishu', () => adapter]]), openStore: () => ({ close() {} }) });
  t.after(() => worker.close());
  await rpc(port, 'start', { connection: { id: 'owned', platform: 'feishu', configuration: {} }, directory: '/unused', generation: 1 });
  for (const [value, outcome] of [[Object.assign(new ChannelError('PLATFORM_AUTHORIZATION_FAILED'), { externalOutcome: 'failed' }), 'failed'],
    [Object.assign(new ChannelError('PLATFORM_HTTP_REJECTED'), { externalOutcome: 'unknown' }), 'unknown'],
    [Object.assign(new Error('PLATFORM_CONTEXT_EXPIRED'), { code: 'PLATFORM_CONTEXT_EXPIRED', externalOutcome: 'failed' }), 'failed'],
    [Object.assign(new ChannelError('STREAM_WINDOW_EXPIRED'), { externalOutcome: 'failed' }), 'failed'],
    [Object.assign(new ChannelError('CARD_CALLBACK_WINDOW_EXPIRED'), { externalOutcome: 'failed' }), 'failed'],
    [Object.assign(new ChannelError('PLATFORM_HTTP_REJECTED'), { externalOutcome: { packet: 'PRIVATE_OUTCOME_CANARY' } }), 'unknown']]) {
    rejected = value;
    const response = await rpc(port, 'send', { payload: {}, deliveryId: 'original-intent' });
    assert.equal(response.error, value.code ?? value.message);
    assert.equal(response.externalOutcome, outcome);
    assert.equal(JSON.stringify(response).includes('CANARY'), false);
  }
});

test('real Feishu feedback parsing keeps its fixed store diagnosis through worker RPC', async t => {
  const port = new Port();
  const feedback = new FeishuReceiptFeedback({ checkpoint: { load: async () => 'PRIVATE_FEEDBACK_CANARY', save: async () => {} }, current: () => true });
  const adapter = { connectionState: () => 'starting', setConnectionObserver() {}, async start() { await feedback.load(); }, async stop() {} };
  const worker = createChannelWorkerController({ port, adapters: () => new Map([['feishu', () => adapter]]), openStore: () => ({ close() {} }) });
  t.after(() => worker.close());
  const result = await rpc(port, 'start', { connection: { id: 'owned', platform: 'feishu', configuration: {} }, generation: 1 });
  assert.equal(result.error, 'FEISHU_FEEDBACK_STORE_INVALID');
  assert.equal(JSON.stringify(port.frames).includes('PRIVATE_FEEDBACK_CANARY'), false);
});

test('all published Weixin connection reasons cross observer and state RPC as exact finite codes', async t => {
  const port = new Port(); let observer, reason;
  const adapter = { connectionState: () => 'connected', connectionFailureReason: () => reason, setConnectionObserver(value) { observer = value; }, async start() {}, async stop() {} };
  const worker = createChannelWorkerController({ port, adapters: () => new Map([['weixin', () => adapter]]), openStore: () => ({ close() {} }) });
  t.after(() => worker.close());
  await rpc(port, 'start', { connection: { id: 'owned', platform: 'weixin', configuration: {} }, generation: 1 });
  for (reason of WEIXIN_CONNECTION_REASON_CODES) {
    observer(); assert.equal(port.frames.at(-1).params.reasonCode, reason);
    assert.equal((await rpc(port, 'state')).result.reasonCode, reason);
  }
  reason = null; observer(); assert.equal((await rpc(port, 'state')).result.reasonCode, undefined);
});
