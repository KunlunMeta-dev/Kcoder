import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ChevronDown, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { usePersistentProcessingExpansion } from './blocks/processingExpansionState'

export function ProcessingGroup({
  children,
  stateKey,
  running,
  turnRunning,
}: {
  children: ReactNode
  stateKey: string
  running: boolean
  turnRunning: boolean
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = usePersistentProcessingExpansion(`${stateKey}:group`, running)
  const wasRunning = useRef(running)
  const wasTurnRunning = useRef(turnRunning)
  useLayoutEffect(() => {
    if (wasTurnRunning.current && !turnRunning) setExpanded(false)
    else if (wasRunning.current !== running) setExpanded(running)
    wasRunning.current = running
    wasTurnRunning.current = turnRunning
  }, [running, setExpanded, turnRunning])
  return (
    <section className="mb-3 min-w-0" data-testid="processing-group">
      <button
        type="button"
        data-testid={running ? 'processing-window-toggle' : 'final-processing-toggle'}
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex min-h-8 items-center gap-1 text-sm text-text-muted hover:text-text-secondary"
      >
        <ChevronDown className={`size-4 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
        {t(running ? 'processing_window.running' : 'toolStatus.processed')}
        {running && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
      </button>
      {expanded && <ProcessingWindow stateKey={stateKey}>{children}</ProcessingWindow>}
    </section>
  )
}

/** A real scroll viewport with a persistent, draggable scrollbar. */
export function ProcessingWindow({
  children,
  stateKey,
  bordered = true,
}: {
  children: ReactNode
  stateKey: string
  bordered?: boolean
}) {
  const { t } = useTranslation('chat')
  const id = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const drag = useRef<{ pointerId: number; offset: number } | null>(null)
  const [metrics, setMetrics] = useState({ height: 0, content: 0, top: 0 })
  const [showLatest, setShowLatest] = useState(false)
  const maxScroll = Math.max(0, metrics.content - metrics.height)
  const hasOverflow = maxScroll > 0
  const thumbHeight = Math.min(
    metrics.height,
    Math.max(28, metrics.height ** 2 / (metrics.content || 1))
  )
  const thumbTop = maxScroll > 0 ? (metrics.top / maxScroll) * (metrics.height - thumbHeight) : 0

  const measure = () => {
    const node = scrollRef.current
    if (!node) return
    setMetrics(previous => {
      const next = { height: node.clientHeight, content: node.scrollHeight, top: node.scrollTop }
      return previous.height === next.height &&
        previous.content === next.content &&
        previous.top === next.top
        ? previous
        : next
    })
    setShowLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 24)
  }

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return
    const follow = () => {
      if (followLatest.current) scroll.scrollTop = scroll.scrollHeight
      measure()
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const scrollbar = scrollbarRef.current
    const viewport = scrollRef.current
    if (!scrollbar || !viewport || !hasOverflow) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const unit =
        event.deltaMode === 2
          ? viewport.clientHeight
          : event.deltaMode === 1
            ? parseFloat(getComputedStyle(viewport).lineHeight) || 24
            : 1
      viewport.scrollTop += event.deltaY * unit
      followLatest.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24
      measure()
    }
    scrollbar.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollbar.removeEventListener('wheel', onWheel)
  }, [hasOverflow])

  const moveThumb = (position: number) => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = Math.max(
      0,
      Math.min(maxScroll, (position / Math.max(1, metrics.height - thumbHeight)) * maxScroll)
    )
    followLatest.current = maxScroll - node.scrollTop <= 24
    measure()
  }

  return (
    <div
      className="relative min-w-0 w-full max-w-[560px]"
      data-testid="processing-window"
      data-state-key={stateKey}
    >
      <div
        id={id}
        ref={scrollRef}
        role="region"
        tabIndex={0}
        aria-label={t('processing_window.title')}
        data-testid="processing-window-scroll"
        className={`scrollbar-none max-h-[min(13rem,35vh)] min-w-0 overflow-y-auto overscroll-contain pr-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${bordered ? 'border-l-2 border-border/60 pl-3 text-text-muted' : ''}`}
        onScroll={event => {
          const node = event.currentTarget
          followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24
          measure()
        }}
      >
        <div ref={contentRef} className="min-w-0">
          {children}
        </div>
      </div>
      {maxScroll > 0 && (
        <div
          ref={scrollbarRef}
          data-testid="processing-window-scrollbar"
          role="scrollbar"
          tabIndex={0}
          aria-label={t('processing_window.scrollbar')}
          aria-controls={id}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxScroll)}
          aria-valuenow={Math.round(metrics.top)}
          className="absolute inset-y-0 right-0 w-6 touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault()
            followLatest.current = false
            event.currentTarget.focus({ preventScroll: true })
            const offset = event.clientY - event.currentTarget.getBoundingClientRect().top
            const insideThumb = offset >= thumbTop && offset <= thumbTop + thumbHeight
            drag.current = {
              pointerId: event.pointerId,
              offset: insideThumb ? offset - thumbTop : thumbHeight / 2,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            if (!insideThumb) moveThumb(offset - thumbHeight / 2)
          }}
          onPointerMove={event => {
            if (drag.current?.pointerId !== event.pointerId) return
            moveThumb(
              event.clientY - event.currentTarget.getBoundingClientRect().top - drag.current.offset
            )
          }}
          onPointerUp={event => {
            if (drag.current?.pointerId !== event.pointerId) return
            drag.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}
          onKeyDown={event => {
            const node = scrollRef.current
            if (!node) return
            const positions: Record<string, number> = {
              ArrowUp: node.scrollTop - 48,
              ArrowDown: node.scrollTop + 48,
              PageUp: node.scrollTop - node.clientHeight,
              PageDown: node.scrollTop + node.clientHeight,
              Home: 0,
              End: maxScroll,
            }
            if (!(event.key in positions)) return
            event.preventDefault()
            node.scrollTop = positions[event.key]
            followLatest.current = maxScroll - node.scrollTop <= 24
            measure()
          }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-2 w-1.5 rounded-full bg-border/50"
          />
          <div
            data-testid="processing-window-thumb"
            aria-hidden="true"
            className="absolute left-2 w-1.5 cursor-grab rounded-full bg-text-muted/80 active:cursor-grabbing"
            style={{ height: thumbHeight, transform: `translateY(${thumbTop}px)` }}
          />
        </div>
      )}
      {showLatest && (
        <button
          type="button"
          data-testid="processing-window-latest"
          aria-label={t('processing_window.latest')}
          title={t('processing_window.latest')}
          className="absolute bottom-2 right-8 flex size-8 items-center justify-center rounded-full border border-border bg-background text-text-secondary shadow-sm hover:bg-surface max-md:size-11"
          onClick={() => {
            followLatest.current = true
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            measure()
          }}
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
