import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationLocalAttachment } from './useMigrationLocalAttachment'
import { notifyAccountContextChange } from './accountContextEvents'
import type { MigrationLocalAttachmentStateResult } from '../../../shared/generated/contracts'

const { api } = vi.hoisted(() => ({ api: Object.fromEntries([
  'localAttachmentList','localAttachmentPrepare','localAttachmentRead','localAttachmentBegin',
  'localAttachmentPart','localAttachmentFinish','localAttachmentRun','localAttachmentResume','localAttachmentCancel',
].map(name => [name, vi.fn()])) }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))
const context = { deviceId: 'target', workspacePath: '/owned', jobId: 'history', viewId: 'branch', isCurrent: () => true }
function state(id = 'operation'): MigrationLocalAttachmentStateResult {
  return { upload: { operationId: id, selection: { jobId: 'history', viewId: 'branch', position: 0, blockIndex: 1 },
    sequence: 0, stage: 'prepared', filename: null, bytes: null, sha256: null, receivedBytes: 0,
    receivedParts: 0, partBytes: 196608, cancelRequested: false, cancelRevision: 0,
    failureCode: null, localJob: null }, workerRunning: false, workerError: null }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.localAttachmentList.mockResolvedValue({ items: [], nextCursor: null })
  api.localAttachmentPrepare.mockImplementation(async ({ requestId }) => state(requestId))
  api.localAttachmentRead.mockImplementation(async ({ operationId }) => state(operationId))
  api.localAttachmentCancel.mockImplementation(async ({ operationId }) => ({ ...state(operationId),
    upload: { ...state(operationId).upload, sequence: 1, stage: 'cancelled', cancelRequested: true, cancelRevision: 1 } }))
})

test('opening a historical local reference only lists prior operations and never selects or starts one', async () => {
  api.localAttachmentList.mockResolvedValue({ items: [state().upload], nextCursor: null })
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  expect(result.current.state).toBeNull()
  for (const method of ['localAttachmentPrepare','localAttachmentRead','localAttachmentBegin','localAttachmentRun'])
    expect(api[method]).not.toHaveBeenCalled()
})

test('native upload error codes survive diagnosis without replaying the operation', async () => {
  api.localAttachmentPrepare.mockRejectedValue(new Error('local_upload_owner_changed'))
  api.localAttachmentRead.mockRejectedValue(new Error('local_upload_not_found'))
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  await act(() => result.current.prepare())
  expect(result.current.error).toBe('local_upload_owner_changed')
  expect(api.localAttachmentPrepare).toHaveBeenCalledTimes(1)
  expect(api.localAttachmentBegin).not.toHaveBeenCalled()
})

test('explicit preparation fixes an identity before any file or copy operation', async () => {
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  await act(() => result.current.prepare())
  const params = api.localAttachmentPrepare.mock.calls[0][0]
  expect(params.requestId).toMatch(/^[a-f0-9-]{36}$/)
  expect(params.selection).toEqual(state().upload.selection)
  expect(result.current.state?.upload.operationId).toBe(params.requestId)
  expect(api.localAttachmentBegin).not.toHaveBeenCalled()
  expect(api.localAttachmentRun).not.toHaveBeenCalled()
})

test('switching the historical source discards a late preparation receipt and never reconciles into the new source', async () => {
  let resolve!: (value: MigrationLocalAttachmentStateResult) => void
  api.localAttachmentPrepare.mockImplementation(() => new Promise(done => { resolve = done }))
  const { result, rerender } = renderHook(({ source }) => useMigrationLocalAttachment(source, 0, 1),
    { initialProps: { source: context } })
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  let pending!: Promise<boolean>
  act(() => { pending = result.current.prepare() })
  const id = api.localAttachmentPrepare.mock.calls[0][0].requestId
  rerender({ source: { ...context, jobId: 'other-history' } })
  await act(async () => { resolve(state(id)); await pending })
  expect(result.current.state).toBeNull()
  expect(api.localAttachmentRead).not.toHaveBeenCalled()
  expect(api.localAttachmentRun).not.toHaveBeenCalled()
})

test('account invalidation fences the entire upload action, including reconciliation', async () => {
  let reject!: (value: Error) => void
  api.localAttachmentPrepare.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  let pending!: Promise<boolean>
  act(() => { pending = result.current.prepare() })
  notifyAccountContextChange('target')
  await act(async () => { reject(new Error('reply_lost')); await pending })
  expect(result.current.state).toBeNull()
  expect(api.localAttachmentRead).not.toHaveBeenCalled()
  expect(api.localAttachmentBegin).not.toHaveBeenCalled()
})

test('cancellation remains available while hashing an outstanding File read', async () => {
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  await act(() => result.current.prepare())
  let release!: (bytes: ArrayBuffer) => void
  const read = vi.fn(() => new Promise<ArrayBuffer>(done => { release = done }))
  const file = { name: 'notes.txt', size: 3, slice: () => ({ arrayBuffer: read }) } as unknown as File
  let pending!: Promise<boolean>
  act(() => { pending = result.current.upload(file) })
  await waitFor(() => expect(read).toHaveBeenCalled())
  await act(() => result.current.cancel())
  await act(async () => { release(new Uint8Array([1, 2, 3]).buffer); await pending })
  expect(api.localAttachmentCancel).toHaveBeenCalledTimes(1)
  expect(api.localAttachmentBegin).not.toHaveBeenCalled()
  expect(api.localAttachmentFinish).not.toHaveBeenCalled()
  expect(result.current.state?.upload.stage).toBe('cancelled')
  expect(result.current.busy).toBe(false)
})

test('a lost preparation receipt is observed with its canonical ID and never automatically runs', async () => {
  api.localAttachmentPrepare.mockRejectedValue(new Error('reply_lost'))
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  await act(() => result.current.prepare())
  const id = api.localAttachmentPrepare.mock.calls[0][0].requestId
  expect(api.localAttachmentRead).toHaveBeenCalledExactlyOnceWith({ operationId: id })
  expect(result.current.state?.upload.operationId).toBe(id)
  expect(api.localAttachmentBegin).not.toHaveBeenCalled()
  expect(api.localAttachmentRun).not.toHaveBeenCalled()
  api.localAttachmentPrepare.mockImplementation(async ({ requestId }) => state(requestId))
  await act(() => result.current.prepare())
  expect(api.localAttachmentPrepare.mock.calls[1][0].requestId).not.toBe(id)
  expect(api.localAttachmentRead).toHaveBeenCalledTimes(1)
})

test('a complete owned upload can be explicitly finalized after reopening without the original File', async () => {
  const complete = { ...state(), upload: { ...state().upload, stage: 'receiving', sequence: 3,
    filename: 'now-missing.txt', bytes: 3, sha256: 'a'.repeat(64), receivedBytes: 3, receivedParts: 1 } }
  api.localAttachmentRead.mockResolvedValue(complete)
  api.localAttachmentFinish.mockResolvedValue({ ...complete, workerRunning: true,
    upload: { ...complete.upload, sequence: 4, stage: 'assembling' } })
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  await act(() => result.current.open('operation'))
  expect(api.localAttachmentFinish).not.toHaveBeenCalled()
  await act(() => result.current.finalize())
  expect(api.localAttachmentFinish).toHaveBeenCalledExactlyOnceWith({ operationId: 'operation', expectedSequence: 3 })
  expect(api.localAttachmentBegin).not.toHaveBeenCalled()
  expect(api.localAttachmentPart).not.toHaveBeenCalled()
  expect(api.localAttachmentRun).not.toHaveBeenCalled()
  expect(result.current.state?.workerRunning).toBe(true)
})
