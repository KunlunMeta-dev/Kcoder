import { startWorkflowPolling } from './workflowPolling'
import { WorkflowWorkspaceLocation } from './WorkflowWorkspaceLocation'
import {
  useHorizontalPaneResize,
  PANE_RESIZE_HANDLE,
} from '@/components/layout/useHorizontalPaneResize'
import { WorkflowDeleteButton } from './WorkflowDeleteButton'
import { requestWorkflowComposerIntent } from './useWorkflowComposerIntent'
import { WorkflowLibraryActions, WorkflowImportButton } from './WorkflowLibraryActions'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import {
  WorkflowVerification,
  type WorkflowVersionVerification,
  type WorkflowStorageCapacity,
} from './WorkflowVerification'
import {
  WorkflowVerificationHistory,
  type WorkflowVersionReferenceView,
} from './WorkflowVerificationHistory'
import { WorkflowVerificationStorage } from './WorkflowVerificationStorage'
import { WorkflowVerificationPrepare } from './WorkflowVerificationPrepare'
import type { WorkflowCapabilities, WorkflowScenarioInput } from './workflowApi'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  GitBranch,
  Plus,
  RefreshCw,
  Save,
  Play,
  ChevronRight,
  MessageSquare,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { SettingsDialog } from '@/components/settings/settings-ui'
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

const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30'
export function WorkflowWorkspace({
  onOpenAgent,
}: { onOpenAgent?: (agentId: string, context?: { runId: string; nodeId: string }) => void } = {}) {
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
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-text-primary"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-4 py-3 md:px-6">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('workflowCanvas.back')}
          onClick={() => navigateTo('/')}
        >
          <ArrowLeft />
        </Button>
        <h1 className="text-base font-semibold tracking-tight">{t('workflowCanvas.heading')}</h1>
        <div className="ml-auto">
          <SettingsSelect
            density="compact"
            icon={<GitBranch />}
            aria-label={t('workflowCanvas.target')}
            data-testid="workflow-target"
            disabled={dirtyScope === scope.key}
            value={serverId}
            onChange={event => setRequested(event.target.value)}
          >
            {state.devices.map(device => (
              <option key={device.device_id} value={device.device_id}>
                {device.name}
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
          onOpenAgent={onOpenAgent}
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
  onOpenAgent,
}: {
  serverId: string
  initialWorkspace: string
  onDirty: (dirty: boolean) => void
  isCurrent: () => boolean
  onOpenAgent?: (agentId: string, context?: { runId: string; nodeId: string }) => void
}) {
  const { t } = useTranslation('common')
  const splitRef = useRef<HTMLDivElement>(null)
  const librarySplit = useHorizontalPaneResize({
    containerRef: splitRef,
    initialWidth: 240,
    minWidth: 200,
    minRemaining: 420,
    maxWidth: 600,
  })
  const { startNewChat, openStandaloneWorkspace } = useWorkbench()
  const [items, setItems] = useState<WorkflowSummary[]>([])
  const [truncated, setTruncated] = useState(false)
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | undefined>()
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const latestDefinition = useRef<WorkflowDefinition | null>(null)
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
  const [locationAction, setLocationAction] = useState<'run' | 'design' | null>(null)
  const [runHistoryOpen, setRunHistoryOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [observedRun, setObservedRun] = useState<WorkflowRun | null>(null)
  const [runArguments, setRunArguments] = useState('{}')
  const [schemaText, setSchemaText] = useState('')
  const [schemaRevision, setSchemaRevision] = useState<number | null>(null)
  const [capabilities, setCapabilities] = useState<WorkflowCapabilities | null>(null)
  const [verification, setVerification] = useState<WorkflowVersionVerification | null>(null)
  const [capacity, setCapacity] = useState<WorkflowStorageCapacity | null>(null)
  const [references, setReferences] = useState<WorkflowVersionReferenceView | null>(null)
  const [metadataError, setMetadataError] = useState('')
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [preparing, setPreparing] = useState<WorkflowDefinition | null>(null)
  const metadataVersion = viewVersion ?? definition?.savedVersion ?? null
  const latestObservedRun = useRef<WorkflowRun | null>(null)
  useEffect(() => {
    latestObservedRun.current = observedRun
  }, [observedRun])
  const inspectionToken = useRef(0)
  const evidenceKey = (run: NonNullable<WorkflowVersionVerification>['runs'][number]) =>
    `${run.runId}:${run.artifactAttempt ?? run.resumeCount}`
  useEffect(() => {
    inspectionToken.current++
    return startWorkflowPolling({
      isCurrent,
      changes: { serverId, definitionId: selected ?? undefined },
      poll: async (isLive, signal) => {
        const caps = await workflowApi.capabilities(serverId, { signal })
        if (!isLive()) return false
        setCapabilities(caps)
        setMetadataLoading(true)
        const [proof, storage] = await Promise.all([
          caps.verification && selected && metadataVersion !== null
            ? workflowApi.verification(serverId, selected, metadataVersion, 0, 32, { signal })
            : Promise.resolve(null),
          caps.storage ? workflowApi.capacity(serverId, { signal }) : Promise.resolve(null),
        ])
        if (!isLive()) return false
        setVerification(current => {
          if (
            !proof ||
            current?.definitionId !== proof.definitionId ||
            current.savedVersion !== proof.savedVersion
          )
            return proof
          const first = new Set(proof.runs.map(evidenceKey))
          return {
            ...proof,
            runs: [...proof.runs, ...current.runs.filter(run => !first.has(evidenceKey(run)))],
            nextOffset:
              current.runs.length > proof.runs.length ? current.nextOffset : proof.nextOffset,
          }
        })
        setCapacity(storage)
        setMetadataLoading(false)
        setMetadataError('')
        return latestObservedRun.current?.status === 'running' ? 2500 : 15_000
      },
      onError: failure => {
        setMetadataError(String(failure))
        setMetadataLoading(false)
      },
    })
  }, [serverId, selected, metadataVersion, revisionTick, isCurrent])
  const inspectReferences = async (version: number) => {
    if (!selected || !capabilities?.versionHistory || !isCurrent()) return
    const token = ++inspectionToken.current
    try {
      const value = await workflowApi.versionReferences(serverId, selected, version)
      if (isCurrent() && token === inspectionToken.current) setReferences(value)
    } catch (failure) {
      if (isCurrent() && token === inspectionToken.current) setMetadataError(String(failure))
    }
  }
  const moreEvidence = async () => {
    if (!selected || metadataVersion === null || verification?.nextOffset == null || !isCurrent())
      return
    const token = ++inspectionToken.current
    try {
      const page = await workflowApi.verification(
        serverId,
        selected,
        metadataVersion,
        verification.nextOffset
      )
      if (isCurrent() && token === inspectionToken.current)
        setVerification(current =>
          current &&
          current.definitionId === page.definitionId &&
          current.savedVersion === page.savedVersion
            ? {
                ...page,
                runs: [
                  ...current.runs.filter(
                    run => !page.runs.some(next => evidenceKey(next) === evidenceKey(run))
                  ),
                  ...page.runs,
                ],
              }
            : page
        )
    } catch (failure) {
      if (isCurrent() && token === inspectionToken.current) setMetadataError(String(failure))
    }
  }
  const prepareVerification = async () => {
    if (!definition || metadataVersion === null || loadError || !isCurrent()) return
    const token = ++inspectionToken.current
    try {
      const saved = await workflowApi.exportDefinition(serverId, definition.id, metadataVersion)
      if (
        isCurrent() &&
        token === inspectionToken.current &&
        saved.id === definition.id &&
        saved.savedVersion === metadataVersion
      )
        setPreparing(saved)
    } catch (failure) {
      if (isCurrent() && token === inspectionToken.current) setMetadataError(String(failure))
    }
  }
  const prepared = async (
    workspace: string,
    args: unknown,
    verificationScenario?: WorkflowScenarioInput
  ) => {
    if (!preparing || loadError || !isCurrent()) return
    const saved = preparing
    const accountValid = captureAccountContextRevision()
    startNewChat()
    await openStandaloneWorkspace(serverId, workspace)
    if (!accountValid(serverId)) return
    requestWorkflowComposerIntent({
      active: false,
      run: {
        id: saved.id,
        version: saved.savedVersion!,
        args,
        deviceId: serverId,
        workspacePath: workspace,
        ...(verificationScenario ? { verificationScenario } : {}),
      },
    })
    setPreparing(null)
    navigateTo('/')
  }

  const apply = useCallback((next: WorkflowDefinition) => {
    setDefinition(current => {
      const merged = current?.id === next.id ? newerDefinition(current, next) : current
      latestDefinition.current = merged
      return merged
    })
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
    let ticks = 0
    return startWorkflowPolling({
      isCurrent,
      changes: {
        serverId,
        onChange: () => {
          ticks = 0
        },
      },
      poll: async (isLive, signal) => {
        if (ticks++ % 4 === 0) {
          const page = await workflowApi.list(serverId, offset, { signal })
          if (!isLive()) return false
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
              ? await workflowApi.read(serverId, selected, latestDefinition.current, { signal })
              : await workflowApi.exportDefinition(serverId, selected, viewVersion, { signal })
          if (!isLive()) return false
          setDefinition(current => {
            const merged = newerDefinition(current, next)
            latestDefinition.current = merged
            return merged
          })
        }
        setLoadError(null)
        setLoading(false)
        return selected && viewVersion == null ? 3000 : 10_000
      },
      onError: failure => {
        setLoadError(failure instanceof Error ? failure.message : t('workflowCanvas.loadFailed'))
        setLoading(false)
        // Retry the list too: a failed first page must not wait for four successful ticks.
        ticks = 0
      },
    })
  }, [serverId, selected, revisionTick, offset, t, isCurrent, viewVersion])

  const mutate = async (operation: () => Promise<WorkflowDefinition>) => {
    if (loadError || !isCurrent()) return false
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
    setReferences(null)
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
  const design = (path = workspacePath) => {
    if (!definition || !isCurrent()) return
    if (!path.trim()) {
      setLocationAction('design')
      return
    }
    const id = definition.id
    const accountValid = captureAccountContextRevision()
    startNewChat()
    void openStandaloneWorkspace(serverId, path.trim())
      .then(() => {
        if (accountValid(serverId)) {
          requestWorkflowComposerIntent({ active: true, definitionId: id })
          navigateTo(`/?workflow=new&workflowDraft=${encodeURIComponent(id)}`)
        }
      })
      .catch(failure => {
        if (isCurrent()) setError(String(failure))
      })
  }
  const launch = async (path = workspacePath) => {
    if (!definition || loadError || !isCurrent()) return
    if (!path.trim()) {
      setLocationAction('run')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (!definition.savedVersion) return
      const accountValid = captureAccountContextRevision()
      const args: unknown = JSON.parse(runArguments)
      startNewChat()
      await openStandaloneWorkspace(serverId, path.trim())
      if (!accountValid(serverId)) return
      requestWorkflowComposerIntent({
        active: false,
        run: {
          id: definition.id,
          version: viewVersion ?? definition.savedVersion,
          args,
          deviceId: serverId,
          workspacePath: path.trim(),
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
    <div
      ref={splitRef}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:flex-row lg:gap-0 lg:overflow-hidden md:p-5"
    >
      <aside
        data-testid="workflow-library-panel"
        style={{ '--library-width': `${librarySplit.width}px` } as React.CSSProperties}
        className="w-full shrink-0 space-y-3 overflow-y-auto rounded-xl bg-surface/40 p-3 lg:w-[var(--library-width)]"
      >
        <h2 className="px-2 text-xs font-medium text-text-muted">{t('workflowCanvas.library')}</h2>
        <label className="flex items-center gap-2 rounded-lg bg-background px-3 py-2 ring-1 ring-border/60 focus-within:ring-focus">
          <Search className="size-4 shrink-0 text-text-muted" />
          <input
            data-testid="workflow-library-search"
            aria-label={t('workflowCanvas.searchLibrary')}
            placeholder={t('workflowCanvas.searchLibrary')}
            value={libraryQuery}
            onChange={event => setLibraryQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <Button
          className="w-full"
          data-testid="workflow-create"
          disabled={busy || dirty || !!loadError}
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
          disabled={busy || dirty || !!loadError}
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
        {items
          .filter(item =>
            item.title.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase())
          )
          .map(item => (
            <button
              key={item.id}
              data-testid={`workflow-library-${item.id}`}
              className="block w-full rounded-lg px-3 py-3 text-left text-sm transition-colors hover:bg-background/70 aria-pressed:bg-background aria-pressed:shadow-sm"
              aria-pressed={selected === item.id}
              disabled={busy}
              onClick={() => choose(item.id)}
            >
              <span className="block truncate font-medium">{item.title}</span>
              <span className="text-xs text-text-muted">
                {t(`workflowCanvas.${item.status}`)}
                {item.savedVersion ? ` · v${item.savedVersion}` : ''}
              </span>
            </button>
          ))}
        {!loading && !items.length && (
          <p className="text-sm text-text-muted">{t('workflowCanvas.emptyLibrary')}</p>
        )}
        {(total > 32 || offset > 0) && (
          <>
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
            {truncated && (
              <p className="text-xs text-text-muted">{t('workflowCanvas.truncated')}</p>
            )}
          </>
        )}
      </aside>
      <div
        {...librarySplit.handleProps}
        data-testid="workflow-library-resize"
        aria-label={t('workflowCanvas.resizeLibrary')}
        className={`${PANE_RESIZE_HANDLE} mx-1 hidden lg:block`}
      />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:overflow-hidden">
        {locationAction && (
          <WorkflowWorkspaceLocation
            onClose={() => setLocationAction(null)}
            onChoose={path => {
              const action = locationAction
              setWorkspacePath(path)
              setLocationAction(null)
              if (action === 'run') void launch(path)
              else design(path)
            }}
          />
        )}
        {(error || loadError) && (
          <div
            role="alert"
            data-testid="workflow-error"
            className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
          >
            <span className="whitespace-pre-wrap break-words">{error || loadError}</span>
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
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 pb-4">
              <div className="mr-auto min-w-0 flex-1 basis-48">
                <h2 className="heading-sm truncate tracking-tight" title={definition.title}>
                  {definition.title}
                </h2>
                <p className="mt-1 text-xs text-text-muted">
                  {t('workflowCanvas.nodeCount', { count: definition.nodes.length })}
                </p>
              </div>
              <span
                data-testid="workflow-revision"
                className="text-xs text-text-muted"
                title={`r${definition.revision}`}
              >
                {t(`workflowCanvas.${definition.status}`)}
                {definition.savedVersion ? ` · v${definition.savedVersion}` : ''}
              </span>
              <Button
                size="sm"
                variant="secondary"
                data-testid="workflow-add-node"
                disabled={
                  busy ||
                  dirty ||
                  !!loadError ||
                  viewVersion != null ||
                  definition.nodes.length >= 64
                }
                onClick={() => void addNode()}
              >
                <Plus />
                {t('workflowCanvas.addNode')}
              </Button>
              <Button
                size="sm"
                data-testid="workflow-publish"
                variant="secondary"
                title={t('workflowCanvas.saveDoesNotRun')}
                disabled={
                  busy ||
                  !!loadError ||
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
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || dirty || !!loadError || viewVersion != null}
                onClick={() => design()}
              >
                <MessageSquare />
                {t('workflowCanvas.continueDesign')}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="workflow-run"
                  disabled={busy || !!loadError || !definition.savedVersion}
                  onClick={() => void launch()}
                >
                  <Play />
                  {t('workflowCanvas.runSaved', {
                    version: viewVersion ?? definition.savedVersion ?? '—',
                  })}
                </Button>
              </div>
            </div>
            {preparing && (
              <WorkflowVerificationPrepare
                definition={preparing}
                scenariosSupported={capabilities?.scenarios === true}
                workspace={workspacePath}
                args={runArguments}
                disabled={busy || !!loadError || !isCurrent()}
                onClose={() => setPreparing(null)}
                onPrepared={prepared}
              />
            )}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                data-testid="workflow-advanced-toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen(value => !value)}
              >
                <ChevronRight className={advancedOpen ? 'rotate-90' : ''} />
                {t('workflowCanvas.advancedSettings')}
              </Button>
              {advancedOpen && (
                <SettingsDialog
                  title={t('workflowCanvas.advancedSettings')}
                  testId="workflow-settings-dialog"
                  closeLabel={t('workflowCanvas.back')}
                  onClose={() => setAdvancedOpen(false)}
                >
                  <div className="space-y-6 pt-5">
                    <WorkflowVerification
                      definitionId={definition.id}
                      version={metadataVersion}
                      verification={verification}
                      capacity={capacity}
                      loading={metadataLoading}
                      unsupported={capabilities?.verification === false}
                      error={metadataError}
                      disabled={busy || dirty || !!loadError || !isCurrent()}
                      onPrepareVerification={
                        capabilities?.verification ? () => void prepareVerification() : undefined
                      }
                      onLoadMore={() => void moreEvidence()}
                    />
                    <details className="rounded-xl border border-border/60 p-4">
                      <summary
                        data-testid="workflow-management-toggle"
                        className="cursor-pointer text-sm text-text-secondary focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        {t('workflowVerification.management')}
                      </summary>
                      <div className="mt-4 space-y-5">
                        {capabilities?.versionHistory && (
                          <WorkflowVerificationHistory
                            definitionId={definition.id}
                            version={metadataVersion}
                            references={references}
                            loading={metadataLoading}
                            disabled={busy || dirty || !!loadError || !isCurrent()}
                            isCurrent={isCurrent}
                            onInspect={version => void inspectReferences(version)}
                            onArchive={async (version, expectedRevision) => {
                              if (!isCurrent()) return
                              await workflowApi.archiveVersion(
                                serverId,
                                definition.id,
                                version,
                                expectedRevision
                              )
                              if (isCurrent()) {
                                setReferences(null)
                                setVerification(null)
                                setRevisionTick(value => value + 1)
                              }
                            }}
                          />
                        )}
                        {capabilities?.storage && capacity && (
                          <WorkflowVerificationStorage
                            capacity={capacity}
                            disabled={busy || dirty || !!loadError || !isCurrent()}
                            isCurrent={isCurrent}
                            onChangeStorage={async operation => {
                              if (!isCurrent()) return
                              if (operation === 'migrate')
                                await workflowApi.migrateStorage(serverId)
                              else await workflowApi.rollbackStorage(serverId)
                              if (isCurrent()) setRevisionTick(value => value + 1)
                            }}
                          />
                        )}
                        <WorkflowDeleteButton
                          key={definition.id}
                          serverId={serverId}
                          definition={definition}
                          disabled={busy || dirty || !!loadError || viewVersion != null}
                          isCurrent={isCurrent}
                          onDeleted={() => {
                            setSelected(null)
                            setDefinition(null)
                            setSelectedNode(null)
                            setObservedRun(null)
                            setViewVersion(null)
                            setItems(current => current.filter(item => item.id !== definition.id))
                            setOffset(0)
                            setRevisionTick(value => value + 1)
                          }}
                        />
                        <WorkflowLibraryActions
                          serverId={serverId}
                          definition={definition}
                          version={viewVersion}
                          disabled={busy || dirty || !!loadError}
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
                            value={
                              schemaText || JSON.stringify(definition.inputSchema ?? {}, null, 2)
                            }
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
                              !!loadError ||
                              dirty ||
                              viewVersion != null ||
                              !schemaText ||
                              schemaRevision !== definition.revision
                            }
                            onClick={() => {
                              try {
                                const schema: unknown = JSON.parse(schemaText)
                                void mutate(() =>
                                  workflowApi.update(serverId, definition, schema)
                                ).then(ok => {
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
                      </div>
                    </details>
                  </div>
                  <div className="sticky bottom-0 mt-5 flex justify-end border-t border-border/50 bg-popover pt-4">
                    <Button
                      type="button"
                      variant="secondary"
                      data-testid="workflow-settings-done"
                      onClick={() => setAdvancedOpen(false)}
                    >
                      {t('common.close')}
                    </Button>
                  </div>
                </SettingsDialog>
              )}
              <Button
                size="sm"
                variant="ghost"
                data-testid="workflow-run-history-toggle"
                aria-expanded={runHistoryOpen}
                onClick={() => {
                  setRunHistoryOpen(value => !value)
                }}
              >
                <ChevronRight className={runHistoryOpen ? 'rotate-90' : ''} />
                {t('workflowCanvas.runHistory')}
              </Button>
              {runHistoryOpen && (
                <ModalDialog
                  wide
                  title={t('workflowCanvas.runHistory')}
                  testId="workflow-history-dialog"
                  closeLabel={t('workflowCanvas.back')}
                  onClose={() => setRunHistoryOpen(false)}
                >
                  <WorkflowRunPanel
                    serverId={serverId}
                    definitionId={definition.id}
                    latestSavedVersion={
                      capabilities?.checkpointReuse ? definition.savedVersion : null
                    }
                    onSnapshot={setObservedRun}
                    onOpenAgent={onOpenAgent}
                  />
                </ModalDialog>
              )}
            </div>
            <p className="sr-only" aria-live="polite">
              {t('workflowCanvas.nodeCount', { count: definition.nodes.length })}
            </p>
            <div className="flex min-h-96 min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:flex-row">
              <WorkflowCanvas
                definition={definition}
                nodeStates={
                  definition.status === 'saved' &&
                  observedRun?.definitionId === definition.id &&
                  observedRun.version === definition.savedVersion
                    ? observedRun.nodeStates
                    : []
                }
                runId={observedRun?.runId}
                onOpenAgent={onOpenAgent}
                stale={!!loadError}
                selectedId={selectedNode}
                disabled={busy || dirty || !!loadError || viewVersion != null}
                onSelect={id => {
                  if (dirty && id !== selectedNode) {
                    setError(t('workflowCanvas.finishNodeEdit'))
                    return
                  }
                  setSelectedNode(id)
                }}
                onMove={(value, _revision, previous) =>
                  void mutate(() => workflowApi.move(serverId, definition.id, value, previous))
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
                  serverId={serverId}
                  key={`${definition.id}:${node.id}`}
                  definition={definition}
                  node={node}
                  onClose={() => setSelectedNode(null)}
                  busy={busy || !!loadError}
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
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-surface">
              <GitBranch className="size-6 text-text-muted" strokeWidth={1.4} />
            </div>
            <h2 className="heading-sm">{t('workflowCanvas.selectWorkflow')}</h2>
            <p className="max-w-sm text-sm leading-relaxed text-text-muted">
              {t('workflowCanvas.workspaceHint')}
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
