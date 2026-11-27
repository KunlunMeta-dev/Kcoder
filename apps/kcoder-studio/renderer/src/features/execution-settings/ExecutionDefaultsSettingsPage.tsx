import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw, Save, Server, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { GatewayRpcError, isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { navigateTo } from '@/lib/navigation'
import {
  EXECUTION_PERMISSION_MODES,
  isExecutionDefaultsUnsupported,
  readExecutionDefaults,
  saveExecutionDefaults,
  type ExecutionDefaults,
  type ExecutionPermissionMode,
} from './executionSettingsApi'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { IconSelect, SettingsPage, SettingsPageHeader } from '@/components/settings/settings-ui'

const permissionModeLabels: Record<ExecutionPermissionMode, string> = {
  ask: 'workbench.permission_mode_ask',
  auto: 'workbench.permission_mode_auto',
  accept_edits: 'workbench.permission_mode_accept_edits',
  dont_ask: 'workbench.permission_mode_dont_ask',
  bypass: 'workbench.permission_mode_bypass',
  yolo: 'workbench.permission_mode_yolo',
}

function targetLabel(target: GatewayServer): string {
  return target.label ? `${target.label} (${target.id})` : target.id
}

function hasUnknownWriteOutcome(error: unknown): boolean {
  return !(error instanceof GatewayRpcError) || error.reason !== 'remote'
}

interface PendingPermissionWrite {
  inFlight: boolean
  targetId: string
  permissionMode: ExecutionPermissionMode | null
  draftRevision: number
}

interface PermissionSettingsSnapshot {
  defaults: ExecutionDefaults | null
  draft: ExecutionPermissionMode | ''
  draftRevision: number
  pendingWrite: PendingPermissionWrite | null
  reconciledMismatch: boolean
  saveConfirmed: boolean
  saveConfirmedWithNewerDraft: boolean
}

type PermissionSnapshotPublisher = (
  targetScope: string,
  snapshot: PermissionSettingsSnapshot,
  expectedPendingWrite?: PendingPermissionWrite
) => void

function ExecutionPermissionDefaults({
  serverId,
  targetScope,
  initialSnapshot,
  onSnapshotChange,
}: {
  serverId: string
  targetScope: string
  initialSnapshot?: PermissionSettingsSnapshot
  onSnapshotChange: PermissionSnapshotPublisher
}) {
  const { t } = useTranslation('common')
  const initialPendingWrite =
    initialSnapshot?.pendingWrite?.targetId === serverId ? initialSnapshot.pendingWrite : null
  const [defaults, setDefaults] = useState<ExecutionDefaults | null>(
    initialSnapshot?.defaults ?? null
  )
  const [draft, setDraft] = useState<ExecutionPermissionMode | ''>(initialSnapshot?.draft ?? '')
  const [saving, setSaving] = useState(initialPendingWrite?.inFlight ?? false)
  const [outcomeUnknown, setOutcomeUnknown] = useState(
    Boolean(initialPendingWrite && !initialPendingWrite.inFlight)
  )
  const [reconciledMismatch, setReconciledMismatch] = useState(
    initialSnapshot?.reconciledMismatch ?? false
  )
  const [saveConfirmed, setSaveConfirmed] = useState(initialSnapshot?.saveConfirmed ?? false)
  const [saveConfirmedWithNewerDraft, setSaveConfirmedWithNewerDraft] = useState(
    initialSnapshot?.saveConfirmedWithNewerDraft ?? false
  )
  const [error, setError] = useState<'load' | 'save' | 'unsupported' | null>(null)
  const [reload, setReload] = useState(0)
  const [completedReload, setCompletedReload] = useState<number | null>(null)
  const [verifiedReload, setVerifiedReload] = useState<number | null>(null)
  const loading = completedReload !== reload
  const baselineVerified = verifiedReload === reload
  const requestGeneration = useRef(0)
  const draftRevision = useRef(initialSnapshot?.draftRevision ?? 0)
  const draftRef = useRef<ExecutionPermissionMode | ''>(initialSnapshot?.draft ?? '')
  const savingRef = useRef(initialPendingWrite?.inFlight ?? false)
  const savingOwnerRef = useRef<object | null>(null)
  const pendingWrite = useRef<PendingPermissionWrite | null>(initialPendingWrite)
  const snapshotRef = useRef<PermissionSettingsSnapshot>({
    defaults: initialSnapshot?.defaults ?? null,
    draft: initialSnapshot?.draft ?? '',
    draftRevision: initialSnapshot?.draftRevision ?? 0,
    pendingWrite: initialPendingWrite,
    reconciledMismatch: initialSnapshot?.reconciledMismatch ?? false,
    saveConfirmed: initialSnapshot?.saveConfirmed ?? false,
    saveConfirmedWithNewerDraft: initialSnapshot?.saveConfirmedWithNewerDraft ?? false,
  })
  const publishSnapshot = useCallback(
    (patch: Partial<PermissionSettingsSnapshot>, expectedPendingWrite?: PendingPermissionWrite) => {
      const nextSnapshot = { ...snapshotRef.current, ...patch }
      snapshotRef.current = nextSnapshot
      onSnapshotChange(targetScope, nextSnapshot, expectedPendingWrite)
    },
    [onSnapshotChange, targetScope]
  )
  const previousSnapshot = useRef(initialSnapshot)
  useEffect(() => {
    if (previousSnapshot.current === initialSnapshot) return
    previousSnapshot.current = initialSnapshot
    if (!initialSnapshot || initialSnapshot === snapshotRef.current) return
    snapshotRef.current = initialSnapshot
    pendingWrite.current = initialSnapshot.pendingWrite
    draftRevision.current = initialSnapshot.draftRevision
    draftRef.current = initialSnapshot.draft
    setDefaults(initialSnapshot.defaults)
    setDraft(initialSnapshot.draft)
    setReconciledMismatch(initialSnapshot.reconciledMismatch)
    setSaveConfirmed(initialSnapshot.saveConfirmed)
    setSaveConfirmedWithNewerDraft(initialSnapshot.saveConfirmedWithNewerDraft)
    savingRef.current = initialSnapshot.pendingWrite?.inFlight ?? false
    setSaving(savingRef.current)
    setOutcomeUnknown(
      Boolean(initialSnapshot.pendingWrite && !initialSnapshot.pendingWrite.inFlight)
    )
    setReload(value => value + 1)
  }, [initialSnapshot])

  useEffect(() => {
    let cancelled = false
    const generation = ++requestGeneration.current
    const pendingAtRead = pendingWrite.current?.targetId === serverId ? pendingWrite.current : null
    if (pendingAtRead?.inFlight) {
      setCompletedReload(reload)
      return () => {
        requestGeneration.current += 1
      }
    }
    const draftAtRead = draftRef.current
    const baselineAtRead = snapshotRef.current.defaults?.persistedPermissionMode ?? ''
    const revisionAtRead = draftRevision.current
    const preserveDraftAtRead =
      snapshotRef.current.defaults !== null && draftAtRead !== baselineAtRead

    void readExecutionDefaults(serverId, { targetScope })
      .then(result => {
        if (cancelled || requestGeneration.current !== generation) return
        setDefaults(result)
        setVerifiedReload(reload)
        setError(null)
        const persistedMode = result.persistedPermissionMode ?? ''
        let nextReconciledMismatch: boolean
        let nextSaveConfirmed: boolean
        let nextSaveConfirmedWithNewerDraft: boolean
        if (pendingAtRead) {
          pendingWrite.current = null
          const submittedMode = pendingAtRead.permissionMode ?? ''
          const matchesWrite = persistedMode === submittedMode
          const newerDraft = draftRevision.current !== pendingAtRead.draftRevision
          nextReconciledMismatch = !matchesWrite && persistedMode !== draftRef.current
          nextSaveConfirmed = matchesWrite && !newerDraft
          nextSaveConfirmedWithNewerDraft = matchesWrite && newerDraft
          setOutcomeUnknown(false)
          setReconciledMismatch(nextReconciledMismatch)
          setSaveConfirmed(nextSaveConfirmed)
          setSaveConfirmedWithNewerDraft(nextSaveConfirmedWithNewerDraft)
          if (matchesWrite && !newerDraft) {
            draftRef.current = persistedMode
            setDraft(persistedMode)
          }
        } else {
          const preserveDraft = preserveDraftAtRead || draftRevision.current !== revisionAtRead
          const confirmedSameValue =
            snapshotRef.current.saveConfirmed && baselineAtRead === persistedMode && !preserveDraft
          nextReconciledMismatch =
            preserveDraft &&
            persistedMode !== draftRef.current &&
            snapshotRef.current.reconciledMismatch
          nextSaveConfirmed = confirmedSameValue
          nextSaveConfirmedWithNewerDraft =
            baselineAtRead === persistedMode &&
            preserveDraft &&
            snapshotRef.current.saveConfirmedWithNewerDraft
          if (!preserveDraft) {
            draftRef.current = persistedMode
            setDraft(persistedMode)
          }
          setOutcomeUnknown(false)
          setReconciledMismatch(nextReconciledMismatch)
          setSaveConfirmed(nextSaveConfirmed)
          setSaveConfirmedWithNewerDraft(nextSaveConfirmedWithNewerDraft)
        }
        publishSnapshot(
          {
            defaults: result,
            draft: draftRef.current,
            draftRevision: draftRevision.current,
            pendingWrite: pendingWrite.current,
            reconciledMismatch: nextReconciledMismatch,
            saveConfirmed: nextSaveConfirmed,
            saveConfirmedWithNewerDraft: nextSaveConfirmedWithNewerDraft,
          },
          pendingAtRead ?? undefined
        )
      })
      .catch(fetchError => {
        if (cancelled || requestGeneration.current !== generation) return
        if (pendingAtRead) {
          setOutcomeUnknown(true)
          publishSnapshot(
            {
              draft: draftRef.current,
              draftRevision: draftRevision.current,
              pendingWrite: pendingAtRead,
            },
            pendingAtRead
          )
        } else {
          setError(isExecutionDefaultsUnsupported(fetchError) ? 'unsupported' : 'load')
        }
      })
      .finally(() => {
        if (!cancelled && requestGeneration.current === generation) {
          setCompletedReload(reload)
        }
      })

    return () => {
      cancelled = true
      requestGeneration.current += 1
    }
  }, [publishSnapshot, serverId, targetScope, reload])

  const retry = () => setReload(value => value + 1)
  const save = async () => {
    if (
      loading ||
      savingRef.current ||
      !baselineVerified ||
      outcomeUnknown ||
      error === 'unsupported' ||
      !defaults
    )
      return
    const targetId = serverId
    const generation = requestGeneration.current
    const revision = draftRevision.current
    const nextMode = draftRef.current === '' ? null : draftRef.current
    const operation = {}
    const pending = {
      inFlight: true,
      targetId,
      permissionMode: nextMode,
      draftRevision: revision,
    }
    pendingWrite.current = pending
    publishSnapshot({
      defaults,
      draft: draftRef.current,
      draftRevision: revision,
      pendingWrite: pending,
      reconciledMismatch: false,
      saveConfirmed: false,
      saveConfirmedWithNewerDraft: false,
    })
    savingRef.current = true
    savingOwnerRef.current = operation
    setSaving(true)
    setError(null)
    setSaveConfirmed(false)
    setSaveConfirmedWithNewerDraft(false)
    setReconciledMismatch(false)
    try {
      const result = await saveExecutionDefaults(targetId, nextMode, { targetScope })
      const persistedMode = result.persistedPermissionMode ?? ''
      const submittedMode = nextMode ?? ''
      const matchesWrite = persistedMode === submittedMode
      const newerDraft = draftRevision.current !== revision
      const nextDraft = matchesWrite && !newerDraft ? persistedMode : draftRef.current
      pendingWrite.current = null
      publishSnapshot(
        {
          defaults: result,
          draft: nextDraft,
          draftRevision: draftRevision.current,
          pendingWrite: null,
          reconciledMismatch: !matchesWrite,
          saveConfirmed: matchesWrite && !newerDraft,
          saveConfirmedWithNewerDraft: matchesWrite && newerDraft,
        },
        pending
      )
      if (requestGeneration.current !== generation) return
      setDefaults(result)
      setVerifiedReload(reload)
      setReconciledMismatch(!matchesWrite)
      setSaveConfirmed(matchesWrite && !newerDraft)
      setSaveConfirmedWithNewerDraft(matchesWrite && newerDraft)
      if (matchesWrite && !newerDraft) {
        draftRef.current = persistedMode
        setDraft(persistedMode)
      }
    } catch (saveError) {
      if (hasUnknownWriteOutcome(saveError)) {
        const unknownPending = { ...pending, inFlight: false }
        pendingWrite.current = unknownPending
        publishSnapshot({ pendingWrite: unknownPending }, pending)
        if (requestGeneration.current === generation) {
          setOutcomeUnknown(true)
          setError(null)
          setSaving(false)
          setReload(value => value + 1)
        }
      } else {
        pendingWrite.current = null
        publishSnapshot(
          {
            defaults: snapshotRef.current.defaults,
            draft: draftRef.current,
            draftRevision: draftRevision.current,
            pendingWrite: null,
          },
          pending
        )
        if (requestGeneration.current === generation) {
          setError(isExecutionDefaultsUnsupported(saveError) ? 'unsupported' : 'save')
        }
      }
    } finally {
      if (savingOwnerRef.current === operation) {
        savingOwnerRef.current = null
        savingRef.current = false
      }
      if (requestGeneration.current === generation) {
        setSaving(false)
      }
    }
  }

  const dirty = defaults !== null && draft !== (defaults.persistedPermissionMode ?? '')
  const permissionLabel = (mode: ExecutionPermissionMode) => t(permissionModeLabels[mode], mode)

  return (
    <section
      data-testid="execution-permission-defaults"
      className="studio-card mb-5 overflow-hidden rounded-xl border border-border bg-background"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ShieldCheck className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          {t('workbench.execution_defaults_permission_title', 'New-session permission default')}
        </h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          {t(
            'workbench.execution_defaults_permission_description',
            'This target profile default is used when a new session is created. Existing sessions keep their explicit permission mode.'
          )}
        </p>
      </div>

      <div className="space-y-3 px-4 py-4">
        {loading ? (
          <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('workbench.execution_defaults_loading', 'Loading target settings…')}
          </p>
        ) : error === 'unsupported' && !defaults ? (
          <div role="alert" className="space-y-2 text-sm text-text-secondary">
            <p>
              {t(
                'workbench.execution_defaults_unsupported',
                'Upgrade the target KCoder to configure new-session permission defaults.'
              )}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('workbench.execution_defaults_retry', 'Retry')}
            </Button>
          </div>
        ) : error === 'load' && !defaults ? (
          <div role="alert" className="space-y-2 text-sm text-text-secondary">
            <p>
              {t(
                'workbench.execution_defaults_load_failed',
                'Could not load permission defaults for this target.'
              )}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('workbench.execution_defaults_retry', 'Retry')}
            </Button>
          </div>
        ) : defaults ? (
          <>
            <label
              htmlFor="execution-default-permission-mode"
              className="block text-sm font-medium text-text-primary"
            >
              {t('workbench.execution_defaults_permission_label', 'Default permission mode')}
            </label>
            <IconSelect
              id="execution-default-permission-mode"
              data-testid="execution-default-permission-select"
              aria-label={t(
                'workbench.execution_defaults_permission_label',
                'Default permission mode'
              )}
              icon={<ShieldCheck className="h-4 w-4" />}
              value={draft}
              disabled={saving || loading || !baselineVerified || outcomeUnknown}
              onChange={event => {
                draftRevision.current += 1
                const nextDraft = event.target.value as ExecutionPermissionMode | ''
                draftRef.current = nextDraft
                setDraft(nextDraft)
                publishSnapshot({
                  draft: nextDraft,
                  draftRevision: draftRevision.current,
                  reconciledMismatch: false,
                  saveConfirmed: false,
                  saveConfirmedWithNewerDraft: false,
                })
                setError(null)
                setSaveConfirmed(false)
                setSaveConfirmedWithNewerDraft(false)
                setReconciledMismatch(false)
              }}
            >
              <option value="">
                {t(
                  'workbench.execution_defaults_follow_target',
                  'Follow other target configuration and CLI settings'
                )}
              </option>
              {EXECUTION_PERMISSION_MODES.map(mode => (
                <option key={mode} value={mode}>
                  {permissionLabel(mode)}
                </option>
              ))}
            </IconSelect>

            <dl className="grid gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-text-muted">
                  {t('workbench.execution_defaults_effective', 'Effective on this target now')}
                </dt>
                <dd className="mt-0.5 font-medium text-text-primary">
                  {permissionLabel(defaults.effectivePermissionMode)}
                </dd>
              </div>
              {defaults.cliPermissionModeOverride && (
                <div>
                  <dt className="text-text-muted">
                    {t('workbench.execution_defaults_cli_override', 'CLI override')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-text-primary">
                    {permissionLabel(defaults.cliPermissionModeOverride)}
                  </dd>
                </div>
              )}
            </dl>
            {defaults.cliPermissionModeOverride && (
              <p className="text-xs leading-5 text-text-secondary">
                {t(
                  'workbench.execution_defaults_cli_override_help',
                  'The CLI currently overrides the saved target default. The saved choice will apply when the CLI override is removed.'
                )}
              </p>
            )}

            {error === 'unsupported' && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary"
              >
                <span>
                  {t(
                    'workbench.execution_defaults_unsupported',
                    'Upgrade the target KCoder to configure new-session permission defaults.'
                  )}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('workbench.execution_defaults_retry', 'Retry')}
                </Button>
              </div>
            )}
            {error === 'load' && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary"
              >
                <span>
                  {t(
                    'workbench.execution_defaults_load_failed',
                    'Could not load permission defaults for this target.'
                  )}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('workbench.execution_defaults_retry', 'Retry')}
                </Button>
              </div>
            )}
            {outcomeUnknown && (
              <div
                data-testid="execution-defaults-outcome-unknown"
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive"
              >
                <span>
                  {t(
                    'workbench.execution_defaults_outcome_unknown',
                    'Could not confirm whether this change was saved. Check the current target value before saving again.'
                  )}
                </span>
                {!loading && (
                  <Button
                    data-testid="execution-defaults-check-current"
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={retry}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('workbench.execution_defaults_check_current', 'Check current value')}
                  </Button>
                )}
              </div>
            )}
            {reconciledMismatch && (
              <p
                data-testid="execution-defaults-reconciled"
                role="alert"
                className="text-sm text-destructive"
              >
                {t(
                  'workbench.execution_defaults_reconciled_not_saved',
                  'The current saved value differs from your draft. Review it and press Save explicitly if you still want to apply your draft.'
                )}
              </p>
            )}
            {error === 'save' && (
              <p role="alert" className="text-sm text-destructive">
                {t(
                  'workbench.execution_defaults_save_failed',
                  'Could not save permission defaults. Retry to try again.'
                )}
              </p>
            )}
            {saveConfirmed && (
              <p
                data-testid="execution-defaults-saved"
                role="status"
                className="text-sm text-text-secondary"
              >
                {t('workbench.execution_defaults_saved', 'Saved.')}
              </p>
            )}
            {saveConfirmedWithNewerDraft && (
              <p
                data-testid="execution-defaults-saved-previous-draft"
                role="status"
                className="text-sm text-text-secondary"
              >
                {t(
                  'workbench.execution_defaults_saved_previous_draft',
                  'The submitted value was saved. Newer edits remain in your draft.'
                )}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <span role="status" className="text-xs text-text-secondary">
                {saving
                  ? t('workbench.saving', 'Saving…')
                  : error === 'save'
                    ? t('workbench.execution_defaults_save_failed_short', 'Save failed')
                    : ''}
              </span>
              <Button
                type="button"
                data-testid="execution-default-permission-save"
                disabled={
                  !dirty ||
                  saving ||
                  loading ||
                  !baselineVerified ||
                  outcomeUnknown ||
                  error === 'unsupported'
                }
                onClick={() => void save()}
              >
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {t('workbench.save', 'Save')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}

export function ExecutionDefaultsSettingsPage() {
  const { t } = useTranslation('common')
  const targets = useRuntimeSettingsTargets()
  const permissionScope = targets.selectedTarget ? hookTargetScope(targets.selectedTarget) : ''
  const gatewayPage = isKCoderGatewayPage()
  const permissionSnapshots = useRef(new Map<string, PermissionSettingsSnapshot>())
  const [permissionViews, setPermissionViews] = useState(() => new Map<string, PermissionSettingsSnapshot>())
  const pageActive = useRef(true)
  useEffect(() => {
    pageActive.current = true
    return () => {
      pageActive.current = false
    }
  }, [])
  const updatePermissionSnapshot = useCallback<PermissionSnapshotPublisher>(
    (targetScope, snapshot, expectedPendingWrite) => {
      if (!pageActive.current) return
      const current = permissionSnapshots.current.get(targetScope)
      if (expectedPendingWrite && current?.pendingWrite !== expectedPendingWrite) return
      permissionSnapshots.current.set(targetScope, snapshot)
      setPermissionViews(new Map(permissionSnapshots.current))
    },
    []
  )
  if (!gatewayPage) {
    return (
      <SettingsPage data-testid="execution-defaults-unsupported-page">
        <SettingsPageHeader
          title={t('workbench.execution_defaults_title', 'New-session defaults')}
          description={t(
            'workbench.execution_defaults_gateway_required',
            'This page requires a KCoder Gateway. Local Codex settings are not used for target defaults.'
          )}
        />
        <div
          role="alert"
          className="studio-card-spacing rounded-xl border border-border bg-background px-4 py-3 text-sm text-text-secondary"
        >
          {t(
            'workbench.execution_defaults_gateway_required',
            'This page requires a KCoder Gateway. Local Codex settings are not used for target defaults.'
          )}
        </div>
      </SettingsPage>
    )
  }

  return (
    <SettingsPage data-testid="execution-defaults-settings-page">
      <SettingsPageHeader
        title={t('workbench.execution_defaults_title', 'New-session defaults')}
        description={t(
          'workbench.execution_defaults_description',
          'Choose the default permission mode for new conversations on a runtime target.'
        )}
      />

      <section className="studio-card-spacing mb-5 rounded-xl border border-border bg-background px-4 py-3">
        <label
          htmlFor="execution-settings-target"
          className="block text-sm font-semibold text-text-primary"
        >
          {t('workbench.execution_defaults_target', 'Runtime target')}
        </label>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          {t(
            'workbench.execution_defaults_target_scope',
            'Settings are stored in the target user profile and shared with other clients using the same target account.'
          )}
        </p>
        <IconSelect
          id="execution-settings-target"
          data-testid="execution-settings-target-select"
          aria-label={t('workbench.execution_defaults_target', 'Runtime target')}
          icon={<Server className="h-4 w-4" />}
          value={targets.selectedServerId}
          disabled={targets.loading || targets.targets.length <= 1}
          onChange={event => targets.selectTarget(event.target.value)}
        >
          {targets.targets.length !== 1 && (
            <option value="">
              {t('workbench.execution_defaults_select_target', 'Select a target')}
            </option>
          )}
          {targets.targets.map(target => (
            <option key={target.id} value={target.id}>
              {targetLabel(target)}
            </option>
          ))}
        </IconSelect>
        {targets.currentRuntimeTarget && (
          <p
            data-testid="execution-settings-current-target"
            className="mt-2 text-xs text-text-secondary"
          >
            {t('workbench.execution_defaults_current_target', 'Current runtime target')}:{' '}
            {targetLabel(targets.currentRuntimeTarget)}
          </p>
        )}
        {targets.loading && (
          <p role="status" className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t('workbench.execution_defaults_targets_loading', 'Loading runtime targets…')}
          </p>
        )}
        {targets.error === 'load_failed' && (
          <div
            role="alert"
            className="mt-2 flex items-center justify-between gap-3 text-xs text-text-secondary"
          >
            <span>
              {t(
                'workbench.execution_defaults_targets_load_failed',
                'Could not load runtime targets.'
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void targets.refresh()}
            >
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('workbench.execution_defaults_retry', 'Retry')}
            </Button>
          </div>
        )}
        {!targets.loading && targets.targets.length === 0 && targets.error !== 'load_failed' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>
              {t(
                'workbench.execution_defaults_no_targets',
                'No KCoder runtime targets are configured for this Gateway.'
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigateTo('/settings/kcoder-servers')}
            >
              {t('workbench.execution_defaults_manage_targets', 'Manage targets')}
            </Button>
          </div>
        )}
      </section>

      {targets.selectedTarget ? (
        <>
          <p className="mb-4 text-xs text-text-secondary">
            {t('workbench.execution_defaults_editing_target', 'Editing target')}:{' '}
            <strong className="font-medium text-text-primary">
              {targetLabel(targets.selectedTarget)}
            </strong>
          </p>
          <div key={permissionScope}>
            <ExecutionPermissionDefaults
              serverId={targets.selectedTarget.id}
              targetScope={permissionScope}
              initialSnapshot={permissionViews.get(permissionScope)}
              onSnapshotChange={updatePermissionSnapshot}
            />
          </div>
        </>
      ) : !targets.loading && targets.targets.length > 1 ? (
        <div className="studio-card-spacing rounded-xl border border-dashed border-border text-sm text-text-secondary">
          {t(
            'workbench.execution_defaults_choose_target',
            'Select a runtime target to load its settings.'
          )}
        </div>
      ) : null}
    </SettingsPage>
  )
}
