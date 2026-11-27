import * as C from './generated/contracts'
import { validPrivatePreparation } from './migrationPrivatePreparation'

export interface PrivateCredentialCalls {
  candidates: [C.MigrationSourceCredentialCandidatesParams, C.MigrationSourceCredentialCandidatesResult]
  run: [C.MigrationSourceCredentialRunParams, C.MigrationSourceCredentialResult]
  read: [C.MigrationSourceCredentialLocator, C.MigrationSourceCredentialResult]
  'source-read': [C.MigrationSourceCredentialSourceReadParams, C.MigrationSourceCredentialResult]
  'prepare-status': [C.MigrationSourceCredentialPreparationReadParams, C.MigrationSourceCredentialPreparationResult]
  cancel: [C.MigrationSourceCredentialCancelParams, C.MigrationSourceCredentialControlResult]
  resume: [C.MigrationSourceCredentialResumeParams, C.MigrationSourceCredentialControlResult]
  prepare: [C.MigrationSourceCredentialPrepareParams, C.MigrationSourceCredentialPrepareResult]
  release: [C.MigrationSourceCredentialReleaseParams, C.MigrationSourceCredentialResult]
}
export type PrivateCredentialOperation = keyof PrivateCredentialCalls
type PrivateCredentialInput = PrivateCredentialCalls[PrivateCredentialOperation][0]
function privateCredentialLocator(input: PrivateCredentialInput): C.MigrationSourceCredentialLocator | C.MigrationSourceCredentialCandidatesParams | C.MigrationSourceCredentialPreparationReadParams {
  return 'locator' in input ? input.locator : input
}
export const PRIVATE_CREDENTIAL_READ_ONLY = new Set<string>(['candidates', 'read', 'source-read', 'prepare-status'])
export const isPrivateCredentialError = C.isMigrationSourceCredentialError
const guards: Record<PrivateCredentialOperation, (value: unknown) => boolean> = {
  candidates: C.isMigrationSourceCredentialCandidatesParams,
  run: C.isMigrationSourceCredentialRunParams,
  read: C.isMigrationSourceCredentialLocator,
  'source-read': C.isMigrationSourceCredentialSourceReadParams,
  'prepare-status': C.isMigrationSourceCredentialPreparationReadParams,
  cancel: C.isMigrationSourceCredentialCancelParams,
  resume: C.isMigrationSourceCredentialResumeParams,
  prepare: C.isMigrationSourceCredentialPrepareParams,
  release: C.isMigrationSourceCredentialReleaseParams,
}
const planAtom = (value: unknown) => typeof value === 'string' && value.length > 0
  && new TextEncoder().encode(value).length <= 256 && !/[\p{Cc}]/u.test(value)
function validCandidatePlanInput(input: C.MigrationSourceCredentialCandidatesParams) {
  return input.jobId == null && input.expectedPlanId == null || planAtom(input.jobId) && planAtom(input.expectedPlanId)
}

function validCandidateResult(input: C.MigrationSourceCredentialCandidatesParams, value: unknown): value is C.MigrationSourceCredentialCandidatesResult {
  if (!validCandidatePlanInput(input) || !C.isMigrationSourceCredentialCandidatesResult(value)
    || value.requestId !== input.requestId || value.manifestSha256 !== input.manifestSha256 || value.entryId !== input.entryId) return false
  const offset = input.pageIndex * 10
  if (offset >= value.totalItems && offset !== 0 || value.items.length !== Math.min(10, value.totalItems - offset)
    || (value.nextPage ?? null) !== (offset + 10 < value.totalItems ? input.pageIndex + 1 : null)) return false
  if (input.jobId == null ? value.plan != null : value.plan?.jobId !== input.jobId || value.plan?.planId !== input.expectedPlanId) return false
  const items = new Set<string>(), targets = new Set<string>()
  for (const row of value.items) {
    if (row.sourceVerificationRequired !== true || items.has(row.itemId)) return false
    items.add(row.itemId)
    if ((row.targets ?? []).length > 1 || input.jobId == null && row.targets?.length) return false
    for (const target of row.targets ?? []) {
      if (target.kind !== row.kind || !planAtom(target.batchItemId) || !planAtom(target.targetName) || targets.has(target.batchItemId)) return false
      targets.add(target.batchItemId)
    }
  }
  return true
}

export function validPrivateCredentialInput<K extends PrivateCredentialOperation>(operation: K, value: unknown): value is PrivateCredentialCalls[K][0] {
  if (!guards[operation](value)) return false
  const input = value as PrivateCredentialCalls[K][0]
  const locator = privateCredentialLocator(input)
  if (!['target', 'target_recovery'].includes(locator.target.purpose)) return false
  if (operation === 'candidates') return validCandidatePlanInput(input as C.MigrationSourceCredentialCandidatesParams)
  if (operation === 'prepare-status') return planAtom((input as C.MigrationSourceCredentialPreparationReadParams).jobId)
  if (operation === 'prepare' && (input as C.MigrationSourceCredentialPrepareParams).additionalOffers?.includes((locator as C.MigrationSourceCredentialLocator).offerId)) return false
  if (operation === 'source-read') return 'source' in input && input.source?.purpose === 'source'
  if (operation === 'run') return locator.target.purpose === 'target' && 'source' in input && input.source?.purpose === 'source'
  if (operation === 'cancel' || operation === 'resume') {
    const control = input as C.MigrationSourceCredentialCancelParams | C.MigrationSourceCredentialResumeParams
    return control.side === 'source' ? control.source?.purpose === 'source' : control.source == null
  }
  return !('source' in input)
}

/** Shape checks are supplemented by the original receipt, offer and observed control identities. */
export function validPrivateCredentialResult<K extends PrivateCredentialOperation>(operation: K, input: PrivateCredentialCalls[K][0], value: unknown): value is PrivateCredentialCalls[K][1] {
  const locator = privateCredentialLocator(input)
  if (!value || typeof value !== 'object' || !('requestId' in value) || value.requestId !== locator.requestId) return false
  if (operation === 'candidates') return validCandidateResult(input as C.MigrationSourceCredentialCandidatesParams, value)
  if (operation === 'prepare-status') return validPrivatePreparation(input as C.MigrationSourceCredentialPreparationReadParams, value)
  if (!('offerId' in locator) || !('offerId' in value) || value.offerId !== locator.offerId) return false
  if (operation === 'prepare') {
    const params = input as C.MigrationSourceCredentialPrepareParams
    if (!C.isMigrationSourceCredentialPrepareResult(value) || value.job.job.jobId !== params.jobId) return false
    return params.additionalOffers === undefined ? value.offerIds === undefined
      : JSON.stringify(value.offerIds) === JSON.stringify([(locator as C.MigrationSourceCredentialLocator).offerId, ...params.additionalOffers].sort())
  }
  if (operation === 'cancel' || operation === 'resume') return C.isMigrationSourceCredentialControlResult(value)
    && value.side === (input as C.MigrationSourceCredentialCancelParams).side
  if (!C.isMigrationSourceCredentialResult(value)) return false
  for (const side of ['source', 'target'] as const) {
    if (value[`${side}Observed`] !== (value[`${side}Control`] !== null)
      || value[`${side}Observed`] !== (value[`${side}WorkerRunning`] !== null)) return false
  }
  if (operation === 'source-read') {
    if (!value.sourceObserved || !value.sourceControl || value.targetObserved || value.received || value.keyReleased) return false
    return value.phase === (value.sourceControl.cancelled ? value.sourceWorkerRunning ? 'cancelling' : 'cancelled'
      : value.sourceWorkerRunning ? 'running' : value.sourceControl.ready ? 'sealed' : 'offered')
  }
  if (!value.targetObserved || !value.targetControl || value.received !== value.targetControl.ready) return false
  const running = value.sourceWorkerRunning === true || value.targetWorkerRunning === true
  const cancelled = value.sourceControl?.cancelled === true || value.targetControl.cancelled
  if (cancelled) return value.phase === (running ? 'cancelling' : 'cancelled')
  if (running) return value.phase === 'running'
  if (value.keyReleased) return value.phase === 'released'
  if (value.received) return value.phase === 'received'
  return value.phase === 'offered' || value.phase === 'sealed' && value.sourceObserved && value.sourceControl?.ready === true
}

export type PrivateCredentialHttpRequest = <T>(operation: string, input: unknown, validInput: (value: unknown) => boolean,
  validResult: (value: unknown) => value is T, signal?: AbortSignal) => Promise<T>

export function privateCredentialClient(request: PrivateCredentialHttpRequest, defaultSignal?: () => AbortSignal) {
  function call<K extends PrivateCredentialOperation>(operation: K, input: PrivateCredentialCalls[K][0], signal?: AbortSignal) {
    return request<PrivateCredentialCalls[K][1]>(operation, input, value => validPrivateCredentialInput(operation, value),
      (value): value is PrivateCredentialCalls[K][1] => validPrivateCredentialResult(operation, input, value), signal ?? defaultSignal?.())
  }
  return {
    candidates: (input: PrivateCredentialCalls['candidates'][0], signal?: AbortSignal) => call('candidates', input, signal),
    run: (input: PrivateCredentialCalls['run'][0], signal?: AbortSignal) => call('run', input, signal),
    sourceRead: (input: PrivateCredentialCalls['source-read'][0], signal?: AbortSignal) => call('source-read', input, signal),
    preparationRead: (input: PrivateCredentialCalls['prepare-status'][0], signal?: AbortSignal) => call('prepare-status', input, signal),
    read: (input: PrivateCredentialCalls['read'][0], signal?: AbortSignal) => call('read', input, signal),
    cancel: (input: PrivateCredentialCalls['cancel'][0], signal?: AbortSignal) => call('cancel', input, signal),
    resume: (input: PrivateCredentialCalls['resume'][0], signal?: AbortSignal) => call('resume', input, signal),
    prepare: (input: PrivateCredentialCalls['prepare'][0], signal?: AbortSignal) => call('prepare', input, signal),
    release: (input: PrivateCredentialCalls['release'][0], signal?: AbortSignal) => call('release', input, signal),
  }
}
