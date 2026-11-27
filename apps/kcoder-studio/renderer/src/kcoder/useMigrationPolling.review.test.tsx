import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationUndo } from './useMigrationUndo'
import { useMigrationContinuation } from './useMigrationContinuation'

const { api } = vi.hoisted(() => ({ api: {
  undoLookup: vi.fn(), undoRead: vi.fn(), undoPreview: vi.fn(), undoCreate: vi.fn(), undoRun: vi.fn(), undoCancel: vi.fn(),
  continuationRead: vi.fn(), continuationCreate: vi.fn(), continuationRun: vi.fn(), continuationResume: vi.fn(), continuationCancel: vi.fn(),
} }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))

const undoJob = { jobId: 'canonical-undo', continuationJobId: 'source', sessionId: 'ThreadA', sequence: 5, stage: 'checking', checkedBytes: 12, cancelRequested: false, cancelRevision: 0, failureCode: null, archivesRetained: true, attachmentsRetained: true }
const undoState = (sequence: number, workerRunning: boolean, stage = 'checking') => ({ job: { ...undoJob, sequence, stage }, workerRunning, workerError: null })
const continuationState = (sequence: number, workerRunning: boolean, stage = 'preparing') => ({ job: { jobId: 'continuation-a', sourceJobId: 'archive', viewId: 'branch', sequence, stage, cancelRevision: 0, cancelRequested: false, threadId: null }, workerRunning, workerError: null })
beforeEach(() => { vi.resetAllMocks(); localStorage.clear() })

test('an older stopped undo poll cannot strand a newer running canonical checkpoint', async () => {
  api.undoLookup.mockResolvedValue({ existingJob: undoJob })
  let finish!: (value: unknown) => void
  api.undoRead.mockResolvedValueOnce(undoState(5, true))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(undoState(7, true))
    .mockResolvedValue(undoState(8, false, 'undone'))
  const { result } = renderHook(() => useMigrationUndo('owned-target', '/owned', 'source', 9, () => true))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await act(() => result.current.refresh())
  expect(result.current.result?.job.sequence).toBe(7)
  await act(async () => { finish(undoState(5, false)); await Promise.resolve() })
  await waitFor(() => expect(result.current.result?.job.stage).toBe('undone'), { timeout: 1600 })
  expect(api.undoCreate).not.toHaveBeenCalled()
  expect(api.undoRun).not.toHaveBeenCalled()
})

test('an older stopped continuation poll cannot strand a newer running native import checkpoint', async () => {
  localStorage.setItem('kcoder.migration.continuation:["owned-target","/owned","archive","branch"]', 'continuation-a')
  let finish!: (value: unknown) => void
  api.continuationRead.mockResolvedValueOnce(continuationState(5, true))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(continuationState(7, true))
    .mockResolvedValue(continuationState(8, false, 'imported'))
  const { result } = renderHook(() => useMigrationContinuation('owned-target', '/owned', 'archive', 'branch', () => true))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await act(() => result.current.refresh())
  expect(result.current.result?.job.sequence).toBe(7)
  await act(async () => { finish(continuationState(5, false)); await Promise.resolve() })
  await waitFor(() => expect(result.current.result?.job.stage).toBe('imported'), { timeout: 1600 })
  expect(api.continuationCreate).not.toHaveBeenCalled()
  expect(api.continuationRun).not.toHaveBeenCalled()
})
