import * as C from './generated/contracts'
import { validResourceCall, validResourceFacts, sameResourceLimits } from './migrationResourceBudget'
export const HISTORY_RESOURCE_CAPABILITY = 'migrationHistoryResourceBudgetV1'
export const HISTORY_RESOURCE_METHODS = {
  read: 'migration/history/resources/read', increase: 'migration/history/resources/increase',
  attach: 'migration/history/resources/attach', parentAttach: 'migration/batch/resources/attach',
} as const
export const historyResourceMethod = (method: string) => Object.values(HISTORY_RESOURCE_METHODS).some(value => value === method)
const atom = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
export function validHistoryResourceCall(method: string, input: unknown, result?: unknown): boolean {
  if (method === HISTORY_RESOURCE_METHODS.read) {
    if (!C.isMigrationHistoryResourceReadParams(input) || !atom(input.jobId) || input.requestId != null && !atom(input.requestId)) return false
    if (arguments.length < 3) return true
    if (!C.isMigrationHistoryResourceResult(result) || result.ownerJobId !== null && !atom(result.ownerJobId)
      || !validResourceCall('migration/batch/resources/read', input, result.budget)) return false
    if (result.budget.phase !== 'active' && result.budget.phase !== 'planned') return result.initialLimits === null
    if (!result.ownerJobId || !validResourceFacts(result.initialLimits)) return false
    const initial = result.initialLimits, current = result.budget.limits
    return initial.maxTotalBytes <= current.maxTotalBytes && initial.maxPayloadFiles <= current.maxPayloadFiles
      && initial.minFreeBytes === current.minFreeBytes && initial.minFreeFileNodes === current.minFreeFileNodes
  }
  if (method === HISTORY_RESOURCE_METHODS.increase) {
    if (!C.isMigrationHistoryResourceIncreaseParams(input) || !atom(input.jobId) || !atom(input.requestId) || !integer(input.expectedPolicyRevision) || !validResourceFacts(input.limits) || input.confirm !== true) return false
    const batch = { ...input, planId: input.jobId }
    return arguments.length < 3 ? validResourceCall('migration/batch/resources/increase', batch)
      : validResourceCall('migration/batch/resources/increase', batch, result)
  }
  if (method === HISTORY_RESOURCE_METHODS.attach || method === HISTORY_RESOURCE_METHODS.parentAttach) {
    const parent = method === HISTORY_RESOURCE_METHODS.parentAttach
    if (!(parent ? C.isMigrationHistoryParentResourceAttachParams(input) : C.isMigrationHistoryResourceAttachParams(input))) return false
    const params = input as C.MigrationHistoryResourceAttachParams & { planId?: string }
    if (!atom(params.jobId) || parent && !atom(params.planId) || !integer(params.expectedSequence) || !validResourceFacts(params.limits) || params.confirm !== true) return false
    if (arguments.length < 3) return true
    return parent ? C.isMigrationResourceBudgetView(result) && result.phase === 'active' && validResourceCall('migration/batch/resources/read', { jobId: params.jobId }, result)
      && result.limits.maxTotalBytes >= params.limits.maxTotalBytes! && result.limits.maxPayloadFiles >= params.limits.maxPayloadFiles!
      && result.limits.minFreeBytes === params.limits.minFreeBytes && result.limits.minFreeFileNodes === params.limits.minFreeFileNodes
      : validHistoryResourceCall(HISTORY_RESOURCE_METHODS.read, { jobId: params.jobId }, result) && C.isMigrationHistoryResourceResult(result) && result.ownerJobId === params.jobId && result.initialLimits !== null && sameResourceLimits(result.initialLimits, params.limits)
  }
  return false
}
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createHistoryResourceApi(invoke: Invoke) {
  const call = async <T>(method: string, input: object, options?: { signal?: AbortSignal }): Promise<T> => {
    if (!validHistoryResourceCall(method, input)) throw new Error('migration_invalid_parameters')
    const result = await invoke<T>(method, input, options)
    if (!validHistoryResourceCall(method, input, result)) throw new Error('migration_invalid_response')
    return result
  }
  return {
    historyResourcesRead: (input: C.MigrationHistoryResourceReadParams, options?: { signal?: AbortSignal }) => call<C.MigrationHistoryResourceResult>(HISTORY_RESOURCE_METHODS.read, input, options),
    historyResourcesIncrease: (input: C.MigrationHistoryResourceIncreaseParams) => call<C.MigrationResourceIncreaseReceipt>(HISTORY_RESOURCE_METHODS.increase, input),
    historyResourcesAttach: (input: C.MigrationHistoryResourceAttachParams) => call<C.MigrationHistoryResourceResult>(HISTORY_RESOURCE_METHODS.attach, input),
    batchResourcesAttach: (input: C.MigrationHistoryParentResourceAttachParams) => call<C.MigrationResourceBudgetView>(HISTORY_RESOURCE_METHODS.parentAttach, input),
  }
}
