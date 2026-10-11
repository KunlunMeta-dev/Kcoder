/** Public retained-upload contract. The Gateway injects private authority. */
export const RETENTION_CAPABILITY = "stagedAttachmentRetentionReceiptsV1";
export const RETENTION_CHUNK_BYTES = 512 * 1024;
export const RETENTION_SAVE_BYTES = 256 * 1024;
export const RETENTION_LOCAL_FILE_BYTES = 50 * 1024 * 1024;
export type RetentionUploadMethod = `attachment/retention/upload/${"save" | "start" | "read" | "chunk" | "finish" | "cancel"}`;
export interface RetentionUploadAdmissionV1 { version: 1; rootNamespace: string; admissionEpoch: number }
export interface RetentionOwnerRequestV1 { clientOwnerRequestId: string; immutableParameters: Record<string, string> }
export interface RetentionStageRefV1 { rootNamespace: string; epoch: number; ownerId: string; entryId: string; revision: number; path?: string }
export type RetentionUploadState = "allocating" | "uploading" | "sealed" | "cancelled" | "unknown";
export interface RetentionUploadRecoveryV1 { rootNamespace: string; epoch: number; state: RetentionUploadState; confirmedBytes: number; stageRef?: RetentionStageRefV1 }
export interface RetentionEpochRetiredV1 { rootNamespace: string; epoch: number; retiredThrough: number }
export type RetentionUploadLookupV1 = { outcome: "absent" } | { outcome: "present"; filename: string; size: number; contentSha256: string; recovery: RetentionUploadRecoveryV1 } | { outcome: "epochRetired"; proof: RetentionEpochRetiredV1 };
export interface RetentionUploadResultV1 { clientOwnerRequestId: string; clientUploadId: string; scopeId: string; lookup: RetentionUploadLookupV1 }
export interface RetentionUploadExpectation { ownerRequest: RetentionOwnerRequestV1; clientUploadId: string; admission: RetentionUploadAdmissionV1; filename: string; size: number; contentSha256: string; scopeId?: string; stageRef?: RetentionStageRefV1 }
export interface RetentionUploadParamsV1 {
  ownerRequest: RetentionOwnerRequestV1; clientUploadId: string;
  filename?: string; size?: number; contentSha256?: string;
  offset?: number; length?: number; chunkSha256?: string; contentBase64?: string;
}
const invalid = () => new Error("附件回执无效；保留原上传 ID 和本地文件");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function atom(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function integer(value: unknown, minimum = 0): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum; }
export function isRetentionSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
export function parseRetentionAdmission(value: unknown): RetentionUploadAdmissionV1 {
  const v = object(value); fields(v, ["version", "rootNamespace", "admissionEpoch"]);
  if (v.version !== 1 || !atom(v.rootNamespace) || !/^[a-zA-Z0-9_-]+$/.test(v.rootNamespace) || !integer(v.admissionEpoch, 1)) throw invalid();
  return { version: 1, rootNamespace: v.rootNamespace, admissionEpoch: v.admissionEpoch };
}
export function retentionGenerationId(prefix: "o1" | "u1" | "r1", admission: RetentionUploadAdmissionV1, nonce: string): string {
  parseRetentionAdmission(admission);
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw invalid();
  const result = `${prefix}.${admission.rootNamespace}.${admission.admissionEpoch}.${nonce}`;
  if (result.length > 256) throw invalid();
  return result;
}
export function verifyRetentionGenerationId(value: unknown, prefix: "o1" | "u1", admission: RetentionUploadAdmissionV1): asserts value is string {
  if (typeof value !== "string") throw invalid();
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== prefix || parts[1] !== admission.rootNamespace || parts[2] !== String(admission.admissionEpoch) || !/^[0-9a-f]{32}$/.test(parts[3]!) || value.length > 256) throw invalid();
}
export function parseRetentionStageRef(value: unknown): RetentionStageRefV1 {
  const v = object(value); fields(v, ["rootNamespace", "epoch", "ownerId", "entryId", "revision", "path"]);
  if (!atom(v.rootNamespace) || !integer(v.epoch, 1) || !atom(v.ownerId) || !atom(v.entryId) || !integer(v.revision, 1) || (v.path !== undefined && (!atom(v.path, 4096) || !v.path.startsWith("/")))) throw invalid();
  return { rootNamespace: v.rootNamespace, epoch: v.epoch, ownerId: v.ownerId, entryId: v.entryId, revision: v.revision, ...(v.path !== undefined ? { path: v.path } : {}) };
}
export function parseRetentionUploadResult(value: unknown, expected: RetentionUploadExpectation): RetentionUploadResultV1 {
  const v = object(value); fields(v, ["clientOwnerRequestId", "clientUploadId", "scopeId", "lookup"]);
  verifyRetentionGenerationId(v.clientOwnerRequestId, "o1", expected.admission);
  verifyRetentionGenerationId(v.clientUploadId, "u1", expected.admission);
  if (v.clientOwnerRequestId !== expected.ownerRequest.clientOwnerRequestId || v.clientUploadId !== expected.clientUploadId || !isRetentionSha256(v.scopeId) || (expected.scopeId !== undefined && v.scopeId !== expected.scopeId)) throw invalid();
  const l = object(v.lookup); let lookup: RetentionUploadLookupV1;
  if (l.outcome === "absent") { fields(l, ["outcome"]); lookup = { outcome: "absent" }; }
  else if (l.outcome === "epochRetired") {
    fields(l, ["outcome", "proof"]); const proof = object(l.proof); fields(proof, ["rootNamespace", "epoch", "retiredThrough"]);
    if (proof.rootNamespace !== expected.admission.rootNamespace || proof.epoch !== expected.admission.admissionEpoch || !integer(proof.retiredThrough) || proof.retiredThrough < expected.admission.admissionEpoch) throw invalid();
    lookup = { outcome: "epochRetired", proof: { rootNamespace: proof.rootNamespace, epoch: proof.epoch, retiredThrough: proof.retiredThrough } };
  } else if (l.outcome === "present") {
    fields(l, ["outcome", "filename", "size", "contentSha256", "recovery"]);
    if (l.filename !== expected.filename || l.size !== expected.size || !integer(l.size) || l.size > RETENTION_LOCAL_FILE_BYTES || !isRetentionSha256(l.contentSha256) || l.contentSha256 !== expected.contentSha256) throw invalid();
    const rec = object(l.recovery); fields(rec, ["rootNamespace", "epoch", "state", "confirmedBytes", "stageRef"]);
    if (rec.rootNamespace !== expected.admission.rootNamespace || rec.epoch !== expected.admission.admissionEpoch || !integer(rec.confirmedBytes) || rec.confirmedBytes > expected.size || !["allocating", "uploading", "sealed", "cancelled", "unknown"].includes(String(rec.state))) throw invalid();
    const stageRef = rec.stageRef === undefined ? undefined : parseRetentionStageRef(rec.stageRef);
    if (expected.stageRef && JSON.stringify(stageRef) !== JSON.stringify(expected.stageRef)) throw invalid();
    if (stageRef && (stageRef.rootNamespace !== rec.rootNamespace || stageRef.epoch !== rec.epoch)) throw invalid();
    if (rec.state === "sealed" && (!stageRef || rec.confirmedBytes !== expected.size)) throw invalid();
    if (rec.state === "allocating" && (rec.confirmedBytes !== 0 || stageRef)) throw invalid();
    if (rec.state === "uploading" && stageRef) throw invalid();
    lookup = { outcome: "present", filename: expected.filename, size: expected.size, contentSha256: expected.contentSha256,
      recovery: { rootNamespace: expected.admission.rootNamespace, epoch: expected.admission.admissionEpoch, state: rec.state as RetentionUploadState, confirmedBytes: rec.confirmedBytes, ...(stageRef ? { stageRef } : {}) } };
  } else throw invalid();
  return { clientOwnerRequestId: v.clientOwnerRequestId, clientUploadId: v.clientUploadId, scopeId: v.scopeId, lookup };
}

/** Exact public fields mirror Rust validate_for; trustedContext is never a public parameter. */
export function validateRetentionUploadParams(method: RetentionUploadMethod, value: RetentionUploadParamsV1, expected: RetentionUploadExpectation): void {
  const v = object(value);
  const mode = method.slice("attachment/retention/upload/".length);
  if (!["save", "start", "read", "chunk", "finish", "cancel"].includes(mode)) throw invalid();
  const start = mode === "save" || mode === "start"; const chunk = mode === "chunk"; const bytes = mode === "save" || chunk;
  fields(v, ["ownerRequest", "clientUploadId", ...(start ? ["filename", "size", "contentSha256"] : []), ...(chunk ? ["offset", "length", "chunkSha256"] : []), ...(bytes ? ["contentBase64"] : [])]);
  const owner = object(v.ownerRequest); fields(owner, ["clientOwnerRequestId", "immutableParameters"]);
  const immutable = object(owner.immutableParameters);
  if (Object.keys(immutable).length > 32 || Object.entries(immutable).some(([key, entry]) => !atom(key) || !atom(entry)) || JSON.stringify(owner).length > 16384 || JSON.stringify(owner) !== JSON.stringify(expected.ownerRequest)) throw invalid();
  verifyRetentionGenerationId(owner.clientOwnerRequestId, "o1", expected.admission);
  verifyRetentionGenerationId(v.clientUploadId, "u1", expected.admission);
  if (v.clientUploadId !== expected.clientUploadId) throw invalid();
  if (start && (v.filename !== expected.filename || v.size !== expected.size || v.contentSha256 !== expected.contentSha256 || !atom(v.filename) || !integer(v.size) || v.size > RETENTION_LOCAL_FILE_BYTES || !isRetentionSha256(v.contentSha256))) throw invalid();
  if (chunk && (!integer(v.offset) || !integer(v.length, 1) || v.length > RETENTION_CHUNK_BYTES || v.offset + v.length > expected.size || !isRetentionSha256(v.chunkSha256))) throw invalid();
  if (mode === "save" && expected.size > RETENTION_SAVE_BYTES) throw invalid();
  if (bytes) {
    if (typeof v.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.contentBase64)) throw invalid();
    const length = v.contentBase64.length / 4 * 3 - (v.contentBase64.endsWith("==") ? 2 : v.contentBase64.endsWith("=") ? 1 : 0);
    if (length !== (chunk ? v.length : expected.size) || length > RETENTION_CHUNK_BYTES) throw invalid();
  }
}
