import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuAdapter } from '../../../kcoder-channel-host/src/adapters/sdk.mjs';
import { matchesFeishuReadback } from './feishu-readback-proof.mjs';

test('readback matches the actual adapter post payload and rejects unrelated or malformed messages', async () => {
  let sent;
  const adapter = new FeishuAdapter({ configuration: { appId: 'fixture-app' }, credentials: { appSecret: 'fixture-secret' },
    transport: async (url, options) => {
      if (url.includes('/auth/')) return { code: 0, tenant_access_token: 'fixture-token', expire: 3600 };
      sent = options.body; return { code: 0, data: { message_id: 'om_fixture' } };
    } });
  const text = 'KCoder fixture message\nunique marker';
  const receipt = await adapter.send({ destination: { conversationId: 'oc_fixture' }, content: { text } }, { deliveryId: 'owned-fixture' });
  assert.equal(receipt.messageType, 'post');
  assert.equal(sent.msg_type, 'post');
  const item = { message_id: receipt.messageId, chat_id: 'oc_fixture', msg_type: sent.msg_type, body: { content: sent.content } };
  const expected = { receipt, chatId: 'oc_fixture', text };
  assert.equal(matchesFeishuReadback(item, expected), true);
  assert.equal(matchesFeishuReadback({ ...item, chat_id: 'oc_other' }, expected), false);
  assert.equal(matchesFeishuReadback({ ...item, message_id: 'om_other' }, expected), false);
  assert.equal(matchesFeishuReadback({ ...item, msg_type: 'text' }, expected), false);
  assert.equal(matchesFeishuReadback({ ...item, body: { content: '{' } }, expected), false);
  assert.equal(matchesFeishuReadback(item, { ...expected, text: 'other text' }), false);
  await adapter.stop();
});

test('plain text receipt requires a matching text body', () => {
  const receipt = { messageId: 'om_fixture', messageType: 'text' };
  const item = { message_id: 'om_fixture', chat_id: 'oc_fixture', msg_type: 'text', body: { content: JSON.stringify({ text: 'owned' }) } };
  assert.equal(matchesFeishuReadback(item, { receipt, chatId: 'oc_fixture', text: 'owned' }), true);
  assert.equal(matchesFeishuReadback(item, { receipt, chatId: 'oc_fixture', text: 'different' }), false);
});
