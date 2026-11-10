import {
  isMigrationSourceTransferReadParams,
  isMigrationSourceTransferRunParams,
  isMigrationSourceSessionParams,
  type MigrationSourceTransferReadParams,
  type MigrationSourceTransferRunParams,
  type MigrationSourceSessionParams,
} from '../../../shared/generated/contracts'
import { createMigrationSourceTransferClient } from './gatewayMigrationSourceTransfers'
import { MigrationSourceHttpError, type MigrationSourceHttpOptions } from './gatewayMigrationSourceHttp'

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>
interface RecoveryOptions extends MigrationSourceHttpOptions {
  storage: StoragePort
  /** Stable account and target namespace; must not contain credentials. */
  recoveryScope: string
}
interface Locator {
  version: 1
  request: MigrationSourceTransferReadParams
  attemptId: string
}

/** Locators are navigation hints, never receipts or permission to replay a mutation. */
export function createMigrationSourceTransferRecovery(options: RecoveryOptions) {
  const client = createMigrationSourceTransferClient(options)
  const scope = options.captureScope()
  if (!scope || !options.recoveryScope) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
  const prefix = `kcoder.migration.transfer:${encodeURIComponent(options.recoveryScope)}:`
  function assertScope() {
    if (options.captureScope() !== scope) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
  }
  function key(requestId: string) {
    // Reuse the authoritative request validator rather than maintaining another UUID codec.
    const probe = { requestId, source: { sessionId: requestId, purpose: 'source', targetId: '_' },
      target: { sessionId: requestId, purpose: 'target', targetId: '_' } }
    if (!isMigrationSourceTransferReadParams(probe)) throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
    return prefix + requestId
  }
  function load(requestId: string): Locator | null {
    assertScope()
    let value: unknown
    try {
      const raw = options.storage.getItem(key(requestId))
      if (raw === null) return null
      if (raw.length > 32 * 1024) throw new Error('oversized locator')
      value = JSON.parse(raw)
    } catch {
      throw new MigrationSourceHttpError('source_transfer_recovery_unavailable', false)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MigrationSourceHttpError('source_transfer_recovery_invalid', false)
    const item = value as Partial<Locator>
    if (Object.keys(item).sort().join(',') !== 'attemptId,request,version' || item.version !== 1
      || !isMigrationSourceTransferReadParams(item.request) || item.request.requestId !== requestId
      || item.request.source.purpose !== 'source' || item.request.target.purpose !== 'target'
      || !isMigrationSourceTransferRunParams({ ...item.request, attemptId: item.attemptId })) {
      throw new MigrationSourceHttpError('source_transfer_recovery_invalid', false)
    }
    assertScope()
    return item as Locator
  }
  return {
    load,
    list(pageIndex = 0) {
      assertScope()
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
      }
      const ids: string[] = []
      try {
        for (let index = 0; index < options.storage.length; index++) {
          const name = options.storage.key(index)
          if (name?.startsWith(prefix)) ids.push(name.slice(prefix.length))
        }
      } catch {
        throw new MigrationSourceHttpError('source_transfer_recovery_unavailable', false)
      }
      ids.sort()
      const records: Locator[] = []
      const invalidRequestIds: string[] = []
      for (const id of ids.slice(pageIndex * 10, pageIndex * 10 + 10)) {
        try {
          const record = load(id)
          if (record) records.push(record)
        } catch (error) {
          if (error instanceof MigrationSourceHttpError && error.code === 'source_transfer_authority_changed') throw error
          invalidRequestIds.push(id)
        }
      }
      assertScope()
      return { records, invalidRequestIds, total: ids.length, pageIndex }
    },
    async start(input: MigrationSourceTransferRunParams, signal?: AbortSignal) {
      assertScope()
      if (signal?.aborted) throw new MigrationSourceHttpError('source_transfer_request_not_sent', false)
      if (!isMigrationSourceTransferRunParams(input) || !input.selections || input.resume != null
        || input.source.purpose !== 'source' || input.target.purpose !== 'target') {
        throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
      }
      // A second submission must first reconcile, including after an uncertain first reply.
      if (load(input.requestId)) throw new MigrationSourceHttpError('source_transfer_reconcile_required', false)
      const locator: Locator = { version: 1, attemptId: input.attemptId,
        request: { requestId: input.requestId, source: input.source, target: input.target } }
      const raw = JSON.stringify(locator)
      try {
        if (raw.length > 32 * 1024) throw new Error('oversized locator')
        options.storage.setItem(key(input.requestId), raw)
        if (options.storage.getItem(key(input.requestId)) !== raw) throw new Error('locator not retained')
      } catch {
        throw new MigrationSourceHttpError('source_transfer_recovery_unavailable', false)
      }
      assertScope()
      return client.run(input, signal)
    },
    async reconcile(requestId: string, signal?: AbortSignal) {
      const locator = load(requestId)
      if (!locator) throw new MigrationSourceHttpError('source_transfer_recovery_missing', false)
      return client.read(locator.request, signal)
    },
    async reconcileTarget(requestId: string, target: MigrationSourceSessionParams, signal?: AbortSignal) {
      const locator = load(requestId)
      if (!locator) throw new MigrationSourceHttpError('source_transfer_recovery_missing', false)
      if (!isMigrationSourceSessionParams(target) || target.purpose !== 'target_recovery'
        || target.targetId !== locator.request.target.targetId
        || (target.workspacePath ?? null) !== (locator.request.target.workspacePath ?? null)) {
        throw new MigrationSourceHttpError('source_transfer_request_changed', false)
      }
      // The caller explicitly opened a fresh target recovery connection. Never
      // reopen or contact the unavailable source to inspect the original receipt.
      return client.targetRead({ requestId, target }, signal)
    },
  }
}
