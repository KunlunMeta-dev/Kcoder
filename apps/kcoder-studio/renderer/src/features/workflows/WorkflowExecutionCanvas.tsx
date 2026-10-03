import { WorkflowPendingPanel } from './WorkflowPendingPanel'
import progressStyles from './WorkflowProgress.module.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { X, RefreshCw, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { WorkflowCanvas } from './WorkflowCanvas'
import { workflowApi, type WorkflowDefinition, type WorkflowRun } from './workflowApi'
import { workflowReferenceKey, type WorkflowReference } from './workflowReferences'
export function WorkflowExecutionCanvas(props: {
  serverId: string
  threadId: string
  reference: WorkflowReference
  onClose: () => void
  active: boolean
}) {
  const scope = usePluginTargetScope(props.serverId)
  return (
    <ExecutionCanvas
      key={`${scope.key}:${workflowReferenceKey(props.reference)}`}
      {...props}
      isCurrent={scope.isCurrent}
    />
  )
}
function ExecutionCanvas({
  serverId,
  threadId,
  reference,
  onClose,
  isCurrent,
  active,
}: {
  serverId: string
  threadId: string
  reference: WorkflowReference
  onClose: () => void
  isCurrent: () => boolean
  active: boolean
}) {
  const { t } = useTranslation('common')
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const latest = useRef<WorkflowRun | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; revision: number }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [output, setOutput] = useState<{
    nodeId: string
    text: string
    next: number | null
  } | null>(null)
  const outputRevision = useRef(0)
  const [outputBusy, setOutputBusy] = useState(false)
  const [outputError, setOutputError] = useState('')
  const invalidateOutputs = useCallback(() => {
    outputRevision.current++
  }, [])
  useEffect(() => {
    let stopped = false,
      inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cached: WorkflowDefinition | null = null
    const poll = async () => {
      if (!active || stopped || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      let keepPolling = true,
        identityMismatch = false
      let pollDelay = 1000
      try {
        const graph =
          cached ??
          (reference.version
            ? await workflowApi.exportDefinition(serverId, reference.id, reference.version)
            : await workflowApi.read(serverId, reference.id))
        cached = graph
        const next = reference.runId ? await workflowApi.run(serverId, reference.runId) : null
        if (stopped || !isCurrent()) return
        if (
          graph.id !== reference.id ||
          (reference.version && graph.savedVersion !== reference.version)
        ) {
          identityMismatch = true
          throw new Error(t('workflowReuse.versionMismatch'))
        }
        if (
          next &&
          (next.definitionId !== reference.id ||
            next.version !== reference.version ||
            (threadId.startsWith(`kcoder:${serverId}:`)
              ? threadId.slice(`kcoder:${serverId}:`.length)
              : threadId) !== next.threadId)
        ) {
          identityMismatch = true
          throw new Error(t('workflowFlow.runMismatch'))
        }
        setDefinition(graph)
        if (!next || !latest.current || next.revision >= latest.current.revision) {
          if (next && latest.current && next.resumeCount > latest.current.resumeCount) {
            setFollow(true)
            outputRevision.current++
            setOutput(null)
            setOutputBusy(false)
          }
          latest.current = next
          setRun(next)
        }
        setError('')
        keepPolling = Boolean(reference.runId) && latest.current?.status !== 'completed'
        pollDelay = latest.current?.status === 'running' ? 1000 : 2500
      } catch (e) {
        keepPolling = !identityMismatch
        if (!stopped && isCurrent()) {
          setError(String(e instanceof Error ? e.message : e))
          setRun(null)
          setOutput(null)
          outputRevision.current++
          setOutputBusy(false)
        }
      } finally {
        inFlight = false
        if (keepPolling && reference.runId && !stopped && active && isCurrent())
          timer = setTimeout(() => void poll(), pollDelay)
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
      invalidateOutputs()
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [
    serverId,
    threadId,
    reference.id,
    reference.version,
    reference.runId,
    isCurrent,
    retry,
    t,
    active,
    invalidateOutputs,
  ])
  const runningNodes = run?.nodeStates.filter(node => node.status === 'running') ?? []
  const chooseNode = useCallback((id: string, manual: boolean) => {
    outputRevision.current++
    setSelected(id)
    setOutput(null)
    setOutputBusy(false)
    setOutputError('')
    setFocusRequest(previous => ({ nodeId: id, revision: (previous?.revision ?? 0) + 1 }))
    if (manual) setFollow(false)
  }, [])
  useEffect(() => {
    if (!follow || !run || error) return
    const running = run.nodeStates.filter(node => node.status === 'running')
    const next =
      running.find(node => node.nodeId === selected) ??
      running[0] ??
      (run.status === 'failed'
        ? run.nodeStates.find(node => node.status === 'failed')
        : run.status === 'cancelled'
          ? (run.nodeStates.find(node => node.status === 'cancelled' && node.startedAtMs != null) ??
            run.nodeStates.find(node => node.status === 'cancelled'))
          : undefined)
    if (!next || next.nodeId === selected) return
    const frame = requestAnimationFrame(() => chooseNode(next.nodeId, false))
    return () => cancelAnimationFrame(frame)
  }, [run, follow, selected, error, chooseNode])
  const state = run?.nodeStates.find(node => node.nodeId === selected)
  const node = definition?.nodes.find(node => node.id === selected)
  const readOutput = async (offset = 0) => {
    if (!reference.runId || !selected) return
    const revision = ++outputRevision.current
    setOutputBusy(true)
    setOutputError('')
    try {
      const value = await workflowApi.output(serverId, reference.runId, selected, offset)
      if (isCurrent() && revision === outputRevision.current)
        setOutput({ nodeId: selected, text: value.text, next: value.nextOffset ?? null })
    } catch (e) {
      if (isCurrent() && revision === outputRevision.current)
        setOutputError(String(e instanceof Error ? e.message : e))
    } finally {
      if (isCurrent() && revision === outputRevision.current) setOutputBusy(false)
    }
  }
  return (
    <aside
      data-testid="workflow-execution-canvas"
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-background"
    >
      <header className="flex items-center gap-2 border-b border-border p-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {definition?.title ?? t('workflowCanvas.heading')}
        </h2>
        <span className="text-xs text-text-muted">
          {reference.version ? `v${reference.version}` : t('workflowCanvas.draft')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('workflowCanvas.reload')}
          onClick={() => {
            outputRevision.current++
            setOutputBusy(false)
            setOutputError('')
            setRetry(n => n + 1)
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('workflowFlow.closeCanvas')}
          data-testid="workflow-canvas-close"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary" role="status">
        {(run?.status === 'running' || (error && reference.runId)) && (
          <LoaderCircle
            data-testid="workflow-running-spinner"
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 ${progressStyles.spinner}`}
          />
        )}
        {run ? (
          <>
            {t(`workflowCanvas.status_${run.status}`, run.status)} ·{' '}
            {
              run.nodeStates.filter(n =>
                ['completed', 'skipped', 'failed', 'cancelled'].includes(n.status)
              ).length
            }
            /{definition?.nodes.length ?? 0}
          </>
        ) : error ? (
          t('workflowFlow.reconnecting')
        ) : (
          t('workflowFlow.savedPreview')
        )}
      </div>
      {run?.status === 'running' && (
        <div
          className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs"
          data-testid="workflow-current-nodes"
          aria-live="polite"
        >
          <span className="text-text-muted">{t('workflowFlow.currentNodes')}</span>
          {runningNodes.length ? (
            runningNodes.map(node => (
              <Button
                key={node.nodeId}
                size="sm"
                variant="secondary"
                onClick={() => chooseNode(node.nodeId, true)}
                data-testid={`workflow-current-${node.nodeId}`}
              >
                {definition?.nodes.find(item => item.id === node.nodeId)?.title || node.nodeId}
                {node.iteration != null
                  ? ` · ${t('workflowFlow.iteration', { number: node.iteration + 1 })}`
                  : ''}
              </Button>
            ))
          ) : (
            <span className="text-text-muted">{t('workflowFlow.scheduling')}</span>
          )}
          <Button
            size="sm"
            variant={follow ? 'secondary' : 'ghost'}
            aria-pressed={follow}
            data-testid="workflow-follow-run"
            onClick={() => {
              setFollow(value => !value)
              if (!follow && runningNodes[0]) chooseNode(runningNodes[0].nodeId, false)
            }}
          >
            {t('workflowFlow.followRun')}
          </Button>
        </div>
      )}
      {(error || run?.error) && (
        <p role="alert" className="break-words px-3 py-2 text-sm text-destructive">
          {error || run?.error}
        </p>
      )}
      {active && run && ['running','interrupted'].includes(run.status) && <WorkflowPendingPanel key={`${serverId}:${run.runId}`} serverId={serverId} runId={run.runId} isCurrent={isCurrent} />}
      {definition && (
        <div className="flex min-h-64 flex-1">
          <WorkflowCanvas
            definition={definition}
            selectedId={selected}
            focusRequest={focusRequest}
            disabled
            nodeStates={error ? [] : (run?.nodeStates ?? [])}
            onMove={() => {}}
            onSelect={id => chooseNode(id, true)}
          />
        </div>
      )}
      {node && (
        <section
          className="max-h-[40%] space-y-2 overflow-auto border-t border-border p-3"
          data-testid="workflow-node-inspector"
        >
          <h3 className="text-sm font-medium">{node.title}</h3>
          {state && (
            <p className="text-xs text-text-secondary">
              {t(`workflowCanvas.status_${state.status}`, state.status)}
              {state.reused ? ` · ${t('workflowCanvas.reused')}` : ''}
            </p>
          )}
          {state?.error && (
            <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
              {state.error}
            </p>
          )}
          {node.expectedArtifacts?.length > 0 && (
            <p className="text-xs text-text-muted">
              {t('workflowFlow.expectedArtifacts')}: {node.expectedArtifacts.join(', ')}
            </p>
          )}
          {outputError && (
            <p role="alert" className="break-words text-sm text-destructive">
              {outputError}
            </p>
          )}
          {reference.runId && (
            <Button
              size="sm"
              variant="secondary"
              disabled={outputBusy}
              data-testid="workflow-node-output"
              onClick={() => void readOutput()}
            >
              {t('workflowCanvas.nodeOutput')}
            </Button>
          )}
          {output?.nodeId === selected && (
            <>
              <pre className="whitespace-pre-wrap break-words text-code">
                {output.text || t('workflowFlow.noOutput')}
              </pre>
              {output.next != null && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={outputBusy}
                  onClick={() => void readOutput(output.next!)}
                >
                  {t('workflowCanvas.moreOutput')}
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </aside>
  )
}
