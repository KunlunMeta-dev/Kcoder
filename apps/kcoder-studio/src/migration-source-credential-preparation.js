import { isContract } from '../shared/generated/validator.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const atom = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\p{Cc}]/u.test(value);

/** A prepare receipt proves its original intent, never publication or worker exit. */
export function validPrivatePreparationResult(options, value) {
  if (!isContract('MigrationSourceCredentialPreparationResult', value)
    || value.requestId !== options.requestId || value.jobId !== options.jobId) return false;
  const proof = [value.originalPlanId, value.planId, value.offerIds, value.expectedSequence, value.consent];
  if (proof.every(item => item === null)) return ['not_started', 'unknown'].includes(value.phase);
  if (proof.some(item => item === null) || value.phase === 'not_started'
    || !atom(value.originalPlanId) || !atom(value.planId) || value.originalPlanId === value.planId
    || !value.offerIds.every((id, index) => UUID.test(id) && (index === 0 || value.offerIds[index - 1] < id))
    || !(value.consent.apiKeys || value.consent.mcpPrivateFields)) return false;
  if (value.phase === 'pending') return value.sequence === value.expectedSequence;
  if (value.phase === 'prepared') return value.sequence > value.expectedSequence;
  return value.phase === 'unknown';
}
