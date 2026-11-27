import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HistoryViewLeaseController, type HistoryViewSnapshot } from '../../../shared/historyViewLease'
import { createMigrationApi } from './gatewayMigration'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'
import { HISTORY_VIEW_UNCONFIRMED_EVENT } from './gatewayMigrationViewRouting'

const EMPTY: HistoryViewSnapshot = { state: 'idle', lease: null, error: '' }
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function useMigrationHistoryView(input: { deviceId: string; workspacePath?: string; jobId: string; archiveId?: string | null; viewId?: string; isCurrent: () => boolean }) {
  const { deviceId, workspacePath, jobId, archiveId, viewId } = input
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const key = JSON.stringify([deviceId, workspacePath, jobId, archiveId, viewId])
  const active = useRef(input.isCurrent)
  useLayoutEffect(()=>{active.current=input.isCurrent},[input.isCurrent])
  const owner = useRef<{ key: string; controller: HistoryViewLeaseController; valid: () => boolean } | null>(null)
  const [value, setValue] = useState({ key, snapshot: EMPTY })
  useEffect(() => {
    if (!archiveId) return
    const account = captureAccountContextRevision()
    const valid = () => active.current() && account(deviceId)
    const controller = new HistoryViewLeaseController(api, { jobId, archiveId, viewId }, requestId)
    const current = { key, controller, valid }; owner.current = current
    const unsubscribe = controller.subscribe(() => { if (owner.current === current) setValue({ key, snapshot: controller.snapshot() }) })
    const invalidate = () => controller.invalidate()
    const visibility = () => { if (document.hidden) invalidate() }
    const lost = (event: Event) => { if ((event as CustomEvent).detail?.requestId === controller.requestId()) invalidate() }
    const stopAccount = listenAccountContextChanges(target => { if (target === deviceId) invalidate() })
    window.addEventListener('offline', invalidate)
    window.addEventListener(HISTORY_VIEW_UNCONFIRMED_EVENT, lost)
    document.addEventListener('visibilitychange', visibility)
    if (valid()) void controller.open()
    return () => {
      if (owner.current === current) owner.current = null
      unsubscribe(); stopAccount()
      window.removeEventListener('offline', invalidate)
      window.removeEventListener(HISTORY_VIEW_UNCONFIRMED_EVENT, lost)
      document.removeEventListener('visibilitychange', visibility)
      controller.dispose()
    }
  }, [api, key, deviceId, jobId, archiveId, viewId])
  const open = useCallback(() => { const current = owner.current; if (current?.key === key && current.valid()) void current.controller.open() }, [key])
  const release = useCallback(async () => {
    const current = owner.current
    if (!current || current.key !== key || !current.valid()) throw new Error('history_view_scope_changed')
    await current.controller.release()
  }, [key])
  return { ...(value.key === key ? value.snapshot : EMPTY), open, release }
}
