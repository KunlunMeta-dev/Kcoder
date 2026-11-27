import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { SettingsRow } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { clearEvolutionData, evolutionFailureKind } from '@/kcoder/evolution/evolutionApi'
import type { EvolutionDataClearParams, EvolutionSettings } from '@/kcoder/evolution/evolutionContract'
import { EVIDENCE_TTL_CHOICES } from '@/kcoder/evolution/evolutionSettingsModel'

type ClearOutcome = 'cleared' | 'failed' | 'unconfirmed' | null
type ClearScope = EvolutionDataClearParams['scope']
const CLEAR_SCOPES: ClearScope[] = ['all', 'project', 'user']

/** Evidence retention and the doubly confirmed local data reset. Sharing stays hidden (phase 5). */
export function EvolutionDataSection({
  serverId,
  workspace,
  settings,
  disabled,
  isCurrent,
  onSave,
  onCleared,
}: {
  serverId: string
  /** Project partition for `scope: 'project'`; without it the project choice is unavailable. */
  workspace?: string
  settings: EvolutionSettings
  disabled: boolean
  isCurrent: () => boolean
  onSave: (next: EvolutionSettings) => void
  onCleared: () => void
}) {
  const { t } = useTranslation('evolution')
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [clearing, setClearing] = useState(false)
  const [outcome, setOutcome] = useState<ClearOutcome>(null)
  const [scope, setScope] = useState<ClearScope>('all')
  const ttlChoices: number[] = [...EVIDENCE_TTL_CHOICES]
  if (!ttlChoices.includes(settings.evidence_ttl_days)) ttlChoices.push(settings.evidence_ttl_days)

  const clear = async () => {
    setClearing(true)
    setOutcome(null)
    try {
      const result = await clearEvolutionData(serverId, scope, scope === 'project' ? workspace : undefined)
      if (!isCurrent()) return
      setOutcome(result.cleared ? 'cleared' : 'failed')
      setStep(0)
      onCleared()
    } catch (error) {
      if (!isCurrent()) return
      setOutcome(evolutionFailureKind(error, true) === 'unconfirmed' ? 'unconfirmed' : 'failed')
      setStep(0)
    } finally {
      if (isCurrent()) setClearing(false)
    }
  }

  return (
    <>
      <SettingsRow
        label={t('data.ttl')}
        description={t('data.ttlDescription')}
        control={
          <SettingsSelect
            data-testid="evolution-evidence-ttl"
            aria-label={t('data.ttl')}
            value={String(settings.evidence_ttl_days)}
            disabled={disabled}
            onChange={event => onSave({ ...settings, evidence_ttl_days: Number(event.target.value) })}
          >
            {ttlChoices.map(days => (
              <option key={days} value={days}>
                {t('data.days', { count: days })}
              </option>
            ))}
          </SettingsSelect>
        }
      />
      <SettingsRow
        label={t('data.clear')}
        description={
          <>
            {t('data.clearDescription')}
            {outcome && (
              <span
                role={outcome === 'cleared' ? 'status' : 'alert'}
                data-testid="evolution-clear-outcome"
                className={outcome === 'cleared' ? 'block text-text-secondary' : 'block text-destructive'}
              >
                {t(`data.outcome.${outcome}`)}
              </span>
            )}
          </>
        }
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="evolution-clear-data"
            disabled={clearing}
            onClick={() => {
              setScope('all')
              setStep(1)
            }}
          >
            {t('data.clearAction')}
          </Button>
        }
      />
      {step > 0 && (
        <ModalDialog
          title={t(step === 1 ? 'data.confirmTitle' : 'data.confirmAgainTitle')}
          testId="evolution-clear-dialog"
          pending={clearing}
          onClose={() => {
            setStep(0)
            setScope('all')
          }}
          closeLabel={t('actions.dismiss')}
        >
          {step === 1 ? (
            <>
            <p className="mb-3 text-sm text-text-secondary">{t('data.confirmBody')}</p>
            <fieldset className="flex flex-col gap-2" disabled={clearing}>
              <legend className="mb-2 text-sm font-medium text-text-primary">{t('data.scopeLabel')}</legend>
              {CLEAR_SCOPES.map(value => (
                <label key={value} className="flex min-h-11 items-start gap-2 text-sm md:min-h-8">
                  <input
                    type="radio"
                    name="evolution-clear-scope"
                    value={value}
                    data-testid={`evolution-clear-scope-${value}`}
                    checked={scope === value}
                    disabled={value === 'project' && !workspace}
                    onChange={() => setScope(value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-text-primary">{t(`data.scopes.${value}`)}</span>
                    <span className="block text-xs text-text-secondary">
                      {t(value === 'project' && !workspace ? 'data.scopeProjectUnavailable' : `data.scopeDescriptions.${value}`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              {t('data.confirmAgainBody', { scope: t(`data.scopes.${scope}`) })}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={clearing} onClick={() => setStep(0)}>
              {t('actions.cancel')}
            </Button>
            {step === 1 ? (
              <Button
                type="button"
                variant="destructive"
                data-testid="evolution-clear-continue"
                onClick={() => setStep(2)}
              >
                {t('data.continue')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="destructive"
                data-testid="evolution-clear-confirm"
                pending={clearing}
                onClick={() => void clear()}
              >
                {t('data.confirmAction')}
              </Button>
            )}
          </div>
        </ModalDialog>
      )}
    </>
  )
}
