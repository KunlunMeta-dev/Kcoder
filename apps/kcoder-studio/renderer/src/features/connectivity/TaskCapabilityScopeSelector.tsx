import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, FolderSearch, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { IntegrationTaskCapabilityScopeSnapshot } from '../../../../shared/generated/contracts'

/** A display projection; the controller retains the typed native lookup target. */
export interface SavedTaskCapabilityScopeRow<T> {
  referenceId: string
  target: T | null
  savedSnapshot: IntegrationTaskCapabilityScopeSnapshot | null
  observationState: 'saved_only' | 'unknown'
  reasonCode: string | null
  title?: string
  detail?: string
}
export interface SavedTaskCapabilityScopePage<T> {
  entries: SavedTaskCapabilityScopeRow<T>[]
  nextCursor: string | null
  observationState: 'saved_only' | 'unknown'
  reasonCode: string | null
}
interface Props<T> {
  ownerKey: string
  loadPage: (cursor: string | null) => Promise<SavedTaskCapabilityScopePage<T>>
  onChoose: (target: T) => Promise<void>
}

export function TaskCapabilityScopeSelector<T>(props: Props<T>) {
  return <OwnedTaskCapabilityScopeSelector key={props.ownerKey} {...props} />
}
function OwnedTaskCapabilityScopeSelector<T>({ loadPage, onChoose }: Props<T>) {
  const { t } = useTranslation('taskCapabilityScope')
  const lifetime = useRef({ active: true, generation: 0 })
  const [initialLoader] = useState(() => loadPage)
  const [page, setPage] = useState<SavedTaskCapabilityScopePage<T> | null>(null)
  const [busy, setBusy] = useState(true), [chosen, setChosen] = useState<string | null>(null), [notice, setNotice] = useState<'load' | 'choose' | null>(null)
  const fetchPage = useCallback(async (cursor: string | null, generation: number, loader: Props<T>['loadPage']) => {
    const owner = lifetime.current
    try {
      const next = await loader(cursor)
      if (!owner.active || generation !== owner.generation) return
      setPage(old => {
        const previous = cursor ? old?.entries ?? [] : []
        const rows = new Map(previous.map(row => [row.referenceId, row]))
        for (const row of next.entries) rows.set(row.referenceId, row)
        return { ...next, entries: [...rows.values()] }
      })
    } catch {
      if (owner.active && generation === owner.generation) setNotice('load')
    } finally {
      if (owner.active && generation === owner.generation) setBusy(false)
    }
  }, [])
  useEffect(() => {
    const owner = lifetime.current
    owner.active = true
    void fetchPage(null, ++owner.generation, initialLoader)
    return () => { owner.active = false; owner.generation++ }
  }, [fetchPage, initialLoader])
  const read = (cursor: string | null) => {
    if (busy || chosen !== null) return
    setBusy(true); setNotice(null)
    void fetchPage(cursor, ++lifetime.current.generation, loadPage)
  }
  const choose = async (row: SavedTaskCapabilityScopeRow<T>) => {
    if (row.target === null || busy || chosen !== null) return
    const owner = lifetime.current, generation = owner.generation
    setChosen(row.referenceId); setNotice(null)
    try { await onChoose(row.target) }
    catch { if (owner.active && generation === owner.generation) setNotice('choose') }
    finally { if (owner.active && generation === owner.generation) setChosen(null) }
  }
  return <section className="studio-card-spacing grid gap-4 rounded-xl border border-border bg-surface" aria-label={t('title')} aria-busy={busy || chosen !== null}>
    <header className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary"><FolderSearch className="h-5 w-5" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1"><h3 className="text-base font-medium text-text-primary">{t('title')}</h3><p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p></div>
      <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 shrink-0" aria-label={t('refresh')} disabled={busy || chosen !== null} onClick={() => void read(null)}><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
    </header>
    {busy && !page && <p role="status" className="flex items-center gap-2 py-4 text-sm text-text-secondary"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('loading')}</p>}
    {page && <ul className="divide-y divide-border" aria-label={t('list')}>
      {page.entries.map(row => {
        const snapshot = row.savedSnapshot, opening = chosen === row.referenceId
        const summary = snapshot === null ? t('unreadable') : snapshot.selection.mode === 'none' ? t('none') : t('count', { count: snapshot.effectiveSources.length })
        return <li key={row.referenceId} className="py-1 first:pt-0 last:pb-0">
          <Button type="button" variant="ghost" className="h-auto min-h-11 w-full justify-start gap-3 whitespace-normal px-3 py-3 text-left" disabled={row.target === null || busy || chosen !== null} onClick={() => void choose(row)}>
            <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{row.title || t('record', { id: row.referenceId.slice(-8) })}</span><span className="rounded-full border border-border px-2 py-0.5 text-xs font-normal text-text-muted">{row.observationState === 'unknown' ? t('unknown') : t('saved')}</span></span><span className="mt-1 block text-sm font-normal text-text-secondary">{summary}</span>{row.detail && <span className="mt-1 block break-words text-xs font-normal text-text-muted">{row.detail}</span>}{snapshot?.effectiveFrom === 'next_tool_boundary' && <span className="mt-1 block text-xs font-normal text-text-muted">{t('pending')}</span>}</span>
            {opening ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />}
          </Button>
        </li>
      })}
    </ul>}
    {page?.entries.length === 0 && <p className="py-3 text-sm text-text-secondary">{page.observationState === 'unknown' ? t('unknownDirectory') : page.nextCursor ? t('moreToRead') : t('empty')}</p>}
    {notice && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-sm text-text-secondary"><span>{t(notice === 'load' ? 'loadFailed' : 'chooseFailed')}</span><Button type="button" variant="ghost" disabled={busy || chosen !== null} onClick={() => void read(null)}>{t('retry')}</Button></div>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"><p className="min-w-0 flex-1 text-xs text-text-muted">{t('authorityHint')}</p>{page?.nextCursor && <Button type="button" variant="outline" className="min-h-11" disabled={busy || chosen !== null} onClick={() => void read(page.nextCursor)}>{busy ? t('loading') : t('more')}</Button>}</footer>
  </section>
}
