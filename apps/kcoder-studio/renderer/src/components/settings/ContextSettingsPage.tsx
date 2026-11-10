import { currentHostDeviceId } from '@/features/runtime-target/currentHostTarget'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { deviceDisplayName } from '@/lib/device-display-name'
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Save, Terminal } from 'lucide-react'
import {
  getLocalCodexInstructions,
  saveLocalCodexInstructions,
} from '@/api/local/codexInstructions'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/host/localExecutor'
import { GatewayRpcError, isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { KCODER_RUNTIME_METHODS } from '@/kcoder/legacyRuntimeAbi'
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

interface PendingInstructionsWrite {
  targetId: string
  instructions: string
  draftRevision: number
}

interface ContextInstructionsResponse {
  instructions: string
  configPath: string | null
}

function validateGatewayInstructionsResponse(value: unknown): ContextInstructionsResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid runtime instructions response')
  }
  const response = value as Record<string, unknown>
  if (typeof response.instructions !== 'string') {
    throw new Error('Invalid runtime instructions response')
  }
  return {
    instructions: response.instructions,
    configPath: typeof response.configPath === 'string' ? response.configPath : null,
  }
}

async function readGatewayInstructions(targetId: string): Promise<ContextInstructionsResponse> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<unknown>(KCODER_RUNTIME_METHODS.instructionsRead, {
    ...(targetId ? { deviceId: targetId } : {}),
  })
  return validateGatewayInstructionsResponse(response)
}

async function saveGatewayInstructions(
  targetId: string,
  instructions: string
): Promise<ContextInstructionsResponse> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<unknown>(KCODER_RUNTIME_METHODS.instructionsWrite, {
    ...(targetId ? { deviceId: targetId } : {}),
    instructions,
  })
  return validateGatewayInstructionsResponse(response)
}

function hasUnknownGatewayWriteOutcome(error: unknown): boolean {
  return !(error instanceof GatewayRpcError) || error.reason !== 'remote'
}

export function ContextSettingsPage({ devices = [] }: { devices?: DeviceInfo[] }) {
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
  const selectedDeviceIdRef = useRef(selectedDeviceId)
  const saveGeneration = useRef(0)
  const instructionsReadGeneration = useRef(0)
  const instructionsDraftRevisions = useRef(new Map<string, number>())
  const instructionsDrafts = useRef(new Map<string, string>())
  const instructionsSavedBaselines = useRef(new Map<string, string>())
  const instructionsSavingOperations = useRef(new Map<string, object>())
  const pendingInstructionsWrites = useRef(new Map<string, PendingInstructionsWrite>())

  const getDraftRevision = (targetId: string) =>
    instructionsDraftRevisions.current.get(targetId) ?? 0

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId
    saveGeneration.current += 1
    instructionsReadGeneration.current += 1
    setInstructionsSaving(instructionsSavingOperations.current.has(selectedDeviceId))
  }, [selectedDeviceId])

  const instructionsDirty = instructions !== savedInstructions

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const pendingAtRead = pendingInstructionsWrites.current.get(selectedDeviceId) ?? null
      const draftAtRead = gatewayPage ? instructionsDrafts.current.get(selectedDeviceId) : undefined
      setInstructionsLoading(true)
      setInstructionsBaselineVerified(false)
      setInstructionsSaved(false)
      if (draftAtRead !== undefined) setInstructions(draftAtRead)
      else if (pendingAtRead) setInstructions(pendingAtRead.instructions)
      else setInstructions('')
      if (gatewayPage && pendingAtRead && draftAtRead === undefined) {
        instructionsDrafts.current.set(selectedDeviceId, pendingAtRead.instructions)
      }
      setSavedInstructions(
        gatewayPage ? (instructionsSavedBaselines.current.get(selectedDeviceId) ?? '') : ''
      )
      setInstructionsError(null)
      setInstructionsOutcomeUnknown(false)
      setInstructionsReconciledMismatch(false)
      setInstructionsReconciledMatch(false)
      setInstructionsSavedPreviousDraft(false)
      const readGeneration = ++instructionsReadGeneration.current
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

      if (
        cancelled ||
        selectedDeviceIdRef.current !== selectedDeviceId ||
        instructionsReadGeneration.current !== readGeneration
      ) {
        return
      }

      if (gatewayPage && !selectedDeviceId) {
        setInstructionsLoading(false)
        return
      }

      if (gatewayPage && instructionsSavingOperations.current.has(selectedDeviceId)) {
        setInstructionsLoading(false)
        setInstructionsSaving(true)
        return
      }

      try {
        const nextInstructions = gatewayPage
          ? await readGatewayInstructions(selectedDeviceId)
          : selectedDeviceId
            ? await getLocalCodexInstructions(selectedDeviceId)
            : await getLocalCodexInstructions()
        if (
          !cancelled &&
          selectedDeviceIdRef.current === selectedDeviceId &&
          instructionsReadGeneration.current === readGeneration
        ) {
          const previousBaseline = gatewayPage
            ? instructionsSavedBaselines.current.get(selectedDeviceId)
            : undefined
          setSavedInstructions(nextInstructions.instructions)
          setInstructionsBaselineVerified(true)
          if (gatewayPage) {
            instructionsSavedBaselines.current.set(selectedDeviceId, nextInstructions.instructions)
          }
          setInstructionsError(null)
          if (pendingAtRead && instructionsReadGeneration.current === readGeneration) {
            if (pendingInstructionsWrites.current.get(selectedDeviceId) === pendingAtRead) {
              pendingInstructionsWrites.current.delete(selectedDeviceId)
            }
            const matchesWrite = nextInstructions.instructions === pendingAtRead.instructions
            const newerDraft = getDraftRevision(selectedDeviceId) !== pendingAtRead.draftRevision
            const currentDraft =
              instructionsDrafts.current.get(selectedDeviceId) ?? pendingAtRead.instructions
            setInstructionsOutcomeUnknown(false)
            setInstructionsReconciledMismatch(
              !matchesWrite && nextInstructions.instructions !== currentDraft
            )
            setInstructionsReconciledMatch(matchesWrite && !newerDraft)
            setInstructionsSaved(matchesWrite && !newerDraft)
            setInstructionsSavedPreviousDraft(matchesWrite && newerDraft)
            if (matchesWrite && !newerDraft) {
              setInstructions(nextInstructions.instructions)
              instructionsDrafts.current.set(selectedDeviceId, nextInstructions.instructions)
            } else if (!matchesWrite && !newerDraft) {
              setInstructions(pendingAtRead.instructions)
              instructionsDrafts.current.set(selectedDeviceId, pendingAtRead.instructions)
            } else {
              setInstructions(currentDraft)
            }
          } else {
            const cachedDraft = gatewayPage
              ? instructionsDrafts.current.get(selectedDeviceId)
              : undefined
            const hasUnsavedDraft =
              cachedDraft !== undefined &&
              previousBaseline !== undefined &&
              cachedDraft !== previousBaseline
            const draft = hasUnsavedDraft ? cachedDraft : nextInstructions.instructions
            setInstructions(draft)
            if (gatewayPage) instructionsDrafts.current.set(selectedDeviceId, draft)
            setInstructionsOutcomeUnknown(false)
            setInstructionsReconciledMismatch(false)
            setInstructionsReconciledMatch(false)
            setInstructionsSavedPreviousDraft(false)
          }
        }
      } catch (fetchError) {
        if (
          !cancelled &&
          selectedDeviceIdRef.current === selectedDeviceId &&
          instructionsReadGeneration.current === readGeneration
        ) {
          if (pendingAtRead && instructionsReadGeneration.current === readGeneration) {
            setInstructionsOutcomeUnknown(true)
            const draft =
              instructionsDrafts.current.get(selectedDeviceId) ?? pendingAtRead.instructions
            setInstructions(draft)
            instructionsDrafts.current.set(selectedDeviceId, draft)
          } else {
            console.error('[KCoder Studio] Failed to load KCoder custom instructions', fetchError)
            setInstructionsError(t('workbench.context_settings_kcoder_instructions_load_failed'))
          }
        }
      } finally {
        if (
          !cancelled &&
          selectedDeviceIdRef.current === selectedDeviceId &&
          instructionsReadGeneration.current === readGeneration
        ) {
          setInstructionsLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [gatewayPage, selectedDeviceId, t, instructionsRefreshRevision])

  const checkCurrentInstructions = async (pendingWrite: PendingInstructionsWrite) => {
    if (
      !gatewayPage ||
      selectedDeviceIdRef.current !== pendingWrite.targetId ||
      pendingInstructionsWrites.current.get(pendingWrite.targetId) !== pendingWrite
    ) {
      return
    }
    const readGeneration = ++instructionsReadGeneration.current
    const targetGeneration = saveGeneration.current
    setInstructionsLoading(true)
    setInstructionsBaselineVerified(false)
    setInstructionsError(null)
    try {
      const current = await readGatewayInstructions(pendingWrite.targetId)
      if (
        selectedDeviceIdRef.current !== pendingWrite.targetId ||
        saveGeneration.current !== targetGeneration ||
        instructionsReadGeneration.current !== readGeneration ||
        pendingInstructionsWrites.current.get(pendingWrite.targetId) !== pendingWrite
      ) {
        return
      }
      pendingInstructionsWrites.current.delete(pendingWrite.targetId)
      setSavedInstructions(current.instructions)
      setInstructionsBaselineVerified(true)
      instructionsSavedBaselines.current.set(pendingWrite.targetId, current.instructions)
      const matchesWrite = current.instructions === pendingWrite.instructions
      const newerDraft = getDraftRevision(pendingWrite.targetId) !== pendingWrite.draftRevision
      const currentDraft =
        instructionsDrafts.current.get(pendingWrite.targetId) ?? pendingWrite.instructions
      setInstructionsOutcomeUnknown(false)
      setInstructionsReconciledMismatch(!matchesWrite && current.instructions !== currentDraft)
      setInstructionsReconciledMatch(matchesWrite && !newerDraft)
      setInstructionsSaved(matchesWrite && !newerDraft)
      setInstructionsSavedPreviousDraft(matchesWrite && newerDraft)
      if (matchesWrite && !newerDraft) {
        setInstructions(current.instructions)
        instructionsDrafts.current.set(pendingWrite.targetId, current.instructions)
      } else if (!matchesWrite && !newerDraft) {
        setInstructions(pendingWrite.instructions)
        instructionsDrafts.current.set(pendingWrite.targetId, pendingWrite.instructions)
      } else {
        setInstructions(currentDraft)
      }
    } catch {
      if (
        selectedDeviceIdRef.current === pendingWrite.targetId &&
        saveGeneration.current === targetGeneration &&
        instructionsReadGeneration.current === readGeneration &&
        pendingInstructionsWrites.current.get(pendingWrite.targetId) === pendingWrite
      ) {
        setInstructionsOutcomeUnknown(true)
      }
    } finally {
      if (
        selectedDeviceIdRef.current === pendingWrite.targetId &&
        saveGeneration.current === targetGeneration &&
        instructionsReadGeneration.current === readGeneration
      ) {
        setInstructionsLoading(false)
      }
    }
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
    if (
      instructionsSavingOperations.current.has(targetDeviceId) ||
      (gatewayPage &&
        (!instructionsBaselineVerified || pendingInstructionsWrites.current.has(targetDeviceId)))
    ) {
      return
    }
    const generation = ++saveGeneration.current
    const nextInstructions = instructions
    const draftRevision = getDraftRevision(targetDeviceId)
    const operation = {}
    instructionsSavingOperations.current.set(targetDeviceId, operation)
    setInstructionsSaving(true)
    setInstructionsSaved(false)
    setInstructionsSavedPreviousDraft(false)
    setInstructionsReconciledMismatch(false)
    setInstructionsReconciledMatch(false)
    setInstructionsError(null)
    try {
      const response = gatewayPage
        ? await saveGatewayInstructions(targetDeviceId, nextInstructions)
        : targetDeviceId
          ? await saveLocalCodexInstructions(nextInstructions, targetDeviceId)
          : await saveLocalCodexInstructions(nextInstructions)
      if (gatewayPage && response.instructions !== nextInstructions) {
        const pendingWrite = {
          targetId: targetDeviceId,
          instructions: nextInstructions,
          draftRevision,
        }
        if (instructionsSavingOperations.current.get(targetDeviceId) === operation) {
          pendingInstructionsWrites.current.set(targetDeviceId, pendingWrite)
          if (
            selectedDeviceIdRef.current === targetDeviceId &&
            generation === saveGeneration.current
          ) {
            setInstructionsOutcomeUnknown(true)
            setInstructionsError(null)
            void checkCurrentInstructions(pendingWrite)
          }
        }
        return
      }
      if (gatewayPage && instructionsSavingOperations.current.get(targetDeviceId) === operation) {
        instructionsSavedBaselines.current.set(targetDeviceId, response.instructions)
        if (getDraftRevision(targetDeviceId) === draftRevision) {
          instructionsDrafts.current.set(targetDeviceId, response.instructions)
        }
      }
      if (selectedDeviceIdRef.current !== targetDeviceId || generation !== saveGeneration.current) {
        return
      }
      setSavedInstructions(response.instructions)
      setInstructionsBaselineVerified(true)
      if (gatewayPage) {
        instructionsSavedBaselines.current.set(targetDeviceId, response.instructions)
        const newerDraft = getDraftRevision(targetDeviceId) !== draftRevision
        if (!newerDraft) {
          setInstructions(response.instructions)
          instructionsDrafts.current.set(targetDeviceId, response.instructions)
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
          targetId: targetDeviceId,
          instructions: nextInstructions,
          draftRevision,
        }
        const ownsOperation = instructionsSavingOperations.current.get(targetDeviceId) === operation
        if (ownsOperation) {
          pendingInstructionsWrites.current.set(targetDeviceId, pendingWrite)
        }
        if (
          ownsOperation &&
          selectedDeviceIdRef.current === targetDeviceId &&
          generation === saveGeneration.current
        ) {
          setInstructionsOutcomeUnknown(true)
          setInstructionsError(null)
          void checkCurrentInstructions(pendingWrite)
        }
      } else if (
        selectedDeviceIdRef.current === targetDeviceId &&
        (gatewayPage || generation === saveGeneration.current)
      ) {
        if (!gatewayPage) {
          console.error('[KCoder Studio] Failed to save KCoder custom instructions', saveError)
        }
        setInstructionsError(t('workbench.context_settings_kcoder_instructions_save_failed'))
      }
    } finally {
      if (instructionsSavingOperations.current.get(targetDeviceId) === operation) {
        instructionsSavingOperations.current.delete(targetDeviceId)
      }
      if (selectedDeviceIdRef.current === targetDeviceId) {
        setInstructionsSaving(instructionsSavingOperations.current.has(targetDeviceId))
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
              selectedDeviceIdRef.current = nextTargetId
              saveGeneration.current += 1
              instructionsReadGeneration.current += 1
              setInstructionsLoading(true)
              setInstructionsSaving(instructionsSavingOperations.current.has(nextTargetId))
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

      {(!gatewayPage || selectedDeviceId) && <ToolProfileSettings serverId={selectedDeviceId} />}
      {gatewayPage && selectedDeviceId && <ImportedMemorySettings key={selectedDeviceId} deviceId={selectedDeviceId}/>}

      {(!gatewayPage || selectedDeviceId) && <CodexPersonalitySettings deviceId={selectedDeviceId || undefined} />}

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
            <span>
              {instructionsSaving
                ? t('workbench.context_settings_kcoder_instructions_saving')
                : instructionsSaved && !instructionsDirty
                  ? t('workbench.context_settings_kcoder_instructions_saved')
                  : t('workbench.context_settings_kcoder_instructions_save')}
            </span>
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
              disabled={instructionsSaving || (gatewayPage && !selectedDeviceId)}
              onChange={event => {
                const nextDraft = event.target.value
                instructionsDraftRevisions.current.set(
                  selectedDeviceId,
                  getDraftRevision(selectedDeviceId) + 1
                )
                instructionsDrafts.current.set(selectedDeviceId, nextDraft)
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
          {instructionsError ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-red-500">
              <p data-testid="context-studio-instructions-error" role="alert">
                {instructionsError}
              </p>
              {gatewayPage && !instructionsLoading && !instructionsBaselineVerified && (
                <button
                  type="button"
                  data-testid="context-studio-instructions-retry"
                  onClick={() => setInstructionsRefreshRevision(value => value + 1)}
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
                    const pendingWrite = pendingInstructionsWrites.current.get(selectedDeviceId)
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
