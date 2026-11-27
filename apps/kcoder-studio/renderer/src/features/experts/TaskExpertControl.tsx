import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleAlert, GraduationCap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { ExpertTarget } from './ExpertTarget'
import { ExpertTaskDialog } from './ExpertTaskDialog'
import { taskAgentBinding } from './taskAgentBinding'
import { useTaskExpert } from './useTaskExpert'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'

/**
 * A task that has no original runtime thread yet (optimistic creation or a
 * failed creation draft) or a read-only legacy channel task has no readable
 * expert configuration; its known binding is shown without a failing read.
 */
function expertReadable(state: ReturnType<typeof useWorkbench>['state'], task: RuntimeTaskAddress | null | undefined) {
  if (!task) return false
  if (taskAgentBinding(task)?.source === 'channel' || task.runtimeHandle?.channelTaskSource) return false
  const summary = findRuntimeTask(state.runtimeWork, task)
  return !(summary?.status === 'creating' || (summary?.optimistic === true && summary.status === 'failed'))
}

interface TaskExpertControlProps {
  address?: RuntimeTaskAddress | null
  deviceId?: string | null
  workspacePath?: string
}

export function TaskExpertControl({ address, deviceId, workspacePath }: TaskExpertControlProps) {
  const workbench = useWorkbench()
  const currentTask = address === undefined ? workbench.state.currentRuntimeTask : address
  const targetDeviceId = currentTask?.deviceId ?? deviceId
  const targetWorkspacePath = currentTask?.workspacePath || (deviceId === targetDeviceId ? workspacePath : undefined)
  const key = JSON.stringify([targetDeviceId, targetWorkspacePath, currentTask
    ? [currentTask.deviceId, currentTask.taskId, runtimeThreadId(currentTask), currentTask.workspacePath]
    : [workbench.state.currentProject?.id, workbench.state.standaloneChatKey]])
  return <TaskExpertControlView key={key} currentTask={currentTask} deviceId={targetDeviceId}
    workspacePath={targetWorkspacePath} workbench={workbench} />
}

function TaskExpertControlView({ currentTask, deviceId, workspacePath, workbench }: {
  currentTask: RuntimeTaskAddress | null
  deviceId?: string | null
  workspacePath?: string
  workbench: ReturnType<typeof useWorkbench>
}) {
  const { t } = useTranslation('experts')
  const { state, selectDraftExpert, updateRuntimeTaskExpertBinding } = workbench
  const expert = useTaskExpert(expertReadable(state, currentTask) ? currentTask : null)
  const binding = expert.error
    ? null
    : expert.snapshot
      ? expert.snapshot.expert ?? null
      : taskAgentBinding(currentTask)
  const [open, setOpen] = useState(false)
  const targets = useRuntimeSettingsTargets({ enabled: open || workspacePath === undefined })
  const target = targets.targets.find(item => item.id === deviceId)
  const path = workspacePath ?? target?.workspacePath
  const scope = usePluginTargetScope(open ? target?.id : undefined, path, target)
  const [readError, setReadError] = useState<{
    taskKey: string
    snapshot: typeof expert.snapshot
  }>()
  const [retrying, setRetrying] = useState(false)
  const [revision, setRevision] = useState(0)
  const errorId = useId()
  const unavailable = Boolean(currentTask && expert.error)
  // The generic headline stays; a known cause is added so a report is diagnosable.
  const failureReason = unavailable && expert.errorReason && expert.errorReason !== 'unknown'
    ? t(`task.readFailure.${expert.errorReason}`)
    : ''
  const taskKey = JSON.stringify([currentTask?.deviceId, currentTask?.taskId,
    runtimeThreadId(currentTask), currentTask?.workspacePath])
  useEffect(() => {
    if (currentTask && expert.snapshot)
      updateRuntimeTaskExpertBinding(currentTask, expert.snapshot.expert ?? null)
  }, [currentTask, expert.snapshot, updateRuntimeTaskExpertBinding])
  // A successful read replaces its snapshot even when the selection revision is unchanged.
  const errorOpen = Boolean(currentTask && readError?.taskKey === taskKey &&
    (unavailable || readError.snapshot === expert.snapshot))
  const openReadError = () => setReadError({ taskKey, snapshot: expert.snapshot })
  const draft =
    state.expertDraft &&
    !currentTask &&
    (state.expertDraft?.projectId ?? null) === (state.currentProject?.id ?? null) &&
    state.expertDraft?.draftKey === state.standaloneChatKey &&
    state.expertDraft.deviceId === deviceId &&
    state.expertDraft.workspacePath === path
      ? state.expertDraft
      : null
  const label = expert.error
    ? t('task.switchUnavailable')
    : binding
    ? t('task.selected', { name: binding.title, version: binding.definition.version })
    : draft
      ? t('task.selected', { name: draft.title, version: draft.reference.version })
      : t('task.selectorLabel')
  const targetStatus = (content: ReactNode) => (
    <ModalDialog title={t('task.selectorLabel')} testId="expert-task-target-status"
      onClose={() => setOpen(false)} closeLabel={t('close')}>
      {content}
    </ModalDialog>
  )
  return (
    <div
      className="relative flex min-w-0 max-w-full items-center gap-1"
      data-testid="task-expert-control"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 min-w-0 max-w-full px-2 font-normal disabled:opacity-100"
        data-composer-action
        aria-haspopup="dialog"
        aria-pressed={Boolean(binding || draft)}
        aria-label={label}
        aria-expanded={open || errorOpen}
        aria-describedby={unavailable ? errorId : undefined}
        title={unavailable ? `${label}\n${t('task.switchUnavailable')}` : label}
        disabled={!deviceId || !path || (currentTask ? expert.busy || (!expert.snapshot && !unavailable) : !selectDraftExpert)}
        onClick={async () => {
          if (unavailable) { openReadError(); return }
          if (currentTask) { try { await expert.refresh() } catch { openReadError(); return } }
          setOpen(true)
        }}
      >
        <GraduationCap className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span data-composer-label className="max-w-36 truncate text-sm text-text-secondary">{label}</span>
        {unavailable && <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />}
        <ChevronDown data-composer-label className="size-4 shrink-0" aria-hidden="true" />
      </Button>
      {unavailable && <span id={errorId} className="sr-only" role="status">{t('task.switchUnavailable')}</span>}
      {currentTask && expert.snapshot && <span className="sr-only" role="status">{t('task.nextTurnHint')}</span>}
      {errorOpen && createPortal(
        <ModalDialog title={t('task.selectorLabel')} testId="expert-task-read-error"
          onClose={() => setReadError(undefined)} closeLabel={t('close')}>
          <p className="mt-4 text-sm text-text-secondary" role="alert">{t('task.switchUnavailable')}</p>
          {failureReason && <p className="mt-2 text-sm text-text-muted" data-testid="expert-task-read-error-reason">
            {failureReason}</p>}
          {unavailable && expert.errorCode && <details className="mt-2 text-sm text-text-muted">
            <summary>{t('task.readFailure.details')}</summary>
            <code className="mt-1 block select-all break-all" data-testid="expert-task-read-error-code">
              {expert.errorCode}</code>
          </details>}
          <Button type="button" variant="secondary" className="mt-4" disabled={retrying || expert.busy}
            onClick={async () => {
              setRetrying(true)
              try {
                await expert.refresh()
                if (scope.isCurrent()) { setReadError(undefined); setOpen(true) }
              } catch { /* Keep the failed read visible; retry never changes the expert. */ }
              finally { setRetrying(false) }
            }}>{t('task.retryRead')}</Button>
        </ModalDialog>, document.body
      )}
      {open &&
        deviceId &&
        createPortal(target ?
          <ExpertTarget
            key={`${scope.key}:${revision}`}
            serverId={deviceId}
            workspacePath={path}
            targetScope={hookTargetScope(target)}
            isCurrent={scope.isCurrent}
            onReconnect={() => setRevision(value => value + 1)}
            renderFallback={targetStatus}
          >
            {client => (
              <ExpertTaskDialog
                client={client}
                onClose={() => setOpen(false)}
                nextTurn={Boolean(currentTask)}
                onClear={async () => {
                  if (currentTask) await expert.select(null)
                  else selectDraftExpert?.(null, {
                    draftKey: state.standaloneChatKey,
                    projectId: state.currentProject?.id ?? null,
                  })
                }}
                onSelect={selected => currentTask ? expert.select(selected.reference) :
                  selectDraftExpert?.(selected, {
                    draftKey: state.standaloneChatKey,
                    projectId: state.currentProject?.id ?? null,
                  })
                }
              />
            )}
          </ExpertTarget> : targetStatus(<>
            <p role={targets.loading ? 'status' : 'alert'}>{t(targets.loading ? 'loading' : 'unavailable')}</p>
            {!targets.loading && <Button type="button" variant="secondary" onClick={() => void targets.refresh()}>
              {t('task.retryRead')}
            </Button>}
          </>),
          document.body
        )}

    </div>
  )
}
