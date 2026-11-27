import { useRetainedPageVisible } from '@/components/layout/retainedPageState'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { currentHostServer } from '@/features/runtime-target/currentHostTarget'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGatewayServers, isKCoderGatewayPage, type GatewayServer } from '@/kcoder/gatewayRpc'
import { readProviderSettings, type ProviderSettings } from '@/kcoder/providerSettings'
import { captureAccountContextRevision, listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { getRuntimeConfig } from '@/config/runtime'
import { MigrationFirstUsePanel } from './MigrationFirstUsePanel'

/** Read only the current target profile; multiple unselected targets and unavailable reads remain unknown. */
export function MigrationFirstUseLauncher({ targetId, workspacePath, enabled }: {
  targetId?: string | null; workspacePath?: string; enabled: boolean
}) {
  const [value, setValue] = useState<{ key: string; target: GatewayServer; settings: ProviderSettings; valid: () => boolean } | null>(null)
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false)
  const visible = useRetainedPageVisible()
  const isVisible = useStableEvent(() => visible)
  const key = JSON.stringify([targetId]), readController = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    readController.current?.abort()
    readController.current = null
    if (!enabled || !isKCoderGatewayPage()) return
    setLoading(true); setFailed(false)
    if (!isVisible()) return
    const request = new AbortController()
    readController.current = request
    const account = captureAccountContextRevision(), mount = getRuntimeConfig().appBasePath
    const valid = (id = targetId ?? '') => !request.signal.aborted && account(id)
      && getRuntimeConfig().appBasePath === mount && isVisible()
    try {
      await Promise.resolve()
      if (!valid()) return
      const targets = await fetchGatewayServers(fetch, { signal: request.signal })
      const target = targetId ? targets.find(item => item.id === targetId) : currentHostServer(targets)
      if (!valid(target?.id)) return
      if (!target || target.security?.identity.mode === 'kcoder-account' && !target.accountIdentity) { setValue(null); return }
      const settings = await readProviderSettings(target.id)
      if (valid(target.id)) setValue({ key, target, settings, valid: () => account(target.id) && getRuntimeConfig().appBasePath === mount })
    } catch {
      if (valid()) setFailed(true)
    } finally {
      if (readController.current === request) readController.current = null
      if (valid()) setLoading(false)
    }
  }, [enabled, targetId, key, isVisible])
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active && visible) void refresh() })
    const changed = (event?: Event) => {
      const id = (event as CustomEvent<{ targetId?: string }> | undefined)?.detail?.targetId
      if (!id || !targetId || id === targetId) void refresh()
    }
    const stop = listenAccountContextChanges(id => { if (!targetId || id === targetId) { setValue(null); changed() } })
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      active = false
      readController.current?.abort()
      readController.current = null
      stop()
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [refresh, targetId, visible])
  if (!enabled || value?.key !== key || !value.valid()) return null
  return <MigrationFirstUsePanel key={migrationSourceRecoveryScope(value.target)} target={value.target} workspacePath={workspacePath} settings={loading || failed ? null : value.settings} onRefresh={refresh}/>
}
