import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationAttachment } from './useMigrationAttachment'
const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    [
      'historyAttachmentRead',
      'historyAttachmentRun',
      'historyAttachmentResume',
      'historyAttachmentCancel',
      'historyAttachmentChunk',
    ].map(v => [v, vi.fn()])
  ),
}))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const empty = { job: null, workerRunning: false, workerError: null }
const context = {
  deviceId: 'target',
  workspacePath: '/owned',
  jobId: 'archive',
  viewId: 'view',
  isCurrent: () => true,
}
const active = {
  job: {
    id: 'job',
    sequence: 1,
    stage: 'inspecting',
    processedBytes: 0,
    info: null,
    failureCode: null,
    cancelRequested: false,
  },
  workerRunning: true,
  workerError: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  api.historyAttachmentRead.mockResolvedValue(empty)
  api.historyAttachmentRun.mockResolvedValue(active)
})
test('attachment processing starts explicitly with the selected branch coordinates', async () => {
  const { result } = renderHook(() => useMigrationAttachment(context, 2, 3))
  await waitFor(() => expect(result.current.result).toEqual(empty))
  expect(api.historyAttachmentRun).not.toHaveBeenCalled()
  await act(() => result.current.run())
  expect(api.historyAttachmentRun).toHaveBeenCalledExactlyOnceWith({
    selection: { jobId: 'archive', viewId: 'view', position: 2, blockIndex: 3 },
  })
})
test('a lost receipt observes the same selection instead of replaying the operation', async () => {
  const { result } = renderHook(() => useMigrationAttachment(context, 2, 3))
  await waitFor(() => expect(result.current.result).toEqual(empty))
  api.historyAttachmentRun.mockRejectedValue(new Error('lost'))
  api.historyAttachmentRead.mockResolvedValue(active)
  await act(() => result.current.run())
  expect(api.historyAttachmentRun).toHaveBeenCalledOnce()
  expect(result.current.result?.workerRunning).toBe(true)
})
test('resume uses the authoritative sequence and stale target responses are discarded', async () => {
  api.historyAttachmentRead.mockResolvedValue({
    ...active,
    workerRunning: false,
    job: { ...active.job, sequence: 8, stage: 'cancelled' },
  })
  let current = true
  const { result } = renderHook(() =>
    useMigrationAttachment({ ...context, isCurrent: () => current }, 2, 3)
  )
  await waitFor(() => expect(result.current.result?.job?.sequence).toBe(8))
  let finish!: (value: unknown) => void
  api.historyAttachmentResume.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  let pending: Promise<unknown>
  await act(async () => {
    pending = result.current.run()
  })
  expect(api.historyAttachmentResume).toHaveBeenCalledExactlyOnceWith({
    selection: { jobId: 'archive', viewId: 'view', position: 2, blockIndex: 3 },
    expectedSequence: 8,
  })
  current = false
  await act(async () => {
    finish({ ...active, job: { ...active.job, sequence: 9 } })
    await pending
  })
  expect(result.current.result?.job?.sequence).toBe(8)
})

test('a late poll cannot clear a newer cancellation acknowledged at the same job sequence', async () => {
  const running = { ...active, job: { ...active.job, sequence: 6, cancelRevision: 0 } }
  api.historyAttachmentRead.mockResolvedValueOnce(running)
  let finish!: (value: unknown) => void
  api.historyAttachmentRead.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const { result } = renderHook(() => useMigrationAttachment(context, 2, 3))
  await waitFor(() => expect(result.current.result?.job?.sequence).toBe(6))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  api.historyAttachmentCancel.mockResolvedValue({
    ...running,
    job: { ...running.job, cancelRevision: 1, cancelRequested: true },
  })
  await act(() => result.current.cancel())
  await act(async () => {
    finish(running)
    await Promise.resolve()
  })
  expect(result.current.result?.job?.cancelRevision).toBe(1)
  expect(result.current.result?.job?.cancelRequested).toBe(true)
})

test('tool item zero is preserved in the selected coordinates', async () => {
  const { result } = renderHook(() =>
    useMigrationAttachment({ ...context, toolAttachments: true, toolItemIndex: 0 }, 2, 3)
  )
  await waitFor(() => expect(result.current.result).toEqual(empty))
  await act(() => result.current.run())
  expect(api.historyAttachmentRun).toHaveBeenCalledExactlyOnceWith({
    selection: { jobId: 'archive', viewId: 'view', position: 2, blockIndex: 3, toolItemIndex: 0 },
  })
})
