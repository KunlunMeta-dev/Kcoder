import {
  isMigrationBatchControlReadParams, isMigrationBatchControlCancelParams, isMigrationBatchControlResult,
  type MigrationBatchControlReadParams, type MigrationBatchControlCancelParams,
  type MigrationBatchControlResult, type MigrationBatchCancellationReceipt,
} from './generated/contracts'

export const BATCH_CONTROL_CAPABILITY = 'migrationBatchControlV1'
export const BATCH_CONTROL_METHODS = {
  read: 'migration/batch/control/read', cancel: 'migration/batch/control/cancel',
} as const
export const batchControlMethod = (method: string) => Object.values(BATCH_CONTROL_METHODS).some(value => value === method)
const id = (value: string, max = 128) => /^[A-Za-z0-9_.:-]+$/.test(value) && value.length <= max
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const seq = (value: number) => Number.isSafeInteger(value) && value >= 0
const same = (a: { planId: string; runRequestId: string; admissionSequence: number }, b: typeof a) =>
  a.planId === b.planId && a.runRequestId === b.runRequestId && a.admissionSequence === b.admissionSequence

/** No progress revision or worker projection grants authority to cancel another runner. */
export function validBatchControlCall(method: string, input: unknown, value?: unknown): boolean {
  if (!batchControlMethod(method)) return false
  if (method === BATCH_CONTROL_METHODS.read) {
    if (!isMigrationBatchControlReadParams(input) || !id(input.jobId) || input.commandId != null && !uuid(input.commandId)) return false
  } else if (!isMigrationBatchControlCancelParams(input) || !id(input.jobId) || !id(input.planId) || !id(input.runRequestId, 256)
    || !seq(input.admissionSequence) || input.admissionSequence === 0 || !uuid(input.commandId)) return false
  if (arguments.length < 3) return true
  const params = input as MigrationBatchControlReadParams | MigrationBatchControlCancelParams
  if (!isMigrationBatchControlResult(value) || value.jobId !== params.jobId || !seq(value.currentSequence)
    || value.planId !== null && !id(value.planId)) return false
  const generation = value.generation
  if ((value.phase === 'tracked') !== (generation !== null)) return false
  if (generation && (generation.planId !== value.planId || !id(generation.planId) || !id(generation.runRequestId, 256)
    || !seq(generation.admissionSequence) || generation.admissionSequence < 1 || generation.admissionSequence > value.currentSequence)) return false
  const receiptValid = (receipt: MigrationBatchCancellationReceipt) => uuid(receipt.commandId)
    && id(receipt.planId) && id(receipt.runRequestId, 256) && seq(receipt.admissionSequence) && receipt.admissionSequence > 0
    && seq(receipt.acceptedSequence) && receipt.acceptedSequence >= receipt.admissionSequence && receipt.acceptedSequence <= value.currentSequence
  if (value.lastCancellation && (!receiptValid(value.lastCancellation) || !generation || !same(value.lastCancellation, generation))) return false
  if (value.requestedReceipt && (!receiptValid(value.requestedReceipt) || value.requestedReceipt.commandId !== params.commandId)) return false
  if (method === BATCH_CONTROL_METHODS.cancel && (!value.requestedReceipt || !same(value.requestedReceipt, input as MigrationBatchControlCancelParams))) return false
  return true
}

type Invoke = <T>(method: string, input: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createBatchControlApi(invoke: Invoke) {
  const call = async (method: string, input: object, options?: { signal?: AbortSignal }) => {
    if (!validBatchControlCall(method, input)) throw new Error('migration_invalid_parameters')
    const value = await invoke<MigrationBatchControlResult>(method, input, options)
    if (!validBatchControlCall(method, input, value)) throw new Error('migration_invalid_response')
    return value
  }
  return {
    batchControlRead: (input: MigrationBatchControlReadParams, options?: { signal?: AbortSignal }) => call(BATCH_CONTROL_METHODS.read, input, options),
    batchControlCancel: (input: MigrationBatchControlCancelParams) => call(BATCH_CONTROL_METHODS.cancel, input),
  }
}

export interface BatchControlApi {
  batchControlRead(input: MigrationBatchControlReadParams): Promise<MigrationBatchControlResult>
  batchControlCancel(input: MigrationBatchControlCancelParams): Promise<MigrationBatchControlResult>
}

/** Unknown sends are reconciled with the original UUID. This controller never retries a write. */
export class BatchCancellationControl {
  private readonly pending = new Map<string, MigrationBatchControlCancelParams>()
  hasPending(jobId: string): boolean { return this.pending.has(jobId) }
  private readonly commandId: () => string
  private readonly boundApi?: BatchControlApi
  constructor(commandId: () => string, boundApi?: BatchControlApi) { this.commandId = commandId; this.boundApi = boundApi }
  async cancel(api: BatchControlApi, jobId: string, planId: string, assertCurrent: () => void): Promise<MigrationBatchControlResult | null> {
    assertCurrent()
    if (this.boundApi && this.boundApi !== api) throw new Error('migration_scope_changed')
    const previous = this.pending.get(jobId)
    const state = await api.batchControlRead({ jobId, ...(previous ? { commandId: previous.commandId } : {}) })
    assertCurrent()
    if (!validBatchControlCall(BATCH_CONTROL_METHODS.read, { jobId, ...(previous ? { commandId: previous.commandId } : {}) }, state)) throw new Error('migration_invalid_response')
    if (previous) {
      if (!state.requestedReceipt || !same(state.requestedReceipt, previous)) throw new Error('migration_batch_cancel_unconfirmed')
      this.pending.delete(jobId)
      return state
    }
    if ((state.planId ?? '') !== planId) throw new Error('migration_batch_control_changed')
    if (state.phase === 'unadmitted') return null
    if (!state.generation || state.generation.mode === 'rollback') throw new Error('migration_batch_control_unknown')
    if (state.lastCancellation) return state
    const intent = { jobId, planId, runRequestId: state.generation.runRequestId, admissionSequence: state.generation.admissionSequence, commandId: this.commandId() }
    if (!validBatchControlCall(BATCH_CONTROL_METHODS.cancel, intent)) throw new Error('migration_invalid_parameters')
    if (this.pending.size >= 256) throw new Error('migration_batch_control_capacity_reached')
    this.pending.set(jobId, intent)
    try {
      assertCurrent()
      const result = await api.batchControlCancel(intent)
      assertCurrent()
      if (!validBatchControlCall(BATCH_CONTROL_METHODS.cancel, intent, result)) throw new Error('migration_invalid_response')
      this.pending.delete(jobId)
      return result
    } catch (error) {
      assertCurrent()
      // The original Native receipt may exist even when the mutation response was lost.
      const observed = await api.batchControlRead({ jobId, commandId: intent.commandId })
      assertCurrent()
      if (!validBatchControlCall(BATCH_CONTROL_METHODS.read, { jobId, commandId: intent.commandId }, observed)
        || !observed.requestedReceipt || !same(observed.requestedReceipt, intent)) throw error
      this.pending.delete(jobId)
      return observed
    }
  }
}
