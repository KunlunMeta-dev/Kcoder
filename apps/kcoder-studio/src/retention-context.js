// Trusted-parent adapter only. No public capability or attachment lifecycle.
import { createHash } from 'node:crypto';

export const PRIVATE_RETENTION_FIELD = 'kcoderPrivateRetention';
export const RETENTION_UPLOAD_METHODS = new Set(['save', 'start', 'read', 'chunk', 'finish', 'cancel']
  .map(phase => `attachment/retention/upload/${phase}`));
export const RETENTION_METHODS = new Set([
  ...RETENTION_UPLOAD_METHODS,
  'attachment/retention/reserve', 'attachment/retention/read',
  'attachment/retention/release', 'attachment/retention/consume',
]);
export const WORKSPACE_RECEIPT_METHODS_V2 = new Set([
  'runtime.workspaces.operation/scopeV2', 'runtime.workspaces.operation/readV2',
  'runtime.workspaces.openV2', 'runtime.workspaces.prepareV2', 'runtime.worktrees.prepareV2',
]);
export class RetentionAuthorityError extends Error {
  constructor(code = -32001) {
    super(code === -32602 ? 'Invalid retention request' : 'Private retention authority unavailable');
    this.code = code;
  }
}
const atom = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function hasReservedRetentionFields(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasReservedRetentionFields);
  return Object.entries(value).some(([key, child]) => key === PRIVATE_RETENTION_FIELD || key === 'trustedContext' || hasReservedRetentionFields(child));
}

// Inspect property-name tokens before JSON.parse's duplicate-key projection
// can hide a reserved field. Values and escaped text are never scanned as keys.
// The caller first validates the bounded frame with JSON.parse.
export function hasRawReservedRetentionFields(raw) {
  raw = typeof raw === 'string' ? raw : raw.toString('utf8');
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== '"') continue;
    const start = index++;
    while (index < raw.length && raw[index] !== '"') {
      if (raw[index] === '\\') index++;
      index++;
    }
    let next = index + 1;
    while (/\s/.test(raw[next] ?? '') && next < raw.length) next++;
    if (raw[next] !== ':') continue;
    const key = JSON.parse(raw.slice(start, index + 1));
    if (key === PRIVATE_RETENTION_FIELD || key === 'trustedContext') return true;
  }
  return false;
}

// Used by the Gateway grant registration itself, not client-supplied metadata.
// Timers, socket revocation and the access-token map remain at the composition root.
export function registerMobileDeviceGrantState({ families, payload, allowedServerIds }) {
  if (![payload.deviceId, payload.authorizationGeneration, payload.retentionNamespaceId].every(atom) ||
      !Number.isSafeInteger(payload.wsLeaseExpiresAt) || !Number.isSafeInteger(payload.expiresAt)) throw new RetentionAuthorityError();
  let family = families.get(payload.deviceId);
  if (!family) {
    family = { sockets: new Set(), timer: null };
    families.set(payload.deviceId, family);
  }
  family.authorizationGeneration = payload.authorizationGeneration;
  family.retentionNamespaceId = payload.retentionNamespaceId;
  family.expiresAt = payload.wsLeaseExpiresAt;
  const session = { expiresAt: payload.wsLeaseExpiresAt, accessExpiresAt: payload.expiresAt,
    deviceId: payload.deviceId, authorizationGeneration: payload.authorizationGeneration,
    stableLoginOwner: payload.stableLoginOwner, allowedServerIds: new Set(allowedServerIds) };
  const { stableLoginOwner, wsLeaseExpiresAt, retentionNamespaceId, ...publicPayload } = payload;
  return { family, session, publicPayload: { ...publicPayload, wsLeaseExpiresAt } };
}

// Normalized stored target fields, never client target JSON or display labels.
export function retentionTargetFingerprint(target, workspacePath, brokerSelection = null) {
  if (!target || !atom(target.id) || target.runtime !== 'kcoder' || !['local', 'ssh'].includes(target.transport)) throw new RetentionAuthorityError();
  const projection = [target.id, target.runtime, target.transport, target.command ?? null,
    target.transport === 'local' ? target.cwd ?? null : target.remoteCwd ?? null,
    target.transport === 'ssh' ? [target.host, target.user ?? null, target.port ?? 22, target.acceptNewHostKey === true] : null,
    target.profile ?? null, target.settingsFile ?? null, target.chromiumBin ?? null,
    target.chromiumNoSandbox === true, target.security?.identity?.mode ?? null,
    workspacePath ?? (target.transport === 'local' ? target.cwd : target.remoteCwd) ?? '<remote-default-cwd>', brokerSelection];
  return createHash('sha256').update(JSON.stringify(['kcoder.retention.target.v1', projection])).digest('hex');
}
export function trustedRetentionContext({ gatewayNamespaceId, deviceId, authorizationGeneration, targetFingerprint, principal }) {
  if (![gatewayNamespaceId, deviceId, authorizationGeneration, targetFingerprint].every(atom)) throw new RetentionAuthorityError();
  if (!principal || (principal.kind !== 'localOs' && (principal.kind !== 'verifiedAccount' || !atom(principal.principalId)))) throw new RetentionAuthorityError();
  return { gatewayNamespaceId, deviceId, authorizationGeneration, targetFingerprint,
    principal: principal.kind === 'localOs' ? { kind: 'localOs' } : { kind: 'verifiedAccount', principalId: principal.principalId } };
}
// JSON.parse already established syntax. Inspect original property tokens so
// duplicate public fields cannot disappear before private reserialization.
export function hasRawDuplicateRetentionFields(raw) {
  raw = typeof raw === 'string' ? raw : raw.toString('utf8');
  const stack = [];
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '{' || char === '[') {
      if (stack.length >= 128) return true;
      stack.push(char === '{' ? new Set() : null);
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = index++;
      while (index < raw.length && raw[index] !== '"') { if (raw[index] === '\\') index++; index++; }
      let next = index + 1;
      while (next < raw.length && /\s/.test(raw[next])) next++;
      if (raw[next] === ':') {
        const key = JSON.parse(raw.slice(start, index + 1));
        const keys = stack.at(-1);
        if (!keys || keys.has(key)) return true;
        keys.add(key);
      }
    }
  }
  return false;
}
function privateEnvelope(authority) {
  const context = trustedRetentionContext(authority);
  if (!atom(authority.workspaceTargetId)) throw new RetentionAuthorityError();
  const account = authority.workspaceAccount;
  if (context.principal.kind === 'verifiedAccount') {
    if (!account || !atom(account.role) || typeof account.authorizationGeneration !== 'string' ||
        !/^(0|[1-9][0-9]{0,19})$/.test(account.authorizationGeneration) ||
        BigInt(account.authorizationGeneration) > 18446744073709551615n) throw new RetentionAuthorityError();
  } else if (account !== undefined) throw new RetentionAuthorityError();
  return { version: 1, context, workspaceTargetId: authority.workspaceTargetId,
    ...(account ? { workspaceAccount: { role: account.role, authorizationGeneration: account.authorizationGeneration } } : {}) };
}
const objectWithKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const operationId = value => {
  if (!atom(value)) return false;
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === 'r1' && atom(parts[1]) &&
    /^[1-9][0-9]{0,19}$/.test(parts[2]) && BigInt(parts[2]) <= 18446744073709551615n &&
    /^[0-9a-fA-F]{32}$/.test(parts[3]);
};
function validAcks(acks, required = false) {
  if (acks === undefined) return !required;
  if (!Array.isArray(acks) || acks.length > 32 || (required && acks.length === 0)) return false;
  const ids = new Set(), receipts = new Set();
  return acks.every(ack => {
    if (!objectWithKeys(ack, ['retentionId', 'terminalRevision', 'clientAckId']) ||
        !operationId(ack.retentionId) || !atom(ack.clientAckId) || !positive(ack.terminalRevision) ||
        ids.has(ack.clientAckId) || receipts.has(ack.retentionId)) return false;
    ids.add(ack.clientAckId); receipts.add(ack.retentionId); return true;
  });
}
export function injectRetentionAuthority(message, authority) {
  if (!RETENTION_METHODS.has(message.method)) return message;
  if (hasReservedRetentionFields(message) || !objectWithKeys(message, ['jsonrpc', 'id', 'method', 'params'])) throw new RetentionAuthorityError(-32602);
  if (!authority || message.jsonrpc !== '2.0' || !(typeof message.id === 'string' || (Number.isSafeInteger(message.id) && message.id >= 0))) throw new RetentionAuthorityError();
  const params = message.params;
  let valid = false;
  if (RETENTION_UPLOAD_METHODS.has(message.method)) {
    valid = validUploadParams(message.method, params);
  } else switch (message.method) {
    case 'attachment/retention/reserve': {
      const ids = new Set();
      valid = objectWithKeys(params, ['clientRequestId', 'threadId', 'stageRefs', 'consumeAcks']) &&
        operationId(params.clientRequestId) && atom(params.threadId) && Array.isArray(params.stageRefs) &&
        params.stageRefs.length > 0 && params.stageRefs.length <= 32 && params.stageRefs.every(stage => {
          if (!objectWithKeys(stage, ['rootNamespace', 'epoch', 'ownerId', 'entryId', 'revision', 'path']) ||
              !atom(stage.rootNamespace) || !atom(stage.ownerId) || !atom(stage.entryId) ||
              !positive(stage.epoch) || !positive(stage.revision) || ids.has(stage.entryId) ||
              (stage.path !== undefined && typeof stage.path !== 'string')) return false;
          ids.add(stage.entryId); return true;
        }) && validAcks(params.consumeAcks);
      break;
    }
    case 'attachment/retention/read':
      valid = objectWithKeys(params, ['selector', 'consumeAcks']) &&
        ((objectWithKeys(params.selector, ['by', 'clientRequestId']) && params.selector.by === 'clientRequestId' && operationId(params.selector.clientRequestId)) ||
         (objectWithKeys(params.selector, ['by', 'retentionId']) && params.selector.by === 'retentionId' && operationId(params.selector.retentionId))) && validAcks(params.consumeAcks);
      break;
    case 'attachment/retention/release':
      valid = objectWithKeys(params, ['retentionId', 'expectedRevision', 'reason', 'consumeAcks']) &&
        operationId(params.retentionId) && positive(params.expectedRevision) && ['discard', 'threadDeleted'].includes(params.reason) && validAcks(params.consumeAcks);
      break;
    case 'attachment/retention/consume':
      valid = objectWithKeys(params, ['acks']) && validAcks(params.acks, true);
      break;
  }
  if (!valid) throw new RetentionAuthorityError(-32602);
  const envelope = privateEnvelope(authority);
  return { ...message, params: { ...params, trustedContext: envelope.context }, [PRIVATE_RETENTION_FIELD]: envelope };
}

export function injectWorkspaceReceiptAuthority(message, authority) {
  if (!WORKSPACE_RECEIPT_METHODS_V2.has(message.method)) return message;
  if (hasReservedRetentionFields(message)) throw new RetentionAuthorityError(-32602);
  if (!authority || message.jsonrpc !== '2.0' ||
      !(typeof message.id === 'string' || (Number.isSafeInteger(message.id) && message.id >= 0))) throw new RetentionAuthorityError();
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params) ||
      Object.hasOwn(message.params, 'deviceId') || Object.hasOwn(message.params, 'workspaceAccount') ||
      Object.hasOwn(message.params, 'workspaceTargetId')) throw new RetentionAuthorityError(-32602);
  return { ...message, [PRIVATE_RETENTION_FIELD]: privateEnvelope(authority) };
}

// All arguments are composition-root callbacks over verified server state.
// Access-token refresh preserves the family; revocation/re-pair never does.
export function captureRetentionAuthority({ session, familyFor, target, currentTarget, brokerSelection, currentBrokerSelection, workspacePath, accountIdentity, accountGeneration, includeWorkspaceAccount = false }) {
  const deviceId = session?.deviceId;
  const generation = session?.authorizationGeneration;
  const family = atom(deviceId) ? familyFor(deviceId) : null;
  if (!family || !atom(generation) || family.authorizationGeneration !== generation || !atom(family.retentionNamespaceId)) return () => null;
  const fingerprint = retentionTargetFingerprint(target, workspacePath, brokerSelection);
  const namespace = family.retentionNamespaceId;
  const principal = target.security ? accountIdentity?.() : null;
  const loginGeneration = target.security ? accountGeneration?.() : null;
  if (target.security && (!principal || !atom(principal.principalId))) return () => null;
  return () => {
    try {
      const liveFamily = familyFor(deviceId);
      const liveTarget = currentTarget();
      if (liveFamily !== family || liveFamily.authorizationGeneration !== generation || liveFamily.retentionNamespaceId !== namespace ||
          liveFamily.expiresAt <= Date.now() || !liveTarget || currentBrokerSelection() !== brokerSelection ||
          retentionTargetFingerprint(liveTarget, workspacePath, brokerSelection) !== fingerprint) return null;
      if (target.security) {
        const livePrincipal = accountIdentity?.();
        if (!livePrincipal || livePrincipal.principalId !== principal.principalId || livePrincipal.role !== principal.role || accountGeneration?.() !== loginGeneration) return null;
      }
      const context = trustedRetentionContext({ gatewayNamespaceId: namespace, deviceId, authorizationGeneration: generation,
        targetFingerprint: fingerprint, principal: principal ? { kind: 'verifiedAccount', principalId: principal.principalId } : { kind: 'localOs' } });
      if (!includeWorkspaceAccount) return context;
      if (principal && (!atom(principal.role) || !Number.isSafeInteger(loginGeneration) || loginGeneration < 0)) return null;
      return { ...context, workspaceTargetId: target.id,
        ...(principal ? { workspaceAccount: { role: principal.role, authorizationGeneration: String(loginGeneration) } } : {}) };
    } catch { return null; }
  };
}


function generationId(value, prefix) {
  if (!atom(value)) return false;
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === prefix && /^[A-Za-z0-9_-]+$/.test(parts[1])
    && /^[1-9][0-9]{0,19}$/.test(parts[2]) && BigInt(parts[2]) <= 18446744073709551615n
    && /^[0-9a-fA-F]{32}$/.test(parts[3]);
}
function validUploadParams(method, params) {
  const phase = method.slice('attachment/retention/upload/'.length);
  const start = phase === 'start' || phase === 'save', chunk = phase === 'chunk';
  const allowed = ['ownerRequest', 'clientUploadId', ...(start ? ['filename', 'size', 'contentSha256'] : []),
    ...(chunk ? ['offset', 'length', 'chunkSha256'] : []), ...(chunk || phase === 'save' ? ['contentBase64'] : [])];
  if (!objectWithKeys(params, allowed) || !generationId(params.clientUploadId, 'u1')
    || !objectWithKeys(params.ownerRequest, ['clientOwnerRequestId', 'immutableParameters'])
    || !generationId(params.ownerRequest.clientOwnerRequestId, 'o1')) return false;
  const immutable = params.ownerRequest.immutableParameters;
  if (!immutable || typeof immutable !== 'object' || Array.isArray(immutable)
    || Object.keys(immutable).length > 32 || Object.entries(immutable).some(([key, value]) => !atom(key) || !atom(value))
    || Buffer.byteLength(JSON.stringify(params.ownerRequest)) > 16384) return false;
  const sha = value => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
  if (start && (!atom(params.filename) || !Number.isSafeInteger(params.size) || params.size < 0
    || params.size > 100 * 1024 * 1024 || !sha(params.contentSha256))) return false;
  if (chunk && (!Number.isSafeInteger(params.offset) || params.offset < 0 || !positive(params.length)
    || params.length > 512 * 1024 || !sha(params.chunkSha256))) return false;
  if (phase === 'save' && params.size > 256 * 1024) return false;
  if ((chunk || phase === 'save') && (typeof params.contentBase64 !== 'string'
    || params.contentBase64.length > Math.ceil(512 * 1024 / 3) * 4)) return false;
  return true;
}
