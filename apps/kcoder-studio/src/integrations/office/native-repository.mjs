import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const hash = value => createHash('sha256').update(value).digest('hex');
function owner(value) { return { accountId: value.accountId, targetId: value.targetId, workspaceId: value.workspaceId, ...(typeof value.organizationId === 'string' ? { organizationId: value.organizationId } : {}) }; }
function flatten(record) {
  if (!record?.receipt) return null;
  const receipt = record.receipt;
  const own = owner(receipt.owner);
  const metadata = { filename: receipt.metadata.filename, mediaType: receipt.metadata.mediaType, expectedBytes: receipt.metadata.expectedBytes, expectedSha256: receipt.metadata.expectedSha256 };
  return { inputId: receipt.inputId, operationId: receipt.operationId, owner: own, metadata,
    intent: hash(JSON.stringify({ owner: own, operationId: receipt.operationId, metadata })),
    status: receipt.status, bytes: receipt.bytes, sha256: receipt.sha256, native: record.native };
}
function failure(code) { const error = new Error(code); error.code = code; error.recovery = 'reconcile_original'; return error; }
const media = Object.freeze({ docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',pdf:'application/pdf',csv:'text/csv; charset=utf-8',json:'application/json' });
/**
 * privateCall is the authenticated, host-only IPC owner. The adapter must never
 * be backed by the ordinary client RPC dispatcher or a caller-supplied address.
 */
export function createOfficeNativeRepository({ privateCall, getScope }) {
  if (typeof privateCall !== 'function' || typeof getScope !== 'function') throw failure('OFFICE_HOST_PROVIDER_REQUIRED');
  const call = async (method, payload, options = {}) => {
    try { return await privateCall(method, payload, { scope: getScope(), ...options }); }
    catch { throw failure('OFFICE_NATIVE_STORE_UNCONFIRMED'); }
  };
  const receipts = {
    async beginInput(record) {
      if (!isDeepStrictEqual(owner(getScope()),owner(record.owner))) throw failure('OFFICE_SCOPE_CHANGED');
      const result = await call('office/input/begin', { inputId: record.inputId, operationId: record.operationId, metadata: record.metadata }, { operationId: record.operationId });
      const stored = flatten(result.record);
      if (!stored) throw failure('OFFICE_NATIVE_STORE_UNCONFIRMED');
      return { existing: result.existing === true, record: stored };
    },
    async readInput({ inputId }) { const result = await call('office/input/read', { inputId }); return flatten(result.record); },
    async completeInput(record) {
      if (!isDeepStrictEqual(owner(getScope()),owner(record.owner))) throw failure('OFFICE_SCOPE_CHANGED');
      const result = await call('office/input/complete', { inputId: record.inputId, operationId: record.operationId, bytes: record.bytes, sha256: record.sha256, native: record.native }, { operationId: record.operationId });
      if (result.receipt?.status !== 'accepted') throw failure('OFFICE_NATIVE_STORE_UNCONFIRMED');
    },
    async failInput(record) { await call('office/input/fail', { inputId: record.inputId, operationId: record.operationId }, { operationId: record.operationId }); }
  };
  const exports = {
    async readExport({ scope, artifactRef, destination, signal }) {
      if (!isDeepStrictEqual(getScope(),scope)) throw failure('OFFICE_SCOPE_CHANGED');
      const { manifest } = await call('office/artifact/read', { reference: artifactRef, ...(destination ? { destination } : {}) }, { signal });
      if (!manifest || manifest.id !== artifactRef.id || manifest.revision !== artifactRef.revision || !media[manifest.format]
        || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw failure('OFFICE_EXPORT_RECEIPT_INVALID');
      const originalScope = JSON.stringify(getScope());
      const byteStream = async function* () {
        let offset = 0;
        while (offset < manifest.bytes) {
          if (signal?.aborted || originalScope !== JSON.stringify(getScope())) throw failure('OFFICE_SCOPE_CHANGED');
          const chunk = await call('office/artifact/chunk', { reference: artifactRef, offset, length: 512 * 1024, ...(destination ? { destination } : {}) }, { signal });
          if (chunk.totalBytes !== manifest.bytes || chunk.offset !== offset || typeof chunk.contentBase64 !== 'string'
            || chunk.contentBase64.length > 700_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.contentBase64)) throw failure('OFFICE_EXPORT_RECEIPT_INVALID');
          const bytes = Buffer.from(chunk.contentBase64, 'base64');
          if (!bytes.length || bytes.length > 512 * 1024 || offset + bytes.length > manifest.bytes) throw failure('OFFICE_EXPORT_SIZE_MISMATCH');
          offset += bytes.length; yield bytes;
        }
      };
      const title = String(manifest.title).replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/^[ .]+|[ .]+$/gu, '').slice(0, 80) || 'office-deliverable';
      return { filename: `office_${title}.${manifest.format}`, mediaType: media[manifest.format], expectedBytes: manifest.bytes, sha256: manifest.sha256.toLowerCase(), byteStream: byteStream() };
    }
  };
  return { receipts: Object.freeze(receipts), exports: Object.freeze(exports) };
}
