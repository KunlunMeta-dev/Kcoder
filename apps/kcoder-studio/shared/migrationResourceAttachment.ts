import * as C from './generated/contracts'
import { HISTORY_RESOURCE_METHODS, validHistoryResourceCall } from './migrationHistoryResourceBudget'
import { validResourceFacts } from './migrationResourceBudget'

export const RESOURCE_ATTACHMENT_CAPABILITY = 'migrationHistoryResourceAttachmentV1'
export const RESOURCE_ATTACHMENT_METHODS = {
  history: 'migration/history/resources/attachment/read',
  batch: 'migration/batch/resources/attachment/read',
} as const
export const resourceAttachmentMethod = (method: string) => Object.values(RESOURCE_ATTACHMENT_METHODS).some(value => value === method)
const atom = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
export type AttachmentKind = keyof typeof RESOURCE_ATTACHMENT_METHODS
export type AttachmentIntent = (C.MigrationHistoryResourceAttachParams | C.MigrationHistoryParentResourceAttachParams) & { expectedSequence: number; confirm: true; limits: C.MigrationResourceLimitFacts }
export function validAttachmentIntent(kind: AttachmentKind, value: unknown): value is AttachmentIntent {
  return validHistoryResourceCall(kind === 'history' ? HISTORY_RESOURCE_METHODS.attach : HISTORY_RESOURCE_METHODS.parentAttach, value)
}
/** The original attachment intent is distinct from a current job watermark or policy. */
export function validResourceAttachment(method: string, params: unknown, result?: unknown): boolean {
  if (!resourceAttachmentMethod(method) || !C.isMigrationHistoryResourceAttachmentReadParams(params) || !atom(params.jobId)) return false
  if (arguments.length < 3) return true
  if (!C.isMigrationHistoryResourceAttachmentResult(result) || result.jobId !== params.jobId || !integer(result.currentSequence)
    || result.ownerJobId !== null && !atom(result.ownerJobId) || result.currentPlanId !== null && !atom(result.currentPlanId)
    || result.issueCode !== null && !/^[a-z_]{1,128}$/.test(result.issueCode)) return false
  const parent = method === RESOURCE_ATTACHMENT_METHODS.batch, intent = result.originalIntent
  if (intent && (!integer(intent.expectedSequence) || intent.expectedSequence > result.currentSequence || !validResourceFacts(intent.initialLimits)
    || (parent ? !atom(intent.planId) || intent.planId !== result.currentPlanId : intent.planId !== null))) return false
  if (result.phase === 'parent_owned') return !parent && !!result.ownerJobId && result.ownerJobId !== params.jobId && intent === null
  if (['untracked', 'pending', 'attached', 'tracked'].includes(result.phase) && result.ownerJobId !== params.jobId) return false
  if (['pending', 'attached'].includes(result.phase)) return intent !== null && result.issueCode === null
  if (['untracked', 'tracked', 'not_applicable'].includes(result.phase)) return intent === null && result.issueCode === null
  return result.phase === 'unknown' && result.issueCode !== null
}
type Invoke = <T>(method: string, input: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createResourceAttachmentApi(invoke: Invoke) {
  const read = async (method: string, input: C.MigrationHistoryResourceAttachmentReadParams, options?: { signal?: AbortSignal }) => {
    if (!validResourceAttachment(method, input)) throw Error('migration_invalid_parameters')
    const result = await invoke<C.MigrationHistoryResourceAttachmentResult>(method, input, options)
    if (!validResourceAttachment(method, input, result)) throw Error('migration_invalid_response')
    return result
  }
  return {
    historyResourceAttachmentRead: (input: C.MigrationHistoryResourceAttachmentReadParams, options?: { signal?: AbortSignal }) => read(RESOURCE_ATTACHMENT_METHODS.history, input, options),
    batchResourceAttachmentRead: (input: C.MigrationHistoryResourceAttachmentReadParams, options?: { signal?: AbortSignal }) => read(RESOURCE_ATTACHMENT_METHODS.batch, input, options),
  }
}
