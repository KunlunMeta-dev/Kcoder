import { migrateChannelConfiguration, migrateChannelCredentials } from './configuration.mjs';
import { isDeepStrictEqual } from 'node:util';
import { channelContextTtl } from '../adapters/contract.mjs';

export const CHANNEL_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 10_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function boundedBundle(bundle) {
  let bytes = 0;
  const add = count => { bytes += count; if (bytes > CHANNEL_IMPORT_MAX_BYTES) throw new Error('CHANNEL_IMPORT_TOO_LARGE'); };
  const string = value => { if (value.length > CHANNEL_IMPORT_MAX_BYTES - bytes) throw new Error('CHANNEL_IMPORT_TOO_LARGE'); add(Buffer.byteLength(JSON.stringify(value))); };
  const walk = (value, depth) => {
    if (depth > 32) throw new Error('CHANNEL_IMPORT_FORMAT_INVALID');
    if (typeof value === 'string') { string(value); return; }
    if (value === null) { add(4); return; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { add(String(value).length); return; }
    if (!object(value) && !Array.isArray(value)) throw new Error('CHANNEL_IMPORT_FORMAT_INVALID');
    if (object(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('CHANNEL_IMPORT_FORMAT_INVALID');
    add(2); let count = 0;
    if (Array.isArray(value)) for (const item of value) { if (count++) add(1); walk(item, depth + 1); }
    else for (const key in value) { if (!Object.hasOwn(value, key)) continue; if (count++) add(1); string(key); add(1); walk(value[key], depth + 1); }
  };
  walk(bundle, 0);
}

/** Validate private portable input before opening a target or beginning a write transaction. */
export function validateChannelImport(bundle) {
  if (bundle?.version !== 1 || !Array.isArray(bundle.connections) || bundle.connections.length > 100
    || Object.keys(bundle).some(key => !['version', 'connections'].includes(key))) throw new Error('CHANNEL_IMPORT_FORMAT_INVALID');
  let records = 0;
  for (const entry of bundle.connections) {
    if (!object(entry) || Object.keys(entry).some(key => !['id', 'platform', 'label', 'configuration', 'credentials', 'chats', 'contexts', 'checkpoint'].includes(key))
      || typeof entry.id !== 'string' || !entry.id || entry.id.length > 512 || entry.id.includes('\0')
      || typeof entry.label !== 'string' || !entry.label || entry.label.length > 256 || entry.label.includes('\0')) throw new Error('CHANNEL_IMPORT_CONNECTION_INVALID');
    const chats = entry.chats ?? [], contexts = entry.contexts ?? [];
    if (!Array.isArray(chats) || !Array.isArray(contexts)) throw new Error('CHANNEL_IMPORT_CAPACITY');
    records += chats.length + contexts.length;
    if (records > MAX_IMPORT_RECORDS) throw new Error('CHANNEL_IMPORT_CAPACITY');
    for (const context of contexts) if (!object(context) || typeof context.id !== 'string' || !context.id
      || !Object.hasOwn(context, 'value') || context.value === undefined
      || (context.expiresAtMs !== null && !Number.isSafeInteger(context.expiresAtMs))) throw new Error('CHANNEL_IMPORT_CONTEXT_INVALID');
    for (const chat of chats) if (!object(chat) || !object(chat.event) || typeof chat.event.eventId !== 'string'
      || !chat.event.eventId || typeof chat.event.conversationId !== 'string') throw new Error('CHANNEL_IMPORT_CHAT_INVALID');
    migrateChannelConfiguration(entry.platform, entry.configuration ?? {});
    migrateChannelCredentials(entry.platform, entry.credentials);
  }
  boundedBundle(bundle);
  return bundle;
}

function historicalEvent(event, now) {
  const valid = value => Number.isSafeInteger(value) && value >= 0 && value <= now;
  const value = { ...event, receivedAtMs: valid(event.receivedAtMs) ? event.receivedAtMs : valid(event.occurredAtMs) ? event.occurredAtMs : null };
  if (event.occurredAtMs !== undefined && event.occurredAtMs !== null && !valid(event.occurredAtMs)) value.occurredAtMs = null;
  return value;
}

/** Import portable platform facts only. Old Native signatures, grants and filesystem identities have no role. */
export function importChannels(store, bundle) {
  validateChannelImport(bundle);
  const now = Date.now();
  return store.transaction(() => bundle.connections.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key =>
      !['id', 'platform', 'label', 'configuration', 'credentials', 'chats', 'contexts', 'checkpoint'].includes(key))) {
      throw new Error('CHANNEL_IMPORT_CONNECTION_INVALID');
    }
    const existing = store.connection(entry.id);
    if (existing?.enabled) throw new Error('CHANNEL_CONNECTION_STOP_REQUIRED');
    const configuration = migrateChannelConfiguration(entry.platform, entry.configuration ?? {});
    const credentials = migrateChannelCredentials(entry.platform, entry.credentials);
    if (existing && (existing.platform !== entry.platform || !isDeepStrictEqual(existing.configuration, configuration)
      || !isDeepStrictEqual(store.credentials(entry.id), credentials))) throw new Error('CHANNEL_IMPORT_CONNECTION_CONFLICT');
    const connection = existing ?? store.saveConnection({ id: entry.id, platform: entry.platform,
      label: entry.label, configuration, enabled: false }, credentials, 0);
    const chats = entry.chats ?? [], contexts = entry.contexts ?? [];
    if (!Array.isArray(chats) || chats.length > 10000 || !Array.isArray(contexts) || contexts.length > 10000) throw new Error('CHANNEL_IMPORT_CAPACITY');
    for (const context of contexts) {
      if (typeof context.id !== 'string' || (context.expiresAtMs !== null && !Number.isSafeInteger(context.expiresAtMs))) throw new Error('CHANNEL_IMPORT_CONTEXT_INVALID');
      if (existing) continue;
      const contextNow = Date.now();
      const ttl = channelContextTtl(entry.platform, context.value, context.expiresAtMs === null ? undefined : context.expiresAtMs - contextNow);
      if (ttl === undefined) store.putContext(connection.id, context.id, context.value);
      else if (ttl > 0) store.putContextUntil(connection.id, context.id, context.value, contextNow + ttl);
    }
    if (!existing && entry.checkpoint !== undefined) store.putContext(connection.id, 'checkpoint', entry.checkpoint);
    for (const chat of chats) {
      const observed = store.receive(connection.id, historicalEvent(chat.event, now), { historical: true });
      if (chat.target) {
        const current = store.binding(observed.chatId);
        if (current && !isDeepStrictEqual(current.target, chat.target)) throw new Error('CHANNEL_IMPORT_BINDING_CONFLICT');
        store.bind(observed.chatId, chat.target);
      }
    }
    return { id: connection.id, platform: connection.platform, importedChats: chats.length };
  }));
}

