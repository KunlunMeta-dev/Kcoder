import { isMigrationSourceCredentialSourcesParams, isMigrationSourceCredentialSourcesResult,
  type MigrationSourceCredentialSourcesParams, type MigrationSourceCredentialSourcesResult } from './generated/contracts'

export const CREDENTIAL_SOURCES_METHOD = 'migration/batch/credential-sources'
export const CREDENTIAL_SOURCES_CAPABILITY = 'migrationSourceCredentialSourcesV1'

/** Original-job locators are metadata only; all private actions require separate authorization. */
export function validCredentialSources(input: unknown, value?: unknown): boolean {
  if (!isMigrationSourceCredentialSourcesParams(input)) return false
  if (arguments.length === 1) return true
  if (!isMigrationSourceCredentialSourcesResult(value) || value.jobId !== input.jobId) return false
  const offset = input.pageIndex * 10
  return (offset === 0 || offset < value.totalItems) && value.items.length === Math.min(10, value.totalItems - offset)
    && (value.nextPage ?? null) === (offset + 10 < value.totalItems ? input.pageIndex + 1 : null)
    && new Set(value.items.map(row => JSON.stringify([row.requestId, row.manifestSha256, row.entryId]))).size === value.items.length
}

type Invoke = <T>(method: string, input: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createCredentialSourcesApi(invoke: Invoke) {
  return {
    async credentialSources(input: MigrationSourceCredentialSourcesParams, options?: { signal?: AbortSignal }): Promise<MigrationSourceCredentialSourcesResult> {
      if (!validCredentialSources(input)) throw new Error('migration_invalid_parameters')
      const result = await invoke<MigrationSourceCredentialSourcesResult>(CREDENTIAL_SOURCES_METHOD, input, options)
      if (!validCredentialSources(input, result)) throw new Error('migration_invalid_response')
      return result
    },
  }
}
