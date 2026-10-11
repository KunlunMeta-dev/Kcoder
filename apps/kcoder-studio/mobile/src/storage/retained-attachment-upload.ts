import { GatewayRpcClient } from "@/gateway/rpc";
import { parseRetentionUploadResult, validateRetentionUploadParams, RETENTION_CHUNK_BYTES, type RetentionUploadExpectation, type RetentionUploadMethod, type RetentionUploadParamsV1, type RetentionUploadResultV1, type RetentionStageRefV1 } from "@/protocol/attachment-retention";
import { hashBoundedSource, createAttachmentMacrotaskYield, type BoundedByteReader } from "@/protocol/sha256-stream";
import { StagedAttachmentStore, type AttachmentStoreContext, type StagedAttachmentRecord, type RetainedAttachmentComposer } from "./staged-attachment-store";
import type { DurableByteSource } from "./staged-attachment-bytes";

export interface RetainedAttachmentHandle { kind: "retained"; localAttachmentId: string; filename: string; size: number; stageRef: RetentionStageRefV1 }
export class RetainedUploadUnknown extends Error {
  constructor() { super("附件上传状态尚未确认，原文件和上传 ID 已保留。请核对原连接后继续。"); this.name = "RetainedUploadUnknown"; }
}
function expectation(row: StagedAttachmentRecord): RetentionUploadExpectation {
  if (!row.contentSha256) throw new RetainedUploadUnknown();
  return { ownerRequest: row.ownerRequest, clientUploadId: row.clientUploadId, admission: row.admission, filename: row.filename, size: row.size, contentSha256: row.contentSha256, scopeId: row.scopeId, stageRef: row.stageRef };
}
function selector(row: StagedAttachmentRecord): RetentionUploadParamsV1 { return { ownerRequest: row.ownerRequest, clientUploadId: row.clientUploadId }; }
async function base64(bytes: Uint8Array, current: () => void): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = []; const scheduler = createAttachmentMacrotaskYield();
  const clock = () => typeof performance === "object" ? performance.now() : Date.now();
  let started = clock(); let blocks = 0;
  try {
    for (let start = 0; start < bytes.length; start += 3 * 4096) {
      current(); let chunk = "";
      for (let i = start; i < Math.min(start + 3 * 4096, bytes.length); i += 3) {
        const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
        chunk += alphabet[a >>> 2]! + alphabet[(a & 3) << 4 | (b ?? 0) >>> 4]! + (b === undefined ? "=" : alphabet[(b & 15) << 2 | (c ?? 0) >>> 6]!) + (c === undefined ? "=" : alphabet[c & 63]!);
      }
      chunks.push(chunk);
      if (++blocks >= 16 || clock() - started >= 8) { await scheduler.yield(); current(); blocks = 0; started = clock(); }
    }
    current(); return chunks.join("");
  } finally { scheduler.close(); }
}
async function readRange(source: BoundedByteReader, offset: number, length: number, current: () => void): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 64 * 1024) {
    current(); const size = Math.min(64 * 1024, length - at); const part = await source.read(offset + at, size); current();
    if (part.length !== size) throw new RetainedUploadUnknown(); bytes.set(part, at);
  }
  return bytes;
}
/** One caller-owned initialized connection. No automatic reconnect, retry queue or legacy fallback. */
export class RetainedAttachmentUploader {
  constructor(private readonly context: AttachmentStoreContext, private readonly client: GatewayRpcClient, private readonly store = new StagedAttachmentStore(), private readonly signal?: AbortSignal) {}
  private current(): void {
    if (this.signal?.aborted || !this.context.isCurrent() || !this.client.matchesRetainedAttachmentOwner(this.context.profile, this.context.server, this.context.workspacePath) || !this.client.getAttachmentUploadAdmission()) throw new RetainedUploadUnknown();
  }
  async prepare(filename: string, source: DurableByteSource, composer?: RetainedAttachmentComposer): Promise<StagedAttachmentRecord> {
    this.current(); const admission = this.client.getAttachmentUploadAdmission()!;
    // This durable local checkpoint is complete before the first retained RPC.
    return this.store.prepare(this.context, admission, filename, source, this.signal, composer);
  }
  async listUnresolved(): Promise<StagedAttachmentRecord[]> {
    this.current(); return this.store.listUnresolved(this.context);
  }
  /** Select exact sealed local rows; no upload/read RPC or path inference. */
  async sealedRows(localAttachmentIds: readonly string[]): Promise<StagedAttachmentRecord[]> {
    this.current();
    const rows = await Promise.all(localAttachmentIds.map(id => this.store.load(this.context, id)));
    this.current();
    if (rows.some(row => !row || row.phase !== "sealed" || row.wire || !row.stageRef || !row.scopeId)) throw new RetainedUploadUnknown();
    return rows.map(row => row!);
  }
  /** Only a complete, hash-matching copy can become prepared; partial/missing stays recoverable by ID. */
  async recoverCopy(localAttachmentId: string): Promise<StagedAttachmentRecord> {
    this.current();
    return this.store.recoverCopy({ ...this.context, isCurrent: () => { this.current(); return true; } }, localAttachmentId, this.signal);
  }
  private async wire(row: StagedAttachmentRecord, method: RetentionUploadMethod, params: RetentionUploadParamsV1): Promise<{ row: StagedAttachmentRecord; result: RetentionUploadResultV1 }> {
    this.current(); const expected = expectation(row); validateRetentionUploadParams(method, params, expected);
    // Before-first-send local client/root admission must match the captured IDs.
    const admission = this.client.getAttachmentUploadAdmission()!;
    if (admission.rootNamespace !== row.admission.rootNamespace || ((method.endsWith("/start") || method.endsWith("/save")) && admission.admissionEpoch !== row.admission.admissionEpoch)) throw new RetainedUploadUnknown();
    const held = await this.store.dispatch(this.context, row, method, params, () => {
      this.current(); return this.client.request<unknown>(method, { ...params }, 30_000);
    });
    // A rejected/invalid/late response leaves the original durable wire intent.
    const raw = await held.response; this.current();
    const result = parseRetentionUploadResult(raw, expected);
    return { row: held.row, result };
  }
  private async apply(row: StagedAttachmentRecord, result: RetentionUploadResultV1): Promise<StagedAttachmentRecord> {
    this.current(); const lookup = result.lookup;
    if (lookup.outcome === "absent") {
      // Absence cannot turn a sent Unknown under an unconfirmed scope into a new allocation.
      if (!row.scopeId) throw new RetainedUploadUnknown();
      return this.store.update(this.context, row, old => ({ ...old, scopeId: result.scopeId }));
    }
    if (lookup.outcome === "epochRetired") {
      await this.store.update(this.context, row, old => ({ ...old, scopeId: result.scopeId, phase: "epochRetired" }));
      throw new RetainedUploadUnknown(); // No new ID or implicit local source deletion.
    }
    const recovery = lookup.recovery;
    if (recovery.state === "unknown") throw new RetainedUploadUnknown();
    if (recovery.confirmedBytes < row.confirmedBytes) throw new RetainedUploadUnknown();
    return this.store.update(this.context, row, old => ({ ...old, scopeId: result.scopeId, confirmedBytes: recovery.confirmedBytes,
      phase: recovery.state === "sealed" ? "sealed" : recovery.state === "cancelled" ? "cancelled" : "uploading", ...(recovery.stageRef ? { stageRef: recovery.stageRef } : {}) }));
  }
  private handle(row: StagedAttachmentRecord): RetainedAttachmentHandle {
    if (row.phase !== "sealed" || !row.stageRef || row.wire) throw new RetainedUploadUnknown();
    return { kind: "retained", localAttachmentId: row.id, filename: row.filename, size: row.size, stageRef: { ...row.stageRef } };
  }
  async resume(localAttachmentId: string): Promise<RetainedAttachmentHandle> {
    this.current(); let row = await this.store.load(this.context, localAttachmentId);
    if (!row || row.phase === "copying" || ["cancelled", "epochRetired", "sourceRemovalPending", "sourceRemoved"].includes(row.phase)) throw new RetainedUploadUnknown();
    // Validate the entire exact local source before any read/mutation RPC. Native source changes
    // and lost cache URIs cannot silently upload different bytes using the original ID.
    const source = await this.store.source(this.context, row);
    const digest = await hashBoundedSource(source, () => { try { this.current(); return true; } catch { return false; } }, this.signal);
    if (digest !== row.contentSha256) throw new RetainedUploadUnknown();
    if (row.wire || row.phase === "uploading" || row.phase === "sealed") {
      const read = await this.wire(row, "attachment/retention/upload/read", selector(row));
      row = await this.apply(read.row, read.result);
      if (read.result.lookup.outcome === "absent") throw new RetainedUploadUnknown();
      if (row.phase === "sealed") return this.handle(row);
      if (row.phase === "cancelled") throw new RetainedUploadUnknown();
    } else {
      const params: RetentionUploadParamsV1 = { ...selector(row), filename: row.filename, size: row.size, contentSha256: row.contentSha256 };
      // Small save still uses the same durable IDs and typed retained service.
      const method: RetentionUploadMethod = row.size <= 256 * 1024 ? "attachment/retention/upload/save" : "attachment/retention/upload/start";
      if (method.endsWith("/save")) params.contentBase64 = await base64(await readRange(source, 0, row.size, () => this.current()), () => this.current());
      const started = await this.wire(row, method, params); row = await this.apply(started.row, started.result);
      if (row.phase === "sealed") return this.handle(row);
      if (started.result.lookup.outcome !== "present" || row.phase !== "uploading") throw new RetainedUploadUnknown();
    }
    while (row.confirmedBytes < row.size) {
      this.current(); const offset = row.confirmedBytes; const length = Math.min(RETENTION_CHUNK_BYTES, row.size - offset);
      const bytes = await readRange(source, offset, length, () => this.current());
      const chunkSha256 = await hashBoundedSource({ size: bytes.length, async read(start, count) { return bytes.subarray(start, start + count); } }, () => { this.current(); return true; }, this.signal);
      const contentBase64 = await base64(bytes, () => this.current());
      const uploaded = await this.wire(row, "attachment/retention/upload/chunk", { ...selector(row), offset, length, chunkSha256, contentBase64 });
      const next = await this.apply(uploaded.row, uploaded.result);
      if (next.confirmedBytes !== offset + length || next.phase !== "uploading") throw new RetainedUploadUnknown(); row = next;
    }
    const finished = await this.wire(row, "attachment/retention/upload/finish", selector(row));
    row = await this.apply(finished.row, finished.result); return this.handle(row);
  }
  async cancel(localAttachmentId: string): Promise<void> {
    this.current(); const row = await this.store.load(this.context, localAttachmentId);
    if (!row || row.consumers.length !== 0) throw new RetainedUploadUnknown();
    if (!row.wire && !row.scopeId && row.confirmedBytes === 0 && ["copying", "prepared"].includes(row.phase)) {
      await this.store.discardSource(this.context, row); return;
    }
    if (row.phase === "cancelled" && !row.wire && row.cleanup === "requested") {
      await this.store.discardSource(this.context, row); return;
    }
    if (row.phase === "copying") throw new RetainedUploadUnknown();
    const source = await this.store.source(this.context, row);
    if (await hashBoundedSource(source, () => { this.current(); return true; }, this.signal) !== row.contentSha256) throw new RetainedUploadUnknown();
    // Explicit cancellation only. Transport errors never call cancel or discard local bytes.
    const cancelled = await this.wire(row, "attachment/retention/upload/cancel", selector(row));
    const next = await this.apply(cancelled.row, cancelled.result);
    if (next.phase !== "cancelled") throw new RetainedUploadUnknown();
    await this.store.discardSource(this.context, next);
  }
}
