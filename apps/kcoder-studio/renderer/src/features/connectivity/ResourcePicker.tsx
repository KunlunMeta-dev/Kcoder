import { useMemo, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { ConnectivityClient, ConnectivityClientError } from './client'
import type { ConnectionView, ResourceItem } from './types'

interface ResourcePage { items: ResourceItem[]; nextCursor: string | null; resourceGrants: ResourceItem[] }
export function ResourcePicker({ client, connection, scopeRevision, onChanged, onClose }: { client: ConnectivityClient; connection: ConnectionView; scopeRevision: string; onChanged: () => void; onClose: () => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  const [page, setPage] = useState<ResourcePage | null>(null), [selected, setSelected] = useState<Record<string, ResourceItem>>(() => Object.fromEntries((connection.resourceGrants as ResourceItem[]).filter(item => item?.id && item.revision).map(item => [item.id, item])))
  const [cursor, setCursor] = useState(''), [previous, setPrevious] = useState<string[]>([]), [busy, setBusy] = useState(true), [error, setError] = useState('')
  const generation = useRef(0)
  const scope = useRef(client.scopeIdentity())
  const load = async (after = '') => {
    const current = ++generation.current; setBusy(true)
    try { const result = await client.call<ResourcePage>('P-CONNECTION', 'readResourceGrant', { connectionId: connection.id, discover: true, after, limit: 10 }, { expectedScopeKey: scope.current }); if (current === generation.current) setPage(result) }
    catch (cause) { if (current === generation.current) setError(cause instanceof ConnectivityClientError ? cause.code : 'RESOURCE_LIST_UNAVAILABLE') }
    finally { if (current === generation.current) setBusy(false) }
  }
  const resetOwner = useMemo(() => ({}), [client, connection.id, connection.revision, scopeRevision])
  const [previousOwner, setPreviousOwner] = useState(resetOwner)
  if (previousOwner !== resetOwner) { setPreviousOwner(resetOwner); setSelected(Object.fromEntries((connection.resourceGrants as ResourceItem[]).filter(item => item?.id && item.revision).map(item => [item.id, item]))); setPage(null); setPrevious([]); setCursor(''); setError(''); setBusy(true) }
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false; generation.current++ }
  }, [client, connection.id, connection.revision, scopeRevision])
  const save = async () => {
    const current = generation.current; setBusy(true)
    try { await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'setResources', connectionId: connection.id, resourceGrants: Object.values(selected).map(({ id, revision, kind }) => ({ id, revision, kind })) }, { expectedRevision: connection.revision, expectedScopeKey: scope.current }); if (current === generation.current) { onChanged(); onClose() } }
    catch (cause) { if (current === generation.current) setError(cause instanceof ConnectivityClientError ? cause.code : 'RESOURCE_SAVE_UNCONFIRMED') }
    finally { if (current === generation.current) setBusy(false) }
  }
  return <section className="studio-card-spacing grid gap-3 rounded-lg border border-border bg-surface" aria-label={zh ? '选择可访问资料' : 'Select accessible resources'}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-base font-medium">{zh ? '选择可访问资料' : 'Select accessible resources'}</h3><Button type="button" variant="ghost" onClick={onClose}>{zh ? '关闭' : 'Close'}</Button></div>
    <p className="text-sm text-text-secondary">{zh ? '这里只列出当前来源允许读取的资料。保存选择后，任务仍会检查实际访问权限。' : 'Only resources available from this source appear here. Tasks recheck actual access when running.'}</p>
    {error && <details className="text-sm text-text-secondary"><summary>{zh ? '暂时无法完成，请检查连接后重试。' : 'Unavailable. Inspect the connection and retry.'}</summary><code>{error}</code></details>}
    <div className="grid gap-2">{page?.items.map(item => <label key={item.id} className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm"><input type="checkbox" checked={Boolean(selected[item.id])} onChange={event => setSelected(old => { const next = { ...old }; if (event.target.checked) next[item.id] = item; else delete next[item.id]; return next })} /><span className="truncate">{item.label}</span></label>)}{page && !page.items.length && <p className="text-sm text-text-muted">{zh ? '没有发现可供选择的资料。' : 'No resources were discovered.'}</p>}</div>
    <div className="flex flex-wrap justify-between gap-2"><Button type="button" disabled={busy} onClick={() => void save()}>{zh ? '保存选择' : 'Save selection'}</Button><div className="flex gap-2"><Button variant="outline" type="button" disabled={busy || !previous.length} onClick={() => { const pages = [...previous], after = pages.pop() ?? ''; setPrevious(pages); setCursor(after); void load(after) }}>{zh ? '上一页' : 'Previous'}</Button><Button variant="outline" type="button" disabled={busy || !page?.nextCursor} onClick={() => { if (page?.nextCursor) { setPrevious(old => [...old, cursor]); setCursor(page.nextCursor); void load(page.nextCursor) } }}>{zh ? '下一页' : 'Next'}</Button></div></div>
  </section>
}
