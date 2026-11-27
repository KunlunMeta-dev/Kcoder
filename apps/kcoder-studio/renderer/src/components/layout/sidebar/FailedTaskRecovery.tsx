import { useState } from 'react'
import type { RecoverRuntimeTask } from '@/features/workbench/workbenchContextTypes'
import { useTranslation } from '@/hooks/useTranslation'
import { sessionHistoryErrorMessage } from '@/kcoder/sessionHistoryError'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import type {
  RuntimeTaskAddress,
  RuntimeTaskCreationReadResponse,
  RuntimeTaskSummary,
} from '@/types/api'

export function FailedTaskRecovery({
  task,
  address,
  available,
  deviceStatus,
  onRecover,
  onNavigate,
  className,
}: {
  task: RuntimeTaskSummary
  address: RuntimeTaskAddress
  available: boolean
  deviceStatus?: string | null
  onRecover?: RecoverRuntimeTask
  onNavigate?: () => void
  className?: string
}) {
  const { t } = useTranslation('common')
  const owner = JSON.stringify([
    address.deviceId,
    address.workspacePath,
    task.taskId,
    task.updatedAt,
    task.creationRequest?.clientRequestId,
    task.creationRequest?.clientMessageId,
    task.creationRequest?.outcome,
  ])
  const [recovery, setRecovery] = useState<{
    owner: string
    pending: boolean
    result?: RuntimeTaskCreationReadResponse
    error?: string
  }>()
  const current = recovery?.owner === owner ? recovery : undefined
  const rejected = task.creationRequest?.outcome === 'rejected'
  const recover = async (open = false) => {
    if (!onRecover || current?.pending) return
    setRecovery({ owner, pending: true })
    try {
      const result = await onRecover(address, open)
      setRecovery(previous =>
        previous?.owner === owner ? { owner, pending: false, result } : previous
      )
      if (open && result.status === 'ready') onNavigate?.()
    } catch (error) {
      setRecovery(previous =>
        previous?.owner === owner
          ? { owner, pending: false, error: error instanceof Error ? error.message : String(error) }
          : previous
      )
    }
  }
  const result = current?.result
  const timestamp = task.creationRequest?.failedAt ?? task.updatedAt ?? task.createdAt
  const date = timestamp == null ? null : new Date(timestamp)
  const health =
    deviceStatus === 'online' && !available
      ? 'online_workspace_unavailable'
      : deviceStatus === 'online' || deviceStatus === 'busy' || deviceStatus === 'offline'
        ? deviceStatus
        : 'unknown'
  const buttonClass =
    'min-h-11 rounded px-2 py-1 font-medium text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-8'
  return (
    <div
      role="alert"
      data-testid={`runtime-task-creation-error-${task.taskId}`}
      className={cn('space-y-1 break-words py-1 text-xs text-text-secondary', className)}
    >
      <p>{t(rejected ? 'workbench.failed_task_rejected' : 'workbench.failed_task_check')}</p>
      {date && Number.isFinite(date.getTime()) && (
        <time dateTime={date.toISOString()}>
          {t(
            task.creationRequest?.failedAt
              ? 'workbench.failed_task_failed_at'
              : 'workbench.failed_task_recorded',
            { time: date.toLocaleString() }
          )}
        </time>
      )}
      <p data-testid="failed-task-target-health">{t(`workbench.failed_task_health_${health}`)}</p>
      <div className="flex flex-wrap gap-1">
        {onRecover && !rejected && (
          <button
            type="button"
            className={buttonClass}
            disabled={!available || current?.pending}
            onClick={() => {
              void recover()
            }}
          >
            {t(current?.pending ? 'workbench.failed_task_querying' : 'workbench.failed_task_query')}
          </button>
        )}
        {result?.status === 'ready' && (
          <button
            type="button"
            className={buttonClass}
            disabled={!available || current?.pending}
            onClick={() => {
              void recover(true)
            }}
          >
            {t('workbench.failed_task_open_original')}
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            navigateTo('/settings/connections')
            onNavigate?.()
          }}
        >
          {t('workbench.failed_task_connection')}
        </button>
      </div>
      {result && (
        <p>
          {t(
            result.status === 'ready'
              ? result.initialMessage.status === 'unknown'
                ? 'workbench.failed_task_message_unknown'
                : 'workbench.failed_task_found'
              : result.status === 'unavailable'
                ? 'workbench.failed_task_query_unavailable'
                : 'workbench.failed_task_outcome_unknown'
          )}
        </p>
      )}
      {current?.error && <p>{t('workbench.failed_task_query_failed')}</p>}
      <details>
        <summary className="cursor-pointer">{t('workbench.failed_task_details')}</summary>
        <p className="mt-1 max-h-40 overflow-auto text-red-500">
          {sessionHistoryErrorMessage(current?.error ?? task.error ?? '')}
        </p>
      </details>
    </div>
  )
}
