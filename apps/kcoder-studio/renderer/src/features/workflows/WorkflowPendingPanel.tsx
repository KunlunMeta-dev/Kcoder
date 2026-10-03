import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { WorkflowArguments } from './WorkflowArguments'
import { argumentFields, defaultArguments } from './workflowArguments'
import { workflowApi, type WorkflowPendingRequest } from './workflowApi'

export function WorkflowPendingPanel({ serverId, runId, isCurrent }: { serverId: string; runId: string; isCurrent: () => boolean }) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<WorkflowPendingRequest[]>([])
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await workflowApi.requests(serverId, runId)
        if (!active || !isCurrent()) return
        setItems(result.requests)
        setError('')
        if (result.supported) timer = setTimeout(() => void poll(), 1500)
      } catch (cause) {
        if (active && isCurrent()) {
          setError(cause instanceof Error ? cause.message : String(cause))
          timer = setTimeout(() => void poll(), 3000)
        }
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [serverId, runId, isCurrent, refresh])
  return <div className="max-h-[40vh] space-y-2 overflow-y-auto px-3" data-testid="workflow-pending-requests">
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    {items.map(item => <Pending key={item.requestId} item={item} serverId={serverId} isCurrent={isCurrent} onSent={() => setRefresh(value => value + 1)} />)}
    {items.length > 0 && <p className="text-xs text-text-muted">{t('workflowCanvas.pendingHint')}</p>}
  </div>
}
function Pending({ item, serverId, isCurrent, onSent }: { item: WorkflowPendingRequest; serverId: string; isCurrent: () => boolean; onSent: () => void }) {
  const { t } = useTranslation('common')
  const [value, setValue] = useState(() => defaultArguments(argumentFields(item.request.schema)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isTimer = item.request.kind === 'wait'
  return <div className="space-y-2 rounded-lg border border-border bg-background p-3" data-testid={`workflow-pending-${item.nodeId}`}>
    <p className="text-sm font-medium">{t(`workflowCanvas.kind_${item.request.kind}`)} · {item.nodeId}</p>
    <p className="whitespace-pre-wrap break-words text-sm">{item.request.prompt ?? item.request.name ?? t('workflowCanvas.waitUntil')}</p>
    <p className="text-xs text-text-muted">{new Date(item.deadlineUnixMs).toLocaleString()}</p>
    {!isTimer && <>
      <WorkflowArguments schema={item.request.schema} value={value} onChange={setValue} />
      <Button variant="outline" size="sm" className="max-md:min-h-11" disabled={busy} data-testid="workflow-submit-response" onClick={async () => {
        if (!isCurrent()) return
        setBusy(true); setError('')
        try {
          const response = JSON.parse(value)
          await workflowApi.respond(serverId, item.runId, item.requestId, response)
          if (isCurrent()) onSent()
        } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { if (isCurrent()) setBusy(false) }
      }}>{t(item.request.kind === 'human' ? 'workflowCanvas.submitResponse' : 'workflowCanvas.submitEvent')}</Button>
    </>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
  </div>
}
