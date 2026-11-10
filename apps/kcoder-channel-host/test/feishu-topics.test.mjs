import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter } from '../src/adapters/sdk.mjs';

function fixture(code = 0) {
  const calls = [];
  const adapter = new FeishuAdapter({ configuration: { appId: 'owned-test-app' },
    credentials: { appSecret: 'inert-test-secret' }, transport: async (url, args) => {
      calls.push({ url, args });
      return url.includes('/auth/') ? { code: 0, tenant_access_token: 'inert-test-token', expire: 3600 }
        : { code, data: { message_id: 'actual-shaped-receipt' } };
    } });
  return { adapter, calls };
}
const destination = { conversationId: 'real-chat', topicId: 'real-topic', replyMessageId: 'original-message' };

test('Feishu topic text uses the original message reply endpoint with stable UUID and no chat-level fallback', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.send({ destination, content: { text: 'Owned response' } }, { deliveryId: 'original-delivery' });
  assert.equal(result.state, 'accepted'); assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('/im/v1/messages/original-message/reply'));
  assert.equal(calls[1].args.body.reply_in_thread, true);
  assert.equal(calls[1].args.body.receive_id, undefined);
  assert.equal(calls[1].args.body.uuid.length, 32);
});

test('Feishu rejection of a topic reply stays failed and does not send outside the topic', async () => {
  const { adapter, calls } = fixture(230002);
  const result = await adapter.send({ destination, content: { text: 'Owned response' } }, { deliveryId: 'original-delivery' });
  assert.equal(result.state, 'failed'); assert.equal(result.code, 'PLATFORM_REJECTED');
  assert.equal(calls.filter(call => !call.url.includes('/auth/')).length, 1);
  assert.equal(calls.some(call => call.url.includes('receive_id_type')), false);
});

test('Feishu topic files use the same explicit reply route and require a real source message', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.sendFile({ destination }, { mediaKind: 'file', mediaId: 'original-upload' }, { deliveryId: 'file-delivery' });
  assert.equal(result.state, 'accepted'); assert.ok(calls[1].url.endsWith('/original-message/reply'));
  assert.equal(calls[1].args.body.reply_in_thread, true);
  assert.deepEqual(JSON.parse(calls[1].args.body.content), { file_key: 'original-upload' });
  const unbound = fixture();
  await assert.rejects(unbound.adapter.send({ destination: { ...destination, replyMessageId: undefined }, content: { text: 'x' } },
    { deliveryId: 'missing-origin' }), { code: 'FEISHU_TOPIC_REPLY_TARGET_REQUIRED' });
  assert.equal(unbound.calls.length, 0);
});
