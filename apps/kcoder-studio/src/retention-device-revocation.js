// Private installation facts only. No function in this module grants a public
// client authority or accepts its choice of account/workspace scope.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const DEVICE_REVOCATION_METHOD = 'attachment/retention/deviceRevoked';
export const RETENTION_VERIFIER_ENV = 'KCODER_PRIVATE_RETENTION_VERIFIER_V1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const atom = value => typeof value === 'string' && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 256 && !/\p{Cc}/u.test(value);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const canonicalRevocation = statement => JSON.stringify(['kcoder.retention.device-revocation.v1', statement.version,
  statement.gatewayNamespaceId, statement.deviceId, statement.authorizationGeneration, statement.revocationId, statement.revokedAt]);
const routeBytes = route => JSON.stringify(['kcoder.retention.local-route.v1', route.version, route.targetId, route.targetFingerprint, route.workspacePath, route.workspaceSelection]);
export function validRevocationStatement(statement) {
  return shape(statement, ['version', 'gatewayNamespaceId', 'deviceId', 'authorizationGeneration', 'revocationId', 'revokedAt']) && statement.version === 1 &&
    hex(statement.gatewayNamespaceId) && [statement.deviceId, statement.authorizationGeneration, statement.revocationId].every(atom) && Number.isSafeInteger(statement.revokedAt) && statement.revokedAt >= 0;
}
export function validLocalRetentionRoute(route) {
  return shape(route, ['version', 'routeId', 'targetId', 'targetFingerprint', 'workspacePath', 'workspaceSelection']) && route.version === 1 && hex(route.routeId) &&
    atom(route.targetId) && hex(route.targetFingerprint) && typeof route.workspacePath === 'string' && route.workspacePath.startsWith('/') &&
    Buffer.byteLength(route.workspacePath) <= 4096 && !/\p{Cc}/u.test(route.workspacePath) && (route.workspaceSelection === null || (typeof route.workspaceSelection === 'string' && route.workspaceSelection.startsWith('/') && Buffer.byteLength(route.workspaceSelection) <= 4096 && !/\p{Cc}/u.test(route.workspaceSelection))) && route.routeId === sha(routeBytes(route));
}
export function localRetentionRoute({ targetId, targetFingerprint, workspacePath, workspaceSelection = null }) {
  const route = { version: 1, routeId: '', targetId, targetFingerprint, workspacePath, workspaceSelection };
  route.routeId = sha(routeBytes(route));
  if (!validLocalRetentionRoute(route)) throw new Error('Invalid private retention route');
  return route;
}
export function revocationRequest(statement, route, verifier) {
  if (!validRevocationStatement(statement) || !validLocalRetentionRoute(route) || !hex(verifier.key) || verifier.gatewayNamespaceId !== statement.gatewayNamespaceId)
    throw new Error('Invalid private revocation proof');
  const statementSha256 = sha(canonicalRevocation(statement));
  const signed = JSON.stringify(['kcoder.retention.device-revocation-request.v1', statementSha256, route.routeId,
    route.version, route.targetId, route.targetFingerprint, route.workspacePath, route.workspaceSelection]);
  return { statement, statementSha256, route, authenticator: createHmac('sha256', Buffer.from(verifier.key, 'hex')).update(signed).digest('hex') };
}
export function validRevocationRequest(request, verifier) {
  try {
    if (!shape(request, ['statement', 'statementSha256', 'route', 'authenticator']) || !hex(request.authenticator)) return false;
    const expected = revocationRequest(request.statement, request.route, verifier);
    return request.statementSha256 === expected.statementSha256 && timingSafeEqual(Buffer.from(request.authenticator, 'hex'), Buffer.from(expected.authenticator, 'hex'));
  } catch { return false; }
}
