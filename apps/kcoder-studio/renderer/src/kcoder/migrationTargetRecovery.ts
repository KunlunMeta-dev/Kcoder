import type { GatewayServer } from './gatewayRpc'
import { migrationSourceRecoveryScope } from './migrationSourceTransferScope'
import { createMigrationSourceTransferRecovery } from './migrationSourceTransferRecovery'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { createRandomUuid } from '@/lib/random-id'
import type { MigrationSourceSessionParams } from '../../../shared/generated/contracts'

export interface MigrationTargetRecoveryOptions {
  target: GatewayServer
  storage: Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>
  captureScope: () => string
  /** Original account fence remains usable for cleanup after the view closes. */
  captureCleanupScope: () => string
  fetcher?: typeof fetch
}

/** A recovery view can open only target_recovery and can never submit a transfer. */
export function createMigrationTargetRecovery(options: MigrationTargetRecoveryOptions) {
  const scope = options.captureScope()
  const recoveryScope = migrationSourceRecoveryScope(options.target)
  const cleanupScope = options.captureCleanupScope()
  const cache = createMigrationSourceTransferRecovery({ ...options, recoveryScope })
  const sessions = createMigrationSourceSessionClient({ captureScope: () => options.captureCleanupScope() === cleanupScope
    && migrationSourceRecoveryScope(options.target) === recoveryScope ? cleanupScope : '', fetcher: options.fetcher })
  let owned: { requestId: string; session: MigrationSourceSessionParams; ready: boolean } | null = null
  let disposed = false
  let busy = false
  function assertCurrent() {
    if (disposed || !scope || options.captureScope() !== scope || migrationSourceRecoveryScope(options.target) !== recoveryScope) {
      throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
    }
  }
  async function closeOwned() {
    const value = owned
    if (!value) return
    const response = await sessions.close(value.session)
    if (response.status !== 'released') throw new MigrationSourceHttpError('source_transfer_release_pending', false)
    if (owned === value) owned = null
  }
  return {
    list(page = 0) { assertCurrent(); return cache.list(page) },
    async read(requestId: string) {
      assertCurrent()
      if (busy) throw new MigrationSourceHttpError('source_transfer_busy', false)
      busy = true
      let selected: typeof owned = null
      try {
        const locator = cache.load(requestId)
        if (!locator) throw new MigrationSourceHttpError('source_transfer_recovery_missing', false)
        if (locator.request.target.targetId !== options.target.id
          || (locator.request.target.workspacePath ?? null) !== (options.target.workspacePath ?? null)) {
          throw new MigrationSourceHttpError('source_transfer_request_changed', false)
        }
        if (owned && owned.requestId !== requestId) await closeOwned()
        assertCurrent()
        if (!owned) owned = { requestId, ready: false, session: { sessionId: createRandomUuid(), purpose: 'target_recovery',
          targetId: options.target.id, ...(options.target.workspacePath === undefined ? {} : { workspacePath: options.target.workspacePath }) } }
        selected = owned
        if (!selected.ready) {
          const opened = await sessions.open(selected.session)
          assertCurrent()
          if (opened.status !== 'ready') throw new MigrationSourceHttpError('source_transfer_target_not_ready', false)
          selected.ready = true
        }
        const result = await cache.reconcileTarget(requestId, selected.session)
        assertCurrent()
        return result
      } finally {
        busy = false
        if (disposed && selected) {
          // Cleanup may have raced with an open that finished after release().
          try { await sessions.close(selected.session) } catch { /* Native retains uncertain ownership. */ }
        }
      }
    },
    async release() {
      disposed = true
      await closeOwned()
    },
  }
}
