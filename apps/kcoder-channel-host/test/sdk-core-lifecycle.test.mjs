import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { FeishuAdapter, DingTalkAdapter, WeComAdapter } from '../src/adapters/sdk.mjs';
import { hardenDingTalkSdk, hardenWecomSdk, BoundedPlatformEvents } from '../src/adapters/sdk-guards.mjs';
import { publicError } from '../src/errors.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function tokenFixture(platform) {
  const pending = deferred(); let calls = 0;
  const body = value => platform === 'feishu' ? { code: 0, tenant_access_token: value, expire: 3600 }
    : { accessToken: value, expireIn: 3600 };
  const transport = async () => { calls++; return body(calls === 1 ? await pending.promise : 'fresh-fixture-token'); };
  const adapter = platform === 'feishu'
    ? new FeishuAdapter({ configuration: { appId: 'inert-app' }, credentials: { appSecret: 'inert-secret' }, transport })
    : new DingTalkAdapter({ configuration: { clientId: 'inert-app' }, credentials: { clientSecret: 'inert-secret' }, transport });
  return { adapter, pending, calls: () => calls };
}

for (const platform of ['feishu', 'dingtalk']) {
  test(platform + ' concurrent token consumers share the original lookup', async () => {
    const fixture = tokenFixture(platform), waits = [];
    try {
      waits.push(fixture.adapter.accessToken(), fixture.adapter.accessToken());
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fixture.calls(), 1);
      fixture.pending.resolve('original-fixture-token');
      assert.deepEqual(await Promise.all(waits), ['original-fixture-token', 'original-fixture-token']);
    } finally { fixture.pending.resolve('original-fixture-token'); await Promise.allSettled(waits); await fixture.adapter.stop(); }
  });

  test(platform + ' a late closed-generation token cannot repopulate the cache', async () => {
    const fixture = tokenFixture(platform);
    const original = fixture.adapter.accessToken();
    const observed = original.then(value => ({ value }), error => ({ error }));
    try {
      await new Promise(resolve => setImmediate(resolve));
      fixture.adapter.closeTransport();
      fixture.pending.resolve('old-fixture-token');
      const result = await observed;
      assert.equal(result.error?.code, 'STALE_PLATFORM_SOURCE');
      assert.equal(await fixture.adapter.accessToken(), 'fresh-fixture-token');
      assert.equal(fixture.calls(), 2);
    } finally { fixture.pending.resolve('old-fixture-token'); await observed; await fixture.adapter.stop(); }
  });

  test(platform + ' cancellation belongs to one token waiter, not its healthy peer', async () => {
    const fixture = tokenFixture(platform), controller = new AbortController();
    const first = fixture.adapter.accessToken(controller.signal), second = fixture.adapter.accessToken();
    const cancelled = first.then(() => assert.fail('cancelled waiter resolved'), error => assert.equal(error.name, 'AbortError'));
    try {
      controller.abort(); await cancelled;
      await new Promise(resolve => setImmediate(resolve)); assert.equal(fixture.calls(), 1);
      fixture.pending.resolve('shared-fixture-token');
      assert.equal(await second, 'shared-fixture-token');
      assert.equal(await fixture.adapter.accessToken(), 'shared-fixture-token');
      assert.equal(fixture.calls(), 1);
    } finally { fixture.pending.resolve('shared-fixture-token'); await Promise.allSettled([cancelled, second]); await fixture.adapter.stop(); }
  });
}

test('DingTalk legacy media token consumers share lookup without replaying uploads', async () => {
  const pending = deferred(); let calls = 0, uploads = 0;
  const adapter = new DingTalkAdapter({ configuration: { clientId: 'inert-app' }, credentials: { clientSecret: 'inert-secret' },
    transport: async () => { calls++; await pending.promise; return { errcode: 0, access_token: 'legacy-fixture-token', expires_in: 3600 }; },
    multipartTransport: async () => { uploads++; return { errcode: 0, media_id: 'fixture-media' }; },
  });
  const waits = [];
  try {
    const file = () => ({ filename: 'fixture.txt', mediaType: 'text/plain', expectedBytes: 1 });
    waits.push(adapter.upload(file(), {}), adapter.upload(file(), {}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    pending.resolve(); await Promise.all(waits);
    assert.equal(uploads, 2, 'each explicitly requested upload remains its own operation');
  } finally { pending.resolve(); await Promise.allSettled(waits); await adapter.stop(); }
});

class WecomFixture extends EventEmitter {
  constructor() { super(); this.wsManager = { pendingAcks: new Map(), replyQueues: new Map(), sendReply: async () => ({}) }; }
  connect() { this.emit('authenticated'); }
  disconnect() { this.emit('disconnected'); }
}

class DingFixture {
  constructor() { this.sslopts = { rejectUnauthorized: true }; this.config = { subscriptions: [] }; this.acks = 0; }
  async getEndpoint() { return this; }
  _connect() { this.socket = new EventEmitter(); this.socket.readyState = 1; return Promise.resolve(); }
  onSystem() {}
  registerCallbackListener(_topic, callback) { this.callback = callback; }
  socketCallBackResponse() { this.acks++; }
  async connect() { await this.getEndpoint(); await this._connect(); this.connected = true; this.registered = true; this.onSystem({}); }
  disconnect() { this.connected = false; this.registered = false; }
}

class FeishuFixture {
  constructor(options) { this.options = options; this.state = 'idle'; this.wsConfig = { setWSInstance() {} }; this.dataCache = { cache: new Map(), mergeData() {} }; }
  async start({ eventDispatcher }) { this.dispatcher = eventDispatcher; this.state = 'connected'; this.options.onReady?.(); }
  getConnectionStatus() { return { state: this.state }; }
  close() { this.state = 'idle'; }
}

function ingressFixture(platform) {
  if (platform === 'feishu') return new FeishuAdapter({ configuration: { appId: 'inert-bot', channelId: 'owned-channel', features: { showTyping: false } }, credentials: { appSecret: 'inert-secret' },
    sdk: { WSClient: FeishuFixture, EventDispatcher: class { register(routes) { this.routes = routes; return this; } } },
    transport: async url => url.includes('/auth/') ? { code: 0, tenant_access_token: 'inert-token', expire: 3600 } : { code: 0, bot: { open_id: 'owned-bot-open' } },
    checkpoint: { load: async () => null, save: async () => {} },
  });
  if (platform === 'dingtalk') return new DingTalkAdapter({ configuration: { clientId: 'inert-bot', channelId: 'owned-channel' }, credentials: { clientSecret: 'inert-secret' },
    sdk: { DWClient: DingFixture, TOPIC_ROBOT: 'robot' }, transport: async () => ({ endpoint: 'wss://gateway.dingtalk.com', ticket: 'inert' }) });
  return new WeComAdapter({ configuration: { botId: 'inert-bot', channelId: 'owned-channel' }, credentials: { secret: 'inert-secret' }, sdk: { WSClient: WecomFixture } });
}

function inbound(platform, id, card = false) {
  if (platform === 'feishu') return { header: { event_id: id, tenant_key: 'owned-tenant' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'owned-user' } },
    message: { message_id: id, chat_id: 'owned-chat', chat_type: 'p2p', message_type: 'text', create_time: String(Date.now()), content: JSON.stringify({ text: 'PRIVATE_INGRESS_CANARY' }) } } };
  if (platform === 'dingtalk') return { headers: { messageId: id }, data: JSON.stringify({ msgId: id, conversationType: '1', conversationId: 'owned-chat',
    senderCorpId: 'owned-tenant', senderStaffId: 'owned-user', createAt: Date.now(), text: { content: 'PRIVATE_INGRESS_CANARY' } }) };
  return { cmd: card ? 'aibot_event_callback' : 'aibot_msg_callback', headers: { req_id: id }, body: { aibotid: 'inert-bot', msgid: id,
    from: { userid: 'owned-user', corpid: 'owned-tenant' }, chatid: 'owned-chat', chattype: 'single', create_time: Math.floor(Date.now() / 1000),
    ...(card ? { msgtype: 'event', event: { eventtype: 'template_card_event', event_key: 'owned-action', task_id: 'owned-task' } }
      : { msgtype: 'text', text: { content: 'PRIVATE_INGRESS_CANARY' } }) } };
}

function emitInbound(adapter, platform, id, card) {
  if (platform === 'dingtalk') adapter.client.callback(inbound(platform, id));
  else if (platform === 'feishu') void adapter.client.dispatcher.routes['im.message.receive_v1'](inbound(platform, id)).catch(() => {});
  else adapter.client.emit(card ? 'event.template_card_event' : 'message', inbound(platform, id, card));
}

test('DingTalk malformed content never ACKs, while a declared unsupported kind ACKs without ingress', async () => {
  const adapter = ingressFixture('dingtalk'); let calls = 0;
  try {
    await adapter.start(async () => { calls++; return { accepted: true }; });
    const client = adapter.client;
    client.callback({ headers: { messageId: 'owned-malformed' }, data: 'null' });
    await idle(adapter); assert.equal(client.acks, 0); assert.equal(calls, 0);
    const unsupported = inbound('dingtalk', 'owned-unsupported');
    const body = JSON.parse(unsupported.data); delete body.text;
    unsupported.data = JSON.stringify({ ...body, msgtype: 'unknownMsgType', content: { unknownMsgType: 'Unsupported' } });
    client.callback(unsupported);
    await idle(adapter); assert.equal(client.acks, 1); assert.equal(calls, 0);
    client.callback(inbound('dingtalk', 'owned-valid'));
    await idle(adapter); assert.equal(client.acks, 2); assert.equal(calls, 1);
  } finally { await adapter.stop(); }
});

async function idle(adapter) {
  const deadline = Date.now() + 1000;
  do { await new Promise(resolve => setImmediate(resolve)); if (!adapter.events.running) return; } while (Date.now() < deadline);
  throw new Error('owned ingress fixture did not settle');
}

async function until(check) {
  const deadline = Date.now() + 1000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('owned fixture observation timed out'); await new Promise(resolve => setImmediate(resolve)); }
}

for (const [platform, card] of [['feishu', false], ['dingtalk', false], ['wecom', false], ['wecom', true]]) {
  test(platform + (card ? ' card' : ' message') + ' reports only a sticky fixed ingress-confirmation reason', async () => {
    const adapter = ingressFixture(platform), observations = []; let fail = true, calls = 0;
    adapter.setConnectionObserver(() => observations.push({ state: adapter.connectionState(), reason: adapter.connectionFailureReason?.() ?? null }));
    try {
      await adapter.start(async () => { calls++; if (fail) throw new Error('PRIVATE_ERROR_CANARY'); return { durablyAccepted: true }; });
      const client = adapter.client;
      emitInbound(adapter, platform, 'owned-failed', card);
      await idle(adapter);
      assert.equal(calls, 1);
      assert.equal(adapter.connectionFailureReason?.(), 'CHANNEL_INGRESS_FAILED');
      assert.equal(adapter.connectionState(), 'connected');
      assert.ok(observations.some(value => value.reason === 'CHANNEL_INGRESS_FAILED'));
      assert.ok(!JSON.stringify(observations).includes('PRIVATE_'));
      if (platform === 'dingtalk') assert.equal(client.acks, 0, 'no SDK ACK before a known durable ingress result');
      fail = false;
      emitInbound(adapter, platform, 'owned-other-success', card);
      await idle(adapter);
      assert.equal(calls, 2);
      assert.equal(adapter.connectionFailureReason(), 'CHANNEL_INGRESS_FAILED', 'another event does not reconcile the failed original');
    } finally { await adapter.stop(); }
  });
}

test('WeCom admission cancellation does not revoke the connected SDK owner', async () => {
  const adapter = ingressFixture('wecom'), controller = new AbortController(); let calls = 0;
  try {
    await adapter.start(async () => { calls++; }, { signal: controller.signal });
    controller.abort(); adapter.client.emit('message', inbound('wecom', 'owned-after-cancel'));
    await idle(adapter); assert.equal(calls, 1);
    const client = adapter.client; await adapter.stop();
    client.emit('message', inbound('wecom', 'owned-after-stop'));
    await idle(adapter); assert.equal(calls, 1);
  } finally { await adapter.stop(); }
});

test('a late retired-generation ingress failure does not contaminate the replacement SDK', async () => {
  const adapter = ingressFixture('wecom'), pending = deferred(); let entered = false;
  try {
    await adapter.start(() => { entered = true; return pending.promise; });
    adapter.client.emit('message', inbound('wecom', 'owned-old-generation'));
    await until(() => entered);
    adapter.client.emit('disconnected'); await adapter.reconnect();
    pending.reject(new Error('PRIVATE_RETIRED_ERROR_CANARY')); await idle(adapter);
    assert.equal(adapter.connectionState(), 'connected');
    assert.equal(adapter.connectionFailureReason?.() ?? null, null);
  } finally { pending.resolve(); await adapter.stop(); }
});

test('the actual DingTalk SDK keepalive does not publish unchanged connection state', { timeout: 5000 }, async t => {
  const { DWClient } = await import('dingtalk-stream');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false }); await once(server, 'listening');
  const client = new DWClient({ clientId: 'inert-app', clientSecret: 'inert-secret', debug: false, keepAlive: false, autoReconnect: false });
  t.after(() => new Promise(resolve => { client.disconnect(); client.socket?.terminate(); for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  client.getEndpoint = async () => { await new Promise(resolve => setImmediate(resolve)); client.dw_url = 'ws://127.0.0.1:' + server.address().port; return client; };
  let notifications = 0;
  hardenDingTalkSdk(client, { onConnectionChange: () => { notifications++; } });
  await client.connect();
  const opened = notifications;
  client.onSystem({ headers: { topic: 'ping' }, data: '' });
  client.onSystem({ headers: { topic: 'KEEPALIVE' }, data: '' });
  assert.equal(notifications, opened);
  client.onSystem({ headers: { topic: 'REGISTERED' }, data: '' });
  assert.equal(notifications, opened + 1);
});

test('event queue close fences queued work and preserves the admitted original result', async () => {
  const queue = new BoundedPlatformEvents(1), original = deferred(); let entered = 0;
  const active = queue.run(() => { entered++; return original.promise; });
  const queued = queue.run(() => { entered++; return { durablyAccepted: false }; });
  queue.close(); await assert.rejects(queued, { code: 'CHANNEL_STOPPED' });
  original.resolve({ durablyAccepted: true });
  assert.deepEqual(await active, { durablyAccepted: true });
  assert.equal(entered, 1);
  await assert.rejects(queue.run(() => {}), { code: 'CHANNEL_STOPPED' });
});

test('an already cancelled SDK invocation retains a fixed cancellation outcome', () => {
  let writes = 0;
  const client = { wsManager: { pendingAcks: new Map(), replyQueues: new Map(), sendReply: async () => { writes++; } } };
  const run = hardenWecomSdk(client), controller = new AbortController(); controller.abort();
  assert.throws(() => run(controller.signal, () => client.wsManager.sendReply('owned-cancelled', {}, 'aibot_send_msg')), error => {
    assert.deepEqual(publicError(error), { code: 'PLATFORM_SEND_CANCELLED', recovery: 'reconcile_original', messageKey: 'connectivity.platform_send_cancelled' });
    return true;
  });
  assert.equal(writes, 0);
});

test('a card callback timeout observes a later rejection without replay or unhandled rejection', { timeout: 5000 }, async t => {
  const adapter = ingressFixture('feishu'), original = deferred(), unhandled = [];
  const observe = error => unhandled.push(error);
  process.on('unhandledRejection', observe);
  t.after(() => process.removeListener('unhandledRejection', observe));
  const packet = { header: { event_id: 'owned-late-card', tenant_key: 'owned-tenant' }, event: { operator: { open_id: 'owned-user' }, context: { open_chat_id: 'owned-chat' },
    action: { value: { kcoderQuestionAction: 'owned-question-action' }, form_value: { answer: 'owned-answer' } } } };
  let calls = 0;
  try {
    await assert.rejects(adapter.handleCardAction(packet, () => { calls++; return original.promise; }), { code: 'CARD_ACCEPTANCE_UNCONFIRMED', recovery: 'reconcile_original' });
    original.reject(new Error('PRIVATE_LATE_ERROR_CANARY'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled.length, 0); assert.equal(calls, 1);
  } finally { original.resolve(); await adapter.stop(); }
});
