import { downloadMigrationAttachment } from './migrationAttachmentDownload'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationUploadCollection } from './useMigrationUploadCollection'
const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    [
      'uploadCollectionAttachment',
      'localAttachmentChunk',
      'uploadCollectionPrepare',
      'uploadCollectionRead',
      'uploadCollectionList',
      'uploadCollectionRun',
      'uploadCollectionCancel',
      'uploadCollectionResume',
      'localAttachmentRead',
    ].map(name => [name, vi.fn()])
  ),
}))
vi.mock('./migrationAttachmentDownload', () => ({
  downloadMigrationAttachment: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const selection = { jobId: 'history', position: 0, blockIndex: 1 }
const context = { deviceId: 'target', jobId: 'history', isCurrent: () => true }
const upload = { operationId: 'owned', selection, sequence: 5 } as never
const collection = (sequence = 1, changes = {}) => ({
  operationId: 'owned',
  selection,
  collectionId: 'a'.repeat(64),
  sequence,
  uploadSequence: 5,
  stage: 'prepared',
  cancelRequested: false,
  cancelRevision: 0,
  storageRetired: false,
  deletedBytes: 0,
  releasedReservationBytes: 0,
  failureCode: null,
  ...changes,
})
const state = (sequence = 1, changes = {}) => ({
  collection: collection(sequence, changes),
  workerRunning: false,
  workerScheduled: false,
  workerError: null,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.uploadCollectionList.mockResolvedValue({ items: [], nextCursor: null })
  api.uploadCollectionPrepare.mockResolvedValue(state())
  api.uploadCollectionRead.mockResolvedValue(state())
  api.localAttachmentRead.mockResolvedValue({
    upload: { ...(upload as object), operationId: 'owned', selection, sequence: 5 },
  })
})
test('mount and reopen only read; preparing never runs or deletes', async () => {
  const { result } = renderHook(() => useMigrationUploadCollection(context, selection, upload))
  await waitFor(() => expect(api.uploadCollectionList).toHaveBeenCalledOnce())
  expect(api.uploadCollectionPrepare).not.toHaveBeenCalled()
  await act(() => result.current.prepare())
  await waitFor(() => expect(result.current.result?.collection?.sequence).toBe(1))
  expect(api.uploadCollectionPrepare).toHaveBeenCalledOnce()
  expect(api.uploadCollectionRun).not.toHaveBeenCalled()
  expect(api.uploadCollectionResume).not.toHaveBeenCalled()
})
test('changing target while checking upload prevents dispatch of the prepared mutation', async () => {
  const pending = deferred<{ upload: { operationId: string; selection: typeof selection; sequence: number } }>()
  api.localAttachmentRead.mockReturnValue(pending.promise)
  const { result, rerender } = renderHook(
    ({ target }) => useMigrationUploadCollection(target, selection, upload),
    { initialProps: { target: context } }
  )
  let prepared!: Promise<boolean>
  act(() => {
    prepared = result.current.prepare()
  })
  await waitFor(() => expect(api.localAttachmentRead).toHaveBeenCalled())
  rerender({ target: { ...context, deviceId: 'other' } })
  await act(async () => {
    pending.resolve({ upload: { operationId: 'owned', selection, sequence: 5 } })
    await prepared
  })
  expect(api.uploadCollectionPrepare).not.toHaveBeenCalled()
  expect(result.current.result).toBeNull()
})
test('cancel stays available during a lost run response and older replies cannot erase its watermark', async () => {
  const pending = deferred<ReturnType<typeof state>>()
  api.uploadCollectionRun.mockReturnValue(pending.promise)
  const cancelled = state(2, { stage: 'cancelled', cancelRequested: true, cancelRevision: 1 })
  api.uploadCollectionCancel.mockImplementation(async () => {
    api.uploadCollectionRead.mockResolvedValue(cancelled)
    return cancelled
  })
  const { result } = renderHook(() => useMigrationUploadCollection(context, selection, upload))
  await act(() => result.current.prepare())
  let running!: Promise<boolean>
  act(() => {
    running = result.current.run(result.current.result!.collection!, 'run')
  })
  await waitFor(() => expect(result.current.busy).toBe(true))
  await act(() => result.current.cancel())
  expect(result.current.result?.collection?.cancelRequested).toBe(true)
  await act(async () => {
    pending.resolve({ ...state(), workerScheduled: true })
    await running
  })
  expect(result.current.result?.collection?.sequence).toBe(2)
  expect(result.current.result?.collection?.cancelRequested).toBe(true)
  expect(api.uploadCollectionRun).toHaveBeenCalledOnce()
})
test('explicit resume checks the current upload but never dispatches run', async () => {
  api.uploadCollectionPrepare.mockResolvedValue(
    state(2, { stage: 'cancelled', cancelRequested: true, cancelRevision: 1 })
  )
  api.uploadCollectionRead.mockResolvedValue(
    state(2, { stage: 'cancelled', cancelRequested: true, cancelRevision: 1 })
  )
  api.uploadCollectionResume.mockResolvedValue(state(3))
  const { result } = renderHook(() => useMigrationUploadCollection(context, selection, upload))
  await act(() => result.current.prepare())
  await act(() => result.current.run(result.current.result!.collection!, 'resume'))
  expect(api.uploadCollectionResume).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedSequence: 2,
      expectedUploadSequence: 5,
      collectionId: 'a'.repeat(64),
    })
  )
  expect(api.uploadCollectionRun).not.toHaveBeenCalled()
})
test('a lost deletion acknowledgement remains unknown and is never automatically submitted again', async () => {
  api.uploadCollectionRun.mockRejectedValue(new Error('local_upload_collection_outcome_unknown'))
  const { result } = renderHook(() => useMigrationUploadCollection(context, selection, upload))
  await act(() => result.current.prepare())
  await act(() => result.current.run(result.current.result!.collection!, 'run'))
  expect(result.current.error).toBe('local_upload_collection_outcome_unknown')
  expect(api.uploadCollectionRun).toHaveBeenCalledOnce()
  expect(api.uploadCollectionResume).not.toHaveBeenCalled()
})

test('a collected record explicitly reads the final Local receipt instead of reviving its retired upload', async () => {
  const ready = state(9, {
    stage: 'collected',
    storageRetired: true,
    deletedBytes: 6,
    releasedReservationBytes: 6,
  })
  api.uploadCollectionPrepare.mockResolvedValue(ready)
  api.uploadCollectionRead.mockResolvedValue(ready)
  const job = {
    selection,
    state: {
      operationId: 'owned',
      stage: 'ready',
      receipt: { attachmentId: 'final', bytes: 3, sha256: 'b'.repeat(64), chunkBytes: 262144 },
    },
    info: { displayName: 'final.txt' },
    historicalContentVerified: false,
  }
  api.uploadCollectionAttachment.mockResolvedValue({ job })
  const { result } = renderHook(() => useMigrationUploadCollection(context, selection, upload))
  await act(() => result.current.prepare())
  await act(() => result.current.save())
  expect(api.uploadCollectionAttachment).toHaveBeenCalledWith(
    { operationId: 'owned', selection },
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  expect(result.current.finalJob).toEqual(job)
  expect(downloadMigrationAttachment).toHaveBeenCalledWith(
    job.state.receipt,
    'final.txt',
    expect.any(Function),
    expect.any(AbortSignal),
    expect.any(Function),
    expect.any(Function)
  )
  expect(api.uploadCollectionRun).not.toHaveBeenCalled()
})
test('closing the reader during a pending final attachment lookup prevents download from the late response', async () => {
  const ready = state(9, { stage: 'collected', storageRetired: true })
  api.uploadCollectionPrepare.mockResolvedValue(ready)
  api.uploadCollectionRead.mockResolvedValue(ready)
  const pending = deferred<{ job: Record<string, never> }>()
  api.uploadCollectionAttachment.mockReturnValue(pending.promise)
  const { result, unmount } = renderHook(() =>
    useMigrationUploadCollection(context, selection, upload)
  )
  await act(() => result.current.prepare())
  let saving!: Promise<boolean>
  act(() => {
    saving = result.current.save()
  })
  await waitFor(() => expect(api.uploadCollectionAttachment).toHaveBeenCalled())
  unmount()
  pending.resolve({ job: {} })
  await saving
  expect(downloadMigrationAttachment).not.toHaveBeenCalled()
})
