import { createHash, createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { agentMessageId, validAgentMessageAddress, validAgentMessageReceipt, validAgentTurnId } from '../shared/agentMessageMethods.mjs';

export const ROUTER_PREFIX = 'agentMessage/router/';
export const ROUTER_CAPABILITY = 'agentMessageRouterPrivateV1';
export const BACKGROUND_REPLY_CAPABILITY = 'agentMessageBackgroundReplyV1';
export const WAKE_READ_CAPABILITY = 'agentMessageWakeReadV1';
export const ROUTER_PRIVATE_FIELD = 'kcoderPrivateAgentMessageRoute';
export const ROUTER_PURPOSE = 'kcoder.peer-message.route.v1';
export const ROUTER_METHODS = Object.freeze(Object.fromEntries([
  'identity', 'capabilities', 'sourceList', 'queryOriginalDetails', 'sourcePrepare', 'sourceRead', 'sourceFind', 'sourceMarkDispatch',
  'sourceRecordReceipt', 'sourceCheckOriginal', 'sourceCheckReplyAttempt', 'sourceCheckWakeRead', 'sourceWakeReadTarget', 'targets', 'acceptForwarded', 'queryOriginal', 'read',
].map(name => [name, ROUTER_PREFIX + name])));
const methods = new Set(Object.values(ROUTER_METHODS));
const proofs = new WeakSet();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const octets = (value, count) => Array.isArray(value) && value.length === count && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255);
export class AgentMessageRouterError extends Error {
  constructor(reason = 'AGENT_MESSAGES_OUTCOME_UNKNOWN', code = -32034) {
    super(reason); this.name = 'AgentMessageRouterError'; this.code = code;
  }
}
export function requireRouter(value, reason = 'AGENT_MESSAGES_INVALID_NATIVE_RESPONSE') {
  if (!value) throw new AgentMessageRouterError(reason);
}
export const sameAddress = (a, b) => validAgentMessageAddress(a) && validAgentMessageAddress(b) &&
  a.targetId === b.targetId && a.workspaceId === b.workspaceId && a.threadId === b.threadId;
export const identityContains = (identity, address) => validAgentMessageAddress(address) &&
  identity.targetId === address.targetId && identity.workspaceId === address.workspaceId;
export function routerIdentity(value) {
  requireRouter(keys(value, ['targetId', 'workspaceId', 'principal', 'publicKey', 'identityEpoch']) &&
    [value.targetId, value.workspaceId, value.identityEpoch].every(agentMessageId) && octets(value.publicKey, 32));
  const p = value.principal;
  requireRouter(keys(p, ['kind'], p?.kind === 'verifiedAccount' ? ['principalId'] : []) &&
    (p.kind === 'localOs' || p.kind === 'verifiedAccount' && typeof p.principalId === 'string' &&
      Buffer.byteLength(p.principalId) > 0 && Buffer.byteLength(p.principalId) <= 256 && !/[\p{Cc}]/u.test(p.principalId)));
  return Object.freeze({ ...value, publicKey: Object.freeze([...value.publicKey]), principal: Object.freeze({ ...p }) });
}
export function routeProof(source, destination, authorizationId) {
  requireRouter(agentMessageId(authorizationId), 'AGENT_MESSAGES_AUTHORIZATION_CHANGED');
  const proof = Object.freeze({ version: 1, purpose: ROUTER_PURPOSE, authorizationId,
    source: routerIdentity(source), destination: routerIdentity(destination) });
  proofs.add(proof);
  return proof;
}
export function privateRouterFrame(message, proof) {
  requireRouter(methods.has(message.method), 'AGENT_MESSAGES_PRIVATE_METHOD_UNAVAILABLE');
  if ([ROUTER_METHODS.identity, ROUTER_METHODS.capabilities].includes(message.method)) {
    requireRouter(proof === undefined, 'AGENT_MESSAGES_UNEXPECTED_PRIVATE_PROOF');
    return message;
  }
  requireRouter(proofs.has(proof), 'AGENT_MESSAGES_PRIVATE_AUTHORITY_REQUIRED');
  return { ...message, [ROUTER_PRIVATE_FIELD]: proof };
}
/** Inspect property tokens before JSON.parse discards duplicate/escaped keys. */
export function hasRawPrivateRouterField(raw) {
  raw = typeof raw === 'string' ? raw : raw.toString('utf8');
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== '"') continue;
    const start = index++;
    while (index < raw.length && raw[index] !== '"') { if (raw[index] === '\\') index++; index++; }
    let next = index + 1;
    while (next < raw.length && /\s/.test(raw[next])) next++;
    if (raw[next] === ':' && JSON.parse(raw.slice(start, index + 1)) === ROUTER_PRIVATE_FIELD) return true;
  }
  return false;
}
export function routerOperationId(sourceAddress, clientMessageId) {
  requireRouter(validAgentMessageAddress(sourceAddress) && agentMessageId(clientMessageId), 'AGENT_MESSAGES_INVALID_REQUEST');
  return createHash('sha256').update(JSON.stringify(['kcoder.peer-message.router-operation.v1',
    sourceAddress.targetId, sourceAddress.workspaceId, sourceAddress.threadId, clientMessageId])).digest('hex');
}
export const messageBodySha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const address = value => ({ targetId: value.targetId, workspaceId: value.workspaceId, threadId: value.threadId });
/** Reconstruct the Rust struct serialization order, never arbitrary JSON property order. */
export function attestationSigningBytes(claims) {
  return Buffer.concat([Buffer.from('kcoder.peer-message.attestation.v1\0'), Buffer.from(JSON.stringify({
    version: claims.version, purpose: claims.purpose, operationId: claims.operationId,
    sourceAddress: address(claims.sourceAddress), destination: address(claims.destination),
    sourceIdentityEpoch: claims.sourceIdentityEpoch, clientMessageId: claims.clientMessageId, mode: claims.mode,
    ...(claims.expectedTurnId == null ? {} : { expectedTurnId: claims.expectedTurnId }), bodySha256: claims.bodySha256,
    ...(claims.replyToMessageId == null ? {} : { replyToMessageId: claims.replyToMessageId }),
  }))]);
}
export function requireRouterOperation(value, sourceIdentity, sourceAddress) {
  const optional = ['receipt'];
  requireRouter(keys(value, ['operationId', 'sourceAddress', 'destination', 'bodySha256', 'stage', 'attestation'], optional) &&
    agentMessageId(value.operationId) && sameAddress(value.sourceAddress, sourceAddress) &&
    identityContains(sourceIdentity, value.sourceAddress) && validAgentMessageAddress(value.destination) &&
    !sameAddress(value.sourceAddress, value.destination) && /^[a-f0-9]{64}$/.test(value.bodySha256) &&
    ['prepared', 'dispatching', 'receipted'].includes(value.stage));
  const attestation = value.attestation;
  requireRouter(keys(attestation, ['claims', 'signature']) && octets(attestation.signature, 64));
  const c = attestation.claims;
  requireRouter(keys(c, ['version', 'purpose', 'operationId', 'sourceAddress', 'destination', 'sourceIdentityEpoch',
    'clientMessageId', 'mode', 'bodySha256'], ['expectedTurnId', 'replyToMessageId']) && c.version === 1 && c.purpose === ROUTER_PURPOSE &&
    c.operationId === value.operationId && sameAddress(c.sourceAddress, value.sourceAddress) &&
    sameAddress(c.destination, value.destination) && c.bodySha256 === value.bodySha256 &&
    c.sourceIdentityEpoch === sourceIdentity.identityEpoch && agentMessageId(c.clientMessageId) &&
    ['enqueue_only', 'wake_if_idle'].includes(c.mode) &&
    (c.expectedTurnId == null || validAgentTurnId(c.expectedTurnId) && c.mode === 'enqueue_only') &&
    (c.replyToMessageId == null || agentMessageId(c.replyToMessageId)) &&
    routerOperationId(sourceAddress, c.clientMessageId) === value.operationId);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(sourceIdentity.publicKey)]),
    format: 'der', type: 'spki' });
  requireRouter(verify(null, attestationSigningBytes(c), key, Buffer.from(attestation.signature)), 'AGENT_MESSAGES_ATTESTATION_INVALID');
  if (value.receipt != null) requireRouterReceipt(value.receipt, value);
  requireRouter(value.stage !== 'receipted' || value.receipt != null);
  return value;
}
export function requireRouterReceipt(receipt, operation) {
  requireRouter(validAgentMessageReceipt(receipt) && receipt.clientMessageId === operation.attestation.claims.clientMessageId &&
    receipt.targetThreadId === operation.destination.threadId &&
    (receipt.replyToMessageId ?? null) === (operation.attestation.claims.replyToMessageId ?? null) && sameAddress(receipt.sourceAddress, operation.sourceAddress) &&
    sameAddress(receipt.targetAddress, operation.destination), 'AGENT_MESSAGES_RECEIPT_MISMATCH');
  return receipt;
}
export function requireSameOperation(previous, next) {
  requireRouter(isDeepStrictEqual(previous.attestation, next.attestation) &&
    sameAddress(previous.sourceAddress, next.sourceAddress) && sameAddress(previous.destination, next.destination) &&
    previous.operationId === next.operationId && previous.bodySha256 === next.bodySha256,
  'AGENT_MESSAGES_OPERATION_CONFLICT');
  const rank = { prepared: 0, dispatching: 1, receipted: 2 };
  requireRouter(rank[next.stage] >= rank[previous.stage], 'AGENT_MESSAGES_OPERATION_REGRESSED');
  if (previous.receipt) requireRouter(next.receipt && next.receipt.messageId === previous.receipt.messageId &&
    next.receipt.revision >= previous.receipt.revision &&
    (next.receipt.revision !== previous.receipt.revision || isDeepStrictEqual(next.receipt, previous.receipt)) &&
    (!['applied', 'rejected', 'expired'].includes(previous.receipt.status) || next.receipt.status === previous.receipt.status),
  'AGENT_MESSAGES_RECEIPT_REGRESSED');
  return next;
}
