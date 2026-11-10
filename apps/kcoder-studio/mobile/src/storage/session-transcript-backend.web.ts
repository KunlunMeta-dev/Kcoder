import { bindMetadataTransaction, type MetadataAuthority } from "./metadata-authority";
import { TranscriptCacheCorruptionError, type SessionTranscriptBackend, type TranscriptCacheChange } from "./session-transcript-backend-contract";
import { TRANSCRIPT_CACHE_LIMITS } from "./session-transcript-projection";

const DATABASE = "kcoder-confirmed-transcripts-v1";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Transcript cache unavailable")); return; }
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error("Transcript cache open failed")); } };
    const timer = setTimeout(fail, 3000);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); } catch { clearTimeout(timer); fail(); return; }
    request.onupgradeneeded = () => { request.result.createObjectStore("manifest"); request.result.createObjectStore("entries"); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); fail(); };
    request.onsuccess = () => { clearTimeout(timer); if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
  });
}
async function read(store: string, key: IDBValidKey): Promise<unknown> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(store, "readonly");
      let result: unknown;
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(new Error("Transcript cache read failed"));
      transaction.onerror = () => {};
    });
  } finally { db.close(); }
}
async function reset(manifest: string, isCurrent: () => boolean, authority?: MetadataAuthority): Promise<void> {
  const db = await open();
  try {
    authority?.assert();
    await new Promise<void>((resolve, reject) => {
      if (!isCurrent()) { reject(new Error("Transcript owner changed")); return; }
      const transaction = db.transaction(["manifest", "entries"], "readwrite");
      const unbind = bindMetadataTransaction(authority, transaction);
      transaction.oncomplete = () => { unbind(); resolve(); };
      transaction.onabort = () => { unbind(); reject(new Error("Transcript cache reset failed")); };
      transaction.onerror = () => {};
      transaction.objectStore("entries").clear();
      transaction.objectStore("manifest").put(manifest, "current");
    });
  } finally { db.close(); }
}
export function createSessionTranscriptBackend(): SessionTranscriptBackend {
  return {
    reset,
    async readManifest() {
      const raw = await read("manifest", "current");
      if (raw === undefined) return null;
      if (typeof raw !== "string" || raw.length > TRANSCRIPT_CACHE_LIMITS.manifestBytes) throw new TranscriptCacheCorruptionError("Invalid transcript manifest");
      return raw;
    },
    async readEntry(slot, revision) {
      const entry = await read("entries", slot) as { revision?: number; blob?: Blob } | undefined;
      if (!entry) return null;
      if (entry.revision !== revision || !(entry.blob instanceof Blob) || entry.blob.size > TRANSCRIPT_CACHE_LIMITS.entryBytes) throw new TranscriptCacheCorruptionError("Invalid transcript entry");
      return entry.blob.text();
    },
    async commit(change: TranscriptCacheChange, isCurrent, authority) {
      const db = await open();
      try { authority?.assert(); await new Promise<void>((resolve, reject) => {
        if (!isCurrent()) { reject(new Error("Transcript owner changed")); return; }
        const transaction = db.transaction(["manifest", "entries"], "readwrite");
        const unbind = bindMetadataTransaction(authority, transaction);
        const entries = transaction.objectStore("entries");
        // Publication may already have happened. Store compensates a late cancellation.
        transaction.oncomplete = () => { unbind(); resolve(); };
        transaction.onabort = () => { unbind(); reject(new Error("Transcript cache commit failed")); };
        transaction.onerror = () => {};
        const guard = (request: IDBRequest) => {
          request.onsuccess = () => { if (!isCurrent()) { try { transaction.abort(); } catch { /* oncomplete compensates if already committed. */ } } };
        };
        try {
          if (change.put) guard(entries.put({ revision: change.put.revision, blob: new Blob([change.put.raw], { type: "application/json" }) }, change.put.slot));
          for (const slot of change.removeSlots) guard(entries.delete(slot));
          guard(transaction.objectStore("manifest").put(change.manifest, "current"));
        } catch { transaction.abort(); }
      }); } finally { db.close(); }
    },
  };
}
