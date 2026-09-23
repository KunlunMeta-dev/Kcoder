import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CirclePause,
  Loader2,
  Send,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeSubagentStatus } from '@/types/workbench'

interface SubagentStatusIndicatorProps {
  statuses?: RuntimeSubagentStatus[]
  availableWidth?: number | null
  className?: string
  compact?: boolean
  onSteer?: (agentId: string, message: string) => Promise<boolean>
}

const EXPANDED_MIN_WIDTH = 720

export function SubagentStatusIndicator({
  statuses = [],
  availableWidth,
  className,
  compact = false,
  onSteer,
}: SubagentStatusIndicatorProps) {
  const { t } = useTranslation('common')
  const [hovered, setHovered] = useState(false)
  const [opened, setOpened] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [steerDraft, setSteerDraft] = useState('')
  const [steerPending, setSteerPending] = useState(false)
  const [steerError, setSteerError] = useState<string | null>(null)
  const visibleStatuses = useMemo(() => statuses.slice(0, 4), [statuses])

  if (statuses.length === 0) return null

  const runningCount = statuses.filter(status => status.status === 'running').length
  const autoExpanded =
    !compact && typeof availableWidth === 'number' && availableWidth >= EXPANDED_MIN_WIDTH
  const panelVisible = autoExpanded || hovered || opened
  const summary =
    runningCount > 0
      ? t('workbench.subagents_running', { count: runningCount })
      : t('workbench.subagents_count', { count: statuses.length })
  const statusLabel = (status: RuntimeSubagentStatus['status']) => {
    if (status === 'paused') return t('workbench.subagent_paused')
    if (status === 'done') return t('workbench.subagent_done')
    if (status === 'interrupted') return t('workbench.subagent_interrupted')
    return t('workbench.subagent_running')
  }
  const steerStatusLabel = (status: RuntimeSubagentStatus) => {
    if (status.steerStatus === 'applied') return t('workbench.subagent_steer_applied')
    if (status.steerStatus?.startsWith('queued')) {
      return t('workbench.subagent_steer_queued')
    }
    if (status.steerStatus === 'resuming') return t('workbench.subagent_steer_resuming')
    return null
  }

  return (
    <div
      data-testid="subagent-status-hover-region"
      className={cn('relative flex shrink-0 items-center', className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <button
        type="button"
        data-testid="subagent-status-toggle-button"
        className={cn(
          'flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full border border-border/70 bg-surface px-2.5 text-xs text-text-secondary shadow-sm hover:bg-background',
          compact && 'h-9 min-w-[44px] justify-center px-2'
        )}
        aria-label={t('workbench.subagents_status')}
        aria-expanded={panelVisible}
        onClick={() => setOpened(current => !current)}
      >
        <Bot className="h-4 w-4 shrink-0 text-primary" />
        {!compact && <span className="truncate">{summary}</span>}
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', panelVisible && 'rotate-180')}
        />
      </button>

      {panelVisible && (
        <div
          data-testid="subagent-status-panel"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-popover w-72 rounded-xl border border-border/80 bg-background p-2 shadow-lg"
        >
          <div className="mb-1 flex items-center justify-between px-1 text-xs text-text-muted">
            <span>{t('workbench.subagents_status')}</span>
            <span>{statuses.length}</span>
          </div>
          <div className="space-y-1">
            {visibleStatuses.map(status => {
              const steerLabel = steerStatusLabel(status)
              const editing = selectedAgentId === status.agentId
              return (
                <div key={status.id} className="rounded-lg hover:bg-surface">
                  <div
                    data-testid="subagent-status-item"
                    data-agent-id={status.agentId}
                    data-steer-status={status.steerStatus ?? ''}
                    className="flex min-h-10 items-center gap-2 px-2 py-1.5 text-sm"
                  >
                    <SubagentStatusIcon status={status.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text-primary" title={status.agentName}>
                        {status.agentName}
                      </span>
                      <span className="block truncate text-xs leading-4 text-text-muted">
                        {shortSubagentId(status.agentId)}
                        {steerLabel ? ` · ${steerLabel}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {statusLabel(status.status)}
                    </span>
                    {status.capacityWarning && (
                      <span className="text-xs text-text-secondary" title={t('workbench.subagent_capacity_help')}>
                        {t('workbench.subagent_capacity', { used: status.retainedRuns, limit: status.retainedRunLimit })}
                      </span>
                    )}
                    {onSteer && status.status === 'running' && (
                      <button
                        type="button"
                        data-testid="subagent-steer-open"
                        className={cn(
                          'flex items-center justify-center rounded-lg px-2 text-xs text-text-secondary hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70',
                          compact ? 'h-11 min-w-[44px]' : 'h-7'
                        )}
                        aria-label={t('workbench.subagent_steer_open', {
                          name: status.agentName,
                        })}
                        onClick={() => {
                          setSelectedAgentId(editing ? null : status.agentId)
                          setSteerDraft('')
                          setSteerError(null)
                        }}
                      >
                        {t('workbench.subagent_steer_action')}
                      </button>
                    )}
                  </div>
                  {editing && onSteer && (
                    <form
                      data-testid="subagent-steer-form"
                      className="space-y-2 border-t border-border/60 px-2 py-2"
                      onSubmit={async event => {
                        event.preventDefault()
                        const message = steerDraft.trim()
                        if (!message || steerPending) return
                        setSteerPending(true)
                        setSteerError(null)
                        const accepted = await onSteer(status.agentId, message)
                        setSteerPending(false)
                        if (accepted) {
                          setSelectedAgentId(null)
                          setSteerDraft('')
                          return
                        }
                        setSteerError(t('workbench.subagent_steer_rejected'))
                      }}
                    >
                      <label className="block text-xs text-text-secondary">
                        {t('workbench.subagent_steer_message')}
                        <textarea
                          data-testid="subagent-steer-input"
                          className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border/80 bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-primary/70"
                          value={steerDraft}
                          disabled={steerPending}
                          onChange={event => setSteerDraft(event.target.value)}
                        />
                      </label>
                      {steerError && (
                        <p role="alert" className="text-xs text-destructive">
                          {steerError}
                        </p>
                      )}
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className={cn(
                            'rounded-lg px-3 text-xs text-text-secondary hover:bg-background',
                            compact ? 'h-11' : 'h-7'
                          )}
                          onClick={() => setSelectedAgentId(null)}
                        >
                          {t('workbench.cancel')}
                        </button>
                        <button
                          type="submit"
                          data-testid="subagent-steer-submit"
                          className={cn(
                            'flex items-center gap-1 rounded-lg bg-text-primary px-3 text-xs text-background disabled:opacity-40',
                            compact ? 'h-11' : 'h-7'
                          )}
                          disabled={!steerDraft.trim() || steerPending}
                        >
                          <Send className="h-3.5 w-3.5" />
                          {steerPending
                            ? t('workbench.subagent_steer_sending')
                            : t('workbench.subagent_steer_send')}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function SubagentStatusIcon({ status }: { status: RuntimeSubagentStatus['status'] }) {
  if (status === 'paused') return <CirclePause className="h-4 w-4 shrink-0 text-text-muted" />
  if (status === 'done') {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
  }
  if (status === 'interrupted') {
    return <CircleAlert className="h-4 w-4 shrink-0 text-amber-600" />
  }
  return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
}

function shortSubagentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  if (!normalized) return 'subagent'
  return normalized.length > 8 ? normalized.slice(-8) : normalized
}
