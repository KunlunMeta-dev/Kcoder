import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { downloadMigrationAttachment } from './migrationAttachmentDownload'
const body = new Uint8Array([0, 1, 2, 3, 4, 5, 6])
const receipt = {
  attachmentId: 'a'.repeat(64),
  bytes: body.length,
  sha256: bytesToHex(sha256(body)),
  chunkBytes: 262144,
}
const chunk = (offset: number) => {
  const bytes = body.slice(offset, offset + 3),
    end = offset + bytes.length
  return {
    receipt,
    offset,
    nextOffset: end < body.length ? end : null,
    dataBase64: btoa(String.fromCharCode(...bytes)),
    dataSha256: bytesToHex(sha256(bytes)),
  }
}
let close: ReturnType<typeof vi.fn>,
  abort: ReturnType<typeof vi.fn>,
  write: ReturnType<typeof vi.fn>
beforeEach(() => {
  close = vi.fn().mockResolvedValue(undefined)
  abort = vi.fn().mockResolvedValue(undefined)
  write = vi.fn().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
test('file-picker downloads write bounded chunks and close only after the full digest matches', async () => {
  const picker = vi
    .fn()
    .mockResolvedValue({ createWritable: async () => ({ write, close, abort }) })
  vi.stubGlobal('showSaveFilePicker', picker)
  const read = vi.fn(async (offset: number) => chunk(offset))
  const progress = vi.fn()
  await downloadMigrationAttachment(
    receipt,
    '../../report.txt',
    read,
    new AbortController().signal,
    progress,
    () => true
  )
  expect(picker).toHaveBeenCalledWith({ suggestedName: 'report.txt' })
  expect(read.mock.calls.map(v => v[0])).toEqual([0, 3, 6])
  expect(write).toHaveBeenCalledTimes(3)
  expect(close).toHaveBeenCalledOnce()
  expect(abort).not.toHaveBeenCalled()
  expect(progress).toHaveBeenLastCalledWith(7)
})
test('corrupt or mixed-receipt chunks abort the temporary file without publishing it', async () => {
  vi.stubGlobal(
    'showSaveFilePicker',
    vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close, abort }) })
  )
  await expect(
    downloadMigrationAttachment(
      receipt,
      'file.bin',
      async offset => ({ ...chunk(offset), dataSha256: '0'.repeat(64) }),
      new AbortController().signal,
      () => {},
      () => true
    )
  ).rejects.toThrow('history_attachment_invalid_chunk')
  expect(close).not.toHaveBeenCalled()
  expect(abort).toHaveBeenCalledOnce()
})
test('target changes after a chunk arrives abort the owned download before writing', async () => {
  vi.stubGlobal(
    'showSaveFilePicker',
    vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close, abort }) })
  )
  let current = true
  await expect(
    downloadMigrationAttachment(
      receipt,
      'file.bin',
      async offset => {
        current = false
        return chunk(offset)
      },
      new AbortController().signal,
      () => {},
      () => current
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(write).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(abort).toHaveBeenCalledOnce()
})
test('browser fallback publishes one verified blob and revokes only its own URL', async () => {
  vi.stubGlobal('showSaveFilePicker', undefined)
  const create = vi.fn(() => 'blob:owned'),
    revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    expect(this.isConnected).toBe(true)
    expect(this.download).toBe('file.bin')
  })
  await downloadMigrationAttachment(
    receipt,
    'file.bin',
    async offset => chunk(offset),
    new AbortController().signal,
    () => {},
    () => true
  )
  expect(create).toHaveBeenCalledOnce()
  expect(create.mock.calls[0]).toHaveLength(1)
  expect(click).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned'), {
    timeout: 2000,
  })
})

test('cancelling an in-progress write aborts its temporary file without closing it', async () => {
  const controller = new AbortController()
  write.mockImplementation(async () => {
    controller.abort()
  })
  vi.stubGlobal(
    'showSaveFilePicker',
    vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close, abort }) })
  )
  await expect(
    downloadMigrationAttachment(
      receipt,
      'file.bin',
      async offset => chunk(offset),
      controller.signal,
      () => {},
      () => true
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(write).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
  expect(abort).toHaveBeenCalledOnce()
})

test('a native save keeps the owned blob alive until the desktop download result settles', async () => {
  vi.stubGlobal('showSaveFilePicker', undefined)
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:owned', revokeObjectURL: revoke })
  let finish!: (value: unknown) => void
  const download = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  Object.assign(window, { kcoderDesktopHost: { download } })
  try {
    const pending = downloadMigrationAttachment(
      receipt,
      'file.bin',
      async offset => chunk(offset),
      new AbortController().signal,
      () => {},
      () => true
    )
    await vi.waitFor(() =>
      expect(download).toHaveBeenCalledWith({ url: 'blob:owned', filename: 'file.bin' })
    )
    expect(revoke).not.toHaveBeenCalled()
    finish({ status: 'completed', filename: 'file.bin' })
    await pending
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned'))
  } finally {
    delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
  }
})
