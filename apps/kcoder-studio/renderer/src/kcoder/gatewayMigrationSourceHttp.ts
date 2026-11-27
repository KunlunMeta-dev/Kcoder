import { getRuntimeConfig, joinAppPath } from '@/config/runtime'

export class MigrationSourceHttpError extends Error {
  readonly code: string
  readonly outcomeUnknown: boolean
  constructor(code: string, outcomeUnknown: boolean) {
    super(code)
    this.code = code
    this.outcomeUnknown = outcomeUnknown
    this.name = 'MigrationSourceHttpError'
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('missing response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > 2 * 1024 * 1024) {
        await reader.cancel()
        throw new Error('response too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export interface MigrationSourceHttpOptions {
  captureScope: () => string
  fetcher?: typeof fetch
}

/** Internal transport: mutation retries and resource cleanup remain explicit. */
export function createMigrationSourceHttpTransport(
  { captureScope, fetcher = fetch }: MigrationSourceHttpOptions,
  lane: 'source-session' | 'source-transfer' | 'source-transfer/private',
  readOnly: ReadonlySet<string>,
  validError: (value: unknown) => boolean = value => typeof value === 'string' && /^source_transfer_[a-z_]+$/.test(value)
) {
  async function request<T>(operation: string, input: unknown, validInput: (value: unknown) => boolean,
    validResult: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
    const mutation = !readOnly.has(operation)
    if (!validInput(input)) throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
    const scope = captureScope()
    const basePath = getRuntimeConfig().appBasePath
    const current = () => captureScope() === scope && getRuntimeConfig().appBasePath === basePath
    if (!scope || signal?.aborted) throw new MigrationSourceHttpError('source_transfer_request_not_sent', false)
    const body = JSON.stringify(input)
    let dispatched = false
    try {
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
      dispatched = true
      const response = await fetcher(joinAppPath(basePath, `/api/migration/${lane}/${encodeURIComponent(operation)}`), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body, signal,
      })
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', mutation)
      const result = await boundedJson(response)
      if (!current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', mutation)
      if (!response.ok) {
        const error = result && typeof result === 'object' && 'error' in result ? result.error : null
        throw new MigrationSourceHttpError(typeof error === 'string' && validError(error)
          ? error : 'source_transfer_outcome_unknown', mutation)
      }
      if (!validResult(result)) throw new MigrationSourceHttpError('source_transfer_invalid_response', mutation)
      return result
    } catch (error) {
      if (error instanceof MigrationSourceHttpError) throw error
      throw new MigrationSourceHttpError('source_transfer_outcome_unknown', dispatched && mutation)
    }
  }
  return request
}
