import { ChannelStore } from './store.mjs';
import { officialAdapters } from '../adapters/index.mjs';
import { channelContextTtl } from '../adapters/contract.mjs';

let adapter, store, sequence = 0, stopping = false, reconnectTimer, reconnecting = false, reconnectFailures = 0;
const pending = new Map();
const requests = new Map();
const reply = (id, result, error, externalOutcome) => process.connected && process.send({ id, result, error, externalOutcome });
function parent(method, params) {
  const id = `worker-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CHANNEL_PARENT_TIMEOUT')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    process.send({ id, method, params });
  });
}

function connectionChanged() {
  const state = adapter.connectionState();
  if (process.connected) process.send({ method: 'state', params: { state } });
  if (state === 'connected') reconnectFailures = 0;
  if (state !== 'degraded' || stopping || reconnecting || reconnectTimer || !adapter.reconnect) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = undefined;
    if (stopping) return;
    reconnecting = true;
    try { await adapter.reconnect(); }
    catch { reconnectFailures++; }
    finally { reconnecting = false; if (!stopping) connectionChanged(); }
  }, Math.min(1000 * 2 ** Math.min(reconnectFailures, 6), 60000));
}

process.on('message', async message => {
  if (!message || typeof message !== 'object') return;
  const original = pending.get(message.id);
  if (original && !message.method) {
    pending.delete(message.id); clearTimeout(original.timer);
    return message.error ? original.reject(new Error(message.error)) : original.resolve(message.result);
  }
  if (!message.method) return;
  try {
    if (message.method === 'start') {
      if (adapter) throw new Error('CHANNEL_WORKER_ALREADY_STARTED');
      const { connection, credentials, directory } = message.params;
      store = new ChannelStore(directory);
      const factory = officialAdapters().get(connection.platform);
      if (!factory) throw new Error('CHANNEL_PLATFORM_UNSUPPORTED');
      const secretStore = {
        put: async (id, value, ttlMs) => store.putContext(connection.id, id, value,
          channelContextTtl(connection.platform, value, ttlMs)),
        get: async id => store.context(connection.id, id),
        remove: async id => store.removeContext(connection.id, id),
      };
      const checkpoint = {
        load: async () => { try { return store.context(connection.id, 'checkpoint'); }
          catch (error) { if (error.code === 'PLATFORM_CONTEXT_EXPIRED') return null; throw error; } },
        save: async value => store.putContext(connection.id, 'checkpoint', value),
      };
      adapter = factory({ configuration: { ...connection.configuration, channelId: connection.id }, credentials, secretStore, checkpoint });
      adapter.setConnectionObserver?.(connectionChanged);
      await adapter.start(event => parent('event', { event }));
      reply(message.id, { state: adapter.connectionState?.() ?? 'connected' });
    } else if (message.method === 'send') {
      if (!adapter) throw new Error('CHANNEL_WORKER_NOT_STARTED');
      const controller = new AbortController(); requests.set(message.id, controller);
      try { reply(message.id, await adapter.send(message.params.payload,
        { deliveryId: message.params.deliveryId, signal: controller.signal })); }
      finally { requests.delete(message.id); }
    } else if (message.method === 'state') {
      reply(message.id, { state: adapter?.connectionState?.() ?? 'stopped' });
    } else if (message.method === 'stop') {
      stopping = true; clearTimeout(reconnectTimer);
      for (const controller of requests.values()) controller.abort();
      await adapter?.stop(); store?.close(); reply(message.id, { stopped: true });
      process.disconnect();
    } else throw new Error('CHANNEL_WORKER_METHOD_UNSUPPORTED');
  } catch (error) {
    // Only fixed error codes cross IPC; SDK messages can contain private values.
    reply(message.id, undefined, /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code ?? error.message)
      ? error.code ?? error.message : 'CHANNEL_WORKER_FAILED', error.externalOutcome === 'failed' ? 'failed' : undefined);
  }
});
process.once('disconnect', async () => {
  stopping = true; clearTimeout(reconnectTimer);
  for (const controller of requests.values()) controller.abort();
  await adapter?.stop().catch(() => {});
  try { store?.close(); } catch { /* Shutdown may have already closed the store. */ }
  process.exit();
});
