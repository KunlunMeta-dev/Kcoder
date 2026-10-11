import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { parseRetentionAdmission, parseRetentionStageRef, retentionGenerationId, verifyRetentionGenerationId, isRetentionSha256, RETENTION_LOCAL_FILE_BYTES, type RetentionUploadAdmissionV1, type RetentionOwnerRequestV1, type RetentionStageRefV1, type RetentionUploadMethod, type RetentionUploadParamsV1 } from "@/protocol/attachment-retention";
import { hashBoundedSource } from "@/protocol/sha256-stream";
import { createAttachmentBytesBackend, type AttachmentBytesBackend, type AttachmentStoreChange, type DurableByteSource } from "./staged-attachment-bytes";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite, type WorkspaceProfileIdentity } from "./workspace-profile-fence";

export const STAGED_ATTACHMENT_LIMIT = 128;
export const STAGED_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
const ROW_BYTES = 32 * 1024;
const TOTAL_METADATA_BYTES = 4 * 1024 * 1024;
export interface AttachmentStoreContext { profile: GatewayProfile; server: KCoderServer; workspacePath?: string; isCurrent(): boolean }
export interface StagedAttachmentScope { profile: WorkspaceProfileIdentity; target: string }
export interface StagedAttachmentRecord {
  version: 1; id: string; revision: number; scope: StagedAttachmentScope;
  admission: RetentionUploadAdmissionV1; ownerRequest: RetentionOwnerRequestV1; clientUploadId: string;
  filename: string; size: number; contentSha256?: string;
  phase: "copying" | "prepared" | "uploading" | "sealed" | "cancelled" | "epochRetired" | "sourceRemovalPending" | "sourceRemoved";
  confirmedBytes: number; scopeId?: string; stageRef?: RetentionStageRefV1;
  wire?: { method: RetentionUploadMethod; params: Omit<RetentionUploadParamsV1, "contentBase64">; revision: number };
  consumers: { clientMessageId: string; reserveId: string; confirmed: boolean }[];
  // Prepaid fixed journal slot: cleanup never needs a new record to make progress.
  cleanup: "none" | "requested" | "finished";
}
export class AttachmentStoreConflict extends Error {
  constructor() { super("附件状态尚未核对，请继续原上传，不要重新选择 ID"); this.name = "AttachmentStoreConflict"; }
}
/** Native copy failed after durable reservation. Reload can discover this same ID. */
export class AttachmentPreparationUnknown extends AttachmentStoreConflict {
  constructor(readonly localAttachmentId: string) {
    super(); this.name = "AttachmentPreparationUnknown";
  }
}
function nonce(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error("无法安全建立附件持久身份");
  return [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, "0")).join("");
}
function targetKey(server: KCoderServer): string {
  return JSON.stringify([server.id, server.runtime, server.transport, [server.workspacePath === undefined ? "absent" : "value", server.workspacePath ?? ""], server.host, server.user, server.port, server.command, server.profile, server.settingsFile, server.accountIdentity?.principalId, server.accountIdentity?.username, server.accountIdentity?.role, server.chromiumBin, server.chromiumNoSandbox, server.acceptNewHostKey]);
}
function scopeOf(context: AttachmentStoreContext): StagedAttachmentScope {
  return { profile: captureWorkspaceProfileIdentity(context.profile), target: JSON.stringify([targetKey(context.server), [context.workspacePath === undefined ? "absent" : "value", context.workspacePath ?? ""], "runtime"]) };
}
function sameScope(a: StagedAttachmentScope, b: StagedAttachmentScope): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function checkContext(context: AttachmentStoreContext, scope: StagedAttachmentScope): void {
  if (!context.isCurrent() || !sameScope(scopeOf(context), scope)) throw new AttachmentStoreConflict();
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function record(value: unknown): StagedAttachmentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttachmentStoreConflict();
  const row = value as StagedAttachmentRecord;
  if (row.version !== 1 || !/^[0-9a-f]{32}$/.test(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !row.scope || typeof row.scope.target !== "string" || !row.scope.profile || typeof row.scope.profile.id !== "string" || typeof row.scope.profile.baseUrl !== "string" || typeof row.scope.profile.authorizationGeneration !== "string" || (row.scope.profile.deviceId !== undefined && typeof row.scope.profile.deviceId !== "string")) throw new AttachmentStoreConflict();
  // Persistence contains only the explicit non-secret owner tuple, never a GatewayProfile.
  if (Object.keys(row.scope.profile).some(key => !["id", "baseUrl", "authorizationGeneration", "deviceId"].includes(key))) throw new AttachmentStoreConflict();
  parseRetentionAdmission(row.admission);
  verifyRetentionGenerationId(row.ownerRequest?.clientOwnerRequestId, "o1", row.admission);
  verifyRetentionGenerationId(row.clientUploadId, "u1", row.admission);
  if (JSON.stringify(row.ownerRequest.immutableParameters) !== JSON.stringify({ purpose: "mobile-attachment", localAttachmentId: row.id })) throw new AttachmentStoreConflict();
  if (typeof row.filename !== "string" || row.filename.length < 1 || row.filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(row.filename) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > RETENTION_LOCAL_FILE_BYTES || !Number.isSafeInteger(row.confirmedBytes) || row.confirmedBytes < 0 || row.confirmedBytes > row.size) throw new AttachmentStoreConflict();
  if (!["copying", "prepared", "uploading", "sealed", "cancelled", "epochRetired", "sourceRemovalPending", "sourceRemoved"].includes(row.phase) || !["none", "requested", "finished"].includes(row.cleanup)) throw new AttachmentStoreConflict();
  if ((row.phase !== "copying" || row.contentSha256 !== undefined) && !isRetentionSha256(row.contentSha256)) throw new AttachmentStoreConflict();
  if (row.scopeId !== undefined && !isRetentionSha256(row.scopeId)) throw new AttachmentStoreConflict();
  if (row.stageRef) parseRetentionStageRef(row.stageRef);
  if (["sealed", "sourceRemovalPending", "sourceRemoved"].includes(row.phase) && (!row.stageRef || row.confirmedBytes !== row.size || !row.scopeId)) throw new AttachmentStoreConflict();
  if (row.stageRef && (row.stageRef.rootNamespace !== row.admission.rootNamespace || row.stageRef.epoch !== row.admission.admissionEpoch)) throw new AttachmentStoreConflict();
  if (!Array.isArray(row.consumers) || row.consumers.length > 32 || new Set(row.consumers.map(x => x.clientMessageId)).size !== row.consumers.length || row.consumers.some(x => typeof x.clientMessageId !== "string" || !x.clientMessageId || x.clientMessageId.length > 256 || typeof x.reserveId !== "string" || typeof x.confirmed !== "boolean")) throw new AttachmentStoreConflict();
  if (row.wire && (!/^attachment\/retention\/upload\/(save|start|read|chunk|finish|cancel)$/.test(row.wire.method) || row.wire.revision !== row.revision || JSON.stringify(row.wire.params.ownerRequest) !== JSON.stringify(row.ownerRequest) || row.wire.params.clientUploadId !== row.clientUploadId)) throw new AttachmentStoreConflict();
  if (JSON.stringify(row).length * 2 > ROW_BYTES) throw new AttachmentStoreConflict();
  return clone(row);
}
function records(values: readonly unknown[]): StagedAttachmentRecord[] {
  if (values.length > STAGED_ATTACHMENT_LIMIT) throw new AttachmentStoreConflict();
  const rows = values.map(record);
  if (new Set(rows.map(x => x.id)).size !== rows.length || rows.reduce((sum, x) => sum + (x.cleanup === "finished" ? 0 : x.size), 0) > STAGED_ATTACHMENT_TOTAL_BYTES || rows.reduce((sum, x) => sum + JSON.stringify(x).length * 2, 0) > TOTAL_METADATA_BYTES) throw new AttachmentStoreConflict();
  return rows;
}
function immutable(row: StagedAttachmentRecord): string {
  return JSON.stringify([row.id, row.scope, row.admission, row.ownerRequest, row.clientUploadId, row.filename, row.size, row.contentSha256]);
}
export class StagedAttachmentStore {
  constructor(private readonly backend: AttachmentBytesBackend = createAttachmentBytesBackend()) {}
  private async transaction<T>(context: AttachmentStoreContext, operation: (rows: StagedAttachmentRecord[]) => AttachmentStoreChange<T>): Promise<T> {
    const scope = scopeOf(context); checkContext(context, scope);
    return withWorkspaceProfileWrite(scope.profile, async () => this.backend.transaction(values => {
      checkContext(context, scope); return operation(records(values));
    }));
  }
  async load(context: AttachmentStoreContext, id: string): Promise<StagedAttachmentRecord | undefined> {
    return this.transaction(context, rows => { const row = rows.find(x => x.id === id); if (row && !sameScope(row.scope, scopeOf(context))) throw new AttachmentStoreConflict(); return { value: row }; });
  }
  /** Bounded local recovery index, filtered by the complete captured non-secret scope. */
  async listUnresolved(context: AttachmentStoreContext): Promise<StagedAttachmentRecord[]> {
    const scope = scopeOf(context);
    return this.transaction(context, rows => ({ value: rows.filter(row => sameScope(row.scope, scope) && row.cleanup !== "finished") }));
  }
  async prepare(context: AttachmentStoreContext, admission: RetentionUploadAdmissionV1, filename: string, source: DurableByteSource, signal?: AbortSignal): Promise<StagedAttachmentRecord> {
    const scope = scopeOf(context); checkContext(context, scope); parseRetentionAdmission(admission);
    const id = nonce();
    let row: StagedAttachmentRecord = { version: 1, id, revision: 1, scope, admission: clone(admission), ownerRequest: { clientOwnerRequestId: retentionGenerationId("o1", admission, nonce()), immutableParameters: { purpose: "mobile-attachment", localAttachmentId: id } }, clientUploadId: retentionGenerationId("u1", admission, nonce()), filename, size: source.size, phase: "copying", confirmedBytes: 0, consumers: [], cleanup: "none" };
    record(row);
    const current = () => !signal?.aborted && context.isCurrent() && sameScope(scopeOf(context), scope);
    const reserve = async (prepared: StagedAttachmentRecord, blob?: Blob) => this.transaction(context, rows => {
      if (!current() || rows.length >= STAGED_ATTACHMENT_LIMIT || rows.some(x => x.id === id) || rows.reduce((n,x) => n + (x.cleanup === "finished" ? 0 : x.size), 0) + row.size > STAGED_ATTACHMENT_TOTAL_BYTES || rows.reduce((n,x) => n + JSON.stringify(x).length * 2, 0) + ROW_BYTES > TOTAL_METADATA_BYTES) throw new AttachmentStoreConflict();
      return { value: prepared, putRow: { id, value: prepared }, ...(blob ? { putBytes: { id, blob } } : {}) };
    });
    if (this.backend.kind === "web") {
      if (!source.blob || source.blob.size !== source.size) throw new Error("浏览器附件必须具有原始 Blob");
      const blob = source.blob;
      const hash = await hashBoundedSource({ size: blob.size, async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } }, current, signal);
      row = { ...row, contentSha256: hash, phase: "prepared" }; record(row);
      return reserve(row, source.blob);
    }
    // Capture the intended bytes before the copy-intent checkpoint. A same-size
    // foreign/partial copy on restart must not become a new accepted source.
    const expectedHash = await hashBoundedSource(source, current, signal);
    row = { ...row, contentSha256: expectedHash };
    await reserve(row); // Quota + exact file locator + hash precede native file creation.
    try {
      const hash = await this.backend.copySource!(id, source, current, signal, async write => {
        // A copy and explicit discard cannot race file creation or writes after
        // the reservation is released. Only bounded local IO occurs in this gate.
        await this.transaction(context, rows => {
          const captured = rows.find(x => x.id === row.id);
          if (!current() || !captured || captured.revision !== row.revision || captured.phase !== "copying" || immutable(captured) !== immutable(row)) throw new AttachmentStoreConflict();
          write(); return { value: undefined };
        });
      });
      if (hash !== expectedHash) throw new AttachmentStoreConflict();
      return await this.update(context, row, old => ({ ...old, phase: "prepared" }));
    } catch {
      // Do not mint a replacement ID or discard bytes after an uncertain copy.
      throw new AttachmentPreparationUnknown(id);
    }
  }
  async recoverCopy(context: AttachmentStoreContext, id: string, signal?: AbortSignal): Promise<StagedAttachmentRecord> {
    const row = await this.load(context, id); if (!row || row.phase !== "copying" || row.wire || row.confirmedBytes !== 0 || !row.contentSha256) throw new AttachmentStoreConflict();
    const current = () => {
      checkContext(context, row.scope);
      return !signal?.aborted;
    };
    current(); const source = await this.backend.source(id, row.size); current();
    const hash = await hashBoundedSource(source, current, signal);
    if (hash !== row.contentSha256) throw new AttachmentStoreConflict();
    return this.update(context, row, old => ({ ...old, phase: "prepared" }));
  }
  async source(context: AttachmentStoreContext, row: StagedAttachmentRecord) {
    const latest = await this.load(context, row.id);
    if (!latest || latest.revision !== row.revision || immutable(latest) !== immutable(row) || !latest.contentSha256) throw new AttachmentStoreConflict();
    return this.backend.source(row.id, row.size);
  }
  async update(context: AttachmentStoreContext, expected: StagedAttachmentRecord, change: (row: StagedAttachmentRecord) => StagedAttachmentRecord): Promise<StagedAttachmentRecord> {
    return this.transaction(context, rows => {
      const current = rows.find(x => x.id === expected.id);
      if (!current || current.revision !== expected.revision || immutable(current) !== immutable(expected) || !sameScope(current.scope, scopeOf(context))) throw new AttachmentStoreConflict();
      const next = change(clone(current));
      if (immutable(next) !== immutable(current)) throw new AttachmentStoreConflict();
      next.revision = current.revision + 1; delete next.wire; record(next);
      return { value: next, putRow: { id: next.id, value: next } };
    });
  }
  /** Persist a wire intent, then synchronously send while the profile gate is held. Await remotely outside it. */
  async dispatch<T>(context: AttachmentStoreContext, expected: StagedAttachmentRecord, method: RetentionUploadMethod, params: RetentionUploadParamsV1, send: () => Promise<T>): Promise<{ row: StagedAttachmentRecord; response: Promise<T> }> {
    const scope = scopeOf(context); checkContext(context, scope);
    return withWorkspaceProfileWrite(scope.profile, async () => {
      const row = await this.backend.transaction(values => {
        const current = records(values).find(x => x.id === expected.id);
        if (!current || !sameScope(current.scope, scope) || current.revision !== expected.revision || immutable(current) !== immutable(expected)) throw new AttachmentStoreConflict();
        const durableParams = clone(params); delete durableParams.contentBase64;
        const next = { ...current, revision: current.revision + 1, wire: { method, params: durableParams, revision: current.revision + 1 } }; record(next);
        checkContext(context, scope); return { value: next, putRow: { id: next.id, value: next } };
      });
      checkContext(context, scope); return { row, response: send() };
    });
  }
  /** A consumer reference and its reserve ID exist durably before any reserve/send RPC. */
  async bindConsumer(context: AttachmentStoreContext, row: StagedAttachmentRecord, clientMessageId: string): Promise<StagedAttachmentRecord> {
    if (row.phase !== "sealed" || row.wire) throw new AttachmentStoreConflict();
    const old = row.consumers.find(x => x.clientMessageId === clientMessageId); if (old) return row;
    return this.update(context, row, current => ({ ...current, consumers: [...current.consumers, { clientMessageId, reserveId: retentionGenerationId("r1", row.admission, nonce()), confirmed: false }] }));
  }
  async confirmConsumer(context: AttachmentStoreContext, row: StagedAttachmentRecord, clientMessageId: string): Promise<StagedAttachmentRecord> {
    if (row.phase !== "sealed" || !row.consumers.some(x => x.clientMessageId === clientMessageId)) throw new AttachmentStoreConflict();
    return this.update(context, row, current => ({ ...current, consumers: current.consumers.map(x => x.clientMessageId === clientMessageId ? { ...x, confirmed: true } : x) }));
  }
  /** Explicit local discard only when no server send occurred, or cancel was authoritatively confirmed. */
  async discardSource(context: AttachmentStoreContext, expected: StagedAttachmentRecord): Promise<StagedAttachmentRecord> {
    const unsent = !expected.wire && !expected.scopeId && expected.confirmedBytes === 0 && ["copying", "prepared"].includes(expected.phase);
    if (!unsent && (expected.phase !== "cancelled" || expected.wire)) throw new AttachmentStoreConflict();
    if (this.backend.kind === "web") return this.transaction(context, rows => {
      const current = rows.find(x => x.id === expected.id);
      if (!current || current.revision !== expected.revision || immutable(current) !== immutable(expected)) throw new AttachmentStoreConflict();
      const next: StagedAttachmentRecord = { ...current, revision: current.revision + 1, phase: "cancelled", cleanup: "finished" }; record(next);
      return { value: next, putRow: { id: next.id, value: next }, deleteBytes: next.id };
    });
    const pending = await this.update(context, expected, row => ({ ...row, phase: "cancelled", cleanup: "requested" }));
    checkContext(context, pending.scope); await this.backend.removeSource!(pending.id);
    return this.update(context, pending, row => ({ ...row, cleanup: "finished" }));
  }
  async removeConfirmedSource(context: AttachmentStoreContext, row: StagedAttachmentRecord): Promise<StagedAttachmentRecord> {
    if (!row.stageRef || !row.scopeId || row.consumers.length === 0 || row.consumers.some(x => !x.confirmed) || !["sealed", "sourceRemovalPending"].includes(row.phase)) throw new AttachmentStoreConflict();
    if (this.backend.kind === "web") return this.transaction(context, rows => {
      const current = rows.find(x => x.id === row.id);
      if (!current || current.revision !== row.revision || immutable(current) !== immutable(row)) throw new AttachmentStoreConflict();
      const next: StagedAttachmentRecord = { ...current, revision: current.revision + 1, phase: "sourceRemoved", cleanup: "finished" }; record(next);
      return { value: next, putRow: { id: next.id, value: next }, deleteBytes: next.id };
    });
    const pending = row.phase === "sourceRemovalPending" ? row : await this.update(context, row, old => ({ ...old, phase: "sourceRemovalPending", cleanup: "requested" }));
    checkContext(context, pending.scope); await this.backend.removeSource!(pending.id);
    return this.update(context, pending, old => ({ ...old, phase: "sourceRemoved", cleanup: "finished" }));
  }
}
