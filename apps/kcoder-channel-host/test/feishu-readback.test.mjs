import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter } from '../src/adapters/sdk.mjs';

function fixture(change = message => message, code = 0) {
  const calls = [];
  const adapter = new FeishuAdapter({configuration: {appId: 'owned-app'}, credentials: {appSecret: 'inert-secret'},
    transport: async (url, args) => {
      calls.push({url, args});
      if (url.includes('/auth/')) return {code: 0, tenant_access_token: 'inert-token', expire: 3600};
      return {code, data: {items: [change({message_id: 'original-message', chat_id: 'actual-chat',
        deleted: false, msg_type: 'text', sender: {sender_type: 'user', id_type: 'open_id', id: 'actual-user', tenant_key: 'actual-tenant'},
        body: {content: JSON.stringify({text: 'original input'})}}, adapter)]}};
    }});
  adapter.client = {getConnectionStatus: () => ({state: 'connected'}), close() {}};
  adapter.connectController = new AbortController();
  return {adapter, calls};
}

test('Feishu readback derives identity and text from one original platform message without sending or ingesting', async () => {
  const {adapter, calls} = fixture();
  assert.deepEqual(await adapter.readOriginalMessage({sourceMessageId: 'original-message'}), {
    sourceMessageId: 'original-message', conversationId: 'actual-chat', tenantId: 'actual-tenant',
    senderId: 'actual-user', botId: 'owned-app', text: 'original input', topicId: null,
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('/im/v1/messages/original-message?user_id_type=open_id'));
  assert.equal(calls[1].args.method, 'GET');
  assert.equal(calls[1].args.body, undefined);
  assert.deepEqual(calls[1].args.hosts, ['open.feishu.cn']);
});

test('Feishu readback preserves a real thread identifier without guessing it from root messages', async () => {
  const {adapter} = fixture(message => ({...message, thread_id: 'actual-thread', root_id: 'different-root'}));
  assert.equal((await adapter.readOriginalMessage({sourceMessageId: 'original-message'})).topicId, 'actual-thread');
});

test('Feishu readback rejects deleted, bot, ambiguous-identity, changed and non-text messages', async () => {
  for (const change of [
    message => ({...message, deleted: true}),
    message => ({...message, deleted: undefined}),
    message => ({...message, message_id: 'different-message'}),
    message => ({...message, msg_type: 'post'}),
    message => ({...message, sender: {...message.sender, sender_type: 'app'}}),
    message => ({...message, sender: {...message.sender, id_type: 'user_id'}}),
    message => ({...message, sender: {...message.sender, tenant_key: undefined}}),
    message => ({...message, body: {content: '{broken'}}),
    message => ({...message, body: {content: JSON.stringify({text: 'x'.repeat(16 * 1024 + 1)})}}),
  ]) {
    const {adapter, calls} = fixture(change);
    await assert.rejects(adapter.readOriginalMessage({sourceMessageId: 'original-message'}));
    assert.equal(calls.filter(call => call.args.method === 'GET').length, 1);
    assert.equal(calls.some(call => call.url.includes('receive_id_type')), false);
  }
});

test('Feishu API refusal is visible and stale or disconnected readback never becomes current evidence', async () => {
  const refused = fixture(message => message, 230001);
  await assert.rejects(refused.adapter.readOriginalMessage({sourceMessageId: 'original-message'}), {code: 'PLATFORM_MESSAGE_READBACK_REJECTED'});
  const stale = fixture((message, adapter) => {adapter.generation++; return message;});
  await assert.rejects(stale.adapter.readOriginalMessage({sourceMessageId: 'original-message'}), {code: 'STALE_PLATFORM_SOURCE'});
  const disconnected = fixture(); disconnected.adapter.client = null;
  await assert.rejects(disconnected.adapter.readOriginalMessage({sourceMessageId: 'original-message'}), {code: 'SDK_WORKER_NOT_CONNECTED'});
  assert.equal(disconnected.calls.length, 0);
});
