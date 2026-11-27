import * as C from './generated/contracts'

const atom = (value: unknown) => typeof value === 'string' && value.length > 0
  && new TextEncoder().encode(value).length <= 256 && !/[\p{Cc}]/u.test(value)
const offer = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Preparation proves the original set, never publication, live secrets or stopped workers. */
export function validPrivatePreparation(input: C.MigrationSourceCredentialPreparationReadParams, value: unknown): value is C.MigrationSourceCredentialPreparationResult {
  if (!C.isMigrationSourceCredentialPreparationResult(value) || value.requestId !== input.requestId || value.jobId !== input.jobId) return false
  const empty = value.originalPlanId === null && value.planId === null && value.offerIds === null
    && value.expectedSequence === null && value.consent === null
  if (value.phase === 'not_started') return empty
  const complete = atom(value.originalPlanId) && atom(value.planId) && value.offerIds !== null
    && value.offerIds.length >= 1 && value.offerIds.length <= 16 && value.offerIds.every((id, index, all) => offer.test(id) && (index === 0 || all[index - 1] < id))
    && value.expectedSequence !== null && value.consent !== null
  if (value.phase === 'unknown') return empty || complete
  return complete && (value.phase === 'pending' ? value.sequence === value.expectedSequence : value.sequence > value.expectedSequence!)
}

export function privatePreparationIdentity(value: C.MigrationSourceCredentialPreparationResult) {
  return JSON.stringify([value.requestId, value.jobId, value.originalPlanId, value.planId, value.offerIds,
    value.expectedSequence, value.consent?.apiKeys, value.consent?.mcpPrivateFields])
}

/** Only an explicitly confirmed, still-pending Native intent may supply these mutation parameters. */
export function pendingPrivatePreparation(value: C.MigrationSourceCredentialPreparationResult, target: C.MigrationSourceSessionParams): C.MigrationSourceCredentialPrepareParams | null {
  if (value.phase !== 'pending' || value.offerIds === null || value.expectedSequence === null || value.consent === null
    || !validPrivatePreparation({ requestId: value.requestId, jobId: value.jobId, target }, value)) return null
  return { locator: { requestId: value.requestId, offerId: value.offerIds[0], target }, jobId: value.jobId,
    expectedSequence: value.expectedSequence, consent: structuredClone(value.consent),
    ...(value.offerIds.length > 1 ? { additionalOffers: value.offerIds.slice(1) } : {}) }
}
