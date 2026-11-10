import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleAlert, GraduationCap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { ExpertTarget } from './ExpertTarget'
import { ExpertTaskDialog } from './ExpertTaskDialog'
import { taskAgentBinding } from './taskAgentBinding'
import { useTaskExpert } from './useTaskExpert'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeThreadId } from '@/lib/runtime-thread-id'

export function TaskExpertControl({
  address,
  deviceId,
  workspacePath,
}: {
  address?: RuntimeTaskAddress | null
  deviceId?: string | null
  workspacePath?: string
}) {
  const { t } = useTranslation('experts')
  const { state, selectDraftExpert } = useWorkbench()
  const currentTask = address === undefined ? state.currentRuntimeTask : address
  const expert = useTaskExpert(currentTask)
  const binding = expert.snapshot ? expert.snapshot.expert : taskAgentBinding(currentTask)
  const targets = useRuntimeSettingsTargets()
  const target = targets.targets.find(item => item.id === deviceId)
  const path = workspacePath ?? target?.workspacePath
  const scope = usePluginTargetScope(deviceId ?? undefined, path)
  const [open, setOpen] = useState(false)
  const [readError, setReadError] = useState<{
    taskKey: string
    snapshot: typeof expert.snapshot
  }>()
  const [retrying, setRetrying] = useState(false)
  const [revision, setRevision] = useState(0)
  const errorId = useId()
  const unavailable = Boolean(currentTask && expert.error)
  const taskKey = JSON.stringify([currentTask?.deviceId, currentTask?.taskId,
    runtimeThreadId(currentTask), currentTask?.workspacePath])
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
  const label = binding
    ? t('task.selected', { name: binding.title, version: binding.definition.version })
    : draft
      ? t('task.selected', { name: draft.title, version: draft.reference.version })
      : t('task.selectorLabel')
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
        <span className="max-w-36 truncate text-sm text-text-secondary">{label}</span>
        {unavailable && <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />}
        <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
      </Button>
      {unavailable && <span id={errorId} className="sr-only" role="status">{t('task.switchUnavailable')}</span>}
      {currentTask && expert.snapshot && <span className="sr-only" role="status">{t('task.nextTurnHint')}</span>}
      {errorOpen && createPortal(
        <ModalDialog title={t('task.selectorLabel')} testId="expert-task-read-error"
          onClose={() => setReadError(undefined)} closeLabel={t('close')}>
          <p className="mt-4 text-sm text-text-secondary" role="alert">{t('task.switchUnavailable')}</p>
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
        createPortal(
          <ExpertTarget
            key={`${scope.key}:${revision}`}
            serverId={deviceId}
            workspacePath={path}
            isCurrent={scope.isCurrent}
            onReconnect={() => setRevision(value => value + 1)}
            renderFallback={content => (
              <ModalDialog
                title={t('task.selectorLabel')}
                testId="expert-task-target-status"
                onClose={() => setOpen(false)}
                closeLabel={t('close')}
              >
                {content}
              </ModalDialog>
            )}
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
          </ExpertTarget>,
          document.body
        )}
      {open && !deviceId && (
        <ModalDialog
          title={t('task.selectorLabel')}
          testId="expert-task-unavailable"
          onClose={() => setOpen(false)}
        >
          <p>{t('unavailable')}</p>
        </ModalDialog>
      )}
    </div>
  )
}
