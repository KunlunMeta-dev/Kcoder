// Model-independent transfer boundaries, not model behavior tests.
import { Blob as NodeBlob } from 'node:buffer'
import { expect, test, vi } from 'vitest'
import {
  ARCHIVE_CHUNK_BYTES,
  ARCHIVE_SEGMENT_BYTES,
  beginArchiveExport,
  importArchiveCollection,
  readArchiveSegment,
  validateArchiveManifest,
  type ArchiveManifest,
  type ArchiveRequest,
  type ArchiveStatus,
} from './wikiArchiveTransport'
const manifest = (size = 4): ArchiveManifest => ({
  format: 'kcoder-wiki-collection',
  version: 1,
  collectionId: 'a0000000-0000-4000-8000-000000000001',
  size,
  sha256: 'a'.repeat(64),
  segments: [{ index: 0, name: 'part-00001.kwiki', size, sha256: 'b'.repeat(64) }],
})
const status = (phase: ArchiveStatus['phase'] = 'ready', size = 4): ArchiveStatus => ({
  transferId: 'owned-transfer',
  phase,
  completedBytes: 0,
  totalBytes: size,
  manifest: manifest(size),
})
function file(name: string, content: Uint8Array | string): File {
  const blob = new NodeBlob([content])
  return {
    name,
    size: blob.size,
    text: () => blob.text(),
    slice: (from: number, until: number) => blob.slice(from, until),
  } as File
}
test('rejects unsafe names, missing and duplicate segments before import admission', async () => {
  const request = vi.fn() as unknown as ArchiveRequest
  expect(() =>
    validateArchiveManifest({
      ...manifest(),
      segments: [{ ...manifest().segments[0], name: '../outside' }],
    })
  ).toThrow()
  expect(() => validateArchiveManifest(manifest(ARCHIVE_SEGMENT_BYTES + 1))).toThrow()
  const metadata = file('collection.kwiki.json', JSON.stringify(manifest())),
    part = file('part-00001.kwiki', 'data')
  await expect(
    importArchiveCollection(
      request,
      [metadata],
      () => true,
      () => {}
    )
  ).rejects.toThrow('Missing')
  await expect(
    importArchiveCollection(
      request,
      [metadata, part, part],
      () => true,
      () => {}
    )
  ).rejects.toThrow('Duplicate')
  expect(request).not.toHaveBeenCalled()
})
test('validates offsets and waits for sink backpressure before another read', async () => {
  let calls = 0
  const request = vi.fn(async (_operation, params: { offset: number }) => {
    ++calls
    return {
      contentBase64: btoa('ab'),
      nextOffset: params.offset + 2,
      size: 4,
      eof: params.offset === 2,
    }
  }) as unknown as ArchiveRequest
  let release: () => void = () => {}
  const writes: string[] = []
  const task = readArchiveSegment(
    request,
    status(),
    0,
    () => true,
    async bytes => {
      writes.push(String.fromCharCode(...bytes))
      if (writes.length === 1)
        await new Promise<void>(resolve => {
          release = resolve
        })
    },
    () => {}
  )
  await vi.waitFor(() => expect(writes).toEqual(['ab']))
  expect(calls).toBe(1)
  release()
  await task
  expect(calls).toBe(2)
  const corrupt = vi.fn(async () => ({
    contentBase64: btoa('ab'),
    nextOffset: 3,
    size: 4,
    eof: false,
  })) as unknown as ArchiveRequest
  const sink = vi.fn()
  await expect(
    readArchiveSegment(
      corrupt,
      status(),
      0,
      () => true,
      sink,
      () => {}
    )
  ).rejects.toThrow('Invalid')
  expect(sink).not.toHaveBeenCalled()
})
test('uploads bounded slices and publishes only after all acknowledgements', async () => {
  const bytes = new Uint8Array(ARCHIVE_CHUNK_BYTES + 3),
    calls: string[] = [],
    payloads: Record<string, unknown>[] = []
  const request = vi.fn(async (operation: string, params?: object) => {
    calls.push(operation.split('/').at(-1)!)
    payloads.push(params as Record<string, unknown>)
    if (operation.endsWith('importFinish'))
      return { ...status('completed', bytes.length), library: { id: 'new-library' } }
    return status('uploading', bytes.length)
  }) as unknown as ArchiveRequest
  const result = await importArchiveCollection(
    request,
    [
      file('collection.kwiki.json', JSON.stringify(manifest(bytes.length))),
      file('part-00001.kwiki', bytes),
    ],
    () => true,
    () => {}
  )
  expect(result.id).toBe('new-library')
  expect(calls).toEqual(['importStart', 'chunk', 'chunk', 'importFinish', 'cancel'])
  expect(payloads[1].offset).toBe(0)
  expect(payloads[2].offset).toBe(ARCHIVE_CHUNK_BYTES)
  expect((payloads[1].contentBase64 as string).length).toBe((ARCHIVE_CHUNK_BYTES * 4) / 3)
})
test('unknown chunk acknowledgement is not replayed and does not publish', async () => {
  const calls: string[] = []
  const request = vi.fn(async (operation: string) => {
    calls.push(operation.split('/').at(-1)!)
    if (operation.endsWith('chunk')) throw new Error('connection interrupted')
    return status('uploading')
  }) as unknown as ArchiveRequest
  await expect(
    importArchiveCollection(
      request,
      [file('collection.kwiki.json', JSON.stringify(manifest())), file('part-00001.kwiki', 'data')],
      () => true,
      () => {}
    )
  ).rejects.toThrow('interrupted')
  expect(calls).toEqual(['importStart', 'chunk', 'cancel'])
})
test('an export admitted after its view closed is cancelled using its owned ID', async () => {
  const calls: string[] = []
  const request = vi.fn(async (operation: string) => {
    calls.push(operation)
    return status('processing')
  }) as unknown as ArchiveRequest
  await expect(
    beginArchiveExport(
      request,
      'library',
      () => false,
      () => {}
    )
  ).rejects.toThrow('cancelled')
  expect(calls.map(operation => operation.split('/').at(-1))).toEqual(['exportStart', 'cancel'])
})
