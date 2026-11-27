import { useContext, useEffect, useId, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { ReserveText, StableLabel, StableStatus } from '@/components/ui/stable-content'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { useTranslation } from '@/hooks/useTranslation'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { supportsSelfEvolution } from '@/kcoder/evolution/evolutionApi'
import {
  EVOLUTION_TARGET_TYPES,
  type EvolutionMode,
  type EvolutionSettings,
  type EvolutionStatusResult,
  type EvolutionTargetType,
} from '@/kcoder/evolution/evolutionContract'
import {
  DISTILL_FREQUENCIES,
  FOLLOW_SESSION_VALUE,
  distillFrequency,
  isModelMissing,
  targetEnabled,
  targetSetting,
  withTarget,
} from '@/kcoder/evolution/evolutionSettingsModel'
import {
  IconSelect,
  InfoBox,
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
  StatusChip,
} from './settings-ui'
import { SettingsSelect } from './SettingsSelect'
import { EvolutionAdvancedSection } from './self-evolution/EvolutionAdvancedSection'
import { EvolutionDataSection } from './self-evolution/EvolutionDataSection'
import { EvolutionModelSelect } from './self-evolution/EvolutionModelSelect'
import { EvolutionPreferencesPanel } from './self-evolution/EvolutionPreferencesPanel'
import { EvolutionTargetList } from './self-evolution/EvolutionTargetList'
import { useEvolutionModelOptions } from './self-evolution/useEvolutionModelOptions'
import { useEvolutionSettings } from './self-evolution/useEvolutionSettings'

const MODES: EvolutionMode[] = ['observe', 'propose', 'auto']
const SIGNALS = ['artifact_edits', 'procedure_results', 'chat_corrections', 'rating_ui'] as const
// Client-scoped acknowledgement of the extra-model-call explanation (UI preference only).
const COST_NOTICE_KEY = 'kcoder.selfEvolution.costNoticeAcknowledged'

function costNoticeAcknowledged() {
  try {
    return window.localStorage.getItem(COST_NOTICE_KEY) === '1'
  } catch {
    return false
  }
}

function acknowledgeCostNotice() {
  try {
    window.localStorage.setItem(COST_NOTICE_KEY, '1')
  } catch {
    // Storage may be unavailable; the dialog then simply shows again next time.
  }
}

function targetLabel(target: GatewayServer) {
  return target.label || target.id
}

type SaveStatus = 'saving' | 'saved' | null

/** Saving/saved feedback in a reserved slot beside the target name, so saves never push the page. */
function SaveStatusSlot({ status }: { status: SaveStatus }) {
  const { t } = useTranslation('evolution')
  const icon = 'h-3.5 w-3.5 shrink-0'
  return (
    <StableStatus
      data-testid="self-evolution-save-status"
      data-status={status ?? 'idle'}
      className="shrink-0 text-xs text-text-secondary"
      itemClassName="inline-flex items-center gap-1.5 whitespace-nowrap"
      reserve={[
        <>
          <span className={icon} />
          <ReserveText text={t('notice.saving')} />
        </>,
        <>
          <span className={icon} />
          <ReserveText text={t('notice.saved')} />
        </>,
      ]}
    >
      {status === 'saving' ? (
        <>
          <Loader2 className={`${icon} animate-spin motion-reduce:animate-none`} aria-hidden="true" />
          {t('notice.saving')}
        </>
      ) : status === 'saved' ? (
        <>
          <Check className={icon} aria-hidden="true" />
          {t('notice.saved')}
        </>
      ) : null}
    </StableStatus>
  )
}

export function SelfEvolutionSettingsPage() {
  const { t } = useTranslation('evolution')
  const targets = useRuntimeSettingsTargets()
  const scope = usePluginTargetScope(targets.selectedServerId)
  return (
    <SettingsPage data-testid="self-evolution-settings-page">
      <SettingsPageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          targets.targets.length > 0 ? (
            <IconSelect
              icon={<Server className="h-4 w-4" />}
              data-testid="self-evolution-target"
              aria-label={t('page.target')}
              value={targets.selectedServerId}
              disabled={targets.loading}
              onChange={event => targets.selectTarget(event.target.value)}
            >
              <option value="" disabled>
                {t('page.target')}
              </option>
              {targets.targets.map(target => (
                <option key={target.id} value={target.id}>
                  {targetLabel(target)}
                </option>
              ))}
            </IconSelect>
          ) : undefined
        }
      />
      {targets.error && (
        <InfoBox role="alert" data-testid="self-evolution-targets-error">
          {t(targets.error === 'unsupported' ? 'page.hostUnsupported' : 'page.targetsLoadFailed')}
        </InfoBox>
      )}
      {targets.loading && !targets.selectedTarget && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('page.loading')}
        </p>
      )}
      {targets.selectedTarget && (
        <SelfEvolutionTargetGate
          key={scope.key}
          target={targets.selectedTarget}
          isCurrent={scope.isCurrent}
        />
      )}
    </SettingsPage>
  )
}

function SelfEvolutionTargetGate({
  target,
  isCurrent,
}: {
  target: GatewayServer
  isCurrent: () => boolean
}) {
  const { t } = useTranslation('evolution')
  const workbench = useContext(WorkbenchContext)
  // Project-scoped data belongs to the workspace the user is working in on this target.
  const current = workbench ? workbenchModelTarget(workbench.state) : null
  const workspace =
    (current?.deviceId === target.id ? current.workspacePath : undefined) ?? target.workspacePath
  const [supported, setSupported] = useState<boolean | 'failed' | null>(null)
  const [probe, setProbe] = useState(0)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null)
  useEffect(() => {
    let active = true
    supportsSelfEvolution(target.id).then(
      value => {
        if (active && isCurrent()) setSupported(value)
      },
      () => {
        if (active && isCurrent()) setSupported('failed')
      }
    )
    return () => {
      active = false
    }
  }, [isCurrent, probe, target.id])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p data-testid="self-evolution-target-name" className="min-w-0 text-sm text-text-secondary">
          {t('page.currentTarget', { name: targetLabel(target) })}
        </p>
        <SaveStatusSlot status={supported === true ? saveStatus : null} />
      </div>
      {supported === null && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('page.loading')}
        </p>
      )}
      {supported === false && (
        <InfoBox
          data-testid="self-evolution-unsupported"
          icon={<AlertTriangle />}
          title={t('page.unsupportedTitle')}
        >
          {t('page.unsupported')}
        </InfoBox>
      )}
      {supported === 'failed' && (
        <InfoBox role="alert" icon={<AlertTriangle />}>
          {t('page.probeFailed')}{' '}
          <Button type="button" variant="link" size="sm" onClick={() => setProbe(value => value + 1)}>
            {t('actions.retry')}
          </Button>
        </InfoBox>
      )}
      {supported === true && (
        <SelfEvolutionEditor
          serverId={target.id}
          workspace={workspace}
          isCurrent={isCurrent}
          onSaveStatus={setSaveStatus}
        />
      )}
    </div>
  )
}

function disabledReasonOf(status: EvolutionStatusResult | null) {
  const reason = status?.disabledReason ?? null
  return {
    reason,
    // Training mode and a project-level opt-out lock every control on this page.
    locked: reason === 'training_mode' || reason === 'project_disabled',
  }
}

function SelfEvolutionEditor({
  serverId,
  workspace,
  isCurrent,
  onSaveStatus,
}: {
  serverId: string
  workspace?: string
  isCurrent: () => boolean
  onSaveStatus: (status: SaveStatus) => void
}) {
  const { t, i18n } = useTranslation('evolution')
  const id = useId()
  const state = useEvolutionSettings(serverId, isCurrent)
  const models = useEvolutionModelOptions(serverId)
  const [costDialog, setCostDialog] = useState(false)
  const [openTypes, setOpenTypes] = useState<Set<EvolutionTargetType>>(new Set())
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const { settings, status } = state
  const { reason, locked } = disabledReasonOf(status)
  const disabled = !settings || state.loading || state.saving || state.blocked || locked
  const save = (next: EvolutionSettings) => state.save(next)
  const saveStatus: SaveStatus = state.saving ? 'saving' : state.notice === 'saved' ? 'saved' : null
  useEffect(() => {
    onSaveStatus(saveStatus)
  }, [onSaveStatus, saveStatus])
  useEffect(() => () => onSaveStatus(null), [onSaveStatus])

  // Render the editor once its first status and model catalog reads have settled, so
  // lock reasons, implemented types, usage and model warnings arrive with the layout
  // instead of being inserted above or between rows a moment later.
  const firstReadsSettled = (status !== null || state.statusFailed) && !models.loading
  if (!settings || !firstReadsSettled) {
    return state.notice === 'load_failed' ? (
      <InfoBox role="alert" icon={<AlertTriangle />} data-testid="self-evolution-load-failed">
        {t('notice.load_failed')}{' '}
        <Button type="button" variant="link" size="sm" onClick={() => void state.refresh()}>
          {t('actions.retry')}
        </Button>
      </InfoBox>
    ) : (
      <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t('page.loading')}
      </p>
    )
  }

  const statusTarget = (type: EvolutionTargetType) => status?.targets.find(item => item.type === type)
  const modelMissing = isModelMissing(settings.model ?? null, models.options) && !models.loading
  const usage = status?.usageThisMonth
  const frequency = distillFrequency(settings.distill_min_usages)

  return (
    <div className="flex flex-col gap-4" data-testid="self-evolution-editor">
      {reason && (
        <InfoBox
          role="status"
          icon={<AlertTriangle />}
          data-testid="self-evolution-disabled-reason"
          data-reason={reason}
        >
          {t(`disabledReason.${reason}`)}
        </InfoBox>
      )}
      {status?.diagnostics?.projectScopeIssue && (
        <InfoBox
          role="status"
          data-testid="self-evolution-project-scope-issue"
          data-issue={status.diagnostics.projectScopeIssue}
        >
          {t(`page.projectScopeIssue.${status.diagnostics.projectScopeIssue}`)}
        </InfoBox>
      )}
      {state.notice && state.notice !== 'saved' && (
        <InfoBox role="alert" icon={<AlertTriangle />} data-testid="self-evolution-notice" data-notice={state.notice}>
          {t(`notice.${state.notice}`)}{' '}
          <Button
            type="button"
            variant="link"
            size="sm"
            data-testid="self-evolution-refresh"
            onClick={() => void state.refresh()}
          >
            <RefreshCw aria-hidden="true" />
            {t('actions.refresh')}
          </Button>
        </InfoBox>
      )}
      <SettingsGroup>
        <SettingsRow
          label={t('master.label')}
          description={t('master.description')}
          control={
            <SettingsSwitch
              data-testid="self-evolution-master"
              aria-label={t('master.label')}
              checked={settings.enabled}
              disabled={disabled}
              onCheckedChange={checked => {
                if (checked && !costNoticeAcknowledged()) setCostDialog(true)
                else void save({ ...settings, enabled: checked })
              }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup>
        <fieldset className="studio-card-inset flex flex-col gap-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium text-text-primary">{t('mode.label')}</legend>
          {MODES.map(mode => (
            <label key={mode} className="flex min-h-11 items-start gap-2 text-sm md:min-h-8">
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                data-testid={`self-evolution-mode-${mode}`}
                checked={settings.mode === mode}
                onChange={() => void save({ ...settings, mode })}
                className="mt-1"
              />
              <span>
                <span className="text-text-primary">{t(`mode.options.${mode}`)}</span>
                <span className="block text-xs text-text-secondary">{t(`mode.descriptions.${mode}`)}</span>
                {mode === 'auto' && (
                  // Always laid out with the Auto option so choosing it never inserts a line.
                  <span
                    role="note"
                    data-testid="self-evolution-auto-warning"
                    data-active={settings.mode === 'auto' ? 'true' : 'false'}
                    className={`block text-xs ${settings.mode === 'auto' ? 'text-text-primary' : 'text-text-secondary'}`}
                  >
                    {t('mode.autoWarning')}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      </SettingsGroup>

      <section aria-labelledby={`${id}-targets`} className="flex flex-col gap-2">
        <h2 id={`${id}-targets`} className="heading-sm text-text-primary">
          {t('targets.title')}
        </h2>
        <SettingsGroup>
          {EVOLUTION_TARGET_TYPES.map(type => {
            const info = statusTarget(type)
            const implemented = info?.implemented === true
            const open = openTypes.has(type)
            return (
              <div key={type} data-testid={`self-evolution-target-${type}`} data-implemented={implemented}>
                <SettingsRow
                  label={
                    <span className="flex flex-wrap items-center gap-2">
                      {t(`targets.types.${type}`)}
                      {!implemented && <StatusChip>{t('targets.comingSoon')}</StatusChip>}
                    </span>
                  }
                  description={
                    implemented ? (
                      <span className="tabular-nums">
                        {t('targets.counts', {
                          learned: info?.learnedItems ?? 0,
                          pending: info?.pendingProposals ?? 0,
                        })}
                      </span>
                    ) : (
                      t('targets.notImplemented')
                    )
                  }
                  control={
                    <>
                      {implemented && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={open}
                          data-testid={`self-evolution-target-open-${type}`}
                          onClick={() =>
                            setOpenTypes(current => {
                              const next = new Set(current)
                              if (next.has(type)) next.delete(type)
                              else next.add(type)
                              return next
                            })
                          }
                        >
                          <StableLabel alternatives={[t('targets.hideObjects'), t('targets.showObjects')]}>
                            {t(open ? 'targets.hideObjects' : 'targets.showObjects')}
                          </StableLabel>
                        </Button>
                      )}
                      <SettingsSwitch
                        data-testid={`self-evolution-target-toggle-${type}`}
                        aria-label={t(`targets.types.${type}`)}
                        checked={implemented && targetEnabled(settings, type)}
                        disabled={disabled || !implemented}
                        onCheckedChange={checked =>
                          void save(withTarget(settings, type, { enabled: checked }))
                        }
                      />
                    </>
                  }
                />
                {type === 'skill' && implemented && status?.skillFileEditsSupported === true && (
                  <SettingsRow
                    label={t('targets.allowFileEdits')}
                    description={t('targets.allowFileEditsDescription')}
                    control={
                      <SettingsSwitch
                        data-testid="self-evolution-allow-file-edits"
                        aria-label={t('targets.allowFileEdits')}
                        checked={targetSetting(settings, 'skill').allow_file_edits === true}
                        disabled={disabled}
                        onCheckedChange={checked =>
                          void save(withTarget(settings, 'skill', { allow_file_edits: checked }))
                        }
                      />
                    }
                  />
                )}
                {open && implemented && (
                  <EvolutionTargetList
                    serverId={serverId}
                    type={type}
                    settings={settings}
                    disabled={disabled}
                    isCurrent={isCurrent}
                    onSave={next => void save(next)}
                  />
                )}
              </div>
            )
          })}
        </SettingsGroup>
      </section>

      <section aria-labelledby={`${id}-signals`} className="flex flex-col gap-2">
        <h2 id={`${id}-signals`} className="heading-sm text-text-primary">
          {t('signals.title')}
        </h2>
        <SettingsGroup>
          {SIGNALS.map(signal => (
            <SettingsRow
              key={signal}
              label={t(`signals.${signal}.label`)}
              description={t(`signals.${signal}.description`)}
              control={
                <SettingsSwitch
                  data-testid={`self-evolution-signal-${signal}`}
                  aria-label={t(`signals.${signal}.label`)}
                  checked={settings.signals[signal]}
                  disabled={disabled}
                  onCheckedChange={checked =>
                    void save({ ...settings, signals: { ...settings.signals, [signal]: checked } })
                  }
                />
              }
            />
          ))}
        </SettingsGroup>
      </section>

      <SettingsGroup>
        <SettingsRow
          label={t('preferences.title')}
          description={t('preferences.description')}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={preferencesOpen}
              data-testid="self-evolution-preferences-toggle"
              onClick={() => setPreferencesOpen(value => !value)}
            >
              <StableLabel alternatives={[t('preferences.hide'), t('preferences.show')]}>
                {t(preferencesOpen ? 'preferences.hide' : 'preferences.show')}
              </StableLabel>
            </Button>
          }
        />
        {preferencesOpen && (
          <EvolutionPreferencesPanel serverId={serverId} disabled={locked} isCurrent={isCurrent} />
        )}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={<label htmlFor={`${id}-model`}>{t('model.label')}</label>}
          description={
            <>
              {t('model.description')}
              {models.failed && <span className="block">{t('model.catalogFailed')}</span>}
              {(modelMissing || (status?.model.available === false && settings.model)) && (
                <span
                  id={`${id}-model-error`}
                  role="alert"
                  data-testid="self-evolution-model-unavailable"
                  className="block text-destructive"
                >
                  {t('model.unavailable')}
                </span>
              )}
            </>
          }
          control={
            <EvolutionModelSelect
              id={`${id}-model`}
              testId="self-evolution-model"
              label={t('model.label')}
              value={settings.model ?? null}
              sentinelValue={FOLLOW_SESSION_VALUE}
              sentinelLabel={t('model.followSession')}
              options={models.options}
              disabled={disabled}
              describedBy={modelMissing ? `${id}-model-error` : undefined}
              onChange={ref => void save({ ...settings, model: ref })}
            />
          }
        />
      </SettingsGroup>

      <section aria-labelledby={`${id}-usage`} className="flex flex-col gap-2">
        <h2 id={`${id}-usage`} className="heading-sm text-text-primary">
          {t('usage.title')}
        </h2>
        <SettingsGroup>
          <SettingsRow
            label={t('usage.frequency')}
            description={t('usage.frequencyDescription')}
            control={
              <SettingsSelect
                data-testid="self-evolution-frequency"
                aria-label={t('usage.frequency')}
                value={frequency}
                disabled={disabled}
                onChange={event => {
                  const value = event.target.value as keyof typeof DISTILL_FREQUENCIES
                  if (value in DISTILL_FREQUENCIES)
                    void save({ ...settings, distill_min_usages: DISTILL_FREQUENCIES[value] })
                }}
              >
                {(Object.keys(DISTILL_FREQUENCIES) as (keyof typeof DISTILL_FREQUENCIES)[]).map(value => (
                  <option key={value} value={value}>
                    {t(`usage.frequencies.${value}`)}
                  </option>
                ))}
                {frequency === 'custom' && (
                  <option value="custom" disabled>
                    {t('usage.frequencies.custom', { count: settings.distill_min_usages })}
                  </option>
                )}
              </SettingsSelect>
            }
          />
          <SettingsRow
            label={t('usage.thisMonth')}
            description={
              usage ? (
                <span data-testid="self-evolution-usage" className="tabular-nums">
                  {t('usage.tokens', {
                    input: usage.inputTokens.toLocaleString(i18n.resolvedLanguage),
                    output: usage.outputTokens.toLocaleString(i18n.resolvedLanguage),
                  })}
                  {' · '}
                  {usage.estimatedCost
                    ? t('usage.cost', {
                        cost: usage.estimatedCost.amount.toLocaleString(i18n.resolvedLanguage, {
                          style: 'currency',
                          currency: usage.estimatedCost.currency,
                        }),
                      })
                    : t('usage.costUnknown')}
                </span>
              ) : (
                t(state.statusFailed ? 'usage.unavailable' : 'usage.loading')
              )
            }
          />
        </SettingsGroup>
      </section>

      <section aria-labelledby={`${id}-data`} className="flex flex-col gap-2">
        <h2 id={`${id}-data`} className="heading-sm text-text-primary">
          {t('data.title')}
        </h2>
        <SettingsGroup>
          <EvolutionDataSection
            serverId={serverId}
            workspace={workspace}
            settings={settings}
            disabled={disabled}
            isCurrent={isCurrent}
            onSave={next => void save(next)}
            onCleared={() => void state.refreshStatus()}
          />
        </SettingsGroup>
      </section>

      <SettingsGroup>
        <EvolutionAdvancedSection
          settings={settings}
          modelOptions={models.options}
          disabled={disabled}
          onSave={save}
        />
      </SettingsGroup>

      {costDialog && (
        <ModalDialog
          title={t('costDialog.title')}
          testId="self-evolution-cost-dialog"
          onClose={() => setCostDialog(false)}
          closeLabel={t('actions.dismiss')}
        >
          <p className="text-sm text-text-secondary">{t('costDialog.body')}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCostDialog(false)}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              data-testid="self-evolution-cost-confirm"
              onClick={() => {
                setCostDialog(false)
                acknowledgeCostNotice()
                void save({ ...settings, enabled: true })
              }}
            >
              {t('costDialog.confirm')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
