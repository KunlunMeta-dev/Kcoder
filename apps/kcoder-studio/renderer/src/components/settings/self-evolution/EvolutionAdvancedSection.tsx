import { useState } from 'react'
import { ChevronRight, Hash, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import type { EvolutionSettings } from '@/kcoder/evolution/evolutionContract'
import {
  SAME_AS_MAIN_VALUE,
  advancedDraft,
  applyAdvanced,
  restoreAdvancedDefaults,
  validateAdvanced,
  type AdvancedDraft,
  type AdvancedField,
  type ConfiguredModelOption,
} from '@/kcoder/evolution/evolutionSettingsModel'
import { EvolutionModelSelect } from './EvolutionModelSelect'

const FIELDS: AdvancedField[] = [
  'candidate_traffic',
  'promote_threshold',
  'rollback_threshold',
  'win_rate',
  'max_diversity_drop',
  'monthly_max_tokens',
]
const STAGES = ['classifier', 'distill', 'eval'] as const

/** Collapsed advanced parameters; invalid values are reported inline and block saving. */
export function EvolutionAdvancedSection({
  settings,
  modelOptions,
  disabled,
  onSave,
}: {
  settings: EvolutionSettings
  modelOptions: ConfiguredModelOption[]
  disabled: boolean
  onSave: (next: EvolutionSettings) => Promise<boolean>
}) {
  const { t } = useTranslation('evolution')
  const [draft, setDraft] = useState<AdvancedDraft | null>(null)
  const values = draft ?? advancedDraft(settings)
  const errors = validateAdvanced(values)
  const invalid = Object.keys(errors).length > 0
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(advancedDraft(settings))
  return (
    <details data-testid="evolution-advanced" className="group/advanced studio-card-inset">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-8">
        <ChevronRight
          className="h-4 w-4 text-text-secondary transition-transform group-open/advanced:rotate-90"
          aria-hidden="true"
        />
        {t('advanced.title')}
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        <p className="text-sm text-text-secondary">{t('advanced.description')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map(field => {
            const error = errors[field]
            const errorId = `evolution-advanced-${field}-error`
            return (
              <label key={field} className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-text-primary">{t(`advanced.fields.${field}`)}</span>
                <InputWithIcon
                  icon={field === 'monthly_max_tokens' ? <Hash className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
                  textSize="sm"
                  data-testid={`evolution-advanced-${field}`}
                  inputMode={field === 'monthly_max_tokens' ? 'numeric' : 'decimal'}
                  value={values[field]}
                  placeholder={field === 'monthly_max_tokens' ? t('advanced.unlimited') : undefined}
                  disabled={disabled}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={event => setDraft({ ...values, [field]: event.target.value })}
                />
                {/* The error replaces the hint in the same cell; the hidden hint keeps the height. */}
                <span className="grid text-xs">
                  <span
                    aria-hidden={error ? true : undefined}
                    className={`col-start-1 row-start-1 text-text-secondary ${error ? 'invisible' : ''}`}
                  >
                    {t(`advanced.hints.${field}`)}
                  </span>
                  {error && (
                    <span id={errorId} role="alert" className="col-start-1 row-start-1 text-destructive">
                      {t(`advanced.errors.${error}`)}
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-primary">{t('advanced.stageModels')}</p>
          {STAGES.map(stage => (
            <label key={stage} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-text-secondary">{t(`advanced.stages.${stage}`)}</span>
              <EvolutionModelSelect
                id={`evolution-stage-${stage}`}
                testId={`evolution-stage-model-${stage}`}
                label={t(`advanced.stages.${stage}`)}
                value={settings.stage_models[stage] ?? null}
                sentinelValue={SAME_AS_MAIN_VALUE}
                sentinelLabel={t('advanced.sameAsMain')}
                options={modelOptions}
                disabled={disabled}
                onChange={ref =>
                  void onSave({ ...settings, stage_models: { ...settings.stage_models, [stage]: ref } })
                }
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="evolution-advanced-save"
            disabled={disabled || invalid || !dirty}
            onClick={() =>
              void onSave(applyAdvanced(settings, values)).then(saved => {
                if (saved) setDraft(null)
              })
            }
          >
            {t('actions.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="evolution-advanced-restore"
            disabled={disabled}
            onClick={() =>
              void onSave(restoreAdvancedDefaults(settings)).then(saved => {
                if (saved) setDraft(null)
              })
            }
          >
            {t('advanced.restoreDefaults')}
          </Button>
        </div>
      </div>
    </details>
  )
}
