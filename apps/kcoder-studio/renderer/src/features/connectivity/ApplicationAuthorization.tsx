import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { createRandomUuid } from '@/lib/random-id'
import { ConnectivityClient, ConnectivityClientError } from './client'
import type { ConnectionView } from './types'
import type { ApplicationAuthorizationOwner } from './nativeApplicationAuthorization'

interface Authorization { authorizationId: string; authorizationUrl: string; state: 'waiting'; expiresAt: string }
export function ApplicationAuthorization({ client, connection, onChanged, onClose, createNativeAuthorization }: { client: ConnectivityClient; connection: ConnectionView; onChanged: () => void; onClose: () => void; createNativeAuthorization?: (connection: ConnectionView) => ApplicationAuthorizationOwner }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [cancelled, setCancelled] = useState(false)
  const [authorization, setAuthorization] = useState<Authorization | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [nativeFactory] = useState(() => createNativeAuthorization)
  const nativeOwner = useRef<ApplicationAuthorizationOwner | null>(null)
  const operationId = useRef(createRandomUuid()), scope = useRef(client.scopeIdentity()), active = useRef(true), started = useRef(false), cancelRequested = useRef(false)
  const cancel = async () => {
    cancelRequested.current = true; setCancelled(true)
    if (!started.current) { onClose(); return }
    setBusy(true)
    try { if (nativeFactory) await nativeOwner.current?.cancel(); else await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'cancelAuthorization', connectionId: connection.id, authorizationOperationId: operationId.current }, { expectedRevision: connection.revision, expectedScopeKey: scope.current }); if (active.current) onClose() }
    catch (cause) { if (active.current) setError(cause instanceof ConnectivityClientError ? cause.code : 'AUTHORIZATION_CANCELLATION_UNCONFIRMED') }
    finally { if (active.current) setBusy(false) }
  }
  const begin = async () => {
    started.current = true; setBusy(true); setError('')
    try {
      const result = nativeFactory ? await (nativeOwner.current ??= nativeFactory(connection)).begin() : await client.call<Authorization>('P-CONNECTION', 'prepareConnectionAction', { action: 'authorize', connectionId: connection.id }, { operationId: operationId.current, expectedRevision: connection.revision, expectedScopeKey: scope.current })
      if (active.current && !cancelRequested.current) setAuthorization(result)
    } catch (cause) { if (active.current && !cancelRequested.current) setError(cause instanceof ConnectivityClientError ? cause.code : 'AUTHORIZATION_UNCONFIRMED') }
    finally { if (active.current) setBusy(false) }
  }
  useEffect(() => {
    active.current = true
    return () => {
    active.current = false
    if (started.current && !cancelRequested.current) { if (nativeFactory) void nativeOwner.current?.cancel().catch(() => {}); else void client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'cancelAuthorization', connectionId: connection.id, authorizationOperationId: operationId.current }, { expectedRevision: connection.revision, expectedScopeKey: scope.current }).catch(() => {}) }
    }
  }, [client, connection.id, connection.revision, nativeFactory])
  return <section className="studio-card-spacing grid gap-3 rounded-lg border border-border bg-surface" aria-label={zh ? '应用授权' : 'Application authorization'}>
    <h3 className="text-base font-medium">{zh ? '应用授权' : 'Application authorization'} · {connection.label}</h3>
    <p className="text-sm text-text-secondary">{zh ? '授权会在所选来源的浏览器页面完成。完成后刷新，检查当前目标的授权状态。' : 'Complete authorization in the source browser page, then refresh to inspect the selected target.'}</p>
    {error && <details className="text-sm text-text-secondary"><summary>{zh ? '授权暂未确认，可核对后重试。' : 'Authorization is unconfirmed. Reconcile before retrying.'}</summary><code>{error}</code></details>}
    <div className="flex flex-wrap gap-2">
      {!authorization && <Button type="button" disabled={busy || cancelled} onClick={() => void begin()}>{zh ? '开始浏览器授权' : 'Start browser authorization'}</Button>}
      {authorization && <Button asChild><a href={authorization.authorizationUrl} target="_blank" rel="noopener noreferrer">{zh ? '在浏览器授权' : 'Authorize in browser'}</a></Button>}
      <Button variant="outline" type="button" disabled={busy} onClick={() => { onChanged(); onClose() }}>{zh ? '我已完成，刷新状态' : 'Refresh authorization status'}</Button>
      <Button variant="outline" type="button" onClick={() => void cancel()}>{zh ? '取消授权' : 'Cancel authorization'}</Button>
    </div>
  </section>
}
