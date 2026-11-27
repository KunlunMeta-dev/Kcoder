import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X, type LucideIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export interface ComposerStatusItemProps {
  id: string
  title: string
  label?: string
  statusText?: string
  summary?: string
  count?: number
  icon?: LucideIcon
  attention?: boolean
  autoExpand?: boolean
  /** Hide this item from the row; must be a stable callback. */
  onDismiss?: () => void
  dismissLabel?: string
  children: ReactNode
}

interface ItemMetadata {
  id: string
  title: string
  label?: string
  panelId: string
  statusText?: string
  summary?: string
  count?: number
  icon?: LucideIcon
  attention?: boolean
  onDismiss?: () => void
  dismissLabel?: string
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
  expandedIds: readonly string[]
  noticeTarget: HTMLDivElement | null
  detailsTargets: ReadonlyMap<string, HTMLDivElement>
  registerItem: (metadata: ItemMetadata, token: symbol) => void
  unregisterItem: (id: string, token: symbol) => void
  expandItem: (id: string) => void
  closeItem: (id: string, restoreFocus?: boolean) => void
}

const ComposerStatusContext = createContext<ComposerStatusContextValue | null>(null)
const noop = () => {}

function ownerScopeFor(ownerKey: string | number | undefined): string {
  return ownerKey === undefined ? 'default' : `${typeof ownerKey}:${String(ownerKey)}`
}

function sameMetadata(left: ItemMetadata, right: ItemMetadata): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.label === right.label &&
    left.panelId === right.panelId &&
    left.statusText === right.statusText &&
    left.summary === right.summary &&
    left.count === right.count &&
    left.icon === right.icon &&
    left.attention === right.attention &&
    left.onDismiss === right.onDismiss &&
    left.dismissLabel === right.dismissLabel
  )
}

interface ComposerStatusTriggerProps {
  item: RegisteredItem
  expanded: boolean
  onOpen: (id: string) => void
  onClose: (id: string) => void
  registerTrigger: (id: string, element: HTMLButtonElement | null) => void
}

function ComposerStatusTrigger({
  item,
  expanded,
  onOpen,
  onClose,
  registerTrigger,
}: ComposerStatusTriggerProps) {
  const { id, title, label, panelId, statusText, summary, count, icon, attention, onDismiss, dismissLabel } =
    item.metadata
  return (
    <div className="flex shrink-0 items-center" data-status-item={id}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        data-testid={`composer-status-trigger-${id}`}
        title={[count === undefined ? title : `${title} ${count}`, statusText, summary]
          .filter(Boolean)
          .join(' · ')}
        className={`flex min-h-8 max-w-48 items-center gap-1.5 rounded-md px-2 text-left text-sm hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 ${attention ? 'text-warning' : 'text-text-secondary'} ${expanded ? 'bg-surface-hover' : ''}`}
        ref={element => registerTrigger(id, element)}
        onClick={() => (expanded ? onClose(id) : onOpen(id))}
      >
        {icon ? createElement(icon, { 'aria-hidden': true, className: 'h-4 w-4 shrink-0' }) : null}
        <span className="min-w-0 truncate">{label ?? title}</span>
        {count !== undefined && !label ? (
          <span className="shrink-0 text-xs tabular-nums">{count}</span>
        ) : null}
        {!label && statusText ? (
          <span className={`max-w-24 truncate text-xs ${attention ? 'text-warning' : ''}`}>{statusText}</span>
        ) : null}
      </button>
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel ?? title}
          title={dismissLabel ?? title}
          data-testid={`composer-status-dismiss-${id}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 max-md:w-11"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

/** Stable portal targets retain drafts while React moves panels into opening order. */
function ComposerStatusSlot({
  id,
  registerTarget,
}: {
  id: string
  registerTarget: (id: string, element: HTMLDivElement | null) => void
}) {
  const setTarget = useCallback(
    (element: HTMLDivElement | null) => registerTarget(id, element),
    [id, registerTarget]
  )
  return <div ref={setTarget} />
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

function ComposerStatusRegionHost({ children, ownerKey }: ComposerStatusRegionProps) {
  const { t } = useTranslation('chat')
  const ownerScope = ownerScopeFor(ownerKey)
  const [entries, setEntries] = useState<Map<string, RegisteredItem>>(() => new Map())
  const [expandedState, setExpandedState] = useState<ScopedValue<string[]>>({
    ownerScope,
    value: [],
  })
  const [noticeTarget, setNoticeTarget] = useState<HTMLDivElement | null>(null)
  const [detailsTargets, setDetailsTargets] = useState<Map<string, HTMLDivElement>>(() => new Map())
  const detailsScrollRef = useRef<HTMLDivElement | null>(null)
  const previousExpandedIds = useRef<readonly string[]>([])
  const nextSequence = useRef(0)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  if (expandedState.ownerScope !== ownerScope) {
    setExpandedState({ ownerScope, value: [] })
  }
  const visibleEntries = useMemo(
    () =>
      [...entries.values()]
        .filter(item => item.ownerScope === ownerScope)
        .sort((left, right) => left.sequence - right.sequence),
    [entries, ownerScope]
  )
  const visibleIds = useMemo(
    () => new Set(visibleEntries.map(item => item.metadata.id)),
    [visibleEntries]
  )
  const expandedIds = useMemo(
    () =>
      expandedState.ownerScope === ownerScope
        ? expandedState.value.filter(id => visibleIds.has(id))
        : [],
    [expandedState, ownerScope, visibleIds]
  )
  const panelEntries = useMemo(() => {
    const open = [...expandedIds].reverse().map(id => entries.get(id)!)
    return [
      ...open,
      ...[...entries.values()].filter(item => !expandedIds.includes(item.metadata.id)),
    ]
  }, [entries, expandedIds])

  useLayoutEffect(() => {
    const lastOpened = expandedIds.at(-1)
    if (lastOpened && !previousExpandedIds.current.includes(lastOpened)) {
      if (detailsScrollRef.current) detailsScrollRef.current.scrollTop = 0
    }
    previousExpandedIds.current = expandedIds
  }, [expandedIds])

  const registerTarget = useCallback((id: string, element: HTMLDivElement | null) => {
    setDetailsTargets(previous => {
      if (previous.get(id) === (element ?? undefined)) return previous
      const next = new Map(previous)
      if (element) next.set(id, element)
      else next.delete(id)
      return next
    })
  }, [])

  const registerItem = useCallback(
    (metadata: ItemMetadata, token: symbol) => {
      setEntries(previous => {
        const existing = previous.get(metadata.id)
        const sequence =
          existing?.token === token && existing.ownerScope === ownerScope
            ? existing.sequence
            : nextSequence.current++
        const nextItem: RegisteredItem = { metadata, token, ownerScope, sequence }
        if (
          existing?.ownerScope === ownerScope &&
          existing.token === token &&
          sameMetadata(existing.metadata, metadata)
        )
          return previous
        const next = new Map(previous)
        next.set(metadata.id, nextItem)
        return next
      })
    },
    [ownerScope]
  )

  const unregisterItem = useCallback(
    (id: string, token: symbol) => {
      setEntries(previous => {
        const existing = previous.get(id)
        if (!existing || existing.token !== token) return previous
        const next = new Map(previous)
        next.delete(id)
        return next
      })
      setExpandedState(previous =>
        previous.ownerScope === ownerScope && previous.value.includes(id)
          ? { ownerScope, value: previous.value.filter(value => value !== id) }
          : previous
      )
    },
    [ownerScope]
  )

  const expandItem = useCallback(
    (id: string) => {
      setExpandedState(previous => {
        const ids = previous.ownerScope === ownerScope ? previous.value : []
        return ids.includes(id) ? previous : { ownerScope, value: [...ids, id] }
      })
    },
    [ownerScope]
  )

  const closeItem = useCallback(
    (id: string, restoreFocus = true) => {
      setExpandedState(previous => {
        if (previous.ownerScope !== ownerScope || !previous.value.includes(id)) return previous
        return { ownerScope, value: previous.value.filter(value => value !== id) }
      })
      if (restoreFocus) {
        const trigger = triggerRefs.current.get(id)
        trigger?.focus({ preventScroll: true })
        trigger?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }
    },
    [ownerScope]
  )

  const registerTrigger = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) triggerRefs.current.set(id, element)
    else triggerRefs.current.delete(id)
  }, [])

  const contextValue = useMemo<ComposerStatusContextValue>(
    () => ({
      expandedIds,
      noticeTarget,
      detailsTargets,
      registerItem,
      unregisterItem,
      expandItem,
      closeItem,
    }),
    [expandedIds, noticeTarget, detailsTargets, registerItem, unregisterItem, expandItem, closeItem]
  )

  const isVisible = visibleEntries.length > 0
  const liveStatus = visibleEntries
    .map(({ metadata }) =>
      [
        metadata.title,
        metadata.count === undefined ? undefined : String(metadata.count),
        metadata.statusText,
        metadata.summary,
      ]
        .filter(Boolean)
        .join(' ')
    )
    .join(' · ')

  return (
    <ComposerStatusContext.Provider value={contextValue}>
      <div
        className="contents"
        onKeyDown={event => {
          if (event.key !== 'Escape' || expandedIds.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          const target = event.target as HTMLElement
          const panel = target.closest<HTMLElement>('[data-status-panel]')
          const trigger = target.closest<HTMLElement>('[data-status-item]')
          const id =
            panel?.dataset.statusPanel ?? trigger?.dataset.statusItem ?? expandedIds.at(-1)!
          if (expandedIds.includes(id)) closeItem(id)
        }}
      >
        <div ref={setNoticeTarget} />
        {isVisible && (
          <span className="sr-only" role="status" aria-live="polite">
            {liveStatus}
          </span>
        )}
        <div
          className={
            isVisible ? 'min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-base' : 'contents'
          }
          data-testid={isVisible ? 'composer-status-region' : undefined}
        >
          <div
            ref={detailsScrollRef}
            data-testid="composer-status-details"
            className="processing-preview-scrollbar max-h-[48dvh] overflow-y-auto overscroll-contain"
          >
            {panelEntries.map(item => (
              <ComposerStatusSlot
                key={item.metadata.id}
                id={item.metadata.id}
                registerTarget={registerTarget}
              />
            ))}
          </div>
          {isVisible && (
            <div
              className={`min-w-0 px-2 py-1 ${expandedIds.length ? 'border-t border-border' : ''}`}
            >
              <div
                role="group"
                aria-label={t('composer_status.title')}
                data-testid="composer-status-row"
                className="processing-preview-scrollbar composer-status-scrollbar flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain py-0.5"
              >
                {visibleEntries.map(item => (
                  <ComposerStatusTrigger
                    key={item.metadata.id}
                    item={item}
                    expanded={expandedIds.includes(item.metadata.id)}
                    onOpen={expandItem}
                    onClose={closeItem}
                    registerTrigger={registerTrigger}
                  />
                ))}
              </div>
            </div>
          )}
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
  const expanded = available && context?.expandedIds.includes(id)
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
  label,
  statusText,
  summary,
  count,
  icon,
  attention = false,
  autoExpand = true,
  onDismiss,
  dismissLabel,
  children,
}: ComposerStatusItemProps) {
  const context = useContext(ComposerStatusContext)
  const status = useComposerStatusItem(id)
  const tokenRef = useRef(Symbol(id))
  const panelId = useId()
  const registerItem = context?.registerItem
  const unregisterItem = context?.unregisterItem
  const expandItem = context?.expandItem
  const metadata = useMemo<ItemMetadata>(
    () => ({ id, title, label, panelId, statusText, summary, count, icon, attention, onDismiss, dismissLabel }),
    [id, title, label, panelId, statusText, summary, count, icon, attention, onDismiss, dismissLabel]
  )

  useEffect(() => {
    if (!registerItem) return
    registerItem(metadata, tokenRef.current)
  }, [registerItem, metadata])

  useEffect(() => {
    if (autoExpand) expandItem?.(id)
  }, [autoExpand, expandItem, id])

  useEffect(() => {
    const token = tokenRef.current
    return () => {
      unregisterItem?.(id, token)
    }
  }, [unregisterItem, id])

  if (!context) return <>{children}</>

  const detailsTarget = context.detailsTargets.get(id)
  const details = detailsTarget
    ? createPortal(
        <section
          id={panelId}
          aria-label={title}
          hidden={!status.expanded}
          data-status-panel={id}
          data-testid={`composer-status-content-${id}`}
          className="border-b border-border"
        >
          <div className="min-w-0 px-3 py-2">{children}</div>
        </section>,
        detailsTarget,
        `${id}-details`
      )
    : null

  return details
}
