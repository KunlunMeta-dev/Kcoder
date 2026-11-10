import { isContract } from '../shared/generated/validator.mjs';

const atom = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\p{Cc}]/u.test(value);
export function validPrivateCandidatePlanInput(value) {
  return value.jobId == null && value.expectedPlanId == null
    || atom(value.jobId) && atom(value.expectedPlanId);
}

/** These fields describe a saved Native plan, not authority to publish it. */
export function validPrivateCandidateResult(params, value) {
  if (!validPrivateCandidatePlanInput(params) || !isContract('MigrationSourceCredentialCandidatesResult', value)
    || value.requestId !== params.requestId || value.manifestSha256 !== params.manifestSha256 || value.entryId !== params.entryId) return false;
  const offset = params.pageIndex * 10;
  if (offset >= value.totalItems && offset !== 0 || value.items.length !== Math.min(10, value.totalItems - offset)
    || (value.nextPage ?? null) !== (offset + 10 < value.totalItems ? params.pageIndex + 1 : null)) return false;
  if (params.jobId == null ? value.plan != null : value.plan?.jobId !== params.jobId || value.plan?.planId !== params.expectedPlanId) return false;
  const items = new Set(), targets = new Set();
  for (const row of value.items) {
    if (row.sourceVerificationRequired !== true || items.has(row.itemId)) return false;
    items.add(row.itemId);
    if ((row.targets ?? []).length > 1 || params.jobId == null && row.targets?.length) return false;
    for (const target of row.targets ?? []) {
      if (target.kind !== row.kind || !atom(target.batchItemId) || !atom(target.targetName) || targets.has(target.batchItemId)) return false;
      targets.add(target.batchItemId);
    }
  }
  return true;
}
