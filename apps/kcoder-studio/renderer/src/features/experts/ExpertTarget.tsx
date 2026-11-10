import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isIntegrationScope } from '../../../../shared/generated/contractGuards.mjs'
import { OfficeController } from '@/features/office-integration/controller'
import { nativeOfficeTransport } from '@/features/runtime-governance/nativeOfficeTransport'
import { readNativeOfficeSettings, saveNativeOfficeSettings, applyNativeOfficeSettings } from '@/features/runtime-governance/nativeOfficeSettings'
import type { OfficeSettingsReadResult } from '../../../../shared/generated/contracts'
import { ExpertClient } from './client'

export function ExpertTarget({
  serverId,
  workspacePath,
  isCurrent,
  onReconnect,
  renderFallback,
  loadingFallback,
  children,
}: {
  serverId: string
  workspacePath?: string
  isCurrent: () => boolean
  onReconnect: () => void
  renderFallback?: (content: ReactNode) => ReactNode
  loadingFallback?: ReactNode
  children: (client: ExpertClient) => ReactNode
}) {
  const { t } = useTranslation('experts')
  const [settings, setSettings] = useState<OfficeSettingsReadResult>()
  const [client, setClient] = useState<{ value: ExpertClient; signal: AbortSignal }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [uncertain, setUncertain] = useState(false)
  const owner = useRef<AbortController | null>(null)
  useEffect(() => {
    const lifetime = new AbortController()
    owner.current = lifetime
    let transport: ReturnType<typeof nativeOfficeTransport> | undefined
    const current = () => !lifetime.signal.aborted && isCurrent()
    // Activity retains state but disposes effects. Never reuse that disposed transport.
    queueMicrotask(() => {
      if (!current()) return
      setClient(undefined)
      setSettings(undefined)
      setBusy(true)
      setError('')
    })
    void (async () => {
      const options = { signal: lifetime.signal, isCurrent: current }
      const settings = await readNativeOfficeSettings({ serverId, workspacePath }, options)
      if (!current()) return
      setSettings(settings)
      if (!settings.effectiveEnabled || !settings.connectionEnabled || settings.restartRequired)
        return
      const scope = await requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        { serverId, workspacePath, method: 'integrations/scope/read', params: {} },
        { signal: lifetime.signal }
      )
      if (!current()) return
      if (!isIntegrationScope(scope)) throw new Error('INTEGRATION_SCOPE_UNAVAILABLE')
      transport = nativeOfficeTransport({ serverId, workspacePath }, scope, current)
      setClient({ value: new ExpertClient(new OfficeController(transport, () => scope), { serverId, workspacePath }), signal: lifetime.signal })
    })()
      .catch(() => {
        if (current()) setError(t('unavailable'))
      })
      .finally(() => {
        if (current()) setBusy(false)
      })
    return () => {
      lifetime.abort()
      transport?.dispose()
      owner.current = null
    }
  }, [serverId, workspacePath, isCurrent, t])
  const prepare = async () => {
    const lifetime = owner.current
    if (!lifetime || !settings || busy || uncertain) return
    const options = { signal: lifetime.signal, isCurrent }
    setBusy(true)
    setError('')
    try {
      let next = settings
      if (!next.effectiveEnabled) {
        try {
          next = await saveNativeOfficeSettings(
            { serverId, workspacePath },
            true,
            next.revision,
            options
          )
        } catch (error) {
          if (!lifetime.signal.aborted && isCurrent()) setUncertain(true)
          throw error
        }
      }
      if (!next.effectiveEnabled) throw new Error('OFFICE_SETTINGS_OVERRIDDEN')
      if (
        next.restartRequired &&
        (await applyNativeOfficeSettings({ serverId, workspacePath }, options)) === 'busy'
      ) {
        if (!lifetime.signal.aborted && isCurrent()) setError(t('busy'))
        return
      }
      if (!lifetime.signal.aborted && isCurrent()) onReconnect()
    } catch {
      if (!lifetime.signal.aborted && isCurrent()) setError(t('unavailable'))
    } finally {
      if (!lifetime.signal.aborted && isCurrent()) setBusy(false)
    }
  }
  if (client && !client.signal.aborted && isCurrent()) return children(client.value)
  const connecting = busy || Boolean(client?.signal.aborted)
  if (connecting && !error && loadingFallback !== undefined) return loadingFallback
  const fallback = (
    <div className="mx-auto max-w-5xl space-y-3 p-5">
      <p role={error ? 'alert' : 'status'}>{error || t(connecting ? 'loading' : 'setup')}</p>
      <div className="flex gap-2">
        {settings && !uncertain && (
          <Button disabled={busy} onClick={() => void prepare()}>
            {t('enable')}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onReconnect}>
          {t('refresh')}
        </Button>
      </div>
    </div>
  )
  return renderFallback ? renderFallback(fallback) : fallback
}
