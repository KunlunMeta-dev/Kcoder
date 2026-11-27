import { isContract } from '../shared/generated/validator.mjs';
import { MigrationSourceBridgeError } from './migration-source-private.js';
import { resolveMigrationSourceSelection } from './migration-source-session-routing.js';

const operations = Object.freeze({
  run: ['MigrationSourceTransferRunParams', 'run'],
  read: ['MigrationSourceTransferReadParams', 'read'],
  cancel: ['MigrationSourceTransferCancelParams', 'cancel'],
  'target-read': ['MigrationSourceTransferTargetReadParams', 'targetRead'],
  'target-cancel': ['MigrationSourceTransferTargetCancelParams', 'targetCancel'],
  'target-resume': ['MigrationSourceTransferTargetResumeParams', 'targetResume'],
  'target-finish': ['MigrationSourceTransferTargetFinishParams', 'targetFinish'],
  received: ['MigrationSourceReceivedParams', 'received'],
  'adoption-prepare': ['MigrationSourceAdoptionPrepareParams', 'adoptionPrepare'],
  'adoption-read': ['MigrationSourceAdoptionParams', 'adoptionRead'],
  'adoption-resume': ['MigrationSourceAdoptionResumeParams', 'adoptionResume'],
  'adoption-cancel': ['MigrationSourceAdoptionCancelParams', 'adoptionCancel'],
});
const fail = reason => { throw new MigrationSourceBridgeError(reason); };

export function validMigrationSourceOperationResult(operation, payload, result) {
  if (!Object.hasOwn(operations, operation)) return false;
  if (!isContract(operations[operation][0], payload)) return false;
  if (operation === 'received') return isContract('MigrationSourceReceivedResult', result)
    && result.receipt.requestId === payload.requestId && result.receipt.manifestSha256 === payload.manifestSha256;
  if (operation.startsWith('adoption-')) {
    const locator = operation === 'adoption-read' ? payload : payload.locator;
    return isContract('MigrationSourceAdoptionResult', result) && (result.state === null
      || result.state.requestId === locator.requestId && result.state.adoptionId === locator.adoptionId);
  }
  return isContract('MigrationSourceTransferResult', result) && result.requestId === payload.requestId;
}

/** The HTTP layer validates login/Origin before dispatch. Service resolves only
 * existing Native leases, then authenticates durable attempt receipts itself. */
export async function routeMigrationSourceOperation(operation, payload, { service, resolveSelection }) {
  if (!Object.hasOwn(operations, operation)) fail('source_transfer_invalid_request');
  const [schema, method] = operations[operation];
  if (!isContract(schema, payload)) fail('source_transfer_invalid_request');
  const adoption = operation.startsWith('adoption-');
  const received = operation === 'received';
  const locator = adoption && operation !== 'adoption-read' ? payload.locator : payload;
  const targetOnly = operation.startsWith('target-') || adoption || received;
  if (adoption || received ? !['target', 'target_recovery'].includes(locator.target.purpose) :
      targetOnly ? payload.target.purpose !== 'target_recovery' :
      payload.source.purpose !== 'source' || payload.target.purpose !== 'target') fail('source_transfer_role_mismatch');
  const resolve = async selector => ({
    ...await resolveMigrationSourceSelection(selector, resolveSelection),
    sessionId: selector.sessionId,
    purpose: selector.purpose === 'target_recovery' ? 'target-recovery' : selector.purpose,
  });
  const source = targetOnly ? undefined : await resolve(payload.source);
  const target = await resolve(locator.target);
  // Explicit fields prevent an eventual permissive schema from becoming a raw RPC tunnel.
  const options = { requestId: locator.requestId, target, ...(source ? { source } : {}) };
  if (adoption) options.adoptionId = locator.adoptionId;
  if (received || operation === 'adoption-prepare') options.manifestSha256 = payload.manifestSha256;
  if (received) { options.pageIndex = payload.pageIndex; options.includeProjects = payload.includeProjects === true; options.includePlugins = payload.includePlugins === true; options.includeInstructions = payload.includeInstructions === true; }
  if (operation === 'adoption-prepare') { options.selections = payload.selections; options.instructionMappings = payload.instructionMappings ?? []; }
  if (operation === 'adoption-resume') options.expectedControl = payload.expectedControl;
  if (operation === 'adoption-cancel') options.commandId = payload.commandId;
  if (operation === 'run') {
    options.attemptId = payload.attemptId;
    if (payload.selections != null) options.selections = payload.selections;
    if (payload.resume != null) options.resume = payload.resume;
  }
  if (operation === 'cancel' || operation === 'target-cancel') options.commandId = payload.commandId;
  if (operation === 'target-finish' || operation === 'target-resume') options.attemptId = payload.attemptId;
  if (operation === 'target-resume') {
    options.expectedAdmissionControl = payload.expectedAdmissionControl;
    options.expectedOperationControl = payload.expectedOperationControl;
  }
  return service[method](options);
}
