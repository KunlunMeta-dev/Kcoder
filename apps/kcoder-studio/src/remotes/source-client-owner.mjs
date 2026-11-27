import { isDeepStrictEqual } from 'node:util';
import { workspaceCwdObservationTargetIdentity } from '../workspace-cwd-observation.js';
import { identityContains, requireRouterOperation, routerIdentity, sameAddress } from '../agent-message-router-private.js';
import { requireOriginalOperationDeviceOwner } from '../gateway-device-lifecycle.js';

const owned = new WeakSet();
const peerOperationOwners = new WeakSet();
const fail = () => { throw new Error('REMOTE_HOST_SOURCE_CLIENT_CHANGED'); };
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

/** Captured only by the existing authenticated WebSocket attachment. The
 * callbacks re-use current Gateway authentication and target/account stores;
 * a Native request carries locators, never this captured client capability.
 */
export function captureNativeRemoteSourceClient({ client, broker, sourceTarget,
  authorizationOwner, session, verifySession, getTarget, targetSignature,
  accountIdentity, accountGeneration, originalDeviceOwner }) {
  if (!client || !broker || !sourceTarget || !session || !authorizationOwner ||
      typeof verifySession !== 'function' || typeof getTarget !== 'function' ||
      typeof targetSignature !== 'function' || typeof accountIdentity !== 'function' ||
      typeof accountGeneration !== 'function') fail();
  const sourceId = sourceTarget.id;
  const signature = targetSignature(sourceTarget);
  const generation = accountGeneration(authorizationOwner, sourceId);
  const principal = accountIdentity(authorizationOwner, sourceId)?.principalId ?? null;
  if (session.deviceId) originalDeviceOwner = requireOriginalOperationDeviceOwner(originalDeviceOwner);
  else if (originalDeviceOwner !== undefined) fail();
  const allowed = id => originalDeviceOwner ? originalDeviceOwner.isTargetAllowed(id) : session.allowedServerIds?.has(id);
  const verify = () => {
    const target = getTarget(sourceId);
    if (broker.closed || !client.initialized || !broker.clients.has(client) ||
        client.authorizationOwner !== authorizationOwner || !verifySession() ||
        !allowed(sourceId) || !target ||
        targetSignature(target) !== signature ||
        accountGeneration(authorizationOwner, sourceId) !== generation ||
        (accountIdentity(authorizationOwner, sourceId)?.principalId ?? null) !== principal) fail();
    if (target.security && principal === null) fail();
  };
  const capability = Object.freeze({
    verify,
    currentAllowedServerIds() { verify(); return originalDeviceOwner ? originalDeviceOwner.currentAllowedServerIds() : new Set(session.allowedServerIds); },
    async checkCurrentAuthority() {
      verify();
      if (originalDeviceOwner) await originalDeviceOwner.checkCurrent();
      verify();
    },
    async capturePeerOperationOwner({ operation, sourceIdentity, destinationIdentity, destinationServerId,
      sourceWorkspacePath, destinationWorkspacePath }) {
      verify();
      sourceIdentity = routerIdentity(sourceIdentity); destinationIdentity = routerIdentity(destinationIdentity);
      requireRouterOperation(operation, sourceIdentity, operation.sourceAddress);
      if (!identityContains(destinationIdentity, operation.destination) || !allowed(destinationServerId) ||
          [sourceWorkspacePath, destinationWorkspacePath].some(path => typeof path !== 'string' || !path ||
            Buffer.byteLength(path) > 32768 || /[\p{Cc}]/u.test(path))) fail();
      const destination = getTarget(destinationServerId);
      if (!destination || destination.runtime !== 'kcoder') fail();
      const destinationSignature = targetSignature(destination);
      const destinationGeneration = accountGeneration(authorizationOwner, destinationServerId);
      const destinationPrincipal = accountIdentity(authorizationOwner, destinationServerId)?.principalId ?? null;
      const matchesPrincipal = (target, identity, currentPrincipal) => target.security ?
        currentPrincipal !== null && identity.principal.kind === 'verifiedAccount' && identity.principal.principalId === currentPrincipal :
        identity.principal.kind === 'localOs';
      if (!matchesPrincipal(sourceTarget, sourceIdentity, principal) || !matchesPrincipal(destination, destinationIdentity, destinationPrincipal)) fail();
      // A fixed accepted operation has a different lifetime from its socket or
      // model turn. Retain the actual authentication session and live stores,
      // never an allow boolean or a deserialized identity claim.
      const verifyOperationOwner = () => {
        const currentSource = getTarget(sourceId), currentDestination = getTarget(destinationServerId);
        if (originalDeviceOwner) originalDeviceOwner.verifyScopeFacts();
        const allowed = id => originalDeviceOwner ? originalDeviceOwner.isTargetAllowed(id) : session.allowedServerIds?.has(id);
        if ((!originalDeviceOwner && verifySession() !== true) || !allowed(sourceId) || !allowed(destinationServerId) ||
            !currentSource || !currentDestination || targetSignature(currentSource) !== signature ||
            targetSignature(currentDestination) !== destinationSignature ||
            accountGeneration(authorizationOwner, sourceId) !== generation ||
            accountGeneration(authorizationOwner, destinationServerId) !== destinationGeneration ||
            (accountIdentity(authorizationOwner, sourceId)?.principalId ?? null) !== principal ||
            (accountIdentity(authorizationOwner, destinationServerId)?.principalId ?? null) !== destinationPrincipal) fail();
      };
      const checkCurrentAuthority = async () => {
        verifyOperationOwner();
        if (originalDeviceOwner) await originalDeviceOwner.checkCurrent();
        verifyOperationOwner();
      };
      await checkCurrentAuthority();
      // Capturing a new fixed scope still requires this live Source. Only the
      // already captured operation survives a later transport/turn ending.
      verify();
      verifyOperationOwner();
      const result = freeze({ operation: structuredClone(operation), authorizationOwner, sourceIdentity, destinationIdentity,
        source: { serverId: sourceId, workspacePath: sourceWorkspacePath, signature },
        destination: { serverId: destinationServerId, workspacePath: destinationWorkspacePath, signature: destinationSignature },
        verify: verifyOperationOwner, checkCurrentAuthority });
      peerOperationOwners.add(result);
      return result;
    },
    async withAuthorizedTarget(reference, consume) {
      verify();
      if (!reference || typeof reference.targetId !== 'string' ||
          typeof reference.targetRevision !== 'string' || typeof consume !== 'function' ||
          !allowed(reference.targetId)) fail();
      const target = getTarget(reference.targetId);
      if (!target || target.runtime !== 'kcoder' || target.transport !== 'ssh' ||
          workspaceCwdObservationTargetIdentity(targetSignature(target)) !== reference.targetRevision) fail();
      const targetGeneration = accountGeneration(authorizationOwner, target.id);
      const targetPrincipal = accountIdentity(authorizationOwner, target.id)?.principalId ?? null;
      if (target.security && targetPrincipal === null) fail();
      const check = () => {
        verify();
        const current = getTarget(reference.targetId);
        if (!allowed(reference.targetId) || !current ||
            workspaceCwdObservationTargetIdentity(targetSignature(current)) !== reference.targetRevision ||
            accountGeneration(authorizationOwner, target.id) !== targetGeneration ||
            (accountIdentity(authorizationOwner, target.id)?.principalId ?? null) !== targetPrincipal) fail();
      };
      // Only the actual transport factory receives this target configuration.
      // Image, host key and platform checks remain separate required proofs.
      const result = await consume({ target, authorizationOwner, verify: check });
      check();
      return result;
    },
  });
  owned.add(capability);
  return capability;
}

export function requireCapturedNativeRemoteSourceClient(value) {
  if (!owned.has(value)) fail();
  value.verify();
  return value;
}

/** Check the captured brand and synchronous scope facts only. A consumer must
 * await checkCurrentAuthority() before/after external work; this function is
 * never a durable-device authorization verdict or a new-send capability.
 */
export function requireCapturedPeerOperationOwner(value) {
  if (!peerOperationOwners.has(value)) fail();
  value.verify();
  return value;
}

/** A reciprocal operation remains bound to the same live account and the original two sessions. */
export async function capturePeerReplyOperationOwner(original, operation, originalMessageId) {
  original = requireCapturedPeerOperationOwner(original);
  await original.checkCurrentAuthority();
  requireCapturedPeerOperationOwner(original);
  requireRouterOperation(operation, original.destinationIdentity, original.operation.destination);
  if (!sameAddress(operation.destination, original.operation.sourceAddress) ||
      operation.attestation.claims.replyToMessageId !== originalMessageId) fail();
  // The original callbacks already recheck both live target/account scopes.
  // Reuse them directly so each reply does not retain and recheck every ancestor.
  const reply = freeze({ operation: structuredClone(operation), authorizationOwner: original.authorizationOwner,
    sourceIdentity: original.destinationIdentity, destinationIdentity: original.sourceIdentity,
    source: original.destination, destination: original.source,
    verify: original.verify, checkCurrentAuthority: original.checkCurrentAuthority });
  peerOperationOwners.add(reply);
  return reply;
}

/** Only an actual Native child request may reach this resolver. An active
 * broker turn selects its already authenticated socket owner; the supplied
 * identity still needs Source's original Accepted/budget proof independently.
 */
export function nativeRemoteSourceClientForAttempt(broker, attempt) {
  if (!broker || broker.closed || !attempt ||
      ['threadId', 'turnId', 'attemptId'].some(key => typeof attempt[key] !== 'string' ||
        !attempt[key] || attempt[key].length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(attempt[key]))) fail();
  const active = broker.activeTurns?.get(attempt.threadId);
  if (active?.turnId !== attempt.turnId) fail();
  // A new transcript viewer is not the original active turn's authority.
  // A disconnected captured owner must not fall back to that newer viewer.
  const client = Object.hasOwn(active, 'owner') ? active.owner : broker.ownerFor({ params: { threadId: attempt.threadId } });
  if (!client || !broker.clients.has(client)) fail();
  return requireCapturedNativeRemoteSourceClient(client.nativeRemoteSourceOwner);
}

/** A read request owns its current management lane independently of any turn.
 * Exact pending object identity is retained across every await; a completed or
 * replaced request cannot become a new authenticated reader.
 */
export function nativeRemoteSourceClientForManagement(broker, reference) {
  const pending = broker?.pending?.get(reference?.managementRpcId);
  const original = reference?.original;
  const client = pending?.client;
  const owner = requireCapturedNativeRemoteSourceClient(client?.nativeRemoteSourceOwner);
  const verify = () => {
    owner.verify();
    if (broker.pending.get(reference.managementRpcId) !== pending ||
        pending.method !== 'integrations/remotes/readOperation' ||
        !original || pending.params?.operationId !== original.operationId ||
        pending.params?.requestId !== original.requestId ||
        !isDeepStrictEqual(pending.params?.scope, original.sourceScope)) fail();
  };
  verify();
  const capability = Object.freeze({ verify,
    async withAuthorizedTarget(target, consume) {
      verify();
      const result = await owner.withAuthorizedTarget(target, async captured => {
        const check = () => { verify(); captured.verify(); };
        check();
        const value = await consume({ ...captured, verify: check });
        check();
        return value;
      });
      verify();
      return result;
    },
  });
  owned.add(capability);
  return capability;
}
