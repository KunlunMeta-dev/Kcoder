import {
  isMigrationResourceBudgetReadParams, isMigrationResourceBudgetView, isMigrationResourceIncreaseParams,
  isMigrationResourceIncreaseReceipt, type MigrationResourceBudgetReadParams, type MigrationResourceBudgetView,
  type MigrationResourceIncreaseParams, type MigrationResourceIncreaseReceipt, type MigrationResourceLimitFacts,
} from './generated/contracts'

export const RESOURCE_BUDGET_CAPABILITY = 'migrationResourceBudgetV1'
export const RESOURCE_BUDGET_METHODS = ['migration/batch/resources/read', 'migration/batch/resources/increase'] as const
export const resourceBudgetReadOnly = (method: string) => method === RESOURCE_BUDGET_METHODS[0]
const atom = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const LIMIT_KEYS = ['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'] as const
export const sameResourceLimits = (a: MigrationResourceLimitFacts, b: MigrationResourceLimitFacts) => LIMIT_KEYS.every(key => a[key] === b[key])
export function validResourceFacts(value: unknown): value is MigrationResourceLimitFacts {
  if (!value || typeof value !== 'object') return false
  const limits = value as Record<string, unknown>
  return Object.keys(limits).length === 4 && LIMIT_KEYS.every(key => integer(limits[key]))
    && Number(limits.maxTotalBytes) > 0 && Number(limits.maxPayloadFiles) > 0 && Number(limits.minFreeBytes) > 0
}
export function validResourceIntent(input: unknown): input is MigrationResourceIncreaseParams & { confirm: true; limits: MigrationResourceLimitFacts } {
  return isMigrationResourceIncreaseParams(input) && input.confirm === true && atom(input.jobId) && atom(input.planId)
    && atom(input.requestId) && integer(input.expectedPolicyRevision) && validResourceFacts(input.limits)
}
function validReceipt(receipt: MigrationResourceIncreaseReceipt) {
  return atom(receipt.jobId) && atom(receipt.requestId) && integer(receipt.previousRevision)
    && integer(receipt.revision) && receipt.revision === receipt.previousRevision + 1 && validResourceFacts(receipt.limits)
}
export function validResourceCall(method: string, input: unknown, result?: unknown): boolean {
  if (method === RESOURCE_BUDGET_METHODS[0]) {
    if (!isMigrationResourceBudgetReadParams(input) || !atom(input.jobId) || input.requestId != null && !atom(input.requestId)) return false
    if (arguments.length < 3) return true
    if (!isMigrationResourceBudgetView(result) || result.jobId !== input.jobId) return false
    if (result.phase === 'not_applicable' || result.phase === 'legacy_untracked') return true
    if (!validResourceFacts(result.limits)) return false
    if (result.phase === 'planned') return true
    const { usage, requestedReceipt: receipt } = result
    return integer(result.policyRevision) && Object.values(usage).every(integer)
      && Number.isSafeInteger(usage.committedBytes + usage.reservedBytes) && Number.isSafeInteger(usage.committedFiles + usage.reservedFiles)
      && usage.committedBytes + usage.reservedBytes <= result.limits.maxTotalBytes
      && usage.committedFiles + usage.reservedFiles <= result.limits.maxPayloadFiles
      && (!receipt || !!input.requestId && receipt.requestId === input.requestId && receipt.jobId === input.jobId
        && validReceipt(receipt) && receipt.revision <= result.policyRevision
        && receipt.limits.maxTotalBytes <= result.limits.maxTotalBytes && receipt.limits.maxPayloadFiles <= result.limits.maxPayloadFiles
        && receipt.limits.minFreeBytes === result.limits.minFreeBytes && receipt.limits.minFreeFileNodes === result.limits.minFreeFileNodes)
  }
  if (method === RESOURCE_BUDGET_METHODS[1]) {
    return validResourceIntent(input) && (arguments.length < 3 || isMigrationResourceIncreaseReceipt(result)
      && validReceipt(result) && result.jobId === input.jobId && result.requestId === input.requestId
      && result.previousRevision === input.expectedPolicyRevision && sameResourceLimits(result.limits, input.limits))
  }
  return false
}

/** The editor changes only totals; it carries the original mandatory free-space margins unchanged. */
export function resourceBudgetDraft(view: MigrationResourceBudgetView | null, bytes: string, files: string): MigrationResourceLimitFacts | null {
  if (view?.phase !== 'active' || !/^\d{1,16}$/.test(bytes) || !/^\d{1,8}$/.test(files)) return null
  const limits = { ...view.limits, maxTotalBytes: Number(bytes), maxPayloadFiles: Number(files) }
  return validResourceFacts(limits) && limits.maxTotalBytes >= view.limits.maxTotalBytes
    && limits.maxPayloadFiles >= view.limits.maxPayloadFiles && !sameResourceLimits(limits, view.limits) ? limits : null
}

type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createResourceBudgetApi(invoke: Invoke) {
  const call = async <T>(method: string, input: object, options?: { signal?: AbortSignal }): Promise<T> => {
    if (!validResourceCall(method, input)) throw new Error('migration_invalid_parameters')
    const result = await invoke<T>(method, input, options)
    if (!validResourceCall(method, input, result)) throw new Error('migration_invalid_response')
    return result
  }
  return {
    resourcesRead: (input: MigrationResourceBudgetReadParams, options?: { signal?: AbortSignal }) => call<MigrationResourceBudgetView>(RESOURCE_BUDGET_METHODS[0], input, options),
    resourcesIncrease: (input: MigrationResourceIncreaseParams) => call<MigrationResourceIncreaseReceipt>(RESOURCE_BUDGET_METHODS[1], input),
  }
}

export const resourceBudgetMutable = (status: string, unresolvedActions = 0) => ['scanning', 'ready', 'applying', 'failed'].includes(status) || status === 'completed_with_issues' && unresolvedActions > 0
