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
        )
          throw new Error(t('workflowReuse.versionMismatch'))
        if (
          next &&
          (next.definitionId !== reference.id ||
            next.version !== reference.version ||
            (threadId.startsWith(`kcoder:${serverId}:`)
              ? threadId.slice(`kcoder:${serverId}:`.length)
              : threadId) !== next.threadId)
        )
          throw new Error(t('workflowFlow.runMismatch'))
        setDefinition(graph)
        if (!next || !latest.current || next.revision >= latest.current.revision) {
          latest.current = next
          setRun(next)
          if (next?.status === 'failed')
            setSelected(
              current =>
                current ?? next.nodeStates.find(node => node.status === 'failed')?.nodeId ?? null
            )
        }
        setError('')
        if (next?.status === 'running') timer = setTimeout(() => void poll(), 1000)
      } catch (e) {
        if (!stopped && isCurrent()) {
          setError(String(e instanceof Error ? e.message : e))
          setRun(null)
          setOutput(null)
          outputRevision.current++
          setOutputBusy(false)
        }
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
        {run?.status === 'running' && (
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
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
        ) : (
          t('workflowFlow.savedPreview')
        )}
      </div>
      {(error || run?.error) && (
        <p role="alert" className="break-words px-3 py-2 text-sm text-error">
          {error || run?.error}
        </p>
      )}
      {definition && (
        <div className="flex min-h-64 flex-1">
          <WorkflowCanvas
            definition={definition}
            selectedId={selected}
            disabled
            nodeStates={error ? [] : (run?.nodeStates ?? [])}
            onMove={() => {}}
            onSelect={id => {
              outputRevision.current++
              setSelected(id)
              setOutput(null)
              setOutputBusy(false)
              setOutputError('')
            }}
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
            <p role="alert" className="whitespace-pre-wrap break-words text-sm text-error">
              {state.error}
            </p>
          )}
          {node.expectedArtifacts?.length > 0 && (
            <p className="text-xs text-text-muted">
              {t('workflowFlow.expectedArtifacts')}: {node.expectedArtifacts.join(', ')}
            </p>
          )}
          {outputError && (
            <p role="alert" className="break-words text-sm text-error">
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
