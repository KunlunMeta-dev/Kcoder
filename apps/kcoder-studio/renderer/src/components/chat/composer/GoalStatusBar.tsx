import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Pause, Pencil, Play, Target, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeGoal, RuntimeGoalStatus } from '@/types/api'
import { ComposerStatusItem } from './ComposerStatusRegion'

interface GoalStatusBarProps {
  goal: RuntimeGoal
  readOnly?: boolean
  presentation?: 'detail' | 'embedded'
  continuing?: boolean
  onEditGoal?: () => void
  onPauseGoal?: () => void
  onResumeGoal?: () => void
  onClearGoal?: () => void
}

const goalStatusLabelKeys: Record<RuntimeGoalStatus, { key: string; fallback: string }> = {
  active: { key: 'workbench.goal_status_active', fallback: '进行中的目标' },
  paused: { key: 'workbench.goal_status_paused', fallback: '已暂停的目标' },
  blocked: { key: 'workbench.goal_status_blocked', fallback: '受阻的目标' },
  cancelled: { key: 'workbench.goal_status_cancelled', fallback: '已取消的目标' },
  complete: { key: 'workbench.goal_status_complete', fallback: '已完成的目标' },
  usageLimited: { key: 'workbench.goal_status_usage_limited', fallback: '用量受限的目标' },
  budgetLimited: { key: 'workbench.goal_status_budget_limited', fallback: '预算受限的目标' },
}

export function GoalStatusBar({
  goal,
  continuing = false,
  readOnly = false,
  presentation,
  onEditGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
}: GoalStatusBarProps) {
  const { t } = useTranslation('common')
  const statusLabel = continuing
    ? { key: 'workbench.goal_status_continuing', fallback: '目标继续执行中' }
    : (goalStatusLabelKeys[goal.status] ?? goalStatusLabelKeys.active)
  const timerKey = `${goalTimerKey(goal)}:${readOnly}`
  const [timerState, setTimerState] = useState(() => createTimerState(timerKey, Date.now()))
  const elapsedSeconds = useMemo(
    () => (readOnly ? goal.timeUsedSeconds : getLiveElapsedSeconds(goal, timerState, timerKey)),
    [goal, timerKey, timerState, readOnly]
  )
  const elapsed = formatGoalElapsed(elapsedSeconds)
  const resumable = goal.status === 'paused' || goal.status === 'blocked'
  const canToggle = goal.status === 'active' || resumable
  const ToggleIcon = resumable ? Play : Pause
  const toggleLabel = resumable
    ? t('workbench.goal_resume', '继续目标')
    : t('workbench.goal_pause', '暂停目标')
  const toggleAction = resumable ? onResumeGoal : onPauseGoal
  const statusText = t(statusLabel.key, statusLabel.fallback)
  const goalTitle = t('workbench.goal_chip', '目标')
  const attention =
    goal.status === 'paused' ||
    goal.status === 'blocked' ||
    goal.status === 'usageLimited' ||
    goal.status === 'budgetLimited'

  const actionButtons = !readOnly ? (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        data-testid="edit-goal-button"
        onClick={onEditGoal}
        disabled={!onEditGoal}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={t('workbench.goal_edit', '编辑目标')}
        title={t('workbench.goal_edit', '编辑目标')}
      >
        <Pencil className="h-4 w-4" />
      </button>
      {canToggle && (
        <button
          type="button"
          data-testid={resumable ? 'resume-goal-button' : 'pause-goal-button'}
          onClick={toggleAction}
          disabled={!toggleAction}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <ToggleIcon className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        data-testid="clear-goal-button"
        onClick={onClearGoal}
        disabled={!onClearGoal}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={t('workbench.goal_clear', '删除目标')}
        title={t('workbench.goal_clear', '删除目标')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  ) : null

  const detail = (
    <div data-testid="goal-status-detail" className="flex min-w-0 items-start gap-3">
      <Target className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-text-primary">{statusText}</span>
          <span className="text-xs text-text-muted">
            {goal.mode === 'strict'
              ? '/goal-pro'
              : goal.mode === 'arrangement'
                ? '/ultgoal'
                : '/goal'}
          </span>
          {elapsed && <span className="text-xs text-text-muted">{elapsed}</span>}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-secondary">
          {goal.objective}
        </p>
      </div>
      {actionButtons}
    </div>
  )

  useEffect(() => {
    if (readOnly || goal.status !== 'active') return

    const interval = window.setInterval(() => {
      const nowMs = Date.now()
      setTimerState(current =>
        current.key === timerKey ? { ...current, nowMs } : createTimerState(timerKey, nowMs)
      )
    }, 1000)
    return () => window.clearInterval(interval)
  }, [goal.status, timerKey, readOnly])

  if (presentation === 'detail') return detail
  if (presentation === 'embedded') {
    return (
      <ComposerStatusItem
        id="goal"
        title={goalTitle}
        summary={`${statusText} · ${goal.objective}`}
        icon={Target}
        attention={attention}
        order={0}
      >
        {detail}
      </ComposerStatusItem>
    )
  }

  return (
    <div
      data-testid="goal-status-bar"
      className="mb-2 flex h-11 w-full items-center gap-2 rounded-2xl border border-border/45 bg-background px-4 text-sm leading-[18px] text-text-secondary shadow-[0_8px_24px_rgba(15,23,42,0.05)]"
    >
      <Target className="h-4 w-4 shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-text-primary">
          {goal.mode === 'strict'
            ? '/goal-pro'
            : goal.mode === 'arrangement'
              ? '/ultgoal'
              : '/goal'}{' '}
          · {statusText}
        </span>
        <span className="ml-1 truncate text-text-secondary">{goal.objective}</span>
      </div>
      {elapsed && <span className="shrink-0 text-text-secondary">{elapsed}</span>}
      {actionButtons}
      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
    </div>
  )
}

interface GoalTimerState {
  key: string
  startedAtMs: number
  nowMs: number
}

function createTimerState(key: string, nowMs: number): GoalTimerState {
  return {
    key,
    startedAtMs: nowMs,
    nowMs,
  }
}

function goalTimerKey(goal: RuntimeGoal): string {
  return [goal.threadId, goal.status, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt].join(
    ':'
  )
}

function getLiveElapsedSeconds(
  goal: RuntimeGoal,
  timerState: GoalTimerState,
  timerKey: string
): number {
  const baseSeconds = Number.isFinite(goal.timeUsedSeconds)
    ? Math.max(0, Math.floor(goal.timeUsedSeconds))
    : 0
  if (goal.status !== 'active' || timerState.key !== timerKey) return baseSeconds

  return baseSeconds + Math.max(0, Math.floor((timerState.nowMs - timerState.startedAtMs) / 1000))
}

function formatGoalElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`
  }
  return `${remainingSeconds}s`
}
