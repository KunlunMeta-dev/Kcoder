import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationUndo } from './useMigrationUndo'
import { notifyAccountContextChange } from './accountContextEvents'
const { api } = vi.hoisted(() => ({
  api: {
    undoLookup: vi.fn(),
    undoPreview: vi.fn(),
    undoRead: vi.fn(),
    undoCreate: vi.fn(),
    undoRun: vi.fn(),
    undoCancel: vi.fn(),
  },
}))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const job = {
  jobId: 'canonical',
  continuationJobId: 'source',
  sessionId: 'Ab123',
  sequence: 2,
  stage: 'planned',
  checkedBytes: 0,
  cancelRequested: false,
  cancelRevision: 0,
  failureCode: null,
  archivesRetained: true,
  attachmentsRetained: true,
}
const value = (changes: object = {}, workerRunning = false) => ({
  job: { ...job, ...changes },
  workerRunning,
  workerError: null,
})
const preview = {
  continuationJobId: 'source',
  sessionId: 'Ab123',
  canUndo: true,
  reasonCode: null,
  existingJob: null,
  archivesRetained: true,
  attachmentsRetained: true,
}
beforeEach(() => {
  vi.resetAllMocks()
  api.undoLookup.mockResolvedValue({ existingJob: null })
  api.undoPreview.mockResolvedValue(preview)
  api.undoCreate.mockResolvedValue(value())
  api.undoRun.mockResolvedValue(value({ stage: 'undone', sequence: 4 }))
  api.undoRead.mockResolvedValue(value({ stage: 'undone', sequence: 4 }))
})
test('mount restores only lightweight source-owned records and never locks or mutates a native session', async () => {
  const { result } = renderHook(() => useMigrationUndo('target', '/owned', 'source', 9, () => true))
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(api.undoLookup).toHaveBeenCalledExactlyOnceWith(
    { continuationJobId: 'source' },
    { signal: expect.any(AbortSignal) }
  )
  expect(api.undoPreview).not.toHaveBeenCalled()
  expect(api.undoCreate).not.toHaveBeenCalled()
  expect(api.undoRun).not.toHaveBeenCalled()
})
test('a saved undone operation is read from the server without a local cache', async () => {
  api.undoLookup.mockResolvedValue({ existingJob: { ...job, stage: 'undone', sequence: 4 } })
  const { result } = renderHook(() =>
    useMigrationUndo('target', undefined, 'source', 9, () => true)
  )
  await waitFor(() => expect(result.current.result?.job.stage).toBe('undone'))
  expect(api.undoRead).toHaveBeenCalledWith(
    { jobId: 'canonical' },
    { signal: expect.any(AbortSignal) }
  )
  expect(api.undoPreview).not.toHaveBeenCalled()
  expect(api.undoCreate).not.toHaveBeenCalled()
})
test('explicit confirmation uses the canonical returned operation and latest expected sequence', async () => {
  const { result } = renderHook(() => useMigrationUndo('target', '/owned', 'source', 9, () => true))
  await waitFor(() => expect(result.current.ready).toBe(true))
  await act(() => result.current.prepare())
  expect(api.undoCreate).not.toHaveBeenCalled()
  expect(result.current.preview?.canUndo).toBe(true)
  await act(() => result.current.start())
  expect(api.undoCreate).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    continuationJobId: 'source',
    expectedContinuationSequence: 9,
  })
  expect(api.undoRun).toHaveBeenCalledExactlyOnceWith({ jobId: 'canonical', expectedSequence: 2 })
  expect(result.current.result?.job.stage).toBe('undone')
})
test('a lost creation acknowledgement only reads authority and never automatically repeats the write', async () => {
  api.undoCreate.mockRejectedValue(new Error('transport lost'))
  const { result } = renderHook(() =>
    useMigrationUndo('target', undefined, 'source', 9, () => true)
  )
  await waitFor(() => expect(result.current.ready).toBe(true))
  api.undoLookup.mockResolvedValue({
    existingJob: { ...job, stage: 'outcome_unknown', sequence: 3 },
  })
  api.undoRead.mockResolvedValue(value({ stage: 'outcome_unknown', sequence: 3 }))
  await act(() => result.current.start())
  expect(api.undoCreate).toHaveBeenCalledOnce()
  expect(api.undoRun).not.toHaveBeenCalled()
  expect(result.current.result?.job.stage).toBe('outcome_unknown')
})
test('account changes discard a late mutation response and all previous private job state', async () => {
  let finish!: (value: unknown) => void
  api.undoCreate.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const { result } = renderHook(() => useMigrationUndo('target', '/owned', 'source', 9, () => true))
  await waitFor(() => expect(result.current.ready).toBe(true))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.start()
  })
  await waitFor(() => expect(api.undoCreate).toHaveBeenCalledOnce())
  act(() => notifyAccountContextChange('target'))
  expect(result.current.result).toBeNull()
  await act(async () => {
    finish(value())
    await pending
  })
  expect(result.current.result).toBeNull()
  expect(api.undoRun).not.toHaveBeenCalled()
})
test('wrong-source or invalid server results cannot become a confirmed undo', async () => {
  api.undoCreate.mockResolvedValue(value({ continuationJobId: 'other' }))
  const { result } = renderHook(() =>
    useMigrationUndo('target', undefined, 'source', 9, () => true)
  )
  await waitFor(() => expect(result.current.ready).toBe(true))
  await act(() => result.current.start())
  expect(result.current.error).toBe('migration_invalid_result')
  expect(result.current.result).toBeNull()
  expect(api.undoRun).not.toHaveBeenCalled()
})
