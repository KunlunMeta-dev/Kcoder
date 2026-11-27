import { isContract } from './generated/validator.mjs';

export const INSTRUCTION_CAPABILITY = 'migrationInstructionSourcesV1';
export const INSTRUCTION_TRANSFER_CAPABILITY = 'migrationSourceTransferInstructionsV1';
export const INSTRUCTION_METHODS = Object.freeze({ capture: 'migration/instructions/capture', page: 'migration/instructions/page', body: 'migration/instructions/body' });
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const atom = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 256 && !/[\p{Cc}]/u.test(value);
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const same = (a, b) => a.kind === b.kind && (a.kind === 'source' ? a.captureId === b.captureId
  : a.kind === 'job' ? a.jobId === b.jobId : a.requestId === b.requestId && a.manifestSha256 === b.manifestSha256 && a.entryId === b.entryId);
const relative = value => typeof value === 'string' && new TextEncoder().encode(value).length <= 4096 && !/[\\:\p{Cc}]/u.test(value)
  && (value === '' || value.split('/').length <= 64 && value.split('/').every(part => part && part !== '.' && part !== '..'));
const revision = value => value === 'scoped-instructions/v1' || value === 'scoped-instructions/v2';

/** Request-bound checks supplement generated serde/schema shape validation. */
export function validInstructionCall(method, input, result) {
  if (method === INSTRUCTION_METHODS.capture) {
    if (!isContract('MigrationInstructionCaptureParams', input)) return false;
    if (result === undefined) return true;
    return isContract('MigrationInstructionCaptureResult', result) && result.captureId === input.captureId && result.source === input.source
      && result.formatRevision === 'scoped-instructions/v2' && sha(result.sourceRevision) && count(result.totalItems, 128)
      && count(result.remainingMs, 600000) && result.remainingMs > 0;
  }
  if (method === INSTRUCTION_METHODS.page) {
    if (!isContract('MigrationInstructionPageParams', input) || !count(input.pageIndex ?? 0, 102)) return false;
    if (result === undefined) return true;
    if (!isContract('MigrationInstructionPageResult', result) || !same(input.target, result.target) || result.pageIndex !== (input.pageIndex ?? 0)
      || !count(result.totalItems, input.target.kind === 'job' ? 1024 : 128) || result.items.length > 10) return false;
    const start = result.pageIndex * 10;
    if (start >= result.totalItems && start !== 0 || result.items.length !== Math.min(10, Math.max(0, result.totalItems - start))
      || result.nextPage !== (start + 10 < result.totalItems ? result.pageIndex + 1 : null)) return false;
    const ids = new Set();
    return result.items.every(item => {
      if (!atom(item.itemId) || ids.has(item.itemId) || typeof item.displayName !== 'string' || item.displayName.length > 4096 || /[\p{Cc}]/u.test(item.displayName)) return false;
      ids.add(item.itemId);
      if (!item.scoped) return input.target.kind === 'job' && item.formatRevision === null && item.sourceRevision === null && item.relativePath === null
        && item.relativeScope === null && item.role === null && item.trigger === null && item.bytes === null && item.completeAuthorizedStaticChain === false
        && item.disposition === 'requires_review' && item.reasonCode === 'migration_instruction_legacy_scope_unobserved';
      return revision(item.formatRevision) && sha(item.sourceRevision) && relative(item.relativePath) && item.relativePath.length > 0
        && relative(item.relativeScope) && item.role !== null && item.trigger !== null && count(item.bytes, 4 * 1024 * 1024)
        && (item.reasonCode === null || /^migration_instruction_[a-z0-9_]{1,140}$/.test(item.reasonCode));
    });
  }
  if (method === INSTRUCTION_METHODS.body) {
    if (!isContract('MigrationInstructionBodyParams', input) || !count(input.offset ?? 0, 4 * 1024 * 1024)) return false;
    if (result === undefined) return true;
    if (!isContract('MigrationInstructionBodyResult', result) || !same(result.target, input.target) || result.itemId !== input.itemId
      || result.representation !== input.representation || result.offset !== (input.offset ?? 0) || !revision(result.formatRevision)
      || result.enabledByPreview !== false || !sha(result.sha256) || !count(result.totalBytes, 4 * 1024 * 1024)
      || result.bytesBase64.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.bytesBase64)) return false;
    try {
      const binary = atob(result.bytesBase64), end = result.offset + binary.length;
      if (btoa(binary) !== result.bytesBase64 || binary.length > 16384 || end > result.totalBytes || (end === result.offset && end !== result.totalBytes)
        || result.nextOffset !== (end < result.totalBytes ? end : null)) return false;
      return result.encoding === 'binary' ? result.text === undefined && input.representation === 'original'
        : result.text !== undefined && new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))) === result.text;
    } catch { return false; }
  }
  return false;
}

/** The owned source channel cannot address destination jobs or received artifacts. */
export function validInstructionSourceCall(method, input, result) {
  return validInstructionCall(method, input, result) && (method === INSTRUCTION_METHODS.capture || input.target.kind === 'source');
}
