import { requireValue, publicError } from '../errors.mjs';
import { identifier, scopeKey, privatePayload } from '../validation.mjs';

export const CONTRACT_VERSION = 'parallel-v1';
export const PORTS = Object.freeze({
  'P-CONNECTION': ['listConnections', 'readConnection', 'resolveCapability', 'readResourceGrant', 'prepareConnectionAction'],
  'P-READINESS': ['inspectReadiness', 'readReadiness', 'verifyCapability'],
});
export const MUTATIONS = new Set(['prepareConnectionAction', 'verifyCapability']);
export function validateRequest(request, method) {
  requireValue(request && request.contractVersion === CONTRACT_VERSION, 'CONTRACT_UNSUPPORTED', 'repair_configuration');
  requireValue(Object.keys(request).every(key => ['contractVersion','requestId','scope','operationId','expectedRevision','timeoutMs','cancellationRef','payload'].includes(key)), 'INVALID_REQUEST_FIELD');
  identifier(request.requestId, 'request');
  scopeKey(request.scope);
  requireValue(Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 60000, 'INVALID_TIMEOUT');
  if (MUTATIONS.has(method)) identifier(request.operationId, 'operation');
  if (request.operationId != null) identifier(request.operationId, 'operation');
  if (request.expectedRevision != null) identifier(request.expectedRevision, 'revision');
  if (request.cancellationRef != null) identifier(request.cancellationRef, 'cancellation');
  requireValue(request.payload && !Array.isArray(request.payload) && typeof request.payload === 'object', 'INVALID_PAYLOAD');
  privatePayload(request.payload);
}
export function reply(request, status, result = null, error = null, revision = null) {
  requireValue(['accepted', 'completed', 'rejected', 'unknown', 'unavailable'].includes(status), 'INVALID_STATUS');
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: request.requestId,
    status,
    operationId: request.operationId ?? null,
    entityRevision: revision === null ? null : String(revision),
    observedAt: new Date().toISOString(),
    result,
    error,
  };
}
export function rejected(request, error) {
  const pub = publicError(error);
  return reply(request, pub.recovery === 'reconcile_original' ? 'unknown' : pub.code.endsWith('_UNAVAILABLE')?'unavailable':'rejected', null, pub);
}
