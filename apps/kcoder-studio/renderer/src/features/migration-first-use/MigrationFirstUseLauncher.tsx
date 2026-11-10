import { currentHostServer } from '@/features/runtime-target/currentHostTarget'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGatewayServers, isKCoderGatewayPage, type GatewayServer } from '@/kcoder/gatewayRpc'
import { readProviderSettings, type ProviderSettings } from '@/kcoder/providerSettings'
import { captureAccountContextRevision, listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { getRuntimeConfig } from '@/config/runtime'
import { MigrationFirstUsePanel } from './MigrationFirstUsePanel'

/** Read only the current target; multiple unselected targets and unavailable reads remain unknown. */
export function MigrationFirstUseLauncher({ targetId, workspacePath, enabled }: {
  targetId?: string | null; workspacePath?: string; enabled: boolean
}) {
  const [value, setValue] = useState<{ key: string; target: GatewayServer; settings: ProviderSettings; valid: () => boolean } | null>(null)
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false)
  const key = JSON.stringify([targetId, workspacePath]), generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!enabled || !isKCoderGatewayPage()) return
    const request = ++generation.current, account = captureAccountContextRevision(), mount = getRuntimeConfig().appBasePath
    setLoading(true); setFailed(false)
    const valid = (id: string) => request === generation.current && account(id) && getRuntimeConfig().appBasePath === mount
    try {
      const targets = await fetchGatewayServers()
      const target = targetId ? targets.find(item => item.id === targetId) : currentHostServer(targets)
      if (!target || target.security?.identity.mode === 'kcoder-account' && !target.accountIdentity) { if (request === generation.current) setValue(null); return }
      if (!valid(target.id)) return
      const settings = await readProviderSettings(target.id)
      if (valid(target.id)) setValue({ key, target, settings, valid: () => account(target.id) && getRuntimeConfig().appBasePath === mount })
    } catch {
      if (request === generation.current) setFailed(true)
    } finally { if (request === generation.current) setLoading(false) }
  }, [enabled, targetId, key])
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    const changed = () => { void refresh() }
    const stop = listenAccountContextChanges(id => { if (!targetId || id === targetId) { generation.current += 1; setValue(null); void refresh() } })
    window.addEventListener('kcoder:servers-changed', changed)
    return () => { window.clearTimeout(timer); generation.current += 1; stop(); window.removeEventListener('kcoder:servers-changed', changed) }
  }, [refresh, targetId])
  if (!enabled || value?.key !== key || !value.valid()) return null
  return <MigrationFirstUsePanel key={migrationSourceRecoveryScope(value.target)} target={value.target} workspacePath={workspacePath} settings={loading || failed ? null : value.settings} onRefresh={refresh}/>
}
