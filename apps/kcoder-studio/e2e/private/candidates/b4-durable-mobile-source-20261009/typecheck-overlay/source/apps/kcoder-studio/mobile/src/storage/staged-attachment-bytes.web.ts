import type { AttachmentBytesBackend, AttachmentStoreChange } from "./staged-attachment-bytes";

const DATABASE = "kcoder-staged-attachments-v1";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("此浏览器无法持久保存附件")); return; }
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("rows", { keyPath: "id" });
      db.createObjectStore("bytes");
    };
    request.onerror = () => fail(request.error ?? new Error("附件存储无法打开"));
    request.onblocked = () => fail(new Error("附件存储升级被其他页面阻止"));
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
  });
}
export function createAttachmentBytesBackend(): AttachmentBytesBackend {
  return {
    kind: "web",
    async transaction<T>(change: (rows: readonly unknown[]) => AttachmentStoreChange<T>): Promise<T> {
      const db = await openDatabase();
      return new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try { transaction = db.transaction(["rows", "bytes"], "readwrite"); } catch (error) { db.close(); reject(error); return; }
        const rows = transaction.objectStore("rows"); const bytes = transaction.objectStore("bytes");
        let value: T; let failure: unknown;
        const request = rows.getAll(undefined, 129);
        request.onsuccess = () => {
          try {
            // No await inside this callback: final Blob + row + quota/revision CAS
            // are written under this same readwrite transaction across tabs.
            if (request.result.length > 128) throw new Error("附件本地索引超出容量，保留原记录");
            const update = change(request.result.map((row: { id?: unknown; value?: unknown }) => {
              if (typeof row.id !== "string" || !row.value || typeof row.value !== "object" || (row.value as { id?: unknown }).id !== row.id) throw new Error("附件本地索引损坏");
              return row.value;
            }));
            value = update.value;
            if (update.putRow) rows.put(update.putRow);
            if (update.deleteRow) rows.delete(update.deleteRow);
            if (update.putBytes) bytes.put(update.putBytes.blob, update.putBytes.id);
            if (update.deleteBytes) bytes.delete(update.deleteBytes);
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => { db.close(); resolve(value); };
        transaction.onerror = () => { /* onabort is the single rejection path. */ };
        transaction.onabort = () => { db.close(); reject(failure ?? transaction.error ?? new Error("附件持久化失败")); };
      });
    },
    async source(id, expectedSize) {
      const db = await openDatabase();
      const blob = await new Promise<Blob>((resolve, reject) => {
        let transaction: IDBTransaction;
        try { transaction = db.transaction("bytes", "readonly"); } catch (error) { db.close(); reject(error); return; }
        const request = transaction.objectStore("bytes").get(id);
        let result: unknown;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => { db.close(); result instanceof Blob ? resolve(result) : reject(new Error("附件本地字节缺失；保留原上传 ID")); };
        transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("附件本地字节读取失败")); };
      });
      if (blob.size !== expectedSize) throw new Error("附件本地字节长度不符；不会派发");
      return { size: blob.size, async read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > blob.size) throw new Error("Invalid staged byte range");
        return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      } };
    },
  };
}
