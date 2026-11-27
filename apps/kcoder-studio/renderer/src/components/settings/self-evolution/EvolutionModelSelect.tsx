import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import type { EvolutionModelRef } from '@/kcoder/evolution/evolutionContract'
import {
  modelRefValue,
  parseModelRefValue,
  type ConfiguredModelOption,
} from '@/kcoder/evolution/evolutionSettingsModel'

/**
 * One dropdown over already-configured models. The first option is a sentinel
 * (follow the session model, or "same as above" for a stage). A stored
 * reference that is no longer configured stays selected and is marked
 * unavailable; it is never replaced by another catalog entry.
 */
export function EvolutionModelSelect({
  id,
  testId,
  label,
  value,
  sentinelValue,
  sentinelLabel,
  options,
  disabled,
  describedBy,
  onChange,
}: {
  id: string
  testId: string
  label: string
  value: EvolutionModelRef | null
  sentinelValue: string
  sentinelLabel: string
  options: ConfiguredModelOption[]
  disabled?: boolean
  describedBy?: string
  onChange: (next: EvolutionModelRef | null) => void
}) {
  const { t } = useTranslation('evolution')
  const selectedValue = value ? modelRefValue(value) : sentinelValue
  const missing = value !== null && !options.some(option => option.value === selectedValue)
  return (
    <SettingsSelect
      id={id}
      data-testid={testId}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={missing || undefined}
      value={selectedValue}
      disabled={disabled}
      onChange={event => {
        const next = event.target.value
        onChange(next === sentinelValue ? null : parseModelRefValue(next))
      }}
      // The native select is an invisible overlay; width belongs to the visible surface.
      surfaceClassName="min-w-64 max-sm:min-w-0"
    >
      <option value={sentinelValue}>{sentinelLabel}</option>
      {options.map(option => (
        <option key={option.value} value={option.value} disabled={!option.available}>
          {option.available ? option.label : t('model.optionUnavailable', { label: option.label })}
        </option>
      ))}
      {missing && value && (
        <option value={selectedValue} disabled>
          {t('model.optionUnavailable', { label: `${value.model} · ${value.provider}` })}
        </option>
      )}
    </SettingsSelect>
  )
}
