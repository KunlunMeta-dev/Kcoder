import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { ConnectivityClientError, type ConnectivityClient } from './client'
import type { ConnectionView } from './types'
import type { ApplicationAuthorizationOwner } from './nativeApplicationAuthorization'
import type { ProviderRevocationLocator } from './nativeProviderRevocation'
import type { ConnectivityLocalAuthorizationCleanupReceipt, McpProviderRevocationReceipt } from '../../../../shared/generated/contracts'

type Props = { client: ConnectivityClient; connection: ConnectionView; createNativeAuthorization?: (connection: ConnectionView) => ApplicationAuthorizationOwner }
/** A replacement client/connection cannot inherit the previous view's mutation owner. */
export function ApplicationAuthorizationLifecycle(props: Props) {
  const [owner, setOwner] = useState({ client: props.client, id: props.connection.id, revision: props.connection.revision, generation: 0 })
  if (owner.client !== props.client || owner.id !== props.connection.id || owner.revision !== props.connection.revision) {
    setOwner({ client: props.client, id: props.connection.id, revision: props.connection.revision, generation: owner.generation + 1 }); return null
  }
  return <OwnedAuthorizationLifecycle key={owner.generation} {...props} />
}
function OwnedAuthorizationLifecycle({ connection, createNativeAuthorization }: Props) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [initial] = useState(() => {
    try {
      const owner = createNativeAuthorization?.(connection)
      return { provider: owner?.providerRevocation, local: owner?.localCleanup, providerPending: owner?.providerRevocation?.pending(), localPending: owner?.localCleanup?.pending(), blocked: false }
    } catch { return { provider: undefined, local: undefined, providerPending: undefined, localPending: undefined, blocked: true } }
  })
  const [providerReceipt, setProviderReceipt] = useState<McpProviderRevocationReceipt>(), [localReceipt, setLocalReceipt] = useState<ConnectivityLocalAuthorizationCleanupReceipt | null>()
  const [providerPending, setProviderPending] = useState<ProviderRevocationLocator | undefined>(initial.providerPending), [localPending, setLocalPending] = useState(initial.localPending)
  const [busy, setBusy] = useState(!!(initial.providerPending || initial.localPending)), [unconfirmed, setUnconfirmed] = useState(initial.blocked), [confirmProvider, setConfirmProvider] = useState(false), [confirmLocal, setConfirmLocal] = useState(false), [archived, setArchived] = useState(false), [unsupportedTarget, setUnsupportedTarget] = useState(false)
  const alive = useRef(true), generation = useRef(0)
  const rememberPending = () => { setProviderPending(initial.provider?.pending()); setLocalPending(initial.local?.pending()) }
  const invoke = async (action: 'prepare' | 'commit' | 'readProvider' | 'cancel' | 'clearLocal' | 'readLocal' | 'archive') => {
    if (busy || initial.blocked) return
    const own = ++generation.current; setBusy(true); setUnconfirmed(false)
    try {
      if (action === 'clearLocal') { const receipt = await initial.local!.clear(); if (alive.current && own === generation.current) setLocalReceipt(receipt) }
      else if (action === 'readLocal') { const receipt = await initial.local!.read(); if (alive.current && own === generation.current) { setLocalReceipt(receipt); if (!receipt) setUnconfirmed(true) } }
      else if (action === 'archive') { await initial.provider!.archiveChangedSource(); if (alive.current && own === generation.current) { setArchived(true); setProviderReceipt(undefined) } }
      else {
        const receipt = await (action === 'readProvider' ? initial.provider!.read() : initial.provider![action]())
        if (alive.current && own === generation.current) setProviderReceipt(receipt)
      }
    } catch (failure) { if (alive.current && own === generation.current) { if (failure instanceof ConnectivityClientError && failure.code === 'APPLICATION_PROVIDER_REVOCATION_UNSUPPORTED_TARGET') setUnsupportedTarget(true); else setUnconfirmed(true) } }
    finally { if (alive.current && own === generation.current) { try { rememberPending() } catch { setUnconfirmed(true) } setBusy(false); setConfirmProvider(false); setConfirmLocal(false) } }
  }
  const restore = useEffectEvent((own: number) => {
    const reads = [initial.providerPending ? initial.provider!.read() : Promise.resolve(undefined), initial.localPending ? initial.local!.read() : Promise.resolve(undefined)] as const
    void Promise.allSettled(reads).then(results => {
      if (!alive.current || own !== generation.current) return
      if (results[0].status === 'fulfilled') setProviderReceipt(results[0].value)
      if (results[1].status === 'fulfilled') { setLocalReceipt(results[1].value); if (initial.localPending && !results[1].value) setUnconfirmed(true) }
      if (results.some(result => result.status === 'rejected')) setUnconfirmed(true)
      try { rememberPending() } catch { setUnconfirmed(true) }
      setBusy(false)
    })
  })
  const retire = useEffectEvent(() => { alive.current = false; generation.current++ })
  useEffect(() => { alive.current = true; const own = ++generation.current; if (initial.providerPending || initial.localPending) restore(own); return () => retire() }, [initial])
  const canConfirmProvider = providerReceipt?.phase === 'prepared' && providerReceipt.currentSourceMatches && providerPending?.stage === 'prepare' && providerPending.currentConnectionMatches
  const providerText = providerReceipt && ({
    prepared: zh ? '原撤销请求已准备，尚未向提供方发送。' : 'The original request is prepared. Nothing has been sent to the provider.',
    accepted: zh ? '提供方已接受原令牌的撤销请求。本地凭据未据此清除。' : 'The provider accepted revocation of the original token. Local credentials were not cleared.',
    unknown: zh ? '提供方结果未确认。保留原请求，只读取原回执，不重新发送。' : 'The provider outcome is unconfirmed. Keep the original request and read its receipt without resending.',
    unsupported: zh ? '原授权未提供可用的撤销方式，或提供方明确不支持该令牌类型。本地凭据保留。' : 'No supported revocation method was advertised, or the provider explicitly rejected this token type. Local credentials were retained.',
    rejected: zh ? '原请求被拒绝或准备已取消，未确认提供方撤销成功。' : 'The original request was rejected or its preparation was cancelled. Provider revocation was not confirmed.',
  })[providerReceipt.phase]
  return <section className="studio-card-spacing grid gap-3 rounded-lg border border-border" aria-label={zh ? '授权清理与回执' : 'Authorization cleanup and receipts'}>
    <h3 className="text-base font-medium">{zh ? '授权清理与回执' : 'Authorization cleanup and receipts'}</h3>
    <p className="text-sm text-text-secondary">{zh ? '本地清除与提供方撤销是两个独立操作。停用或网络断开不会自动撤销提供方凭据。' : 'Local clearing and provider revocation are separate operations. Disabling a connection or losing its network does not revoke provider credentials.'}</p>
    {!initial.blocked && !initial.local && !initial.provider && <p className="text-sm text-text-secondary">{zh ? '当前目标未提供这些原生操作；不能据此认为授权已撤销。' : 'This target does not provide these Native operations; authorization is not thereby revoked.'}</p>}
    {initial.local && <div className="grid gap-2">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={confirmLocal} disabled={busy || !!localPending || initial.blocked} onChange={event => setConfirmLocal(event.target.checked)} />{zh ? '仅清除当前来源在此目标的本地授权并停用，不请求提供方撤销' : 'Clear this source’s local authorization on this target and disable it, without requesting provider revocation'}</label>
      <Button type="button" variant="outline" disabled={busy || !confirmLocal || !!localPending || initial.blocked} onClick={() => void invoke('clearLocal')}>{zh ? '清除本地授权并停用' : 'Clear local authorization and disable'}</Button>
      {localPending && <Button type="button" variant="outline" disabled={busy} onClick={() => void invoke('readLocal')}>{zh ? '读取原本地清除回执' : 'Read original local cleanup receipt'}</Button>}
      {localReceipt && <p role="status" className="text-sm text-text-secondary">{localReceipt.localRemoval === 'accepted' ? zh ? '原生端已确认清除本地授权；未请求提供方撤销。' : 'Native confirmed local authorization clearing. Provider revocation was not requested.' : zh ? '本地清除结果未确认，请核对原操作。' : 'Local clearing is unconfirmed; reconcile the original operation.'}{localReceipt.availability === 'unknown' && (zh ? '停用状态尚未确认。' : ' Disablement is not yet confirmed.')}</p>}
    </div>}
    {initial.provider && <div className="grid gap-2 border-t border-border pt-3">
      {!providerPending && providerReceipt?.phase !== 'accepted' && <Button type="button" variant="outline" disabled={busy || initial.blocked || unsupportedTarget} onClick={() => void invoke('prepare')}>{zh ? '准备提供方撤销' : 'Prepare provider revocation'}</Button>}
      {canConfirmProvider && <><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={confirmProvider} disabled={busy} onChange={event => setConfirmProvider(event.target.checked)} />{zh ? '向原授权已发现的提供方端点提交撤销，关联令牌也可能失效' : 'Submit revocation to the provider endpoint discovered for the original authorization; related tokens may also be invalidated'}</label><Button type="button" disabled={busy || !confirmProvider} onClick={() => void invoke('commit')}>{zh ? '确认提供方撤销' : 'Confirm provider revocation'}</Button></>}
      {providerPending && <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => void invoke('readProvider')}>{zh ? '读取原提供方回执' : 'Read original provider receipt'}</Button>{providerReceipt?.phase === 'prepared' && providerPending.stage === 'prepare' && <Button type="button" variant="ghost" disabled={busy} onClick={() => void invoke('cancel')}>{zh ? '取消本次准备' : 'Cancel this preparation'}</Button>}</div>}
      {providerText && <p role="status" className="text-sm text-text-secondary">{providerText}</p>}
      {(providerReceipt?.sourceState === 'changed' || providerPending && !providerPending.currentConnectionMatches) && <div className="grid gap-2"><p className="text-sm text-text-secondary">{zh ? '当前连接或授权已改变。原回执不会成为新来源的权限。' : 'The current connection or authorization changed. The original receipt does not authorize the new source.'}</p><Button type="button" variant="outline" disabled={busy} onClick={() => void invoke('archive')}>{zh ? '保留旧回执并切换到当前来源' : 'Keep the old receipt and switch to the current source'}</Button></div>}
    </div>}
    {unsupportedTarget && <p role="status" className="text-sm text-text-secondary">{zh ? '当前目标未提供原生提供方撤销接口，尚未向提供方发送请求。' : 'This target does not provide Native provider revocation. No provider request was dispatched.'}</p>}
    {archived && <p role="status" className="text-sm text-text-secondary">{zh ? '原请求定位信息已保留为历史，未重发、取消或改写其提供方结果。' : 'The original request locator was retained as history. Its provider outcome was not replayed, cancelled or rewritten.'}</p>}
    {(providerPending || localPending || providerReceipt || localReceipt) && <details className="text-sm text-text-muted"><summary>{zh ? '原操作定位与诊断' : 'Original operation and diagnostics'}</summary>{providerPending && <p className="break-all">{providerPending.requestId} · {providerPending.server.name} · {providerPending.connectionRef.id}@{providerPending.connectionRef.revision}</p>}{localPending && <p className="break-all">{localPending.operationId} · {localPending.connectionRef.id}@{localPending.connectionRef.revision}</p>}{providerReceipt && <p>{providerReceipt.requestId} · {providerReceipt.reason} · {providerReceipt.sourceState}</p>}{localReceipt && <p>{localReceipt.operationId} · {localReceipt.localRemoval} · {localReceipt.availability}</p>}</details>}
    {unconfirmed && <p role="alert" className="text-sm text-destructive">{zh ? '原操作未确认。请读取原回执，不要重复执行或新建请求。' : 'The original operation is unconfirmed. Read its receipt without repeating it or creating a new request.'}</p>}
  </section>
}
