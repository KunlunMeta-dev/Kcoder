import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { desktopHost } from '@/kcoder/desktopHost'
import type {
  StorageLayout,
  StorageLocationSource,
  StorageLocationsBridge,
  StorageMigrationPhase,
  StorageMigrationPlan,
  StorageMigrationReceipt,
  StoragePaths,
  StorageSourceCleanupPreview,
  StorageSourceCleanupResult,
  StorageSourceCleanupReceipt,
} from '@/kcoder/storageLocations'
import { sourceCleanupResult } from '@/kcoder/storageLocations'
import { Database, FolderOpen, HardDrive, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { InfoBox, InputWithIcon, SectionHeader, SettingsGroup, SettingsRow, StatusChip } from './settings-ui'

type Selection = { dataRoot: string; cacheRoot: string }
type BusyAction = 'read' | 'pick-data' | 'pick-cache' | 'preview' | 'migrate' | 'cleanup-preview' | 'cleanup-confirm' | 'cleanup-status' | null

const sourceKeys: Record<StorageLocationSource, string> = {
  default: 'source_default',
  selection: 'source_selection',
  configOverride: 'source_configOverride',
  homeOverride: 'source_homeOverride',
  cacheOverride: 'source_cacheOverride',
  dataOverride: 'source_dataOverride',
  serversStoreOverride: 'source_serversStoreOverride',
  desktopOverride: 'source_desktopOverride',
  development: 'source_development',
}

const phaseKeys: Record<StorageMigrationPhase, string> = {
  planned: 'phase_planned',
  stopping: 'phase_stopping',
  stopped: 'phase_stopped',
  copying: 'phase_copying',
  verifying: 'phase_verifying',
  prepared: 'phase_prepared',
  committed: 'phase_committed',
  verified: 'phase_verified',
}

const layoutKeys: Record<StorageLayout, string> = {
  legacy: 'layout_legacy',
  unified: 'layout_unified',
  custom: 'layout_custom',
}

const domainKeys: Record<string, string> = {
  'persistent-root': 'domain_dataRoot',
  native: 'domain_native',
  gateway: 'domain_gateway',
  desktop: 'domain_desktop',
  cache: 'domain_cacheRoot',
  'cache-root': 'domain_cacheRoot',
}

function formatBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function isComplete(receipt: StorageMigrationReceipt | null | undefined): boolean {
  return receipt?.phase === 'verified' && receipt.disposition === 'complete'
}

function hostBridge(): StorageLocationsBridge | undefined {
  return desktopHost()?.storageLocations
}

function isCurrentHost(bridge: StorageLocationsBridge): boolean {
  return hostBridge() === bridge
}

function currentPaths(paths: StoragePaths): Selection {
  return { dataRoot: paths.dataRoot, cacheRoot: paths.cacheRoot }
}

export function StorageLocationsPanel() {
  const { t } = useTranslation('common')
  const label = useCallback(
    (key: string, options?: Record<string, unknown>) => t(`storageSettings.locations.${key}`, options),
    [t]
  )
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<StorageLocationsBridge['read']>> | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
  const [draft, setDraft] = useState<Selection | null>(null)
  const [plan, setPlan] = useState<StorageMigrationPlan | null>(null)
  const [planDraftRevision, setPlanDraftRevision] = useState<number | null>(null)
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'unchanged'>('idle')
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [cleanup, setCleanup] = useState<StorageSourceCleanupPreview | null>(null)
  const [cleanupResult, setCleanupResult] = useState<StorageSourceCleanupResult | null>(null)
  const [cleanupUnknown, setCleanupUnknown] = useState<{ operationId: string; confirmation: string } | null>(null)
  const [cleanupOperationId, setCleanupOperationId] = useState<string | null>(null)
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false)
  const [readyOperationId, setReadyOperationId] = useState<string | null>(null)
  const readyOperationIdRef = useRef<string | null>(null)
  const cleanupRestored = useRef(false)
  const requestRevision = useRef(0)
  const draftRevision = useRef(0)
  const draftRef = useRef<Selection | null>(null)
  const disposed = useRef(false)

  const refresh = useCallback(async () => {
    const bridge = hostBridge()
    if (!bridge) {
      setSnapshot(null)
      setLoadState('unavailable')
      setBusyAction(null)
      return
    }
    const revision = ++requestRevision.current
    draftRevision.current += 1
    draftRef.current = null
    setDraft(null)
    setPlan(null)
    setPlanDraftRevision(null)
    setPreviewState('idle')
    setConfirmOpen(false)
    setCleanup(null)
    setCleanupConfirmOpen(false)
    setError(null)
    setSnapshot(null)
    setLoadState('loading')
    setBusyAction('read')
    try {
      const next = await bridge.read()
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      setSnapshot(next)
      setLoadState('ready')
      if (!cleanupRestored.current && isComplete(next.operation)) {
        const saved = next.operation?.ownerReceipts?.['source-cleanup'] as StorageSourceCleanupReceipt | undefined
        if ((saved?.version === 1 || saved?.version === 2) && saved.preview?.operationId === next.operation?.plan.operationId &&
          /^[a-f0-9]{64}$/.test(saved.preview.confirmation)) {
          const original = { operationId: saved.preview.operationId, confirmation: saved.preview.confirmation }
          const result = sourceCleanupResult(next.operation, original)
          if (result) setCleanupResult(result)
          else setCleanupUnknown(original)
        }
      }
      cleanupRestored.current = true
      if (
        readyOperationIdRef.current &&
        next.operation?.plan.operationId === readyOperationIdRef.current &&
        isComplete(next.operation)
      ) {
        readyOperationIdRef.current = null
        setReadyOperationId(null)
        setNotice(label('migrationComplete'))
      }
    } catch (failure) {
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      setLoadState('error')
      setError(errorMessage(failure, label))
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge))
        setBusyAction(null)
    }
  }, [label])

  useEffect(() => {
    disposed.current = false
    let active = true
    void Promise.resolve().then(() => { if (active) void refresh() })
    return () => {
      active = false
      disposed.current = true
      requestRevision.current += 1
    }
  }, [refresh])

  const pick = async (kind: 'data' | 'cache') => {
    const bridge = hostBridge()
    if (
      !bridge ||
      !snapshot ||
      snapshot.readOnly ||
      snapshot.operation?.disposition === 'active' ||
      (busyAction !== null && busyAction !== 'preview')
    ) return
    const revision = ++requestRevision.current
    setBusyAction(kind === 'data' ? 'pick-data' : 'pick-cache')
    setError(null)
    try {
      const selected = await bridge.pick({ kind })
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      if (selected == null) return
      const next = {
        ...(draftRef.current ?? currentPaths(snapshot.paths)),
        [kind === 'data' ? 'dataRoot' : 'cacheRoot']: selected,
      }
      draftRevision.current += 1
      draftRef.current = next
      setDraft(next)
      setPlan(null)
      setPlanDraftRevision(null)
      setPreviewState('idle')
      setNotice(null)
    } catch (failure) {
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      setError(errorMessage(failure, label))
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge))
        setBusyAction(null)
    }
  }

  const preview = async () => {
    const bridge = hostBridge()
    const candidate = draftRef.current
    if (!bridge || !snapshot || !candidate || snapshot.readOnly || snapshot.operation?.disposition === 'active') return
    const revision = ++requestRevision.current
    const candidateRevision = draftRevision.current
    setBusyAction('preview')
    setError(null)
    setNotice(null)
    setPlan(null)
    setPlanDraftRevision(null)
    setPreviewState('loading')
    try {
      const next = await bridge.preview(candidate)
      if (
        disposed.current ||
        revision !== requestRevision.current ||
        candidateRevision !== draftRevision.current ||
        !isCurrentHost(bridge)
      ) return
      setPlan(next)
      setPlanDraftRevision(next ? candidateRevision : null)
      setPreviewState(next ? 'ready' : 'unchanged')
    } catch (failure) {
      if (
        disposed.current ||
        revision !== requestRevision.current ||
        candidateRevision !== draftRevision.current ||
        !isCurrentHost(bridge)
      ) return
      setPreviewState('idle')
      setError(errorMessage(failure, label))
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge))
        setBusyAction(null)
    }
  }

  const beginMigration = async () => {
    const bridge = hostBridge()
    if (
      !bridge ||
      !snapshot ||
      snapshot.readOnly ||
      snapshot.operation?.disposition === 'active' ||
      !plan ||
      planDraftRevision !== draftRevision.current
    ) return
    const revision = ++requestRevision.current
    const operationId = plan.operationId
    const retryOriginal = snapshot.operation?.disposition === 'deferred' &&
      snapshot.operation.plan.operationId === operationId
    setBusyAction('migrate')
    setError(null)
    try {
      const result = await (retryOriginal ? bridge.retry({ operationId }) : bridge.migrate({ operationId }))
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      if (!result || result.operationId !== operationId) {
        setConfirmOpen(false)
        setNotice(label('migrationOutcomeUnknown'))
        void refresh()
        return
      }
      setConfirmOpen(false)
      setDraft(null)
      draftRef.current = null
      draftRevision.current += 1
      setPlan(null)
      setPlanDraftRevision(null)
      setPreviewState('idle')
      if (result.state === 'cancelled') {
        setNotice(label('migrationCancelled'))
      } else if (result.state === 'ready') {
        readyOperationIdRef.current = operationId
        setReadyOperationId(operationId)
        setNotice(label('handoffReady'))
      } else {
        setNotice(label('migrationOutcomeUnknown'))
      }
      void refresh()
    } catch (failure) {
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      setConfirmOpen(false)
      setError(errorMessage(failure, label))
      setNotice(label('refreshBeforeRetry'))
      setPlan(null)
      setPlanDraftRevision(null)
      setPreviewState('idle')
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge))
        setBusyAction(null)
    }
  }

  const previewCleanup = async () => {
    const bridge = hostBridge()
    const operationId = cleanupUnknown?.operationId ?? cleanupOperationId ?? snapshot?.operation?.plan.operationId
    if (!bridge || !snapshot || snapshot.readOnly || busyAction || !operationId) return
    const revision = ++requestRevision.current
    setBusyAction('cleanup-preview')
    setCleanup(null)
    setCleanupResult(null)
    setError(null)
    try {
      const next = await bridge.cleanupPreview({ operationId })
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      if (next.operationId !== operationId || (next.pending && cleanupUnknown && next.confirmation !== cleanupUnknown.confirmation))
        throw new Error('STORAGE_SOURCE_CLEANUP_UNKNOWN')
      setCleanup(next)
      setCleanupUnknown(next.pending ? { operationId: next.operationId, confirmation: next.confirmation } : null)
    } catch (failure) {
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      setError(errorMessage(failure, label))
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge)) setBusyAction(null)
    }
  }

  const checkCleanup = async (original = cleanupUnknown) => {
    const bridge = hostBridge()
    if (!bridge || !original || busyAction) return
    const revision = ++requestRevision.current
    setBusyAction('cleanup-status')
    setError(null)
    try {
      const receipt = await bridge.cleanupStatus({ operationId: original.operationId })
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      const result = sourceCleanupResult(receipt, original)
      if (result) {
        setCleanupResult(result)
        setCleanupUnknown(null)
        setCleanup(null)
      }
    } catch (failure) {
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      setError(errorMessage(failure, label))
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge)) setBusyAction(null)
    }
  }

  const confirmCleanup = async () => {
    const bridge = hostBridge()
    if (!bridge || !cleanup || !snapshot || snapshot.readOnly || busyAction) return
    const original = { operationId: cleanup.operationId, confirmation: cleanup.confirmation }
    const revision = ++requestRevision.current
    setBusyAction('cleanup-confirm')
    setError(null)
    try {
      const result = await bridge.cleanupConfirm(original)
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      if (result.operationId !== original.operationId || result.confirmation !== original.confirmation)
        throw new Error('STORAGE_SOURCE_CLEANUP_UNKNOWN')
      setCleanupResult(result)
      setCleanupUnknown(null)
      setCleanup(null)
    } catch (failure) {
      if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
      if ((failure as { code?: unknown } | null)?.code === 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' ||
        (failure instanceof Error && failure.message.includes('STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED'))) {
        setCleanupUnknown(null)
        setCleanup(null)
        setError(errorMessage(failure, label))
        return
      }
      setCleanupUnknown(original)
      setCleanup(null)
      setError(errorMessage(failure, label))
      // A lost reply can follow deletion. Read that same receipt once; never
      // replay cleanup or mint another operation in response to transport loss.
      try {
        const receipt = await bridge.cleanupStatus({ operationId: original.operationId })
        if (disposed.current || revision !== requestRevision.current || !isCurrentHost(bridge)) return
        const result = sourceCleanupResult(receipt, original)
        if (result) { setCleanupResult(result); setCleanupUnknown(null); setError(null) }
      } catch { /* The original ID remains available for an explicit receipt read. */ }
    } finally {
      if (!disposed.current && revision === requestRevision.current && isCurrentHost(bridge)) {
        setCleanupConfirmOpen(false)
        setBusyAction(null)
      }
    }
  }

  const operation = snapshot?.operation ?? null
  const isActiveOperation = operation?.disposition === 'active'
  const canChoose = Boolean(snapshot && !snapshot.readOnly && !isActiveOperation && !cleanupUnknown)
  const canConfirm = Boolean(
    snapshot && !snapshot.readOnly && !isActiveOperation && !cleanupUnknown && plan && planDraftRevision !== null
  )
  const locationRows = snapshot
    ? [
        { key: 'dataRoot', path: snapshot.paths.dataRoot, source: snapshot.paths.sources.dataRoot },
        { key: 'cacheRoot', path: snapshot.paths.cacheRoot, source: snapshot.paths.sources.cacheRoot },
        { key: 'gatewayRoot', path: snapshot.paths.gatewayRoot, source: snapshot.paths.sources.gatewayRoot },
        { key: 'desktopRoot', path: snapshot.paths.desktopRoot, source: snapshot.paths.sources.desktopRoot },
        { key: 'temporaryRoot', path: snapshot.paths.temporaryRoot, source: null },
      ]
    : []
  const cleanupEntries = cleanupResult?.entries ?? cleanup?.entries ?? []
  const cleanupEligible = cleanupEntries.filter(entry => entry.status === 'eligibleFile' || entry.status === 'eligibleDirectory').length
  const cleanupRemoved = cleanupEntries.filter(entry => entry.status === 'removed').length
  const cleanupRetained = cleanupEntries.filter(entry => entry.status.startsWith('retained')).length

  return (
    <>
      <section
        data-testid="storage-locations-panel"
        aria-label={label('title')}
        aria-busy={busyAction !== null}
        className="space-y-4"
      >
        <SectionHeader
          icon={<HardDrive />}
          title={label('title')}
          description={label('description')}
        />

        {loadState === 'unavailable' && (
          <InfoBox data-testid="storage-locations-desktop-only" icon={<Database />}>
            {label('desktopOnly')}
          </InfoBox>
        )}
        {loadState === 'loading' && (
          <div data-testid="storage-locations-loading" role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {label('loading')}
          </div>
        )}
        {loadState === 'error' && (
          <div role="alert" data-testid="storage-locations-error" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
            <span>{error ?? label('loadFailed')}</span>
            <Button data-testid="storage-location-retry" variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />
              {label('refresh')}
            </Button>
          </div>
        )}

        {snapshot && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2" data-testid="storage-location-layout">
                <span className="text-xs text-text-secondary">{label('layoutLabel')}</span>
                <StatusChip>{label(layoutKeys[snapshot.paths.layout])}</StatusChip>
                {snapshot.paths.selectionRevision != null && (
                  <span className="text-xs text-text-muted">{label('revision', { revision: snapshot.paths.selectionRevision })}</span>
                )}
              </div>
              <Button
                data-testid="storage-location-refresh"
                variant="outline"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => void refresh()}
              >
                {busyAction === 'read' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {label('refresh')}
              </Button>
            </div>

            <SettingsGroup aria-label={label('actualLocations')} data-testid="storage-location-actual-paths">
              {locationRows.map(({ key, path, source }) => (
                <SettingsRow
                  key={key}
                  data-testid={`storage-location-path-${key}`}
                  label={label(key)}
                  description={<code className="block break-all font-mono text-xs text-text-secondary" title={path}>{path}</code>}
                  className="py-3"
                  control={source ? <StatusChip>{label(sourceKeys[source] ?? 'source_unknown')}</StatusChip> : undefined}
                />
              ))}
            </SettingsGroup>

            {snapshot.readOnly && (
              <InfoBox data-testid="storage-locations-readonly" icon={<FolderOpen />}>
                {snapshot.paths.externallyConfigured ? label('overrideReadOnly') : label('instanceReadOnly')}
              </InfoBox>
            )}

            {operation && (
              <div
                data-testid="storage-location-operation"
                role="status"
                className="rounded-lg border border-border/60 bg-surface/30 p-3 text-sm"
              >
                <p className="font-medium text-text-primary">
                  {isComplete(operation)
                    ? label('migrationComplete')
                    : operation.disposition === 'deferred'
                      ? label('operationDeferred')
                      : label(phaseKeys[operation.phase] ?? 'operationUnknown')}
                </p>
                {operation.errorCode && <p className="mt-1 break-words text-text-secondary">{label('operationNeedsAttention', { code: operation.errorCode })}</p>}
                <p className="mt-1 break-all text-xs text-text-muted">{label('operationId', { id: operation.plan.operationId })}</p>
                {operation.disposition === 'deferred' && !snapshot.readOnly && (
                  <Button data-testid="storage-location-retry-original" variant="outline" size="sm"
                    className="mt-3" disabled={busyAction !== null} onClick={() => {
                      const original = operation.plan
                      const selection = { dataRoot: original.target.dataRoot, cacheRoot: original.target.cacheRoot }
                      draftRevision.current += 1
                      draftRef.current = selection
                      setDraft(selection)
                      setPlan(original)
                      setPlanDraftRevision(draftRevision.current)
                      setPreviewState('ready')
                      setError(null)
                      setNotice(null)
                      setConfirmOpen(true)
                    }}>
                    {label('retryOriginal')}
                  </Button>
                )}
              </div>
            )}

            {readyOperationId &&
              (!operation || operation.plan.operationId === readyOperationId) &&
              !isComplete(operation) && (
              <p role="status" data-testid="storage-location-handoff-ready" className="text-sm text-text-secondary">
                {label('handoffReady')}
              </p>
            )}
            {notice && <p role="status" data-testid="storage-location-notice" className="text-sm text-text-secondary">{notice}</p>}
            {error && loadState === 'ready' && <p role="alert" data-testid="storage-location-action-error" className="break-words text-sm text-destructive">{error}</p>}

            <InfoBox data-testid="storage-location-backup-scope" title={label('backupTitle')} icon={<Database />}>
              <p>{label('backupScope')}</p>
              <p className="mt-1">{label('backupLimit')}</p>
            </InfoBox>

            {!snapshot.readOnly && !isActiveOperation && (isComplete(operation) || cleanupUnknown) && (
              <section data-testid="storage-source-cleanup" aria-label={label('cleanupTitle')} className="space-y-3 rounded-2xl border border-border/60 bg-surface/30 p-5">
                <h3 className="heading-sm text-text-primary">{label('cleanupTitle')}</h3>
                <p className="text-sm text-text-secondary">{label('cleanupDescription')}</p>
                <details>
                  <summary data-testid="storage-cleanup-original-operation" className="cursor-pointer text-sm text-text-secondary">{label('cleanupOriginalOperation')}</summary>
                  <label className="mt-2 block space-y-2 text-sm">
                    <span>{label('cleanupOperationId')}</span>
                    <InputWithIcon icon={<Database className="size-4" />} data-testid="storage-cleanup-operation-id"
                      value={cleanupUnknown?.operationId ?? cleanupOperationId ?? operation?.plan.operationId ?? ''}
                      disabled={busyAction !== null || cleanupUnknown !== null}
                      onChange={event => { setCleanupOperationId(event.target.value); setCleanup(null); setCleanupResult(null) }} />
                  </label>
                </details>
                {cleanupUnknown && (
                  <InfoBox data-testid="storage-cleanup-unknown">
                    <p>{label('cleanupUnknown')}</p>
                    <p className="mt-1 break-all text-xs">{label('operationId', { id: cleanupUnknown.operationId })}</p>
                  </InfoBox>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button data-testid="storage-cleanup-preview" variant="outline" disabled={busyAction !== null} onClick={() => void previewCleanup()}>
                    {busyAction === 'cleanup-preview' && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {label(busyAction === 'cleanup-preview' ? 'cleanupPreviewing' : 'cleanupPreview')}
                  </Button>
                  {cleanupUnknown && (
                    <Button data-testid="storage-cleanup-status" variant="outline" disabled={busyAction !== null} onClick={() => void checkCleanup()}>
                      {label('cleanupCheckReceipt')}
                    </Button>
                  )}
                </div>
                {(cleanup || cleanupResult) && (
                  <div data-testid={cleanupResult ? 'storage-cleanup-result' : 'storage-cleanup-plan'} className="space-y-3">
                    <p role="status" className="text-sm text-text-primary">
                      {cleanupResult ? label('cleanupResult', { removed: cleanupRemoved, retained: cleanupRetained })
                        : label('cleanupSummary', { eligible: cleanupEligible, retained: cleanupRetained })}
                    </p>
                    <p className="break-all text-xs text-text-secondary">{label('operationId', { id: cleanupResult?.operationId ?? cleanup?.operationId })}</p>
                    {cleanup?.pending && <p className="text-sm text-text-secondary">{label('cleanupPending')}</p>}
                    <details>
                      <summary data-testid="storage-cleanup-entry-details" className="cursor-pointer text-sm text-text-secondary">{label('cleanupDetails')}</summary>
                      <ul data-testid="storage-cleanup-entries" className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                        {cleanupEntries.map((entry, index) => (
                          <li key={`${entry.domain}:${entry.relativePath}:${index}`} className="border-b border-border/50 pb-2">
                            <p className="break-all font-mono text-xs text-text-secondary">{entry.relativePath ? `${entry.sourceRoot.replace(/[\\/]$/, '')}${entry.sourceRoot.includes('\\') ? '\\' : '/'}${entry.relativePath}` : entry.sourceRoot}</p>
                            <span className="text-xs text-text-muted">{label(`cleanupStatus_${entry.status}`)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                    {cleanup && (cleanupEligible > 0 || cleanup.pending) && (
                      <Button data-testid="storage-cleanup-confirm" variant="destructive" disabled={busyAction !== null} onClick={() => setCleanupConfirmOpen(true)}>
                        {label('cleanupConfirm')}
                      </Button>
                    )}
                  </div>
                )}
              </section>
            )}

            {canChoose && (
              <div className="space-y-3" data-testid="storage-location-selection">
                <div className="grid gap-3 md:grid-cols-2">
                  {(['data', 'cache'] as const).map(kind => {
                    const path = draft?.[kind === 'data' ? 'dataRoot' : 'cacheRoot'] ??
                      snapshot.paths[kind === 'data' ? 'dataRoot' : 'cacheRoot']
                    return (
                      <SettingsRow
                        key={kind}
                        label={label(kind === 'data' ? 'dataRoot' : 'cacheRoot')}
                        description={<code className="block break-all font-mono text-xs text-text-secondary" title={path}>{draft ? path : label('chooseHint')}</code>}
                        control={(
                          <Button
                            data-testid={`storage-location-pick-${kind}`}
                            variant="outline"
                            size="sm"
                            className="max-md:min-h-11"
                            disabled={busyAction !== null && busyAction !== 'preview'}
                            onClick={() => void pick(kind)}
                          >
                            <FolderOpen aria-hidden="true" />
                            {busyAction === `pick-${kind}` ? label('picking') : label('choose')}
                          </Button>
                        )}
                        className="rounded-xl border border-border/50 bg-surface/20 p-3"
                      />
                    )
                  })}
                </div>
                <p className="text-sm text-text-secondary">{label('selectionHint')}</p>
                {draft && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      data-testid="storage-location-preview"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={() => void preview()}
                    >
                      {busyAction === 'preview' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Database aria-hidden="true" />}
                      {busyAction === 'preview' ? label('previewing') : label('preview')}
                    </Button>
                    <Button
                      data-testid="storage-location-discard"
                      variant="ghost"
                      disabled={busyAction !== null}
                      onClick={() => {
                        draftRevision.current += 1
                        draftRef.current = null
                        setDraft(null)
                        setPlan(null)
                        setPlanDraftRevision(null)
                        setPreviewState('idle')
                        setError(null)
                      }}
                    >
                      {label('discard')}
                    </Button>
                  </div>
                )}
                {previewState === 'unchanged' && (
                  <p role="status" data-testid="storage-location-no-change" className="text-sm text-text-secondary">{label('noChange')}</p>
                )}
              </div>
            )}

            {isActiveOperation && (
              <InfoBox data-testid="storage-location-active-operation">
                {label('operationActive')}
              </InfoBox>
            )}

            {plan && previewState === 'ready' && planDraftRevision !== null && (
              <section data-testid="storage-location-plan" aria-label={label('previewTitle')} className="space-y-3 rounded-2xl border border-border/60 bg-surface/30 p-5">
                <h3 className="heading-sm text-text-primary">{label('previewTitle')}</h3>
                <dl className="grid gap-3 text-sm md:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-xs text-text-secondary">{label('currentDataRoot')}</dt>
                    <dd className="mt-1 break-all font-mono text-xs">{plan.from.dataRoot}</dd>
                    <dd className="mt-1 break-all font-mono text-xs text-text-secondary">{label('targetPath', { path: plan.target.dataRoot })}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-text-secondary">{label('currentCacheRoot')}</dt>
                    <dd className="mt-1 break-all font-mono text-xs">{plan.from.cacheRoot}</dd>
                    <dd className="mt-1 break-all font-mono text-xs text-text-secondary">{label('targetPath', { path: plan.target.cacheRoot })}</dd>
                  </div>
                </dl>
                <div>
                  <h4 className="text-sm font-medium text-text-primary">{label('planComponents')}</h4>
                  {plan.components.length > 0 ? (
                    <ul className="mt-2 space-y-2">
                      {plan.components.map((component, index) => {
                        const estimatedSize = formatBytes(component.estimatedBytes)
                        return (
                          <li key={`${component.domain}:${component.source}:${component.destination}:${index}`} className="rounded-lg border border-border/50 bg-background/40 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium">{label(Object.hasOwn(domainKeys, component.domain) ? domainKeys[component.domain] : 'domain_other')}</span>
                              {estimatedSize && <span className="text-xs text-text-secondary">{estimatedSize}</span>}
                            </div>
                            <p className="mt-1 break-all font-mono text-xs text-text-secondary">{component.source}</p>
                            <p className="mt-1 break-all font-mono text-xs text-text-secondary">{label('targetPath', { path: component.destination })}</p>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-text-secondary">{label('noComponents')}</p>
                  )}
                </div>
                <InfoBox icon={<HardDrive />}>{label('fullStopImpact')}</InfoBox>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    data-testid="storage-location-stop-migrate"
                    disabled={!canConfirm || busyAction !== null}
                    onClick={() => setConfirmOpen(true)}
                  >
                    {label('stopAndMigrate')}
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
      </section>

      {confirmOpen && plan && (
        <ModalDialog
          title={label('confirmTitle')}
          testId="storage-location-confirm"
          pending={busyAction === 'migrate'}
          onClose={() => setConfirmOpen(false)}
          closeLabel={label('close')}
        >
          <div className="mt-4 space-y-4">
            <p className="text-sm leading-relaxed text-text-primary">{label('confirmDescription')}</p>
            <InfoBox icon={<HardDrive />}>{label('fullStopImpact')}</InfoBox>
            <InfoBox>{label('sourcePreserved')}</InfoBox>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
              <Button data-testid="storage-location-confirm-cancel" variant="outline" disabled={busyAction === 'migrate'} onClick={() => setConfirmOpen(false)}>
                {label('cancel')}
              </Button>
              <Button data-testid="storage-location-confirm-submit" disabled={busyAction === 'migrate'} onClick={() => void beginMigration()}>
                {busyAction === 'migrate' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {busyAction === 'migrate' ? label('migrating') : label('confirmStopAndMigrate')}
              </Button>
            </div>
          </div>
        </ModalDialog>
      )}
      {cleanupConfirmOpen && cleanup && (
        <ModalDialog title={label('cleanupConfirmTitle')} testId="storage-cleanup-confirm-dialog"
          pending={busyAction === 'cleanup-confirm'} onClose={() => setCleanupConfirmOpen(false)} closeLabel={label('close')}>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-text-primary">{label('cleanupConfirmDescription', { count: cleanupEligible })}</p>
            <p className="break-all text-xs text-text-secondary">{label('operationId', { id: cleanup.operationId })}</p>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
              <Button data-testid="storage-cleanup-cancel" variant="outline" disabled={busyAction === 'cleanup-confirm'} onClick={() => setCleanupConfirmOpen(false)}>{label('cancel')}</Button>
              <Button data-testid="storage-cleanup-submit" variant="destructive" disabled={busyAction === 'cleanup-confirm'} onClick={() => void confirmCleanup()}>
                {busyAction === 'cleanup-confirm' && <Loader2 className="animate-spin" aria-hidden="true" />}
                {label(busyAction === 'cleanup-confirm' ? 'cleanupDeleting' : 'cleanupDelete')}
              </Button>
            </div>
          </div>
        </ModalDialog>
      )}
    </>
  )
}

function errorMessage(failure: unknown, label: (key: string, options?: Record<string, unknown>) => string): string {
  const error = failure as { code?: unknown; message?: unknown } | null
  const code = typeof error?.code === 'string' ? error.code : null
  const message = typeof error?.message === 'string' ? error.message : String(failure)
  if ([
    'CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE',
    'CREDENTIAL_RELOCATION_KEYRING_ENTRY_MISSING',
    'CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED',
  ].some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('credentialAccessRequired')
  if ([
    'SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED',
    'SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED',
  ].some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('serviceRelocationUnsupported')
  if (code === 'STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED' || message.includes('STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED'))
    return label('internalReferenceUnsupported')
  if (code === 'STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED' || message.includes('STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED'))
    return label('managedWorktreeAliasUnsupported')
  if (['STORAGE_GATEWAY_REFERENCE_METADATA_INVALID', 'STORAGE_GATEWAY_REFERENCE_METADATA_TOO_LARGE']
    .some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('referenceMetadataUnavailable')
  if (code === 'STORAGE_PREVIEW_CHANGED' || message.includes('STORAGE_PREVIEW_CHANGED'))
    return label('previewChanged')
  if (code === 'STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT' || message.includes('STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT'))
    return label('cleanupLimit')
  if (code === 'STORAGE_WRITERS_ACTIVE' || message.includes('STORAGE_WRITERS_ACTIVE'))
    return label('cleanupWritersActive')
  if (code === 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' || message.includes('STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED'))
    return label('cleanupPreviewChanged')
  if ([
    'STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED', 'STORAGE_LEGACY_ENTRY_OWNER_UNKNOWN',
    'STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED', 'STORAGE_LEGACY_ENTRY_KIND_MISMATCH',
    'STORAGE_LEGACY_CONTROL_PAYLOAD_UNCONFIRMED',
    'STORAGE_LEGACY_REGISTRATION_INVALID', 'STORAGE_LEGACY_REGISTERED_CATALOG_UNSUPPORTED', 'STORAGE_LEGACY_SOURCE_CONFLICT',
  ].some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('legacySourceUnsupported')
  if (['STORAGE_LEGACY_SOURCE_CHANGED', 'STORAGE_TREE_MANIFEST_UNKNOWN', 'STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED']
    .some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('sourceChanged')
  if (code === 'STORAGE_TARGET_NOT_EMPTY' || message.includes('STORAGE_TARGET_NOT_EMPTY'))
    return label('targetNotEmpty')
  if (code === 'STORAGE_BROWSER_PROFILE_PATH_TOO_LONG' || message.includes('STORAGE_BROWSER_PROFILE_PATH_TOO_LONG'))
    return label('desktopPathTooLong')
  if (code === 'STORAGE_INSUFFICIENT_SPACE' || message.includes('STORAGE_INSUFFICIENT_SPACE'))
    return label('insufficientSpace')
  if (['STORAGE_SOURCE_TARGET_OVERLAP', 'STORAGE_ROOTS_OVERLAP']
    .some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('rootsOverlap')
  if (['STORAGE_RECORD_UNAVAILABLE', 'STORAGE_LEGACY_REGISTRATION_UNAVAILABLE']
    .some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('recordUnavailable')
  if (code === 'STORAGE_OWNER_RUNTIME_REQUIRED' || message.includes('STORAGE_OWNER_RUNTIME_REQUIRED'))
    return label('ownerRuntimeRequired')
  if (['STORAGE_SOURCE_CLEANUP_NOT_COMPLETE', 'STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN', 'STORAGE_SOURCE_CLEANUP_UNKNOWN']
    .some(safeCode => code === safeCode || message.includes(safeCode)))
    return label('cleanupUnconfirmed')
  return label('operationFailed', { message })
}
