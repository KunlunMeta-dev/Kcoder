import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths, type FileHandle } from "expo-file-system";
import { hashBoundedSource } from "@/protocol/sha256-stream";
import type { AttachmentBytesBackend, DurableByteSource } from "./staged-attachment-bytes";

const MANIFEST = "kcoder-staged-attachments-v1";
const directory = () => new Directory(Paths.document, "kcoder-staged-attachments-v1");
function fileFor(id: string): File {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid staged attachment locator");
  return new File(directory(), `${id}.bytes`);
}
/** Caller holds the shared profile-index gate for every manifest transaction. */
export function createAttachmentBytesBackend(): AttachmentBytesBackend {
  return {
    kind: "native",
    async transaction(change) {
      const raw = await AsyncStorage.getItem(MANIFEST);
      if (raw !== null && raw.length * 2 > 4 * 1024 * 1024) throw new Error("附件本地索引超出容量，保留原记录");
      const rows: unknown = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > 128) throw new Error("附件本地索引无法确认，请保留原记录");
      const result = change(rows);
      if (result.putBytes || result.deleteBytes) throw new Error("Native byte changes require their durable manifest intent");
      const next = [...rows];
      const rowId = (row: unknown): string => {
        if (!row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string") throw new Error("损坏的附件本地索引");
        return (row as { id: string }).id;
      };
      if (result.deleteRow) {
        const index = next.findIndex(row => rowId(row) === result.deleteRow);
        if (index !== -1) next.splice(index, 1);
      }
      const writes = [...(result.putRows ?? []), ...(result.putRow ? [result.putRow] : [])];
      if (writes.length > 32 || new Set(writes.map(row => row.id)).size !== writes.length) throw new Error("附件消费批事务无效");
      for (const write of writes) {
        if (rowId(write.value) !== write.id) throw new Error("附件消费批身份无效");
        const index = next.findIndex(row => rowId(row) === write.id);
        if (index === -1) next.push(write.value); else next[index] = write.value;
      }
      // A single manifest write is the process-restart checkpoint. Expo provides no fsync API.
      if (writes.length || result.deleteRow) await AsyncStorage.setItem(MANIFEST, JSON.stringify(next));
      return result.value;
    },
    async source(id, expectedSize) {
      const file = fileFor(id);
      if (!file.exists || file.size !== expectedSize) throw new Error("附件原始文件缺失或长度无法确认");
      return {
        size: expectedSize,
        async read(offset, length) {
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 64 * 1024 || offset + length > expectedSize) throw new Error("Invalid staged byte range");
          const handle = file.open();
          try {
            if (handle.size !== expectedSize) throw new Error("附件原始文件长度已变化");
            handle.offset = offset;
            const bytes = handle.readBytes(length);
            if (bytes.length !== length) throw new Error("附件原始文件读取不完整");
            return bytes;
          } finally { handle.close(); }
        },
      };
    },
    async copySource(id, source: DurableByteSource, isCurrent, signal, withOwnership) {
      if (!isCurrent() || signal?.aborted) throw new Error("附件保存已取消");
      const root = directory(); const file = fileFor(id);
      let handle: FileHandle | undefined;
      await withOwnership(() => {
        root.create({ intermediates: true, idempotent: true });
        // No overwrite/adoption: an existing copy takes the hash-checked recovery path.
        file.create({ overwrite: false }); handle = file.open();
      });
      try {
        const digest = await hashBoundedSource({
          size: source.size,
          async read(offset, length) {
            if (!isCurrent() || signal?.aborted) throw new Error("附件保存已取消");
            const bytes = await source.read(offset, length);
            if (!isCurrent() || signal?.aborted) throw new Error("附件保存已取消");
            if (bytes.byteLength !== length) throw new Error("附件原始文件读取不完整");
            await withOwnership(() => { handle!.offset = offset; handle!.writeBytes(bytes); });
            return bytes;
          },
        }, isCurrent, signal);
        if (handle!.size !== source.size) throw new Error("附件持久副本长度不一致");
        return digest;
      } finally { handle?.close(); }
    },
    async removeSource(id) {
      // Only called with an exact durable removal-intent row. No directory scans or cache-URI deletion.
      const file = fileFor(id);
      const root = directory();
      // exists=false may also mean access denied. Require a successful exact-parent
      // listing before accepting absence, including crash-after-delete recovery.
      if (!new Directory(Paths.document).list().some(entry => entry.uri === root.uri)) return;
      const before = root.list();
      if (before.some(entry => entry.uri === file.uri)) file.delete();
      if (root.list().some(entry => entry.uri === file.uri)) throw new Error("附件原始副本尚未删除");
    },
  };
}
