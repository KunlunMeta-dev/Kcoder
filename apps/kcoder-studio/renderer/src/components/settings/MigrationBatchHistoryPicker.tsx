import { MigrationHistoryGroups } from './MigrationHistoryGroup'
import { MigrationHistoryFamilyChoice } from './MigrationHistoryFamilyChoice'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { useMigrationBatchHistorySources } from '@/kcoder/useMigrationBatchHistorySources'

export function MigrationBatchHistoryPicker({
  model,
  disabled,
}: {
  model: ReturnType<typeof useMigrationBatchHistorySources>
  disabled: boolean
}) {
  const { t } = useTranslation('migration')
  const blocked = disabled || model.busy
  return (
    <section
      data-testid="migration-batch-history-picker"
      className="studio-card-spacing space-y-3 rounded-lg border border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t('batch.history_title')}</h4>
        <Button
          variant="outline"
          size="sm"
          disabled={blocked}
          onClick={() => void model.discover()}
        >
          {t('batch.history_find')}
        </Button>
      </div>
      <p className="text-xs leading-5 text-text-secondary">{t('batch.history_notice')}</p>
      {model.kind === 'codex' && <MigrationHistoryFamilyChoice disabled={blocked} active={model.familyMode} error={model.error} onDiscover={() => void model.discoverFamilies()}/>}
      {model.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${model.error}`, { defaultValue: t('error') })}
        </p>
      )}
      {model.catalog && (
        <>
          {(!model.catalog.discoveryComplete || model.catalog.problems.length > 0) && (
            <p role="status" className="text-sm text-text-secondary">
              {t('batch.history_partial')}
            </p>
          )}
          {model.catalog.items.length === 0 && (
            <p className="text-sm text-text-secondary">{t('empty')}</p>
          )}
          {model.familyMode && model.catalog.problems.filter(problem => problem.code.startsWith('history_discovery_family_')).map(problem => <p key={problem.code} role="status" className="text-sm text-text-secondary">{t(`historyFamilies.problems.${problem.code}`, { count: problem.count, defaultValue: t('historyFamilies.incomplete') })}</p>)}
          <MigrationHistoryGroups items={model.catalog.items} groups={model.familyGroups}>
            {item => (
              <label
                key={item.sourceHandle}
                className="flex min-h-11 items-center gap-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={model.checked(item.sourceHandle)}
                  disabled={
                    blocked ||
                    item.importIssues.length > 0 ||
                    (!model.checked(item.sourceHandle) && model.selections.length >= 64)
                  }
                  onChange={event => model.toggle(item.sourceHandle, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block truncate">{item.title || item.sourceSessionId}</span>
                  <span className="block text-xs text-text-secondary">
                    {item.bytes.toLocaleString()} B
                    {item.importIssues.length > 0 ? ` · ${t('batch.source_problems')}` : ''}
                  </span>
                </span>
              </label>
            )}
          </MigrationHistoryGroups>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
            <span>{t('batch.history_selected', { count: model.selections.length })}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={blocked || model.page === 0}
                onClick={() => void model.paginate(-1)}
              >
                {t('previous')}
              </Button>
              <span>{model.page + 1}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={blocked || !model.catalog.nextCursor}
                onClick={() => void model.paginate(1)}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
