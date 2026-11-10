import {
  isMigrationSourceTransferRunParams,
  isMigrationSourceTransferReadParams,
  isMigrationSourceTransferCancelParams,
  isMigrationSourceTransferTargetReadParams,
  isMigrationSourceTransferTargetCancelParams,
  isMigrationSourceTransferTargetResumeParams,
  isMigrationSourceTransferTargetFinishParams,
  type MigrationSourceTransferRunParams,
  type MigrationSourceTransferReadParams,
  type MigrationSourceTransferCancelParams,
  type MigrationSourceTransferTargetReadParams,
  type MigrationSourceTransferTargetCancelParams,
  type MigrationSourceTransferTargetResumeParams,
  type MigrationSourceTransferTargetFinishParams,
} from '../../../shared/generated/contracts'
import { validMigrationSourceObservation } from '../../../shared/migrationSourceObservation'
import { createMigrationSourceHttpTransport, type MigrationSourceHttpOptions } from './gatewayMigrationSourceHttp'

/** IDs are supplied by the confirmed draft. A lost response never mints a new attempt. */
export function createMigrationSourceTransferClient(options: MigrationSourceHttpOptions) {
  const request = createMigrationSourceHttpTransport(options, 'source-transfer', new Set(['read', 'target-read']))
  function call<T extends { requestId: string }>(operation: string, input: T,
    valid: (value: unknown) => value is T, signal?: AbortSignal) {
    return request(operation, input, valid, value => validMigrationSourceObservation(value, input.requestId), signal)
  }
  return {
    run: (input: MigrationSourceTransferRunParams, signal?: AbortSignal) => call('run', input, isMigrationSourceTransferRunParams, signal),
    read: (input: MigrationSourceTransferReadParams, signal?: AbortSignal) => call('read', input, isMigrationSourceTransferReadParams, signal),
    cancel: (input: MigrationSourceTransferCancelParams, signal?: AbortSignal) => call('cancel', input, isMigrationSourceTransferCancelParams, signal),
    targetRead: (input: MigrationSourceTransferTargetReadParams, signal?: AbortSignal) => call('target-read', input, isMigrationSourceTransferTargetReadParams, signal),
    targetCancel: (input: MigrationSourceTransferTargetCancelParams, signal?: AbortSignal) => call('target-cancel', input, isMigrationSourceTransferTargetCancelParams, signal),
    targetResume: (input: MigrationSourceTransferTargetResumeParams, signal?: AbortSignal) => call('target-resume', input, isMigrationSourceTransferTargetResumeParams, signal),
    targetFinish: (input: MigrationSourceTransferTargetFinishParams, signal?: AbortSignal) => call('target-finish', input, isMigrationSourceTransferTargetFinishParams, signal),
  }
}
