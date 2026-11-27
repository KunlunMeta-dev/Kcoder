import { isContract } from './generated/validator.mjs';

const scopeFields = ['accountId', 'targetId', 'workspaceId', 'identityGeneration', 'targetRevision', 'organizationId'];
const referenceFields = ['threadId', 'turnId', 'taskId'];
const terminal = new Set(['completed', 'failed', 'cancelled']);

export function sameTaskObservationScope(left, right) {
  return !!left && !!right && scopeFields.every(key => left[key] === right[key]);
}

export function isTaskStateObservation(value) {
  return isContract('IntegrationTaskStateObservation', value)
    && value.entityId === value.operationId
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && value.sequence === value.revision
    && Number.isSafeInteger(value.observedAtMs) && value.observedAtMs > 0;
}

/** Fold an observation into an existing owner projection; this stores no state
 * and never authorizes an RPC, a task, or an external effect. */
export function foldTaskStateObservation(previous, incoming, ownerScope) {
  const current = previous && sameTaskObservationScope(previous.scope, ownerScope) ? previous : null;
  const unchanged = (needsSnapshot = false) => ({ observation: current, changed: false, needsSnapshot });
  if (!isTaskStateObservation(incoming) || !sameTaskObservationScope(incoming.scope, ownerScope)) return unchanged();
  if (current) {
    if (current.entityId !== incoming.entityId || current.operationId !== incoming.operationId
      || referenceFields.some(key => current.reference[key] !== incoming.reference[key])) return unchanged();
    if (incoming.revision <= current.revision) return unchanged();
    if (terminal.has(current.state) && incoming.state !== current.state) return unchanged();
    if (!incoming.snapshot && incoming.sequence !== current.sequence + 1) return unchanged(true);
  } else if (!incoming.snapshot && incoming.sequence !== 1) return unchanged(true);
  return { observation: incoming, changed: true, needsSnapshot: false };
}
