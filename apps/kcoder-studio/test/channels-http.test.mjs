import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelRuntime } from '../../kcoder-channel-host/src/channels/runtime.mjs';
import { createChannelsHttpHandler } from '../src/channels-http.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-http-'));
  const runtime = new ChannelRuntime({ directory, tasks: { run: async () => {}, recover: async () => ({ state: 'unknown' }) } });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const validated = [], resolved = [];
  const descriptions = [];
  const controller = { runtime, validateTarget: async target => validated.push(target), bindingChanged: async () => {},
    describeTarget: async target => { descriptions.push(target); return { title: 'Original task title' }; } };
  const handler = createChannelsHttpHandler({ controller,
    targetLabel: id => `Computer ${id}`,
    requestBody: async request => JSON.stringify(request.body), requireSameOriginMutation: request => request.sameOrigin !== false,
    jsonResponse: (response, status, body) => Object.assign(response, { status, body }),
    resolveTarget: async (target, context) => { resolved.push(context); return { ...target, loginOwner: 'private-target-login-owner' }; },
  });
  async function call(body, options = {}) {
    const response = {};
    await handler({ request: { method: 'POST', body, ...options }, response, pathname: '/api/channels', session: 'authenticated-session', loginOwner: 'owner' });
    return response;
  }
  return { runtime, handler, call, validated, resolved, controller, descriptions };
}
const configured = { id: 'bot', platform: 'qq', label: 'Test bot', configuration: { appId: 'fixture-app' } };
const event = { platform: 'qq', eventId: 'observed', conversationId: 'chat', senderId: 'user', text: 'private-input' };

test('the authenticated Gateway can bind an observed chat directly without channel grants or signatures', async t => {
  const { runtime, call, validated, resolved } = fixture(t);
  runtime.store.saveConnection(configured, { appSecret: 'FIXTURE_SECRET' });
  const chat = runtime.store.observeChat('bot', event);
  const target = { serverId: 'local', workspacePath: '/project', threadId: 'original-task' };
  const response = await call({ action: 'bind', chatId: chat.id, target, expectedBindingRevision: 0 });
  assert.equal(response.status, 200); assert.deepEqual(response.body.target, target);
  assert.equal(validated.length, 1); assert.equal(resolved[0].session, 'authenticated-session');
  assert.equal(JSON.stringify(response.body).includes('private-target-login-owner'), false);
  assert.equal(runtime.store.binding(chat.id).target.threadId, 'original-task');
  assert.equal((await call({ action: 'unbind', chatId: chat.id, expectedBindingRevision: response.body.revision })).status, 200);
  assert.equal(runtime.store.binding(chat.id), null);
});

test('a stale browser cannot replace or remove another client\'s newer chat binding', async t => {
  const { runtime, call } = fixture(t);
  runtime.store.saveConnection(configured, { appSecret: 'FIXTURE_SECRET' });
  const chat = runtime.store.observeChat('bot', event);
  const target = { serverId: 'local', workspacePath: '/project', threadId: 'first-task' };
  const first = await call({ action: 'bind', chatId: chat.id, target, expectedBindingRevision: 0 });
  assert.equal(first.status, 200);
  const replaced = await call({ action: 'bind', chatId: chat.id, target: { ...target, threadId: 'second-task' }, expectedBindingRevision: first.body.revision });
  assert.equal(replaced.status, 200);
  const stale = await call({ action: 'unbind', chatId: chat.id, expectedBindingRevision: first.body.revision });
  assert.equal(stale.body.code, 'CHANNEL_BINDING_CHANGED');
  assert.equal(runtime.store.binding(chat.id).target.threadId, 'second-task');
});

test('inventory exposes bounded human message previews, excluding credentials and SDK context fields', async t => {
  const { runtime, handler } = fixture(t);
  runtime.store.saveConnection(configured, { appSecret: 'FIXTURE_SECRET' });
  runtime.store.observeChat('bot', { ...event, replyRef: 'PRIVATE_REPLY_REF', contextToken: 'PRIVATE_TOKEN', raw: { secret: 'PRIVATE_ENVELOPE' } });
  runtime.store.putContext('bot', 'reply-context', { contextToken: 'FIXTURE_CONTEXT' });
  const response = {};
  await handler({ request: { method: 'GET' }, response, pathname: '/api/channels' });
  assert.equal(response.status, 200); assert.equal(response.body.connections[0].hasCredential, true);
  assert.equal(response.body.chats[0].lastMessage.text, 'private-input');
  for (const privateValue of ['FIXTURE_SECRET', 'FIXTURE_CONTEXT', 'PRIVATE_REPLY_REF', 'PRIVATE_TOKEN', 'PRIVATE_ENVELOPE']) assert.equal(JSON.stringify(response.body).includes(privateValue), false);
});

test('renames are revision checked and do not restart connected workers or change their credentials', async t => {
  const { runtime, call } = fixture(t);
  const saved = runtime.store.saveConnection({ ...configured, enabled: true }, { appSecret: 'PRESERVED' });
  const chat = runtime.store.observeChat('bot', event);
  const response = await call({ action: 'rename_connection', connectionId: 'bot', label: 'Human readable bot', expectedRevision: saved.revision });
  assert.equal(response.status, 200); assert.equal(response.body.enabled, true);
  assert.equal(runtime.store.credentials('bot').appSecret, 'PRESERVED');
  assert.equal((await call({ action: 'rename_connection', connectionId: 'bot', label: 'stale', expectedRevision: saved.revision })).status, 409);
  assert.equal((await call({ action: 'rename_chat', chatId: chat.id, alias: 'My phone', expectedAliasRevision: 0 })).body.alias, 'My phone');
  assert.equal((await call({ action: 'rename_chat', chatId: chat.id, alias: 'stale', expectedAliasRevision: 0 })).status, 409);
  assert.equal((await call({ action: 'rename_connection', connectionId: 'bot', label: 'No', expectedRevision: response.body.revision }, { sameOrigin: false })).status, 403);
});

test('chat details read at most three Inbox messages and resolve only the authorized original target on demand', async t => {
  const { runtime, handler, descriptions } = fixture(t);
  runtime.store.saveConnection(configured, { appSecret: 'PRIVATE_CREDENTIAL' });
  let input;
  for (let n = 0; n < 5; n++) input = runtime.store.receive('bot', { ...event, eventId: `message-${n}`, text: `input ${n}`, receivedAtMs: n + 1,
    replyRef: 'PRIVATE_REPLY', attachments: [{ kind: 'file', filename: 'report.txt', mediaId: 'PRIVATE_MEDIA' }] });
  runtime.store.bind(input.chatId, { serverId: 'local', workspacePath: '/owned/project', threadId: 'original', loginOwner: 'private-target-login-owner' }, 0);
  const inventory = {}; await handler({ request: { method: 'GET' }, response: inventory, pathname: '/api/channels' });
  assert.equal(descriptions.length, 0);
  const response = {}; await handler({ request: { method: 'GET', url: `/api/channels?chatId=${input.chatId}` }, response, pathname: '/api/channels', session: 'current', loginOwner: 'owner' });
  assert.equal(response.status, 200); assert.equal(response.body.bindingInfo.title, 'Original task title');
  assert.equal(response.body.bindingInfo.serverLabel, 'Computer local');
  assert.deepEqual(response.body.messages.map(message => message.text), ['input 4', 'input 3', 'input 2']);
  assert.equal(descriptions[0].workspacePath, '/owned/project');
  for (const secret of ['PRIVATE_CREDENTIAL', 'PRIVATE_REPLY', 'PRIVATE_MEDIA', 'private-target-login-owner']) assert.equal(JSON.stringify(response.body).includes(secret), false);
});

test('a changed binding or target login cannot publish a stale or foreign task title', async t => {
  const { runtime, handler, controller, descriptions } = fixture(t);
  runtime.store.saveConnection(configured, { appSecret: 'secret' });
  const chat = runtime.store.observeChat('bot', event);
  runtime.store.bind(chat.id, { serverId: 'local', threadId: 'foreign', loginOwner: 'another-account' }, 0);
  const read = async () => {
    const response = {}; await handler({ request: { method: 'GET', url: `/api/channels?chatId=${chat.id}` }, response, pathname: '/api/channels', loginOwner: 'owner' }); return response;
  };
  assert.equal((await read()).body.bindingInfo.status, 'unavailable'); assert.equal(descriptions.length, 0);
  runtime.store.bind(chat.id, { serverId: 'local', threadId: 'original', loginOwner: 'private-target-login-owner' }, 1);
  controller.describeTarget = async () => {
    runtime.store.unbind(chat.id, 2); return { title: 'STALE_PRIVATE_TITLE' };
  };
  const changed = await read(); assert.equal(changed.status, 409); assert.equal(changed.body.code, 'CHANNEL_BINDING_CHANGED');
  assert.equal(JSON.stringify(changed.body).includes('STALE_PRIVATE_TITLE'), false);
});

test('origin rejection and stale revisions cannot modify platform credentials', async t => {
  const { runtime, call } = fixture(t);
  assert.equal((await call({ action: 'save', connection: configured }, { sameOrigin: false })).status, 403);
  assert.deepEqual(runtime.store.connections(), []);
  runtime.store.saveConnection(configured, { appSecret: 'ORIGINAL' });
  const stale = await call({ action: 'save', connection: { ...configured, label: 'Changed' },
    credentials: { appSecret: 'REPLACEMENT' }, expectedRevision: 0 });
  assert.equal(stale.body.code, 'CHANNEL_CONNECTION_STATE_CHANGED');
  assert.deepEqual(runtime.store.credentials('bot'), { appSecret: 'ORIGINAL' });
});

test('one Gateway setting controls all client mirrors and requires a same-origin boolean update', async t => {
  const { runtime, call, handler } = fixture(t);
  const response = {};
  await handler({ request: { method: 'GET' }, response, pathname: '/api/channels' });
  assert.equal(response.body.settings.mirrorClientTurns, false);
  assert.equal(response.body.settings.toolRestrictions.enabled, true);
  assert.equal((await call({ action: 'settings', settings: { mirrorClientTurns: true } }, { sameOrigin: false })).status, 403);
  for (const settings of [{ mirrorClientTurns: 'true' }, { mirrorClientTurns: true, secret: 'no' }, null])
    assert.equal((await call({ action: 'settings', settings })).body.code, 'CHANNEL_SETTINGS_INVALID');
  assert.equal((await call({ action: 'settings', settings: { mirrorClientTurns: true } })).body.mirrorClientTurns, true);
  assert.equal(runtime.store.settings().mirrorClientTurns, true);
  await call({ action: 'settings', settings: { mirrorClientTurns: false } });
  assert.equal(runtime.store.settings().mirrorClientTurns, false);
});
