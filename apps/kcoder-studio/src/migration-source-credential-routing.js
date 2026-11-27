import { validPrivatePreparationResult } from './migration-source-credential-preparation.js';
import { privateCredentialOfferSet, validPrivateCredentialOfferSet } from './migration-source-credential-bundles.js';
import { validPrivateCandidatePlanInput, validPrivateCandidateResult } from './migration-source-credential-candidates.js';
import { isContract } from '../shared/generated/validator.mjs';
import { MigrationSourceBridgeError } from './migration-source-private.js';
import { resolveMigrationSourceSelection } from './migration-source-session-routing.js';

const operations = Object.freeze({
  'prepare-status': ['MigrationSourceCredentialPreparationReadParams', 'privatePreparationStatus'],
  candidates: ['MigrationSourceCredentialCandidatesParams', 'privateCandidates'],
  run: ['MigrationSourceCredentialRunParams', 'privateRun'],
  read: ['MigrationSourceCredentialLocator', 'privateRead'],
  'source-read': ['MigrationSourceCredentialSourceReadParams', 'privateSourceRead'],
  cancel: ['MigrationSourceCredentialCancelParams', 'privateCancel'],
  resume: ['MigrationSourceCredentialResumeParams', 'privateResume'],
  prepare: ['MigrationSourceCredentialPrepareParams', 'privatePrepare'],
  release: ['MigrationSourceCredentialReleaseParams', 'privateRelease'],
});
const fail = reason => { throw new MigrationSourceBridgeError(reason); };
export function validMigrationSourceCredentialResult(operation, payload, result) {
  if (!Object.hasOwn(operations, operation) || !isContract(operations[operation][0], payload)) return false;
  const locator = ['read', 'candidates', 'prepare-status'].includes(operation) ? payload : payload.locator;
  if (result?.requestId !== locator.requestId) return false;
  if (operation === 'candidates') return validPrivateCandidateResult(payload, result);
  if (operation === 'prepare-status') return validPrivatePreparationResult(payload, result);
  if (result?.offerId !== locator.offerId) return false;
  if (operation === 'prepare') {
    let offerIds;
    try { offerIds = privateCredentialOfferSet({ offerId: locator.offerId,
      ...(Object.hasOwn(payload, 'additionalOffers') ? { additionalOffers: payload.additionalOffers } : {}) }); }
    catch { return false; }
    return isContract('MigrationSourceCredentialPrepareResult', result) && result.job.job.jobId === payload.jobId
      && (offerIds ? validPrivateCredentialOfferSet(offerIds, result.offerIds) : !Object.hasOwn(result, 'offerIds'));
  }
  if (operation === 'cancel' || operation === 'resume') return isContract('MigrationSourceCredentialControlResult', result)
    && result.side === payload.side;
  if (!isContract('MigrationSourceCredentialResult', result)) return false;
  for (const side of ['source', 'target']) {
    if (result[`${side}Observed`] !== (result[`${side}Control`] !== null)
      || result[`${side}Observed`] !== (result[`${side}WorkerRunning`] !== null)) return false;
  }
  if (operation === 'source-read') {
    if (!result.sourceObserved || result.targetObserved || result.received || result.keyReleased) return false;
    const running = result.sourceWorkerRunning;
    return result.phase === (result.sourceControl.cancelled ? running ? 'cancelling' : 'cancelled' : running ? 'running' : result.sourceControl.ready ? 'sealed' : 'offered');
  }
  if (!result.targetObserved || result.received !== result.targetControl.ready) return false;
  const running = result.sourceWorkerRunning === true || result.targetWorkerRunning === true;
  const cancelled = result.sourceControl?.cancelled === true || result.targetControl.cancelled;
  if (cancelled) return result.phase === (running ? 'cancelling' : 'cancelled');
  if (running) return result.phase === 'running';
  if (result.keyReleased) return result.phase === 'released';
  if (result.received) return result.phase === 'received';
  if (result.phase === 'sealed') return result.sourceObserved && result.sourceControl.ready;
  return result.phase === 'offered';
}

/** Selectors resolve through the same authenticated session owner as ordinary
 * transfers. Keys, ciphertext and authorities have no public input field. */
export async function routeMigrationSourceCredential(operation, payload, { service, resolveSelection }) {
  if (!Object.hasOwn(operations, operation) || !isContract(operations[operation][0], payload)) fail('private_credentials_invalid_request');
  if (operation === 'candidates' && !validPrivateCandidatePlanInput(payload)) fail('private_credentials_invalid_request');
  const locator = ['read', 'candidates', 'prepare-status'].includes(operation) ? payload : payload.locator;
  if (operation === 'prepare') privateCredentialOfferSet({ offerId: locator.offerId,
    ...(Object.hasOwn(payload, 'additionalOffers') ? { additionalOffers: payload.additionalOffers } : {}) });
  if (!['target', 'target_recovery'].includes(locator.target.purpose)) fail('source_transfer_role_mismatch');
  const sourceRequired = ['run', 'source-read'].includes(operation) || ['cancel', 'resume'].includes(operation) && payload.side === 'source';
  if (sourceRequired ? payload.source?.purpose !== 'source' : payload.source != null) fail('source_transfer_role_mismatch');
  if (operation === 'run' && locator.target.purpose !== 'target') fail('source_transfer_role_mismatch');
  const resolve = async selector => ({ ...await resolveMigrationSourceSelection(selector, resolveSelection),
    sessionId: selector.sessionId, purpose: selector.purpose === 'target_recovery' ? 'target-recovery' : selector.purpose });
  const target = await resolve(locator.target);
  const source = sourceRequired ? await resolve(payload.source) : undefined;
  const options = { requestId: locator.requestId, offerId: locator.offerId, target, ...(source ? { source } : {}) };
  if (operation === 'prepare-status') options.jobId = payload.jobId;
  if (operation === 'candidates') Object.assign(options, { manifestSha256: payload.manifestSha256, entryId: payload.entryId, pageIndex: payload.pageIndex,
    ...(payload.jobId != null ? { jobId: payload.jobId, expectedPlanId: payload.expectedPlanId } : {}) });
  if (operation === 'run') Object.assign(options, { manifestSha256: payload.manifestSha256, entryId: payload.entryId,
    selections: payload.selections, consent: payload.consent });
  if (['cancel', 'resume'].includes(operation)) options.side = payload.side;
  if (operation === 'cancel') options.commandId = payload.commandId;
  if (operation === 'resume') options.expectedControl = payload.expectedControl;
  if (operation === 'prepare') Object.assign(options, { jobId: payload.jobId, expectedSequence: payload.expectedSequence, consent: payload.consent,
    ...(Object.hasOwn(payload, 'additionalOffers') ? { additionalOffers: [...payload.additionalOffers] } : {}) });
  if (operation === 'release') options.jobId = payload.jobId;
  const result = await service[operations[operation][1]](options);
  if (!validMigrationSourceCredentialResult(operation, payload, result)) fail('private_credentials_invalid_response');
  return result;
}
