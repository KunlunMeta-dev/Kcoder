import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import {
  createScheduledWorkflowTask,
  type ScheduledWorkflowChoice,
} from './createScheduledWorkflowTask'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import { ScheduledWorkflowTasks } from './ScheduledWorkflowTasks'
import { ScheduleTimeInput } from './ScheduleTimeInput'
import { AutomationRunHistory } from '@/features/automations/AutomationRunHistory'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Checkbox } from '@/components/ui/checkbox'
import { PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS } from '@/components/ui/page-content'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  History,
  Inbox,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
} from 'lucide-react'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useAutomationIdentity } from './useAutomationIdentity'
import { useAutomationDefaultTarget } from './useAutomationDefaultTarget'
import { useSchedulePreview } from './useSchedulePreview'
import {
  automationTargets,
  requestAutomation,
  type ScheduledJob,
} from '@/kcoder/gatewayAutomationApi'
import {
  SCHEDULE_PRESETS,
  describeSchedule,
  formatLocalTime,
  parseLocalTimeInput,
  zonedCronFromPreset,
  type SchedulePresetId,
} from './schedulePresets'

const DEFAULT_LOCAL_TIME = { hour: 9, minute: 0 }

export function ScheduledTasksPanel({
  runtimeWork,
  currentHostId,
  onOpenTask,
}: {
  runtimeWork: RuntimeWorkListResponse | null
  currentHostId?: string
  onOpenTask?: (address: RuntimeTaskAddress) => Promise<unknown>
}) {
  const { t, i18n } = useTranslation('common')
  const { t: knowledgeT } = useTranslation('knowledgeIntegration')
  const workflowDefaultsRequiredLabel = t('automations.workflowDefaultsRequired')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const workTargets = useMemo(
    () => automationTargets(runtimeWork, t('runtimeTarget.currentComputer'), currentHostId),
    [runtimeWork, t, currentHostId]
  )
  const fallback = useAutomationDefaultTarget(
    currentHostId,
    !workTargets.some(item => item.isCurrentHost)
  )
  const currentComputerLabel = t('runtimeTarget.currentComputer')
  const resolvedTargets = fallback
    ? automationTargets(runtimeWork, currentComputerLabel, currentHostId ?? fallback.id)
    : workTargets
  const fallbackKey = fallback?.workspacePath
    ? `${fallback.id}\0${fallback.workspacePath}`
    : undefined
  const allTargets =
    fallbackKey && !resolvedTargets.some(item => item.key === fallbackKey)
      ? [
          ...resolvedTargets,
          {
            key: fallbackKey,
            label: currentComputerLabel,
            address: { deviceId: fallback!.id, workspacePath: fallback!.workspacePath! },
            isCurrentHost: true,
          },
        ]
      : resolvedTargets
  const localCount = allTargets.filter(item => item.isCurrentHost).length
  const targets = allTargets.map(item =>
    item.isCurrentHost
      ? {
          ...item,
          label:
            localCount > 1
              ? `${currentComputerLabel} · ${item.address.workspacePath}`
              : currentComputerLabel,
        }
      : item
  )
  const [selected, setSelected] = useState('')
  const target = selected
    ? targets.find(item => item.key === selected)
    : (targets.find(item => item.key === fallbackKey) ?? targets.find(item => item.isCurrentHost))
  const targetKey = target ? String(target.key) : undefined
  const targetDeviceId = target ? String(target.address.deviceId) : undefined
  const targetWorkspacePath = target ? String(target.address.workspacePath) : undefined
  const [view, setView] = useState<'settings' | 'history' | 'inbox'>('settings')
  const [listing, setListing] = useState<{ key: string; jobs: ScheduledJob[] } | null>(null)
  const jobs = target && listing?.key === target.key ? listing.jobs : []
  const workflowCreated = useCallback(() => setView('history'), [setView])
  const [workflowChoice, setWorkflowChoice] = useState<ScheduledWorkflowChoice | null>(null)
  const [creationKind, setCreationKind] = useState<'prompt' | 'workflow'>('prompt')
  const [workflowBlocked, setWorkflowBlocked] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState<SchedulePresetId>('at')
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [when, setWhen] = useState('')
  const [timeOfDay, setTimeOfDay] = useState(formatLocalTime(DEFAULT_LOCAL_TIME))
  const [interval, setInterval] = useState('3600')
  const [expression, setExpression] = useState('0 9 * * *')
  const [confirmedTarget, setConfirmedTarget] = useState<string | null>(null)
  const confirmed = Boolean(target && confirmedTarget === target.key)
  const [unconfirmedAction, setUnconfirmedAction] = useState<'create' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [presetMenu, setPresetMenu] = useState<HTMLDivElement | null>(null)
  const generation = useRef(0)
  const scopeEpoch = useRef(0)
  const invalidateScope = useCallback(
    (ownerChanged: boolean) => {
      setConfirmedTarget(null)
      if (!ownerChanged) return
      setUnconfirmedAction(null)
      scopeEpoch.current += 1
      generation.current += 1
      setListing(null)
      setPrompt('')
      setTitle('')
      setConfirmedTarget(null)
      setPendingDelete(null)
      setBusy(false)
      setError('')
    },
    [
      setListing,
      setPrompt,
      setTitle,
      setConfirmedTarget,
      setPendingDelete,
      setBusy,
      setError,
      setUnconfirmedAction,
    ]
  )
  const identity = useAutomationIdentity(target?.address, invalidateScope)
  const [workflowOwner, setWorkflowOwner] = useState<{ target: string; fingerprint: string }>()
  const observedWorkflowOwner =
    identity.server && target ? hookTargetScope(identity.server) : undefined
  if (
    target &&
    observedWorkflowOwner &&
    (workflowOwner?.target !== target.key || workflowOwner.fingerprint !== observedWorkflowOwner)
  )
    setWorkflowOwner({ target: target.key, fingerprint: observedWorkflowOwner })
  const workflowOwnerKey =
    workflowOwner?.target === target?.key ? workflowOwner?.fingerprint : undefined

  const refresh = useCallback(async () => {
    const current = ++generation.current
    if (
      !targetKey ||
      !targetDeviceId ||
      !targetWorkspacePath ||
      !identity.ready ||
      !identity.server
    )
      return
    try {
      const result = await requestAutomation<{ jobs: ScheduledJob[] }>(
        { deviceId: targetDeviceId, workspacePath: targetWorkspacePath },
        'cron/list'
      )
      if (current === generation.current) {
        setListing({ key: targetKey, jobs: result.jobs })
        setError('')
      }
    } catch (failure) {
      if (current === generation.current) {
        setError(
          failure instanceof KnowledgeOperationError && failure.code === 'AUTOMATION_INVALID_INPUTS'
            ? workflowDefaultsRequiredLabel
            : String(failure instanceof Error ? failure.message : failure)
        )
      }
    }
  }, [
    targetKey,
    targetDeviceId,
    targetWorkspacePath,
    identity.ready,
    identity.server,
    setListing,
    setError,
    workflowDefaultsRequiredLabel,
  ])
  useEffect(() => {
    const requestGeneration = generation
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => {
      ++requestGeneration.current
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    if (!presetMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!presetMenu?.contains(event.target as Node)) setPresetMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [presetMenuOpen, presetMenu])

  const activePresetLabel = (id: SchedulePresetId) =>
    t(`automations.presets.${SCHEDULE_PRESETS.find(item => item.id === id)?.labelKey ?? id}`)

  // Presets retain their local calendar and zone; legacy custom cron remains UTC.
  const buildSchedule = (): ScheduledJob['schedule'] | null => {
    if (preset === 'at') {
      if (!when) return null
      const instant = new Date(when)
      return Number.isFinite(instant.getTime()) ? { kind: 'at', at: instant.toISOString() } : null
    }
    if (preset === 'interval') {
      const seconds = Number(interval)
      if (!Number.isSafeInteger(seconds) || seconds < 60) return null
      return { kind: 'every', every_seconds: seconds }
    }
    if (preset === 'cron') {
      if (!expression.trim()) return null
      return { kind: 'cron', expression: expression.trim() }
    }
    const time = parseLocalTimeInput(timeOfDay)
    if (!time) return null
    const compiled = zonedCronFromPreset(preset, time, timezone)
    return compiled
  }
  const scheduleForForm = buildSchedule()
  const scheduleReady = Boolean(scheduleForForm)
  const preview = useSchedulePreview(
    target?.address,
    scheduleForForm,
    identity.server,
    identity.ready
  )

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!target || !identity.ready || busy || !confirmed || !scheduleForForm || unconfirmedAction)
      return
    const epoch = scopeEpoch.current
    setBusy(true)
    setError('')
    try {
      const trimmedTitle = title.trim()
      const body = trimmedTitle ? `# ${trimmedTitle}\n\n${prompt}` : prompt
      if (creationKind === 'workflow') {
        if (!workflowChoice) return
        await createScheduledWorkflowTask({
          address: target.address,
          workflow: workflowChoice,
          title: trimmedTitle,
          schedule: scheduleForForm,
          timezone: timezone || 'UTC',
          isCurrent: () => epoch === scopeEpoch.current,
        })
      } else {
        await requestAutomation(target.address, 'cron/create', {
          prompt: body,
          schedule: scheduleForForm,
          confirmed: true,
        })
      }
      if (epoch !== scopeEpoch.current) return
      setPrompt('')
      setTitle('')
      setConfirmedTarget(null)
      await refresh()
      if (epoch !== scopeEpoch.current) return
      setView('history')
    } catch (failure) {
      if (epoch === scopeEpoch.current) {
        setConfirmedTarget(null)
        setUnconfirmedAction(
          failure instanceof KnowledgeOperationError && !failure.uncertain ? null : 'create'
        )
        setError(
          failure instanceof KnowledgeOperationError && failure.code === 'AUTOMATION_INVALID_INPUTS'
            ? t('automations.workflowDefaultsRequired')
            : String(failure instanceof Error ? failure.message : failure)
        )
      }
    } finally {
      if (epoch === scopeEpoch.current) setBusy(false)
    }
  }

  const timeZoneLabel = timezone || t('automations.timezoneUnavailable')
  const field =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary'

  const pill =
    'rounded-lg px-3 py-1.5 text-sm transition-colors aria-pressed:bg-surface aria-pressed:font-medium'

  const renderScheduleField = () => {
    if (preset === 'at') {
      return (
        <ScheduleTimeInput
          type="datetime-local"
          value={when}
          onChange={setWhen}
          testId="automation-at"
        />
      )
    }
    if (preset === 'interval') {
      return (
        <input
          data-testid="automation-interval"
          type="number"
          required
          min={60}
          value={interval}
          onChange={event => setInterval(event.target.value)}
          className={`${field} max-w-32`}
        />
      )
    }
    if (preset === 'cron') {
      return (
        <input
          data-testid="automation-cron"
          required
          value={expression}
          onChange={event => setExpression(event.target.value)}
          className={`${field} max-w-64 font-mono`}
          placeholder="0 1 * * *"
        />
      )
    }
    return (
      <ScheduleTimeInput
        type="time"
        value={timeOfDay}
        onChange={setTimeOfDay}
        testId="automation-time-of-day"
      />
    )
  }

  const scheduleDescription = (() => {
    if (preset === 'at') {
      return when
        ? describeSchedule({ kind: 'at', at: new Date(when).toISOString() }, t, i18n.language)
        : t('automations.presets.atHint')
    }
    if (preset === 'interval') {
      const seconds = Number(interval)
      return Number.isFinite(seconds) && seconds >= 60
        ? describeSchedule({ kind: 'every', every_seconds: seconds }, t, i18n.language)
        : t('automations.presets.intervalHint')
    }
    if (preset === 'cron') {
      return expression.trim()
        ? t('automations.describeCron', { expression: expression.trim() })
        : t('automations.presets.cronHint')
    }
    const time = parseLocalTimeInput(timeOfDay)
    if (!time) return t('automations.presets.timeHint')
    const compiled = zonedCronFromPreset(preset, time, timezone)
    return compiled
      ? describeSchedule(compiled, t, i18n.language)
      : t('automations.timezoneUnavailable')
  })()

  return (
    <section
      data-testid="scheduled-tasks-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-text-primary"
    >
      <WorkspacePageHeader
        title={t('automations.title')}
        actions={
          <SettingsSelect
            density="compact"
            icon={<Server />}
            aria-label={t('automations.target')}
            data-testid="automation-target"
            value={target?.key ?? ''}
            disabled={busy || workflowBlocked}
            onChange={event => {
              setSelected(event.target.value)
              setListing(null)
              setPendingDelete(null)
            }}
          >
            {!target && <option value="">{t(selected ? 'automations.selectedTargetUnavailable' : 'automations.currentHostUnavailable')}</option>}
            {targets.map(item => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </SettingsSelect>
        }
      />
      <div className="studio-page-gutter min-h-0 flex-1 overflow-y-auto py-7">
        <div className={`mx-auto min-w-0 w-full ${PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS}`}>
          <div className="mb-8 mt-4 flex items-center justify-between gap-3">
            <div
              className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-xl border border-border/60 bg-surface p-1 sm:flex sm:flex-none"
              role="tablist"
              aria-label={t('automations.title')}
            >
              {(['settings', 'history', 'inbox'] as const).map(key => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  disabled={workflowBlocked}
                  aria-selected={view === key}
                  onClick={() => setView(key)}
                  className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-[background-color,color,border-color,box-shadow,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40 sm:min-w-32 sm:px-5 ${view === key ? 'border-border/70 bg-background text-text-primary shadow-sm' : 'border-transparent text-text-secondary hover:bg-background/60 hover:text-text-primary'}`}
                  tabIndex={view === key ? 0 : -1}
                  onKeyDown={event => {
                    const keys = ['settings', 'history', 'inbox'] as const
                    const index = keys.indexOf(key)
                    const next =
                      event.key === 'ArrowRight'
                        ? (index + 1) % keys.length
                        : event.key === 'ArrowLeft'
                          ? (index + keys.length - 1) % keys.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? keys.length - 1
                              : -1
                    if (next < 0) return
                    event.preventDefault()
                    setView(keys[next]!)
                    const tabs =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]'
                      )
                    tabs?.[next]?.focus()
                  }}
                  data-testid={`automation-tab-${key}`}
                >
                  {key === 'settings' ? (
                    <Settings2 className="size-4 shrink-0" aria-hidden="true" />
                  ) : key === 'history' ? (
                    <History className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <Inbox className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  {key === 'inbox' ? knowledgeT('inbox') : t(`automations.tab_${key}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('kcoder:servers-changed', {
                    detail: { targetId: targetDeviceId },
                  })
                )
                void refresh()
              }}
              aria-label={t('automations.refresh')}
              className="rounded-lg p-2 text-text-secondary hover:bg-surface"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          {(error || identity.failure || unconfirmedAction) && (
            <p
              role="alert"
              className="mb-6 rounded-lg border border-red-500/30 p-3 text-sm text-red-500"
            >
              {unconfirmedAction ? knowledgeT('scheduledOutcomeUnknown') : t('automations.error')}:{' '}
              {error || identity.failure}
            </p>
          )}
          {unconfirmedAction && (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                className={pill}
                onClick={() => {
                  setView('history')
                  void refresh()
                }}
              >
                {knowledgeT('checkScheduledRecords')}
              </button>
              <button
                type="button"
                className={pill}
                onClick={() => {
                  setUnconfirmedAction(null)
                  setConfirmedTarget(null)
                  setView('settings')
                }}
              >
                {knowledgeT('acknowledgeUnknownNewIntent')}
              </button>
            </div>
          )}
          {view === 'settings' && (
            <div className="mb-8">
              <SettingsSelect
                aria-label={knowledgeT('scheduledTaskKind')}
                className={field}
                surfaceClassName="min-h-11 rounded-lg shadow-none"
                value={creationKind}
                disabled={busy || workflowBlocked}
                onChange={event => setCreationKind(event.target.value as typeof creationKind)}
                data-testid="scheduled-task-kind"
              >
                <option value="prompt">{knowledgeT('describeScheduledTask')}</option>
                <option value="workflow">{knowledgeT('runSavedWorkflow')}</option>
              </SettingsSelect>
            </div>
          )}
          {view === 'settings' && creationKind === 'workflow' && target && workflowOwnerKey && (
            <div className="mb-8">
              <ScheduledWorkflowTasks
                key={`${target.key}:${workflowOwnerKey}`}
                suspended={!identity.ready || busy}
                serverId={target.address.deviceId}
                workspacePath={target.address.workspacePath}
                view="create"
                selectionOnly
                onChoiceChange={setWorkflowChoice}
                onBlockedChange={setWorkflowBlocked}
                onCreated={workflowCreated}
              />
            </div>
          )}
          {view === 'settings' ? (
            <form onSubmit={submit}>
              <fieldset className="min-w-0 space-y-8" disabled={!identity.ready || busy}>
                <label className="block space-y-2">
                  <span className="text-sm text-text-secondary">{t('automations.titleLabel')}</span>
                  <input
                    data-testid="automation-title"
                    value={title}
                    maxLength={80}
                    onChange={event => setTitle(event.target.value)}
                    placeholder={t('automations.titlePlaceholder')}
                    className={`${field} h-11`}
                  />
                </label>
                <div className="space-y-2">
                  <span className="text-sm text-text-secondary">{t('automations.schedule')}</span>
                  <div className="studio-card-spacing flex flex-wrap items-center gap-3 rounded-xl border border-border">
                    <div className="relative" ref={setPresetMenu}>
                      <button
                        type="button"
                        data-testid="automation-kind"
                        disabled={busy}
                        onClick={() => setPresetMenuOpen(open => !open)}
                        className="flex h-10 min-w-32 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm hover:bg-surface"
                        aria-haspopup="listbox"
                        aria-expanded={presetMenuOpen}
                      >
                        {activePresetLabel(preset)}
                        <ChevronDown className="h-4 w-4 text-text-secondary" />
                      </button>
                      {presetMenuOpen && (
                        <div
                          role="listbox"
                          data-testid="automation-preset-menu"
                          className="absolute left-0 top-11 z-30 min-w-36 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg"
                        >
                          {SCHEDULE_PRESETS.map(item => (
                            <button
                              key={item.id}
                              type="button"
                              role="option"
                              data-testid={`automation-kind-${item.id}`}
                              aria-selected={preset === item.id}
                              onClick={() => {
                                setPreset(item.id)
                                setPresetMenuOpen(false)
                              }}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface"
                            >
                              {t(`automations.presets.${item.labelKey}`)}
                              {preset === item.id && <Check className="h-4 w-4 text-primary" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {(preset === 'daily' ||
                      preset === 'weekday' ||
                      preset === 'weekly' ||
                      preset === 'monthly') && (
                      <span className="flex items-center gap-2 text-sm text-text-secondary">
                        {t('automations.atWord')}
                        {renderScheduleField()}
                      </span>
                    )}
                    {(preset === 'at' || preset === 'interval' || preset === 'cron') &&
                      renderScheduleField()}
                    <span className="text-xs text-text-muted">{timeZoneLabel}</span>
                    <span
                      className="min-w-0 flex-1 truncate text-sm text-text-secondary"
                      data-testid="automation-schedule-description"
                    >
                      {scheduleDescription}
                    </span>
                    {preset === 'cron' && (
                      <Trash2
                        className="h-4 w-4 shrink-0 cursor-pointer text-text-secondary hover:text-red-500"
                        onClick={() => setExpression('0 9 * * *')}
                        aria-label={t('automations.presets.cronReset')}
                      />
                    )}
                  </div>
                </div>
                <p
                  className="text-xs text-text-secondary break-words"
                  data-testid="automation-preview"
                  aria-live="polite"
                >
                  {preview?.next
                    ? t('automations.previewNext', {
                        time: new Date(preview.next).toLocaleString(i18n.language),
                      })
                    : preview?.error
                      ? t('automations.previewFailed', { message: preview.error })
                      : scheduleReady && identity.ready
                        ? t('automations.previewLoading')
                        : t('automations.previewEmpty')}
                </p>
                <div className="space-y-2">
                  {creationKind === 'prompt' && (
                    <span className="text-sm text-text-secondary">{t('automations.prompt')}</span>
                  )}
                  <div className="overflow-hidden rounded-xl border border-border focus-within:border-primary/50">
                    {creationKind === 'prompt' && (
                      <textarea
                        data-testid="automation-prompt"
                        required
                        maxLength={10000}
                        value={prompt}
                        onChange={event => setPrompt(event.target.value)}
                        rows={5}
                        placeholder={t('automations.promptPlaceholder')}
                        className="block w-full resize-y border-0 bg-background px-4 py-3 text-sm text-text-primary focus:outline-none"
                      />
                    )}
                    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-surface/40 px-3 py-2">
                      <label
                        className="checkbox-option shrink-0 text-sm text-text-secondary"
                        title={t('automations.confirm')}
                      >
                        <Checkbox
                          data-testid="automation-confirm"
                          disabled={busy || !target || !identity.ready}
                          checked={confirmed}
                          onChange={event =>
                            setConfirmedTarget(event.target.checked ? (target?.key ?? null) : null)
                          }
                          className="h-4 w-4"
                        />
                        {t('automations.confirmShort')}
                      </label>
                    </div>
                  </div>
                  <p className="text-xs text-text-secondary" data-testid="automation-identity">
                    {t('automations.identityLabel')}:{' '}
                    {identity.server?.accountIdentity?.username ??
                      (identity.server?.security
                        ? t('automations.identityRequired')
                        : identity.ready
                          ? t('automations.identityCompatibility')
                          : '…')}
                  </p>
                </div>
                <button
                  data-testid="automation-create"
                  type="submit"
                  disabled={
                    !target ||
                    !identity.ready ||
                    !confirmed ||
                    busy ||
                    !scheduleReady ||
                    (creationKind === 'workflow' && !workflowChoice) ||
                    !!unconfirmedAction
                  }
                  className="rounded-xl bg-text-primary px-5 py-2.5 text-sm font-medium text-background transition-opacity disabled:opacity-40"
                >
                  {busy ? t('automations.saving') : t('automations.create')}
                </button>
              </fieldset>
            </form>
          ) : view === 'history' ? (
            <div className="space-y-4" data-testid="automation-jobs">
              {target && identity.ready && (
                <AutomationRunHistory
                  key={`${target.key}:${identity.server?.accountIdentity?.username ?? ''}`}
                  address={target.address}
                  onOpenTask={onOpenTask}
                />
              )}
              <p className="text-sm text-text-secondary">{t('automations.runResults')}</p>
              {!jobs.length && listing?.key === target?.key && !error && identity.ready && (
                <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
                  {t('automations.empty')}
                </p>
              )}
              {jobs.map(job => (
                <article
                  key={job.id}
                  data-testid="automation-job"
                  className="studio-card-spacing space-y-2 rounded-xl border border-border"
                >
                  <div className="flex items-start justify-between gap-4">
                    <p className="whitespace-pre-wrap break-words text-sm">{job.prompt}</p>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('automations.delete')}
                      onClick={() => setPendingDelete(job.id)}
                      className="shrink-0 rounded-md p-1.5 text-text-secondary hover:bg-surface hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="text-xs text-text-secondary">{t('automations.enabled')}</p>
                  <p className="text-xs text-text-secondary">
                    {describeSchedule(job.schedule, t, i18n.language)}
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                    <span>
                      {t('automations.next')}:{' '}
                      {new Date(job.next_run_at).toLocaleString(i18n.language)}
                    </span>
                    {job.last_fired_at && (
                      <span>
                        {t('automations.last')}:{' '}
                        {new Date(job.last_fired_at).toLocaleString(i18n.language)}
                      </span>
                    )}
                  </div>
                  {pendingDelete === job.id && (
                    <div
                      role="alertdialog"
                      className="flex flex-wrap items-center gap-3 rounded-lg bg-surface px-3 py-2 text-sm"
                    >
                      <span>{t('automations.deleteConfirm')}</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (!target || !identity.ready) return
                          const epoch = scopeEpoch.current
                          setBusy(true)
                          try {
                            const result = await requestAutomation<{ deleted: boolean }>(
                              target.address,
                              'cron/delete',
                              { jobId: job.id }
                            )
                            if (epoch !== scopeEpoch.current) return
                            if (!result.deleted) throw new Error(t('automations.deleteUnavailable'))
                            setPendingDelete(null)
                            await refresh()
                          } catch (failure) {
                            if (epoch === scopeEpoch.current) {
                              setUnconfirmedAction('delete')
                              setPendingDelete(null)
                              setError(String(failure))
                            }
                          } finally {
                            if (epoch === scopeEpoch.current) setBusy(false)
                          }
                        }}
                        className="rounded-lg bg-red-500 px-3 py-1 text-white"
                      >
                        {t('automations.delete')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(null)}
                        className="rounded-lg px-3 py-1 hover:bg-background"
                      >
                        {t('automations.cancel')}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : null}
          {target && workflowOwnerKey && view !== 'settings' && (
            <ScheduledWorkflowTasks
              key={`${target.key}:${workflowOwnerKey}:${view}`}
              suspended={!identity.ready}
              serverId={target.address.deviceId}
              workspacePath={target.address.workspacePath}
              view={view === 'inbox' ? 'inbox' : 'manage'}
              onBlockedChange={setWorkflowBlocked}
            />
          )}
        </div>
      </div>
    </section>
  )
}
