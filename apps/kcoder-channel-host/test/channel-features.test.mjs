import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import definitions from '../src/channel-platforms.json' with { type: 'json' };
import { connectionFeatures, effectiveChannelConfiguration, channelMessageContent } from '../src/adapters/feature-options.mjs';
import { ChannelRuntime } from '../src/channels/runtime.mjs';
import { FeishuAdapter, WeComAdapter } from '../src/adapters/sdk.mjs';

test('platform declarations validate supported choices, bounds, independent versions and defaults', () => {
  for (const platform of Object.keys(definitions)) {
    assert.equal(connectionFeatures(platform).responseMode, 'final');
    assert.equal(connectionFeatures(platform).messageFormat, 'auto');
    assert.deepEqual(connectionFeatures(platform).meta, { config_version: 1 });
    for (const value of [null, { unknown: true }, { responseMode: 'stream' }, { messageFormat: null }, { meta: { config_version: 2 } }]) {
      assert.throws(() => connectionFeatures(platform, value), /CHANNEL_FEATURES/);
    }
  }
  assert.throws(() => connectionFeatures('qq', { showTyping: true }), /CHANNEL_FEATURES/);
  assert.throws(() => connectionFeatures('github', { pollIntervalSeconds: 14 }), /CHANNEL_FEATURES/);
  assert.throws(() => connectionFeatures('github', { pollIntervalSeconds: 60.5 }), /CHANNEL_FEATURES/);
  assert.equal(effectiveChannelConfiguration('github', { pollIntervalSeconds: 90 }).pollIntervalSeconds, 90);
  assert.equal(effectiveChannelConfiguration('github', { pollIntervalSeconds: 90, features: { pollIntervalSeconds: 120 } }).pollIntervalSeconds, 120);
});

test('each connection persists its own options; Outbox freezes formatting across config changes and mirror completion', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-features-'));
  const runtime = new ChannelRuntime({ directory, tasks: { run: async () => {}, recover: async () => ({ state: 'unknown' }) } });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ['a', 'b']) runtime.store.saveConnection({ id, platform: 'qq', label: id,
    configuration: { appId: id, features: { messageFormat: id === 'a' ? 'plain' : 'auto' } } }, { appSecret: 'fixture' });
  const event = { platform: 'qq', tenantId: 't', botId: 'a', chatKind: 'private', senderId: 's', conversationId: 'chat', eventId: 'event', text: 'input' };
  const a = runtime.store.receive('a', event, { historical: true });
  const b = runtime.store.receive('b', { ...event, botId: 'b', eventId: 'peer' }, { historical: true });
  const source = { text: '**Hello** [docs](https://example.com)' };
  const output = runtime.prepareOutput('first', a.chatId, source);
  assert.equal(output.payload.content.text, 'Hello docs');
  assert.equal(runtime.prepareOutput('peer', b.chatId, source).payload.content.text, source.text);
  const connection = runtime.store.connection('a');
  runtime.store.saveConnection({ ...connection, configuration: { ...connection.configuration, features: { messageFormat: 'auto' } } }, undefined, connection.revision);
  assert.equal(runtime.prepareOutput('first', a.chatId, source).payload.content.text, 'Hello docs');
  assert.equal(runtime.prepareOutput('later', a.chatId, source).payload.content.text, source.text);
  assert.throws(() => runtime.prepareOutput('first', a.chatId, { text: 'different' }), /CONFLICT/);
  runtime.store.enqueueOutput('mirror', a.chatId, { destination: {}, content: { text: '' }, messageFormat: 'plain' });
  runtime.store.deferTaskOutput('mirror', { role: 'assistant' }); runtime.store.resolveTaskOutput('mirror', source.text);
  assert.equal(runtime.store.output('mirror').payload.content.text, 'Hello docs');
  assert.equal(runtime.store.settings().mirrorClientTurns, false);
});

test('plain formatting uses the Markdown package and leaves auto content untouched', () => {
  const content = { text: '# Heading\n\n**bold** and `code`' };
  assert.equal(channelMessageContent(content, 'auto'), content);
  assert.equal(channelMessageContent(content, 'plain').text.includes('**'), false);
});

test('Feishu plain replies use the real text envelope while default replies retain Markdown posts', async () => {
  const bodies = [];
  const adapter = new FeishuAdapter({ configuration: { appId: 'app' }, credentials: { appSecret: 'fixture' },
    transport: async (url, options) => url.includes('/auth/') ? { code: 0, tenant_access_token: 'fixture', expire: 3600 }
      : (bodies.push(options.body), { code: 0, data: { message_id: 'm' } }) });
  await adapter.send({ destination: { conversationId: 'chat' }, content: { text: 'plain' }, messageFormat: 'plain' }, { deliveryId: 'plain' });
  await adapter.send({ destination: { conversationId: 'chat' }, content: { text: '**markdown**' } }, { deliveryId: 'auto' });
  assert.equal(bodies[0].msg_type, 'text'); assert.equal(bodies[1].msg_type, 'post');
});

test('WeCom plain results use the SDK text envelope without changing the original destination', async () => {
  const calls = [], adapter = new WeComAdapter({ configuration: { botId: 'bot' }, credentials: { secret: 'fixture' } });
  adapter.client = { sendMessage: async (chatId, body) => {
    calls.push({ chatId, body }); return { errcode: 0, headers: { req_id: 'receipt' } };
  } };
  adapter.withSignal = (_signal, action) => action();
  await adapter.send({ destination: { conversationId: 'original-chat' }, content: { text: 'plain' }, messageFormat: 'plain' });
  assert.deepEqual(calls, [{ chatId: 'original-chat', body: { msgtype: 'text', text: { content: 'plain' } } }]);
});
