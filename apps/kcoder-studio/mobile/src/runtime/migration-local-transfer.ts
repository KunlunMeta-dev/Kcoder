import { fromByteArray, toByteArray } from "base64-js";
import { Sha256Stream, createAttachmentMacrotaskYield, type BoundedByteReader } from "@/protocol/sha256-stream";
import { samePublicValue } from "./migration-client/history-validation";
import type { MobileMigrationClient } from "./migration-client";
import type { HistoricalAttachmentReceipt, HistoricalAttachmentSelection } from "../../../shared/generated/contracts";

export const MIGRATION_LOCAL_FILE_LIMIT = 256 * 1024 * 1024;
export const MIGRATION_LOCAL_PART_LIMIT = 192 * 1024;
export interface MigrationLocalSource extends BoundedByteReader { filename: string; close(): void }
const fail = (code: string): never => { throw new Error(code); };
/** The migration receiver has its own budget; task attachments keep their separate 50 MiB limit. */
export async function hashMigrationSource(source: BoundedByteReader, assertCurrent: () => void, progress: (bytes: number) => void = () => {}) {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MIGRATION_LOCAL_FILE_LIMIT) fail("local_upload_file_budget_exceeded");
  const hash = new Sha256Stream(), yieldTask = createAttachmentMacrotaskYield();
  try {
  for (let offset = 0; offset < source.size;) {
    assertCurrent(); const size = Math.min(64 * 1024, source.size - offset);
    const bytes = await source.read(offset, size); assertCurrent();
    if (bytes.byteLength !== size) fail("local_upload_source_changed");
    for (let at = 0; at < bytes.length; at += 16 * 1024) { hash.update(bytes.subarray(at, at + 16 * 1024)); await yieldTask.yield(); assertCurrent(); }
    offset += bytes.length; progress(offset);
  }
  assertCurrent(); return hash.digestHex();
  } finally { yieldTask.close(); }
}
/** Resend is never automatic: the caller explicitly reselects the same file and reconciles Native credit first. */
export async function sendMigrationLocalFile(client: MobileMigrationClient, operationId: string, source: MigrationLocalSource, assertCurrent: () => void, progress: (phase: "hashing" | "sending", bytes: number) => void = () => {}) {
  const check = () => { assertCurrent(); if (!client.available()) fail("migration_scope_changed"); };
  try {
    check(); const sha256 = await hashMigrationSource(source, check, bytes => progress("hashing", bytes));
    let state = await client.call("localRead", { operationId }); check();
    if (state.workerRunning || state.upload.cancelRequested || state.upload.localJob?.state.cancelRequested) fail("local_upload_explicit_resume_required");
    if (state.upload.stage === "prepared") {
      state = await client.call("localBegin", { operationId, expectedSequence: state.upload.sequence, filename: source.filename, bytes: source.size, sha256 }); check();
    }
    const manifest = state.upload;
    if (manifest.filename !== source.filename || manifest.bytes !== source.size || manifest.sha256 !== sha256) fail("local_upload_source_changed");
    if (!["receiving", "assembling", "authorized"].includes(manifest.stage)) fail("local_upload_explicit_resume_required");
    const partBytes = manifest.partBytes;
    if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > MIGRATION_LOCAL_PART_LIMIT || manifest.receivedBytes !== Math.min(source.size, manifest.receivedParts * partBytes)) fail("migration_invalid_response");
    // Hash the actual second read as well; a changed local handle must never be sealed as the first selection.
    const sentHash = new Sha256Stream(), yieldTask = createAttachmentMacrotaskYield();
    try {
    let index = 0;
    for (let offset = 0; offset < source.size; index++) {
      check(); const size = Math.min(partBytes, source.size - offset), bytes = await source.read(offset, size); check();
      if (bytes.byteLength !== size) fail("local_upload_source_changed");
      for (let at = 0; at < bytes.length; at += 16 * 1024) { sentHash.update(bytes.subarray(at, at + 16 * 1024)); await yieldTask.yield(); check(); }
      if (index >= manifest.receivedParts) {
        if (state.upload.stage !== "receiving") fail("migration_invalid_response");
        state = await client.call("localPart", { operationId, expectedSequence: state.upload.sequence, index, contentBase64: fromByteArray(bytes) }); check();
        if (state.upload.receivedBytes !== offset + size || state.upload.receivedParts !== index + 1 || state.upload.sha256 !== sha256 || state.upload.bytes !== source.size || state.upload.partBytes !== partBytes) fail("migration_invalid_response");
      }
      offset += bytes.length; progress("sending", offset);
    }
    check(); if (sentHash.digestHex() !== sha256) fail("local_upload_source_changed");
    return state;
    } finally { yieldTask.close(); }
  } finally { source.close(); }
}
export interface MigrationByteSink { write(bytes: Uint8Array): Promise<void>; finish(): Promise<void>; abort(): Promise<void> }
/** Both the per-window digest and the final receipt must agree before a download is delivered. */
export async function receiveMigrationAttachment(client: MobileMigrationClient, selection: HistoricalAttachmentSelection, receipt: HistoricalAttachmentReceipt, sink: MigrationByteSink, assertCurrent: () => void, localOperationId?: string) {
  const check = () => { assertCurrent(); if (!client.available()) fail("migration_scope_changed"); };
  const hash = new Sha256Stream();
  try {
    if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || receipt.bytes > MIGRATION_LOCAL_FILE_LIMIT) fail("history_attachment_download_budget_exceeded");
    let offset = 0;
    while (offset < receipt.bytes) {
      check(); const limit = Math.min(MIGRATION_LOCAL_PART_LIMIT, receipt.bytes - offset);
      const result = localOperationId ? await client.call("localChunk", { operationId: localOperationId, selection, expectedReceipt: receipt, offset, limit }) : await client.call(selection.toolItemIndex == null ? "attachmentChunk" : "toolAttachmentChunk", { selection, offset, limit });
      check();
      if (!samePublicValue(result.receipt, receipt)) fail("history_attachment_receipt_changed");
      const bytes = toByteArray(result.dataBase64), end = offset + bytes.length;
      if (!bytes.length || bytes.length > limit || end > receipt.bytes || (end < receipt.bytes ? result.nextOffset !== end : result.nextOffset != null)) fail("migration_invalid_response");
      if (new Sha256Stream().update(bytes).digestHex() !== result.dataSha256) fail("history_attachment_chunk_integrity");
      hash.update(bytes); await sink.write(bytes); check(); offset = end;
    }
    check(); if (hash.digestHex() !== receipt.sha256) fail("history_attachment_integrity");
    await sink.finish(); check();
  } catch (error) { try { await sink.abort(); } catch { /* Cleanup remains scoped to this selected output. */ } throw error; }
}
