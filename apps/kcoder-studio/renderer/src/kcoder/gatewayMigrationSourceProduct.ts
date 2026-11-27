import {
  isMigrationSourceProductParams, isMigrationSourceProductRunParams, isMigrationSourceProductCancelParams,
  isMigrationSourceProductStateResult, type MigrationSourceProductParams, type MigrationSourceProductRunParams,
  type MigrationSourceProductCancelParams, type MigrationSourceProductStateResult,
} from '../../../shared/generated/contracts'

export const SOURCE_PRODUCT_CAPABILITY = 'migrationSourceUploadedV1'
export const SOURCE_PRODUCT_METHODS = ['run', 'read', 'cancel', 'resume'].map(name => `migration/source/upload/product/${name}`)
export const sourceProductReadOnly = (method: string) => method === 'migration/source/upload/product/read'
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>

export function validSourceProductCall(method: string, input: unknown, result?: unknown): boolean {
  const operation = method.slice('migration/source/upload/product/'.length)
  const valid = operation === 'read' ? isMigrationSourceProductParams(input)
    : operation === 'cancel' ? isMigrationSourceProductCancelParams(input)
      : ['run', 'resume'].includes(operation) && isMigrationSourceProductRunParams(input)
  if (!valid) return false
  if (result === undefined) return true
  if (!isMigrationSourceProductStateResult(result)) return false
  const request = input as MigrationSourceProductParams, state = result.materialization
  return state.operationId === request.operationId && state.manifestSha256 === request.manifestSha256
    && [state.totalBytes, state.receivedBytes, state.verifiedBytes, state.sequence, state.cancelWatermark].every(Number.isSafeInteger)
    && state.totalBytes <= 2 * 1024 ** 3 && state.receivedBytes === state.totalBytes && state.verifiedBytes <= state.totalBytes
    && state.totalFiles >= 1 && state.totalFiles <= 1024 && state.completedFiles <= state.totalFiles && state.cancelWatermark <= state.sequence
    && (state.stage !== 'ready' || state.verifiedBytes === state.totalBytes && state.completedFiles === state.totalFiles && !state.cancelRequested)
}

export function createSourceProductApi(invoke: Invoke) {
  const call = async <T>(method: string, params: object, options?: { signal?: AbortSignal }) => {
    if (!validSourceProductCall(method, params)) throw new Error('migration_invalid_parameters')
    const result = await invoke<T>(method, params, options)
    if (!validSourceProductCall(method, params, result)) throw new Error('migration_invalid_response')
    return result
  }
  return {
    sourceProductRun: (input: MigrationSourceProductRunParams) => call<MigrationSourceProductStateResult>('migration/source/upload/product/run', input),
    sourceProductRead: (input: MigrationSourceProductParams, options?: { signal?: AbortSignal }) => call<MigrationSourceProductStateResult>('migration/source/upload/product/read', input, options),
    sourceProductCancel: (input: MigrationSourceProductCancelParams) => call<MigrationSourceProductStateResult>('migration/source/upload/product/cancel', input),
    sourceProductResume: (input: MigrationSourceProductRunParams) => call<MigrationSourceProductStateResult>('migration/source/upload/product/resume', input),
  }
}
