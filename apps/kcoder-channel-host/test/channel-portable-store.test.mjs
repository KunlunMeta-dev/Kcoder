import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, copyFileSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from '../src/channels/store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'jsonc-parser';

const connection = { id: 'feishu-test', platform: 'feishu', label: 'Test',
  configuration: { appId: 'fixture-app' }, enabled: true };
const event = { platform: 'feishu', tenantId: 'fixture-tenant', chatKind: 'private',
  conversationId: 'fixture-chat', senderId: 'fixture-user', eventId: 'event-1', text: 'hello' };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kcoder-portable-channel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('client sync defaults off and its explicit setting survives reopening without changing connection data', t => {
  const directory = fixture(t);
  const store = new ChannelStore(directory);
  assert.equal(store.settings().mirrorClientTurns, false);
  assert.equal(store.settings().toolRestrictions.enabled, true);
  store.saveConnection(connection, { appSecret: 'fixture-secret' });
  store.setSettings({ mirrorClientTurns: true });
  const settingsPath = join(directory, 'settings.json');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { meta: { config_version: 2 }, channels: { mirror_client_turns: true } });
  if (process.platform !== 'win32') assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='mirrorClientTurns'").get(), undefined);
  store.close();
  const reopened = new ChannelStore(directory);
  try {
    assert.equal(reopened.settings().mirrorClientTurns, true);
    assert.deepEqual(reopened.connection(connection.id).configuration, connection.configuration);
    assert.deepEqual(reopened.credentials(connection.id), { appSecret: 'fixture-secret' });
    assert.throws(() => reopened.setSettings({ mirrorClientTurns: 'false' }), /CHANNEL_SETTINGS_INVALID/);
    reopened.setSettings({ mirrorClientTurns: false });
    assert.equal(reopened.settings().mirrorClientTurns, false);
  } finally { reopened.close(); }
});

test('Studio settings retain JSONC comments and other domains; malformed or future documents are not overwritten', t => {
  const directory = fixture(t), store = new ChannelStore(directory);
  const path = join(directory, 'settings.json');
  try {
    writeFileSync(path, '// Studio preferences\n{\n  "channels": {\n    // Explicit user choice\n    "mirror_client_turns": true,\n    "future_option": 3,\n  },\n  "other_domain": {"value": "preserve me"},\n}\n', { mode: 0o600 });
    assert.equal(store.settings().mirrorClientTurns, true);
    store.setSettings({ mirrorClientTurns: false });
    const saved = readFileSync(path, 'utf8');
    assert.ok(saved.includes('// Studio preferences'));
    assert.ok(saved.includes('// Explicit user choice'));
    assert.deepEqual(parse(saved), { meta: { config_version: 2 }, channels: { mirror_client_turns: false, future_option: 3 }, other_domain: { value: 'preserve me' } });
    for (const value of [
      '{invalid', JSON.stringify({ meta: { config_version: 1 }, channels: { mirror_client_turns: 'true' } }),
      JSON.stringify({ meta: { config_version: 999 }, channels: { mirror_client_turns: true } }),
      JSON.stringify({ meta: { config_version: null } }), JSON.stringify({ channels: null }),
    ]) {
      writeFileSync(path, value);
      assert.throws(() => store.settings(), /CHANNEL_SETTINGS/);
      assert.throws(() => store.setSettings({ mirrorClientTurns: true }), /CHANNEL_SETTINGS/);
      assert.equal(readFileSync(path, 'utf8'), value);
    }
  } finally { store.close(); }
});

test('Gateway supplies the Studio directory and upgrades the legacy setting there', t => {
  const studio = fixture(t), directory = join(studio, 'channels');
  const store = new ChannelStore(directory, { settingsDirectory: studio });
  t.after(() => store.close());
  const path = join(studio, 'settings.json');
  writeFileSync(path, '{"mirror_client_turns":true,"channels":{}}');
  assert.equal(store.settings().mirrorClientTurns, true);
  store.setSettings({ mirrorClientTurns: true });
  assert.equal(parse(readFileSync(path, 'utf8')).channels.mirror_client_turns, true);
  assert.equal(existsSync(join(directory, 'settings.json')), false);
});

test('channel settings do not replace invalid UTF-8 or publish edits beyond their file budget', t => {
  const directory = fixture(t), store = new ChannelStore(directory), path = join(directory, 'settings.json');
  t.after(() => store.close());
  const corrupt = Buffer.concat([Buffer.from('{"channels":{"mirror_client_turns":true},"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  writeFileSync(path, corrupt);
  assert.throws(() => store.settings(), /CHANNEL_SETTINGS_INVALID/);
  assert.throws(() => store.setSettings({ mirrorClientTurns: false }), /CHANNEL_SETTINGS_INVALID/);
  assert.deepEqual(readFileSync(path), corrupt);
  const template = JSON.stringify({ channels: {}, note: '' });
  const full = JSON.stringify({ channels: {}, note: 'a'.repeat(65536 - Buffer.byteLength(template)) });
  writeFileSync(path, full);
  assert.equal(store.settings().mirrorClientTurns, false);
  assert.throws(() => store.setSettings({ mirrorClientTurns: true }), /CONFIG_FILE_TOO_LARGE/);
  assert.equal(readFileSync(path, 'utf8'), full);
});

test('connection credentials and chat/task binding survive file-identity-changing migration', t => {
  const first = fixture(t), second = fixture(t);
  const original = new ChannelStore(first);
  original.saveConnection(connection, { appSecret: 'FIXTURE_SECRET' });
  const chat = original.observeChat(connection.id, event);
  original.bind(chat.id, { serverId: 'local', workspacePath: '/fixture/project', threadId: 'original-task' });
  const installationId = original.installationId;
  original.close();
  copyFileSync(join(first, 'channels.sqlite3'), join(second, 'channels.sqlite3'));
  assert.notEqual(statSync(join(first, 'channels.sqlite3')).ino, statSync(join(second, 'channels.sqlite3')).ino);
  rmSync(first, { recursive: true });
  const restored = new ChannelStore(second);
  t.after(() => restored.close());
  assert.equal(restored.installationId, installationId);
  assert.deepEqual(restored.credentials(connection.id), { appSecret: 'FIXTURE_SECRET' });
  assert.equal(restored.binding(chat.id).target.threadId, 'original-task');
  assert.equal(restored.connection(connection.id).configuration.appId, 'fixture-app');
  assert.equal(JSON.stringify(restored.connections()).includes('FIXTURE_SECRET'), false);
});

test('an unbound input is retained without being replayed when its chat is later bound', t => {
  const store = new ChannelStore(fixture(t)); t.after(() => store.close());
  store.saveConnection(connection);
  const input = store.receive(connection.id, event);
  assert.equal(input.state, 'unbound');
  store.bind(input.chatId, { serverId: 'local', threadId: 'task' });
  assert.equal(store.claimInput(input.id), false);
  assert.equal(store.receive(connection.id, event).duplicate, true);
  const next = store.receive(connection.id, { ...event, eventId: 'event-2' });
  assert.equal(next.state, 'pending');
  assert.equal(store.claimInput(next.id), true);
  assert.equal(store.claimInput(next.id), false);
});

test('concurrent store handles accept a source message and claim a send only once', t => {
  const directory = fixture(t), first = new ChannelStore(directory), second = new ChannelStore(directory);
  t.after(() => { second.close(); first.close(); });
  first.saveConnection(connection);
  const input = first.receive(connection.id, event);
  assert.equal(second.receive(connection.id, event).duplicate, true);
  first.enqueueOutput('delivery-1', input.chatId, { text: 'result' });
  assert.equal(second.claimOutput('delivery-1'), true);
  assert.equal(first.claimOutput('delivery-1'), false);
  second.settleOutput('delivery-1', 'unknown', { reason: 'response_lost' });
  assert.equal(first.claimOutput('delivery-1'), false);
  assert.equal(first.output('delivery-1').state, 'unknown');
});

test('a failed credential update rolls back its configuration mutation', t => {
  const store = new ChannelStore(fixture(t)); t.after(() => store.close());
  store.saveConnection(connection, { appSecret: 'FIXTURE_SECRET' });
  assert.throws(() => store.saveConnection({ ...connection, label: 'Changed' }, 'invalid'));
  assert.equal(store.connection(connection.id).label, 'Test');
  assert.deepEqual(store.credentials(connection.id), { appSecret: 'FIXTURE_SECRET' });
});

test('removal clears connection credentials and SDK contexts while preserving task and delivery facts', t => {
  const store = new ChannelStore(fixture(t)); t.after(() => store.close());
  store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Owned' }, { appSecret: 'FIXTURE_SECRET' });
  const known = store.receive('bot', { platform: 'feishu', eventId: 'historical', conversationId: 'chat', text: 'kept' }, { historical: true });
  store.bind(known.chatId, { serverId: 'server', threadId: 'original-task' });
  store.putContext('bot', 'context', { token: 'FIXTURE_CONTEXT' });
  store.enqueueOutput('unknown-send', known.chatId, { destination: {}, content: { text: 'reply' } });
  store.claimOutput('unknown-send'); store.settleOutput('unknown-send', 'unknown', {});
  const connection = store.connection('bot');
  store.removeConnection('bot', connection.revision);
  assert.equal(store.connection('bot'), null); assert.equal(store.credentials('bot'), null);
  assert.equal(store.binding(known.chatId), null); assert.equal(store.inbox(known.id).state, 'historical');
  assert.equal(store.output('unknown-send').state, 'unknown');
  assert.throws(() => store.context('bot', 'context'), /PLATFORM_CONTEXT_EXPIRED/);
  assert.throws(() => store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Recreated' }), /REMOVED/);
});

for (const version of [1, 2]) test(`channel database v${version} upgrades without replacing identities, credentials or receipts`, t => {
  const directory = fixture(t), original = new ChannelStore(directory);
  original.saveConnection(connection, { appSecret: 'FIXTURE_PRESERVED_SECRET' });
  const input = original.receive(connection.id, event, { historical: true });
  original.bind(input.chatId, { serverId: 'target', threadId: 'original-task' });
  original.enqueueOutput('original-delivery', input.chatId, { destination: {}, content: { text: 'kept reply' } });
  const installationId = original.installationId;
  original.close();
  const oldVersion = new DatabaseSync(join(directory, 'channels.sqlite3'));
  oldVersion.exec(`ALTER TABLE connections DROP COLUMN created_at_ms;
    ALTER TABLE chats DROP COLUMN alias; ALTER TABLE chats DROP COLUMN alias_revision;
    ALTER TABLE bindings DROP COLUMN bound_at_ms; DROP INDEX inbox_chat;`);
  if (version === 1) oldVersion.exec('ALTER TABLE connections DROP COLUMN retired; DROP INDEX outbox_chat;');
  oldVersion.exec(`PRAGMA user_version=${version};`);
  oldVersion.close();
  const migrated = new ChannelStore(directory); t.after(() => migrated.close());
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(migrated.connection(connection.id).createdAtMs, null);
  assert.equal(migrated.binding(input.chatId).boundAtMs, null);
  assert.equal(migrated.installationId, installationId);
  assert.equal(migrated.credentials(connection.id).appSecret, 'FIXTURE_PRESERVED_SECRET');
  assert.equal(migrated.binding(input.chatId).target.threadId, 'original-task');
  assert.equal(migrated.output('original-delivery').state, 'pending');
  assert.equal(migrated.inbox(input.id).state, 'historical');
});

test('a failed presentation migration rolls back and an unknown database version is never reset', t => {
  const directory = fixture(t), store = new ChannelStore(directory);
  store.saveConnection(connection, { appSecret: 'preserved' }); store.close();
  const file = join(directory, 'channels.sqlite3'), damaged = new DatabaseSync(file);
  damaged.exec('ALTER TABLE connections DROP COLUMN created_at_ms; PRAGMA user_version=2;');
  damaged.close();
  assert.throws(() => new ChannelStore(directory), /duplicate column/);
  const inspect = new DatabaseSync(file);
  assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(inspect.prepare('PRAGMA table_info(connections)').all().some(row => row.name === 'created_at_ms'), false);
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM credentials').get().n, 1);
  inspect.exec('PRAGMA user_version=99;'); inspect.close();
  assert.throws(() => new ChannelStore(directory), /VERSION_UNSUPPORTED/);
  const unchanged = new DatabaseSync(file); t.after(() => unchanged.close());
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(unchanged.prepare('SELECT count(*) AS n FROM connections').get().n, 1);
});

test('presentation renames preserve a running connection, original creation time and routing; chat aliases survive later messages', t => {
  const store = new ChannelStore(fixture(t)); t.after(() => store.close());
  const original = store.saveConnection(connection, { appSecret: 'private-existing-secret' });
  const input = store.receive(connection.id, event);
  const binding = store.bind(input.chatId, { serverId: 'local', workspacePath: '/project', threadId: 'task' }, 0);
  const renamed = store.renameConnection(connection.id, 'Personal dev bot', original.revision);
  assert.equal(renamed.enabled, true); assert.equal(renamed.createdAtMs, original.createdAtMs);
  assert.equal(store.credentials(connection.id).appSecret, 'private-existing-secret');
  assert.deepEqual(store.binding(input.chatId), binding);
  assert.throws(() => store.renameConnection(connection.id, 'stale', original.revision), /STATE_CHANGED/);
  const alias = store.renameChat(input.chatId, 'My test chat', 0);
  store.receive(connection.id, { ...event, eventId: 'later-event', text: 'new input' });
  assert.equal(store.chat(input.chatId).alias, 'My test chat');
  assert.throws(() => store.renameChat(input.chatId, 'stale', 0), /STATE_CHANGED/);
  assert.equal(store.renameChat(input.chatId, '', alias.aliasRevision).alias, '');
  assert.equal(store.inbox(input.id).state, 'unbound');
});
