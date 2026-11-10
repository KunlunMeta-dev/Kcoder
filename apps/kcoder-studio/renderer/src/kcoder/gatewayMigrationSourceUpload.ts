import {
  isMigrationSourceUploadPrepareParams, isMigrationSourceUploadReadParams, isMigrationSourceUploadFilesParams,
  isMigrationSourceUploadPartParams, isMigrationSourceUploadRunParams, isMigrationSourceUploadCancelParams,
  isMigrationSourceUploadStateResult, isMigrationSourceUploadFilesResult,
  type MigrationSourceUploadPrepareParams, type MigrationSourceUploadReadParams, type MigrationSourceUploadFilesParams,
  type MigrationSourceUploadPartParams, type MigrationSourceUploadRunParams, type MigrationSourceUploadCancelParams,
  type MigrationSourceUploadStateResult, type MigrationSourceUploadFilesResult,
} from '../../../shared/generated/contracts'

export const SOURCE_UPLOAD_CAPABILITY = 'migrationSourceUploadV1'
export const SOURCE_UPLOAD_METHODS = ['prepare', 'read', 'files', 'part', 'finish', 'cancel', 'resume'].map(name => `migration/source/upload/${name}`)
export const sourceUploadReadOnly = (method: string) => ['migration/source/upload/read', 'migration/source/upload/files'].includes(method)
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>

export function validSourceUploadCall(method: string, input: unknown, result?: unknown): boolean {
  const operation = method.slice('migration/source/upload/'.length)
  const valid = operation === 'prepare' ? isMigrationSourceUploadPrepareParams(input)
    : operation === 'read' ? isMigrationSourceUploadReadParams(input)
      : operation === 'files' ? isMigrationSourceUploadFilesParams(input)
        : operation === 'part' ? isMigrationSourceUploadPartParams(input)
          : operation === 'cancel' ? isMigrationSourceUploadCancelParams(input)
            : ['finish', 'resume'].includes(operation) && isMigrationSourceUploadRunParams(input)
  if (!valid) return false
  if (result === undefined) return true
  const id = (input as { operationId: string }).operationId
  if (operation === 'files') return isMigrationSourceUploadFilesResult(result) && result.page.operationId === id && result.page.files.length <= 10
    && (result.page.nextCursor == null || result.page.nextCursor > ((input as MigrationSourceUploadFilesParams).cursor ?? 0))
  if (!isMigrationSourceUploadStateResult(result) || result.upload.operationId !== id) return false
  const state = result.upload
  return [state.totalBytes, state.receivedBytes, state.verifiedBytes, state.sequence, state.cancelWatermark].every(Number.isSafeInteger)
    && state.totalBytes <= 2 * 1024 ** 3 && state.receivedBytes <= state.totalBytes && state.verifiedBytes <= state.totalBytes
    && state.totalFiles <= 1024 && state.completedFiles <= state.totalFiles && state.cancelWatermark <= state.sequence
}

export function createSourceUploadApi(invoke: Invoke) {
  const call = async <T>(method: string, input: object, options?: { signal?: AbortSignal }) => {
    if (!validSourceUploadCall(method, input)) throw new Error('migration_invalid_parameters')
    const result = await invoke<T>(method, input, options)
    if (!validSourceUploadCall(method, input, result)) throw new Error('migration_invalid_response')
    return result
  }
  return {
    sourceUploadPrepare: (input: MigrationSourceUploadPrepareParams) => call<MigrationSourceUploadStateResult>('migration/source/upload/prepare', input),
    sourceUploadRead: (input: MigrationSourceUploadReadParams, options?: { signal?: AbortSignal }) => call<MigrationSourceUploadStateResult>('migration/source/upload/read', input, options),
    sourceUploadFiles: (input: MigrationSourceUploadFilesParams, options?: { signal?: AbortSignal }) => call<MigrationSourceUploadFilesResult>('migration/source/upload/files', input, options),
    sourceUploadPart: (input: MigrationSourceUploadPartParams) => call<MigrationSourceUploadStateResult>('migration/source/upload/part', input),
    sourceUploadFinish: (input: MigrationSourceUploadRunParams) => call<MigrationSourceUploadStateResult>('migration/source/upload/finish', input),
    sourceUploadCancel: (input: MigrationSourceUploadCancelParams) => call<MigrationSourceUploadStateResult>('migration/source/upload/cancel', input),
    sourceUploadResume: (input: MigrationSourceUploadRunParams) => call<MigrationSourceUploadStateResult>('migration/source/upload/resume', input),
  }
}
