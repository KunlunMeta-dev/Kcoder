import {
  CircleAlert,
  Clock3,
  Loader2,
  MessageCircleQuestion,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ThreadRunActivity, ThreadRunSummary } from '@/kcoder/threadRunSummary'

export function RuntimeTaskActivityBadge({
  taskId,
  activity,
  summary,
  running,
}: {
  taskId: string
  activity?: ThreadRunActivity
  summary?: ThreadRunSummary
  running: boolean
}) {
  const { t } = useTranslation('common')
  const state =
    activity &&
    ['waiting_approval', 'waiting_answer', 'background', 'aggregating', 'unknown'].includes(
      activity
    )
      ? activity
      : running
        ? 'running'
        : (activity ?? 'idle')
  const recent = summary?.recentError
  if (
    !running &&
    !['waiting_approval', 'waiting_answer', 'background', 'aggregating'].includes(state) &&
    (state !== 'unknown' || Boolean(recent))
  ) {
    if (!recent) return null
    const label = t(
      `workbench.runtime_activity.${recent.kind === 'interrupted' ? 'recent_interrupted' : 'recent_failed'}`
    )
    return (
      <span
        data-testid={`runtime-task-recent-error-${taskId}`}
        className="inline-flex items-center gap-1 text-xs text-text-muted"
        title={`${label} · ${t(`workbench.runtime_activity.error_${recent.category}`)}`}
        aria-label={label}
      >
        <CircleAlert className="h-3 w-3" aria-hidden="true" />
        <span>{label}</span>
      </span>
    )
  }
  const label = t(`workbench.runtime_activity.${state}`)
  const Icon =
    state === 'waiting_approval'
      ? ShieldCheck
      : state === 'waiting_answer'
        ? MessageCircleQuestion
        : state === 'background'
          ? Workflow
          : state === 'aggregating'
            ? Clock3
            : state === 'unknown'
              ? CircleAlert
              : Loader2
  const count =
    state === 'background'
      ? (summary?.activeJobs ?? 0) + (summary?.tasksPending ?? 0) + (summary?.tasksRunning ?? 0)
      : state === 'waiting_approval'
        ? summary?.pendingApprovals
        : state === 'waiting_answer'
          ? summary?.pendingQuestions
          : state === 'aggregating'
            ? summary?.pendingFollowups
            : 0
  const title =
    recent === undefined ? `${label} · ${t('workbench.runtime_activity.error_unknown')}` : label
  return (
    <span
      data-testid={`runtime-task-activity-${taskId}`}
      data-activity={state}
      className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-text-muted"
      title={title}
      aria-label={label}
    >
      <Icon className={`h-3 w-3 ${state === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span>
        {label}
        {count && count > 1 ? ` ${count}` : ''}
      </span>
    </span>
  )
}
