import { useTranslation } from '@/hooks/useTranslation'
import { INITIAL_RESOURCE_FIELDS, initialResourceSelection, type InitialResourceDraft } from '../../../../shared/migrationInitialResourceLimits'

type Props = { draft: InitialResourceDraft; onChange(draft: InitialResourceDraft): void; disabled?: boolean; purpose?: 'attachment' }
export function MigrationInitialResourceForm({ draft, onChange, disabled, purpose }: Props) {
  const { t } = useTranslation('migrationResources')
  return <details className="studio-card-spacing rounded-lg border border-border text-sm" data-testid="migration-initial-resources">
    <summary className="cursor-pointer font-medium">{t('initial.title')}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-5 text-text-secondary">{t(purpose === 'attachment' ? 'attachment.formBoundary' : 'initial.boundary')}</p>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" data-testid="migration-initial-enabled" disabled={disabled} checked={draft.enabled} onChange={event => onChange({ ...draft, enabled: event.target.checked })}/>{t(purpose === 'attachment' ? 'attachment.custom' : 'initial.custom')}</label>
      {draft.enabled && INITIAL_RESOURCE_FIELDS.map(key => <label key={key} className="block">{t(`initial.${key}`)}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid={`migration-initial-${key}`} inputMode="numeric" maxLength={16} value={draft[key]} disabled={disabled} onChange={event => onChange({ ...draft, [key]: event.target.value })}/></label>)}
      {!initialResourceSelection(draft).valid && <p role="alert" className="text-destructive">{t('initial.invalid')}</p>}
    </div>
  </details>
}
