import { RUNTIME_ACTIVITY_CHANGED } from '../shared/runtimeActivityEvents.js';

/** Reject obsolete scopes before ledger I/O and recheck after fresh authentication. */
export function createRuntimeActivityAuthorization({ getSession, session, getTarget, targetSignature, loginContexts, loginOwner }) {
  const isCurrent = scope => {
    const original = getTarget(scope.serverId);
    return !!original && targetSignature(original) === scope.signature && (!original.security ||
      loginOwner === scope.loginOwner && !!loginContexts.identity(loginOwner, scope.serverId) &&
      loginContexts.generation(loginOwner, scope.serverId) === scope.generation);
  };
  return async scope => {
    if (!isCurrent(scope)) return false;
    const current = await getSession();
    return current === session && current.allowedServerIds.has(scope.serverId) && isCurrent(scope);
  };
}

/** Share one content-free invalidation per authenticated page, without opening a watcher per workspace. */
export function createRuntimeActivityNotifications({ frame }) {
  const observers = new Map();
  let closed = false;
  function schedule(observer) {
    if (closed || observer.timer || observer.reading || !observer.pending.length) return;
    observer.timer = setTimeout(() => { observer.timer = null; void deliver(observer); }, 50);
    observer.timer.unref?.();
  }
  async function deliver(observer) {
    if (closed || observer.reading || !observer.entries.size) return;
    observer.reading = true;
    const scopes = observer.pending.splice(0);
    let waitingForDrain = false;
    try {
      for (const entry of observer.entries) {
        if (!entry.socket.writable || entry.blocked) continue;
        for (const scope of scopes) {
          try {
            if (!await entry.canRead(scope) || !observer.entries.has(entry) || !entry.socket.writable) continue;
            entry.blocked = !entry.socket.write(frame(JSON.stringify({
              jsonrpc: '2.0', method: RUNTIME_ACTIVITY_CHANGED, params: {},
            })));
            observer.selected = entry;
            observer.selectedScope = scope;
            return;
          } catch { /* Another socket may still own the current authorization. */ }
        }
      }
      // If all sockets are backpressured, retain one bounded refresh request.
      if ([...observer.entries].some(entry => entry.blocked)) {
        observer.pending.unshift(...scopes.slice(-64));
        observer.pending.splice(64);
        waitingForDrain = true;
      }
    } finally {
      observer.reading = false;
      if (observer.pending.length && !waitingForDrain) schedule(observer);
    }
  }
  function attach(socket, canRead, sessionId, observerId, initialScope) {
    if (closed || observerId === 'none') return;
    const key = typeof sessionId === 'string' && typeof observerId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(observerId)
      ? JSON.stringify([sessionId, observerId]) : socket;
    let observer = observers.get(key);
    const first = !observer;
    if (!observer) {
      observer = { entries: new Set(), pending: [], timer: null, reading: false, selected: null };
      observers.set(key, observer);
    }
    const entry = { socket, canRead, blocked: false };
    observer.entries.add(entry);
    function drain() { entry.blocked = false; schedule(observer); }
    function stop() {
      observer.entries.delete(entry);
      socket.off('close', stop); socket.off('drain', drain);
      if (!observer.entries.size) { clearTimeout(observer.timer); observers.delete(key); }
      else if (observer.selected === entry && observer.selectedScope) {
        observer.selected = null;
        observer.pending.push(observer.selectedScope);
        schedule(observer);
      }
    }
    entry.stop = stop;
    socket.on('close', stop); socket.on('drain', drain);
    if (first && initialScope) { observer.pending.push(initialScope); schedule(observer); }
  }
  function changed(scope) {
    if (closed) return;
    for (const observer of observers.values()) {
      // A full list refresh covers all scopes, but retain distinct scopes until
      // one of them passes the current authorization check.
      if (!observer.pending.some(value => value.serverId === scope.serverId && value.loginOwner === scope.loginOwner &&
          value.signature === scope.signature && value.generation === scope.generation)) {
        if (observer.pending.length >= 64) observer.pending.shift();
        observer.pending.push(scope);
      }
      schedule(observer);
    }
  }
  function close() {
    closed = true;
    for (const observer of observers.values()) {
      clearTimeout(observer.timer);
      for (const entry of [...observer.entries]) entry.stop();
    }
    observers.clear();
  }
  return { attach, changed, close };
}
