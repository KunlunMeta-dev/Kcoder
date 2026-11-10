import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskDeliveryPanel } from '@/components/chat/TaskDeliveryPanel'
import { createTaskDeliveryDrafts, type TaskDeliveryDrafts } from './taskDeliveryDrafts'
import { invokeRuntimeCommand } from '@/kcoder/gatewayServiceBridge'
import type { TaskDeliveryOwner } from '@/kcoder/taskDelivery'
import type { TaskDeliveryRecipient } from '../../../../shared/generated/contracts'
import type { WorkbenchMessage } from '@/types/workbench'
import { TaskComparisonPanel } from './TaskComparisonPanel'
import {
  createTaskComparisonController,
  type ComparisonTask,
  type CreateComparisonTaskInput,
} from './controller'
import { TASK_COMPARISON_CAPABILITIES } from '@/kcoder/gatewayTaskComparison'

export interface TaskReviewOperationsContext {
  owner: TaskDeliveryOwner
  sourcePath: string
  deliveryDrafts?: TaskDeliveryDrafts
  deliveryResponseKey?: string
  availableTasks: ComparisonTask[]
  isCurrent: () => boolean
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  createTask?: (input: CreateComparisonTaskInput) => Promise<ComparisonTask>
  creationSummary?: string
  onOpenTask?: (task: ComparisonTask) => void
  onAddToTaskDraft?: (text: string, recipient: TaskDeliveryRecipient) => void
}
export function TaskReviewOperations(props: {
  context: TaskReviewOperationsContext
  message: WorkbenchMessage
  requirement: string
}) {
  return (
    <OwnedTaskReviewOperations
      key={JSON.stringify([props.context.owner.scope, props.message.turnId ?? props.message.id])}
      {...props}
    />
  )
}
function OwnedTaskReviewOperations({
  context,
  message,
  requirement,
}: {
  context: TaskReviewOperationsContext
  message: WorkbenchMessage
  requirement: string
}) {
  const { t } = useTranslation('taskComparison')
  const { t: td } = useTranslation('taskDelivery')
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<{
    comparison: boolean
    delivery: boolean
  } | null>(null)
  const [failed, setFailed] = useState(false)
  const [selection, setSelection] = useState<'unknown' | 'none' | 'selected'>('unknown')
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [localDrafts] = useState(createTaskDeliveryDrafts)
  const turn = message.turnId
  const comparisonId =
    typeof turn === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(turn) ? turn : context.owner.threadId
  const controller = useMemo(
    () =>
      createTaskComparisonController({
        scope: {
          deviceId: context.owner.deviceId,
          sourcePath: context.sourcePath,
          ownerThreadId: context.owner.threadId,
          comparisonId,
          requirement,
        },
        supported: capabilities?.comparison === true,
        request: context.request,
        isCurrent: context.isCurrent,
        createTask: context.createTask,
      }),
    [context, capabilities?.comparison, comparisonId, requirement]
  )
  useEffect(() => {
    if (!comparisonOpen && !deliveryOpen) return
    let active = true
    Promise.all([
      context.request(TASK_COMPARISON_CAPABILITIES, { deviceId: context.owner.deviceId }),
      invokeRuntimeCommand<{ supported: boolean }>('local_executor_request', {
        method: 'runtime.taskDelivery.request',
        params: {
          taskId: context.owner.taskId,
          threadId: context.owner.threadId,
          deviceId: context.owner.deviceId,
          method: 'capabilities',
        },
      }),
    ])
      .then(([comparison, delivery]) => {
        if (active && context.isCurrent()) {
          setCapabilities({
            comparison:
              !!comparison &&
              typeof comparison === 'object' &&
              'supported' in comparison &&
              comparison.supported === true,
            delivery: delivery.supported === true,
          })
          setFailed(false)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [context, comparisonOpen, deliveryOpen])
  useEffect(() => {
    if (!deliveryOpen || !capabilities?.comparison) return
    let active = true
    controller
      .read()
      .then(result => {
        if (active && context.isCurrent()) {
          setSelection(result.selectedThreadId ? 'selected' : 'none')
          const selected = result.candidates.find(candidate => candidate.binding.threadId === result.selectedThreadId)
          setSourceKey(selected ? JSON.stringify([selected.worktreeId, selected.path, selected.binding, selected.git?.headCommit, selected.git?.contentToken]) : 'original')
          setFailed(false)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [controller, context, deliveryOpen, capabilities?.comparison, selectionRevision])
  if (!requirement.trim() || (message.taskId && message.taskId !== context.owner.taskId))
    return null
  const summaryClass =
    'min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1'
  return (
    <div className="min-w-0 space-y-2" data-testid="task-review-operations">
      <details onToggle={event => setComparisonOpen(event.currentTarget.open)}>
        <summary className={summaryClass} data-testid="task-review-open-comparison">
          {t('title')}
        </summary>
        {comparisonOpen &&
          (failed ? (
            <p role="alert">{t('errors.request_failed')}</p>
          ) : capabilities ? (
            <TaskComparisonPanel
              controller={controller}
              availableTasks={context.availableTasks}
              creationSummary={context.creationSummary}
              onOpenTask={context.onOpenTask}
              onSelected={() => { setSelection('unknown'); setSourceKey(null); setSelectionRevision(value => value + 1) }}
            />
          ) : (
            <p role="status">{t('pending')}</p>
          ))}
      </details>
      <details onToggle={event => {
        if (event.currentTarget.open) { setSourceKey(null); setSelection('unknown') }
        setDeliveryOpen(event.currentTarget.open)
      }}>
        <summary className={summaryClass} data-testid="task-review-open-delivery">
          {td('title')}
        </summary>
        {deliveryOpen &&
          (failed ? (
            <p role="alert">{t('errors.request_failed')}</p>
          ) : !capabilities || (capabilities.comparison && (selection === 'unknown' || sourceKey === null)) ? (
            <p role="status">{t('pending')}</p>
          ) : (
            <TaskDeliveryPanel
              owner={context.owner}
              supported={capabilities.delivery}
              originalTaskAvailable
              isActive={context.isCurrent}
              draftSlot={(context.deliveryDrafts ?? localDrafts).slot(JSON.stringify([
                context.owner.scope, context.owner.taskId, context.owner.threadId, context.owner.deviceId,
                context.deliveryResponseKey ?? [message.id, message.turnId, message.attemptId],
                selection === 'selected' ? comparisonId : null, sourceKey ?? 'original',
              ]))}
              comparisonId={selection === 'selected' ? comparisonId : undefined}
              onAddToDraft={
                context.onAddToTaskDraft
                  ? (text, recipient) => {
                      if (!context.isCurrent()) throw new Error(t('errors.scope_changed'))
                      context.onAddToTaskDraft?.(text, recipient)
                    }
                  : undefined
              }
            />
          ))}
      </details>
    </div>
  )
}
