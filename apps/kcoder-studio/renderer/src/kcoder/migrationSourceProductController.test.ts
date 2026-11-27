import { beforeEach, expect, it, vi } from 'vitest'
import { createSourceProductController } from './migrationSourceProductController'
import type { createSourceProductApi } from './gatewayMigrationSourceProduct'
import type { SourceUploadState, MigrationSourceProductStateResult } from '../../../shared/generated/contracts'
const upload: SourceUploadState = { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), source: 'codex', totalFiles: 1, totalBytes: 4,
  receivedBytes: 4, verifiedBytes: 4, completedFiles: 1, sequence: 999, cancelWatermark: 888, cancelRequested: false, stage: 'ready', workerState: 'stopped' }
const state = (patch: Partial<SourceUploadState> = {}): MigrationSourceProductStateResult => ({ materialization: { ...upload, sequence: 0, cancelWatermark: 0, verifiedBytes: 0, completedFiles: 0, stage: 'verifying', ...patch } })
function fixture() {
  const api = { sourceProductRun: vi.fn(), sourceProductRead: vi.fn(), sourceProductResume: vi.fn(), sourceProductCancel: vi.fn() }
  const create = () => createSourceProductController({ upload, api: api as ReturnType<typeof createSourceProductApi>, storage: localStorage, scope: 'owned', isCurrent: () => true })
  return { api, create }
}
beforeEach(() => localStorage.clear())
it('uses a separate product epoch, persists before run and reads a lost reply without rerunning the old command', async () => {
  const f = fixture(), manager = f.create()
  f.api.sourceProductRun.mockImplementation(async input => {
    const record = JSON.parse(localStorage.getItem(`kcoder.migration.source-product:owned:${upload.operationId}`)!)
    expect(record.pending.params).toEqual(input)
    throw new Error('accepted reply lost')
  })
  await manager.run()
  expect(f.api.sourceProductRun).toHaveBeenCalledWith({ operationId: upload.operationId, manifestSha256: upload.manifestSha256, expectedSequence: 0, cancelWatermark: 0 })
  manager.dispose(); const reopened = f.create()
  expect(f.api.sourceProductRead).not.toHaveBeenCalled()
  await reopened.run(); expect(f.api.sourceProductRun).toHaveBeenCalledOnce()
  f.api.sourceProductRead.mockResolvedValue(state({ sequence: 3, cancelWatermark: 1, stage: 'cancelled', cancelRequested: true }))
  await reopened.read(); await reopened.retry()
  expect(f.api.sourceProductRun).toHaveBeenCalledOnce()
  f.api.sourceProductResume.mockResolvedValue(state({ sequence: 4, cancelWatermark: 1, cancelRequested: false, stage: 'ready', verifiedBytes: 4, completedFiles: 1 }))
  await reopened.resume()
  expect(f.api.sourceProductResume).toHaveBeenCalledWith({ operationId: upload.operationId, manifestSha256: upload.manifestSha256, expectedSequence: 3, cancelWatermark: 1 })
  expect(reopened.getSnapshot().observed?.materialization.stage).toBe('ready')
})
it('an unexecuted initial run may be explicitly retried with the original parameters only after a read', async () => {
  const f = fixture(), manager = f.create()
  f.api.sourceProductRun.mockRejectedValueOnce(new Error('not dispatched')).mockResolvedValueOnce(state())
  f.api.sourceProductRead.mockRejectedValue(new Error('not observed'))
  await manager.run(); await manager.retry()
  expect(f.api.sourceProductRun).toHaveBeenCalledOnce()
  await manager.read(); await manager.retry()
  expect(f.api.sourceProductRun).toHaveBeenCalledTimes(2)
  expect(f.api.sourceProductRun.mock.calls[0][0]).toEqual(f.api.sourceProductRun.mock.calls[1][0])
})
it('resumes product controls then explicitly starts the worker with the returned product sequence', async () => {
  const f = fixture(), manager = f.create()
  f.api.sourceProductRun.mockResolvedValueOnce(state({ stage: 'cancelled', sequence: 2, cancelWatermark: 1, cancelRequested: true }))
  await manager.run()
  f.api.sourceProductResume.mockResolvedValue(state({ stage: 'prepared', sequence: 3, cancelWatermark: 1, cancelRequested: false }))
  f.api.sourceProductRun.mockResolvedValueOnce(state({ stage: 'verifying', sequence: 3, cancelWatermark: 1, workerState: 'running' }))
  await manager.resume()
  expect(f.api.sourceProductResume).toHaveBeenCalledWith({ operationId: upload.operationId, manifestSha256: upload.manifestSha256, expectedSequence: 2, cancelWatermark: 1 })
  expect(f.api.sourceProductRun).toHaveBeenLastCalledWith({ operationId: upload.operationId, manifestSha256: upload.manifestSha256, expectedSequence: 3, cancelWatermark: 1 })
})
it('can request cancellation during a pending run and ignores the old run reply', async () => {
  const f = fixture(), manager = f.create()
  let finish!: (value: MigrationSourceProductStateResult) => void
  f.api.sourceProductRun.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const running = manager.run()
  f.api.sourceProductCancel.mockResolvedValue(state({ stage: 'cancelled', cancelRequested: true, sequence: 1, cancelWatermark: 1 }))
  await manager.cancel(); const beforeLate = manager.getSnapshot().observed
  finish(state({ stage: 'ready', verifiedBytes: 4, completedFiles: 1 })); await running
  expect(manager.getSnapshot().observed).toEqual(beforeLate)
  expect(f.api.sourceProductCancel.mock.calls[0][0]).toMatchObject({ operationId: upload.operationId, manifestSha256: upload.manifestSha256 })
})
it('refuses to overwrite a recovery selector belonging to another manifest', async () => {
  const f = fixture()
  localStorage.setItem(`kcoder.migration.source-product:owned:${upload.operationId}`, JSON.stringify({ version: 1, operationId: upload.operationId, manifestSha256: 'b'.repeat(64), pending: null }))
  const manager = f.create(); await manager.run()
  expect(f.api.sourceProductRun).not.toHaveBeenCalled()
  expect(manager.getSnapshot().error).toBe('recoveryUnavailable')
})
