import {
  isMigrationMemoryDiscoverParams, isMigrationMemorySourcesParams, isMigrationMemorySourcesResult,
  isMigrationMemoryListParams, isMigrationMemoryListResult, isMigrationMemoryReadParams,
  isMigrationMemoryReadResult, isMigrationMemoryControlParams, isMigrationMemoryControlReadParams,
  isMigrationMemoryControlResult,
  type MigrationMemoryDiscoverParams, type MigrationMemorySourcesParams, type MigrationMemorySourcesResult,
  type MigrationMemoryListParams, type MigrationMemoryListResult, type MigrationMemoryReadParams,
  type MigrationMemoryReadResult, type MigrationMemoryControlParams, type MigrationMemoryControlReadParams,
  type MigrationMemoryControlResult,
} from '../../../shared/generated/contracts'

export const MEMORY_CAPABILITY = 'migrationMemoryV1'
export const MEMORY_METHODS = ['discover', 'sources', 'list', 'read', 'control', 'control/read'].map(name => `migration/memory/${name}`)
export const memoryReadOnly = (method: string) => MEMORY_METHODS.includes(method) && method !== 'migration/memory/control'
type Invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => Promise<T>
const sameControl = (a: MigrationMemoryControlParams, b: MigrationMemoryControlParams) =>
  a.requestId === b.requestId && a.id === b.id && a.ownerOperationId === b.ownerOperationId
  && a.expectedRevision === b.expectedRevision && a.enabled === b.enabled && a.confirmUnverifiedNotes === b.confirmUnverifiedNotes

/** Validate typed DTOs and their request binding before any UI treats a receipt as current state. */
export function validMemoryCall(method: string, input: unknown, result?: unknown): boolean {
  const operation = method.slice('migration/memory/'.length)
  switch (operation) {
    case 'discover': return isMigrationMemoryDiscoverParams(input) && (result === undefined || isMigrationMemorySourcesResult(result) && result.items.length <= 10)
    case 'sources': return isMigrationMemorySourcesParams(input) && (result === undefined || isMigrationMemorySourcesResult(result) && result.catalogId === input.catalogId && result.items.length <= 10 && (result.nextCursor == null || result.nextCursor !== input.cursor))
    case 'list': return isMigrationMemoryListParams(input) && (result === undefined || isMigrationMemoryListResult(result) && result.items.length <= 10 && (result.nextPage == null || result.nextPage === (input.pageIndex ?? 0) + 1))
    case 'read': return isMigrationMemoryReadParams(input) && (result === undefined || isMigrationMemoryReadResult(result)
      && result.record.id === input.id && new TextEncoder().encode(result.text).length <= 8192
      && (input.offset ?? 0) + new TextEncoder().encode(result.text).length <= result.totalBytes
      && (result.nextOffset == null ? (input.offset ?? 0) + new TextEncoder().encode(result.text).length === result.totalBytes
        : result.nextOffset === (input.offset ?? 0) + new TextEncoder().encode(result.text).length && result.nextOffset > (input.offset ?? 0)))
    case 'control': return isMigrationMemoryControlParams(input) && (!input.enabled || input.confirmUnverifiedNotes) && (result === undefined || isMigrationMemoryControlResult(result)
      && !!result.receipt && sameControl(input, result.receipt.request)
      && (!result.current || result.current.id === input.id && result.current.ownerOperationId === input.ownerOperationId))
    case 'control/read': return isMigrationMemoryControlReadParams(input) && (result === undefined || isMigrationMemoryControlResult(result)
      && (!result.receipt || result.receipt.request.requestId === input.requestId)
      && (!result.current || !!result.receipt && result.current.id === result.receipt.request.id && result.current.ownerOperationId === result.receipt.request.ownerOperationId))
    default: return false
  }
}

export function createMemoryApi(invoke: Invoke) {
  const call = async <T>(method: string, input: object, options?: { signal?: AbortSignal }) => {
    if (!validMemoryCall(method, input)) throw new Error('migration_invalid_parameters')
    const result = await invoke<T>(method, input, options)
    if (!validMemoryCall(method, input, result)) throw new Error('migration_invalid_response')
    return result
  }
  return {
    memoryDiscover: (input: MigrationMemoryDiscoverParams, options?: { signal?: AbortSignal }) => call<MigrationMemorySourcesResult>('migration/memory/discover', input, options),
    memorySources: (input: MigrationMemorySourcesParams, options?: { signal?: AbortSignal }) => call<MigrationMemorySourcesResult>('migration/memory/sources', input, options),
    memoryList: (input: MigrationMemoryListParams, options?: { signal?: AbortSignal }) => call<MigrationMemoryListResult>('migration/memory/list', input, options),
    memoryRead: (input: MigrationMemoryReadParams, options?: { signal?: AbortSignal }) => call<MigrationMemoryReadResult>('migration/memory/read', input, options),
    memoryControl: (input: MigrationMemoryControlParams) => call<MigrationMemoryControlResult>('migration/memory/control', input),
    memoryControlRead: (input: MigrationMemoryControlReadParams, options?: { signal?: AbortSignal }) => call<MigrationMemoryControlResult>('migration/memory/control/read', input, options),
  }
}
