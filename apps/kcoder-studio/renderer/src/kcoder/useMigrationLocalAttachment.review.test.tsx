import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { MigrationLocalAttachmentStateResult } from '../../../shared/generated/contracts'
import { useMigrationLocalAttachment } from './useMigrationLocalAttachment'

const { api } = vi.hoisted(() => ({ api: Object.fromEntries([
  'localAttachmentList', 'localAttachmentPrepare', 'localAttachmentRead', 'localAttachmentCancel',
].map(name => [name, vi.fn()])) }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => api }))

const context = { deviceId: 'review-target', workspacePath: '/owned', jobId: 'history',
  viewId: 'branch', isCurrent: () => true }

function prepared(operationId: string): MigrationLocalAttachmentStateResult {
  return { upload: { operationId, selection: { jobId: 'history', viewId: 'branch', position: 0, blockIndex: 1 },
    sequence: 0, stage: 'prepared', filename: null, bytes: null, sha256: null, receivedBytes: 0,
    receivedParts: 0, partBytes: 196608, cancelRequested: false, cancelRevision: 0,
    failureCode: null, localJob: null }, workerRunning: false, workerError: null }
}

beforeEach(() => {
  vi.resetAllMocks()
  api.localAttachmentList.mockResolvedValue({ items: [], nextCursor: null })
  api.localAttachmentPrepare.mockImplementation(async ({ requestId }) => prepared(requestId))
})

test('an earlier cancellation receipt cannot replace a subsequently prepared operation', async () => {
  let cancelled!: (value: MigrationLocalAttachmentStateResult) => void
  api.localAttachmentCancel.mockImplementation(() => new Promise(resolve => { cancelled = resolve }))
  const { result } = renderHook(() => useMigrationLocalAttachment(context, 0, 1))
  await waitFor(() => expect(api.localAttachmentList).toHaveBeenCalled())
  await act(() => result.current.prepare())
  const earlierId = result.current.state!.upload.operationId

  let pendingCancel!: Promise<void>
  act(() => { pendingCancel = result.current.cancel() })
  expect(result.current.busy).toBe(false)
  await act(() => result.current.prepare())
  const currentId = result.current.state!.upload.operationId
  expect(currentId).not.toBe(earlierId)

  await act(async () => {
    const value = prepared(earlierId)
    cancelled({ ...value, upload: { ...value.upload, stage: 'cancelled', sequence: 1,
      cancelRequested: true, cancelRevision: 1 } })
    await pendingCancel
  })
  expect(result.current.state?.upload.operationId).toBe(currentId)
  expect(result.current.state?.upload.stage).toBe('prepared')
})
