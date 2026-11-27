import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useContext, type RefObject } from 'react'
import { ToolsCatalogContext } from '@/kcoder/toolsCatalogContext'
import type { TurnProcessPresentation } from './turnProcessPresentation'
import { useTurnProcessTime } from './useTurnProcessTime'
import { latestProcessActivity } from './turnProcessActivity'
import './turn-process-summary.css'

export function TurnProcessSummary({
  presentation,
  serverId,
  expanded,
  onToggle,
  buttonRef,
}: {
  presentation: TurnProcessPresentation
  serverId?: string
  expanded: boolean
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useTranslation('chat')
  const { status } = presentation
  const duration = useTurnProcessTime(presentation, serverId)
  const statusLabel = t(`turn_process.${status}`)
  const catalog = useContext(ToolsCatalogContext)
  const activity = status === 'running' && !expanded
    ? latestProcessActivity(presentation.blocks, catalog, presentation.describing) ?? t('turn_process.analyzing')
    : undefined
  const heading = [statusLabel, duration].filter(Boolean).join(' ')
  const summary = [heading, activity].filter(Boolean).join(' · ')

  return (
    <div
      className="turn-process-summary mb-3 min-w-0 w-full border-b border-border pb-2"
      data-testid="turn-process-summary"
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="final-processing-toggle"
        aria-expanded={expanded}
        aria-label={summary}
        title={summary}
        className="process-summary-line flex w-full min-w-0 items-center gap-2 text-sm text-text-muted hover:text-text-secondary"
        onClick={onToggle}
      >
        <span data-testid="turn-process-heading" className="inline-flex min-w-0 items-center gap-1 text-text-secondary">
          <span data-testid="turn-process-status" className="shrink-0">{statusLabel}</span>
          {duration ? <span data-testid="turn-process-elapsed" className="truncate tabular-nums">{duration}</span> : null}
        </span>
        {activity ? <span data-testid="turn-process-activity" className="turn-process-activity min-w-0 truncate">
          {activity}
        </span> : null}
        <span className="inline-flex shrink-0 items-center gap-1">
          {status === 'running' && !expanded ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : null}
          <ChevronDown
            className={`size-4 transition-transform ${expanded ? '' : '-rotate-90'}`}
            aria-hidden="true"
          />
        </span>
      </button>
    </div>
  )
}
