import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  Search,
  CircleDashed,
  CircleHelp,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Clock,
  CirclePause,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  taskBoardLanes,
  taskBoardMatchesPeriod,
  taskBoardState,
  taskBoardUpdatedAt,
  type TaskBoardLane,
  type TaskBoardPeriod,
  taskBoardChoiceKey,
  pendingInputSegments,
  workControlPresentation,
  workResultPresentation,
} from './taskBoardModel'
import type { WorkControlAction, WorkControlApi } from './useWorkControl'
import type { ContinuousWorkView } from '../../../../shared/generated/contracts'
import type { TaskWorkspaceThreadChoice } from './NativeTaskWorkspace'
import styles from './TaskBoard.module.css'

export interface TaskBoardProps {
  tasks: TaskWorkspaceThreadChoice[]
  selectedKey?: string
  listingState: 'ready' | 'loading' | 'unavailable'
  onSelect: (task: TaskWorkspaceThreadChoice) => void
  canOpen: (task: TaskWorkspaceThreadChoice) => boolean
  onOpen: (task: TaskWorkspaceThreadChoice) => void
  renderActions?: (task: TaskWorkspaceThreadChoice) => ReactNode
  /** Present only when the target negotiated the control capability. */
  control?: WorkControlApi
}

const tones: Record<TaskBoardLane, string> = {
  active: 'bg-accent-surface text-focus',
  waiting: 'bg-warning/10 text-warning',
  background: 'bg-accent-surface text-text-secondary',
  paused: 'bg-surface text-text-secondary',
  completed: 'bg-success/10 text-success',
  stopped: 'bg-destructive/10 text-destructive',
  unknown: 'bg-surface text-text-muted',
}
const icons = {
  active: LoaderCircle,
  waiting: CircleHelp,
  background: Clock,
  paused: CirclePause,
  completed: CircleCheck,
  stopped: CircleAlert,
  unknown: CircleDashed,
}

/** Horizontal task list retains native observations and original task actions. */
export function TaskBoard({
  tasks,
  selectedKey,
  listingState,
  onSelect,
  canOpen,
  onOpen,
  renderActions,
  control,
}: TaskBoardProps) {
  const { t, i18n } = useTranslation('taskWorkspace')
  const [filter, setFilter] = useState<TaskBoardLane | 'all'>('all')
  const [period, setPeriod] = useState<TaskBoardPeriod>('7days')
  const [clock, setClock] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const [requestedPage, setPage] = useState(1)
  useEffect(() => {
    const nextDay = new Date(clock)
    nextDay.setHours(24, 0, 0, 0)
    const refresh = () => setClock(Date.now())
    const timer = window.setTimeout(refresh, Math.max(1, nextDay.getTime() - Date.now()))
    window.addEventListener('focus', refresh)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [clock])
  const rows = tasks.map(task => ({
    task,
    state: taskBoardState(
      listingState === 'unavailable' && task.board ? { ...task.board, stale: true } : task.board
    ),
  }))
  const periodRows = rows.filter(({ task }) =>
    taskBoardMatchesPeriod(task.board?.task.updatedAt, period, new Date(clock))
  )
  const visible = periodRows.filter(
    ({ task, state }) =>
      (filter === 'all' || filter === state.lane) &&
      task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const page = Math.min(requestedPage, pageCount)
  if (page !== requestedPage) setPage(page)
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize)
  return (
    <section
      className={`${styles.root} min-w-0 space-y-4`}
      aria-label={t('board.label')}
      data-testid="task-board-list"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-text-secondary">{t('board.loaded', { count: tasks.length })}</p>
        <label className="flex min-h-10 w-full items-center gap-2 rounded-xl border border-border px-3 sm:w-72">
          <Search className="size-4 text-text-muted" aria-hidden="true" />
          <input
            aria-label={t('board.search')}
            placeholder={t('board.search')}
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setPage(1)
            }}
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
          />
        </label>
      </div>
      <div
        role="group"
        aria-label={t('board.periodLabel')}
        className="flex flex-wrap items-center gap-2"
      >
        <span className="mr-1 text-sm text-text-secondary">{t('board.updated')}</span>
        {(['today', '7days', '30days', 'all'] as const).map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => {
              setPeriod(value)
              setPage(1)
            }}
            className={`min-h-10 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${period === value ? 'border-focus/30 bg-accent-surface text-text-primary' : 'border-border/60 bg-background text-text-secondary hover:bg-surface'}`}
          >
            {t(`board.periods.${value}`)}
          </button>
        ))}
      </div>
      {period !== 'all' &&
        rows.some(({ task }) => !taskBoardUpdatedAt(task.board?.task.updatedAt)) && (
          <p className="text-xs text-text-muted">{t('board.unknownTimeHelp')}</p>
        )}
      <div className="flex flex-wrap gap-2" aria-label={t('board.label')}>
        {(['all', ...taskBoardLanes] as const).map(lane => (
          <button
            key={lane}
            type="button"
            onClick={() => {
              setFilter(lane)
              setPage(1)
            }}
            aria-pressed={filter === lane}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${filter === lane ? 'border-text-primary bg-text-primary text-background' : 'border-border/60 bg-background text-text-secondary hover:bg-surface'}`}
          >
            {lane === 'all' ? t('board.allTasks') : t(`board.columns.${lane}`)}
            <span className="text-xs opacity-60">
              {lane === 'all'
                ? periodRows.length
                : periodRows.filter(row => row.state.lane === lane).length}
            </span>
          </button>
        ))}
      </div>
      {listingState !== 'ready' && (
        <p role="status" className="text-sm text-text-secondary">
          {t(`board.${listingState}`)}
        </p>
      )}
      <div className="studio-card overflow-hidden rounded-xl border border-border/70 bg-background">
        <div
          className={`${styles.row} border-b border-border/60 bg-surface/70 px-5 py-3 pr-16 text-xs text-text-secondary`}
        >
          <span>{t('board.taskColumn')}</span>
          <span>{t('board.statusColumn')}</span>
          <span className={styles.secondary}>{t('targetLabel')}</span>
          <span className={styles.secondary}>{t('board.updated')}</span>
        </div>
        {pageRows.map(({ task, state }) => {
          const key = taskBoardChoiceKey(task)
          const Icon = icons[state.lane]
          const date = taskBoardUpdatedAt(task.board?.task.updatedAt)
          const workResult = workResultPresentation(task.board?.work?.result)
          return (
            <article
              key={key}
              data-testid="task-board-list-row"
              className={`flex min-w-0 items-center border-b border-border/50 last:border-b-0 ${selectedKey === key ? 'bg-accent-surface/40' : 'hover:bg-surface/50'}`}
            >
              <button
                type="button"
                onClick={() => onSelect(task)}
                className={`${styles.row} min-h-16 min-w-0 flex-1 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus`}
              >
                <span
                  className="min-w-0 truncate text-sm font-medium text-text-primary"
                  title={task.title}
                >
                  {task.title}
                </span>
                <span className="flex min-w-0 flex-col items-start gap-1">
                <span
                  className={`inline-flex w-fit max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs ${tones[state.lane]}`}
                  title={t(`board.hints.${state.hint}`)}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {state.statusLabel
                      ? t(`board.statusLabels.${state.statusLabel}`)
                      : t(`board.columns.${state.lane}`)}
                  </span>
                  <span className="sr-only"> {t(`board.hints.${state.hint}`)}</span>
                </span>
                {workResult && (
                  <span
                    data-testid="task-board-work-result"
                    className="max-w-full truncate text-xs text-text-muted"
                    title={t(`board.workResult.${workResult.label}`)}
                  >
                    {t(`board.workResult.${workResult.label}`)}
                  </span>
                )}
                </span>
                <span className={`${styles.secondary} truncate text-xs text-text-secondary`}>
                  {task.board?.targetLabel || t('board.currentTarget')}
                </span>
                <span className={`${styles.secondary} text-xs text-text-muted`}>
                  {date ? (
                    <time dateTime={date.toISOString()}>
                      {new Intl.DateTimeFormat(i18n.language, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(date)}
                    </time>
                  ) : (
                    t('board.timeUnknown')
                  )}
                </span>
                <TaskBoardCounters work={task.board?.work} />
              </button>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 pr-2">
                {renderActions?.(task)}
                {control?.enabled && task.board?.work && (
                  <TaskBoardControl task={task} control={control} />
                )}
                {canOpen(task) && (
                  <button
                    type="button"
                    aria-label={`${t('board.openTask')}: ${task.title}`}
                    onClick={() => onOpen(task)}
                    className="inline-flex size-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </article>
          )
        })}
        {!visible.length && (
          <p className="px-5 py-12 text-center text-sm text-text-muted">
            {t(listingState === 'ready' ? 'board.emptyColumn' : 'board.syncNeeded')}
          </p>
        )}
      </div>
      <nav
        className="flex flex-wrap items-center justify-between gap-3"
        aria-label={t('board.pagination')}
        data-testid="task-board-pagination"
      >
        <p className="text-xs text-text-secondary" aria-live="polite">
          {t('board.pageSummary', { page, pages: pageCount, count: visible.length })}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            data-testid="task-board-page-previous"
            className="min-h-10 rounded-lg border border-border bg-background px-4 text-sm text-text-secondary max-md:min-h-11 hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('previous')}
          </button>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
            data-testid="task-board-page-next"
            className="min-h-10 rounded-lg border border-border bg-background px-4 text-sm text-text-secondary max-md:min-h-11 hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('next')}
          </button>
        </div>
      </nav>
    </section>
  )
}

const controlButtons = (phase: string): ReadonlyArray<WorkControlAction> => {
  if (phase === 'paused') return ['resume', 'stop']
  if (['pending', 'running', 'waiting_user', 'waiting_event'].includes(phase)) return ['pause', 'stop']
  return []
}

/**
 * Control is offered only for an observed work that the target agreed to
 * control. A receipt is displayed as-is; an unknown outcome blocks resubmission
 * and offers a re-read instead.
 */
function TaskBoardControl({
  task,
  control,
}: {
  task: TaskWorkspaceThreadChoice
  control: WorkControlApi
}) {
  const { t } = useTranslation('taskWorkspace')
  const work = task.board?.work
  if (!work) return null
  const receipt = control.receipt(work.workId)
  const presentation =
    receipt && receipt.state !== 'reconciled'
      ? workControlPresentation(receipt.state)
      : undefined
  const needsReview = presentation?.label === 'needsReview'
  const busy = receipt != null && ['accepted', 'settling', 'unknown'].includes(receipt.state)
  const workspacePath = task.workspacePath ?? ''
  return (
    <div data-testid="task-board-control" className="flex items-center gap-1">
      {controlButtons(work.phase).map(action => (
        <button
          key={action}
          type="button"
          disabled={busy || !workspacePath}
          data-testid={`task-board-control-${action}`}
          onClick={() =>
            void control.submit({
              workId: work.workId,
              threadId: work.threadId,
              workspacePath,
              revision: work.revision,
              action,
            })
          }
          className="min-h-8 rounded-md border border-border/60 bg-background px-2 text-xs text-text-secondary hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t(`board.workControl.${action}`)}
        </button>
      ))}
      {needsReview && (
        <button
          type="button"
          data-testid="task-board-control-recheck"
          onClick={() => void control.recheck({ workId: work.workId, workspacePath })}
          className="min-h-8 rounded-md border border-warning/40 bg-warning/10 px-2 text-xs text-warning focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t('board.workControl.recheck')}
        </button>
      )}
      {presentation && (
        <span
          role="status"
          data-testid="task-board-control-receipt"
          title={t(`board.workControl.${needsReview ? 'needsReviewHelp' : 'settledHelp'}`)}
          className="max-w-32 truncate text-xs text-text-muted"
        >
          {t(`board.workControl.${presentation.label}`)}
        </span>
      )}
    </div>
  )
}

/**
 * Durable batch counters are an observation, not progress evidence: they are
 * shown only when a stored value is non-zero, and an absent record stays blank.
 * An observed pending queue lists its real states; a record that only carries
 * the count keeps the bare counter, which never implies consumption.
 */
function TaskBoardCounters({ work }: { work?: ContinuousWorkView }) {
  const { t } = useTranslation('taskWorkspace')
  if (!work) return null
  const usage = work.usage
  // Older records omit individual counters; a missing value is not zero turns.
  const turns = usage?.automaticTurns ?? 0
  const failures = usage?.consecutiveFailures ?? 0
  const stalled = usage?.stalledRounds ?? 0
  const unconsumed = work.unconsumedInputs ?? 0
  // An omitted queue is unobserved, so only the stored count can be shown.
  const pending = work.pendingInputs ? pendingInputSegments(work.pendingInputs) : undefined
  const pendingCount = work.pendingInputs?.length ?? 0
  const hasUsage = usage != null && (turns > 0 || failures > 0 || stalled > 0)
  const hasPending = pendingCount > 0
  const hasCount = pending == null && unconsumed > 0
  if (!hasUsage && !hasPending && !hasCount) return null
  return (
    <span
      data-testid="task-board-work-counters"
      className={`${styles.secondary} flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-text-muted`}
    >
      {hasUsage && (
        <span className="truncate">
          {t('board.workUsage', { turns, failures, stalled })}
        </span>
      )}
      {hasCount && (
        <span className="truncate">{t('board.unconsumedInputs', { count: unconsumed })}</span>
      )}
      {hasPending && pending && (
        <span
          data-testid="task-board-pending-inputs"
          title={t('board.pendingInputsHelp')}
          className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5"
        >
          <span className="truncate">{t('board.pendingInputs', { count: pendingCount })}</span>
          {pending.map(segment => (
            <span
              key={segment.label}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${tones[segment.lane]}`}
            >
              <span>{t(`board.workInput.${segment.label}`)}</span>
              <span className="tabular-nums">{segment.count}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
