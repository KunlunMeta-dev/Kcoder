import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { workflowApi, type WorkflowRun } from './workflowApi'

export function WorkflowRunPanel({
  serverId,
  definitionId,
  onSnapshot,
}: {
  serverId: string
  definitionId: string
  onSnapshot?: (run: WorkflowRun | null) => void
}) {
  const scope = usePluginTargetScope(serverId)
  return (
    <RunPanel
      key={`${scope.key}:${definitionId}`}
      serverId={serverId}
      definitionId={definitionId}
      isCurrent={scope.isCurrent}
      onSnapshot={onSnapshot}
    />
  )
}
function RunPanel({
  serverId,
  definitionId,
  isCurrent,
  onSnapshot,
}: {
  serverId: string
  definitionId: string
  isCurrent: () => boolean
  onSnapshot?: (run: WorkflowRun | null) => void
}) {
  const { t } = useTranslation('common')
  const outputRevision = useRef(0)
  const latest = useRef<WorkflowRun | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const [selected, setSelected] = useState('')
  const [offset, setOffset] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [output, setOutput] = useState<{
    nodeId: string
    text: string
    next: number | null
  } | null>(null)
  useEffect(() => {
    let stopped = false,
      inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const page = await workflowApi.runs(serverId, definitionId, offset)
        const id = selected || page.items[0]?.runId
        const detail = id ? await workflowApi.run(serverId, id) : null
        if (stopped || !isCurrent()) return
        if (
          !latest.current ||
          !detail ||
          latest.current.runId !== detail.runId ||
          detail.revision >= latest.current.revision
        )
          latest.current = detail
        onSnapshot?.(latest.current)
        setRuns(page.items)
        setNext(page.nextOffset ?? null)
        setRun(latest.current)
        setError('')
        timer = setTimeout(() => void poll(), 1000)
      } catch (failure) {
        if (stopped || !isCurrent()) return
        latest.current = null
        onSnapshot?.(null)
        setRuns([])
        setRun(null)
        setOutput(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        inFlight = false
      }
    }
    const visible = () => {
      if (timer) clearTimeout(timer)
      if (document.visibilityState !== 'hidden') void poll()
    }
    void poll()
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [serverId, definitionId, selected, offset, retry, isCurrent, onSnapshot])
  const readOutput = async (nodeId: string, from = 0) => {
    if (!run) return
    const id = run.runId
    const revision = ++outputRevision.current
    try {
      const value = await workflowApi.output(serverId, id, nodeId, from)
      if (isCurrent() && revision === outputRevision.current)
        setOutput({ nodeId, text: value.text, next: value.nextOffset ?? null })
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  return (
    <section
      data-testid="workflow-run-history"
      className="space-y-2 rounded-xl border border-border bg-background p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">{t('workflowCanvas.runHistory')}</h3>
        <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>
          {t('workflowCanvas.reload')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {!error && !runs.length && (
        <p className="text-xs text-text-muted">{t('workflowCanvas.noRuns')}</p>
      )}
      {!!runs.length && (
        <select
          aria-label={t('workflowCanvas.runHistory')}
          className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          value={run?.runId ?? ''}
          onChange={event => {
            outputRevision.current += 1
            setSelected(event.target.value)
            setRun(null)
            setOutput(null)
          }}
        >
          {runs.map(item => (
            <option key={item.runId} value={item.runId}>
              v{item.version ?? '—'} · {new Date(item.startedAtMs).toLocaleString()} ·{' '}
              {t(`workflowCanvas.status_${item.status}`, item.status)}
            </option>
          ))}
        </select>
      )}
      {(offset > 0 || next != null) && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!offset}
            onClick={() => {
              setOffset(Math.max(0, offset - 20))
              setSelected('')
              setOutput(null)
            }}
          >
            {t('workflowCanvas.previous')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={next == null}
            onClick={() => {
              setOffset(next!)
              setSelected('')
              setOutput(null)
            }}
          >
            {t('workflowCanvas.next')}
          </Button>
        </div>
      )}
      {run && (
        <>
          {run.error && (
            <p role="alert" className="break-words text-xs text-destructive">
              {run.error}
            </p>
          )}
          <p className="break-all text-xs text-text-muted">
            {run.runId} · v{run.version ?? '—'} · {run.workspace}
          </p>
          <Button
            size="sm"
            variant="link"
            onClick={() =>
              navigateTo(
                buildRuntimeTaskRoute({
                  deviceId: serverId,
                  taskId: `kcoder:${serverId}:${run.threadId}`,
                })
              )
            }
          >
            {t('workflowCanvas.openRunConversation')}
          </Button>
          <p className="text-xs text-text-muted">{t('workflowCanvas.runControlsHint')}</p>
          <div className="max-h-64 space-y-1 overflow-auto">
            {run.nodeStates.map(node => (
              <div key={node.nodeId} className="rounded-lg bg-surface/50 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{node.nodeId}</span>
                  <span>{t(`workflowCanvas.status_${node.status}`, node.status)}</span>
                  {node.reused && <span>{t('workflowCanvas.reused')}</span>}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => void readOutput(node.nodeId)}
                  >
                    {t('workflowCanvas.nodeOutput')}
                  </Button>
                </div>
                <p className="text-text-muted">
                  {t('workflowCanvas.attempt', {
                    attempt: node.attempt,
                    iteration: node.iteration ?? '—',
                  })}
                  {node.startedAtMs != null && node.finishedAtMs != null
                    ? ` · ${((node.finishedAtMs - node.startedAtMs) / 1000).toFixed(1)}s`
                    : ''}
                </p>
                {node.error && <p className="break-words text-destructive">{node.error}</p>}
                {node.outputPreview && (
                  <p className="truncate text-text-secondary">{node.outputPreview}</p>
                )}
              </div>
            ))}
          </div>
          {output && (
            <div>
              <h4 className="text-xs font-medium">{output.nodeId}</h4>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-code">
                {output.text}
              </pre>
              {output.next != null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void readOutput(output.nodeId, output.next!)}
                >
                  {t('workflowCanvas.moreOutput')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
