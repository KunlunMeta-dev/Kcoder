import { randomUUID, createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateChannelConfiguration, migrateChannelCredentials, validateChannelConfiguration, validateChannelCredentials,
  withoutChannelAuthority } from './configuration.mjs';
import { ChannelSettingsFile } from './settings.mjs';
import { channelMessageContent } from '../adapters/feature-options.mjs';

const encode = value => JSON.stringify(value);
const decode = value => value == null ? null : JSON.parse(value);
const key = values => createHash('sha256').update(encode(values)).digest('hex');
function containsSecret(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, item]) => /token|secret|password|authorization|private.?key/i.test(name) || containsSecret(item));
}

function text(value, name, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
    throw new Error(`CHANNEL_INVALID_${name.toUpperCase()}`);
  }
  return value;
}

/** Portable connection data. Filesystem objects are not account or authorization identities. */
export class ChannelStore {
  constructor(directory, { settingsDirectory = directory } = {}) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) {
      throw new Error('CHANNEL_STORAGE_DIRECTORY_INVALID');
    }
    this.settingsFile = new ChannelSettingsFile(settingsDirectory);
    const file = join(this.directory, 'channels.sqlite3');
    let created = false;
    try {
      closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
      created = true;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        (process.platform !== 'win32' && (info.mode & 0o077))) {
      throw new Error('CHANNEL_STORAGE_FILE_INVALID');
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (created) this.initialize();
      if (this.db.prepare('PRAGMA user_version').get().user_version === 1) this.transaction(() => {
        if (this.db.prepare('PRAGMA user_version').get().user_version !== 1) return;
        this.db.exec(`ALTER TABLE connections ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
          CREATE INDEX outbox_chat ON outbox(chat_id);
          PRAGMA user_version=2;`);
        for (const row of this.db.prepare('SELECT id,platform,configuration FROM connections').all()) {
          this.db.prepare('UPDATE connections SET configuration=? WHERE id=?').run(encode(migrateChannelConfiguration(row.platform, decode(row.configuration))), row.id);
          const credential = this.credentials(row.id);
          if (credential) this.db.prepare('UPDATE credentials SET value=? WHERE connection_id=?').run(encode(migrateChannelCredentials(row.platform, credential)), row.id);
        }
        for (const row of this.db.prepare('SELECT id,event FROM inbox').all()) {
          this.db.prepare('UPDATE inbox SET event=? WHERE id=?').run(encode(withoutChannelAuthority(decode(row.event))), row.id);
        }
        for (const row of this.db.prepare('SELECT id,last_event FROM chats WHERE last_event IS NOT NULL').all()) {
          this.db.prepare('UPDATE chats SET last_event=? WHERE id=?').run(encode(withoutChannelAuthority(decode(row.last_event))), row.id);
        }
      });
      if (this.db.prepare('PRAGMA user_version').get().user_version === 2) this.transaction(() => {
        if (this.db.prepare('PRAGMA user_version').get().user_version !== 2) return;
        // Unknown historical creation/binding times remain null rather than becoming upgrade times.
        this.db.exec(`ALTER TABLE connections ADD COLUMN created_at_ms INTEGER;
          ALTER TABLE chats ADD COLUMN alias TEXT;
          ALTER TABLE chats ADD COLUMN alias_revision INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE bindings ADD COLUMN bound_at_ms INTEGER;
          CREATE INDEX inbox_chat ON inbox(chat_id);
          PRAGMA user_version=3;`);
      });
      if (this.db.prepare('PRAGMA user_version').get().user_version !== 3) {
        throw new Error('CHANNEL_STORAGE_VERSION_UNSUPPORTED');
      }
      this.installationId = this.db.prepare("SELECT value FROM metadata WHERE key='installationId'").get()?.value;
      if (!this.installationId) throw new Error('CHANNEL_STORAGE_METADATA_INVALID');
    } catch (error) { this.db.close(); throw error; }
  }

  initialize() {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE connections(id TEXT PRIMARY KEY, platform TEXT NOT NULL, label TEXT NOT NULL,
          configuration TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER);
        CREATE TABLE credentials(connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
          value TEXT NOT NULL);
        CREATE TABLE chats(id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          range_json TEXT NOT NULL, label TEXT NOT NULL, last_event TEXT, alias TEXT, alias_revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE bindings(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
          target TEXT NOT NULL, revision INTEGER NOT NULL, bound_at_ms INTEGER);
        CREATE TABLE inbox(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
          event TEXT NOT NULL, state TEXT NOT NULL, result TEXT, target TEXT, binding_revision INTEGER);
        CREATE INDEX inbox_chat ON inbox(chat_id);
        CREATE TABLE outbox(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
          payload TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);
        CREATE INDEX outbox_chat ON outbox(chat_id);
        CREATE TABLE contexts(connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          id TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(connection_id,id));
        PRAGMA user_version=3;
      `);
      this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('installationId', randomUUID());
    });
  }

  transaction(operation) {
    if (this.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }

  connection(id) {
    const row = this.db.prepare('SELECT * FROM connections WHERE id=?').get(id);
    return row && !row.retired ? { id: row.id, platform: row.platform, label: row.label,
      configuration: decode(row.configuration), enabled: Boolean(row.enabled), revision: row.revision,
      createdAtMs: row.created_at_ms ?? null } : null;
  }

  settings() {
    return this.settingsFile.read();
  }

  setSettings(settings) {
    return this.transaction(() => {
      const previous = this.settings();
      const saved = this.settingsFile.write(settings);
      if (!previous.mirrorClientTurns || !saved.mirrorClientTurns) this.cancelPendingClientMirrors();
      return saved;
    });
  }

  cancelPendingClientMirrors() {
    // Already dispatched sends keep their original receipt; only unsent mirrors are suppressed.
    this.db.prepare(`UPDATE outbox SET state='failed',receipt=?
      WHERE state IN ('pending','awaiting_task') AND json_extract(payload,'$.source.role') IN ('user','assistant')`)
      .run(encode({ code: 'CHANNEL_CLIENT_SYNC_DISABLED' }));
  }

  connections() {
    return this.db.prepare('SELECT id FROM connections WHERE retired=0 ORDER BY id').all().map(row => this.connection(row.id));
  }

  saveConnection({ id = randomUUID(), platform, label, configuration = {}, enabled = false }, credentials, expectedRevision) {
    text(id, 'id'); text(label, 'label', 256);
    validateChannelConfiguration(platform, configuration);
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
        Buffer.byteLength(encode(configuration)) > 64 * 1024 || containsSecret(configuration)) throw new Error('CHANNEL_CONFIGURATION_INVALID');
    return this.transaction(() => {
      const previous = this.connection(id);
      if (this.db.prepare('SELECT retired FROM connections WHERE id=?').get(id)?.retired) throw new Error('CHANNEL_CONNECTION_REMOVED');
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new Error('CHANNEL_CONNECTION_STATE_CHANGED');
      if (previous && previous.platform !== platform) throw new Error('CHANNEL_PLATFORM_IMMUTABLE');
      if (previous && previous.label === label && encode(previous.configuration) === encode(configuration)
        && previous.enabled === enabled && (credentials === undefined || encode(this.credentials(id)) === encode(credentials))) return previous;
      this.db.prepare(`INSERT INTO connections(id,platform,label,configuration,enabled,revision,created_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        platform=excluded.platform,label=excluded.label,configuration=excluded.configuration,
        enabled=excluded.enabled,revision=excluded.revision`).run(id, platform, label,
        encode(configuration), enabled ? 1 : 0, (previous?.revision ?? 0) + 1, Date.now());
      if (credentials !== undefined) {
        validateChannelCredentials(platform, credentials);
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
            Buffer.byteLength(encode(credentials)) > 64 * 1024) throw new Error('CHANNEL_CREDENTIALS_INVALID');
        this.db.prepare('INSERT INTO credentials VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET value=excluded.value')
          .run(id, encode(credentials));
      }
      return this.connection(id);
    });
  }

  credentials(id) {
    return decode(this.db.prepare('SELECT value FROM credentials WHERE connection_id=?').get(id)?.value);
  }

  renameConnection(id, label, expectedRevision) {
    text(label, 'label', 256);
    return this.transaction(() => {
      const current = this.connection(id);
      if (!current || current.revision !== expectedRevision) throw new Error('CHANNEL_CONNECTION_STATE_CHANGED');
      if (current.label !== label) this.db.prepare('UPDATE connections SET label=?,revision=revision+1 WHERE id=?').run(label, id);
      return this.connection(id);
    });
  }

  removeConnection(id, expectedRevision) {
    return this.transaction(() => {
      const connection = this.connection(id);
      if (!connection || connection.revision !== expectedRevision) throw new Error('CHANNEL_CONNECTION_STATE_CHANGED');
      if (connection.enabled) throw new Error('CHANNEL_CONNECTION_STOP_REQUIRED');
      this.db.prepare(`UPDATE bindings SET target='null',revision=revision+1
        WHERE chat_id IN (SELECT id FROM chats WHERE connection_id=?)`).run(id);
      this.db.prepare('DELETE FROM credentials WHERE connection_id=?').run(id);
      this.db.prepare('DELETE FROM contexts WHERE connection_id=?').run(id);
      this.db.prepare("UPDATE connections SET retired=1,configuration='{}',revision=revision+1 WHERE id=?").run(id);
      return { removed: true };
    });
  }

  setEnabled(id, enabled) {
    const connection = this.connection(id);
    if (!connection) throw new Error('CHANNEL_CONNECTION_NOT_FOUND');
    return this.saveConnection({ ...connection, enabled });
  }

  observeChat(connectionId, event) {
    event = withoutChannelAuthority(event);
    const connection = this.connection(connectionId);
    if (!connection) throw new Error('CHANNEL_CONNECTION_NOT_FOUND');
    if (event.platform !== connection.platform) throw new Error('CHANNEL_EVENT_PLATFORM_MISMATCH');
    const range = { platform: event.platform, connectionId,
      tenantId: text(event.tenantId ?? 'default', 'tenant'),
      chatKind: event.chatKind ?? 'private', chatId: text(event.conversationId, 'chat'), topicId: event.topicId ?? null };
    const id = key([connectionId, range.platform, range.tenantId, range.chatKind, range.chatId, range.topicId]);
    this.db.prepare(`INSERT INTO chats(id,connection_id,range_json,label,last_event) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      label=excluded.label,last_event=excluded.last_event
      WHERE coalesce(json_extract(excluded.last_event,'$.receivedAtMs'),json_extract(excluded.last_event,'$.occurredAtMs'),0)
        >= coalesce(json_extract(chats.last_event,'$.receivedAtMs'),json_extract(chats.last_event,'$.occurredAtMs'),0)`).run(id, connectionId, encode(range),
        String(event.chatLabel ?? range.chatId), encode(event));
    return this.chat(id);
  }

  chat(id) {
    const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id);
    return row ? { id: row.id, connectionId: row.connection_id, range: decode(row.range_json),
      label: row.label, alias: row.alias ?? '', aliasRevision: row.alias_revision,
      lastEvent: decode(row.last_event) } : null;
  }

  chats(connectionId) {
    return this.db.prepare('SELECT id FROM chats WHERE connection_id=? ORDER BY id').all(connectionId)
      .map(row => ({ ...this.chat(row.id), binding: this.binding(row.id) }));
  }

  renameChat(id, alias, expectedRevision) {
    if (typeof alias !== 'string' || alias.length > 256 || alias.includes('\0')) throw new Error('CHANNEL_INVALID_ALIAS');
    return this.transaction(() => {
      const current = this.chat(id);
      if (!current || current.aliasRevision !== expectedRevision) throw new Error('CHANNEL_CHAT_STATE_CHANGED');
      if (current.alias !== alias) this.db.prepare('UPDATE chats SET alias=?,alias_revision=alias_revision+1 WHERE id=?').run(alias, id);
      return this.chat(id);
    });
  }

  recentInputs(chatId) {
    return this.db.prepare('SELECT id,event,state FROM inbox WHERE chat_id=? ORDER BY rowid DESC LIMIT 3').all(chatId)
      .map(row => ({ id: row.id, event: decode(row.event), state: row.state }));
  }

  bind(chatId, target, expectedRevision) {
    return this.transaction(() => {
      this.checkBindingRevision(chatId, expectedRevision);
      if (!this.chat(chatId)) throw new Error('CHANNEL_CHAT_NOT_FOUND');
      text(target?.serverId, 'server'); text(target?.threadId, 'thread');
      if (target.workspacePath !== undefined) text(target.workspacePath, 'workspace', 32768);
      const current = this.binding(chatId);
      if (current && encode(current.target) === encode(target)) return current;
      this.db.prepare(`INSERT INTO bindings(chat_id,target,revision,bound_at_ms) VALUES(?,?,1,?) ON CONFLICT(chat_id) DO UPDATE SET
        target=excluded.target,revision=bindings.revision+1,bound_at_ms=excluded.bound_at_ms`).run(chatId, encode(target), Date.now());
      return this.binding(chatId);
    });
  }

  binding(chatId) {
    const row = this.db.prepare('SELECT * FROM bindings WHERE chat_id=?').get(chatId);
    return row && decode(row.target) ? { chatId, target: decode(row.target), revision: row.revision, boundAtMs: row.bound_at_ms ?? null } : null;
  }

  bindingRevision(chatId) {
    return this.db.prepare('SELECT revision FROM bindings WHERE chat_id=?').get(chatId)?.revision ?? 0;
  }

  checkBindingRevision(chatId, expectedRevision) {
    if (expectedRevision !== undefined && this.bindingRevision(chatId) !== expectedRevision) {
      throw new Error('CHANNEL_BINDING_CHANGED');
    }
  }

  unbind(chatId, expectedRevision) {
    return this.transaction(() => {
      if (!this.chat(chatId)) throw new Error('CHANNEL_CHAT_NOT_FOUND');
      this.checkBindingRevision(chatId, expectedRevision);
      // Keep the generation across unbind/rebind so queued input cannot follow a replacement binding.
      this.db.prepare("UPDATE bindings SET target='null',revision=revision+1 WHERE chat_id=?").run(chatId);
    });
  }

  receive(connectionId, event, { historical = false } = {}) {
    event = withoutChannelAuthority(event);
    text(event.eventId, 'event');
    return this.transaction(() => {
      const id = key([connectionId, event.sourceMessageId ?? event.eventId]);
      const previous = this.inbox(id);
      if (previous) return { ...previous, duplicate: true };
      const chat = this.observeChat(connectionId, event);
      const binding = this.binding(chat.id);
      const state = historical ? 'historical' : binding ? 'pending' : 'unbound';
      if (!historical && binding && this.db.prepare("SELECT count(*) AS count FROM inbox WHERE chat_id=? AND state IN ('pending','running')")
        .get(chat.id).count >= 100) throw new Error('CHANNEL_INPUT_CAPACITY');
      this.db.prepare('INSERT INTO inbox VALUES(?,?,?,?,NULL,?,?)').run(id, chat.id, encode(event), state,
        binding ? encode(binding.target) : null, binding?.revision ?? null);
      return { ...this.inbox(id), duplicate: false };
    });
  }

  inbox(id) {
    const row = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
    return row ? { id, chatId: row.chat_id, event: decode(row.event), state: row.state, result: decode(row.result),
      target: decode(row.target), bindingRevision: row.binding_revision } : null;
  }

  claimInput(id) {
    return this.db.prepare(`UPDATE inbox SET state='running' WHERE id=? AND state='pending'
      AND EXISTS(SELECT 1 FROM bindings WHERE bindings.chat_id=inbox.chat_id
        AND bindings.revision=inbox.binding_revision AND bindings.target=inbox.target)`)
      .run(id).changes === 1;
  }

  pendingInputs() { return this.db.prepare("SELECT id FROM inbox WHERE state='pending' ORDER BY rowid").all().map(row => this.inbox(row.id)); }

  unsettledInputs() { return this.db.prepare("SELECT id FROM inbox WHERE state IN ('running','unknown') ORDER BY rowid").all().map(row => this.inbox(row.id)); }

  pendingOutputs(connectionId) {
    return this.db.prepare(`SELECT outbox.id FROM outbox JOIN chats ON chats.id=outbox.chat_id
      WHERE outbox.state='pending' AND chats.connection_id=? ORDER BY outbox.rowid`)
      .all(connectionId).map(row => this.output(row.id));
  }

  deliverySummaries(chatId, bindingRevision) {
    return this.db.prepare(`SELECT id,state,receipt,json_extract(payload,'$.createdAtMs') AS created_at,
      json_extract(payload,'$.source.role') AS role FROM outbox
      WHERE chat_id=? AND json_extract(payload,'$.bindingRevision')=? ORDER BY rowid DESC LIMIT 20`)
      .all(chatId, bindingRevision).map(row => {
        const code = decode(row.receipt)?.code;
        return { deliveryId: row.id, deliveryState: row.state === 'awaiting_task' ? 'pending' : row.state,
          phase: row.role === 'user' ? 'mirrored_input' : row.role === 'assistant' ? 'mirrored_reply' : 'result',
          ...(row.created_at ? { createdAtMs: row.created_at } : {}),
          ...(/^[A-Z][A-Z0-9_]{1,100}$/.test(code ?? '') ? { code } : {}) };
      });
  }

  recordAcceptance(id, receipt) {
    this.db.prepare("UPDATE inbox SET result=? WHERE id=? AND state='running'").run(encode(receipt), id);
  }

  recoverInput(id, state, result) {
    if (!['completed', 'failed', 'unknown'].includes(state)) throw new Error('CHANNEL_INPUT_STATE_INVALID');
    const previous = this.inbox(id);
    if (previous?.state === state && encode(previous.result) === encode(result)) return;
    this.db.prepare("UPDATE inbox SET state=?,result=? WHERE id=? AND state IN ('running','unknown')").run(state, encode(result), id);
  }

  retirePending(id) { this.db.prepare("UPDATE inbox SET state='cancelled' WHERE id=? AND state='pending'").run(id); }

  settleInput(id, state, result) {
    if (!['completed', 'failed', 'unknown'].includes(state)) throw new Error('CHANNEL_INPUT_STATE_INVALID');
    this.db.prepare("UPDATE inbox SET state=?,result=? WHERE id=? AND state='running'").run(state, encode(result), id);
  }

  enqueueOutput(id, chatId, payload) {
    this.db.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,'pending',NULL)").run(id, chatId, encode(payload));
    const row = this.output(id);
    if (row.chatId !== chatId || encode(row.payload) !== encode(payload)) throw new Error('CHANNEL_OUTPUT_ID_CONFLICT');
    return row;
  }

  output(id) {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
    return row ? { id, chatId: row.chat_id, payload: decode(row.payload), state: row.state, receipt: decode(row.receipt) } : null;
  }

  hasRecentUnboundNotice(chatId, bindingRevision, sinceMs) {
    const row = this.db.prepare(`SELECT json_extract(payload,'$.createdAtMs') AS at_ms FROM outbox
      WHERE chat_id=? AND json_extract(payload,'$.bindingRequired')=1
        AND json_extract(payload,'$.bindingRevision')=? ORDER BY rowid DESC LIMIT 1`).get(chatId, bindingRevision);
    return row?.at_ms > sinceMs;
  }

  deferTaskOutput(id, source) {
    const row = this.output(id);
    if (row.state !== 'pending' || row.payload.source) return;
    this.db.prepare("UPDATE outbox SET state='awaiting_task',payload=? WHERE id=? AND state='pending'")
      .run(encode({ ...row.payload, source }), id);
  }

  waitingTaskOutputs() {
    return this.db.prepare("SELECT id FROM outbox WHERE state='awaiting_task' ORDER BY rowid").all().map(row => this.output(row.id));
  }

  resolveTaskOutput(id, text, code) {
    const row = this.output(id);
    if (row?.state !== 'awaiting_task') return;
    this.db.prepare("UPDATE outbox SET payload=?,state=?,receipt=? WHERE id=? AND state='awaiting_task'")
      .run(encode({ ...row.payload, content: channelMessageContent({ text: text ?? '' }, row.payload.messageFormat) }), code ? 'failed' : 'pending',
        code ? encode({ code }) : null, id);
  }

  replySequence(chatId, messageId) {
    return this.db.prepare(`SELECT count(*) AS count FROM outbox WHERE chat_id=?
      AND json_extract(payload,'$.destination.replyMessageId')=?`).get(chatId, messageId ?? null).count + 1;
  }

  recoverUnconfirmedOutputs() {
    this.db.prepare("UPDATE outbox SET state='unknown',receipt=? WHERE state='sending'")
      .run(encode({ code: 'CHANNEL_MANAGER_RESTARTED' }));
  }

  claimOutput(id) {
    return this.db.prepare("UPDATE outbox SET state='sending' WHERE id=? AND state='pending'").run(id).changes === 1;
  }

  settleOutput(id, state, receipt) {
    if (!['accepted', 'failed', 'unknown'].includes(state)) throw new Error('CHANNEL_OUTPUT_STATE_INVALID');
    this.db.prepare("UPDATE outbox SET state=?,receipt=? WHERE id=? AND state='sending'").run(state, encode(receipt), id);
  }

  putContext(connectionId, id, value, ttlMs) {
    text(id, 'context');
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) throw new Error('CHANNEL_CONTEXT_TTL_INVALID');
    this.db.prepare(`INSERT INTO contexts VALUES(?,?,?,?) ON CONFLICT(connection_id,id)
      DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`)
      .run(connectionId, id, encode(value), ttlMs === undefined ? Number.MAX_SAFE_INTEGER : Date.now() + ttlMs);
  }

  context(connectionId, id) {
    const row = this.db.prepare('SELECT value,expires_at FROM contexts WHERE connection_id=? AND id=?').get(connectionId, id);
    if (!row || row.expires_at <= Date.now()) throw Object.assign(new Error('PLATFORM_CONTEXT_EXPIRED'), { code: 'PLATFORM_CONTEXT_EXPIRED' });
    return decode(row.value);
  }

  removeContext(connectionId, id) {
    this.db.prepare('DELETE FROM contexts WHERE connection_id=? AND id=?').run(connectionId, id);
  }

  close() { this.db.close(); }
}
