import { requestWorkflowComposerIntent } from './useWorkflowComposerIntent'
import { WorkflowLibraryActions, WorkflowImportButton } from './WorkflowLibraryActions'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, GitBranch, Plus, RefreshCw, Save, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowNodeEditor } from './WorkflowNodeEditor'
import {
  workflowApi,
  newerDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowSummary,
  type WorkflowRun,
} from './workflowApi'

const pageVisible = () => document.visibilityState !== 'hidden'

const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30'
export function WorkflowWorkspace() {
  const { t } = useTranslation('common')
  const { state } = useWorkbench()
  const target = workbenchModelTarget(state)
  const [dirtyScope, setDirtyScope] = useState<string | null>(null)
  const [requested, setRequested] = useState<string | null>(null)
  const serverId = state.devices.some(device => device.device_id === requested)
    ? requested!
    : target?.deviceId ||
      state.devices.find(device => device.is_default)?.device_id ||
      state.devices[0]?.device_id ||
      ''
  const scope = usePluginTargetScope(serverId)
  const handleDirty = useCallback(
    (value: boolean) => setDirtyScope(value ? scope.key : null),
    [scope.key]
  )
  return (
    <main
      data-testid="workflow-workspace"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background p-4 text-text-primary"
    >
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('workflowCanvas.back')}
          onClick={() => navigateTo('/')}
        >
          <ArrowLeft />
        </Button>
        <h1 className="heading-base">{t('workflowCanvas.heading')}</h1>
        <div className="ml-auto">
          <SettingsSelect
            icon={<GitBranch />}
            aria-label={t('workflowCanvas.target')}
            data-testid="workflow-target"
            disabled={dirtyScope === scope.key}
            value={serverId}
            onChange={event => setRequested(event.target.value)}
          >
            {state.devices.map(device => (
              <option key={device.device_id} value={device.device_id}>
                {device.name} · {device.device_id}
              </option>
            ))}
          </SettingsSelect>
        </div>
      </header>
      {serverId ? (
        <WorkflowLibrary
          key={scope.key}
          isCurrent={scope.isCurrent}
          serverId={serverId}
          initialWorkspace={serverId === target?.deviceId ? target.workspacePath || '' : ''}
          onDirty={handleDirty}
        />
      ) : (
        <p>{t('workflowCanvas.chooseTarget')}</p>
      )}
    </main>
  )
}

function WorkflowLibrary({
  serverId,
  initialWorkspace,
  onDirty,
  isCurrent,
}: {
  serverId: string
  initialWorkspace: string
  onDirty: (dirty: boolean) => void
  isCurrent: () => boolean
}) {
  const { t } = useTranslation('common')
  const { startNewChat, openStandaloneWorkspace } = useWorkbench()
  const [items, setItems] = useState<WorkflowSummary[]>([])
  const [truncated, setTruncated] = useState(false)
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | undefined>()
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const [viewVersion, setViewVersion] = useState<number | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [revisionTick, setRevisionTick] = useState(0)
  const [workspacePath, setWorkspacePath] = useState(initialWorkspace)
  const [runHistoryOpen, setRunHistoryOpen] = useState(false)
  const [observedRun, setObservedRun] = useState<WorkflowRun | null>(null)
  const [runArguments, setRunArguments] = useState('{}')
  const [schemaText, setSchemaText] = useState('')
  const [schemaRevision, setSchemaRevision] = useState<number | null>(null)
  const apply = useCallback((next: WorkflowDefinition) => {
    setDefinition(current => (current?.id === next.id ? newerDefinition(current, next) : current))
    setItems(current => {
      const previous = current.find(item => item.id === next.id)
      if (previous && previous.revision > next.revision) return current
      const { nodes, ...summary } = next
      return current.map(item =>
        item.id === next.id ? { ...summary, nodeCount: nodes.length } : item
      )
    })
  }, [])

  useEffect(() => {
    let stopped = false,
      pending = false,
      failed = false,
      ticks = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (stopped || !isCurrent() || pending || !pageVisible()) return
      pending = true
      try {
        if (ticks++ % 4 === 0) {
          const page = await workflowApi.list(serverId, offset)
          if (stopped || !isCurrent()) return
          setTruncated(page.truncated)
          setTotal(page.total)
          setNextOffset(page.nextOffset)
          setItems(current =>
            page.items.map(item => {
              const newer = current.find(
                previous => previous.id === item.id && previous.revision > item.revision
              )
              return newer || item
            })
          )
        }
        if (selected) {
          const next =
            viewVersion == null
              ? await workflowApi.read(serverId, selected)
              : await workflowApi.exportDefinition(serverId, selected, viewVersion)
          if (!stopped && isCurrent()) setDefinition(current => newerDefinition(current, next))
        }
        failed = false
        if (!stopped && isCurrent()) {
          setLoadError(null)
          setLoading(false)
        }
      } catch (failure) {
        failed = true
        if (!stopped && isCurrent()) {
          setDefinition(null)
          setWorkspacePath('')
          setSelected(null)
          setSelectedNode(null)
          setItems([])
          setDirty(false)
          onDirty(false)
          setLoadError(failure instanceof Error ? failure.message : t('workflowCanvas.loadFailed'))
          setLoading(false)
        }
      } finally {
        pending = false
        if (!stopped && !failed && pageVisible()) timer = setTimeout(() => void poll(), 750)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (pageVisible()) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [serverId, selected, revisionTick, offset, t, isCurrent, onDirty, viewVersion])

  const mutate = async (operation: () => Promise<WorkflowDefinition>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await operation()
      if (!isCurrent()) return false
      apply(next)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflowCanvas.saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }
  const choose = (id: string) => {
    if (dirty) {
      setError(t('workflowCanvas.finishNodeEdit'))
      return
    }
    setRunArguments('{}')
    setSchemaText('')
    setSchemaRevision(null)
    setViewVersion(null)
    setObservedRun(null)
    setSelected(id)
    setDefinition(null)
    setSelectedNode(null)
  }
  const addNode = async () => {
    if (!definition) return
    const id = `node-${crypto.randomUUID().slice(0, 8)}`
    if (viewVersion != null) return
    const count = definition.nodes.length
    const node: WorkflowNode = {
      id,
      title: t('workflowCanvas.newNode'),
      prompt: '',
      agentType: 'general',
      maxTurns: 60,
      dependsOn: [],
      position: { x: (count % 3) * 260, y: Math.floor(count / 3) * 140 },
      allowedWritePaths: [],
      acceptanceCriteria: [],
      expectedArtifacts: [],
    }
    if (await mutate(() => workflowApi.upsert(serverId, definition.id, definition.revision, node)))
      setSelectedNode(id)
  }
  const launch = async () => {
    if (!definition || !workspacePath.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (!definition.savedVersion) return
      const accountValid = captureAccountContextRevision()
      const args: unknown = JSON.parse(runArguments)
      startNewChat()
      await openStandaloneWorkspace(serverId, workspacePath.trim(), definition.title)
      if (!accountValid(serverId)) return
      requestWorkflowComposerIntent({
        active: false,
        run: {
          id: definition.id,
          version: viewVersion ?? definition.savedVersion,
          args,
          deviceId: serverId,
          workspacePath: workspacePath.trim(),
        },
      })
      navigateTo('/')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('workflowCanvas.launchFailed'))
    } finally {
      setBusy(false)
    }
  }
  const node = definition?.nodes.find(item => item.id === selectedNode)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto lg:flex-row">
      <aside className="w-full shrink-0 space-y-3 overflow-y-auto rounded-xl border border-border p-3 lg:w-60">
        <h2 className="text-sm font-medium">{t('workflowCanvas.library')}</h2>
        <Button
          className="w-full"
          data-testid="workflow-create"
          disabled={busy || dirty}
          onClick={() => {
            requestWorkflowComposerIntent({ active: true })
            startNewChat()
            navigateTo('/?workflow=new')
          }}
        >
          <Plus />
          {t('workflowCanvas.createInChat')}
        </Button>
        <WorkflowImportButton
          disabled={busy || dirty}
          serverId={serverId}
          isCurrent={isCurrent}
          onError={setError}
          onCreated={next => {
            setViewVersion(null)
            setSelected(next.id)
            setDefinition(next)
            setSelectedNode(null)
            setItems([])
            setOffset(0)
            setRevisionTick(value => value + 1)
          }}
        />
        {loading && (
          <p role="status" className="text-sm">
            {t('workflowCanvas.loading')}
          </p>
        )}
        {items.map(item => (
          <button
            key={item.id}
            data-testid={`workflow-library-${item.id}`}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface aria-pressed:bg-surface"
            aria-pressed={selected === item.id}
            disabled={busy}
            onClick={() => choose(item.id)}
          >
            <span className="block truncate font-medium">{item.title}</span>
            <span className="text-xs text-text-muted">
              {t(`workflowCanvas.${item.status}`)} · {item.nodeCount} · r{item.revision}
            </span>
          </button>
        ))}
        {!loading && !items.length && (
          <p className="text-sm text-text-muted">{t('workflowCanvas.emptyLibrary')}</p>
        )}
        <p className="text-xs text-text-muted">
          {t('workflowCanvas.pageCount', {
            offset: items.length ? offset + 1 : 0,
            end: offset + items.length,
            total,
          })}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!offset || busy}
            onClick={() => {
              setOffset(value => Math.max(0, value - 32))
              setItems([])
              setLoading(true)
            }}
          >
            {t('workflowCanvas.previous')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!truncated || nextOffset == null || busy}
            onClick={() => {
              setOffset(nextOffset!)
              setItems([])
              setLoading(true)
            }}
          >
            {t('workflowCanvas.next')}
          </Button>
        </div>
        {truncated && <p className="text-xs text-text-muted">{t('workflowCanvas.truncated')}</p>}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {(error || loadError) && (
          <div
            role="alert"
            data-testid="workflow-error"
            className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
          >
            <span className="break-words">{error || loadError}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOffset(0)
                setRevisionTick(value => value + 1)
              }}
            >
              <RefreshCw />
              {t('workflowCanvas.reload')}
            </Button>
          </div>
        )}
        {definition ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto truncate text-sm font-medium">{definition.title}</h2>
              <span data-testid="workflow-revision" className="text-xs text-text-muted">
                {t(`workflowCanvas.${definition.status}`)} · r{definition.revision}
                {definition.savedVersion ? ` · v${definition.savedVersion}` : ''}
              </span>
              <Button
                size="sm"
                variant="secondary"
                data-testid="workflow-add-node"
                disabled={busy || dirty || viewVersion != null || definition.nodes.length >= 64}
                onClick={() => void addNode()}
              >
                <Plus />
                {t('workflowCanvas.addNode')}
              </Button>
              <Button
                size="sm"
                data-testid="workflow-publish"
                disabled={
                  busy ||
                  dirty ||
                  viewVersion != null ||
                  !definition.nodes.length ||
                  definition.status === 'saved'
                }
                onClick={() =>
                  void mutate(() => workflowApi.save(serverId, definition.id, definition.revision))
                }
              >
                <Save />
                {t('workflowCanvas.publish')}
              </Button>
            </div>
            <p className="text-xs text-text-muted">{t('workflowCanvas.saveDoesNotRun')}</p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || dirty || viewVersion != null || !workspacePath.trim()}
              onClick={() => {
                const id = definition.id
                const accountValid = captureAccountContextRevision()
                startNewChat()
                void openStandaloneWorkspace(serverId, workspacePath.trim(), definition.title)
                  .then(() => {
                    if (accountValid(serverId)) {
                      requestWorkflowComposerIntent({ active: true, definitionId: id })
                      navigateTo(`/?workflow=new&workflowDraft=${encodeURIComponent(id)}`)
                    }
                  })
                  .catch(failure => {
                    if (isCurrent()) setError(String(failure))
                  })
              }}
            >
              {t('workflowCanvas.continueDesign')}
            </Button>
            <WorkflowLibraryActions
              serverId={serverId}
              definition={definition}
              version={viewVersion}
              disabled={busy || dirty}
              isCurrent={isCurrent}
              onError={setError}
              onVersion={version => {
                setViewVersion(version)
                setDefinition(null)
                setSelectedNode(null)
                setObservedRun(null)
              }}
              onCreated={next => {
                setViewVersion(null)
                setSelected(next.id)
                setDefinition(next)
                setSelectedNode(null)
                setItems([])
                setOffset(0)
                setRevisionTick(value => value + 1)
              }}
            />
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm">
                {t('workflowCanvas.inputSchema')}
              </summary>
              <textarea
                aria-label={t('workflowCanvas.inputSchema')}
                className={`${field} mt-2 font-mono`}
                rows={6}
                value={schemaText || JSON.stringify(definition.inputSchema ?? {}, null, 2)}
                onChange={event => {
                  if (schemaRevision == null) setSchemaRevision(definition.revision)
                  setSchemaText(event.target.value)
                }}
              />
              {schemaText && schemaRevision !== definition.revision && (
                <p role="alert" className="text-xs text-destructive">
                  {t('workflowCanvas.editorStale')}
                </p>
              )}
              {schemaText && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSchemaText('')
                    setSchemaRevision(null)
                  }}
                >
                  {t('workflowCanvas.discardEdits')}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  busy ||
                  dirty ||
                  viewVersion != null ||
                  !schemaText ||
                  schemaRevision !== definition.revision
                }
                onClick={() => {
                  try {
                    const schema: unknown = JSON.parse(schemaText)
                    void mutate(() => workflowApi.update(serverId, definition, schema)).then(ok => {
                      if (ok) {
                        setSchemaText('')
                        setSchemaRevision(null)
                      }
                    })
                  } catch {
                    setError(t('workflowCanvas.invalidJsonObject'))
                  }
                }}
              >
                {t('workflowCanvas.saveInputSchema')}
              </Button>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                data-testid="workflow-run"
                disabled={busy || !definition.savedVersion || !workspacePath.trim()}
                onClick={() => void launch()}
              >
                <Play />
                {t('workflowCanvas.runSaved', {
                  version: viewVersion ?? definition.savedVersion ?? '—',
                })}
              </Button>
            </div>
            <details className="rounded-xl border border-border p-3">
              <summary
                data-testid="workflow-run-settings-toggle"
                className="cursor-pointer text-sm"
              >
                {t('workflowCanvas.runSettings')}
              </summary>
              <div className="space-y-2">
                <label className="block space-y-1 text-sm">
                  {t('workflowCanvas.workspace')}
                  <input
                    data-testid="workflow-execution-workspace"
                    className={field}
                    value={workspacePath}
                    onChange={event => setWorkspacePath(event.target.value)}
                    placeholder={t('workflowCanvas.workspaceRequired')}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  {t('workflowCanvas.runArguments')}
                  {definition.inputSchema != null && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-text-muted">
                      {JSON.stringify(definition.inputSchema, null, 2)}
                    </pre>
                  )}
                  <textarea
                    data-testid="workflow-run-arguments"
                    className={`${field} font-mono`}
                    rows={3}
                    value={runArguments}
                    onChange={event => setRunArguments(event.target.value)}
                  />
                </label>
              </div>
            </details>
            <details
              onToggle={event => {
                setRunHistoryOpen(event.currentTarget.open)
                if (!event.currentTarget.open) setObservedRun(null)
              }}
            >
              <summary data-testid="workflow-run-history-toggle" className="cursor-pointer text-sm">
                {t('workflowCanvas.runHistory')}
              </summary>
              {runHistoryOpen && (
                <WorkflowRunPanel
                  serverId={serverId}
                  definitionId={definition.id}
                  onSnapshot={setObservedRun}
                />
              )}
            </details>
            <p className="sr-only" aria-live="polite">
              {t('workflowCanvas.nodeCount', { count: definition.nodes.length })}
            </p>
            <div className="flex min-h-96 min-w-0 flex-1 flex-col gap-3 md:flex-row">
              <WorkflowCanvas
                definition={definition}
                nodeStates={
                  definition.status === 'saved' &&
                  observedRun?.definitionId === definition.id &&
                  observedRun.version === definition.savedVersion
                    ? observedRun.nodeStates
                    : []
                }
                selectedId={selectedNode}
                disabled={busy || dirty || viewVersion != null}
                onSelect={id => {
                  if (dirty && id !== selectedNode) {
                    setError(t('workflowCanvas.finishNodeEdit'))
                    return
                  }
                  setSelectedNode(id)
                }}
                onMove={(value, revision) =>
                  void mutate(() => workflowApi.upsert(serverId, definition.id, revision, value))
                }
              />
              {node && viewVersion != null && (
                <aside className="w-full overflow-auto rounded-xl border border-border p-4 md:w-72">
                  <h3 className="text-sm font-medium">{node.title}</h3>
                  <p className="my-2 text-xs text-text-muted">
                    {t('workflowCanvas.readOnlyVersion')}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{node.prompt}</p>
                  {node.config && (
                    <pre className="mt-3 whitespace-pre-wrap break-words text-code">
                      {JSON.stringify(node.config, null, 2)}
                    </pre>
                  )}
                </aside>
              )}
              {node && viewVersion == null && (
                <WorkflowNodeEditor
                  key={`${definition.id}:${node.id}`}
                  definition={definition}
                  node={node}
                  busy={busy}
                  onDirty={value => {
                    setDirty(value)
                    onDirty(value)
                    if (!value) setError(null)
                  }}
                  onSave={(value, revision) =>
                    mutate(() => workflowApi.upsert(serverId, definition.id, revision, value))
                  }
                  onDelete={async (id, revision) => {
                    const ok = await mutate(() =>
                      workflowApi.remove(serverId, definition.id, revision, id)
                    )
                    if (ok) {
                      setSelectedNode(null)
                      setDirty(false)
                    }
                    return ok
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <p className="p-8 text-sm text-text-muted">{t('workflowCanvas.selectWorkflow')}</p>
        )}
      </section>
    </div>
  )
}
