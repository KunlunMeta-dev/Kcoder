import { sha256 } from '@noble/hashes/sha2.js'
import { isMigrationLocalAttachmentStateResult } from '../../../shared/generated/contracts'
import type {
  HistoricalAttachmentSelection,
  HistoricalLocalAttachmentUpload,
  MigrationLocalAttachmentStateResult,
} from '../../../shared/generated/contracts'

export const MIGRATION_LOCAL_ATTACHMENT_LIMIT = 256 * 1024 * 1024
export const MIGRATION_LOCAL_ATTACHMENT_PART_BYTES = 192 * 1024

export function sameHistoricalAttachmentSelection(left: HistoricalAttachmentSelection, right: HistoricalAttachmentSelection) {
  return left.jobId === right.jobId && (left.viewId ?? null) === (right.viewId ?? null) &&
    left.position === right.position && left.blockIndex === right.blockIndex &&
    (left.toolItemIndex ?? null) === (right.toolItemIndex ?? null)
}

export interface MigrationLocalAttachmentTransferApi {
  localAttachmentBegin(params: {
    operationId: string; expectedSequence: number; filename: string; bytes: number; sha256: string
  }): Promise<MigrationLocalAttachmentStateResult>
  localAttachmentPart(params: {
    operationId: string; expectedSequence: number; index: number; contentBase64: string
  }): Promise<MigrationLocalAttachmentStateResult>
  localAttachmentRead(params: { operationId: string }): Promise<MigrationLocalAttachmentStateResult>
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64(bytes: Uint8Array): string {
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(result)
}

function assertCurrent(signal: AbortSignal, valid: () => boolean) {
  if (signal.aborted || !valid()) throw new DOMException('Aborted', 'AbortError')
}

function assertState(value: MigrationLocalAttachmentStateResult, original: HistoricalLocalAttachmentUpload) {
  if (!isMigrationLocalAttachmentStateResult(value)) throw new Error('local_attachment_upload_invalid_result')
  const state = value?.upload
  if (!state || state.operationId !== original.operationId ||
    !state.selection || !original.selection || !sameHistoricalAttachmentSelection(state.selection, original.selection) ||
    !Number.isSafeInteger(state.sequence) || state.sequence < original.sequence ||
    !Number.isSafeInteger(state.cancelRevision) || state.cancelRevision < original.cancelRevision ||
    !Number.isSafeInteger(state.receivedBytes) || state.receivedBytes < 0 ||
    state.receivedBytes > MIGRATION_LOCAL_ATTACHMENT_LIMIT ||
    !Number.isSafeInteger(state.receivedParts) || state.receivedParts < 0 || state.receivedParts > 1366 ||
    state.partBytes !== MIGRATION_LOCAL_ATTACHMENT_PART_BYTES)
    throw new Error('local_attachment_upload_invalid_result')
  return state
}

/** Bounded reads preserve the File as the authority; no historical path is opened. */
export async function uploadMigrationLocalAttachment(
  file: File,
  initial: MigrationLocalAttachmentStateResult,
  api: MigrationLocalAttachmentTransferApi,
  signal: AbortSignal,
  valid: () => boolean,
  observe: (state: MigrationLocalAttachmentStateResult) => void,
  hashing: (bytes: number | null) => void = () => undefined,
): Promise<MigrationLocalAttachmentStateResult> {
  assertCurrent(signal, valid)
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MIGRATION_LOCAL_ATTACHMENT_LIMIT)
    throw new Error('local_attachment_upload_budget_exceeded')
  let result = initial
  let current = assertState(result, initial.upload)
  if (!['prepared', 'receiving'].includes(current.stage) || current.cancelRequested)
    throw new Error('local_attachment_upload_resume_required')
  const digest = sha256.create()
  for (let offset = 0; offset < file.size; offset += MIGRATION_LOCAL_ATTACHMENT_PART_BYTES) {
    assertCurrent(signal, valid)
    const bytes = new Uint8Array(await file.slice(offset, offset + MIGRATION_LOCAL_ATTACHMENT_PART_BYTES).arrayBuffer())
    assertCurrent(signal, valid)
    digest.update(bytes)
    hashing(Math.min(offset + bytes.length, file.size))
  }
  const checksum = hex(digest.digest())
  assertCurrent(signal, valid)
  hashing(null)
  if (current.stage === 'receiving') {
    // Re-selecting a file is explicit resume, never permission to replace the accepted bytes.
    if (current.bytes !== file.size || current.filename !== file.name || current.sha256 !== checksum)
      throw new Error('local_attachment_upload_selection_changed')
  }
  try {
    if (current.stage === 'prepared') {
      result = await api.localAttachmentBegin({ operationId: current.operationId,
        expectedSequence: current.sequence, filename: file.name, bytes: file.size, sha256: checksum })
      assertCurrent(signal, valid)
      current = assertState(result, current)
      observe(result)
    }
    if (current.stage !== 'receiving' || current.cancelRequested || current.bytes !== file.size ||
      current.receivedBytes !== Math.min(current.receivedParts * MIGRATION_LOCAL_ATTACHMENT_PART_BYTES, file.size))
      throw new Error('local_attachment_upload_invalid_result')
    for (let offset = current.receivedBytes; offset < file.size;) {
      assertCurrent(signal, valid)
      const bytes = new Uint8Array(await file.slice(offset, offset + MIGRATION_LOCAL_ATTACHMENT_PART_BYTES).arrayBuffer())
      assertCurrent(signal, valid)
      const before = current
      result = await api.localAttachmentPart({ operationId: before.operationId,
        expectedSequence: before.sequence, index: before.receivedParts, contentBase64: base64(bytes) })
      assertCurrent(signal, valid)
      current = assertState(result, before)
      if (current.stage !== 'receiving' || current.cancelRequested ||
        current.receivedBytes !== offset + bytes.length || current.receivedParts !== before.receivedParts + 1 ||
        current.sequence <= before.sequence)
        throw new Error('local_attachment_upload_invalid_result')
      offset = current.receivedBytes
      observe(result)
    }
    return result
  } catch (error) {
    // A lost reply is observed once. The caller must explicitly resume; no mutation is replayed.
    if (!signal.aborted && valid()) {
      try {
        const observed = await api.localAttachmentRead({ operationId: current.operationId })
        assertCurrent(signal, valid)
        assertState(observed, current)
        observe(observed)
      } catch { /* The original operation outcome remains unknown. */ }
    }
    throw error
  }
}
