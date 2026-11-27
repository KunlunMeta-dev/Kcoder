import { currentHostDeviceId } from '@/features/runtime-target/currentHostTarget'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { deviceDisplayName } from '@/lib/device-display-name'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Loader2, Save, Terminal } from 'lucide-react'
import {
  getLocalCodexInstructions,
  saveLocalCodexInstructions,
} from '@/api/local/codexInstructions'
import { GatewayRpcError, isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import {
  exceedsCustomInstructionsLimit,
  readTargetCustomInstructions,
  saveTargetCustomInstructions,
} from '@/features/execution-settings/executionSettingsApi'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsPage, SettingsPageHeader, SettingsSwitch } from './settings-ui'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
} from '@/host/appPreferences'
import { CodexPersonalitySettings } from './CodexPersonalitySettings'
import { ToolProfileSettings } from './ToolProfileSettings'
import type { DeviceInfo } from '@/types/api'
import { ImportedMemorySettings } from './ImportedMemorySettings'
import { useRuntimeSettingsTargets, type RuntimeSettingsTargetsState } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import { StableLabel } from '@/components/ui/stable-content'

interface PendingInstructionsWrite {
  scope: string
  targetId: string
  instructions: string
  draftRevision: number
}

function hasUnknownGatewayWriteOutcome(error: unknown): boolean {
  return !(error instanceof GatewayRpcError) || error.reason !== 'remote'
}

type ContextSettingsProps = { devices?: DeviceInfo[] }

export function ContextSettingsPage(props: ContextSettingsProps) {
  return isKCoderGatewayPage() ? <GatewayContextSettingsPage {...props} /> : <ContextSettingsContents {...props} />
}

function GatewayContextSettingsPage(props: ContextSettingsProps) {
  const targetCatalog = useRuntimeSettingsTargets()
  return <ContextSettingsContents {...props} targetCatalog={targetCatalog} />
}

function ContextSettingsContents({ devices = [], targetCatalog }: ContextSettingsProps & { targetCatalog?: RuntimeSettingsTargetsState }) {
  const { t } = useTranslation('common')
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [savedInstructions, setSavedInstructions] = useState('')
  const [instructionsLoading, setInstructionsLoading] = useState(true)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [instructionsSaved, setInstructionsSaved] = useState(false)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)
  const [instructionsOutcomeUnknown, setInstructionsOutcomeUnknown] = useState(false)
  const [instructionsReconciledMismatch, setInstructionsReconciledMismatch] = useState(false)
  const [instructionsReconciledMatch, setInstructionsReconciledMatch] = useState(false)
  const [instructionsSavedPreviousDraft, setInstructionsSavedPreviousDraft] = useState(false)
  const [instructionsBaselineVerified, setInstructionsBaselineVerified] = useState(false)
  const [instructionsRefreshRevision, setInstructionsRefreshRevision] = useState(0)
  const gatewayPage = isKCoderGatewayPage()
  const [requestedDeviceId, setRequestedDeviceId] = useState(
    () => currentHostDeviceId(devices) ?? ''
  )
  const selectedDeviceId = devices.some(device => device.device_id === requestedDeviceId)
    ? requestedDeviceId
    : (currentHostDeviceId(devices) ?? '')
  const selectedTarget = targetCatalog?.targets.find(target => target.id === selectedDeviceId)
  const instructionsScope = targetCatalog ? selectedTarget ? hookTargetScope(selectedTarget) : '' : selectedDeviceId
  const instructionsScopeRef = useRef<string | null>(instructionsScope)
  const saveGeneration = useRef(0)
  const instructionsReadGeneration = useRef(0)
  const instructionsDraftRevisions = useRef(new Map<string, number>())
  const instructionsDrafts = useRef(new Map<string, string>())
  const instructionsSavedBaselines = useRef(new Map<string, string>())
  const instructionsSavingOperations = useRef(new Map<string, object>())
  const pendingInstructionsWrites = useRef(new Map<string, PendingInstructionsWrite>())

  const getDraftRevision = (scope: string) =>
    instructionsDraftRevisions.current.get(scope) ?? 0

  useLayoutEffect(() => {
    instructionsScopeRef.current = instructionsScope
    saveGeneration.current += 1
    instructionsReadGeneration.current += 1
    setInstructionsSaving(instructionsSavingOperations.current.has(instructionsScope))
    setInstructionsLoading(true)
  }, [instructionsScope])

  const instructionsTooLong = gatewayPage && exceedsCustomInstructionsLimit(instructions)
  const instructionsDirty = instructions !== savedInstructions

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const nextPreferences = await getAppPreferences()
        if (!cancelled) {
          setPreferences(nextPreferences)
          setError(null)
        }
      } catch (fetchError) {
        console.error('[KCoder Studio] Failed to load context settings', fetchError)
        if (!cancelled) {
          setError(t('workbench.context_settings_load_failed'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [t])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const pendingAtRead = pendingInstructionsWrites.current.get(instructionsScope) ?? null
      const draftAtRead = gatewayPage ? instructionsDrafts.current.get(instructionsScope) : undefined
      setInstructionsLoading(true)
      setInstructionsBaselineVerified(false)
      setInstructionsSaved(false)
      if (draftAtRead !== undefined) setInstructions(draftAtRead)
      else if (pendingAtRead) setInstructions(pendingAtRead.instructions)
      else setInstructions('')
      if (gatewayPage && pendingAtRead && draftAtRead === undefined) {
        instructionsDrafts.current.set(instructionsScope, pendingAtRead.instructions)
      }
      setSavedInstructions(
        gatewayPage ? (instructionsSavedBaselines.current.get(instructionsScope) ?? '') : ''
      )
      setInstructionsError(null)
      setInstructionsOutcomeUnknown(Boolean(pendingAtRead))
      setInstructionsReconciledMismatch(false)
      setInstructionsReconciledMatch(false)
      setInstructionsSavedPreviousDraft(false)
      const readGeneration = ++instructionsReadGeneration.current
      const current = () => !cancelled && instructionsScopeRef.current === instructionsScope &&
        instructionsReadGeneration.current === readGeneration
      if (gatewayPage && !instructionsScope) {
        setInstructionsLoading(targetCatalog?.loading ?? false)
        if (targetCatalog?.error) setInstructionsError(t('workbench.context_settings_kcoder_instructions_load_failed'))
        return
      }

      if (gatewayPage && instructionsSavingOperations.current.has(instructionsScope)) {
        setInstructionsLoading(false)
        setInstructionsSaving(true)
        return
      }

      try {
        const nextInstructions = gatewayPage
          ? await readTargetCustomInstructions(selectedDeviceId, { targetScope: instructionsScope })
          : selectedDeviceId
            ? await getLocalCodexInstructions(selectedDeviceId)
            : await getLocalCodexInstructions()
        if (current()) {
          const previousBaseline = gatewayPage
            ? instructionsSavedBaselines.current.get(instructionsScope)
            : undefined
          setSavedInstructions(nextInstructions.instructions)
          setInstructionsBaselineVerified(true)
          if (gatewayPage) {
            instructionsSavedBaselines.current.set(instructionsScope, nextInstructions.instructions)
          }
          setInstructionsError(null)
          if (pendingAtRead) {
            if (pendingInstructionsWrites.current.get(instructionsScope) === pendingAtRead) {
              pendingInstructionsWrites.current.delete(instructionsScope)
            }
            const matchesWrite = nextInstructions.instructions === pendingAtRead.instructions
            const newerDraft = getDraftRevision(instructionsScope) !== pendingAtRead.draftRevision
            const currentDraft =
              instructionsDrafts.current.get(instructionsScope) ?? pendingAtRead.instructions
            setInstructionsOutcomeUnknown(false)
            setInstructionsReconciledMismatch(
              !matchesWrite && nextInstructions.instructions !== currentDraft
            )
            setInstructionsReconciledMatch(matchesWrite && !newerDraft)
            setInstructionsSaved(matchesWrite && !newerDraft)
            setInstructionsSavedPreviousDraft(matchesWrite && newerDraft)
            if (matchesWrite && !newerDraft) {
              setInstructions(nextInstructions.instructions)
              instructionsDrafts.current.set(instructionsScope, nextInstructions.instructions)
            } else if (!matchesWrite && !newerDraft) {
              setInstructions(pendingAtRead.instructions)
              instructionsDrafts.current.set(instructionsScope, pendingAtRead.instructions)
            } else {
              setInstructions(currentDraft)
            }
          } else {
            const cachedDraft = gatewayPage
              ? instructionsDrafts.current.get(instructionsScope)
              : undefined
            const hasUnsavedDraft =
              cachedDraft !== undefined &&
              previousBaseline !== undefined &&
              cachedDraft !== previousBaseline
            const draft = hasUnsavedDraft ? cachedDraft : nextInstructions.instructions
            setInstructions(draft)
            if (gatewayPage) instructionsDrafts.current.set(instructionsScope, draft)
            setInstructionsOutcomeUnknown(false)
            setInstructionsReconciledMismatch(false)
            setInstructionsReconciledMatch(false)
            setInstructionsSavedPreviousDraft(false)
          }
        }
      } catch (fetchError) {
        if (current()) {
          if (pendingAtRead) {
            setInstructionsOutcomeUnknown(true)
            const draft =
              instructionsDrafts.current.get(instructionsScope) ?? pendingAtRead.instructions
            setInstructions(draft)
            instructionsDrafts.current.set(instructionsScope, draft)
          } else {
            console.error('[KCoder Studio] Failed to load KCoder custom instructions', fetchError)
            setInstructionsError(t('workbench.context_settings_kcoder_instructions_load_failed'))
          }
        }
      } finally {
        if (current()) {
          setInstructionsLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [gatewayPage, selectedDeviceId, instructionsScope, targetCatalog?.loading, targetCatalog?.error, t, instructionsRefreshRevision])

  const checkCurrentInstructions = (pendingWrite: PendingInstructionsWrite) => {
    if (gatewayPage && instructionsScopeRef.current === pendingWrite.scope &&
        pendingInstructionsWrites.current.get(pendingWrite.scope) === pendingWrite)
      setInstructionsRefreshRevision(value => value + 1)
  }

  const handleTerminalContextChange = async (enabled: boolean) => {
    setPreferences(current => ({ ...current, terminalContextInjectionEnabled: enabled }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({
        terminalContextInjectionEnabled: enabled,
      })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[KCoder Studio] Failed to update context settings', saveError)
      setPreferences(current => ({
        ...current,
        terminalContextInjectionEnabled: !enabled,
      }))
      setError(t('workbench.context_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveInstructions = async () => {
    const targetDeviceId = selectedDeviceId
    const targetScope = instructionsScope
    if (
      instructionsTooLong ||
      instructionsSavingOperations.current.has(targetScope) ||
      (gatewayPage &&
        (!targetScope || !instructionsBaselineVerified || pendingInstructionsWrites.current.has(targetScope)))
    ) {
      return
    }
    const generation = ++saveGeneration.current
    const nextInstructions = instructions
    const draftRevision = getDraftRevision(targetScope)
    const operation = {}
    instructionsSavingOperations.current.set(targetScope, operation)
    setInstructionsSaving(true)
    setInstructionsSaved(false)
    setInstructionsSavedPreviousDraft(false)
    setInstructionsReconciledMismatch(false)
    setInstructionsReconciledMatch(false)
    setInstructionsError(null)
    try {
      const response = gatewayPage
        ? await saveTargetCustomInstructions(targetDeviceId, nextInstructions, { targetScope })
        : targetDeviceId
          ? await saveLocalCodexInstructions(nextInstructions, targetDeviceId)
          : await saveLocalCodexInstructions(nextInstructions)
      if (gatewayPage && response.instructions !== nextInstructions) {
        const pendingWrite = {
          scope: targetScope,
          targetId: targetDeviceId,
          instructions: nextInstructions,
          draftRevision,
        }
        if (instructionsSavingOperations.current.get(targetScope) === operation) {
          pendingInstructionsWrites.current.set(targetScope, pendingWrite)
          if (
            instructionsScopeRef.current === targetScope &&
            generation === saveGeneration.current
          ) {
            setInstructionsOutcomeUnknown(true)
            setInstructionsError(null)
            void checkCurrentInstructions(pendingWrite)
          }
        }
        return
      }
      if (gatewayPage && instructionsSavingOperations.current.get(targetScope) === operation) {
        instructionsSavedBaselines.current.set(targetScope, response.instructions)
        if (getDraftRevision(targetScope) === draftRevision) {
          instructionsDrafts.current.set(targetScope, response.instructions)
        }
      }
      if (instructionsScopeRef.current !== targetScope || generation !== saveGeneration.current) {
        return
      }
      setSavedInstructions(response.instructions)
      setInstructionsBaselineVerified(true)
      if (gatewayPage) {
        instructionsSavedBaselines.current.set(targetScope, response.instructions)
        const newerDraft = getDraftRevision(targetScope) !== draftRevision
        if (!newerDraft) {
          setInstructions(response.instructions)
          instructionsDrafts.current.set(targetScope, response.instructions)
        }
        setInstructionsSaved(!newerDraft)
        setInstructionsSavedPreviousDraft(newerDraft)
      } else {
        setInstructions(response.instructions)
        setInstructionsSaved(true)
      }
    } catch (saveError) {
      if (gatewayPage && hasUnknownGatewayWriteOutcome(saveError)) {
        const pendingWrite = {
          scope: targetScope,
          targetId: targetDeviceId,
          instructions: nextInstructions,
          draftRevision,
        }
        const ownsOperation = instructionsSavingOperations.current.get(targetScope) === operation
        if (ownsOperation) {
          pendingInstructionsWrites.current.set(targetScope, pendingWrite)
        }
        if (
          ownsOperation &&
          instructionsScopeRef.current === targetScope &&
          generation === saveGeneration.current
        ) {
          setInstructionsOutcomeUnknown(true)
          setInstructionsError(null)
          void checkCurrentInstructions(pendingWrite)
        }
      } else if (
        instructionsScopeRef.current === targetScope &&
        (gatewayPage || generation === saveGeneration.current)
      ) {
        if (!gatewayPage) {
          console.error('[KCoder Studio] Failed to save KCoder custom instructions', saveError)
        }
        setInstructionsError(t('workbench.context_settings_kcoder_instructions_save_failed'))
      }
    } finally {
      if (instructionsSavingOperations.current.get(targetScope) === operation) {
        instructionsSavingOperations.current.delete(targetScope)
      }
      if (instructionsScopeRef.current === targetScope) {
        setInstructionsSaving(instructionsSavingOperations.current.has(targetScope))
        if (gatewayPage && generation !== saveGeneration.current) {
          setInstructionsRefreshRevision(value => value + 1)
        }
      }
    }
  }

  return (
    <SettingsPage data-testid="context-settings-page">
      <SettingsPageHeader
        title={t('workbench.context_settings_title')}
        description={t('workbench.context_settings_subtitle')}
      />

      {devices.length > 0 ? (
        <section className="studio-card-spacing mb-4 rounded-lg border border-border bg-background px-4 py-3">
          <label
            htmlFor="context-runtime-target"
            className="block text-sm font-semibold text-text-primary"
          >
            {t('workbench.context_settings_target', '配置目标')}
          </label>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(
              'workbench.context_settings_target_description',
              '自定义指令和个性仅写入所选 KCoder 运行目标。'
            )}
          </p>
          <SettingsSelect
            id="context-runtime-target"
            data-testid="context-runtime-target-select"
            value={selectedDeviceId}
            onChange={event => {
              const nextTargetId = event.target.value
              instructionsScopeRef.current = null
              saveGeneration.current += 1
              instructionsReadGeneration.current += 1
              setInstructionsLoading(true)
              setInstructionsSaving(false)
              setInstructionsError(null)
              setInstructionsSaved(false)
              setInstructionsOutcomeUnknown(false)
              setInstructionsReconciledMismatch(false)
              setInstructionsReconciledMatch(false)
              setInstructionsSavedPreviousDraft(false)
              setRequestedDeviceId(nextTargetId)
            }}
            className="mt-3 h-9 min-w-64 rounded-lg border border-border bg-background px-3 text-sm text-text-primary"
          >
            {!selectedDeviceId && <option value="">{t('workbench.execution_defaults_select_target')}</option>}
            {devices.map(device => (
              <option key={device.device_id} value={device.device_id}>
                {deviceDisplayName(device, t)} ({device.device_id})
              </option>
            ))}
          </SettingsSelect>
        </section>
      ) : null}

      <section className="studio-card overflow-hidden rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.context_settings_terminal_title')}
          </h2>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Terminal className="h-4 w-4 text-text-secondary" />
              <span>{t('workbench.context_settings_terminal_injection')}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_terminal_injection_description')}
            </p>
          </div>
          <SettingsSwitch
            data-testid="context-terminal-injection-toggle"
            checked={preferences.terminalContextInjectionEnabled}
            disabled={loading || saving}
            onCheckedChange={checked => {
              void handleTerminalContextChange(checked)
            }}
            aria-label={t('workbench.context_settings_terminal_injection')}
          />
        </div>
      </section>

      {(!gatewayPage || instructionsScope) && <ToolProfileSettings serverId={selectedDeviceId} targetScope={gatewayPage ? instructionsScope : undefined} />}
      {selectedTarget && <ImportedMemorySettings key={selectedDeviceId} target={selectedTarget}/>}

      {(!gatewayPage || instructionsScope) && <CodexPersonalitySettings deviceId={selectedDeviceId || undefined} targetScope={gatewayPage ? instructionsScope : undefined} />}

      <section className="studio-card mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.context_settings_kcoder_instructions_title')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_kcoder_instructions_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="context-studio-instructions-save-button"
            disabled={
              instructionsLoading ||
              instructionsSaving ||
              !instructionsDirty ||
              instructionsTooLong ||
              (gatewayPage && !instructionsBaselineVerified) ||
              (gatewayPage && instructionsOutcomeUnknown)
            }
            onClick={() => void handleSaveInstructions()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium leading-[18px] text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {instructionsSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : instructionsSaved && !instructionsDirty ? (
              <Check className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            <StableLabel
              alternatives={[
                t('workbench.context_settings_kcoder_instructions_saving'),
                t('workbench.context_settings_kcoder_instructions_saved'),
                t('workbench.context_settings_kcoder_instructions_save'),
              ]}
            >
              {instructionsSaving
                ? t('workbench.context_settings_kcoder_instructions_saving')
                : instructionsSaved && !instructionsDirty
                  ? t('workbench.context_settings_kcoder_instructions_saved')
                  : t('workbench.context_settings_kcoder_instructions_save')}
            </StableLabel>
          </button>
        </div>
        <div className="px-4 py-4">
          {instructionsLoading ? (
            <div className="flex min-h-40 items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading', '加载中...')}
            </div>
          ) : (
            <textarea
              data-testid="context-studio-instructions-textarea"
              value={instructions}
              aria-invalid={instructionsTooLong || undefined}
              aria-describedby={instructionsTooLong ? 'context-instructions-limit' : undefined}
              disabled={instructionsSaving || (gatewayPage && !instructionsScope)}
              onChange={event => {
                const nextDraft = event.target.value
                instructionsDraftRevisions.current.set(
                  instructionsScope,
                  getDraftRevision(instructionsScope) + 1
                )
                instructionsDrafts.current.set(instructionsScope, nextDraft)
                setInstructions(nextDraft)
                setInstructionsSaved(false)
                setInstructionsSavedPreviousDraft(false)
                setInstructionsReconciledMismatch(false)
                setInstructionsReconciledMatch(false)
              }}
              placeholder={t('workbench.context_settings_kcoder_instructions_placeholder')}
              className="min-h-40 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
            />
          )}
          {instructionsTooLong && (
            <p id="context-instructions-limit" role="alert" className="mt-2 text-sm text-destructive">
              {t('workbench.context_settings_instructions_too_long')}
            </p>
          )}
          {instructionsError ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-red-500">
              <p data-testid="context-studio-instructions-error" role="alert">
                {instructionsError}
              </p>
              {gatewayPage && !instructionsLoading && !instructionsBaselineVerified && (
                <button
                  type="button"
                  data-testid="context-studio-instructions-retry"
                  onClick={() => {
                    if (targetCatalog && !instructionsScope) void targetCatalog.refresh()
                    else setInstructionsRefreshRevision(value => value + 1)
                  }}
                  className="rounded border border-border px-2 py-1 text-text-primary hover:bg-muted"
                >
                  {t(
                    'workbench.context_settings_instructions_check_current',
                    'Check current value'
                  )}
                </button>
              )}
            </div>
          ) : instructionsOutcomeUnknown ? (
            <div
              data-testid="context-studio-instructions-outcome-unknown"
              role="alert"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-red-500"
            >
              <span>
                {t(
                  'workbench.context_settings_instructions_outcome_unknown',
                  'Could not confirm whether this change was saved. Check the current target value before saving again.'
                )}
              </span>
              {!instructionsLoading && (
                <button
                  type="button"
                  data-testid="context-studio-instructions-check-current"
                  disabled={instructionsSaving}
                  onClick={() => {
                    const pendingWrite = pendingInstructionsWrites.current.get(instructionsScope)
                    if (pendingWrite) void checkCurrentInstructions(pendingWrite)
                  }}
                  className="rounded border border-border px-2 py-1 text-text-primary hover:bg-muted disabled:opacity-50"
                >
                  {t(
                    'workbench.context_settings_instructions_check_current',
                    'Check current value'
                  )}
                </button>
              )}
            </div>
          ) : instructionsReconciledMismatch ? (
            <p
              data-testid="context-studio-instructions-reconciled"
              role="alert"
              className="mt-3 text-xs leading-5 text-red-500"
            >
              {t(
                'workbench.context_settings_instructions_reconciled_not_saved',
                'The current saved value differs from your draft. Review it and press Save explicitly if you still want to apply your draft.'
              )}
            </p>
          ) : instructionsReconciledMatch ? (
            <p
              data-testid="context-studio-instructions-saved"
              role="status"
              className="mt-3 text-xs leading-5 text-text-secondary"
            >
              {t(
                'workbench.context_settings_instructions_reconciled_saved',
                'The submitted instructions are saved on this target.'
              )}
            </p>
          ) : instructionsSavedPreviousDraft ? (
            <p role="status" className="mt-3 text-xs leading-5 text-text-secondary">
              {t(
                'workbench.context_settings_instructions_saved_previous_draft',
                'The submitted value was saved. Newer edits remain in your draft.'
              )}
            </p>
          ) : (
            <p className="mt-3 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_kcoder_instructions_hint')}
            </p>
          )}
        </div>
      </section>

      {(loading || saving || error) && (
        <div
          data-testid="context-settings-status"
          className="mt-4 flex items-center gap-2 text-xs text-text-secondary"
        >
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            {error ??
              (loading ? t('common.loading', '加载中...') : t('workbench.context_settings_saving'))}
          </span>
        </div>
      )}
    </SettingsPage>
  )
}
