import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter } from '../src/adapters/sdk.mjs';
import { FeishuReceiptFeedback } from '../src/adapters/feishu-receipt-feedback.mjs';

const event = {platform: 'feishu', channelId: 'second-connection', botId: 'second-app', tenantId: 'tenant',
  conversationId: 'chat', sourceMessageId: 'original-message', text: 'owned input'};
const tick = () => new Promise(resolve => setImmediate(resolve));
function checkpoint() {
  let cursor = '';
  return {load: async () => cursor, save: async value => {cursor = value;}};
}
function feedback({store = checkpoint(), post = async () => ({state: 'accepted', reactionId: 'real-shaped-reaction'}), current = () => true} = {}) {
  const instance = new FeishuReceiptFeedback({checkpoint: store, post, current});
  return {instance, store};
}

test('receipt intent is durable before Typing starts, and a pending POST does not block the caller', async () => {
  const order = []; let release;
  const store = checkpoint(), save = store.save;
  store.save = async value => {await save(value); order.push('durable');};
  const {instance} = feedback({store, post: () => {order.push('Typing'); return new Promise(resolve => {release = resolve;});}});
  await instance.load(); await instance.receive(event); order.push('returned');
  assert.deepEqual(order, ['durable', 'Typing', 'returned']);
  assert.equal(JSON.parse(await store.load()).rows[0].state, 'unknown');
  release({state: 'accepted', reactionId: 'owned-reaction'}); await tick();
  assert.equal(JSON.parse(await store.load()).rows[0].state, 'accepted');
});

test('duplicate deliveries and reconnects do not repeat a reaction, including an unknown original result', async () => {
  let posts = 0;
  const store = checkpoint(), post = async () => {posts++; throw new Error('original HTTP result lost');};
  const a = feedback({store, post}).instance; await a.load();
  assert.equal(await a.receive(event), true); await tick();
  assert.equal(await a.receive({...event, eventId: 'redelivery-with-another-envelope'}), false);
  const b = feedback({store, post}).instance; await b.load();
  assert.equal(await b.receive(event), false); assert.equal(posts, 1);
  assert.equal(JSON.parse(await store.load()).rows[0].state, 'unknown');
});

test('chat, topic and connection identities isolate receipt feedback', async () => {
  let posts = 0; const {instance} = feedback({post: async () => {posts++; return {state: 'accepted'};}});
  await instance.load();
  for (const patch of [{}, {channelId: 'first-connection', botId: 'first-app'}, {conversationId: 'other-chat'}, {topicId: 'actual-topic'}]) {
    assert.equal(await instance.receive({...event, ...patch}), true);
  }
  await tick(); assert.equal(posts, 4);
});

test('platform refusal is persisted and does not produce a status message or retry', async () => {
  const {instance, store} = feedback({post: async () => ({state: 'failed', code: 'PLATFORM_REACTION_REJECTED'})});
  await instance.load(); await instance.receive(event); await tick();
  const row = JSON.parse(await store.load()).rows[0];
  assert.equal(row.state, 'failed'); assert.equal(row.code, 'PLATFORM_REACTION_REJECTED');
  assert.equal(await instance.receive(event), false);
});

test('concurrent redelivery reserves once and the bounded checkpoint retains only metadata', async () => {
  let posts = 0;
  const {instance, store} = feedback({post: async () => {posts++; return {state: 'accepted', reactionId: 'r'.repeat(128)};}});
  await instance.load();
  await Promise.all(Array.from({length: 12}, () => instance.receive(event))); await tick();
  assert.equal(posts, 1);
  for (let index = 0; index < 280; index++) {
    await instance.receive({...event, sourceMessageId: 'message-' + index}); await tick();
  }
  const raw = await store.load(), value = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) <= 60 * 1024); assert.ok(value.rows.length <= 256);
  assert.ok(!raw.includes('owned input')); assert.ok(!raw.includes('second-app'));
});

test('missing persistence, replaced connection and a lost persistence receipt cannot initiate a POST', async () => {
  let posts = 0;
  await assert.rejects(new FeishuReceiptFeedback({post: () => posts++}).load(), /FEISHU_FEEDBACK_STORE_UNAVAILABLE/);
  let live = true;
  const {instance} = feedback({current: () => live, post: () => posts++}); await instance.load(); live = false;
  await assert.rejects(instance.receive(event), /STALE_PLATFORM_SOURCE/);
  const lost = feedback({store: {load: async () => '', save: async () => {throw new Error('lost store result');}}, post: () => posts++}).instance;
  await lost.load(); await assert.rejects(lost.receive(event), /lost store result/);
  assert.equal(await lost.receive(event), false); assert.equal(posts, 0);
});

test('Feishu reaction uses the original message, exact Typing casing and official reaction endpoint', async () => {
  const calls = [], adapter = new FeishuAdapter({configuration: {appId: 'owned-app'}, credentials: {appSecret: 'inert'},
    transport: async (url, args) => {calls.push({url, args}); return url.includes('/auth/')
      ? {code: 0, tenant_access_token: 'inert', expire: 3600} : {code: 0, data: {reaction_id: 'owned-reaction'}};}});
  assert.deepEqual(await adapter.addTypingReaction('original-message'), {state: 'accepted', reactionId: 'owned-reaction'});
  assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages/original-message/reactions');
  assert.equal(calls[1].args.method, 'POST'); assert.deepEqual(calls[1].args.body, {reaction_type: {emoji_type: 'Typing'}});
  assert.deepEqual(calls[1].args.hosts, ['open.feishu.cn']);
});

test('ordinary Feishu answers use Octop Markdown posts without a task card header', async () => {
  const calls = [], adapter = new FeishuAdapter({configuration: {appId: 'owned-app'}, credentials: {appSecret: 'inert'},
    transport: async (url, args) => {calls.push({url, args}); return url.includes('/auth/')
      ? {code: 0, tenant_access_token: 'inert', expire: 3600} : {code: 0, data: {message_id: 'owned-answer'}};}});
  const result = await adapter.send({destination: {conversationId: 'owned-chat'}, content: {text: 'Answer```js\n1\n```',
    presentation: {kind: 'result', title: 'Task result'}}}, {deliveryId: 'owned-result'});
  assert.equal(result.messageType, 'post'); assert.equal(calls[1].args.body.msg_type, 'post');
  assert.deepEqual(JSON.parse(calls[1].args.body.content), {zh_cn: {content: [[{tag: 'md', text: 'Answer\n```js\n1\n```'}]]}});
});

for (const showTyping of [true, false]) test(`real dispatcher respects this connection's Typing option (${showTyping}) and bound acceptance`, async () => {
  let handlers;
  class Dispatcher {register(value) {handlers = value; return this;}}
  class Client {
    wsConfig = {setWSInstance() {}}; dataCache = {cache: new Map(), mergeData() {}};
    getConnectionStatus() {return {state: 'connected'};}
    async start() {} close() {}
  }
  const calls = [], store = checkpoint(); let release;
  const adapter = new FeishuAdapter({configuration: {appId: 'owned-app', channelId: 'owned-connection', features: {showTyping}}, credentials: {appSecret: 'inert'},
    checkpoint: store, sdk: {WSClient: Client, EventDispatcher: Dispatcher}, transport: async (url) => {
      if (url.includes('/auth/')) return {code: 0, tenant_access_token: 'inert', expire: 3600};
      if (url.includes('/bot/')) return {code: 0, bot: {open_id: 'owned-bot'}};
      assert.ok(url.endsWith('/original-message/reactions')); calls.push('Typing');
      return new Promise(resolve => {release = resolve;});
    }});
  await adapter.start(async event => {
    if (event.text === 'unbound') {calls.push('unbound'); return {accepted: true, state: 'unbound'};}
    calls.push('enqueue'); return {accepted: true, state: 'pending'};
  });
  const packet = {header: {event_id: 'original-event', tenant_key: 'tenant'}, sender: {sender_type: 'user', sender_id: {open_id: 'user'}},
    message: {message_id: 'original-message', chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}', create_time: '1'}};
  await handlers['im.message.receive_v1']({...packet, sender: {...packet.sender, sender_type: 'bot'}});
  assert.deepEqual(calls, []);
  await handlers['im.message.receive_v1']({...packet, header: {...packet.header, event_id: 'unbound-event'},
    message: {...packet.message, message_id: 'unbound-message', content: '{"text":"unbound"}'}});
  assert.deepEqual(calls, ['unbound']);
  await handlers['im.message.receive_v1'](packet);
  assert.deepEqual(calls, ['unbound', 'enqueue', ...(showTyping ? ['Typing'] : [])]);
  await handlers['im.message.receive_v1'](packet);
  assert.deepEqual(calls, ['unbound', 'enqueue', ...(showTyping ? ['Typing'] : []), 'enqueue']);
  store.save = async () => {throw new Error('owned checkpoint unavailable');};
  await handlers['im.message.receive_v1']({...packet, header: {...packet.header, event_id: 'next-event'},
    message: {...packet.message, message_id: 'another-message'}});
  assert.deepEqual(calls, ['unbound', 'enqueue', ...(showTyping ? ['Typing'] : []), 'enqueue', 'enqueue'], 'failed feedback cannot discard real input');
  release?.({code: 0, data: {reaction_id: 'owned-reaction'}}); await tick(); await adapter.stop();
});
