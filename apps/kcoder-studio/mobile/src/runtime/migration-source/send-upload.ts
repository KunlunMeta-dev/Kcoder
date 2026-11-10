import { isMigrationSourceUploadFilesResult, isMigrationSourceUploadStateResult } from '../../../../shared/generated/contracts'
import type { MigrationSourceUploadFilesParams, MigrationSourceUploadFilesResult,
  MigrationSourceUploadPartParams, MigrationSourceUploadReadParams, MigrationSourceUploadRunParams,
  MigrationSourceUploadStateResult } from '../../../../shared/generated/contracts'
import { assertUploadCurrent, SOURCE_UPLOAD_PART_BYTES, type SelectedSourceUpload } from './files'

export interface SourceUploadApi {
  read(params: MigrationSourceUploadReadParams): Promise<MigrationSourceUploadStateResult>
  files(params: MigrationSourceUploadFilesParams): Promise<MigrationSourceUploadFilesResult>
  part(params: MigrationSourceUploadPartParams): Promise<MigrationSourceUploadStateResult>
  finish(params: MigrationSourceUploadRunParams): Promise<MigrationSourceUploadStateResult>
}
function base64(bytes: Uint8Array) {
  let value = ''
  for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(value)
}
function assertState(value: MigrationSourceUploadStateResult, previous: MigrationSourceUploadStateResult, selected: SelectedSourceUpload) {
  const before = previous.upload, next = value.upload
  if (!isMigrationSourceUploadStateResult(value) || next.operationId !== before.operationId ||
    next.manifestSha256 !== selected.manifestSha256 || next.source !== selected.manifest.source ||
    next.totalFiles !== selected.files.length || next.totalBytes !== selected.manifest.files.reduce((sum, file) => sum + file.bytes, 0) ||
    next.sequence < before.sequence || next.cancelWatermark < before.cancelWatermark || next.receivedBytes < before.receivedBytes ||
    next.receivedBytes > next.totalBytes || next.verifiedBytes > next.totalBytes)
    throw new Error('source_upload_invalid_result')
}

/** Called only after explicit prepare/resume. Failed writes are observed, never replayed here. */
export async function sendSourceUploadFiles(
  selected: SelectedSourceUpload, initial: MigrationSourceUploadStateResult, api: SourceUploadApi,
  signal: AbortSignal, current: () => boolean, observe: (value: MigrationSourceUploadStateResult) => void,
): Promise<MigrationSourceUploadStateResult> {
  assertUploadCurrent(signal, current)
  if (!isMigrationSourceUploadStateResult(initial)) throw new Error('source_upload_invalid_result')
  assertState(initial, initial, selected)
  let result = initial
  if (result.upload.stage === 'ready') return result
  if (result.upload.cancelRequested || result.upload.workerState !== 'stopped') throw new Error('source_upload_resume_required')
  try {
    let cursor: number | null = null, seen = 0
    do {
      assertUploadCurrent(signal, current)
      const response = await api.files({ operationId: result.upload.operationId, cursor })
      assertUploadCurrent(signal, current)
      if (!isMigrationSourceUploadFilesResult(response) || response.page.operationId !== result.upload.operationId ||
        response.page.manifestSha256 !== selected.manifestSha256 || response.page.files.length < 1 || response.page.files.length > 10)
        throw new Error('source_upload_invalid_result')
      for (const progress of response.page.files) {
        const index = seen++, entry = selected.manifest.files[index], file = selected.files[index]?.blob
        if (!entry || !file || progress.fileIndex !== index || progress.acceptedBytes > entry.bytes ||
          !Number.isSafeInteger(progress.acceptedBytes) || progress.acceptedBytes < 0 ||
          progress.complete !== (progress.acceptedBytes === entry.bytes) ||
          progress.nextPart !== Math.ceil(progress.acceptedBytes / SOURCE_UPLOAD_PART_BYTES) ||
          (!progress.complete && progress.acceptedBytes % SOURCE_UPLOAD_PART_BYTES !== 0)) throw new Error('source_upload_invalid_result')
        for (let offset = progress.acceptedBytes; offset < entry.bytes; offset += SOURCE_UPLOAD_PART_BYTES) {
          assertUploadCurrent(signal, current)
          const bytes = new Uint8Array(await file.slice(offset, offset + SOURCE_UPLOAD_PART_BYTES).arrayBuffer())
          assertUploadCurrent(signal, current)
          if (bytes.length !== Math.min(SOURCE_UPLOAD_PART_BYTES, entry.bytes - offset)) throw new Error('source_upload_file_changed')
          const previous = result
          result = await api.part({ operationId: previous.upload.operationId, cancelWatermark: previous.upload.cancelWatermark,
            fileIndex: index, partIndex: offset / SOURCE_UPLOAD_PART_BYTES, contentBase64: base64(bytes) })
          assertUploadCurrent(signal, current); assertState(result, previous, selected); observe(result)
          if (result.upload.cancelRequested || result.upload.cancelWatermark !== previous.upload.cancelWatermark)
            throw new Error('source_upload_resume_required')
        }
      }
      cursor = response.page.nextCursor ?? null
      if (cursor !== null && (cursor !== seen || cursor >= selected.files.length)) throw new Error('source_upload_invalid_result')
    } while (cursor !== null)
    if (seen !== selected.files.length) throw new Error('source_upload_invalid_result')
    assertUploadCurrent(signal, current)
    const before = result
    result = await api.finish({ operationId: before.upload.operationId, expectedSequence: before.upload.sequence,
      cancelWatermark: before.upload.cancelWatermark })
    assertUploadCurrent(signal, current); assertState(result, before, selected); observe(result)
    return result
  } catch (error) {
    if (!signal.aborted && current()) {
      try {
        const read = await api.read({ operationId: initial.upload.operationId })
        assertUploadCurrent(signal, current); assertState(read, initial, selected); observe(read)
      } catch { /* Unknown receipts stay unknown until an explicit reconciliation. */ }
    }
    throw error
  }
}
