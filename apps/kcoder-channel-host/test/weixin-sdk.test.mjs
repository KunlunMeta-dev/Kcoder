import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WeixinAdapter } from '../src/adapters/weixin.mjs';
import { EphemeralSecretStore, platformJson } from '../src/transport.mjs';

test('Weixin send preparation rejection is distinct from bot authorization and never retried', async () => {
  const secrets = new EphemeralSecretStore();
  await secrets.put('context', { contextToken: 'private-context', toUserId: 'fixture-user' });
  let calls = 0;
  const adapter = new WeixinAdapter({ configuration: {}, credentials: { botToken: 'fixture' }, secretStore: secrets,
    transport: async () => { calls++; return { ret: -2, errmsg: 'prepare failed private-context' }; } });
  const payload = { destination: { conversationId: 'fixture-user', replyRef: 'context' }, content: { text: 'hello' } };
  await assert.rejects(adapter.send(payload, { deliveryId: 'original-delivery' }), error => {
    assert.equal(error.code, 'WEIXIN_SEND_PREPARATION_FAILED');
    assert.equal(error.recovery, 'none');
    assert.equal(error.externalOutcome, 'failed');
    assert.ok(!error.message.includes('private-context'));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal((await secrets.get('context')).contextToken, 'private-context');
  await assert.rejects(adapter.sdkCall('getUpdates', {}, AbortSignal.timeout(1000)), { code: 'WEIXIN_PLATFORM_REJECTED' });
});

test('authorization errors take precedence over send preparation failures', async () => {
  const adapter = new WeixinAdapter({ configuration: {}, credentials: { botToken: 'fixture' },
    transport: async () => ({ ret: -2, errcode: -14 }) });
  await assert.rejects(adapter.sdkCall('sendMessage', { body: {} }), { code: 'PLATFORM_AUTHORIZATION_FAILED', recovery: 'request_authorization' });
});

test('fresh inbound context permits a new reply without replaying the rejected message', async () => {
  const secrets = new EphemeralSecretStore(), sent = [];
  await secrets.put('old-context', { contextToken: 'old-private-context', toUserId: 'fixture-user' });
  const adapter = new WeixinAdapter({ configuration: { accountId: 'fixture', channelId: 'connection' },
    credentials: { botToken: 'fixture' }, secretStore: secrets,
    transport: async (_url, { body }) => {
      sent.push(body.msg);
      return body.msg.context_token === 'old-private-context' ? { ret: -2 } : { ret: 0, message_id: 'accepted' };
    } });
  await assert.rejects(adapter.send({ destination: { conversationId: 'fixture-user', replyRef: 'old-context' }, content: { text: 'old reply' } },
    { deliveryId: 'failed-original' }), { code: 'WEIXIN_SEND_PREPARATION_FAILED' });
  let received;
  await adapter.consume({ msgs: [{ message_id: 'fresh-inbound', from_user_id: 'fixture-user', context_token: 'fresh-private-context',
    item_list: [{ type: 1, text_item: { text: 'new input' } }] }] }, async event => { received = event; });
  assert.equal(sent.length, 1, 'Receiving context alone must not replay the failed send');
  const result = await adapter.send({ destination: { conversationId: 'fixture-user', replyRef: received.replyRef }, content: { text: 'new reply' } },
    { deliveryId: 'new-original' });
  assert.equal(result.state, 'accepted');
  assert.deepEqual(sent.map(message => message.client_id), ['failed-original', 'new-original']);
  assert.equal(sent[1].context_token, 'fresh-private-context');
});

test('actual Weixin SDK preserves uint64 input identities through its JSON decoder', async () => {
  const adapter = new WeixinAdapter({ configuration: { accountId: 'fixture' }, credentials: { botToken: 'fixture' },
    transport: (url, options) => platformJson(url, { ...options, fetchImpl: async () => new Response(
      '{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"fixture"}],"get_updates_buf":"next"}') }) });
  const batch = await adapter.getUpdates(AbortSignal.timeout(1000), { requireResponse: true });
  assert.equal(batch.msgs[0].message_id, '18446744073709551615');
  assert.equal(batch.get_updates_buf, 'next');
});

test('SDK send cannot swallow a business rejection or replace the durable client identity', async () => {
  const secrets = new EphemeralSecretStore();
  await secrets.put('context', { contextToken: 'fixture-context', toUserId: 'fixture-user' });
  const requests = [];
  const adapter = new WeixinAdapter({ configuration: { accountId: 'fixture' }, credentials: { botToken: 'fixture' },
    secretStore: secrets, transport: async (url, options) => { requests.push({ url, options }); return { ret: 1234 }; } });
  await assert.rejects(adapter.send({ destination: { conversationId: 'fixture-user', replyRef: 'context' }, content: { text: 'hello' } },
    { deliveryId: 'durable-delivery' }), error => error.code === 'WEIXIN_PLATFORM_REJECTED' && error.externalOutcome === 'failed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body.msg.client_id, 'durable-delivery');
  assert.equal(requests[0].options.body.msg.context_token, 'fixture-context');
});

test('SDK HTTP contexts isolate simultaneous accounts and leave unrelated fetch untouched', async t => {
  const originalFetch = globalThis.fetch;
  const server = createServer((_request, response) => response.end('ordinary-fetch'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const seen = [], adapters = ['one', 'two'].map(id => new WeixinAdapter({
    configuration: { accountId: id }, credentials: { botToken: id },
    transport: async (_url, options) => {
      await new Promise(resolve => setImmediate(resolve));
      seen.push(options.headers.Authorization); return { ret: 0, msgs: [], get_updates_buf: id };
    },
  }));
  const batches = await Promise.all(adapters.map(adapter => adapter.getUpdates(AbortSignal.timeout(1000))));
  assert.deepEqual(batches.map(batch => batch.get_updates_buf), ['one', 'two']);
  assert.deepEqual(seen.sort(), ['Bearer one', 'Bearer two']);
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'ordinary-fetch');
  assert.equal(seen.length, 2);
  assert.equal(globalThis.fetch, originalFetch);
});

test('Tencent protocol supplies its product envelope and returns the original uint64 send receipt', async () => {
  const secrets = new EphemeralSecretStore();
  await secrets.put('context', { contextToken: 'fixture-context', toUserId: 'fixture-user' });
  let request;
  const adapter = new WeixinAdapter({ configuration: {}, credentials: { botToken: 'fixture' }, secretStore: secrets,
    transport: (url, options) => {
      request = options;
      return platformJson(url, { ...options, fetchImpl: async () => new Response('{"ret":0,"message_id":18446744073709551615}') });
    } });
  const receipt = await adapter.send({ destination: { conversationId: 'fixture-user', replyRef: 'context' }, content: { text: 'hello' } },
    { deliveryId: 'original-delivery' });
  assert.equal(receipt.messageId, '18446744073709551615');
  assert.equal(request.body.msg.client_id, 'original-delivery');
  assert.deepEqual(request.body.base_info, { channel_version: '2.4.10', bot_agent: 'KCoder/0.1.0' });
  assert.equal(request.headers['iLink-App-Id'], 'bot');
  assert.equal(request.headers['iLink-App-ClientVersion'], String((2 << 16) | (4 << 8) | 10));
});

test('official polling, sending and upload requests preserve external cancellation without retries', async () => {
  for (const operation of ['getUpdates', 'sendMessage', 'getUploadUrl']) {
    const controller = new AbortController(); let calls = 0;
    const adapter = new WeixinAdapter({ configuration: {}, credentials: { botToken: 'fixture' },
      transport: async (_url, { signal }) => {
        calls++;
        queueMicrotask(() => controller.abort(new DOMException('Owned stop', 'AbortError')));
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } });
    await assert.rejects(adapter.sdkCall(operation, { body: {} }, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
  }
});
