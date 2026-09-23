import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Checkbox } from '@/components/ui/checkbox'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, RefreshCw, Server, Trash2 } from 'lucide-react'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useAutomationIdentity } from './useAutomationIdentity'
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
}: {
  runtimeWork: RuntimeWorkListResponse | null
  onOpenTask?: (address: RuntimeTaskAddress) => Promise<unknown>
}) {
  const { t, i18n } = useTranslation('common')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const targets = useMemo(
    () => automationTargets(runtimeWork, t('runtimeTarget.currentComputer')),
    [runtimeWork, t]
  )
  const [selected, setSelected] = useState('')
  const target = selected ? targets.find(item => item.key === selected) : targets[0]
  const [view, setView] = useState<'settings' | 'history'>('settings')
  const [listing, setListing] = useState<{ key: string; jobs: ScheduledJob[] } | null>(null)
  const jobs = target && listing?.key === target.key ? listing.jobs : []
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [presetMenu, setPresetMenu] = useState<HTMLDivElement | null>(null)
  const generation = useRef(0)
  const scopeEpoch = useRef(0)
  const invalidateScope = useCallback(() => {
    scopeEpoch.current += 1
    generation.current += 1
    setListing(null)
    setPrompt('')
    setTitle('')
    setConfirmedTarget(null)
    setPendingDelete(null)
    setBusy(false)
    setError('')
  }, [setListing, setPrompt, setTitle, setConfirmedTarget, setPendingDelete, setBusy, setError])
  const identity = useAutomationIdentity(target?.address, invalidateScope)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    if (!target || !identity.ready || !identity.server) return
    try {
      const result = await requestAutomation<{ jobs: ScheduledJob[] }>(target.address, 'cron/list')
      if (current === generation.current) {
        setListing({ key: target.key, jobs: result.jobs })
        setError('')
      }
    } catch (failure) {
      if (current === generation.current) {
        setListing({ key: target.key, jobs: [] })
        setError(String(failure instanceof Error ? failure.message : failure))
      }
    }
  }, [target, identity.ready, identity.server, setListing, setError])
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
    if (!target || !identity.ready || busy || !confirmed || !scheduleForForm) return
    const epoch = scopeEpoch.current
    setBusy(true)
    setError('')
    try {
      const trimmedTitle = title.trim()
      const body = trimmedTitle ? `# ${trimmedTitle}\n\n${prompt}` : prompt
      await requestAutomation(target.address, 'cron/create', {
        prompt: body,
        schedule: scheduleForForm,
        confirmed: true,
      })
      if (epoch !== scopeEpoch.current) return
      setPrompt('')
      setTitle('')
      setConfirmedTarget(null)
      await refresh()
      if (epoch !== scopeEpoch.current) return
      setView('history')
    } catch (failure) {
      if (epoch === scopeEpoch.current)
        setError(String(failure instanceof Error ? failure.message : failure))
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
        <input
          data-testid="automation-at"
          type="datetime-local"
          step="1"
          required
          value={when}
          onChange={event => setWhen(event.target.value)}
          className={`${field} max-w-56`}
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
      <input
        data-testid="automation-time-of-day"
        type="time"
        required
        value={timeOfDay}
        onChange={event => setTimeOfDay(event.target.value)}
        className={`${field} max-w-32`}
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
      className="min-w-0 flex-1 overflow-y-auto bg-background px-6 py-10 text-text-primary"
    >
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">{t('automations.title')}</h1>
        </header>
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="flex gap-1 rounded-lg bg-surface/60 p-1" role="tablist">
            {(['settings', 'history'] as const).map(key => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`${pill} rounded-md`}
                aria-pressed={view === key}
                data-testid={`automation-tab-${key}`}
              >
                {t(`automations.tab_${key}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t('automations.refresh')}
            className="rounded-lg p-2 text-text-secondary hover:bg-surface"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        {(error || identity.failure) && (
          <p
            role="alert"
            className="mb-6 rounded-lg border border-red-500/30 p-3 text-sm text-red-500"
          >
            {t('automations.error')}: {error || identity.failure}
          </p>
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
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
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
                <span className="text-sm text-text-secondary">{t('automations.prompt')}</span>
                <div className="overflow-hidden rounded-xl border border-border focus-within:border-primary/50">
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
                  <div className="flex flex-wrap items-center gap-3 border-t border-border bg-surface/40 px-3 py-2">
                    <label className="block min-w-48 max-w-full flex-1 text-sm text-text-secondary">
                      <span className="sr-only">{t('automations.target')}</span>
                      <SettingsSelect
                        icon={<Server />}
                        aria-label={t('automations.target')}
                        data-testid="automation-target"
                        value={target?.key ?? ''}
                        disabled={busy}
                        onChange={event => {
                          setSelected(event.target.value)
                          setListing(null)
                          setPendingDelete(null)
                        }}
                      >
                        {!targets.length && <option value="">{t('automations.noTargets')}</option>}
                        {targets.map(item => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                      </SettingsSelect>
                    </label>
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
                disabled={!target || !identity.ready || !confirmed || busy || !scheduleReady}
                className="rounded-xl bg-text-primary px-5 py-2.5 text-sm font-medium text-background transition-opacity disabled:opacity-40"
              >
                {busy ? t('automations.saving') : t('automations.create')}
              </button>
            </fieldset>
          </form>
        ) : (
          <div className="space-y-4" data-testid="automation-jobs">
            <p className="text-sm text-text-secondary">{t('automations.runResults')}</p>
            {!jobs.length && (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
                {t('automations.empty')}
              </p>
            )}
            {jobs.map(job => (
              <article
                key={job.id}
                data-testid="automation-job"
                className="space-y-2 rounded-xl border border-border p-5"
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
                          if (epoch === scopeEpoch.current) setError(String(failure))
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
        )}
      </div>
    </section>
  )
}
