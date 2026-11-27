import { Brain, ChevronDown, LoaderCircle, Wrench } from 'lucide-react'
import { useContext, useMemo, type ReactNode } from 'react'
import { ToolsCatalogContext } from '@/kcoder/toolsCatalogContext'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProcessingBlock } from '@/types/workbench'
import { usePersistentProcessingExpansion } from './blocks/processingExpansionState'
import { latestProcessActivity } from './turnProcessActivity'
import { processActivityTiming } from './processActivityTiming'
import { formatTurnDuration } from './useTurnProcessTime'
import './turn-process-summary.css'

/** Thinking and tools share one disclosure; their own details remain independently folded. */
export function ProcessActivityGroup({ blocks, stateKey, children, thinkingActive = true, showTiming = false, now }: {
  blocks: ProcessingBlock[]
  stateKey: string
  children: ReactNode
  thinkingActive?: boolean
  showTiming?: boolean
  now?: number
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = usePersistentProcessingExpansion(stateKey, false)
  const catalog = useContext(ToolsCatalogContext)
  const { thinking, tools, activity, timing, counts } = useMemo(() => {
    const thinking = blocks.filter(block => block.type === 'thinking').length
    const tools = blocks.filter(block => block.type !== 'thinking' && block.type !== 'text').length
    const counts = [thinking ? t('turn_process.thinking', { count: thinking }) : '',
      tools ? t('turn_process.tools', { count: tools }) : ''].filter(Boolean).join(' · ')
    return { thinking, tools, counts,
      activity: latestProcessActivity(blocks, catalog, false, thinkingActive),
      timing: processActivityTiming(blocks, thinkingActive) }
  }, [blocks, catalog, thinkingActive, t])
  const end = timing.running ? now : timing.completedAt
  const duration = timing.startedAt !== undefined && end !== undefined && end >= timing.startedAt
    ? formatTurnDuration(end - timing.startedAt) : undefined
  const heading = showTiming ? [t('turn_process.executed'), duration].filter(Boolean).join(' ') : undefined
  const details = [counts, activity].filter(Boolean).join(' · ')
  const label = [heading, details].filter(Boolean).join(' · ')
  const running = timing.running
  return (
    <div className="process-activity-group min-w-0" data-testid="process-activity-group">
      <button type="button" data-testid="process-activity-toggle" aria-expanded={expanded}
        aria-label={label} title={label} onClick={() => setExpanded(value => !value)}
        className="process-summary-line flex w-full min-w-0 items-center gap-1 text-sm text-text-muted hover:text-text-secondary">
        <ChevronDown className={`size-4 shrink-0 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
        {!heading && thinking > 0 ? <Brain className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        {!heading && tools > 0 ? <Wrench className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        {heading ? <>
          <span className="min-w-0 truncate tabular-nums" data-testid="process-activity-heading">{heading}</span>
          {details ? <span className="turn-process-activity min-w-0 truncate">{details}</span> : null}
        </> : <span className="turn-process-activity min-w-0 truncate">{label}</span>}
        {running ? <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
      </button>
      {expanded ? <div className="flex min-w-0 flex-col gap-1 pl-4" data-testid="process-activity-content">{children}</div> : null}
    </div>
  )
}
