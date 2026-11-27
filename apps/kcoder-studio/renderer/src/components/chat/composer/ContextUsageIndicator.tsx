import { FileArchive, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useOutsideClick } from '@/hooks/useOutsideClick'
import {
  calculateFloatingMenuHorizontalLayout,
  getFloatingMenuVisibleBounds,
  observeFloatingMenuLayout,
} from '@/lib/floating-menu'
import { runtimeContextUsageMetrics, type RuntimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import { cn } from '@/lib/utils'
import type { RuntimeContextUsage } from '@/types/api'

interface ContextUsageIndicatorProps {
  usage?: RuntimeContextUsage
  disabled?: boolean
  onCompactContext?: () => void
}

interface ConfirmPosition {
  left: number
  top: number
  width: number
}

const CONFIRM_WIDTH = 216
const CONFIRM_GAP = 10
const VIEWPORT_PADDING = 8
const USAGE_DEBOUNCE_MS = 250
const USAGE_MAX_WAIT_MS = 1000

export function ContextUsageIndicator({
  usage,
  ...props
}: ContextUsageIndicatorProps) {
  const metrics = usage ? runtimeContextUsageMetrics(usage) : null
  if (!metrics) return null
  return <ContextUsageReading key={metrics.totalTokens} metrics={metrics} {...props} />
}

function ContextUsageReading({
  metrics: incomingMetrics,
  disabled = false,
  onCompactContext,
}: Omit<ContextUsageIndicatorProps, 'usage'> & { metrics: RuntimeContextUsageMetrics }) {
  const { t } = useTranslation('common')
  const [metrics, setMetrics] = useState(incomingMetrics)
  const debounceStartedAt = useRef<number | null>(null)

  useEffect(() => {
    if (incomingMetrics.usedTokens === metrics.usedTokens) {
      debounceStartedAt.current = null
      return
    }
    const now = Date.now()
    debounceStartedAt.current ??= now
    const timer = setTimeout(() => {
      debounceStartedAt.current = null
      setMetrics(incomingMetrics)
    }, Math.min(USAGE_DEBOUNCE_MS, Math.max(0, USAGE_MAX_WAIT_MS - (now - debounceStartedAt.current))))
    return () => clearTimeout(timer)
  }, [incomingMetrics, metrics.usedTokens])
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmPosition, setConfirmPosition] = useState<ConfirmPosition | null>(null)
  const [tooltipLayout, setTooltipLayout] = useState({ left: 0, width: CONFIRM_WIDTH })

  const closeConfirmation = useCallback(() => {
    setConfirmOpen(false)
    setConfirmPosition(null)
  }, [])
  useOutsideClick([containerRef, popoverRef], confirmOpen, closeConfirmation)
  useEscapeKey(closeConfirmation, confirmOpen)

  useLayoutEffect(() => {
    const updateTooltipLayout = () => {
      const anchor = containerRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const layout = calculateFloatingMenuHorizontalLayout({
        anchorRect: rect,
        containerLeft: rect.left,
        visibleBounds: getFloatingMenuVisibleBounds(anchor, VIEWPORT_PADDING),
        preferredWidth: CONFIRM_WIDTH,
        alignment: 'center',
      })
      setTooltipLayout(layout)
    }

    updateTooltipLayout()
    return observeFloatingMenuLayout(containerRef.current, updateTooltipLayout)
  }, [metrics])

  useLayoutEffect(() => {
    if (!confirmOpen) return

    const updatePosition = () => {
      const trigger = containerRef.current
      const popover = popoverRef.current
      if (!trigger) return

      const triggerRect = trigger.getBoundingClientRect()
      const popoverHeight = popover?.getBoundingClientRect().height ?? 92
      const visibleBounds = getFloatingMenuVisibleBounds(trigger, VIEWPORT_PADDING)
      const width = Math.min(CONFIRM_WIDTH, Math.max(0, visibleBounds.right - visibleBounds.left))
      const maxLeft = visibleBounds.right - width
      const left = Math.max(visibleBounds.left, Math.min(triggerRect.right - width, maxLeft))
      const top = Math.max(VIEWPORT_PADDING, triggerRect.top - popoverHeight - CONFIRM_GAP)

      setConfirmPosition({ left, top, width })
    }

    updatePosition()
    return observeFloatingMenuLayout(containerRef.current, updatePosition, [popoverRef.current])
  }, [confirmOpen])

  const handleCompact = () => {
    setConfirmOpen(false)
    setConfirmPosition(null)
    onCompactContext?.()
  }

  return (
    <div
      ref={containerRef}
      className="group relative flex h-8 w-8 shrink-0 items-center justify-center"
      data-testid="context-usage-indicator"
      aria-label={t('workbench.context_usage_aria', {
        usedPercent: metrics.usedPercent,
        remainingPercent: metrics.remainingPercent,
      })}
    >
      <button
        type="button"
        data-testid="context-usage-button"
        disabled={disabled || !onCompactContext}
        onClick={() => {
          setConfirmPosition(null)
          setConfirmOpen(current => !current)
        }}
        className={cn(
          'context-usage-compact-trigger flex h-7 w-7 items-center justify-center rounded-full disabled:cursor-default',
          metrics.usedPercent >= 85 ? 'text-red-500' : 'text-[#a5abb2]'
        )}
        aria-label={`${t('workbench.context_usage_aria', {
          usedPercent: metrics.usedPercent,
          remainingPercent: metrics.remainingPercent,
        })} ${t('workbench.compact_context_prompt', '是否压缩上下文?')}`}
      >
        <span
          className={cn(
            'context-usage-compact-visual flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
            metrics.usedPercent >= 85 ? 'text-red-500' : 'text-[#a5abb2]'
          )}
          style={{
            background: `conic-gradient(currentColor ${metrics.usedPercent * 3.6}deg, #edf0f2 0deg)`,
          }}
        >
          <span className="h-3 w-3 rounded-full bg-background" />
        </span>
      </button>
      {!confirmOpen && (
        <>
          <div
            className="pointer-events-auto absolute bottom-4 z-system-popover hidden h-3 cursor-default group-hover:block group-focus-within:block"
            style={{ left: tooltipLayout.left, width: tooltipLayout.width }}
          />
          <div
            data-testid="context-usage-tooltip"
            className="pointer-events-auto absolute bottom-7 z-system-popover hidden cursor-default rounded-2xl border border-border/70 bg-background px-4 py-3 text-center text-sm leading-5 text-text-primary shadow-[0_14px_42px_rgba(15,23,42,0.16)] group-hover:block group-focus-within:block"
            style={{ left: tooltipLayout.left, width: tooltipLayout.width }}
          >
            <div className="mb-1 break-words font-light text-text-secondary">
              {t('workbench.context_usage_title')}
            </div>
            <div data-testid="context-usage-percent" className="break-words font-light">
              {t('workbench.context_usage_percent', {
                usedPercent: metrics.usedPercent,
                remainingPercent: metrics.remainingPercent,
              })}
            </div>
            <div className="break-words font-light">
              {t('workbench.context_usage_tokens', {
                usedTokens: formatCompactTokens(metrics.usedTokens),
                totalTokens: formatCompactTokens(metrics.totalTokens),
              })}
            </div>
          </div>
        </>
      )}
      {confirmOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-testid="compact-context-confirm-popover"
            data-overlay-motion="popover"
            className="pointer-events-auto fixed z-system-popover cursor-default rounded-xl border border-border/80 bg-background p-3 text-left text-sm leading-5 text-text-primary shadow-[0_14px_42px_rgba(15,23,42,0.14)]"
            style={{
              left: confirmPosition?.left ?? 0,
              top: confirmPosition?.top ?? 0,
              width: confirmPosition?.width ?? CONFIRM_WIDTH,
              visibility: confirmPosition ? 'visible' : 'hidden',
            }}
          >
            <div className="mb-3 pr-7">
              <div className="font-medium">
                {t('workbench.compact_context_prompt', '是否压缩上下文?')}
              </div>
              <div className="mt-0.5 text-xs leading-[18px] text-text-secondary">
                {t('workbench.compact_context_hint', '将当前长对话压缩成更短的上下文。')}
              </div>
            </div>
            <button
              type="button"
              data-testid="cancel-compact-context-button"
              onClick={() => {
                setConfirmOpen(false)
                setConfirmPosition(null)
              }}
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.cancel', '取消')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                data-testid="dismiss-compact-context-button"
                onClick={() => setConfirmOpen(false)}
                className="inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                {t('workbench.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="confirm-compact-context-button"
                onClick={handleCompact}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[#1f1f1f] px-2.5 text-xs font-medium text-white hover:bg-[#333]"
              >
                <FileArchive className="h-3.5 w-3.5" />
                <span>{t('workbench.compact_context', '压缩')}</span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}m`
  if (absolute >= 1_000) return `${formatCompactNumber(value / 1_000)}k`
  return `${Math.round(value)}`
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1).replace(/\.0$/, '')
}
