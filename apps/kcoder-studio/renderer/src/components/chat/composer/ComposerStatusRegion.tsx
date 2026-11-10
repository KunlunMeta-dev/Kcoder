import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export interface ComposerStatusItemProps {
  id: string
  title: string
  statusText?: string
  summary?: string
  count?: number
  icon?: LucideIcon
  attention?: boolean
  order?: number
  children: ReactNode
}

interface ItemMetadata {
  id: string
  title: string
  panelId: string
  statusText?: string
  summary?: string
  count?: number
  icon?: LucideIcon
  attention?: boolean
  order?: number
}

interface RegisteredItem {
  metadata: ItemMetadata
  token: symbol
  ownerScope: string
  sequence: number
}

interface ScopedValue<T> {
  ownerScope: string
  value: T
}

interface ComposerStatusContextValue {
  ownerScope: string
  entries: ReadonlyMap<string, RegisteredItem>
  primaryId: string | null
  expandedId: string | null
  compact: boolean
  noticeTarget: HTMLDivElement | null
  detailsTarget: HTMLDivElement | null
  registerItem: (metadata: ItemMetadata, token: symbol) => void
  unregisterItem: (id: string, token: symbol) => void
  expandItem: (id: string) => void
  closeItem: (id: string, restoreFocus?: boolean) => void
  toggleCompact: () => void
  registerTrigger: (id: string, element: HTMLButtonElement | null) => void
}

const ComposerStatusContext = createContext<ComposerStatusContextValue | null>(null)
const noop = () => {}

function ownerScopeFor(ownerKey: string | number | undefined): string {
  return ownerKey === undefined ? 'default' : `${typeof ownerKey}:${String(ownerKey)}`
}

function sameMetadata(left: ItemMetadata, right: ItemMetadata): boolean {
  return left.id === right.id && left.title === right.title && left.panelId === right.panelId &&
    left.statusText === right.statusText &&
    left.summary === right.summary &&
    left.count === right.count && left.icon === right.icon && left.attention === right.attention &&
    left.order === right.order
}

function compareStatusItems(left: RegisteredItem, right: RegisteredItem): number {
  const leftOrder = left.metadata.order
  const rightOrder = right.metadata.order
  if (leftOrder === undefined && rightOrder !== undefined) return 1
  if (leftOrder !== undefined && rightOrder === undefined) return -1
  return (leftOrder ?? 0) - (rightOrder ?? 0) || left.sequence - right.sequence
}

interface ComposerStatusTriggerProps {
  item: RegisteredItem
  primary: boolean
  expanded: boolean
  visualOrder: number
  onOpen: (id: string) => void
  onClose: (id: string) => void
  registerTrigger: (id: string, element: HTMLButtonElement | null) => void
}

function ComposerStatusTrigger({
  item,
  primary,
  expanded,
  visualOrder,
  onOpen,
  onClose,
  registerTrigger,
}: ComposerStatusTriggerProps) {
  const { id, title, panelId, statusText, summary, count, icon, attention } = item.metadata
  return (
    <div
      className={primary
        ? 'flex min-w-0 flex-[1_1_12rem] items-center'
        : 'flex min-w-0 max-w-full shrink items-center'}
      style={{ order: visualOrder }}
      data-status-item={id}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        className={`${primary
          ? 'flex w-full min-h-8 min-w-0 items-center'
          : 'flex min-h-8 max-w-full min-w-0 items-center'} gap-1.5 rounded-md px-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 ${expanded ? 'bg-surface-hover text-text-primary' : ''}`}
        ref={element => registerTrigger(id, element)}
        onClick={() => expanded ? onClose(id) : onOpen(id)}
        title={summary ? `${title}: ${summary}` : (statusText ? `${title}: ${statusText}` : title)}
      >
        {icon ? createElement(icon, { 'aria-hidden': true, className: 'h-4 w-4 shrink-0' }) : null}
        <span className={primary ? 'max-w-[40%] shrink-0 truncate' : 'min-w-0 truncate'}>{title}</span>
        {statusText ? (
          <span className={`${primary ? 'min-w-0 flex-1' : 'max-w-32'} truncate text-xs text-text-secondary`} title={statusText}>
            {statusText}
          </span>
        ) : null}
        {primary && !statusText && summary ? (
          <span className={`max-w-[50%] truncate text-xs ${attention ? 'text-warning' : 'text-text-muted'}`}>
            {summary}
          </span>
        ) : null}
        {count !== undefined ? (
          <span className={`shrink-0 text-xs tabular-nums ${attention ? 'text-warning' : 'text-text-muted'}`}>
            {count}
          </span>
        ) : null}
        {attention && summary && (!primary || Boolean(statusText)) ? (
          <span className="max-w-32 truncate text-xs text-warning">{summary}</span>
        ) : null}
      </button>
    </div>
  )
}

export interface ComposerStatusRegionProps {
  children: ReactNode
  ownerKey?: string | number
}

/**
 * Owns one composer status row and one stable details host. Nested regions reuse
 * the nearest owner so independently composed panes never share status state.
 */
export function ComposerStatusRegion({ children, ownerKey }: ComposerStatusRegionProps) {
  const parent = useContext(ComposerStatusContext)
  if (parent) return <>{children}</>
  return <ComposerStatusRegionHost ownerKey={ownerKey}>{children}</ComposerStatusRegionHost>
}

/** Portals urgent notices before the status row while keeping call sites in place. */
export function ComposerStatusNotice({ children }: { children: ReactNode }) {
  const context = useContext(ComposerStatusContext)
  if (!context) return <>{children}</>
  return context.noticeTarget ? createPortal(children, context.noticeTarget) : null
}

function ComposerStatusRegionHost({
  children,
  ownerKey,
}: ComposerStatusRegionProps) {
  const { t } = useTranslation('chat')
  const regionId = useId()
  const ownerScope = ownerScopeFor(ownerKey)
  const [entries, setEntries] = useState<Map<string, RegisteredItem>>(() => new Map())
  const [expandedState, setExpandedState] = useState<ScopedValue<string | null>>({
    ownerScope,
    value: null,
  })
  const [compactState, setCompactState] = useState<ScopedValue<boolean>>({
    ownerScope,
    value: false,
  })
  const [stateOwnerScope, setStateOwnerScope] = useState(ownerScope)
  const [noticeTarget, setNoticeTarget] = useState<HTMLDivElement | null>(null)
  const [detailsTarget, setDetailsTarget] = useState<HTMLDivElement | null>(null)
  const nextSequence = useRef(0)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  if (stateOwnerScope !== ownerScope) {
    setStateOwnerScope(ownerScope)
    setExpandedState({ ownerScope, value: null })
    setCompactState({ ownerScope, value: false })
  }
  const visibleEntries = useMemo(
    () => [...entries.values()]
      .filter(item => item.ownerScope === ownerScope)
      .sort(compareStatusItems),
    [entries, ownerScope]
  )
  const visibleIds = useMemo(() => new Set(visibleEntries.map(item => item.metadata.id)), [visibleEntries])
  const primaryId = visibleEntries[0]?.metadata.id ?? null
  const expandedId = expandedState.ownerScope === ownerScope &&
    expandedState.value !== null && visibleIds.has(expandedState.value)
    ? expandedState.value
    : null
  const compact = compactState.ownerScope === ownerScope ? compactState.value : false

  const registerItem = useCallback((metadata: ItemMetadata, token: symbol) => {
    setEntries(previous => {
      const existing = previous.get(metadata.id)
      const sequence = existing?.token === token ? existing.sequence : nextSequence.current++
      const nextItem: RegisteredItem = { metadata, token, ownerScope, sequence }
      if (
        existing?.ownerScope === ownerScope && existing.token === token &&
        sameMetadata(existing.metadata, metadata)
      ) return previous
      const next = new Map(previous)
      next.set(metadata.id, nextItem)
      return next
    })
  }, [ownerScope])

  const unregisterItem = useCallback((id: string, token: symbol) => {
    setEntries(previous => {
      const existing = previous.get(id)
      if (!existing || existing.token !== token) return previous
      const next = new Map(previous)
      next.delete(id)
      return next
    })
    setExpandedState(previous => previous.ownerScope === ownerScope && previous.value === id
      ? { ownerScope, value: null }
      : previous)
  }, [ownerScope])

  const expandItem = useCallback((id: string) => {
    setCompactState({ ownerScope, value: false })
    setExpandedState({ ownerScope, value: id })
  }, [ownerScope])

  const closeItem = useCallback((id: string, restoreFocus = true) => {
    setExpandedState(previous => {
      if (previous.ownerScope !== ownerScope || previous.value !== id) return previous
      return { ownerScope, value: null }
    })
    if (restoreFocus) {
      triggerRefs.current.get(id)?.focus({ preventScroll: true })
    }
  }, [ownerScope])

  const toggleCompact = useCallback(() => {
    if (!compact) {
      setExpandedState({ ownerScope, value: null })
      setCompactState({ ownerScope, value: true })
      return
    }
    setCompactState({ ownerScope, value: false })
  }, [compact, ownerScope])

  const registerTrigger = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) triggerRefs.current.set(id, element)
    else triggerRefs.current.delete(id)
  }, [])

  const contextValue = useMemo<ComposerStatusContextValue>(() => ({
    ownerScope,
    entries,
    primaryId,
    expandedId,
    compact,
    noticeTarget,
    detailsTarget,
    registerItem,
    unregisterItem,
    expandItem,
    closeItem,
    toggleCompact,
    registerTrigger,
  }), [
    ownerScope,
    entries,
    primaryId,
    expandedId,
    compact,
    noticeTarget,
    detailsTarget,
    registerItem,
    unregisterItem,
    expandItem,
    closeItem,
    toggleCompact,
    registerTrigger,
  ])

  const attentionEntries = visibleEntries.filter(item => item.metadata.attention)
  const attentionCount = attentionEntries.length
  const isVisible = visibleEntries.length > 0
  const compactDescription = [
    ...visibleEntries.map(item => {
      const metadata = item.metadata
      return [
        metadata.count === undefined ? metadata.title : `${metadata.title} ${metadata.count}`,
        metadata.statusText,
        metadata.id === primaryId && !metadata.statusText && !metadata.attention ? metadata.summary : undefined,
      ].filter(Boolean).join(' ')
    }),
    ...attentionEntries.map(item => item.metadata.summary ?? item.metadata.title),
  ].join(' · ')
  const liveStatus = visibleEntries.map(({ metadata }) => [
    metadata.title,
    metadata.count === undefined ? undefined : String(metadata.count),
    metadata.statusText,
    metadata.summary,
  ].filter(Boolean).join(' ')).join(' · ')

  return (
    <ComposerStatusContext.Provider value={contextValue}>
      <div
        className="contents"
        onKeyDown={event => {
          if (event.key !== 'Escape' || !expandedId) return
          event.preventDefault()
          event.stopPropagation()
          closeItem(expandedId)
        }}
      >
        <div ref={setNoticeTarget} />
        {isVisible && (
          <span className="sr-only" role="status" aria-live="polite">
            {liveStatus}
          </span>
        )}
        <div
          className={isVisible ? 'overflow-hidden rounded-xl border border-border bg-base' : 'contents'}
          data-testid={isVisible ? 'composer-status-region' : undefined}
        >
          {isVisible && (
            <div className="flex min-w-0 items-center gap-1.5 px-2 py-1">
              {compact && (
                <button
                  type="button"
                  aria-controls={`${regionId}-items`}
                  aria-expanded={false}
                  title={compactDescription}
                  className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1 text-left text-sm text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
                  onClick={toggleCompact}
                >
                  <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="sr-only">{t('composer_status.expandRegion')}</span>
                  <span className="shrink-0 font-medium text-text-primary">{t('composer_status.title')}</span>
                  {visibleEntries.map(item => {
                    const metadata = item.metadata
                    return (
                      <span key={metadata.id} className="inline-flex min-w-0 max-w-full items-center gap-1">
                        <span className="max-w-28 truncate">{metadata.title}</span>
                        {metadata.count !== undefined ? (
                          <span className="shrink-0 text-xs tabular-nums">{' '}{metadata.count}</span>
                        ) : null}
                        {metadata.statusText ? (
                          <span className="max-w-40 truncate text-xs text-text-secondary" title={metadata.statusText}>
                            {metadata.statusText}
                          </span>
                        ) : null}
                        {metadata.id === primaryId && !metadata.statusText && !metadata.attention && metadata.summary ? (
                          <span className="max-w-40 truncate text-xs text-text-muted" title={metadata.summary}>
                            {metadata.summary}
                          </span>
                        ) : null}
                      </span>
                    )
                  })}
                  {attentionEntries.map(item => (
                    <span key={`${item.metadata.id}-attention`} className="max-w-40 truncate text-xs text-warning">
                      {item.metadata.summary ?? item.metadata.title}
                    </span>
                  ))}
                  {attentionCount > 0 && (
                    <span className="shrink-0 text-xs tabular-nums text-warning">
                      {t('composer_status.attentionCount', { count: attentionCount })}
                    </span>
                  )}
                </button>
              )}
              <div
                id={`${regionId}-items`}
                hidden={compact}
                role="group"
                aria-label={t('composer_status.title')}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5"
              >
                {visibleEntries.map((item, visualOrder) => (
                  <ComposerStatusTrigger
                    key={item.metadata.id}
                    item={item}
                    primary={item.metadata.id === primaryId}
                    expanded={expandedId === item.metadata.id}
                    visualOrder={visualOrder}
                    onOpen={expandItem}
                    onClose={closeItem}
                    registerTrigger={registerTrigger}
                  />
                ))}
              </div>
              {!compact && (
                <button
                  type="button"
                  aria-label={t('composer_status.collapseRegion')}
                  aria-controls={`${regionId}-items`}
                  aria-expanded={true}
                  className="flex min-h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 max-md:w-11"
                  onClick={toggleCompact}
                >
                  <ChevronUp aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <div ref={setDetailsTarget} />
        </div>
        {children}
      </div>
    </ComposerStatusContext.Provider>
  )
}

// This hook intentionally shares the component module to keep the public API colocated.
// eslint-disable-next-line react-refresh/only-export-components
export function useComposerStatusItem(id: string) {
  const context = useContext(ComposerStatusContext)
  const expandItem = context?.expandItem
  const closeItem = context?.closeItem
  const available = Boolean(context)
  const expanded = available && context?.expandedId === id
  const open = useCallback(() => expandItem?.(id), [expandItem, id])
  const close = useCallback(() => closeItem?.(id), [closeItem, id])

  return {
    available: Boolean(available),
    expanded: Boolean(expanded),
    open: expandItem ? open : noop,
    close: closeItem ? close : noop,
  }
}

export function ComposerStatusItem({
  id,
  title,
  statusText,
  summary,
  count,
  icon,
  attention = false,
  order,
  children,
}: ComposerStatusItemProps) {
  const context = useContext(ComposerStatusContext)
  const status = useComposerStatusItem(id)
  const { t } = useTranslation('chat')
  const tokenRef = useRef(Symbol(id))
  const panelId = useId()
  const registerItem = context?.registerItem
  const unregisterItem = context?.unregisterItem
  const metadata = useMemo<ItemMetadata>(
    () => ({ id, title, panelId, statusText, summary, count, icon, attention, order }),
    [id, title, panelId, statusText, summary, count, icon, attention, order]
  )

  useEffect(() => {
    if (!registerItem) return
    registerItem(metadata, tokenRef.current)
  }, [registerItem, metadata])

  useEffect(() => () => {
    unregisterItem?.(id, tokenRef.current)
  }, [unregisterItem, id])

  if (!context) return <>{children}</>

  const details = context.detailsTarget
    ? createPortal(
      <section
        id={panelId}
        aria-labelledby={`${panelId}-heading`}
        hidden={!status.expanded}
        data-testid={`composer-status-content-${id}`}
        className="max-h-[min(32dvh,18rem)] overflow-y-auto overscroll-contain border-t border-border"
      >
        <div className="sticky top-0 z-10 flex min-h-9 items-center justify-between gap-2 border-b border-border bg-base px-3 py-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 id={`${panelId}-heading`} className="truncate text-base font-medium text-text-primary">
              {title}
            </h2>
            {summary ? <span className="truncate text-xs text-text-muted">{summary}</span> : null}
          </div>
          <button
            type="button"
            aria-label={t('composer_status.closeDetails')}
            className="flex min-h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 max-md:w-11"
            onClick={() => status.close()}
          >
            <ChevronUp aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="min-w-0 px-3 py-2">
          {children}
        </div>
      </section>,
      context.detailsTarget,
      `${id}-details`
    )
    : null

  return details
}
