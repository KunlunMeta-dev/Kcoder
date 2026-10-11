import { startWorkflowPolling, workflowRunPollDelay } from './workflowPolling'
import { useWorkflowReadCancellation } from './useWorkflowReadCancellation'
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
  onOpenAgent?: (agentId: string, context?: { runId: string; nodeId: string }) => void
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
  onOpenAgent,
}: {
  serverId: string
  threadId: string
  reference: WorkflowReference
  onClose: () => void
  isCurrent: () => boolean
  active: boolean
  onOpenAgent?: (agentId: string, context?: { runId: string; nodeId: string }) => void
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
  const { begin: beginOutput, cancel: cancelOutput } = useWorkflowReadCancellation(active)
  const outputRevision = useRef(0)
  const [outputBusy, setOutputBusy] = useState(false)
  const [outputError, setOutputError] = useState('')
  const invalidateOutputs = useCallback(() => {
    outputRevision.current++
    cancelOutput()
    setOutputBusy(false)
  }, [cancelOutput])
  useEffect(() => {
    let cached: WorkflowDefinition | null = null
    let identityMismatch = false
    const stop = startWorkflowPolling({
      active,
      isCurrent,
      changes: { serverId, definitionId: reference.id, runId: reference.runId },
      poll: async (isLive, signal) => {
        if (identityMismatch) return false
        const graph =
          cached ??
          (reference.version
            ? await workflowApi.exportDefinition(serverId, reference.id, reference.version, {
                signal,
              })
            : await workflowApi.read(serverId, reference.id, undefined, { signal }))
        if (!isLive()) return false
        const next = reference.runId
          ? await workflowApi.run(serverId, reference.runId, latest.current, { signal })
          : null
        if (!isLive()) return false
        if (
          graph.id !== reference.id ||
          (reference.version && graph.savedVersion !== reference.version)
        ) {
          identityMismatch = true
          throw new Error(t('workflowReuse.versionMismatch'))
        }
        if (
          next &&
          (next.runId !== reference.runId ||
            next.definitionId !== reference.id ||
            next.version !== reference.version ||
            (threadId.startsWith(`kcoder:${serverId}:`)
              ? threadId.slice(`kcoder:${serverId}:`.length)
              : threadId) !== next.threadId)
        ) {
          identityMismatch = true
          throw new Error(t('workflowFlow.runMismatch'))
        }
        cached = graph
        setDefinition(graph)
        if (!next || !latest.current || next.revision > latest.current.revision) {
          if (next && latest.current && next.resumeCount > latest.current.resumeCount) {
            setFollow(true)
            outputRevision.current++
            cancelOutput()
            setOutput(null)
            setOutputBusy(false)
          }
          latest.current = next
          setRun(next)
        }
        setError('')
        return reference.runId ? workflowRunPollDelay(latest.current?.status) : false
      },
      onError: cause => {
        setError(cause instanceof Error ? cause.message : String(cause))
        // The last validated graph, run, selection and output remain useful offline.
      },
    })
    return () => {
      stop()
      invalidateOutputs()
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
    cancelOutput,
  ])
  const runningNodes = run?.nodeStates.filter(node => node.status === 'running') ?? []
  const chooseNode = useCallback(
    (id: string, manual: boolean) => {
      outputRevision.current++
      cancelOutput()
      setSelected(id)
      setOutput(null)
      setOutputBusy(false)
      setOutputError('')
      setFocusRequest(previous => ({ nodeId: id, revision: (previous?.revision ?? 0) + 1 }))
      if (manual) setFollow(false)
    },
    [cancelOutput]
  )
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
    const signal = beginOutput()
    setOutputBusy(true)
    setOutputError('')
    try {
      const value = await workflowApi.output(serverId, reference.runId, selected, offset, {
        signal,
      })
      if (!signal.aborted && isCurrent() && revision === outputRevision.current)
        setOutput({ nodeId: selected, text: value.text, next: value.nextOffset ?? null })
    } catch (e) {
      if (!signal.aborted && isCurrent() && revision === outputRevision.current)
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
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
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
            cancelOutput()
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
        {run?.status === 'running' && !error && (
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
            {error && <span>{t('workflowFlow.reconnecting')}</span>}
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
      {run?.interactionModified && (
        <p className="px-3 py-2 text-xs text-text-secondary" role="status">
          {t('workflowVerification.interactionModified')}
        </p>
      )}
      {(error || run?.error) && (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words px-3 py-2 text-sm text-destructive"
        >
          {error || run?.error}
        </p>
      )}
      {active && run && ['running', 'interrupted'].includes(run.status) && (
        <WorkflowPendingPanel
          key={`${serverId}:${run.runId}`}
          serverId={serverId}
          runId={run.runId}
          isCurrent={isCurrent}
          active={active}
          disabled={!active || !!error}
        />
      )}
      {definition && (
        <div className="flex min-h-64 flex-1">
          <WorkflowCanvas
            definition={definition}
            selectedId={selected}
            focusRequest={focusRequest}
            disabled
            nodeStates={run?.nodeStates ?? []}
            runId={run?.runId}
            onOpenAgent={onOpenAgent}
            stale={!!error}
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
          {state?.agentId && onOpenAgent && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="workflow-inspect-agent"
              onClick={() => onOpenAgent(state.agentId!, { runId: run!.runId, nodeId: node.id })}
            >
              {t('workbench.subagent_steer_open', { name: node.title || node.id })}
            </Button>
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
            <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
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
