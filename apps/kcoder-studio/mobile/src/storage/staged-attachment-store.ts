import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { parseRetentionAdmission, parseRetentionStageRef, retentionGenerationId, verifyRetentionGenerationId, isRetentionSha256, RETENTION_LOCAL_FILE_BYTES, type RetentionUploadAdmissionV1, type RetentionOwnerRequestV1, type RetentionStageRefV1, type RetentionUploadMethod, type RetentionUploadParamsV1, normalizedRetentionStageRefs, retentionStageRefsEqual, retentionReserveParams, retentionReadParams, parseScopedRetentionResult, isReadyRetentionReserveProof, type RetentionConsumerMethod, type RetentionConsumerExpectation, type RetentionReserveParamsV1, type RetentionReadParamsV1, type ScopedAttachmentRetentionResultV1 } from "@/protocol/attachment-retention";
import { hashBoundedSource } from "@/protocol/sha256-stream";
import { createAttachmentBytesBackend, type AttachmentBytesBackend, type AttachmentStoreChange, type DurableByteSource } from "./staged-attachment-bytes";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite, type WorkspaceProfileIdentity } from "./workspace-profile-fence";

export const STAGED_ATTACHMENT_LIMIT = 128;
export const STAGED_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
const ROW_BYTES = 32 * 1024;
const TOTAL_METADATA_BYTES = 4 * 1024 * 1024;
export interface AttachmentStoreContext { profile: GatewayProfile; server: KCoderServer; workspacePath?: string; isCurrent(): boolean }
export interface StagedAttachmentScope { profile: WorkspaceProfileIdentity; target: string }
export interface RetentionConsumerBatchHandle { leaderId: string; reserveId: string; threadId: string; clientMessageId: string }
export interface RetentionConsumerBatch extends RetentionConsumerBatchHandle {
  version: 1; revision: number; admission: RetentionUploadAdmissionV1; scopeId: string;
  members: { localAttachmentId: string; stageRef: RetentionStageRefV1 }[];
  phase: "prepared" | "reserveSent" | "checking" | "ready" | "unknown" | "capacityRejected" | "prepaidSlotUnavailable";
  observation?: ScopedAttachmentRetentionResultV1;
}
export interface RetainedAttachmentComposer { threadId: string; mimeType: string }
export interface StagedAttachmentRecord {
  version: 1; id: string; revision: number; scope: StagedAttachmentScope;
  admission: RetentionUploadAdmissionV1; ownerRequest: RetentionOwnerRequestV1; clientUploadId: string;
  filename: string; size: number; contentSha256?: string;
  /** Captured before local persistence; never reconstructed from a filename/path. */
  composer?: RetainedAttachmentComposer;
  phase: "copying" | "prepared" | "uploading" | "sealed" | "cancelled" | "epochRetired" | "sourceRemovalPending" | "sourceRemoved";
  confirmedBytes: number; scopeId?: string; stageRef?: RetentionStageRefV1;
  wire?: { method: RetentionUploadMethod; params: Omit<RetentionUploadParamsV1, "contentBase64">; revision: number };
  consumers: { clientMessageId: string; reserveId: string; leaderId: string }[];
  /** Full batch journal lives only in the deterministic first member's row. */
  consumerBatch?: RetentionConsumerBatch;
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
  if (row.composer && (Object.keys(row.composer).some(key => !["threadId", "mimeType"].includes(key)) || !messageAtom(row.composer.threadId) || typeof row.composer.mimeType !== "string" || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(row.composer.mimeType) || row.composer.mimeType.length > 255)) throw new AttachmentStoreConflict();
  if (!["copying", "prepared", "uploading", "sealed", "cancelled", "epochRetired", "sourceRemovalPending", "sourceRemoved"].includes(row.phase) || !["none", "requested", "finished"].includes(row.cleanup)) throw new AttachmentStoreConflict();
  if ((row.phase !== "copying" || row.contentSha256 !== undefined) && !isRetentionSha256(row.contentSha256)) throw new AttachmentStoreConflict();
  if (row.scopeId !== undefined && !isRetentionSha256(row.scopeId)) throw new AttachmentStoreConflict();
  if (row.stageRef) parseRetentionStageRef(row.stageRef);
  if (["sealed", "sourceRemovalPending", "sourceRemoved"].includes(row.phase) && (!row.stageRef || row.confirmedBytes !== row.size || !row.scopeId)) throw new AttachmentStoreConflict();
  if (row.stageRef && (row.stageRef.rootNamespace !== row.admission.rootNamespace || row.stageRef.epoch !== row.admission.admissionEpoch)) throw new AttachmentStoreConflict();
  if (!Array.isArray(row.consumers) || row.consumers.length > 1 || row.consumers.some(x => !messageAtom(x.clientMessageId) || !messageAtom(x.reserveId) || !/^[a-f0-9]{32}$/.test(x.leaderId) || Object.keys(x).some(key => !["clientMessageId", "reserveId", "leaderId"].includes(key)))) throw new AttachmentStoreConflict();
  if (row.consumerBatch) validateBatch(row.consumerBatch, row);
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
  return JSON.stringify([row.id, row.scope, row.admission, row.ownerRequest, row.clientUploadId, row.filename, row.size, row.contentSha256, row.composer]);
}
function messageAtom(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
export function consumerExpectation(batch: RetentionConsumerBatch): RetentionConsumerExpectation {
  return { admission: batch.admission, scopeId: batch.scopeId, reserveId: batch.reserveId, threadId: batch.threadId, stageRefs: batch.members.map(member => member.stageRef) };
}
function immutableBatch(batch: RetentionConsumerBatch): string {
  return JSON.stringify([batch.version, batch.leaderId, batch.reserveId, batch.threadId, batch.clientMessageId, batch.admission, batch.scopeId, batch.members]);
}
function validateBatch(batch: RetentionConsumerBatch, leader: StagedAttachmentRecord): void {
  if (Object.keys(batch).some(key => !["version", "revision", "leaderId", "reserveId", "threadId", "clientMessageId", "admission", "scopeId", "members", "phase", "observation"].includes(key)) || batch.version !== 1 || batch.leaderId !== leader.id || !messageAtom(batch.clientMessageId) || !Number.isSafeInteger(batch.revision) || batch.revision < 1 || batch.scopeId !== leader.scopeId || !Array.isArray(batch.members) || !["prepared", "reserveSent", "checking", "ready", "unknown", "capacityRejected", "prepaidSlotUnavailable"].includes(batch.phase)) throw new AttachmentStoreConflict();
  if (batch.members.some(member => Object.keys(member).some(key => !["localAttachmentId", "stageRef"].includes(key)))) throw new AttachmentStoreConflict();
  if (batch.phase === "prepared" && batch.observation !== undefined) throw new AttachmentStoreConflict();
  retentionReserveParams(consumerExpectation(batch));
  const ids = batch.members.map(member => member.localAttachmentId);
  if (ids.some(id => !/^[a-f0-9]{32}$/.test(id)) || new Set(ids).size !== ids.length || ids[0] !== batch.leaderId || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) throw new AttachmentStoreConflict();
  if (batch.observation) parseScopedRetentionResult(batch.observation, consumerExpectation(batch));
  if (batch.phase === "ready" && (!batch.observation || !isReadyRetentionReserveProof(batch.observation))) throw new AttachmentStoreConflict();
}
function selectBatch(rows: StagedAttachmentRecord[], handle: RetentionConsumerBatchHandle, scope: StagedAttachmentScope): { batch: RetentionConsumerBatch; rows: StagedAttachmentRecord[] } {
  const leader = rows.find(row => row.id === handle.leaderId); const batch = leader?.consumerBatch;
  if (!leader || !batch || !sameScope(leader.scope, scope) || batch.reserveId !== handle.reserveId || batch.clientMessageId !== handle.clientMessageId || batch.threadId !== handle.threadId) throw new AttachmentStoreConflict();
  validateBatch(batch, leader);
  const members = batch.members.map(member => {
    const row = rows.find(row => row.id === member.localAttachmentId);
    if (!row || (row.composer && row.composer.threadId !== batch.threadId) || !sameScope(row.scope, scope) || row.scopeId !== batch.scopeId || !row.stageRef || !retentionStageRefsEqual([row.stageRef], [member.stageRef]) || row.consumers.length !== 1 || row.consumers[0]!.reserveId !== batch.reserveId || row.consumers[0]!.leaderId !== batch.leaderId || row.consumers[0]!.clientMessageId !== batch.clientMessageId || !["sealed", "sourceRemovalPending", "sourceRemoved"].includes(row.phase) || row.wire || (row.id !== batch.leaderId && row.consumerBatch)) throw new AttachmentStoreConflict();
    return row;
  });
  if (rows.some(row => row.consumers.some(link => link.reserveId === batch.reserveId) && !members.includes(row))) throw new AttachmentStoreConflict();
  return { batch, rows: members };
}
function commitBatchRows<T>(rows: StagedAttachmentRecord[], changed: StagedAttachmentRecord[], value: T): AttachmentStoreChange<T> {
  const replacements = new Map(changed.map(row => [row.id, row]));
  const next = records(rows.map(row => replacements.get(row.id) ?? row));
  const leader = changed.find(row => row.consumerBatch)?.consumerBatch;
  if (leader) selectBatch(next, leader, next.find(row => row.id === leader.leaderId)!.scope);
  return { value, putRows: changed.map(row => ({ id: row.id, value: row })) };
}
function assertConsumerReady(rows: StagedAttachmentRecord[], row: StagedAttachmentRecord, scope: StagedAttachmentScope): void {
  const link = row.consumers[0]; if (!link) throw new AttachmentStoreConflict();
  const leader = rows.find(item => item.id === link.leaderId); const batch = leader?.consumerBatch;
  if (!batch || batch.phase !== "ready") throw new AttachmentStoreConflict();
  const selected = selectBatch(rows, batch, scope);
  if (!selected.rows.some(member => member.id === row.id) || !batch.observation || !isReadyRetentionReserveProof(parseScopedRetentionResult(batch.observation, consumerExpectation(batch)))) throw new AttachmentStoreConflict();
}
export class StagedAttachmentStore {
  private readonly cleanupCapabilities = new WeakMap<RetentionConsumerBatch, string>();
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
    return this.transaction(context, rows => ({ value: rows.filter(row => sameScope(row.scope, scope) && (row.cleanup !== "finished" || row.consumerBatch !== undefined)) }));
  }
  async prepare(context: AttachmentStoreContext, admission: RetentionUploadAdmissionV1, filename: string, source: DurableByteSource, signal?: AbortSignal, composer?: RetainedAttachmentComposer): Promise<StagedAttachmentRecord> {
    const scope = scopeOf(context); checkContext(context, scope); parseRetentionAdmission(admission);
    const id = nonce();
    let row: StagedAttachmentRecord = { version: 1, id, revision: 1, scope, admission: clone(admission), ownerRequest: { clientOwnerRequestId: retentionGenerationId("o1", admission, nonce()), immutableParameters: { purpose: "mobile-attachment", localAttachmentId: id } }, clientUploadId: retentionGenerationId("u1", admission, nonce()), filename, ...(composer ? { composer: clone(composer) } : {}), size: source.size, phase: "copying", confirmedBytes: 0, consumers: [], cleanup: "none" };
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
      if (immutable(next) !== immutable(current) || JSON.stringify([next.consumers, next.consumerBatch]) !== JSON.stringify([current.consumers, current.consumerBatch])) throw new AttachmentStoreConflict();
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
        if (!current || !sameScope(current.scope, scope) || current.revision !== expected.revision || immutable(current) !== immutable(expected) || current.consumers.length !== 0) throw new AttachmentStoreConflict();
        const durableParams = clone(params); delete durableParams.contentBase64;
        const next = { ...current, revision: current.revision + 1, wire: { method, params: durableParams, revision: current.revision + 1 } }; record(next);
        checkContext(context, scope); return { value: next, putRow: { id: next.id, value: next } };
      });
      checkContext(context, scope); return { row, response: send() };
    });
  }
  /** Atomic binding of one submission to its exact local rows and normalized sealed refs. */
  async prepareConsumerBatch(context: AttachmentStoreContext, expected: readonly StagedAttachmentRecord[], threadId: string, clientMessageId: string): Promise<RetentionConsumerBatch> {
    if (expected.some(row => row.composer && row.composer.threadId !== threadId)) throw new AttachmentStoreConflict();
    if (!messageAtom(threadId) || !messageAtom(clientMessageId) || expected.length < 1 || expected.length > 32 || new Set(expected.map(row => row.id)).size !== expected.length) throw new AttachmentStoreConflict();
    return this.transaction(context, rows => {
      const captured = expected.map(item => {
        const row = rows.find(row => row.id === item.id);
        if (!row || row.revision !== item.revision || immutable(row) !== immutable(item) || !sameScope(row.scope, scopeOf(context)) || !["sealed", "sourceRemoved"].includes(row.phase) || row.wire || !row.stageRef || !row.scopeId) throw new AttachmentStoreConflict();
        return row;
      }).sort((a, b) => a.id.localeCompare(b.id));
      const stageRefs = normalizedRetentionStageRefs(captured.map(row => row.stageRef!));
      const scopeId = captured[0]!.scopeId!;
      if (captured.some(row => row.scopeId !== scopeId) || stageRefs.some(ref => ref.rootNamespace !== stageRefs[0]!.rootNamespace)) throw new AttachmentStoreConflict();
      // Same message identity cannot silently acquire another set, even if the
      // caller lost its original handle after the first local commit.
      const existing = rows.filter(row => sameScope(row.scope, scopeOf(context))).flatMap(row => row.consumerBatch ? [row.consumerBatch] : []).find(batch => batch.clientMessageId === clientMessageId);
      if (existing) {
        const found = selectBatch(rows, existing, scopeOf(context));
        if (found.batch.threadId !== threadId || JSON.stringify(found.batch.members.map(member => member.localAttachmentId)) !== JSON.stringify(captured.map(row => row.id)) || !retentionStageRefsEqual(found.batch.members.map(member => member.stageRef), stageRefs)) throw new AttachmentStoreConflict();
        return { value: clone(found.batch) };
      }
      // The service currently binds each sealed entry to one receipt. A second
      // independent submission needs a separately prepared upload, never reuse.
      if (captured.some(row => row.consumers.length !== 0 || row.consumerBatch || row.phase !== "sealed")) throw new AttachmentStoreConflict();
      const admission: RetentionUploadAdmissionV1 = { version: 1, rootNamespace: stageRefs[0]!.rootNamespace, admissionEpoch: Math.min(...stageRefs.map(ref => ref.epoch)) };
      const batch: RetentionConsumerBatch = { version: 1, revision: 1, leaderId: captured[0]!.id, reserveId: retentionGenerationId("r1", admission, nonce()), threadId, clientMessageId, admission, scopeId,
        members: captured.map(row => ({ localAttachmentId: row.id, stageRef: normalizedRetentionStageRefs([row.stageRef!])[0]! })), phase: "prepared" };
      const next = captured.map(row => ({ ...row, revision: row.revision + 1, consumers: [{ clientMessageId, reserveId: batch.reserveId, leaderId: batch.leaderId }], ...(row.id === batch.leaderId ? { consumerBatch: batch } : {}) }));
      // Preflight the largest exact receipt projection now, before any reserve
      // RPC: a full local index must still have room to persist its ACK journal.
      const prepaid = { ...batch, revision: Number.MAX_SAFE_INTEGER, phase: "reserveSent" as const,
        observation: { scopeId, result: { receipt: { clientRequestId: batch.reserveId, retentionId: batch.reserveId, threadId, revision: Number.MAX_SAFE_INTEGER, state: "releasePending" as const,
          entries: stageRefs.map(stageRef => ({ stageRef, state: "sourceDeleting" as const })) } } } };
      const capacity = new Map(next.map(row => [row.id, { ...row, revision: Number.MAX_SAFE_INTEGER, ...(row.id === batch.leaderId ? { consumerBatch: prepaid } : {}) }]));
      const prepaidRows = rows.map(row => capacity.get(row.id) ?? row);
      records(prepaidRows);
      // Leave a small fixed margin for phase names and later journal fields;
      // confirmation must not need new local capacity after the reserve sends.
      if (prepaidRows.some(row => capacity.has(row.id) && JSON.stringify(row).length * 2 + 128 > ROW_BYTES)) throw new AttachmentStoreConflict();
      return commitBatchRows(rows, next, clone(batch));
    });
  }
  async loadConsumerBatch(context: AttachmentStoreContext, handle: RetentionConsumerBatchHandle): Promise<RetentionConsumerBatch> {
    return this.transaction(context, rows => ({ value: clone(selectBatch(rows, handle, scopeOf(context)).batch) }));
  }
  /** CAS all members before sync send; network response is awaited outside the profile gate. */
  async dispatchConsumerBatch<T>(context: AttachmentStoreContext, expected: RetentionConsumerBatch, send: (method: RetentionConsumerMethod, params: RetentionReserveParamsV1 | RetentionReadParamsV1) => Promise<T>): Promise<{ batch: RetentionConsumerBatch; response: Promise<T> }> {
    const scope = scopeOf(context); checkContext(context, scope);
    return withWorkspaceProfileWrite(scope.profile, async () => {
      const batch = await this.backend.transaction(values => {
        checkContext(context, scope); const rows = records(values); const selected = selectBatch(rows, expected, scope);
        if (selected.batch.revision !== expected.revision || immutableBatch(selected.batch) !== immutableBatch(expected)) throw new AttachmentStoreConflict();
        // Legacy capacityRejected was derived from ambiguous -32032. It is
        // read-only on recovery, because reserve may already have committed.
        if (selected.batch.phase === "prepaidSlotUnavailable") throw new AttachmentStoreConflict();
        const next: RetentionConsumerBatch = { ...selected.batch, revision: selected.batch.revision + 1, phase: selected.batch.phase === "prepared" ? "reserveSent" : "checking" };
        return commitBatchRows(rows, selected.rows.map(row => ({ ...row, revision: row.revision + 1, ...(row.id === next.leaderId ? { consumerBatch: next } : {}) })), clone(next));
      });
      checkContext(context, scope);
      const method: RetentionConsumerMethod = batch.phase === "reserveSent" ? "attachment/retention/reserve" : "attachment/retention/read";
      const params = method === "attachment/retention/reserve" ? retentionReserveParams(consumerExpectation(batch)) : retentionReadParams(consumerExpectation(batch));
      return { batch, response: send(method, params) };
    });
  }
  /** Only reserve's dedicated pre-commit code may mark this exact batch blocked. */
  async recordConsumerPrepaidSlotUnavailable(context: AttachmentStoreContext, expected: RetentionConsumerBatch): Promise<void> {
    await this.transaction(context, rows => {
      const selected = selectBatch(rows, expected, scopeOf(context));
      if (selected.batch.revision !== expected.revision || immutableBatch(selected.batch) !== immutableBatch(expected) || selected.batch.phase !== "reserveSent") throw new AttachmentStoreConflict();
      const next: RetentionConsumerBatch = { ...selected.batch, revision: selected.batch.revision + 1, phase: "prepaidSlotUnavailable" };
      return commitBatchRows(rows, selected.rows.map(row => ({ ...row, revision: row.revision + 1, ...(row.id === next.leaderId ? { consumerBatch: next } : {}) })), undefined);
    });
  }
  /** Only an exact scoped server result can make a consumer ready, never a boolean callback. */
  async observeConsumerBatch(context: AttachmentStoreContext, expected: RetentionConsumerBatch, raw: unknown): Promise<RetentionConsumerBatch> {
    const observation = parseScopedRetentionResult(raw, consumerExpectation(expected));
    const observed = await this.transaction(context, rows => {
      const selected = selectBatch(rows, expected, scopeOf(context));
      if (selected.batch.revision !== expected.revision || immutableBatch(selected.batch) !== immutableBatch(expected) || !["reserveSent", "checking"].includes(selected.batch.phase)) throw new AttachmentStoreConflict();
      const next: RetentionConsumerBatch = { ...selected.batch, revision: selected.batch.revision + 1, phase: isReadyRetentionReserveProof(observation) ? "ready" : "unknown", observation };
      return commitBatchRows(rows, selected.rows.map(row => ({ ...row, revision: row.revision + 1, ...(row.id === next.leaderId ? { consumerBatch: next } : {}) })), clone(next));
    });
    if (observed.phase === "ready") this.cleanupCapabilities.set(observed, JSON.stringify(observed));
    return observed;
  }
  /** Exact in-memory observation capability, not a decoded journal, authorizes byte cleanup. */
  async cleanupConfirmedConsumer(context: AttachmentStoreContext, observed: RetentionConsumerBatch): Promise<void> {
    if (this.cleanupCapabilities.get(observed) !== JSON.stringify(observed) || observed.phase !== "ready") throw new AttachmentStoreConflict();
    const current = await this.loadConsumerBatch(context, observed);
    if (JSON.stringify(current) !== JSON.stringify(observed)) throw new AttachmentStoreConflict();
    for (const member of observed.members) {
      const row = await this.load(context, member.localAttachmentId);
      if (!row) throw new AttachmentStoreConflict();
      if (row.phase !== "sourceRemoved") await this.removeConfirmedSource(context, row);
    }
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
  private async removeConfirmedSource(context: AttachmentStoreContext, row: StagedAttachmentRecord): Promise<StagedAttachmentRecord> {
    if (!row.stageRef || !row.scopeId || row.consumers.length !== 1 || !["sealed", "sourceRemovalPending"].includes(row.phase)) throw new AttachmentStoreConflict();
    if (this.backend.kind === "web") return this.transaction(context, rows => {
      const current = rows.find(x => x.id === row.id);
      if (!current || current.revision !== row.revision || immutable(current) !== immutable(row)) throw new AttachmentStoreConflict();
      assertConsumerReady(rows, current, scopeOf(context));
      const next: StagedAttachmentRecord = { ...current, revision: current.revision + 1, phase: "sourceRemoved", cleanup: "finished" }; record(next);
      return { value: next, putRow: { id: next.id, value: next }, deleteBytes: next.id };
    });
    const pending = await this.transaction(context, rows => {
      const current = rows.find(item => item.id === row.id);
      if (!current || current.revision !== row.revision || immutable(current) !== immutable(row)) throw new AttachmentStoreConflict();
      assertConsumerReady(rows, current, scopeOf(context));
      if (current.phase === "sourceRemovalPending") return { value: current };
      const next: StagedAttachmentRecord = { ...current, revision: current.revision + 1, phase: "sourceRemovalPending", cleanup: "requested" }; record(next);
      return { value: next, putRow: { id: next.id, value: next } };
    });
    checkContext(context, pending.scope); await this.backend.removeSource!(pending.id);
    return this.update(context, pending, old => ({ ...old, phase: "sourceRemoved", cleanup: "finished" }));
  }
}
