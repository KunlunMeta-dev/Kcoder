import { migrateChannelConfiguration, migrateChannelCredentials } from './configuration.mjs';

/** Import portable platform facts only. Old Native signatures, grants and filesystem identities have no role. */
export function importChannels(store, bundle) {
  if (bundle?.version !== 1 || !Array.isArray(bundle.connections) || bundle.connections.length > 100
    || Object.keys(bundle).some(key => !['version', 'connections'].includes(key))) throw new Error('CHANNEL_IMPORT_FORMAT_INVALID');
  return store.transaction(() => bundle.connections.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key =>
      !['id', 'platform', 'label', 'configuration', 'credentials', 'chats', 'contexts', 'checkpoint'].includes(key))) {
      throw new Error('CHANNEL_IMPORT_CONNECTION_INVALID');
    }
    const existing = store.connection(entry.id);
    if (existing?.enabled) throw new Error('CHANNEL_CONNECTION_STOP_REQUIRED');
    const connection = store.saveConnection({ id: entry.id, platform: entry.platform,
      label: entry.label, configuration: migrateChannelConfiguration(entry.platform, entry.configuration ?? {}), enabled: false },
      migrateChannelCredentials(entry.platform, entry.credentials));
    const chats = entry.chats ?? [], contexts = entry.contexts ?? [];
    if (!Array.isArray(chats) || chats.length > 10000 || !Array.isArray(contexts) || contexts.length > 10000) throw new Error('CHANNEL_IMPORT_CAPACITY');
    for (const context of contexts) {
      if (typeof context.id !== 'string' || (context.expiresAtMs !== null && !Number.isSafeInteger(context.expiresAtMs))) throw new Error('CHANNEL_IMPORT_CONTEXT_INVALID');
      if (context.expiresAtMs === null) store.putContext(connection.id, context.id, context.value);
      else if (context.expiresAtMs > Date.now()) store.putContext(connection.id, context.id, context.value, context.expiresAtMs - Date.now());
    }
    if (entry.checkpoint !== undefined) store.putContext(connection.id, 'checkpoint', entry.checkpoint);
    for (const chat of chats) {
      const observed = store.receive(connection.id, chat.event, { historical: true });
      if (chat.target) {
        const current = store.binding(observed.chatId);
        if (current && JSON.stringify(current.target) !== JSON.stringify(chat.target)) throw new Error('CHANNEL_IMPORT_BINDING_CONFLICT');
        store.bind(observed.chatId, chat.target);
      }
    }
    return { id: connection.id, platform: connection.platform, importedChats: chats.length };
  }));
}

