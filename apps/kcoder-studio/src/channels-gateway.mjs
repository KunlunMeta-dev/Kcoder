import { createChannelsController } from './channels-controller.mjs';
import { createChannelsHttpHandler } from './channels-http.mjs';
import { CHANNEL_INVENTORY_CHANGED } from '../shared/channelInventoryEvents.js';

/** Reuse authenticated runtime sockets; notifications carry no channel or account data. */
export function createChannelsGateway({ directory, settingsDirectory, serversById,
  selectBroker, requestBody, jsonResponse, requireSameOriginMutation, frame, workerFactory }) {
  const observers = new Map(), pending = new Set();
  let timer, closed = false;
  async function deliver(observer) {
    if (observer.reading || !observer.entries.size) return;
    observer.reading = true;
    try {
      for (const entry of observer.entries) {
        try {
          if (entry.blocked) { observer.dirty = true; continue; }
          if (!await entry.canRead() || !observer.entries.has(entry) || !entry.socket.writable) continue;
          entry.blocked = !entry.socket.write(frame(JSON.stringify({
            jsonrpc: '2.0', method: CHANNEL_INVENTORY_CHANGED, params: {},
          })));
          observer.selected = entry; observer.dirty = false;
          return;
        } catch { /* Try another existing socket without creating a transport. */ }
      }
    } finally { observer.reading = false; }
  }
  function schedule(observer) {
    if (closed) return;
    pending.add(observer);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const batch = [...pending]; pending.clear();
      for (const item of batch) void deliver(item);
    }, 50);
  }
  const changed = () => { for (const observer of observers.values()) schedule(observer); };
  const controller = createChannelsController({ directory, settingsDirectory, selectBroker, workerFactory, onChanged: changed });
  const channels = { ...controller, async close() {
    closed = true; clearTimeout(timer);
    for (const observer of observers.values()) for (const entry of [...observer.entries]) entry.stop();
    pending.clear();
    await controller.close();
  } };
  const handleChannels = createChannelsHttpHandler({ controller: channels, requestBody, jsonResponse, requireSameOriginMutation,
    targetLabel: id => serversById.get(id)?.label ?? id,
    resolveTarget: async (target, { session, loginOwner }) => {
      if (!target || typeof target.threadId !== 'string' || !target.threadId || target.threadId.length > 512
        || (target.workspacePath !== undefined && typeof target.workspacePath !== 'string')
        || !session.allowedServerIds.has(target.serverId) || !serversById.has(target.serverId)) {
        throw new Error('CHANNEL_TASK_TARGET_UNAVAILABLE');
      }
      return { serverId: target.serverId, workspacePath: target.workspacePath, threadId: target.threadId,
        ...(serversById.get(target.serverId).security ? { loginOwner } : {}) };
    },
  });
  function attachChannelNotifications(socket, canRead, sessionId, observerId) {
    if (closed || observerId === 'none') return;
    // A page ID is an optimization only. Never group different authenticated sessions.
    const key = typeof sessionId === 'string' && typeof observerId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(observerId)
      ? JSON.stringify([sessionId, observerId]) : socket;
    let observer = observers.get(key);
    if (!observer) {
      observer = { entries: new Set(), reading: false, dirty: false, selected: null };
      observers.set(key, observer);
      schedule(observer);
    }
    const entry = { socket, canRead, blocked: false, stop };
    function drain() {
      entry.blocked = false;
      if (observer.dirty) { observer.dirty = false; schedule(observer); }
    }
    function stop() {
      observer.entries.delete(entry);
      if (!observer.entries.size) { observers.delete(key); pending.delete(observer); }
      else if (observer.selected === entry) schedule(observer);
      socket.off('close', stop); socket.off('drain', drain);
    }
    observer.entries.add(entry);
    if (observer.dirty) schedule(observer);
    socket.on('close', stop); socket.on('drain', drain);
  }
  return { channels, handleChannels, attachChannelNotifications };
}
