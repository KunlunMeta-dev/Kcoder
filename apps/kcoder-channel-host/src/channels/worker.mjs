import { ChannelStore } from './store.mjs';
import { officialAdapters } from '../adapters/index.mjs';
import { channelContextTtl } from '../adapters/contract.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNEL_WORKER_STATES as STATES, channelWorkerRpcFailure as rpcFailure, channelWorkerReasonCode } from './worker-protocol.mjs';


/** The process port is injectable so the production IPC handlers can be verified without a platform login. */
export function createChannelWorkerController({ port = process, adapters = officialAdapters, openStore = directory => new ChannelStore(directory) } = {}) {
let adapter, store, sequence = 0, stopping = false, reconnectTimer, reconnecting = false, reconnectFailures = 0;
let connectionId, generation, platform, lastReason = null;
const pending = new Map();
const requests = new Map();
function send(message, failed = () => {}) {
  if (!port.connected) { failed(); return; }
  try { port.send(message, error => { if (error) failed(); }); } catch { failed(); }
}
const reply = (id, result, error, externalOutcome) => send({ id, result, error, externalOutcome });
function snapshot() {
  let state = 'stopped', reason, reasonObserved = false;
  try { state = adapter?.connectionState?.() ?? 'stopped'; } catch { state = 'failed'; }
  if (state === 'connecting') state = 'starting';
  if (!STATES.has(state)) state = 'failed';
  try { reason = adapter?.connectionFailureReason?.(); reasonObserved = true; } catch { /* Invalid diagnostics cannot replace transport state. */ }
  const reasonCode = channelWorkerReasonCode(platform, reason);
  if (reasonObserved && (reason === null || reason === undefined || reasonCode)) lastReason = reasonCode;
  return { state, ...(connectionId === undefined || generation === undefined ? {} : { connectionId, generation }),
    ...(lastReason ? { reasonCode: lastReason } : {}) };
}
function parent(method, params) {
  const id = `worker-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CHANNEL_PARENT_TIMEOUT')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params }, () => {
      clearTimeout(timer); pending.delete(id); reject(new Error('CHANNEL_PARENT_UNAVAILABLE'));
    });
  });
}

function connectionChanged() {
  if (stopping) return;
  const current = snapshot(), state = current.state;
  send({ method: 'state', params: current });
  if (state === 'connected') reconnectFailures = 0;
  if (state !== 'degraded') { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
  if (state !== 'degraded' || stopping || reconnecting || reconnectTimer || !adapter.reconnect) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = undefined;
    if (stopping || snapshot().state !== 'degraded') return;
    reconnecting = true;
    try { await adapter.reconnect(); }
    catch { reconnectFailures++; }
    finally { reconnecting = false; if (!stopping) connectionChanged(); }
  }, Math.min(1000 * 2 ** Math.min(reconnectFailures, 6), 60000));
}

port.on('message', async message => {
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
      if (typeof connection?.id !== 'string' || !connection.id || (message.params.generation !== undefined &&
        (!Number.isSafeInteger(message.params.generation) || message.params.generation < 1)))
        throw new Error('CHANNEL_WORKER_SCOPE_INVALID');
      connectionId = connection.id; generation = message.params.generation; platform = connection.platform;
      store = openStore(directory);
      const factory = adapters().get(connection.platform);
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
      reply(message.id, snapshot());
    } else if (message.method === 'send') {
      if (!adapter) throw new Error('CHANNEL_WORKER_NOT_STARTED');
      const controller = new AbortController(); requests.set(message.id, controller);
      try { reply(message.id, await adapter.send(message.params.payload,
        { deliveryId: message.params.deliveryId, signal: controller.signal })); }
      finally { requests.delete(message.id); }
    } else if (message.method === 'state') {
      reply(message.id, snapshot());
    } else if (message.method === 'stop') {
      stopping = true; clearTimeout(reconnectTimer);
      for (const controller of requests.values()) controller.abort();
      await adapter?.stop(); store?.close(); reply(message.id, { stopped: true });
      port.disconnect();
    } else throw new Error('CHANNEL_WORKER_METHOD_UNSUPPORTED');
  } catch (error) {
    const failure = rpcFailure(error);
    reply(message.id, undefined, failure.code, failure.externalOutcome);
  }
});
const disconnected = async () => {
  stopping = true; clearTimeout(reconnectTimer);
  for (const controller of requests.values()) controller.abort();
  for (const original of pending.values()) { clearTimeout(original.timer); original.reject(new Error('CHANNEL_PARENT_UNAVAILABLE')); }
  pending.clear();
  try { await adapter?.stop(); } catch { /* Keep closing the remaining resources owned by this worker. */ }
  try { store?.close(); } catch { /* Shutdown may have already closed the store. */ }
  port.exit();
};
port.once('disconnect', disconnected);
return { close: disconnected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) createChannelWorkerController();
