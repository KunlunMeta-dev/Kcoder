import { expect, test, vi } from 'vitest'
import type { MigrationLocalAttachmentStateResult } from '../../../shared/generated/contracts'
import { uploadMigrationLocalAttachment, MIGRATION_LOCAL_ATTACHMENT_PART_BYTES as PART,
  MIGRATION_LOCAL_ATTACHMENT_LIMIT as LIMIT } from './migrationLocalAttachmentUpload'

function source(size: number, onRead: (start: number, end: number) => void = () => undefined): File {
  return { name: 'notes.txt', size, slice(start: number, end: number) {
    onRead(start, end)
    return { arrayBuffer: async () => new Uint8Array(Math.max(0, Math.min(end, size) - start)).buffer }
  } } as unknown as File
}
function prepared(): MigrationLocalAttachmentStateResult {
  return { upload: { operationId: 'op', selection: { jobId: 'history', position: 0, blockIndex: 1 },
    sequence: 0, stage: 'prepared', filename: null, bytes: null, sha256: null,
    receivedBytes: 0, receivedParts: 0, partBytes: PART, cancelRequested: false,
    cancelRevision: 0, failureCode: null, localJob: null }, workerRunning: false, workerError: null }
}
function receiver() {
  let state = prepared()
  return { current: () => state, api: {
    localAttachmentBegin: vi.fn(async (params) => {
      state = { ...state, upload: { ...state.upload, sequence: 1, stage: 'receiving',
        filename: params.filename, bytes: params.bytes, sha256: params.sha256 } }
      return state
    }),
    localAttachmentPart: vi.fn(async (params) => {
      const size = atob(params.contentBase64).length
      state = { ...state, upload: { ...state.upload, sequence: state.upload.sequence + 1,
        receivedParts: state.upload.receivedParts + 1, receivedBytes: state.upload.receivedBytes + size } }
      return state
    }),
    localAttachmentRead: vi.fn(async () => state),
  } }
}

test('hashing and sending stay bounded and reflect each acknowledged part', async () => {
  const target = receiver(), reads: number[] = [], observed: number[] = []
  const file = source(PART * 2 + 7, (start, end) => reads.push(end - start))
  const result = await uploadMigrationLocalAttachment(file, prepared(), target.api,
    new AbortController().signal, () => true, value => observed.push(value.upload.receivedBytes))
  expect(Math.max(...reads)).toBe(PART)
  expect(target.api.localAttachmentBegin).toHaveBeenCalledTimes(1)
  expect(target.api.localAttachmentPart.mock.calls.map(([params]) => params.index)).toEqual([0, 1, 2])
  expect(observed).toEqual([0, PART, PART * 2, PART * 2 + 7])
  expect(result.upload.receivedBytes).toBe(file.size)
})

test('oversized file is rejected before reading or sending any bytes', async () => {
  const target = receiver(), read = vi.fn()
  await expect(uploadMigrationLocalAttachment(source(LIMIT + 1, read), prepared(), target.api,
    new AbortController().signal, () => true, vi.fn())).rejects.toThrow('budget_exceeded')
  expect(read).not.toHaveBeenCalled()
  expect(target.api.localAttachmentBegin).not.toHaveBeenCalled()
})

test('scope loss during an outstanding file read cannot send a begin request', async () => {
  const target = receiver()
  let valid = true
  const file = source(10, () => { valid = false })
  await expect(uploadMigrationLocalAttachment(file, prepared(), target.api,
    new AbortController().signal, () => valid, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  expect(target.api.localAttachmentBegin).not.toHaveBeenCalled()
})

test('a lost part receipt is read once and never replays the mutation', async () => {
  const target = receiver()
  const original = target.api.localAttachmentPart.getMockImplementation()!
  target.api.localAttachmentPart.mockImplementation(async params => {
    await original(params)
    throw new Error('reply_lost')
  })
  const observe = vi.fn()
  await expect(uploadMigrationLocalAttachment(source(PART + 1), prepared(), target.api,
    new AbortController().signal, () => true, observe)).rejects.toThrow('reply_lost')
  expect(target.api.localAttachmentPart).toHaveBeenCalledTimes(1)
  expect(target.api.localAttachmentRead).toHaveBeenCalledTimes(1)
  expect(observe.mock.calls.at(-1)?.[0].upload.receivedBytes).toBe(PART)
})

test('explicit resume revalidates the complete selected File before sending the remaining part', async () => {
  const target = receiver()
  const original = target.api.localAttachmentPart.getMockImplementation()!
  target.api.localAttachmentPart.mockImplementationOnce(async params => {
    await original(params)
    throw new Error('reply_lost')
  })
  await expect(uploadMigrationLocalAttachment(source(PART + 1), prepared(), target.api,
    new AbortController().signal, () => true, vi.fn())).rejects.toThrow('reply_lost')
  const recovered = target.current()
  await uploadMigrationLocalAttachment(source(PART + 1), recovered, target.api,
    new AbortController().signal, () => true, vi.fn())
  expect(target.api.localAttachmentBegin).toHaveBeenCalledTimes(1)
  expect(target.api.localAttachmentPart.mock.calls.map(([params]) => params.index)).toEqual([0, 1])
})

test('cancellation while waiting for a part reply stops without another read or write', async () => {
  const target = receiver(), controller = new AbortController()
  const original = target.api.localAttachmentPart.getMockImplementation()!
  target.api.localAttachmentPart.mockImplementation(async params => {
    const value = await original(params)
    controller.abort()
    return value
  })
  await expect(uploadMigrationLocalAttachment(source(PART + 1), prepared(), target.api,
    controller.signal, () => true, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  expect(target.api.localAttachmentPart).toHaveBeenCalledTimes(1)
  expect(target.api.localAttachmentRead).not.toHaveBeenCalled()
})
