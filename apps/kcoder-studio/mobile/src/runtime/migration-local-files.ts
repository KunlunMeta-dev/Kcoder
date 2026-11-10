import { Platform } from "react-native";
import type { MigrationByteSink, MigrationLocalSource } from "./migration-local-transfer";
import { MIGRATION_LOCAL_FILE_LIMIT } from "./migration-local-transfer";

export async function chooseMigrationLocalFile(): Promise<MigrationLocalSource | null> {
  const DocumentPicker = await import("expo-document-picker");
  const selected = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
  const item = selected.assets?.[0]; if (!item || selected.canceled) return null;
  if (Platform.OS === "web") {
    const file = item.file;
    if (!file || file.size > MIGRATION_LOCAL_FILE_LIMIT) throw new Error("local_upload_file_budget_exceeded");
    return { filename: item.name, size: file.size, async read(offset, length) { return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()); }, close() {} };
  }
  const { File: ExpoFile, Paths } = await import("expo-file-system");
  const file = new ExpoFile(item.uri), size = file.size;
  const ownedCache = file.uri.startsWith(Paths.cache.uri.endsWith("/") ? Paths.cache.uri : Paths.cache.uri + "/");
  const cleanup = () => { if (ownedCache && file.exists) file.delete(); };
  if (size > MIGRATION_LOCAL_FILE_LIMIT) { cleanup(); throw new Error("local_upload_file_budget_exceeded"); }
  const handle = file.open();
  return { filename: item.name, size, async read(offset, length) { handle.offset = offset; return handle.readBytesSync(length); }, close() { try { handle.close(); } finally { cleanup(); } } };
}
export async function chooseMigrationDownload(bytes: number, id: string): Promise<MigrationByteSink | null> {
  const filename = `migration-attachment-${id.replace(/[^a-z0-9_-]/gi, "_").slice(0, 96)}.bin`;
  if (Platform.OS === "web") {
    const host = globalThis as typeof globalThis & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }> };
    if (host.showSaveFilePicker) {
      let selected; try { selected = await host.showSaveFilePicker({ suggestedName: filename }); } catch (error) { if (error instanceof Error && error.name === "AbortError") return null; throw error; }
      const writer = await selected.createWritable();
      return { write: chunk => writer.write(chunk), finish: () => writer.close(), abort: () => writer.abort() };
    }
    if (bytes > 8 * 1024 * 1024) throw new Error("history_attachment_streaming_download_required");
    const chunks: Uint8Array<ArrayBuffer>[] = []; let received = 0;
    return { async write(chunk) { received += chunk.length; if (received > bytes) throw new Error("migration_invalid_response"); chunks.push(Uint8Array.from(chunk)); }, async finish() { const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" })); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); chunks.length = 0; }, async abort() { chunks.length = 0; } };
  }
  const { File: ExpoFile, Paths } = await import("expo-file-system");
  const Sharing = await import("expo-sharing");
  const file = new ExpoFile(Paths.cache, filename); file.create({ overwrite: false });
  const handle = file.open(); let closed = false;
  const close = () => { if (!closed) { handle.close(); closed = true; } };
  return { async write(chunk) { handle.writeBytesSync(chunk); }, async finish() { close(); try { if (!await Sharing.isAvailableAsync()) throw new Error("history_attachment_sharing_unavailable"); await Sharing.shareAsync(file.uri); } finally { file.delete(); } }, async abort() { close(); if (file.exists) file.delete(); } };
}
