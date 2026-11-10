const PREFIX = 'kcoder-mobile-metadata-gate-v1:', STORE = 'authority';
const leaseStates = new WeakMap();
const unavailable = () => new Error('mobile_metadata_coordination_unavailable');
const revoked = () => new Error('mobile_metadata_authority_revoked');
const keyValid = key => typeof key === 'string' && key.length > 0 && key.length <= 4096 && !/[\x00-\x1f]/.test(key);

/** UA-held short metadata authority. Network responses must remain outside the callback. */
export function createIndexedMetadataGate({ indexedDB, webLocks } = {}) {
  const identity = {};
  const assert = lease => {
    let current = lease;
    for (let depth = 0; current && depth < 32; depth++) {
      const state = leaseStates.get(current);
      if (!state || state.identity !== identity || !state.active || state.cancelled) throw revoked();
      current = state.parent;
    }
    if (current) throw revoked();
  };
  const parentFor = (key, parent) => {
    assert(parent);
    let current = parent;
    while (current) {
      const state = leaseStates.get(current);
      if (state.key === key) return current;
      current = state.parent;
    }
    return null;
  };
  const open = name => new Promise((resolve, reject) => {
    if (!indexedDB?.open) { reject(unavailable()); return; }
    let request, settled = false;
    const fail = () => { settled = true; reject(unavailable()); };
    try { request = indexedDB.open(PREFIX + encodeURIComponent(name), 1); } catch { fail(); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onerror = request.onblocked = fail;
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
  });
  const idb = async (key, callback, parent, signal) => {
    if (signal?.aborted) throw revoked();
    const database = await open(key);
    try { return await new Promise((resolve, reject) => {
      let transaction, lease, state, done = false, output, error, completed = false;
      const effects = [], revocations = new Set();
      const revokeDependents = () => { for (const callback of [...revocations]) { try { callback(); } catch { /* Every dependent must still receive revocation. */ } } revocations.clear(); };
      const finish = (success, cause) => {
        if (completed) return; completed = true;
        if (state) state.active = false;
        revokeDependents();
        signal?.removeEventListener('abort', cancelled);
        for (const effect of effects.splice(0)) effect.reject(revoked());
        if (success && done && !error) resolve(output); else reject(error ?? cause ?? unavailable());
      };
      const cancelled = () => {
        if (!state) { try { transaction.abort(); } catch { /* No callback has been granted yet. */ } }
        else { state.cancelled = true; revokeDependents(); }
      };
      try { transaction = database.transaction(STORE, 'readwrite'); } catch { reject(unavailable()); return; }
      transaction.oncomplete = () => finish(true);
      transaction.onabort = () => finish(false, revoked());
      transaction.onerror = () => { error ??= unavailable(); };
      const store = transaction.objectStore(STORE);
      const pump = () => {
        if (completed) return;
        // This function runs only inside this transaction's own request event task.
        // Promise continuations or another database's events cannot authorize effects.
        for (const effect of effects.splice(0)) {
          try {
            lease.assert();
            const value = effect.operation();
            if (value && typeof value.then === 'function') throw unavailable();
            effect.resolve(value);
          } catch (cause) { effect.reject(cause); }
        }
        if (done) return;
        let request;
        try { request = store.get('owner'); } catch { finish(false, revoked()); return; }
        request.onsuccess = pump;
      };
      const first = store.get('owner');
      signal?.addEventListener('abort', cancelled, { once: true });
      first.onsuccess = () => {
        if (completed || signal?.aborted) { try { transaction.abort(); } catch { finish(false, revoked()); } return; }
        state = { identity, key, parent, active: true, cancelled: false };
        lease = Object.freeze({ key,
          // A logical checkpoint only. Effects always enter the UA request queue below.
          assert() { assert(lease); },
          onRevoke(callback) { lease.assert(); revocations.add(callback); return () => revocations.delete(callback); },
          effect(operation) {
            try { lease.assert(); } catch (cause) { return Promise.reject(cause); }
            return new Promise((resolve, reject) => effects.push({ operation, resolve, reject }));
          },
        });
        leaseStates.set(lease, state);
        let result;
        try { result = callback(lease); } catch (cause) { error = cause; done = true; }
        if (!done) Promise.resolve(result).then(value => { output = value; done = true; }, cause => { error = cause; done = true; });
        pump();
      };
    }); } finally { database.close(); }
  };
  const run = (key, callback, { parent, signal } = {}) => {
    if (!keyValid(key)) return Promise.reject(unavailable());
    try {
      if (parent) { const existing = parentFor(key, parent); if (existing) return Promise.resolve().then(() => callback(existing)); }
    } catch (error) { return Promise.reject(error); }
    // Old clients still using Web Locks share this compatibility boundary when it exists.
    const execute = () => idb(key, callback, parent, signal);
    if (typeof webLocks?.request === 'function') return webLocks.request(`kcoder-mobile:${key}`, { mode: 'exclusive', ...(signal ? { signal } : {}) }, execute);
    return execute();
  };
  return { run };
}
