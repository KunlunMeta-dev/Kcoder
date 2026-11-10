import { validUploadCollectionResult } from '../../../../shared/migrationUploadCollection';
import type { HistoricalAttachmentSelection } from "../../../../shared/generated/contracts";

const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export function attachmentSelectionIdentity(selection: HistoricalAttachmentSelection): string {
  return JSON.stringify([selection.jobId, selection.viewId ?? null, selection.position, selection.blockIndex, selection.toolItemIndex ?? null]);
}
function equalSelection(left: unknown, right: unknown): boolean {
  return attachmentSelectionIdentity(left as HistoricalAttachmentSelection) === attachmentSelectionIdentity(right as HistoricalAttachmentSelection);
}
/** Generated schemas validate shape first; these checks bind content to the requested coordinates. */
export function validHistoricalResult(name: string, input: unknown, output: unknown): boolean {
  const p = object(input), value = object(output), job = object(value.job);
  if (name.startsWith("uploadCollection") && !validUploadCollectionResult(input, output)) return false;
  if (name === "reinterpretPreview" && value.sourceJobId !== p.sourceJobId) return false;
  if (name === "reinterpretCreate" && job.jobId !== p.requestId) return false;
  if (name === "branchPrepare" && (!value.choice || !samePublicValue([...value.choice.relatedJobIds].sort(), [...(p.relatedJobIds ?? [])].sort()))) return false;
  if (p.viewId != null) {
    for (const candidate of [value.progress?.viewId, value.choice?.viewId, value.state?.viewId, value.viewId]) if (candidate != null && candidate !== p.viewId) return false;
  }
  if (name === "continuationCreate") {
    if (job.jobId !== p.requestId || job.sourceJobId !== p.sourceJobId || job.viewId !== p.viewId) return false;
    const options = (raw: unknown) => { const v = object(raw); return { model: v.model ?? null, settingsTemplate: v.settingsTemplate ?? null, studioWorkMode: v.studioWorkMode, localAttachments: (v.localAttachments ?? []).map((binding: any) => ({ operationId: binding.operationId, selection: attachmentSelectionIdentity(binding.selection), receipt: binding.receipt })) }; };
    if (!samePublicValue(options(job.options), options(p.options)) || !samePublicValue(job.policy, p.policy)) return false;
  }
  if (["undoCreate", "undoPreview"].includes(name) && (job.continuationJobId ?? value.continuationJobId) !== p.continuationJobId) return false;
  if (name === "undoLookup" && value.existingJob && value.existingJob.continuationJobId !== p.continuationJobId) return false;
  if (name.startsWith("local")) {
    const validLocal = (upload: any) => !upload.localJob || upload.localJob.historicalContentVerified === false && equalSelection(upload.selection, upload.localJob.selection) && upload.localJob.state.operationId === upload.operationId;
    if (value.upload) {
      if (value.upload.operationId !== (p.operationId ?? p.requestId)) return false;
      if (p.selection && !equalSelection(value.upload.selection, p.selection)) return false;
      if (!validLocal(value.upload)) return false;
    }
    if (name === "localList" && value.items?.some((item: any) => !equalSelection(item.selection, p.selection) || !validLocal(item))) return false;
  }
  if (["branchText", "archiveText"].includes(name) && (typeof value.text !== "string" || value.text.length > 64 * 1024)) return false;
  if (name === "historySearch" && (value.nextCursor?.length > 16384 || value.items?.some((hit: any) => !Number.isSafeInteger(hit.position) || hit.position < 0 || !Number.isSafeInteger(hit.record) || hit.record < 0 || !Number.isSafeInteger(hit.block.index) || hit.block.index < 0 || !hit.bodyCursor || hit.bodyCursor.length > 16384 || !hit.matched || [hit.before, hit.matched, hit.after].some(text => text.length > 4096)))) return false;
  if (name.endsWith("Chunk")) {
    if (value.offset !== p.offset || !Number.isSafeInteger(value.offset) || typeof value.dataBase64 !== "string" || value.dataBase64.length > 384 * 1024) return false;
    if (p.expectedReceipt && !samePublicValue(p.expectedReceipt, value.receipt)) return false;
    if (!/^[0-9a-f]{64}$/.test(String(value.dataSha256))) return false;
    if (value.nextOffset != null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset <= value.offset)) return false;
  }
  return true;
}
export function samePublicValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
