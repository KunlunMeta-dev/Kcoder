import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize as sdkNormalize } from '@larksuiteoapi/node-sdk';
import { feishuEvent, dingtalkEvent, githubEvent, githubMentions, weixinEvent, weixinEventMetadata } from '../src/normalizers.mjs';
import { EphemeralSecretStore } from '../src/transport.mjs';
import { WeixinAdapter } from '../src/adapters/weixin.mjs';
import { ChannelStore } from '../src/channels/store.mjs';

const feishu = { channelId: 'owned-channel', appId: 'owned-app', botOpenId: 'owned-bot' };
function packet(kind, content, extra = {}) {
  return { event_id: 'owned-event', tenant_key: 'owned-tenant', sender: { sender_type: 'user', sender_id: { open_id: 'owned-user' } },
    message: { message_id: 'owned-message', create_time: '1000', chat_id: 'owned-chat', chat_type: 'p2p', message_type: kind,
      content: typeof content === 'string' ? content : JSON.stringify(content), ...extra } };
}
function ding(body) {
  return { data: JSON.stringify({ msgId: 'owned-message', senderStaffId: 'owned-user', senderCorpId: 'owned-corp',
    conversationId: 'owned-chat', conversationType: '1', ...body }) };
}
const dingConfig = { channelId: 'owned-channel', clientId: 'owned-client' };
const weixin = { channelId: 'owned-channel', accountId: 'owned-account' };
const privateMessage = id => ({ message_type: 1, message_id: id, from_user_id: 'owned-user', item_list: [{ type: 1, text_item: { text: 'Owned input' } }] });
const invalid = error => error.name === 'ChannelError' && error.code === 'PLATFORM_INVALID_JSON';

test('Feishu flat and one selected locale retain title, paragraphs and known text', async () => {
  const post = { title: 'Owned title', content: [[{ tag: 'text', text: 'First' }, { tag: 'a', text: ' link', href: 'https://example.invalid' }],
    [{ tag: 'code_block', text: 'Second\ncode' }]] };
  for (const body of [post, { zh_cn: post, en_us: { title: 'Other locale', content: [[{ tag: 'text', text: 'Never duplicate this' }]] } }]) {
    const original = packet('post', body), event = feishuEvent(feishu, original);
    assert.ok((await sdkNormalize(original, { botIdentity: { openId: 'owned-bot', name: 'Bot' } })).content.includes('First'));
    assert.equal(event.text, 'Owned title\nFirst link\nSecond\ncode');
    assert.equal(event.sourceMessageId, 'owned-message'); assert.equal(event.eventId, 'owned-event');
  }
});
test('Feishu strips only exact authenticated bot keys, preserving other mentions and source scope', () => {
  const event = feishuEvent(feishu, packet('text', { text: '@_user_1 /status @_user_10' }, { chat_type: 'group', thread_id: 'owned-topic', parent_id: 'owned-parent',
    mentions: [{ key: '@_user_1', id: { open_id: 'owned-bot' }, name: 'Bot' }, { key: '@_user_10', id: { open_id: 'other-user' }, name: 'Other' }] }));
  assert.equal(event.text, '/status @_user_10'); assert.equal(event.kind, 'control');
  assert.equal(event.topicId, 'owned-topic'); assert.equal(event.replyToMessageId, 'owned-parent');
  assert.equal(feishuEvent(feishu, packet('text', { text: '@_user_10 hello' }, { chat_type: 'group', mentions: [{ key: '@_user_10', id: { open_id: 'other-user' } }] })), null);
});
test('Feishu post media retains metadata for the existing unsupported-attachment guard', () => {
  const event = feishuEvent(feishu, packet('post', { content: [[{ tag: 'at', user_id: 'owned-bot' }, { tag: 'text', text: 'Read this' }],
    [{ tag: 'img', image_key: 'owned-image' }], [{ tag: 'media', file_key: 'owned-video' }]] }));
  assert.equal(event.text, 'Read this');
  assert.deepEqual(event.attachments.map(item => [item.kind, item.mediaId, item.sourceMessageId]), [['image', 'owned-image', 'owned-message'], ['file', 'owned-video', 'owned-message']]);
});
test('text-only legacy non-JSON content remains readable', () => {
  assert.equal(feishuEvent(feishu, packet('text', '/status')).text, '/status');
  assert.equal(feishuEvent(feishu, packet('text', { text: '  keep\n  indentation  ' })).text, '  keep\n  indentation  ');
  assert.equal(feishuEvent(feishu, packet('post', { content: [[{ tag: 'code_block', text: '    keep\n    code' }]] })).text, '    keep\n    code');
});
test('post content and media count stay bounded and malformed nodes do not become empty success', () => {
  assert.throws(() => feishuEvent(feishu, packet('post', { content: [[null]] })), invalid);
  assert.throws(() => feishuEvent(feishu, packet('post', { content: null })), invalid);
  assert.throws(() => feishuEvent(feishu, packet('text', { text: null })), invalid);
  assert.throws(() => feishuEvent(feishu, packet('post', { content: [[{ tag: 'text', text: {} }]] })), invalid);
  assert.throws(() => feishuEvent(feishu, packet('post', { content: [Array.from({ length: 33 }, (_, index) => ({ tag: 'img', image_key: `owned-${index}` }))] })), { code: 'TOO_MANY_ATTACHMENTS' });
  assert.throws(() => feishuEvent(feishu, packet('text', { text: 'x'.repeat(70 * 1024) })), { code: 'TEXT_TOO_LARGE' });
});
test('DingTalk strings and official richText stay text; file metadata never stringifies into text', async () => {
  const secrets = new EphemeralSecretStore();
  for (const body of [{ msgtype: 'text', text: { content: 'Owned text' } }, { content: 'Owned text' },
    { msgtype: 'richText', content: { richText: [{ text: 'Owned ' }, { text: 'text' }] } }]) {
    assert.equal((await dingtalkEvent(dingConfig, ding(body), secrets)).text, 'Owned text');
  }
  const file = await dingtalkEvent(dingConfig, ding({ msgtype: 'file', content: { downloadCode: 'owned-download-code', fileName: 'owned-file.pdf' } }), secrets);
  assert.equal(file.text, ''); assert.equal(file.attachments[0].filename, 'owned-file.pdf'); assert.equal(file.attachments[0].mediaId, 'owned-download-code');
  const rich = await dingtalkEvent(dingConfig, ding({ msgtype: 'richText', content: { richText: [{ text: 'Caption' }, { type: 'picture', downloadCode: 'owned-picture' }] } }), secrets);
  assert.equal(rich.text, 'Caption'); assert.equal(rich.attachments[0].kind, 'image');
});
test('unsupported DingTalk kinds are distinct from malformed recognized payloads and do not write private context', async () => {
  let puts = 0; const secrets = { async put() { puts++; } };
  assert.equal(await dingtalkEvent(dingConfig, ding({ msgtype: 'unknownMsgType', content: { unknownMsgType: 'Unsupported input' }, sessionWebhook: 'not-used' }), secrets), null);
  await assert.rejects(dingtalkEvent(dingConfig, ding({ msgId: 'x'.repeat(257), msgtype: 'unknownMsgType', content: {} }), secrets), { code: 'INVALID_EVENTID' });
  for (const body of [{ msgtype: 'text', text: { content: {} } }, { msgtype: 'richText', content: { richText: [null] } }, { msgtype: 'file', content: { downloadCode: {} } }]) {
    await assert.rejects(dingtalkEvent(dingConfig, ding(body), secrets), invalid);
  }
  assert.equal(puts, 0);
});
for (const value of ['null', '[]', '1', 'true', '"json primitive"']) test(`parsed content ${value} rejects with a fixed ChannelError`, async () => {
  assert.throws(() => feishuEvent(feishu, packet('text', value)), invalid);
  await assert.rejects(dingtalkEvent(dingConfig, { data: value }, { async put() { assert.fail('No context for malformed content'); } }), invalid);
});
test('declared unsupported Weixin groups are null before any private store write in both normalization modes', async () => {
  let writes = 0; const secretStore = { async put() { writes++; } };
  const message = { ...privateMessage('owned-group'), group_id: 'owned-group-id', context_token: 'INERT_NOT_USED' };
  assert.equal(await weixinEventMetadata(weixin, message), null);
  assert.equal(await weixinEvent(weixin, message, secretStore), null); assert.equal(writes, 0);
  let ingested = 0, saved = 0;
  const adapter = new WeixinAdapter({ configuration: weixin, credentials: {}, secretStore, checkpoint: { async save() { saved++; } } });
  await adapter.consume({ msgs: [message, privateMessage('owned-private')], get_updates_buf: 'owned-next' }, async () => { ingested++; });
  assert.equal(ingested, 1); assert.equal(saved, 1); assert.equal(adapter.cursor, 'owned-next'); assert.equal(writes, 0);
});
test('successive unsupported-only Weixin batches advance checkpoints without degrading the polling owner', async () => {
  let polls = 0, writes = 0, saves = 0, ingested = 0;
  const controller = new AbortController();
  const adapter = new WeixinAdapter({ configuration: weixin, credentials: {}, retryWait: async () => {},
    secretStore: { async put() { writes++; } }, checkpoint: { async save() { saves++; } } });
  adapter.observe('connected');
  adapter.getUpdates = async () => {
    if (++polls === 4) { controller.abort(); return { msgs: [] }; }
    return { msgs: [{ ...privateMessage(String(polls)), group_id: 'owned-group' }], get_updates_buf: 'owned-' + polls };
  };
  await adapter.poll(async () => { ingested++; }, controller, adapter.generation);
  assert.equal(polls, 4); assert.equal(adapter.connectionState(), 'connected'); assert.equal(adapter.cursor, 'owned-3');
  assert.equal(saves, 3); assert.equal(writes, 0); assert.equal(ingested, 0);
  await adapter.stop();
});
test('malformed Weixin group fields fail without ingest, secret writes or cursor advancement', async () => {
  let writes = 0, ingested = 0, saved = 0;
  const adapter = new WeixinAdapter({ configuration: weixin, credentials: {}, secretStore: { async put() { writes++; } }, checkpoint: { async save() { saved++; } } });
  for (const group_id of [0, null, true, [], {}, ' ', 'bad\0group']) {
    const message = { ...privateMessage('owned-invalid'), group_id, context_token: 'INERT_NOT_USED' };
    await assert.rejects(weixinEventMetadata(weixin, message), invalid);
    await assert.rejects(adapter.consume({ msgs: [message, privateMessage('later')], get_updates_buf: 'not-saved' }, async () => { ingested++; }), invalid);
  }
  assert.equal(writes, 0); assert.equal(ingested, 0); assert.equal(saved, 0); assert.equal(adapter.cursor, '');
});
test('Weixin persistence, ingress, cursor and cancellation errors still fence the original batch', async () => {
  for (const stage of ['context', 'ingress', 'checkpoint', 'cancel']) {
    let puts = 0, ingested = 0, saved = 0; const controller = new AbortController(), failure = Error('owned original outcome unknown');
    const adapter = new WeixinAdapter({ configuration: weixin, credentials: {}, secretStore: { async put() { puts++; if (stage === 'context') throw failure; } },
      checkpoint: { async save() { saved++; if (stage === 'checkpoint') throw failure; } } });
    const first = { ...privateMessage('owned-first'), context_token: 'INERT_ONLY' };
    await assert.rejects(adapter.consume({ msgs: [first, privateMessage('owned-second')], get_updates_buf: 'unconfirmed' }, async () => {
      ingested++; if (stage === 'ingress') throw failure; if (stage === 'cancel') controller.abort();
    }, () => !controller.signal.aborted), error => error === failure || error.code === 'STALE_PLATFORM_SOURCE');
    assert.equal(puts, 1); assert.equal(adapter.cursor, '');
    assert.equal(saved, stage === 'checkpoint' ? 1 : 0);
    if (stage !== 'checkpoint') assert.ok(ingested <= 1);
  }
});

const github = { channelId: 'owned-channel', botLogin: 'owned-bot' };
function comment(body) { return { id: 1, user: { id: 2, login: 'owned-user', type: 'User' }, body, created_at: '2026-11-12T00:00:00Z', issue_url: 'https://api.github.com/repos/owned/repo/issues/1' }; }
test('GitHub removes only the real visible trigger while retaining quote/code/other addresses', () => {
  const event = githubEvent(github, 'owned/repo', comment('@owned-bot /status\n> quote @owned-bot\n`@owned-bot`\n```\n@owned-bot\n```\n@owned-bot later'));
  assert.equal(event.kind, 'control'); assert.equal(event.topicId, '1'); assert.equal(event.sourceMessageId, '1');
  assert.equal(event.text, '/status\n> quote @owned-bot\n`@owned-bot`\n```\n@owned-bot\n```\n@owned-bot later');
});
for (const body of ['@own`hidden`ed-bot', '@owned-```hidden```bot', 'prefix`hidden`@owned-bot', '@owned-bot`hidden`-suffix', '> @owned-bot', '`@owned-bot`']) {
  test(`GitHub cannot synthesize an address by deleting code or quote spans: ${body}`, () => {
    assert.equal(githubMentions(body, github.botLogin), false); assert.equal(githubEvent(github, 'owned/repo', comment(body)), null);
  });
}
test('a fake projected address cannot hide the next genuine continuous address', () => {
  const body = '@own`hidden`ed-bot @owned-bot explain';
  const event = githubEvent(github, 'owned/repo', comment(body));
  assert.ok(event.text.endsWith('@own`hidden`ed-bot  explain'));
});
test('new content projection never replaces an already durable original Inbox event', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'normalizer-inbox-')); const store = new ChannelStore(directory);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  store.saveConnection({ id: feishu.channelId, platform: 'feishu', label: 'Owned', configuration: { appId: feishu.appId } }, { appSecret: 'INERT_ONLY' });
  const event = feishuEvent(feishu, packet('post', { content: [[{ tag: 'text', text: 'New readable projection' }]] }));
  const original = store.receive(feishu.channelId, { ...event, text: 'Original durable bytes' });
  const duplicate = store.receive(feishu.channelId, event);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.id, original.id); assert.equal(duplicate.event.text, 'Original durable bytes');
});
