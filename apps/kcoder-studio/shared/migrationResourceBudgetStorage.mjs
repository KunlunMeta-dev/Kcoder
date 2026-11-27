const DATABASE = 'kcoder-migration-resource-budget-v2', STORE = 'selectors';
const MAX_CACHE = 16 * 1024;
const failure = () => new Error('migration_recovery_storage_unavailable');
const validKey = key => typeof key === 'string' && key.startsWith('kcoder.migration.resource-budget.v1:') && key.length <= 512 && !/[\x00-\x1f]/.test(key);

/** IndexedDB readwrite transactions coordinate ordinary HTTP tabs without Web Locks. */
export function createResourceBudgetStorage({ storage, indexedDB, isCurrent }) {
  const memory = new Map(), transactions = new Set();
  let database = null, opening = null, generation = 0;
  const legacy = key => {
    const value = storage.getItem(key);
    if (value !== null && (typeof value !== 'string' || value.length > MAX_CACHE)) throw failure();
    return value;
  };
  const current = () => { if (!isCurrent()) throw new Error('migration_scope_changed'); };
  const open = () => {
    current();
    if (!indexedDB?.open) return Promise.reject(failure());
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const ticket = generation;
    const promise = new Promise((resolve, reject) => {
      let request, abandoned = false;
      try { request = indexedDB.open(DATABASE, 1); } catch { reject(failure()); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onerror = () => reject(failure());
      request.onblocked = () => { abandoned = true; reject(failure()); };
      request.onsuccess = () => {
        const result = request.result;
        if (abandoned || ticket !== generation || !isCurrent()) { result.close(); reject(new Error('migration_scope_changed')); return; }
        database = result; result.onversionchange = () => { result.close(); if (database === result) database = null; };
        resolve(result);
      };
    });
    opening = promise;
    void promise.finally(() => { if (opening === promise) opening = null; }).catch(() => {});
    return promise;
  };
  const decode = (row, key) => {
    const baseline = legacy(key);
    if (row === undefined) return { raw: baseline, legacyRaw: baseline };
    if (!row || row.version !== 1 || Object.keys(row).some(name => !['version', 'raw', 'legacyRaw'].includes(name))
      || typeof row.raw !== 'string' || row.raw.length > MAX_CACHE
      || row.legacyRaw !== null && (typeof row.legacyRaw !== 'string' || row.legacyRaw.length > MAX_CACHE)) throw failure();
    // The legacy bytes are retained. A concurrently running older client cannot be silently ignored.
    memory.set(key, row.raw);
    if (baseline !== row.legacyRaw) throw new Error('migration_recovery_storage_changed');
    return row;
  };
  const transaction = async (key, operation) => {
    if (!validKey(key)) throw failure();
    const db = await open(), ticket = generation;
    return new Promise((resolve, reject) => {
      let tx, result, error, finished = false, initialLegacy, slot;
      try { current(); tx = db.transaction(STORE, operation ? 'readwrite' : 'readonly'); } catch { reject(failure()); return; }
      transactions.add(tx);
      const fail = reason => { error = reason; try { tx.abort(); } catch { if (!finished) { finished = true; transactions.delete(tx); reject(reason); } } };
      tx.onabort = () => { if (finished) return; finished = true; transactions.delete(tx); reject(error ?? failure()); };
      tx.onerror = () => { error ??= failure(); };
      tx.oncomplete = () => {
        if (finished) return; finished = true; transactions.delete(tx);
        try {
          current(); if (ticket !== generation) throw new Error('migration_scope_changed');
          if (legacy(key) !== initialLegacy) throw new Error('migration_recovery_storage_changed');
          memory.set(key, slot.raw); resolve(result);
        } catch (cause) { reject(cause); }
      };
      const store = tx.objectStore(STORE), request = store.get(key);
      request.onsuccess = () => {
        try {
          current(); if (ticket !== generation) throw new Error('migration_scope_changed');
          const row = decode(request.result, key); initialLegacy = row.legacyRaw; slot = { key, raw: row.raw };
          if (!operation) { result = row.raw; return; }
          const local = {
            getItem: name => { if (name !== key) throw failure(); return slot.raw; },
            setItem: (name, value) => { if (name !== key || typeof value !== 'string' || value.length > MAX_CACHE) throw failure(); current(); slot.raw = value; },
          };
          result = operation(local);
          if (result && typeof result.then === 'function') throw failure();
          current();
          if (slot.raw !== row.raw) {
            const put = () => { try { current(); if (ticket !== generation) throw new Error('migration_scope_changed'); if (legacy(key) !== initialLegacy) throw new Error('migration_recovery_storage_changed'); store.put({ version: 1, raw: slot.raw, legacyRaw: initialLegacy }, key); } catch (cause) { fail(cause); } };
            if (request.result === undefined) {
              const count = store.count(); count.onsuccess = () => { if (count.result >= 4096) fail(failure()); else put(); };
            } else put();
          }
        } catch (cause) { fail(cause); }
      };
    });
  };
  return {
    getItem: key => { if (!validKey(key)) throw failure(); return memory.has(key) ? memory.get(key) : legacy(key); },
    // Readonly refresh does not create a selector row or rewrite the legacy cache.
    refresh: key => transaction(key),
    withTransaction: (key, operation) => transaction(key, operation),
    close() {
      generation++; opening = null;
      for (const tx of transactions) { try { tx.abort(); } catch { /* A completed owned transaction needs no cancellation. */ } }
      transactions.clear(); database?.close(); database = null;
    },
  };
}
