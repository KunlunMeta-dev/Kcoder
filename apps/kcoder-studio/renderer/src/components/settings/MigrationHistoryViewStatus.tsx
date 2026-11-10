import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { useMigrationHistoryView } from '@/kcoder/useMigrationHistoryView'

export function MigrationHistoryViewStatus({ model }: { model: ReturnType<typeof useMigrationHistoryView> }) {
  const { t } = useTranslation('migration')
  if (model.state === 'idle') return null
  const legacy = model.state === 'confirmed' && model.lease?.legacyArchives
  return <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary" data-testid="migration-history-view-status">
    <p role="status">{t(model.error === 'migration_history_view_update_required' ? 'lifecycle.view_unsupported' : legacy ? 'lifecycle.view_legacy' : `lifecycle.view_${model.state}`)}</p>
    {['unconfirmed', 'expired', 'released'].includes(model.state) && model.error !== 'migration_history_view_update_required' && <Button size="sm" variant="ghost" onClick={model.open}>{t('lifecycle.protect_again')}</Button>}
  </div>
}
