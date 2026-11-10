import { useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type {
  AutomationPeriodBudget,
  AutomationPeriodBudgetPreview,
  AutomationSubscription,
} from '../../../../shared/generated/contracts'
import { fieldClass, OperationError } from './shared'
import { useDomainAction } from './useDomainAction'
import type { AutomationTaskDraft, KnowledgeIntegrationClient } from './client'

export function PeriodBudgetFields({
  value,
  onChange,
  defaultTokens,
  lockedWindow = false,
  disabled = false,
}: {
  value?: AutomationPeriodBudget | null
  onChange: (value: AutomationPeriodBudget | undefined) => void
  defaultTokens: number
  lockedWindow?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const update = (field: keyof AutomationPeriodBudget, next: number) => {
    if (value) onChange({ ...value, [field]: next })
  }
  return (
    <fieldset className="studio-card-spacing space-y-3 rounded-lg border border-border p-3" disabled={disabled}>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <Checkbox
          checked={!!value}
          disabled={disabled || lockedWindow}
          data-testid="period-budget-enabled"
          onChange={event =>
            onChange(
              event.target.checked
                ? { windowSeconds: 86400, maximumTokens: defaultTokens, maximumModelCalls: 128 }
                : undefined
            )
          }
        />
        <span>{t('periodBudgetLabel')}</span>
      </label>
      <p className="text-sm text-text-muted">{t('periodBudgetHint')}</p>
      {value && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>{t('periodSeconds')}</span>
            <input
              type="number"
              min={1}
              max={31536000}
              step={1}
              value={value.windowSeconds}
              disabled={disabled || lockedWindow}
              className={fieldClass}
              data-testid="period-budget-seconds"
              onChange={event => update('windowSeconds', Number(event.target.value))}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>{t('periodTokens')}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={value.maximumTokens}
              className={fieldClass}
              data-testid="period-budget-tokens"
              onChange={event => update('maximumTokens', Number(event.target.value))}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>{t('periodCalls')}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={value.maximumModelCalls}
              className={fieldClass}
              data-testid="period-budget-calls"
              onChange={event => update('maximumModelCalls', Number(event.target.value))}
            />
          </label>
        </div>
      )}
    </fieldset>
  )
}
export function PeriodBudgetObservation({ value }: { value: AutomationPeriodBudgetPreview }) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const date = (time: number) =>
    new Intl.DateTimeFormat(i18n?.resolvedLanguage || 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(time)
  return (
    <div
      role="status"
      className="space-y-1 text-sm text-text-secondary"
      data-testid="period-budget-observation"
    >
      <p>
        {t('periodWindow', {
          start: date(value.currentWindow.startsAtMs),
          end: date(value.currentWindow.endsAtMs),
        })}
      </p>
      <p>
        {t('periodAllowance', {
          tokens: value.effectiveMaximumTokens,
          calls: value.effectiveMaximumModelCalls,
        })}
      </p>
      <p>{t('periodCharged', { tokens: value.chargedTokens, calls: value.chargedModelCalls })}</p>
      {(value.activeTasks > 0 || value.activeCalls > 0) && (
        <p>{t('periodActive', { tasks: value.activeTasks, calls: value.activeCalls })}</p>
      )}
      {value.unknownCostReservations > 0 && (
        <p>{t('periodUnknownCost', { count: value.unknownCostReservations })}</p>
      )}
    </div>
  )
}
export function SubscriptionPeriodBudgetEditor({
  client,
  subscription,
  refresh,
}: {
  client: KnowledgeIntegrationClient
  subscription: AutomationSubscription
  refresh: () => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [value, setValue] = useState<AutomationPeriodBudget | undefined>(
    subscription.draft.periodBudget ?? undefined
  )
  const [preview, setPreview] = useState<AutomationPeriodBudgetPreview>()
  const [consent, setConsent] = useState(false)
  const generation = useRef(0)
  const action = useDomainAction(refresh, client)
  const invalidate = (next: AutomationPeriodBudget | undefined) => {
    ++generation.current
    setValue(next)
    setPreview(undefined)
    setConsent(false)
  }
  const draft = (): AutomationTaskDraft => {
    const { modelSelection, ...original } = subscription.draft
    return {
      ...original,
      ...(modelSelection ? { modelSelection } : {}),
      ...(value ? { periodBudget: value } : {}),
    }
  }
  return (
    <details className="w-full border-t border-border pt-3" data-testid="existing-period-budget">
      <summary className="cursor-pointer text-sm">{t('periodBudgetManage')}</summary>
      <div className="mt-3 space-y-3">
        <PeriodBudgetFields
          value={value}
          onChange={invalidate}
          defaultTokens={subscription.draft.maximumTokens}
          lockedWindow={!!subscription.draft.periodBudget}
          disabled={action.blocked}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!value || action.blocked}
          data-testid="existing-period-preview"
          onClick={() =>
            void action.run(async () => {
              const captured = generation.current
              const result = await client.previewSubscription(draft())
              if (captured === generation.current && result.periodBudget)
                setPreview(result.periodBudget)
            })
          }
        >
          {t('preview')}
        </Button>
        {preview && <PeriodBudgetObservation value={preview} />}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={consent}
            disabled={!preview || action.blocked}
            data-testid="existing-period-consent"
            onChange={event => setConsent(event.target.checked)}
          />
          <span>{t('periodBudgetConsent')}</span>
        </label>
        <OperationError error={action.error} onInspect={() => void action.inspect()} />
        <Button
          type="button"
          disabled={!preview || !consent || action.blocked}
          data-testid="existing-period-save"
          onClick={() =>
            void action.run(() => client.saveSubscription(draft(), subscription.revision))
          }
        >
          {t('saveSubscription')}
        </Button>
      </div>
    </details>
  )
}
