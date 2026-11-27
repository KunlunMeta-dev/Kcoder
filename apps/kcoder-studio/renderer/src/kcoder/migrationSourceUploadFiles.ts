import { sha256 } from '@noble/hashes/sha2.js'
import { isMigrationSourceUploadPrepareParams } from '../../../shared/generated/contracts'
import type { MigrationSourceUploadPrepareParams } from '../../../shared/generated/contracts'
import { assertSourceUploadPaths } from './migrationSourceUploadPathPolicy'

export type SourceUploadManifest = MigrationSourceUploadPrepareParams['manifest']
export const SOURCE_UPLOAD_PART_BYTES = 128 * 1024
export const SOURCE_UPLOAD_MAX_BYTES = 2 * 1024 ** 3
const MANIFEST_MAX_BYTES = 1024 ** 2
const probeId = '11111111-1111-4111-8111-111111111111'
export interface SelectedSourceFile { readonly relativePath: string; readonly blob: Blob }
export interface SelectedSourceUpload {
  readonly manifest: SourceUploadManifest
  readonly manifestSha256: string
  readonly files: readonly SelectedSourceFile[]
}

export function assertUploadCurrent(signal: AbortSignal, current: () => boolean) {
  if (signal.aborted || !current()) throw new DOMException('Aborted', 'AbortError')
}
function hex(bytes: Uint8Array) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') }
export function sourceUploadManifestBytes(manifest: SourceUploadManifest) {
  return new TextEncoder().encode(JSON.stringify({ version: manifest.version, source: manifest.source,
    files: manifest.files.map(file => ({ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 })) }))
}
function checkedManifest(value: unknown): SourceUploadManifest {
  const request = { operationId: probeId, manifest: value }
  if (!isMigrationSourceUploadPrepareParams(request)) throw new Error('source_upload_invalid_manifest')
  const manifest = request.manifest
  if (manifest.version !== 1 || manifest.files.length < 1 || manifest.files.length > 1024)
    throw new Error('source_upload_file_count')
  let total = 0
  for (const file of manifest.files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('source_upload_invalid_manifest')
    total += file.bytes
    if (total > SOURCE_UPLOAD_MAX_BYTES) throw new Error('source_upload_payload_budget')
  }
  if (sourceUploadManifestBytes(manifest).length > MANIFEST_MAX_BYTES) throw new Error('source_upload_manifest_budget')
  return manifest
}

/** Read only supplied Blob handles. Browser names never become target filesystem grants. */
export async function selectSourceUploadFiles(
  source: SourceUploadManifest['source'], selected: readonly SelectedSourceFile[], signal: AbortSignal,
  current: () => boolean, progress: (hashed: number, total: number) => void = () => undefined,
): Promise<SelectedSourceUpload> {
  assertSourceUploadPaths(selected.map(file => file.relativePath))
  const files = selected.map(file => Object.freeze({ relativePath: file.relativePath, blob: file.blob }))
  const manifest = checkedManifest({ version: 1, source,
    files: files.map(file => ({ relativePath: file.relativePath, bytes: file.blob.size, sha256: '0'.repeat(64) })) })
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  let hashed = 0
  for (let index = 0; index < files.length; index++) {
    const hash = sha256.create(), file = files[index].blob
    assertUploadCurrent(signal, current)
    for (let offset = 0; offset < file.size; offset += SOURCE_UPLOAD_PART_BYTES) {
      assertUploadCurrent(signal, current)
      const bytes = new Uint8Array(await file.slice(offset, offset + SOURCE_UPLOAD_PART_BYTES).arrayBuffer())
      assertUploadCurrent(signal, current)
      if (bytes.length !== Math.min(SOURCE_UPLOAD_PART_BYTES, file.size - offset)) throw new Error('source_upload_file_changed')
      hash.update(bytes); hashed += bytes.length; progress(hashed, total)
    }
    manifest.files[index].sha256 = hex(hash.digest())
  }
  assertUploadCurrent(signal, current)
  return { manifest, manifestSha256: hex(sha256(sourceUploadManifestBytes(manifest))), files }
}

/** KCMBNDL1 is an inert ordered byte container, not an executable archive. */
export async function selectSourceUploadPackage(
  file: Blob, signal: AbortSignal, current: () => boolean,
): Promise<SelectedSourceUpload> {
  assertUploadCurrent(signal, current)
  if (!Number.isSafeInteger(file.size) || file.size < 16 || file.size > SOURCE_UPLOAD_MAX_BYTES + MANIFEST_MAX_BYTES + 16)
    throw new Error('source_upload_package_length')
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  assertUploadCurrent(signal, current)
  if (header.length !== 16 || new TextDecoder().decode(header.subarray(0, 8)) !== 'KCMBNDL1')
    throw new Error('source_upload_package_magic')
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getBigUint64(8, true)
  if (length < 1 || length > BigInt(MANIFEST_MAX_BYTES)) throw new Error('source_upload_manifest_budget')
  const bytes = new Uint8Array(await file.slice(16, 16 + Number(length)).arrayBuffer())
  assertUploadCurrent(signal, current)
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('source_upload_invalid_manifest') }
  const manifest = checkedManifest(input), canonical = sourceUploadManifestBytes(manifest)
  assertSourceUploadPaths(manifest.files.map(file => file.relativePath))
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index]))
    throw new Error('source_upload_package_noncanonical_manifest')
  let offset = 16 + Number(length)
  const files = manifest.files.map(entry => {
    const start = offset; offset += entry.bytes
    return Object.freeze({ relativePath: entry.relativePath, blob: file.slice(start, offset) })
  })
  if (offset !== file.size) throw new Error('source_upload_package_length')
  // Payload hashes are checked by Native verification before any adoption is available.
  return { manifest, manifestSha256: hex(sha256(canonical)), files }
}
