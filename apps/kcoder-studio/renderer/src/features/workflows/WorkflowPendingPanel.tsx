import { startWorkflowPolling } from './workflowPolling'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { WorkflowArguments } from './WorkflowArguments'
import { argumentFields, defaultArguments } from './workflowInputArguments'
import { workflowApi, type WorkflowPendingRequest } from './workflowApi'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'

export function WorkflowPendingPanel({
  serverId,
  workspacePath,
  runId,
  isCurrent,
  disabled = false,
  active = true,
  readOnly = false,
}: {
  serverId: string
  workspacePath?: string
  runId: string
  isCurrent: () => boolean
  disabled?: boolean
  active?: boolean
  readOnly?: boolean
}) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<WorkflowPendingRequest[]>([])
  const [error, setError] = useState('')
  const [observed, setObserved] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const pageActive = useRetainedPageActive()
  useEffect(
    () =>
      startWorkflowPolling({
        active: active && pageActive,
        isCurrent,
        changes: { serverId, runId },
        poll: async (isLive, signal) => {
          const result = await workflowApi.requests(serverId, runId, { signal, workspacePath })
          if (!isLive()) return false
          if (readOnly && result.requests.some(item => item.runId !== runId))
            throw new Error(t('workflowFlow.runMismatch'))
          setItems(readOnly && result.supported !== true ? [] : result.requests)
          setObserved(result.supported === true)
          setError('')
          return result.supported ? 1500 : false
        },
        onError: cause => { if (readOnly) { setItems([]); setObserved(false) }; setError(cause instanceof Error ? cause.message : String(cause)) },
      }),
    [pageActive, serverId, workspacePath, runId, isCurrent, refresh, active, readOnly, t]
  )
  return (
    <div
      className="max-h-[40vh] space-y-2 overflow-y-auto px-3"
      data-testid="workflow-pending-requests"
    >
      {error && (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {readOnly && !items.length && (
        <p role="status" className="text-sm text-text-secondary">
          {t(observed && !error ? 'taskWorkspace:noInteractions' : 'taskWorkspace:interactionsUnknown')}
        </p>
      )}
      {items.map(item => (
        <Pending
          key={item.requestId}
          item={item}
          disabled={disabled || !!error}
          readOnly={readOnly}
          serverId={serverId}
          workspacePath={workspacePath}
          isCurrent={isCurrent}
          onSent={() => setRefresh(value => value + 1)}
        />
      ))}
      {items.length > 0 && (
        <p className="text-xs text-text-muted">{t('workflowCanvas.pendingHint')}</p>
      )}
    </div>
  )
}
function Pending({
  item,
  serverId,
  workspacePath,
  isCurrent,
  onSent,
  disabled,
  readOnly,
}: {
  item: WorkflowPendingRequest
  serverId: string
  workspacePath?: string
  isCurrent: () => boolean
  onSent: () => void
  disabled: boolean
  readOnly: boolean
}) {
  const { t } = useTranslation('common')
  const [value, setValue] = useState(() => defaultArguments(argumentFields(item.request.schema)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isTimer = item.request.kind === 'wait'
  return (
    <div
      className="studio-card-spacing space-y-2 rounded-lg border border-border bg-background"
      data-testid={`workflow-pending-${item.nodeId}`}
    >
      <p className="text-sm font-medium">
        {t(`workflowCanvas.kind_${item.request.kind}`)} · {item.nodeId}
      </p>
      <p className="whitespace-pre-wrap break-words text-sm">
        {item.request.prompt ?? item.request.name ?? t('workflowCanvas.waitUntil')}
      </p>
      <p className="text-xs text-text-muted">{new Date(item.deadlineUnixMs).toLocaleString()}</p>
      {readOnly && <p className="text-xs text-text-secondary">{t('taskWorkspace:status')} · {item.status}</p>}
      {!isTimer && !readOnly && (
        <>
          <WorkflowArguments schema={item.request.schema} value={value} onChange={setValue} />
          <Button
            variant="outline"
            size="sm"
            className="max-md:min-h-11"
            disabled={busy || disabled}
            data-testid="workflow-submit-response"
            onClick={async () => {
              if (readOnly || disabled || !isCurrent()) return
              setBusy(true)
              setError('')
              try {
                const response = JSON.parse(value)
                if (workspacePath !== undefined) await workflowApi.respond(serverId, item.runId, item.requestId, response, { workspacePath })
                else await workflowApi.respond(serverId, item.runId, item.requestId, response)
                if (isCurrent()) onSent()
              } catch (cause) {
                if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                if (isCurrent()) setBusy(false)
              }
            }}
          >
            {t(
              item.request.kind === 'human'
                ? 'workflowCanvas.submitResponse'
                : 'workflowCanvas.submitEvent'
            )}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
