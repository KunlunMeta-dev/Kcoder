import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const CHUNK_BYTES = 512 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const safeErrors = new WeakSet();

function failure(code, recovery = 'none') {
  const error = new Error(code);
  error.code = code;
  error.recovery = recovery;
  safeErrors.add(error);
  return error;
}
function owner(scope) {
  return {
    accountId: scope.accountId, targetId: scope.targetId, workspaceId: scope.workspaceId,
    ...(typeof scope.organizationId === 'string' ? { organizationId: scope.organizationId } : {})
  };
}
function same(left, right) { return isDeepStrictEqual(left, right); }
function validateReference(reference) {
  if (!reference || reference.kind !== 'office_input' || typeof reference.inputId !== 'string'
    || reference.inputId.length > 256 || reference.revision !== 1) throw failure('OFFICE_INVALID_INPUT_REFERENCE');
}
function metadata(request) {
  if (!request || typeof request.operationId !== 'string' || !request.operationId || request.operationId.length > 256
    || typeof request.filename !== 'string' || !request.filename || request.filename.length > 200
    || /[\\/:*?"<>|\u0000-\u001f]/u.test(request.filename) || ['.', '..'].includes(request.filename)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(request.filename)
    || !request.byteStream?.[Symbol.asyncIterator] || !Number.isSafeInteger(request.expectedBytes)
    || request.expectedBytes < 0 || request.expectedBytes > MAX_BYTES
    || typeof request.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(request.expectedSha256)
    || typeof request.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(request.mediaType)) {
    throw failure('OFFICE_INVALID_INPUT');
  }
  return { filename: request.filename, mediaType: request.mediaType, expectedBytes: request.expectedBytes, expectedSha256: request.expectedSha256.toLowerCase() };
}
function publicReceipt(record) {
  return {
    kind: 'office_input', inputId: record.inputId, revision: 1, operationId: record.operationId,
    owner: owner(record.owner), filename: record.metadata.filename, mediaType: record.metadata.mediaType,
    bytes: record.bytes ?? null, sha256: record.sha256 ?? null, status: record.status
  };
}

/**
 * Construct only in the authenticated host. Context/receipts are trusted,
 * owner-scoped providers; JSON scope never authenticates a request.
 * No default memory repository or permissive policy exists.
 */
export function createOfficeAssetBridge({ getHostContext, evaluateAction, receipts, exports: exportProvider }) {
  if (typeof getHostContext !== 'function' || typeof evaluateAction !== 'function'
    || !receipts?.beginInput || !receipts?.readInput || !receipts?.completeInput || !receipts?.failInput) {
    throw failure('OFFICE_HOST_PROVIDER_REQUIRED');
  }
  async function authorize(scope, action, resources) {
    const context = await getHostContext();
    if (!context?.scope || !context?.nativeClient?.call || typeof context.nativeConnectionId !== 'string'
      || !same(context.scope, scope)) throw failure('OFFICE_SCOPE_CHANGED', 'request_authorization');
    const reply = await evaluateAction({ scope, action, resources });
    if (reply?.status !== 'completed' || reply?.result?.decision !== 'allow') {
      throw failure(reply?.result?.decision === 'deny' ? 'OFFICE_ACCESS_DENIED' : 'OFFICE_AUTHORIZATION_UNCONFIRMED', 'request_authorization');
    }
    return context;
  }
  async function stillCurrent(context, scope) {
    const next = await getHostContext();
    if (!same(next?.scope, scope) || next?.nativeConnectionId !== context.nativeConnectionId) {
      throw failure('OFFICE_SCOPE_CHANGED', 'request_authorization');
    }
  }
  async function prepareChannelInput(request) {
    const material = metadata(request);
    const context = await authorize(request.scope, 'office.input.prepare', []);
    const own = owner(request.scope);
    const intent = hash(JSON.stringify({ owner: own, operationId: request.operationId, metadata: material }));
    const inputId = 'oi_' + hash(JSON.stringify({ owner: own, operationId: request.operationId }));
    const begun = await receipts.beginInput({ inputId, operationId: request.operationId, owner: own, intent, metadata: material });
    if (begun.existing) {
      if (begun.record.intent !== intent) throw failure('OFFICE_OPERATION_CONFLICT');
      if (begun.record.status === 'accepted') { await stillCurrent(context, request.scope); return publicReceipt(begun.record); }
      throw failure('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original');
    }
    let uploadId;
    let started = false;
    const digest = createHash('sha256');
    let received = 0;
    let index = 0;
    try {
      if (request.signal?.aborted) throw failure('OFFICE_CANCELLED');
      await stillCurrent(context, request.scope);
      started = true;
      const start = await context.nativeClient.call('attachment/upload/start', {
        filename: material.filename, size: material.expectedBytes
      }, { signal: request.signal });
      if (typeof start?.upload_id !== 'string') throw failure('OFFICE_NATIVE_RECEIPT_INVALID', 'reconcile_original');
      uploadId = start.upload_id;
      for await (const chunk of request.byteStream) {
        if (!(chunk instanceof Uint8Array)) throw failure('OFFICE_INVALID_BYTES');
        received += chunk.byteLength;
        if (received > material.expectedBytes) throw failure('OFFICE_INPUT_SIZE_MISMATCH');
        digest.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
          if (request.signal?.aborted) throw failure('OFFICE_CANCELLED');
          await stillCurrent(context, request.scope);
          await context.nativeClient.call('attachment/upload/chunk', {
            upload_id: uploadId, index,
            content_base64: Buffer.from(chunk.subarray(offset, offset + CHUNK_BYTES)).toString('base64')
          }, { signal: request.signal });
          index += 1;
        }
      }
      if (received !== material.expectedBytes) throw failure('OFFICE_INPUT_SIZE_MISMATCH');
      const actualSha256 = digest.digest('hex');
      if (actualSha256 !== material.expectedSha256) throw failure('OFFICE_INPUT_HASH_MISMATCH');
      if (request.signal?.aborted) throw failure('OFFICE_CANCELLED');
      await stillCurrent(context, request.scope);
      const native = await context.nativeClient.call('attachment/upload/finish', { upload_id: uploadId }, { signal: request.signal });
      if (typeof native?.path !== 'string' || !native.path) throw failure('OFFICE_NATIVE_RECEIPT_INVALID', 'reconcile_original');
      await stillCurrent(context, request.scope);
      const record = {
        inputId, operationId: request.operationId, owner: own, intent, metadata: material,
        bytes: received, sha256: actualSha256, status: 'accepted',
        native: { path: native.path, stageRef: native.stageRef ?? null, connectionId: context.nativeConnectionId }
      };
      await receipts.completeInput(record);
      await stillCurrent(context, request.scope);
      return publicReceipt(record);
    } catch (error) {
      let cleanup = 'not_started';
      if (uploadId) {
        try {
          await context.nativeClient.call('attachment/upload/cancel', { upload_id: uploadId });
          cleanup = 'cancel_observed';
        } catch { cleanup = 'unconfirmed'; }
      }
      await receipts.failInput({
        inputId, operationId: request.operationId, owner: own, intent, metadata: material,
        status: started ? 'unknown' : 'rejected', cleanup,
        code: safeErrors.has(error) ? error.code : 'OFFICE_INPUT_UNCONFIRMED'
      });
      throw safeErrors.has(error) ? error : failure('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original');
    }
  }
  async function readInputReceipt({ scope, inputId, revision = 1 }) {
    validateReference({ kind: 'office_input', inputId, revision });
    await authorize(scope, 'office.input.read', [inputId]);
    const record = await receipts.readInput({ inputId, owner: owner(scope) });
    if (!record || !same(owner(record.owner), owner(scope))) throw failure('OFFICE_INPUT_NOT_FOUND');
    return publicReceipt(record);
  }
  async function resolveInput(scope, reference) {
    validateReference(reference);
    const context = await authorize(scope, 'office.input.consume', [reference.inputId]);
    const record = await receipts.readInput({ inputId: reference.inputId, owner: owner(scope) });
    if (!record || record.status !== 'accepted' || !same(owner(record.owner), owner(scope))
      || record.native?.connectionId !== context.nativeConnectionId || !record.native.path) {
      throw failure('OFFICE_INPUT_REQUIRES_RECOVERY', 'reconcile_original');
    }
    await stillCurrent(context, scope);
    return {
      path: record.native.path, stageRef: record.native.stageRef,
      filename: record.metadata.filename, mediaType: record.metadata.mediaType,
      bytes: record.bytes, sha256: record.sha256, inputId: record.inputId, revision: 1
    };
  }
  async function readExport(request) {
    const context = await authorize(request.scope, 'office.artifact.export', [request.artifactRef, ...(request.destination ? [request.destination] : [])]);
    if (!exportProvider?.readExport) throw failure('OFFICE_EXPORT_PROVIDER_UNAVAILABLE', 'repair_configuration');
    // Export provider rechecks the native owner, immutable revision and purpose.
    const source = await exportProvider.readExport(request);
    if (!source || typeof source.filename !== 'string' || !source.filename || source.filename.length > 200
      || /[\\/:*?"<>|\u0000-\u001f]/u.test(source.filename) || typeof source.mediaType !== 'string'
      || !Number.isSafeInteger(source.expectedBytes) || source.expectedBytes < 0 || source.expectedBytes > MAX_BYTES
      || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)
      || !source.byteStream?.[Symbol.asyncIterator]) throw failure('OFFICE_EXPORT_RECEIPT_INVALID');
    const verified = async function* () {
      const digest = createHash('sha256'); let bytes = 0;
      try {
      for await (const chunk of source.byteStream) {
        if (request.signal?.aborted) throw failure('OFFICE_CANCELLED');
        await stillCurrent(context, request.scope);
        await authorize(request.scope, 'office.artifact.export', [request.artifactRef, ...(request.destination ? [request.destination] : [])]);
        if (!(chunk instanceof Uint8Array)) throw failure('OFFICE_INVALID_BYTES');
        bytes += chunk.byteLength;
        if (bytes > source.expectedBytes) throw failure('OFFICE_EXPORT_SIZE_MISMATCH');
        digest.update(chunk); yield chunk;
      }
      if (bytes !== source.expectedBytes || digest.digest('hex') !== source.sha256.toLowerCase()) throw failure('OFFICE_EXPORT_HASH_MISMATCH');
      await stillCurrent(context, request.scope);
      } catch (error) { throw safeErrors.has(error) ? error : failure('OFFICE_EXPORT_UNCONFIRMED', 'reconcile_original'); }
    };
    return { filename: source.filename, mediaType: source.mediaType, expectedBytes: source.expectedBytes,
      sha256: source.sha256.toLowerCase(), byteStream: verified() };
  }
  const protect = fn => async (...args) => {
    try { return await fn(...args); } catch (error) {
      throw safeErrors.has(error) ? error : failure('OFFICE_HOST_UNCONFIRMED', 'reconcile_original');
    }
  };
  return {
    channel: Object.freeze({ prepareChannelInput: protect(prepareChannelInput), readExport: protect(readExport) }),
    assets: Object.freeze({ readInputReceipt: protect(readInputReceipt) }),
    runtime: Object.freeze({ resolveInput: protect(resolveInput) })
  };
}
