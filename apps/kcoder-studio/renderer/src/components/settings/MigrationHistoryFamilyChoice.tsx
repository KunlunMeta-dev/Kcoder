import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function MigrationHistoryFamilyChoice({ disabled, active = false, available = true, error, onDiscover }: {
  disabled: boolean; active?: boolean; available?: boolean; error?: string; onDiscover(): void
}) {
  const { t } = useTranslation('migration')
  return <div data-testid="migration-history-family-choice" className="studio-card-spacing space-y-2 rounded-lg border border-border">
    <p className="text-sm text-text-secondary">{t('historyFamilies.boundary')}</p>
    <details className="text-sm text-text-secondary"><summary>{t('historyFamilies.limitsTitle')}</summary><p>{t('historyFamilies.limits')}</p></details>
    <Button data-testid="migration-history-families-discover" size="sm" variant={active ? 'secondary' : 'outline'} disabled={disabled || !available} onClick={onDiscover}>{t('historyFamilies.discover')}</Button>
    {(!available || error?.endsWith('update_required')) && <p role="status" className="text-sm text-text-secondary">{t('historyFamilies.updateRequired')}</p>}
    {error === 'history_discovery_catalog_unavailable' && <p role="alert" className="text-sm text-text-secondary">{t('historyFamilies.catalogUnavailable')}</p>}
  </div>
}
