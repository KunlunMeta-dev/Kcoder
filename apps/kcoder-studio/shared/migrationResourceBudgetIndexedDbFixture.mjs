/** A deterministic event model for adapter error/transaction tests, not browser IndexedDB acceptance. */
export function budgetIndexedDbFixture() {
  const rows = new Map(), modes = [];
  let tail = Promise.resolve(), closes = 0;
  const indexedDB = { open() {
    const request = {};
    queueMicrotask(() => { request.result = {
      objectStoreNames: { contains: () => true }, close() { closes++; },
      transaction(_store, mode) {
        modes.push(mode); let release, active = false, done = false, pending = 0;
        const ready = tail; tail = new Promise(resolve => { release = resolve; });
        const working = new Map(rows), queued = [];
        const finish = () => { if (done || pending) return; done = true; if (mode === 'readwrite') { rows.clear(); for (const [key, value] of working) rows.set(key, structuredClone(value)); } release(); tx.oncomplete?.(); };
        const schedule = callback => { pending++; const run = () => queueMicrotask(() => { if (done) return; callback(); pending--; queueMicrotask(finish); }); if (active) run(); else queued.push(run); };
        const tx = { abort() { if (done) throw Error('already complete'); done = true; release(); queueMicrotask(() => tx.onabort?.()); }, objectStore() { return {
          get(key) { const result = {}; schedule(() => { result.result = structuredClone(working.get(key)); result.onsuccess?.(); }); return result; },
          put(value, key) { if (mode !== 'readwrite') throw Error('readonly'); schedule(() => working.set(key, structuredClone(value))); },
          count() { const result = {}; schedule(() => { result.result = working.size; result.onsuccess?.(); }); return result; },
        }; } };
        void ready.then(() => { working.clear(); for (const [key, value] of rows) working.set(key, structuredClone(value)); active = true; for (const run of queued) run(); });
        return tx;
      },
    }; request.onsuccess?.(); });
    return request;
  } };
  return { indexedDB, rows, modes, closes: () => closes };
}
