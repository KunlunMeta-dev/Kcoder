import { TestStorage } from './test-storage'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSourceUploadController } from './upload-controller'
import { SOURCE_UPLOAD_PART_BYTES } from './files'
type SourceApi = Parameters<typeof createSourceUploadController>[0]['api']
import type { MigrationSourceUploadStateResult, MigrationSourceUploadPrepareParams } from '../../../../shared/generated/contracts'

const Blob = NodeBlob as unknown as typeof globalThis.Blob
function fixture() {
  let input!: MigrationSourceUploadPrepareParams, received = 0, sequence = 0, cancel = 0, cancelled = false
  const state = (): MigrationSourceUploadStateResult => ({ upload: { operationId: input.operationId,
    manifestSha256: JSON.parse(localStorage.getItem(`kcoder-studio:mobile-source-upload:owned:${input.operationId}`)!).manifestSha256,
    source: input.manifest.source, totalFiles: 1, totalBytes: input.manifest.files[0].bytes, receivedBytes: received,
    completedFiles: received === input.manifest.files[0].bytes ? 1 : 0, verifiedBytes: 0, sequence,
    cancelWatermark: cancel, cancelRequested: cancelled, workerState: 'stopped', stage: cancelled ? 'cancelled' : 'receiving', errorCode: null } })
  const api = {
    sourceUploadPrepare: vi.fn(async value => { input = value; return state() }),
    sourceUploadRead: vi.fn(async () => state()),
    sourceUploadFiles: vi.fn(async () => ({ page: { operationId: input.operationId, manifestSha256: state().upload.manifestSha256,
      files: [{ fileIndex: 0, acceptedBytes: received, nextPart: Math.ceil(received / SOURCE_UPLOAD_PART_BYTES), complete: received === input.manifest.files[0].bytes }], nextCursor: null } })),
    sourceUploadPart: vi.fn(async value => { received += atob(value.contentBase64).length; return state() }),
    sourceUploadFinish: vi.fn(async () => ({ upload: { ...state().upload, stage: 'verifying' as const, workerState: 'running' as const } })),
    sourceUploadCancel: vi.fn(async (_input: { operationId: string; commandId: string }) => { cancelled = true; cancel++; sequence++; return state() }),
    sourceUploadResume: vi.fn(async () => { cancelled = false; sequence++; return state() }),
  }
  const controller = () => createSourceUploadController({ api: api as SourceApi, storage: localStorage, scope: 'owned', isCurrent: () => true })
  return { api, state, controller }
}
const selected = () => [{ relativePath: 'AGENTS.md', blob: new Blob([new Uint8Array(SOURCE_UPLOAD_PART_BYTES + 7).fill(97)]) }]
beforeEach(() => vi.stubGlobal('localStorage', new TestStorage()))
afterEach(() => vi.unstubAllGlobals())

it('persists prepare identity before sending and resumes an accepted lost part only after explicit read and matching file reselection', async () => {
  const f = fixture(), first = f.controller()
  const originalPrepare = f.api.sourceUploadPrepare
  f.api.sourceUploadPrepare = vi.fn(async input => {
    expect(localStorage.getItem(`kcoder-studio:mobile-source-upload:owned:${input.operationId}`)).not.toBeNull()
    return originalPrepare(input)
  })
  // Recreate so the API field points to this receipt-order probe.
  const manager = f.controller(), part = f.api.sourceUploadPart
  f.api.sourceUploadPart.mockImplementationOnce(async input => { await part.getMockImplementation()!(input); throw new Error('accepted reply lost') })
  await manager.selectFiles('codex', selected()); await manager.start()
  const selector = manager.getSnapshot().selector!
  expect(manager.getSnapshot().unknown).toBe(true)
  expect(manager.getSnapshot().observed?.upload.receivedBytes).toBe(SOURCE_UPLOAD_PART_BYTES)
  expect(f.api.sourceUploadPart).toHaveBeenCalledOnce()
  manager.dispose(); first.dispose()
  const reopened = f.controller()
  expect(reopened.getSnapshot().cached).toHaveLength(1)
  const reads = f.api.sourceUploadRead.mock.calls.length
  expect(f.api.sourceUploadPrepare).toHaveBeenCalledOnce()
  await reopened.restore(selector.operationId)
  expect(f.api.sourceUploadRead).toHaveBeenCalledTimes(reads + 1)
  await reopened.resume(); expect(f.api.sourceUploadPart).toHaveBeenCalledOnce()
  await reopened.selectFiles('codex', [{ relativePath: 'AGENTS.md', blob: new Blob(['changed']) }])
  expect(reopened.getSnapshot().error).toBe('selectionMismatch')
  expect(reopened.getSnapshot().selector?.operationId).toBe(selector.operationId)
  await reopened.selectFiles('codex', selected())
  await reopened.resume()
  expect(f.api.sourceUploadPart.mock.calls.map(([value]) => value.partIndex)).toEqual([0, 1])
  expect(f.api.sourceUploadPrepare).toHaveBeenCalledOnce()
  expect(reopened.getSnapshot().observed?.upload.stage).toBe('verifying')
})
it('stops hashing before any Native operation and drops late Blob reads', async () => {
  const f = fixture(), manager = f.controller()
  let finish!: (value: ArrayBuffer) => void
  const blob = { size: 10, slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finish = resolve }) }) } as Blob
  const pending = manager.selectFiles('codex', [{ relativePath: 'AGENTS.md', blob }])
  await manager.cancel(); finish(new ArrayBuffer(10)); await pending
  expect(manager.getSnapshot().selected).toBeNull()
  expect(manager.getSnapshot().selector).toBeNull()
  expect(manager.getSnapshot().error).toBe('localStopped')
  expect(f.api.sourceUploadPrepare).not.toHaveBeenCalled()
})
it('a prepare reply lost before execution can be explicitly reconciled with the same operation only after reading first', async () => {
  const f = fixture(), manager = f.controller()
  f.api.sourceUploadPrepare.mockRejectedValueOnce(new Error('connection lost before request reached Native'))
  f.api.sourceUploadRead.mockRejectedValueOnce(new Error('operation not observed'))
  await manager.selectFiles('codex', selected()); await manager.start()
  const original = manager.getSnapshot().selector!
  await manager.retryPrepare(); expect(f.api.sourceUploadPrepare).toHaveBeenCalledOnce()
  await manager.read(); expect(manager.getSnapshot().readAttempted).toBe(true)
  await manager.retryPrepare()
  expect(f.api.sourceUploadPrepare.mock.calls.map(([value]) => value.operationId)).toEqual([original.operationId, original.operationId])
  expect(f.api.sourceUploadPart).not.toHaveBeenCalled()
  await manager.resume()
  expect(f.api.sourceUploadPart).toHaveBeenCalledTimes(2)
})
it('uses the original operation and a persisted cancel command while another part reply is pending', async () => {
  const f = fixture(), manager = f.controller(), part = f.api.sourceUploadPart
  let finish!: (value: MigrationSourceUploadStateResult) => void
  f.api.sourceUploadPart.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await manager.selectFiles('codex', selected())
  const sending = manager.start()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const original = manager.getSnapshot().selector!
  await manager.cancel()
  const request = f.api.sourceUploadCancel.mock.calls[0][0]
  expect(request.operationId).toBe(original.operationId)
  expect(JSON.parse(localStorage.getItem(`kcoder-studio:mobile-source-upload:owned:${original.operationId}`)!).cancelCommandId).toBe(request.commandId)
  const beforeLate = manager.getSnapshot().observed
  finish(f.state()); await sending
  expect(manager.getSnapshot().observed).toEqual(beforeLate)
  expect(manager.getSnapshot().observed?.upload.cancelRequested).toBe(true)
  expect(part).toHaveBeenCalledOnce()
  expect(f.api.sourceUploadFinish).not.toHaveBeenCalled()
})
it('drops a late prepare reply when its profile/target owner changes', async () => {
  const f = fixture(); let current = true;
  const manager = createSourceUploadController({ api: f.api as SourceApi, storage: localStorage, scope: 'owned', isCurrent: () => current });
  await manager.selectFiles('codex', selected());
  f.api.sourceUploadPrepare.mockImplementation(async () => { current = false; return { upload: { operationId: 'late' } } as MigrationSourceUploadStateResult });
  await manager.start(); expect(f.api.sourceUploadPart).not.toHaveBeenCalled(); expect(manager.getSnapshot().observed).toBeNull(); expect(localStorage.length).toBe(1);
});
it('refuses to create a Native upload when its stable selector cannot be retained', async () => {
  const f = fixture(), manager = createSourceUploadController({ api: f.api as SourceApi, scope: 'owned', isCurrent: () => true,
    storage: { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') } } })
  await manager.selectFiles('codex', selected()); await manager.start()
  expect(manager.getSnapshot().error).toBe('recoveryUnavailable')
  expect(f.api.sourceUploadPrepare).not.toHaveBeenCalled()
})
it('does not append files when a prepare response claims another owned operation', async () => {
  const f = fixture(), manager = f.controller(), prepare = f.api.sourceUploadPrepare.getMockImplementation()!
  f.api.sourceUploadPrepare.mockImplementationOnce(async input => ({ upload: { ...(await prepare(input)).upload, operationId: '22222222-2222-4222-8222-222222222222' } }))
  await manager.selectFiles('codex', selected()); await manager.start()
  expect(manager.getSnapshot().unknown).toBe(true)
  expect(manager.getSnapshot().observed).toBeNull()
  expect(f.api.sourceUploadPart).not.toHaveBeenCalled()
})
it('reorders a reselected file set by the original manifest before hashing while changed bytes still fail', async () => {
  const f = fixture(), manager = f.controller()
  const original = [{ relativePath: 'AGENTS.md', blob: new Blob(['alpha']) }, { relativePath: 'notes.md', blob: new Blob(['beta']) }]
  f.api.sourceUploadPrepare.mockRejectedValue(new Error('prepare reply unconfirmed'))
  await manager.selectFiles('codex', original); await manager.start()
  const binding = manager.getSnapshot().selector!
  manager.dispose(); const reopened = f.controller()
  // Restore keeps the original selector even though the synthetic server has no read result.
  f.api.sourceUploadRead.mockRejectedValue(new Error('not observed'))
  await reopened.restore(binding.operationId)
  await reopened.selectFiles('codex', [original[1], original[0]])
  expect(reopened.getSnapshot().selected?.manifestSha256).toBe(binding.manifestSha256)
  expect(reopened.getSnapshot().selected?.files.map(file => file.relativePath)).toEqual(['AGENTS.md', 'notes.md'])
  await reopened.selectFiles('codex', [{ relativePath: 'notes.md', blob: new Blob(['BETA']) }, original[0]])
  expect(reopened.getSnapshot().selected).toBeNull()
  expect(reopened.getSnapshot().error).toBe('selectionMismatch')
  expect(f.api.sourceUploadPrepare).toHaveBeenCalledOnce()
  expect(f.api.sourceUploadPart).not.toHaveBeenCalled()
})
