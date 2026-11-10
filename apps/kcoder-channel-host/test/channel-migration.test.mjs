import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from '../src/channels/store.mjs';
import { importChannels } from '../src/channels/migration.mjs';
const event = { platform: 'qq', tenantId: 'tenant', chatKind: 'private', conversationId: 'chat',
  senderId: 'user', eventId: 'old-authenticated-message', text: 'old input', receivedAtMs: 100 };
const entry = () => ({ id: 'qq', platform: 'qq', label: 'Migrated', configuration: { appId: 'fixture-app' },
  credentials: { appSecret: 'FIXTURE_PRIVATE_VALUE' }, chats: [{ event,
    target: { serverId: 'original', workspacePath: '/original/project', threadId: 'original-task' } }] });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'channel-migration-')), store = new ChannelStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return store;
}
test('migration preserves authentication and binding but never replays authenticated historical messages', t => {
  const store = fixture(t), bundle = { version: 1, connections: [entry()] };
  assert.equal(importChannels(store, bundle).length, 1);
  const chat = store.chats('qq')[0];
  assert.equal(chat.binding.target.threadId, 'original-task');
  assert.equal(store.pendingInputs().length, 0);
  assert.equal(store.receive('qq', event).state, 'historical');
  assert.equal(store.connection('qq').enabled, false, 'import never starts a second listener');
  assert.deepEqual(store.credentials('qq'), entry().credentials);
  const revision = chat.binding.revision;
  importChannels(store, bundle);
  assert.equal(store.binding(chat.id).revision, revision, 're-import must not invalidate queued new input');
  const fresh = { ...event, eventId: 'new', receivedAtMs: 200, text: 'new input' };
  assert.equal(store.receive('qq', fresh).state, 'pending');
  importChannels(store, bundle);
  assert.equal(store.chat(chat.id).lastEvent.text, 'new input');
});
test('an invalid import rolls back all connection and credential changes', t => {
  const store = fixture(t), invalid = entry();
  invalid.chats[0].event = { ...event, platform: 'feishu' };
  assert.throws(() => importChannels(store, { version: 1, connections: [entry(), { ...invalid, id: 'bad' }] }), /PLATFORM_MISMATCH/);
  assert.deepEqual(store.connections(), []);
});
test('old signatures and secret-bearing public configuration are rejected instead of adopted', t => {
  const store = fixture(t);
  assert.throws(() => importChannels(store, { version: 1, connections: [{ ...entry(), nativeSignature: 'obsolete' }] }), /IMPORT_CONNECTION_INVALID/);
  assert.throws(() => importChannels(store, { version: 1, connections: [{ ...entry(), configuration: { appSecret: 'private' } }] }), /CONFIGURATION_INVALID/);
  assert.deepEqual(store.connections(), []);
});

test('platform reply context is portable without adopting an old local authorization deadline', t => {
  const store = fixture(t), connection = entry();
  connection.contexts = [
    { id: 'platform-reply', value: { contextToken: 'FIXTURE_CONTEXT', toUserId: 'fixture-user' }, expiresAtMs: null },
    { id: 'old-media', value: { url: 'https://invalid.test' }, expiresAtMs: 1 },
  ];
  importChannels(store, { version: 1, connections: [connection] });
  assert.equal(store.context('qq', 'platform-reply').contextToken, 'FIXTURE_CONTEXT');
  assert.throws(() => store.context('qq', 'old-media'), /PLATFORM_CONTEXT_EXPIRED/);
});

test('one-time migration discards retired routing policy and Native authority while preserving platform authentication', t => {
  const store = fixture(t), connection = entry();
  connection.configuration.routingMode = 'task_binding_v1';
  connection.configuration.nativeSignature = 'obsolete-configuration-signature';
  connection.credentials.nativeSignature = 'obsolete-credential-signature';
  connection.chats[0].event = { ...event, bindingRef: { id: 'old' }, delegationRef: 'old-grant', nativeSignature: 'old-proof' };
  importChannels(store, { version: 1, connections: [connection] });
  assert.deepEqual(store.connection('qq').configuration, { appId: 'fixture-app' });
  assert.deepEqual(store.credentials('qq'), { appSecret: 'FIXTURE_PRIVATE_VALUE' });
  const migrated = store.chats('qq')[0].lastEvent;
  assert.equal(migrated.nativeSignature, undefined); assert.equal(migrated.bindingRef, undefined);
  assert.equal(migrated.delegationRef, undefined); assert.equal(migrated.text, event.text);
});
