import { isDeepStrictEqual } from 'node:util';
import { workspaceCwdObservationTargetIdentity } from '../workspace-cwd-observation.js';

const owned = new WeakSet();
const fail = () => { throw new Error('REMOTE_HOST_SOURCE_CLIENT_CHANGED'); };

/** Captured only by the existing authenticated WebSocket attachment. The
 * callbacks re-use current Gateway authentication and target/account stores;
 * a Native request carries locators, never this captured client capability.
 */
export function captureNativeRemoteSourceClient({ client, broker, sourceTarget,
  authorizationOwner, session, verifySession, getTarget, targetSignature,
  accountIdentity, accountGeneration }) {
  if (!client || !broker || !sourceTarget || !session || !authorizationOwner ||
      typeof verifySession !== 'function' || typeof getTarget !== 'function' ||
      typeof targetSignature !== 'function' || typeof accountIdentity !== 'function' ||
      typeof accountGeneration !== 'function') fail();
  const sourceId = sourceTarget.id;
  const signature = targetSignature(sourceTarget);
  const generation = accountGeneration(authorizationOwner, sourceId);
  const principal = accountIdentity(authorizationOwner, sourceId)?.principalId ?? null;
  const verify = () => {
    const target = getTarget(sourceId);
    if (broker.closed || !client.initialized || !broker.clients.has(client) ||
        client.authorizationOwner !== authorizationOwner || !verifySession() ||
        !session.allowedServerIds?.has(sourceId) || !target ||
        targetSignature(target) !== signature ||
        accountGeneration(authorizationOwner, sourceId) !== generation ||
        (accountIdentity(authorizationOwner, sourceId)?.principalId ?? null) !== principal) fail();
    if (target.security && principal === null) fail();
  };
  const capability = Object.freeze({
    verify,
    async withAuthorizedTarget(reference, consume) {
      verify();
      if (!reference || typeof reference.targetId !== 'string' ||
          typeof reference.targetRevision !== 'string' || typeof consume !== 'function' ||
          !session.allowedServerIds?.has(reference.targetId)) fail();
      const target = getTarget(reference.targetId);
      if (!target || target.runtime !== 'kcoder' || target.transport !== 'ssh' ||
          workspaceCwdObservationTargetIdentity(targetSignature(target)) !== reference.targetRevision) fail();
      const targetGeneration = accountGeneration(authorizationOwner, target.id);
      const targetPrincipal = accountIdentity(authorizationOwner, target.id)?.principalId ?? null;
      if (target.security && targetPrincipal === null) fail();
      const check = () => {
        verify();
        const current = getTarget(reference.targetId);
        if (!session.allowedServerIds?.has(reference.targetId) || !current ||
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

/** Only an actual Native child request may reach this resolver. An active
 * broker turn selects its already authenticated socket owner; the supplied
 * identity still needs Source's original Accepted/budget proof independently.
 */
export function nativeRemoteSourceClientForAttempt(broker, attempt) {
  if (!broker || broker.closed || !attempt ||
      ['threadId', 'turnId', 'attemptId'].some(key => typeof attempt[key] !== 'string' ||
        !attempt[key] || attempt[key].length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(attempt[key]))) fail();
  if (broker.activeTurns?.get(attempt.threadId)?.turnId !== attempt.turnId) fail();
  const client = broker.ownerFor({ params: { threadId: attempt.threadId } });
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
