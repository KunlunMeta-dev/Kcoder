import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { navigateTo } from '@/lib/navigation'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScheduleTimeInput } from '@/components/chat/ScheduleTimeInput'
import { parseLocalTimeInput, zonedCronFromPreset } from '@/components/chat/schedulePresets'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import type { AutomationTemplate } from '../../../../shared/generated/contracts'
import {
  KnowledgeOperationError,
  type AutomationTaskDraft,
  type KnowledgeIntegrationClient,
} from './client'
import { AdoptedPublicationInputs } from './AdoptedPublicationInputs'
import { verifyAdoptedPublicationInputs } from './adopted-publication-inputs'
import { fieldClass, OperationError } from './shared'
import { useDomainAction } from './useDomainAction'
import { formatAutomationTimestamp } from './time'

/** An explicit subscription over fixed authorized materials, never an external monitor. */
export function SimpleScheduledSubscription({
  client,
  template,
  refresh,
}: {
  client: KnowledgeIntegrationClient
  template: AutomationTemplate
  refresh: () => void
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const [id, setId] = useState(createRandomUuid)
  const [requirements, setRequirements] = useState('')
  const [sources, setSources] = useState<Array<{ kind: string; id: string; revision: string }>>([])
  const [mode, setMode] = useState<'daily' | 'once'>('daily')
  const [time, setTime] = useState('09:00')
  const [dateTime, setDateTime] = useState('')
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [preview, setPreview] = useState<{ identity: string; time: string }>()
  const [consent, setConsent] = useState(false)
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)
  const action = useDomainAction(refresh, client)
  const language = i18n?.resolvedLanguage || i18n?.language || 'en'
  const invalidate = () => {
    ++generation.current
    setPreview(undefined)
    setConsent(false)
    setSaved(false)
  }
  const draft = (): AutomationTaskDraft => {
    const parsed = parseLocalTimeInput(time)
    const schedule =
      mode === 'daily' && parsed
        ? zonedCronFromPreset('daily', parsed, timezone)
        : mode === 'once' && Number.isFinite(Date.parse(dateTime))
          ? { kind: 'at' as const, at: new Date(dateTime).toISOString() }
          : null
    if (!schedule || !requirements.trim() || !sources.length)
      throw new KnowledgeOperationError('AUTOMATION_INVALID_INPUTS')
    return {
      id,
      title: Array.from(requirements.trim().split(/\r?\n/)[0]).slice(0, 256).join(''),
      workflowId: template.workflowId,
      workflowVersion: template.workflowVersion,
      inputs: {
        requirements: requirements.trim(),
        sourceRefs: sources,
        outputLanguage: language.startsWith('zh') ? 'zh-CN' : 'en',
      },
      schedule,
      eventSource: null,
      maximumTokens: template.maximumTokens,
      maximumRuntimeSeconds: template.maximumRuntimeSeconds,
      delivery: { kind: 'studio' },
    }
  }
  return (
    <form
      className="workbench-card space-y-4 p-5"
      data-testid="simple-subscription"
      onChange={invalidate}
      onSubmit={event => {
        event.preventDefault()
        void action.run(async () => {
          const current = draft()
          if (!consent || preview?.identity !== JSON.stringify(current))
            throw new KnowledgeOperationError('AUTOMATION_EXPLICIT_CONSENT_REQUIRED')
          await verifyAdoptedPublicationInputs(client, sources)
          await client.saveSubscription(current)
          setId(createRandomUuid())
          setRequirements('')
          setSources([])
          setPreview(undefined)
          setConsent(false)
          setSaved(true)
        })
      }}
    >
      <h3 className="font-medium">{t('simpleSubscriptionTitle')}</h3>
      <p className="text-sm text-text-secondary">{t('simpleSubscriptionHint')}</p>
      <label className="block space-y-1 text-sm">
        <span>{t('subscriptionFocus')}</span>
        <textarea
          className={fieldClass}
          rows={3}
          maxLength={4096}
          required
          value={requirements}
          disabled={action.blocked}
          onChange={event => setRequirements(event.target.value)}
          data-testid="simple-subscription-focus"
        />
      </label>
      <p className="text-sm text-text-secondary">{t('materialSubscriptionNeedsKnowledge')}</p>
      <Button type="button" variant="outline" onClick={() => navigateTo('/knowledge')}>
        {t('importKnowledgeFiles')}
      </Button>
      <AdoptedPublicationInputs
        client={client}
        selected={sources}
        disabled={action.blocked}
        onChange={value => {
          setSources(value)
          invalidate()
        }}
        showRevision={false}
      />
      <label className="block space-y-1 text-sm">
        <span>{t('subscriptionWhen')}</span>
        <SettingsSelect
          className={fieldClass}
          value={mode}
          disabled={action.blocked}
          onChange={event => setMode(event.target.value as typeof mode)}
          data-testid="simple-subscription-mode"
        >
          <option value="daily">{t('daily')}</option>
          <option value="once">{t('once')}</option>
        </SettingsSelect>
      </label>
      <fieldset disabled={action.blocked} className="space-y-2">
        <legend className="sr-only">{t('subscriptionWhen')}</legend>
        <ScheduleTimeInput
          type={mode === 'daily' ? 'time' : 'datetime-local'}
          value={mode === 'daily' ? time : dateTime}
          onChange={value => {
            if (mode === 'daily') setTime(value)
            else setDateTime(value)
            invalidate()
          }}
          testId="simple-subscription-time"
        />
        <p className="text-xs text-text-muted">{t('subscriptionTimezone', { timezone })}</p>
      </fieldset>
      <Button
        type="button"
        variant="outline"
        disabled={action.blocked || !requirements.trim() || !sources.length}
        data-testid="simple-subscription-preview"
        onClick={() =>
          void action.run(async () => {
            const current = draft()
            const original = generation.current
            await verifyAdoptedPublicationInputs(client, sources)
            const result = await client.previewSubscription(current)
            if (original !== generation.current) return
            const next =
              typeof result.nextFireAtMs === 'number'
                ? formatAutomationTimestamp(result.nextFireAtMs, language, timezone)
                : undefined
            if (!next) throw new KnowledgeOperationError('AUTOMATION_INVALID_SCHEDULE')
            setPreview({ identity: JSON.stringify(current), time: next })
          })
        }
      >
        {t('preview')}
      </Button>
      {preview && <p role="status">{t('nextRun', { time: preview.time })}</p>}
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <Checkbox
          checked={consent}
          disabled={action.blocked || !preview}
          data-testid="simple-subscription-consent"
          onChange={event => {
            event.stopPropagation()
            setConsent(event.target.checked)
          }}
        />
        <span>{t('simpleSubscriptionConsent')}</span>
      </label>
      <Button
        type="submit"
        disabled={action.blocked || !preview || !consent}
        data-testid="simple-subscription-save"
      >
        {t('confirmSubscription')}
      </Button>
      {saved && <p role="status">{t('subscriptionSaved')}</p>}
      <OperationError error={action.error} onInspect={() => void action.inspect()} />
    </form>
  )
}
