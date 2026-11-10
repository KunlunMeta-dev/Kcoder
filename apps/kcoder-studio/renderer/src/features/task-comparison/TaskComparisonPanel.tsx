import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  TaskComparisonCandidate,
  TaskComparisonReadResult,
} from '../../../../shared/generated/contracts'
import {
  TaskComparisonError,
  taskComparisonScopeKey,
  type ComparisonTask,
  type TaskComparisonController,
} from './controller'

export interface TaskComparisonPanelProps {
  controller: TaskComparisonController
  availableTasks?: ComparisonTask[]
  creationSummary?: string
  onOpenTask?: (task: ComparisonTask) => void
  onSelected?: (candidate: TaskComparisonCandidate) => void
}
const controlClass =
  'min-h-11 w-full rounded-lg border border-text-primary/10 bg-background px-3 py-2 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8'
function recipient(candidate: TaskComparisonCandidate): ComparisonTask {
  return {
    deviceId: candidate.binding.deviceId,
    taskId: candidate.binding.taskId,
    threadId: candidate.binding.threadId,
    workspacePath: candidate.path,
    title: candidate.binding.label,
  }
}

export function TaskComparisonPanel(props: TaskComparisonPanelProps) {
  return <TaskComparisonSession key={taskComparisonScopeKey(props.controller.scope)} {...props} />
}
function TaskComparisonSession({
  controller,
  availableTasks = [],
  creationSummary,
  onOpenTask,
  onSelected,
}: TaskComparisonPanelProps) {
  const { t } = useTranslation('taskComparison')
  const [result, setResult] = useState<TaskComparisonReadResult | null>(null)
  const [pending, setPending] = useState(controller.supported)
  const [error, setError] = useState<unknown>(null)
  const [label, setLabel] = useState('')
  const [branch, setBranch] = useState('')
  const [prompt, setPrompt] = useState('')
  const [linkedTask, setLinkedTask] = useState('')
  const live = useRef(true)
  const latest = useRef(controller)
  const run = async (
    operation: () => Promise<TaskComparisonReadResult>,
    selectedThread?: string
  ) => {
    const owner = controller
    setPending(true)
    setError(null)
    try {
      const next = await operation()
      if (!live.current || latest.current !== owner) return
      setResult(next)
      if (selectedThread) {
        const chosen = next.candidates.find(
          candidate => candidate.binding.threadId === selectedThread
        )
        if (chosen && next.selectedThreadId === selectedThread) onSelected?.(chosen)
      }
    } catch (failure) {
      if (live.current && latest.current === owner) setError(failure)
    } finally {
      if (live.current && latest.current === owner) setPending(false)
    }
  }
  useEffect(() => {
    latest.current = controller
    live.current = true
    let active = true
    if (controller.supported) {
      controller
        .read()
        .then(value => {
          if (active) {
            setResult(value)
            setError(null)
          }
        })
        .catch(failure => {
          if (active) setError(failure)
        })
        .finally(() => {
          if (active) setPending(false)
        })
    }
    return () => {
      active = false
      live.current = false
    }
  }, [controller])
  const tasks = availableTasks.filter(
    task =>
      task.deviceId === controller.scope.deviceId &&
      task.threadId !== controller.scope.ownerThreadId &&
      !result?.candidates.some(c => c.binding.threadId === task.threadId)
  )
  const errorCode = error instanceof TaskComparisonError ? error.code : 'request_failed'
  return (
    <section
      className="min-w-0 space-y-3 text-sm text-text-secondary"
      aria-label={t('title')}
      data-testid="task-comparison-panel"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-text-primary">{t('title')}</h3>
        {controller.supported && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-8"
            data-testid="task-comparison-refresh"
            disabled={pending}
            onClick={() => void run(() => controller.read())}
          >
            {t('refresh')}
          </Button>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words">{controller.scope.requirement}</p>
      {!controller.supported ? (
        <p role="status" data-testid="task-comparison-unsupported">
          {t('unsupported')}
        </p>
      ) : (
        <>
          {pending && <p role="status">{t('pending')}</p>}
          {error != null && (
            <div role="alert" data-testid="task-comparison-error">
              <p>{t(`errors.${errorCode}`)}</p>
              {error instanceof Error && !(error instanceof TaskComparisonError) && (
                <details>
                  <summary
                    className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1"
                    data-testid="task-comparison-error-details"
                  >
                    {t('details')}
                  </summary>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {error.message}
                  </pre>
                </details>
              )}
            </div>
          )}
          {result && result.candidates.length === 0 && <p>{t('empty')}</p>}
          {result && (
            <ul
              className="grid min-w-0 gap-4 xl:grid-cols-2"
              data-testid="task-comparison-candidates"
            >
              {result.candidates.map(candidate => (
                <li
                  key={candidate.worktreeId}
                  className="min-w-0 space-y-2 border-b border-text-primary/10 pb-4"
                  data-testid="task-comparison-candidate"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-text-primary">{candidate.binding.label}</span>
                    {result.selectedThreadId === candidate.binding.threadId && (
                      <span role="status" data-testid="task-comparison-selected">
                        {t('selected')}
                      </span>
                    )}
                  </div>
                  <p className="break-all text-xs">
                    {candidate.binding.deviceId} · {candidate.binding.branch}
                  </p>
                  <p className="break-all text-xs">{candidate.path}</p>
                  {onOpenTask && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      data-testid="task-comparison-open-task"
                      onClick={() => onOpenTask(recipient(candidate))}
                    >
                      {t('openTask')}
                    </Button>
                  )}
                  <p>{t('result')}</p>
                  {candidate.resultPreview ? (
                    <p
                      className="max-h-48 overflow-auto whitespace-pre-wrap break-words"
                      data-testid="task-comparison-result"
                    >
                      {candidate.resultPreview}
                    </p>
                  ) : (
                    <p>{t('unknownResult')}</p>
                  )}
                  <p>{t('checks')}</p>
                  {candidate.checks.length === 0 && (
                    <p data-testid="task-comparison-checks-unknown">{t('unknownChecks')}</p>
                  )}
                  {candidate.evidencePartial && (
                    <p className="text-xs text-text-muted">{t('partialEvidence')}</p>
                  )}
                  <ul className="min-w-0 space-y-2">
                    {candidate.checks.map(check => (
                      <li className="min-w-0" key={`${check.evidenceId}:${check.ordinal}`}>
                        <span data-testid="task-comparison-check-outcome">
                          {t(`outcomes.${check.outcome}`)}
                        </span>
                        {check.command && (
                          <code className="block truncate text-xs" title={check.command}>
                            {check.command}
                          </code>
                        )}
                        <details>
                          <summary
                            className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1"
                            data-testid="task-comparison-check-details"
                          >
                            {t('checkDetails')}
                          </summary>
                          <p className="break-all text-xs">
                            {t('checkIdentity', {
                              turn: check.turnId,
                              attempt: check.attemptId,
                              ordinal: check.ordinal,
                            })}
                          </p>
                          <p className="break-all text-xs">
                            {check.cwd ?? t('unknown')} ·{' '}
                            {check.exitCode == null
                              ? t('unknown')
                              : t('exitCode', { code: check.exitCode })}
                          </p>
                          {check.outputPreview && (
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                              {check.outputPreview}
                            </pre>
                          )}
                          {check.detailsTruncated && <p>{t('truncated')}</p>}
                        </details>
                      </li>
                    ))}
                  </ul>
                  <p data-testid="task-comparison-usage">
                    {candidate.usage.inputTokens == null || candidate.usage.outputTokens == null
                      ? t('unknownUsage')
                      : t('usage', {
                          input: candidate.usage.inputTokens,
                          output: candidate.usage.outputTokens,
                          samples: candidate.usage.usageSamples,
                          messages: candidate.usage.assistantMessages,
                        })}
                  </p>
                  <p data-testid="task-comparison-cost">
                    {candidate.usage.costMicrousd == null
                      ? t('unknownCost')
                      : t('cost', { value: (candidate.usage.costMicrousd / 1_000_000).toFixed(6) })}
                  </p>
                  <details>
                    <summary
                      className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1"
                      data-testid="task-comparison-diff"
                    >
                      {t('changes')}
                    </summary>
                    <p className="break-all text-xs">
                      {t('base', { commit: candidate.binding.baseCommit })}
                    </p>
                    <p className="break-all text-xs">
                      {t('head', { commit: candidate.git?.headCommit ?? t('unknown') })}
                    </p>
                    <p className="text-xs text-text-muted">{t('diffScope')}</p>
                    {candidate.git ? (
                      <>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">
                          {candidate.git.diffPreview || t('emptyDiff')}
                        </pre>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                          {candidate.git.statusPreview}
                        </pre>
                        {candidate.git.truncated && <p>{t('truncated')}</p>}
                      </>
                    ) : (
                      <p>{t('unknownChanges')}</p>
                    )}
                    {candidate.artifacts.map(artifact => (
                      <p className="break-all text-xs" key={`${artifact.path}:${artifact.sha256}`}>
                        {artifact.path} · SHA-256 {artifact.sha256}
                      </p>
                    ))}
                  </details>
                  {candidate.unavailable.map(reason => (
                    <p role="status" className="text-xs" key={reason}>
                      {t(`unavailable.${reason}`, { defaultValue: t('unknown') })}
                    </p>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    data-testid="task-comparison-select"
                    disabled={
                      pending ||
                      result.candidates.length < 2 ||
                      !candidate.git ||
                      candidate.git.branch !== candidate.binding.branch ||
                      candidate.unavailable.includes('transcript_unavailable')
                    }
                    onClick={() =>
                      void run(() => controller.select(candidate), candidate.binding.threadId)
                    }
                  >
                    {t('select')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-text-muted">{t('selectionScope')}</p>
          <details>
            <summary
              className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1"
              data-testid="task-comparison-add"
            >
              {t('add')}
            </summary>
            <div className="min-w-0 space-y-3 pt-2">
              <label className="block space-y-1">
                <span>{t('label')}</span>
                <input
                  data-testid="task-comparison-label"
                  className={controlClass}
                  maxLength={128}
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  disabled={pending}
                />
              </label>
              {tasks.length > 0 && (
                <div className="space-y-2">
                  <label className="block space-y-1">
                    <span>{t('existingTask')}</span>
                    <SettingsSelect
                      data-testid="task-comparison-existing-task"
                      className={controlClass}
                      value={linkedTask}
                      onChange={e => setLinkedTask(e.target.value)}
                      disabled={pending}
                    >
                      <option value="">{t('chooseTask')}</option>
                      {tasks.map(task => (
                        <option key={task.taskId} value={task.taskId}>
                          {task.title} · {task.workspacePath}
                        </option>
                      ))}
                    </SettingsSelect>
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    data-testid="task-comparison-link"
                    disabled={pending || !label.trim() || !linkedTask}
                    onClick={() => {
                      const task = tasks.find(item => item.taskId === linkedTask)
                      if (task) void run(() => controller.link(task, label.trim()))
                    }}
                  >
                    {t('link')}
                  </Button>
                </div>
              )}
              {controller.canCreate && creationSummary && (
                <div className="space-y-2">
                  <p>{creationSummary}</p>
                  <label className="block space-y-1">
                    <span>{t('branch')}</span>
                    <input
                      data-testid="task-comparison-branch"
                      className={controlClass}
                      maxLength={1024}
                      value={branch}
                      onChange={e => setBranch(e.target.value)}
                      disabled={pending}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span>{t('approach')}</span>
                    <textarea
                      data-testid="task-comparison-approach"
                      className={controlClass}
                      rows={3}
                      value={prompt}
                      onChange={e => setPrompt(e.target.value)}
                      disabled={pending}
                    />
                  </label>
                  <p className="text-xs text-text-muted">{t('createScope')}</p>
                  <Button
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    data-testid="task-comparison-create"
                    disabled={
                      pending ||
                      !result ||
                      result.candidates.length >= 8 ||
                      !label.trim() ||
                      !branch.trim()
                    }
                    onClick={() =>
                      void run(() =>
                        controller.create({ label: label.trim(), branch: branch.trim(), prompt })
                      )
                    }
                  >
                    {t('create')}
                  </Button>
                </div>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  )
}
