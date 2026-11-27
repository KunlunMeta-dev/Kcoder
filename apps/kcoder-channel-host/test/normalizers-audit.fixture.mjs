// Read-only audit reproductions, outside the default *.test.mjs glob until the
// parent reviews the proposed production changes. No real SDK connection/send.
import assert from 'node:assert/strict';
import test from 'node:test';
import { feishuEvent, dingtalkEvent, wecomEvent, wecomCardActionEvent, githubEvent } from '../src/normalizers.mjs';
import { EphemeralSecretStore } from '../src/transport.mjs';
import { WeixinAdapter } from '../src/adapters/weixin.mjs';
import { DingTalkAdapter } from '../src/adapters/sdk.mjs';
import { normalize as officialFeishuNormalize } from '@larksuiteoapi/node-sdk';

const feishu = { channelId: 'owned-channel', appId: 'owned-app', botOpenId: 'owned-bot' };
const feishuPacket = (message_type, content, extra = {}) => ({ event_id: 'owned-event', tenant_key: 'owned-tenant',
  sender: { sender_type: 'user', sender_id: { open_id: 'owned-user' } },
  message: { message_id: 'owned-message', create_time: '1000', chat_id: 'owned-chat', chat_type: 'p2p', message_type, content: JSON.stringify(content), ...extra } });
test('locked Feishu SDK flat post text survives normalization', async () => {
  const packet = feishuPacket('post', { title: 'Owned title', content: [[{ tag: 'text', text: 'Owned post text' }]] });
  const reference = await officialFeishuNormalize(packet, { botIdentity: { openId: 'owned-bot', name: 'Owned bot' } });
  assert.ok(reference.content.includes('Owned post text'));
  const event = feishuEvent(feishu, packet);
  assert.ok(event.text.includes('Owned post text'), `observed text=${JSON.stringify(event.text)}`);
});
test('addressed Feishu bot mention is removed before command classification', async () => {
  const packet = feishuPacket('text', { text: '@_user_1 /status' }, {
    chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'owned-bot' }, name: 'Owned bot' }] });
  const reference = await officialFeishuNormalize(packet, { botIdentity: { openId: 'owned-bot', name: 'Owned bot' } });
  assert.equal(reference.content, '/status');
  const event = feishuEvent(feishu, packet);
  assert.equal(event.text, '/status'); assert.equal(event.kind, 'control');
});
test('DingTalk official richText object does not become model text object-string', async () => {
  const event = await dingtalkEvent({ channelId: 'owned-channel', clientId: 'owned-client' }, { data: JSON.stringify({
    msgId: 'owned-message', senderStaffId: 'owned-user', senderCorpId: 'owned-corp', conversationId: 'owned-chat', conversationType: '1',
    msgtype: 'richText', content: { richText: [{ text: 'Owned readable text' }] } }) }, new EphemeralSecretStore());
  assert.equal(event.attachments.length, 0); assert.equal(event.text, 'Owned readable text');
});
test('WeCom normal messages and event callbacks keep one canonical conversation tenant', async () => {
  const configuration = { channelId: 'owned-channel', botId: 'owned-bot' }, secrets = new EphemeralSecretStore();
  const body = { aibotid: 'owned-bot', msgid: 'owned-message', create_time: Math.floor(Date.now() / 1000), chattype: 'single', from: { userid: 'owned-user' } };
  const message = await wecomEvent(configuration, { cmd: 'aibot_msg_callback', headers: { req_id: 'owned-message-req' }, body: { ...body, msgtype: 'text', text: { content: 'Owned input' } } }, secrets);
  const action = await wecomCardActionEvent(configuration, { cmd: 'aibot_event_callback', headers: { req_id: 'owned-card-req' }, body: { ...body,
    msgid: 'owned-card-message', msgtype: 'event', from: { userid: 'owned-user', corpid: 'owned-external-corp' },
    event: { eventtype: 'template_card_event', event_key: 'owned-action', task_id: 'owned-task' } } }, secrets);
  assert.equal(action.conversationId, message.conversationId); assert.equal(action.tenantId, message.tenantId);
});
test('unsupported Weixin group packet does not poison the following private input or its cursor', async () => {
  let ingested = 0, saved = 0;
  const adapter = new WeixinAdapter({ configuration: { channelId: 'owned-channel', accountId: 'owned-account' }, credentials: {},
    checkpoint: { async save() { saved++; } }, secretStore: new EphemeralSecretStore() });
  await adapter.consume({ get_updates_buf: 'owned-next', msgs: [
    { message_type: 1, message_id: '1', from_user_id: 'owned-group-user', group_id: 'owned-group', item_list: [] },
    { message_type: 1, message_id: '2', from_user_id: 'owned-user', item_list: [{ type: 1, text_item: { text: 'Owned private input' } }] },
  ] }, async () => { ingested++; });
  assert.equal(ingested, 1); assert.equal(saved, 1);
});
test('three declared-but-unsupported group batches do not repeatedly degrade the original polling owner', async () => {
  let polls = 0, ingested = 0;
  const controller = new AbortController();
  const adapter = new WeixinAdapter({ configuration: { channelId: 'owned-channel', accountId: 'owned-account' }, credentials: {}, retryWait: async () => {} });
  adapter.observe('connected');
  adapter.getUpdates = async () => {
    if (++polls === 4) { controller.abort(); return { msgs: [] }; }
    return { msgs: [{ message_type: 1, message_id: String(polls), from_user_id: 'owned-user', group_id: 'owned-group', item_list: [] }] };
  };
  await adapter.poll(async () => { ingested++; }, controller, adapter.generation);
  const observed = { polls, ingested, state: adapter.connectionState() };
  controller.abort(); await adapter.stop();
  assert.equal(observed.polls, 4); assert.equal(observed.state, 'connected');
});
test('GitHub mention removal retains quoted/code text after the real visible address', () => {
  const event = githubEvent({ channelId: 'owned-channel', botLogin: 'owned-bot' }, 'owned/repo', {
    id: 1, user: { id: 2, login: 'owned-user', type: 'User' }, created_at: '2026-11-12T00:00:00Z',
    issue_url: 'https://api.github.com/repos/owned/repo/issues/1', body: '@owned-bot explain\n> quote @owned-bot\n`@owned-bot`' });
  assert.ok(event.text.includes('> quote @owned-bot')); assert.ok(event.text.includes('`@owned-bot`'));
});
test('malformed external JSON null is a typed normalization rejection, not TypeError', () => {
  assert.throws(() => feishuEvent(feishu, feishuPacket('text', null)), error => error.name === 'ChannelError');
});
test('expired DingTalk webhook storage never extends its actual send window', async () => {
  let sends = 0; const secrets = new EphemeralSecretStore(), configuration = { channelId: 'owned-channel', clientId: 'owned-client' };
  const event = await dingtalkEvent(configuration, { data: JSON.stringify({ msgId: 'owned-expired', senderStaffId: 'owned-user', conversationId: 'owned-chat', conversationType: '1',
    text: { content: 'Owned text' }, sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?owned', sessionWebhookExpiredTime: Date.now() - 100 }) }, secrets);
  const adapter = new DingTalkAdapter({ configuration, credentials: {}, secretStore: secrets, transport: async () => { sends++; throw Error('unexpected send'); } });
  await assert.rejects(adapter.send({ destination: { replyRef: event.replyRef }, content: { text: 'Owned reply' } }, { deliveryId: 'owned-delivery' }), error => error.code === 'REPLY_WINDOW_EXPIRED' && error.externalOutcome === 'failed');
  assert.equal(sends, 0); await adapter.stop();
});
