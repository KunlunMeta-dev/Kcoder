import { describe, expect, it, vi } from 'vitest'
import { BatchCancellationControl, BATCH_CONTROL_METHODS, validBatchControlCall } from '../../../shared/migrationBatchControl'
import type { MigrationBatchControlResult, MigrationBatchControlCancelParams, MigrationBatchControlReadParams } from '../../../shared/generated/contracts'

const commandId = '40000000-0000-4000-8000-000000000001'
const generation = { planId: 'plan', runRequestId: 'original-run', admissionSequence: 3, mode: 'apply' as const }
const observed = (): MigrationBatchControlResult => ({ jobId: 'job', currentSequence: 14, planId: 'plan', phase: 'tracked', generation,
  cancelRequested: false, lastCancellation: null, requestedReceipt: null })
function accepted(input: MigrationBatchControlCancelParams): MigrationBatchControlResult {
  const receipt = { commandId: input.commandId, planId: input.planId, runRequestId: input.runRequestId, admissionSequence: input.admissionSequence }
  return { ...observed(), currentSequence: 28, cancelRequested: true,
    lastCancellation: { ...receipt, acceptedSequence: 25 }, requestedReceipt: { ...receipt, acceptedSequence: 25 } }
}

describe('original execution cancellation', () => {
  it('uses the admission identity while progress revisions advance, and never projects worker stopped', async () => {
    const api = { batchControlRead: vi.fn(async () => observed()), batchControlCancel: vi.fn(async (input: MigrationBatchControlCancelParams) => accepted(input)) }
    const result = await new BatchCancellationControl(() => commandId).cancel(api, 'job', 'plan', () => {})
    expect(api.batchControlCancel).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', planId: 'plan', runRequestId: 'original-run', admissionSequence: 3, commandId })
    expect(result?.currentSequence).toBe(28)
    expect(result).not.toHaveProperty('workerRunning')
  })
  it('lost acknowledgement reconciles the original UUID with reads and sends only one write', async () => {
    let receipt: MigrationBatchControlResult | undefined
    const api = {
      batchControlRead: vi.fn(async (input: MigrationBatchControlReadParams) => receipt ? { ...receipt, requestedReceipt: input.commandId ? receipt.requestedReceipt : null } : observed()),
      batchControlCancel: vi.fn(async (input: MigrationBatchControlCancelParams) => { receipt = accepted(input); throw new Error('transport_lost') }),
    }
    const controller = new BatchCancellationControl(() => commandId)
    expect((await controller.cancel(api, 'job', 'plan', () => {}))?.requestedReceipt?.commandId).toBe(commandId)
    await controller.cancel(api, 'job', 'plan', () => {})
    expect(api.batchControlCancel).toHaveBeenCalledTimes(1)
    expect(api.batchControlRead).toHaveBeenCalledWith({ jobId: 'job', commandId })
  })
  it('an unconfirmed write stays bound to its old UUID when a new runner appears', async () => {
    let current = observed()
    const api = { batchControlRead: vi.fn(async () => current), batchControlCancel: vi.fn(async () => { throw new Error('transport_lost') }) }
    const controller = new BatchCancellationControl(() => commandId)
    await expect(controller.cancel(api, 'job', 'plan', () => {})).rejects.toThrow('transport_lost')
    current = { ...observed(), currentSequence: 50, generation: { ...generation, runRequestId: 'new-resume', admissionSequence: 40, mode: 'resume' } }
    await expect(controller.cancel(api, 'job', 'plan', () => {})).rejects.toThrow('migration_batch_cancel_unconfirmed')
    expect(api.batchControlCancel).toHaveBeenCalledTimes(1)
  })
  it('a scope change during read prevents dispatch', async () => {
    let current = true
    const api = { batchControlRead: vi.fn(async () => { current = false; return observed() }), batchControlCancel: vi.fn() }
    await expect(new BatchCancellationControl(() => commandId).cancel(api, 'job', 'plan', () => { if (!current) throw new Error('migration_scope_changed') })).rejects.toThrow('migration_scope_changed')
    expect(api.batchControlCancel).not.toHaveBeenCalled()
  })
  it('missing legacy authority and changed plans do not derive a generation from current sequence', async () => {
    const api = { batchControlRead: vi.fn(async () => ({ ...observed(), phase: 'legacy_unknown' as const, generation: null })), batchControlCancel: vi.fn() }
    await expect(new BatchCancellationControl(() => commandId).cancel(api, 'job', 'plan', () => {})).rejects.toThrow('migration_batch_control_unknown')
    api.batchControlRead.mockResolvedValue({ ...observed(), planId: 'peer-plan' } as never)
    await expect(new BatchCancellationControl(() => commandId).cancel(api, 'job', 'plan', () => {})).rejects.toThrow('migration_invalid_response')
    expect(api.batchControlCancel).not.toHaveBeenCalled()
  })
  it('unadmitted null plans retain the original CAS path without admitting unknown legacy authority', async () => {
    let state: MigrationBatchControlResult = { ...observed(), phase: 'unadmitted', planId: null, generation: null }
    const api = { batchControlRead: vi.fn(async () => state), batchControlCancel: vi.fn() }
    const controller = new BatchCancellationControl(() => commandId)
    expect(await controller.cancel(api, 'job', '', () => {})).toBeNull()
    state = { ...state, phase: 'legacy_unknown' }
    await expect(controller.cancel(api, 'job', '', () => {})).rejects.toThrow('migration_batch_control_unknown')
    state = { ...state, phase: 'unadmitted', planId: 'another-real-plan' }
    await expect(controller.cancel(api, 'job', '', () => {})).rejects.toThrow('migration_batch_control_changed')
    expect(api.batchControlCancel).not.toHaveBeenCalled()
  })
  it('rejects peer receipts, unsafe revisions and missing proof instead of accepting partial success', () => {
    const input = { jobId: 'job', planId: 'plan', runRequestId: 'original-run', admissionSequence: 3, commandId }
    expect(validBatchControlCall(BATCH_CONTROL_METHODS.cancel, input, accepted(input))).toBe(true)
    expect(validBatchControlCall(BATCH_CONTROL_METHODS.cancel, input, { ...accepted(input), requestedReceipt: null })).toBe(false)
    expect(validBatchControlCall(BATCH_CONTROL_METHODS.cancel, input, { ...accepted(input), jobId: 'peer' })).toBe(false)
    expect(validBatchControlCall(BATCH_CONTROL_METHODS.read, { jobId: 'job' }, { ...observed(), currentSequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(validBatchControlCall(BATCH_CONTROL_METHODS.read, { jobId: 'job' }, { ...observed(), generation: null })).toBe(false)
  })
})
