import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isIntegrationScope } from '../../../../shared/generated/contractGuards.mjs'
import { ResourceController } from '@/features/integration-resources/controller'
import { resourceTransport } from '@/features/runtime-governance/resourceTransport'
import { ExpertClient } from './client'

export function ExpertTarget({
  serverId,
  workspacePath,
  targetScope,
  isCurrent,
  onReconnect,
  renderFallback,
  loadingFallback,
  children,
}: {
  serverId: string
  workspacePath?: string
  targetScope?: string
  isCurrent: () => boolean
  onReconnect: () => void
  renderFallback?: (content: ReactNode) => ReactNode
  loadingFallback?: ReactNode
  children: (client: ExpertClient) => ReactNode
}) {
  const { t } = useTranslation('experts')
  const [client, setClient] = useState<{ value: ExpertClient; signal: AbortSignal }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    const lifetime = new AbortController()
    const target = { serverId, workspacePath, ...(targetScope === undefined ? {} : { targetScope }) }
    let transport: ReturnType<typeof resourceTransport> | undefined
    const current = () => !lifetime.signal.aborted && isCurrent()
    // Activity retains state but disposes effects. Never reuse that disposed transport.
    queueMicrotask(() => {
      if (!current()) return
      setClient(undefined)
      setBusy(true)
      setError('')
    })
    void (async () => {
      const scope = await requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        { ...target, method: 'agentDefinitions/scope/read', params: {} },
        { signal: lifetime.signal }
      )
      if (!current()) return
      if (!isIntegrationScope(scope)) throw new Error('INTEGRATION_SCOPE_UNAVAILABLE')
      transport = resourceTransport(target, scope, current)
      setClient({
        value: new ExpertClient(new ResourceController(transport, () => scope), target),
        signal: lifetime.signal,
      })
    })()
      .catch((reason: unknown) => {
        const code = typeof reason === 'object' && reason !== null && 'code' in reason
          ? reason.code
          : reason instanceof Error ? reason.message : undefined
        if (current()) setError(t(
          code === 'INTEGRATION_TARGET_UPGRADE_REQUIRED' ||
          code === 'INTEGRATION_METHOD_UNSUPPORTED' || code === -32601
            ? 'upgradeRequired' : 'unavailable'
        ))
      })
      .finally(() => {
        if (current()) setBusy(false)
      })
    return () => {
      lifetime.abort()
      transport?.dispose()
    }
  }, [serverId, workspacePath, targetScope, isCurrent, t])
  if (client && !client.signal.aborted && isCurrent()) return children(client.value)
  const connecting = busy || Boolean(client?.signal.aborted)
  if (connecting && !error && loadingFallback !== undefined) return loadingFallback
  const fallback = (
    <div className="mx-auto max-w-5xl space-y-3 p-5">
      <p role={error ? 'alert' : 'status'}>{error || t(connecting ? 'loading' : 'setup')}</p>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={busy} onClick={onReconnect}>
          {t('refresh')}
        </Button>
      </div>
    </div>
  )
  return renderFallback ? renderFallback(fallback) : fallback
}
