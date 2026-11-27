import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ListChecks, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import {
  knowledgeApi,
  type WikiJob,
  type WikiPendingUnit,
  type WikiSource,
} from '@/kcoder/knowledgeApi'
import { WikiError } from './WikiError'
import { wikiPendingReasonKey, wikiRequestKey } from './wikiVerification'

/** The host organizes at most this many units of one source revision per request. */
export const WIKI_PENDING_ORGANIZE_LIMIT = 64

interface WikiPendingUnitsProps {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  sources: WikiSource[]
  canOrganize: boolean
  refreshSignal: number
  /** Reports whether the target persists pending units at all. */
  onSupportChange?: (supported: boolean) => void
  onJobStarted?: (job: WikiJob) => void
  onShowJob?: (jobId: string) => void
}

const selectionKey = (ids: Iterable<string>) => JSON.stringify([...ids].sort())

/**
 * Required source units no published page organizes yet. They are organized
 * only after an explicit user action; the host never does it automatically.
 */
export function WikiPendingUnits({
  serverId,
  libraryId,
  isCurrent,
  sources,
  canOrganize,
  refreshSignal,
  onSupportChange,
  onJobStarted,
  onShowJob,
}: WikiPendingUnitsProps) {
  const { t, i18n } = useTranslation('knowledge')
  const [supported, setSupported] = useState(false)
  const [items, setItems] = useState<WikiPendingUnit[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [includeClosed, setIncludeClosed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [organizing, setOrganizing] = useState(false)
  const [started, setStarted] = useState<WikiJob | null>(null)
  const [error, setError] = useState('')
  // An explicit retry of the identical selection reuses the same request key.
  const request = useRef<{ selection: string; key: string } | null>(null)
  const generation = useRef(0)
  // Callers may pass inline callbacks; a ref keeps them out of the load identity.
  const supportChanged = useRef(onSupportChange)
  useEffect(() => {
    supportChanged.current = onSupportChange
  }, [onSupportChange])
  const live = useCallback(
    (attempt: number) => isCurrent() && attempt === generation.current,
    [isCurrent]
  )
  const load = useCallback(
    async (afterId?: string) => {
      const attempt = afterId ? generation.current : ++generation.current
      setLoading(true)
      try {
        const result = await knowledgeApi.pendingUnits(serverId, libraryId, {
          includeClosed,
          afterId,
        })
        if (!live(attempt)) return
        const available = result.supported !== false
        setSupported(available)
        supportChanged.current?.(available)
        const page = available ? result.items : []
        setItems(previous => (afterId ? [...previous, ...page] : page))
        setCursor(available ? (result.nextAfterId ?? null) : null)
        if (!afterId)
          setSelected(previous => {
            const open = new Set(
              page.filter(item => item.status === 'open').map(item => item.pendingId)
            )
            const kept = [...previous].filter(id => open.has(id))
            return kept.length === previous.size ? previous : new Set(kept)
          })
      } catch (cause) {
        if (live(attempt)) setError(String(cause instanceof Error ? cause.message : cause))
      } finally {
        if (live(attempt)) setLoading(false)
      }
    },
    [serverId, libraryId, includeClosed, live]
  )
  useEffect(() => {
    let active = true
    const lifetime = generation
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
      ++lifetime.current
    }
  }, [load, refreshSignal])

  // Pending ranges are absolute source lines; 0 means the host had no line map.
  const lines = (unit: WikiPendingUnit) =>
    unit.firstLine > 0
      ? t('sourceLines', { start: unit.firstLine, end: Math.max(unit.firstLine, unit.lastLine) })
      : t('pendingUnits.linesUnknown')
  const sourceFor = (unit: WikiPendingUnit) =>
    sources.find(source => source.sourceId === unit.sourceId)
  // A unit of an older source revision cannot be organized against the current one.
  const stale = (unit: WikiPendingUnit) => {
    const source = sourceFor(unit)
    return Boolean(source && (source.removed || source.revisionId !== unit.sourceRevision))
  }
  const anchor = items.find(item => selected.has(item.pendingId))
  const selectable = (unit: WikiPendingUnit) =>
    canOrganize &&
    unit.status === 'open' &&
    !stale(unit) &&
    (!anchor ||
      (anchor.sourceId === unit.sourceId && anchor.sourceRevision === unit.sourceRevision)) &&
    (selected.has(unit.pendingId) || selected.size < WIKI_PENDING_ORGANIZE_LIMIT)
  const toggle = (unit: WikiPendingUnit) =>
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(unit.pendingId)) next.delete(unit.pendingId)
      else next.add(unit.pendingId)
      return next
    })

  const organize = async () => {
    const pendingIds = [...selected]
    if (!pendingIds.length) return
    const selection = selectionKey(pendingIds)
    if (request.current?.selection !== selection)
      request.current = { selection, key: wikiRequestKey('pending') }
    const key = request.current.key
    const attempt = generation.current
    setOrganizing(true)
    setError('')
    setStarted(null)
    try {
      const job = await knowledgeApi.organizePending(
        serverId,
        libraryId,
        pendingIds,
        key,
        i18n.language
      )
      request.current = null
      if (!isCurrent()) return
      setStarted(job)
      setSelected(new Set())
      onJobStarted?.(job)
      if (live(attempt)) void load()
    } catch (cause) {
      // No automatic retry: an unknown outcome keeps the key for an explicit retry.
      if (isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (isCurrent()) setOrganizing(false)
    }
  }

  if (!supported || (!items.length && !includeClosed && !started)) return null
  const active = items.filter(item => item.status === 'open' || item.status === 'organizing')
  return (
    <details
      open
      className="group/pending rounded-xl border border-border/50 bg-surface/30 text-xs text-text-secondary"
      data-testid="wiki-pending-units"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 font-medium text-text-primary">
          {t('pendingUnits.title', { count: active.length })}
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-text-muted transition-transform group-open/pending:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-text-muted">{t('pendingUnits.hint')}</p>
        {error && <WikiError error={error} />}
        {started && (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2"
            data-testid="wiki-pending-started"
          >
            {t('pendingUnits.started')}
            {onShowJob && (
              <Button
                size="sm"
                variant="ghost"
                className="max-md:min-h-11"
                data-testid="wiki-pending-show-job"
                onClick={() => onShowJob(started.id)}
              >
                {t('pendingUnits.showJob')}
              </Button>
            )}
          </p>
        )}
        <ul className="max-h-64 divide-y divide-border/40 overflow-y-auto">
          {items.map(unit => {
            const source = sourceFor(unit)
            const id = `wiki-pending-${unit.pendingId}`
            return (
              <li
                key={unit.pendingId}
                className="flex min-w-0 items-start gap-3 py-2"
                data-testid={id}
                data-state={unit.status}
              >
                <Checkbox
                  id={`${id}-select`}
                  className="mt-0.5"
                  aria-label={t('pendingUnits.select', {
                    title: source?.title ?? unit.sourceId,
                    lines: lines(unit),
                  })}
                  data-testid={`${id}-select`}
                  checked={selected.has(unit.pendingId)}
                  disabled={organizing || !selectable(unit)}
                  onChange={() => toggle(unit)}
                />
                <label htmlFor={`${id}-select`} className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-text-primary" title={source?.title}>
                    {source?.title ?? unit.sourceId}
                    <span className="text-text-muted"> · {lines(unit)}</span>
                  </span>
                  <span className="block text-text-muted">
                    {t(wikiPendingReasonKey(unit.reasonCode))}
                  </span>
                  {stale(unit) && unit.status === 'open' && (
                    <span className="block text-text-muted">{t('pendingUnits.sourceChanged')}</span>
                  )}
                </label>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-text-muted">{t(`pendingUnits.status.${unit.status}`)}</span>
                  {unit.organizeJobId && onShowJob && unit.status === 'organizing' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="max-md:min-h-11"
                      data-testid={`${id}-job`}
                      onClick={() => onShowJob(unit.organizeJobId!)}
                    >
                      {t('pendingUnits.showJob')}
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="max-md:min-h-11"
            disabled={!canOrganize || organizing || !selected.size}
            data-testid="wiki-pending-organize"
            onClick={() => void organize()}
          >
            {organizing ? <LoaderCircle className="animate-spin" /> : <ListChecks />}
            {t('pendingUnits.organize', { count: selected.size })}
          </Button>
          {cursor && (
            <Button
              size="sm"
              variant="ghost"
              className="max-md:min-h-11"
              disabled={loading}
              data-testid="wiki-pending-more"
              onClick={() => void load(cursor)}
            >
              {t('more')}
            </Button>
          )}
          <label className="ml-auto flex min-h-11 items-center gap-2 text-text-muted">
            <Checkbox
              checked={includeClosed}
              data-testid="wiki-pending-include-closed"
              onChange={event => setIncludeClosed(event.target.checked)}
            />
            {t('pendingUnits.includeClosed')}
          </label>
        </div>
        {selected.size > 0 && <p className="text-text-muted">{t('pendingUnits.sameSourceHint')}</p>}
      </div>
    </details>
  )
}
