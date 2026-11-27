import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'

export function MemoryScopePicker({ value, onChange, workspacePath, disabled = false }: {
  value: string; onChange: (value: string) => void; workspacePath?: string; disabled?: boolean
}) {
  const { t } = useTranslation('migrationMemory')
  return <div className="space-y-2">
    <label className="block text-sm"><span className="mb-1 block text-text-secondary">{t('mapping')}</span>
      <SettingsSelect aria-label={t('mapping')} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        <option value="">{t('mappingPlaceholder')}</option><option value="global">{t('mappingGlobal')}</option><option value="current_workspace" disabled={!workspacePath}>{t('mappingWorkspace')}</option>
      </SettingsSelect>
    </label><p className="text-xs leading-5 text-text-secondary">{t('mappingBoundary')}</p><p className="text-xs leading-5 text-text-secondary">{t('defaultDisabled')}</p>
  </div>
}
