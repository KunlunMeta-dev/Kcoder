/** Segments are streamed individually; no API returns a whole archive Blob. */
import type { WikiLibrary } from '@/kcoder/knowledgeApi'
export const ARCHIVE_CHUNK_BYTES = 192 * 1024
export const ARCHIVE_SEGMENT_BYTES = 96 * 1024 * 1024
export const ARCHIVE_TOTAL_BYTES = 1024 * 1024 * 1024
export type ArchiveManifest = {
  format: 'kcoder-wiki-collection'
  version: 1
  collectionId: string
  size: number
  sha256: string
  segments: Array<{ index: number; name: string; size: number; sha256: string }>
}
export type ArchiveStatus = {
  transferId: string
  phase: 'processing' | 'uploading' | 'ready' | 'completed' | 'cancelled' | 'failed'
  completedBytes: number
  totalBytes: number
  manifest?: ArchiveManifest | null
  library?: WikiLibrary | null
  error?: string | null
}
export type ArchiveRequest = <T>(operation: string, params?: object) => Promise<T>
export type ArchiveProgress = (status: ArchiveStatus) => void
const prefix = 'knowledge/archiveTransfer/'
const hash = /^[a-f0-9]{64}$/
export function validateArchiveManifest(value: unknown): ArchiveManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Wiki collection manifest')
  const manifest = value as ArchiveManifest
  if (
    manifest.format !== 'kcoder-wiki-collection' ||
    manifest.version !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(manifest.collectionId) ||
    !hash.test(manifest.sha256) ||
    !Array.isArray(manifest.segments) ||
    !manifest.segments.length ||
    manifest.segments.length > 16
  )
    throw new Error('Invalid Wiki collection manifest')
  let total = 0
  for (const [index, segment] of manifest.segments.entries()) {
    if (
      segment.index !== index ||
      segment.name !== `part-${String(index + 1).padStart(5, '0')}.kwiki` ||
      !Number.isSafeInteger(segment.size) ||
      segment.size <= 0 ||
      segment.size > ARCHIVE_SEGMENT_BYTES ||
      !hash.test(segment.sha256)
    )
      throw new Error('Invalid Wiki collection segment')
    total += segment.size
  }
  if (total !== manifest.size || total > ARCHIVE_TOTAL_BYTES)
    throw new Error('Invalid Wiki collection size')
  return manifest
}
export async function archiveCapability(request: ArchiveRequest) {
  return request<{ supported: boolean }>(prefix + 'capabilities')
}
export async function cancelArchive(request: ArchiveRequest, transferId: string) {
  return request<ArchiveStatus>(prefix + 'cancel', { transferId })
}
export async function waitArchive(
  request: ArchiveRequest,
  status: ArchiveStatus,
  current: () => boolean,
  progress: ArchiveProgress
): Promise<ArchiveStatus> {
  progress(status)
  while (status.phase === 'processing') {
    if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
    status = await request<ArchiveStatus>(prefix + 'status', { transferId: status.transferId })
    progress(status)
  }
  if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
  if (status.phase === 'failed' || status.phase === 'cancelled')
    throw new Error(status.error || `Wiki archive transfer ${status.phase}`)
  return status
}
export async function beginArchiveExport(
  request: ArchiveRequest,
  libraryId: string,
  current: () => boolean,
  progress: ArchiveProgress
) {
  const status = await request<ArchiveStatus>(prefix + 'exportStart', { libraryId })
  try {
    return await waitArchive(request, status, current, progress)
  } catch (cause) {
    await cancelArchive(request, status.transferId).catch(() => {})
    throw cause
  }
}
/** Sink writes provide backpressure. The caller can use a native file stream or one segment Blob. */
export async function readArchiveSegment(
  request: ArchiveRequest,
  status: ArchiveStatus,
  index: number,
  current: () => boolean,
  write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
  progress: (bytes: number) => void
) {
  const manifest = validateArchiveManifest(status.manifest)
  const segment = manifest.segments[index]
  if (!segment) throw new Error('Wiki collection segment missing')
  let offset = 0
  while (offset < segment.size) {
    if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
    const chunk = await request<{
      contentBase64: string
      nextOffset: number
      size: number
      eof: boolean
    }>(prefix + 'read', { transferId: status.transferId, index, offset })
    if (chunk.contentBase64.length > Math.ceil(ARCHIVE_CHUNK_BYTES / 3) * 4)
      throw new Error('Wiki archive chunk exceeds limit')
    const binary = atob(chunk.contentBase64)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    if (
      !bytes.length ||
      bytes.length > ARCHIVE_CHUNK_BYTES ||
      chunk.size !== segment.size ||
      chunk.nextOffset !== offset + bytes.length ||
      chunk.nextOffset > segment.size ||
      chunk.eof !== (chunk.nextOffset === segment.size)
    )
      throw new Error('Invalid Wiki archive chunk')
    if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
    await write(bytes)
    offset = chunk.nextOffset
    progress(offset)
  }
}
export async function importArchiveCollection(
  request: ArchiveRequest,
  files: File[],
  current: () => boolean,
  progress: ArchiveProgress
): Promise<WikiLibrary> {
  const manifests = files.filter(file => file.name.endsWith('.kwiki.json'))
  if (manifests.length !== 1 || manifests[0].size > 64 * 1024)
    throw new Error('Select one .kwiki.json collection manifest and every listed .kwiki segment')
  const manifest = validateArchiveManifest(JSON.parse(await manifests[0].text()))
  const named = new Map<string, File>()
  for (const file of files) {
    if (file === manifests[0]) continue
    if (named.has(file.name)) throw new Error('Duplicate Wiki collection segment')
    named.set(file.name, file)
  }
  if (
    named.size !== manifest.segments.length ||
    manifest.segments.some(segment => named.get(segment.name)?.size !== segment.size)
  )
    throw new Error('Missing, foreign or incorrectly sized Wiki collection segment')
  if (!current()) throw new Error('Wiki target changed')
  let status = await request<ArchiveStatus>(prefix + 'importStart', {
    manifest,
    idempotencyKey: `stream:${manifest.collectionId}:${manifest.sha256.slice(0, 32)}`,
  })
  progress(status)
  try {
    for (const segment of manifest.segments) {
      const file = named.get(segment.name)!
      for (let offset = 0; offset < segment.size;) {
        if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
        const bytes = new Uint8Array(
          await file.slice(offset, offset + ARCHIVE_CHUNK_BYTES).arrayBuffer()
        )
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
        status = await request<ArchiveStatus>(prefix + 'chunk', {
          transferId: status.transferId,
          index: segment.index,
          offset,
          contentBase64: btoa(binary),
        })
        // A missing acknowledgement is not replayed automatically.
        offset += bytes.length
        progress(status)
      }
    }
    if (!current()) throw new Error('Wiki archive transfer cancelled or target changed')
    status = await request<ArchiveStatus>(prefix + 'importFinish', {
      transferId: status.transferId,
    })
    status = await waitArchive(request, status, current, progress)
    if (status.phase !== 'completed' || !status.library)
      throw new Error(
        'Wiki import outcome unknown; retry the same collection to resolve its receipt'
      )
    return status.library
  } finally {
    // Completed import receipts remain durable. Only this owned staging is released.
    await cancelArchive(request, status.transferId).catch(() => {})
  }
}
