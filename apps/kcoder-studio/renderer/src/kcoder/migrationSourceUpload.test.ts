import { Blob as NodeBlob } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { MigrationSourceUploadStateResult } from '../../../shared/generated/contracts'
import { sendSourceUploadFiles, type SourceUploadApi } from './migrationSourceUpload'
import { selectSourceUploadFiles, selectSourceUploadPackage, sourceUploadManifestBytes, SOURCE_UPLOAD_MAX_BYTES,
  SOURCE_UPLOAD_PART_BYTES, type SelectedSourceUpload } from './migrationSourceUploadFiles'

const Blob = NodeBlob as unknown as typeof globalThis.Blob
const id = '11111111-1111-4111-8111-111111111111'
async function selected(bytes = SOURCE_UPLOAD_PART_BYTES + 7) {
  return selectSourceUploadFiles('codex', [{ relativePath: 'AGENTS.md', blob: new Blob([new Uint8Array(bytes).fill(97)]) }],
    new AbortController().signal, () => true)
}
function fixture(input: SelectedSourceUpload) {
  let received = 0
  const result = (): MigrationSourceUploadStateResult => ({ upload: { operationId: id, manifestSha256: input.manifestSha256,
    source: 'codex', stage: 'receiving', sequence: 0, cancelWatermark: 0, cancelRequested: false, workerState: 'stopped',
    totalFiles: 1, completedFiles: 0, totalBytes: input.files[0].blob.size, receivedBytes: received, verifiedBytes: 0, errorCode: null } })
  const api: SourceUploadApi = {
    read: vi.fn(async () => result()),
    files: vi.fn(async () => ({ page: { operationId: id, manifestSha256: input.manifestSha256,
      files: [{ fileIndex: 0, acceptedBytes: received, nextPart: Math.ceil(received / SOURCE_UPLOAD_PART_BYTES),
        complete: received === input.files[0].blob.size }], nextCursor: null } })),
    part: vi.fn(async params => { received += atob(params.contentBase64).length; return result() }),
    finish: vi.fn(async () => ({ upload: { ...result().upload, workerState: 'running', stage: 'verifying' } })),
  }
  return { api, result }
}

describe('explicit browser migration files', () => {
  it('hashes and transmits bounded chunks, then accepts asynchronous verification', async () => {
    const input = await selected(), { api, result } = fixture(input), observations = vi.fn()
    const final = await sendSourceUploadFiles(input, result(), api, new AbortController().signal, () => true, observations)
    expect(api.part).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.part).mock.calls.map(([part]) => atob(part.contentBase64).length)).toEqual([SOURCE_UPLOAD_PART_BYTES, 7])
    expect(final.upload.workerState).toBe('running')
    expect(final.upload.stage).toBe('verifying')
    expect(observations).toHaveBeenCalledTimes(3)
  })

  it('observes an accepted but lost part reply once and requires explicit resume', async () => {
    const input = await selected(), { api, result } = fixture(input)
    const send = api.part
    api.part = vi.fn(async params => { await send(params); throw new Error('reply lost') })
    await expect(sendSourceUploadFiles(input, result(), api, new AbortController().signal, () => true, vi.fn())).rejects.toThrow('reply lost')
    expect(api.part).toHaveBeenCalledTimes(1)
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(api.finish).not.toHaveBeenCalled()
    api.part = send
    await sendSourceUploadFiles(input, result(), api, new AbortController().signal, () => true, vi.fn())
    expect(vi.mocked(send).mock.calls.map(([part]) => part.partIndex)).toEqual([0, 1])
  })

  it('ignores a late reply after changing the account or target and sends nothing further', async () => {
    const input = await selected(), { api, result } = fixture(input), observations = vi.fn()
    let current = true
    const send = api.part
    api.part = vi.fn(async params => { const value = await send(params); current = false; return value })
    await expect(sendSourceUploadFiles(input, result(), api, new AbortController().signal, () => current, observations)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.part).toHaveBeenCalledTimes(1)
    expect(api.read).not.toHaveBeenCalled()
    expect(api.finish).not.toHaveBeenCalled()
    expect(observations).not.toHaveBeenCalled()
  })

  it('stops local hashing promptly and checks the aggregate budget before opening files', async () => {
    const controller = new AbortController(), read = vi.fn()
    await expect(selectSourceUploadFiles('codex', [{ relativePath: 'AGENTS.md', blob: { size: SOURCE_UPLOAD_MAX_BYTES + 1,
      slice: read } as unknown as Blob }], controller.signal, () => true)).rejects.toThrow('source_upload_payload_budget')
    expect(read).not.toHaveBeenCalled()
    await expect(selectSourceUploadFiles('codex', [{ relativePath: 'AGENTS.md', blob: new Blob([new Uint8Array(SOURCE_UPLOAD_PART_BYTES * 3)]) }],
      controller.signal, () => true, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a foreign receipt and never follows a fabricated page cursor', async () => {
    const input = await selected(), { api, result } = fixture(input)
    const initial = result(); initial.upload.manifestSha256 = 'f'.repeat(64)
    await expect(sendSourceUploadFiles(input, initial, api, new AbortController().signal, () => true, vi.fn())).rejects.toThrow('source_upload_invalid_result')
    expect(api.files).not.toHaveBeenCalled()
    const page = await api.files({ operationId: id })
    page.page.files[0].fileIndex = 2
    api.files = vi.fn(async () => page)
    await expect(sendSourceUploadFiles(input, result(), api, new AbortController().signal, () => true, vi.fn())).rejects.toThrow('source_upload_invalid_result')
    expect(api.part).not.toHaveBeenCalled()
  })
})

describe('versioned inert migration backup', () => {
  async function packageFile(extra = false, canonical = true) {
    const input = await selected(4), manifest = sourceUploadManifestBytes(input.manifest)
    const bytes = canonical ? manifest : new TextEncoder().encode(JSON.stringify(input.manifest, null, 2))
    const header = new Uint8Array(16)
    header.set(new TextEncoder().encode('KCMBNDL1'))
    new DataView(header.buffer).setBigUint64(8, BigInt(bytes.length), true)
    return { input, blob: new Blob([header, bytes, input.files[0].blob, ...(extra ? ['x'] : [])]) }
  }
  it('selects payload slices while retaining the canonical manifest digest', async () => {
    const { input, blob } = await packageFile()
    const parsed = await selectSourceUploadPackage(blob, new AbortController().signal, () => true)
    expect(parsed.manifestSha256).toBe(input.manifestSha256)
    expect(await parsed.files[0].blob.text()).toBe('aaaa')
  })
  it('rejects trailing bytes and noncanonical metadata without opening any external path', async () => {
    for (const [extra, canonical, error] of [[true, true, 'source_upload_package_length'],
      [false, false, 'source_upload_package_noncanonical_manifest']] as const) {
      const { blob } = await packageFile(extra, canonical)
      await expect(selectSourceUploadPackage(blob, new AbortController().signal, () => true)).rejects.toThrow(error)
    }
  })
  it('rejects sensitive package paths before slicing a body and never rewrites its signed manifest', async () => {
    const manifest = { version: 1, source: 'codex' as const, files: [{ relativePath: 'auth.json', bytes: 4, sha256: 'a'.repeat(64) }] }
    const bytes = sourceUploadManifestBytes(manifest), header = new Uint8Array(16)
    header.set(new TextEncoder().encode('KCMBNDL1')); new DataView(header.buffer).setBigUint64(8, BigInt(bytes.length), true)
    const original = new Blob([header, bytes, 'AUTH']), bodySlice = vi.fn()
    const file = { size: original.size, slice(start: number, end: number) { if (start >= 16 + bytes.length) bodySlice(); return original.slice(start, end) } } as Blob
    await expect(selectSourceUploadPackage(file, new AbortController().signal, () => true)).rejects.toThrow('source_upload_excluded_file')
    expect(bodySlice).not.toHaveBeenCalled()
    expect(manifest.files[0].relativePath).toBe('auth.json')
  })
})
