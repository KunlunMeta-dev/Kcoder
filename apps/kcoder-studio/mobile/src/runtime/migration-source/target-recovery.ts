import type { SourceTarget } from './catalog'
import type { GatewayProfile } from '@/gateway/types'
import { createMigrationSourceTransferRecovery } from './transfer-recovery'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './sessions'
import { migrationRequestId as createRandomUuid } from '../migration-client'
import type { MigrationSourceSessionParams } from '../../../../shared/generated/contracts'

export interface MigrationTargetRecoveryOptions {
  target: SourceTarget
  profile: GatewayProfile
  recoveryScope: string
  storage: Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>
  captureScope: () => string
  /** Original account fence remains usable for cleanup after the view closes. */
  captureCleanupScope: () => string
}

/** A recovery view can open only target_recovery and can never submit a transfer. */
export function createMigrationTargetRecovery(options: MigrationTargetRecoveryOptions) {
  const scope = options.captureScope()
  const target = { ...options.target }
  const recoveryScope = options.recoveryScope
  const cleanupScope = options.captureCleanupScope()
  let disposed = false
  const cache = createMigrationSourceTransferRecovery({ ...options, recoveryScope, captureScope: () => !disposed && options.captureScope() === scope ? scope : '' })
  const sessions = createMigrationSourceSessionClient({ profile: options.profile, captureScope: () => !disposed && options.captureScope() === scope ? scope : '' })
  const cleanupSessions = createMigrationSourceSessionClient({ profile: options.profile, captureScope: () => options.captureCleanupScope() === cleanupScope
    ? cleanupScope : '' })
  let owned: { requestId: string; session: MigrationSourceSessionParams; ready: boolean } | null = null
  let busy = false
  function assertCurrent() {
    if (disposed || !scope || options.captureScope() !== scope) {
      throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
    }
  }
  async function closeOwned() {
    const value = owned
    if (!value) return
    const response = await cleanupSessions.close(value.session)
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
        if (locator.request.target.targetId !== target.id
          || (locator.request.target.workspacePath ?? null) !== (target.workspacePath ?? null)) {
          throw new MigrationSourceHttpError('source_transfer_request_changed', false)
        }
        if (owned && owned.requestId !== requestId) await closeOwned()
        assertCurrent()
        if (!owned) owned = { requestId, ready: false, session: { sessionId: createRandomUuid(), purpose: 'target_recovery',
          targetId: target.id, ...(target.workspacePath === undefined ? {} : { workspacePath: target.workspacePath }) } }
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
          try { await cleanupSessions.close(selected.session) } catch { /* Native retains uncertain ownership. */ }
        }
      }
    },
    async release() {
      disposed = true
      await closeOwned()
    },
  }
}
