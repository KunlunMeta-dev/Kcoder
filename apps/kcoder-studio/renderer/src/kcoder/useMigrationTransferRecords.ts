import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRandomUuid } from '@/lib/random-id'
import type { GatewayServer } from './gatewayRpc'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationTargetRecovery } from './migrationTargetRecovery'
import { MigrationSourceHttpError } from './gatewayMigrationSourceHttp'
import { migrationSourceRecoveryScope } from './migrationSourceTransferScope'
import type { MigrationSourceTransferResult } from '../../../shared/generated/contracts'

type Controller = ReturnType<typeof createMigrationTargetRecovery>
type Page = ReturnType<Controller['list']>
export function useMigrationTransferRecords(target: GatewayServer, isCurrent: () => boolean) {
  const [page, setPage] = useState<Page>({ records: [], invalidRequestIds: [], total: 0, pageIndex: 0 })
  const [result, setResult] = useState<MigrationSourceTransferResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)
  const flight = useRef(false)
  const owned = useRef<Controller | null>(null)
  const currentCheck = useRef(isCurrent)
  const currentTarget = useRef(target)
  useLayoutEffect(() => { currentCheck.current = isCurrent; currentTarget.current = target }, [isCurrent, target])
  const visible = useCallback(() => active.current && currentCheck.current(), [])
  const controller = useCallback(() => {
    if (!owned.current) {
      const accountCurrent = captureAccountContextRevision()
      const identity = createRandomUuid()
      const selectedTarget = currentTarget.current
      const selectedScope = migrationSourceRecoveryScope(selectedTarget)
      owned.current = createMigrationTargetRecovery({ target: selectedTarget, storage: localStorage,
        captureScope: () => visible() && accountCurrent(selectedTarget.id)
          && migrationSourceRecoveryScope(currentTarget.current) === selectedScope ? identity : '',
        captureCleanupScope: () => accountCurrent(selectedTarget.id) ? identity : '' })
    }
    return owned.current
  }, [visible])
  const failure = useCallback((value: unknown) => {
    if (visible()) setError(value instanceof MigrationSourceHttpError ? value.code : 'source_transfer_recovery_unavailable')
  }, [visible])
  const refresh = useCallback(async (pageIndex = 0) => {
    await Promise.resolve()
    if (!visible()) return
    try { setPage(controller().list(pageIndex)); setError(null) } catch (error) { failure(error) }
  }, [controller, failure, visible])
  useEffect(() => {
    active.current = true
    void refresh()
    return () => {
      active.current = false
      if (owned.current) void owned.current.release().catch(() => {})
    }
  }, [refresh])
  const read = useCallback(async (requestId: string) => {
    if (!visible() || flight.current) return
    flight.current = true
    setBusy(true)
    setSelectedId(requestId)
    setResult(null)
    setError(null)
    try {
      const value = await controller().read(requestId)
      if (visible()) setResult(value)
    } catch (error) { failure(error) }
    finally { flight.current = false; if (visible()) setBusy(false) }
  }, [controller, failure, visible])
  return { page, result, selectedId, busy, error, refresh, read }
}
