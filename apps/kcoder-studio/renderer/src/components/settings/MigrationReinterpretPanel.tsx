import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { useMigrationHistory } from '@/kcoder/useMigrationHistory'

export function MigrationReinterpretPanel({ model }: { model: ReturnType<typeof useMigrationHistory> }) {
  const { t } = useTranslation('migration')
  const preview = model.reinterpretation
  return (
    <details className="space-y-2 text-sm" data-testid="migration-reinterpretation">
      <summary className="cursor-pointer text-text-secondary">{t('reinterpretation.title')}</summary>
      <p className="pt-2 text-text-secondary">{t('reinterpretation.boundary')}</p>
      {preview && (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt>{t('reinterpretation.previous')}</dt><dd className="break-words">{preview.sourceRevision}</dd>
            <dt>{t('reinterpretation.current')}</dt><dd className="break-words">{preview.parserRevision}</dd>
          </dl>
          {preview.canCreate ? <p>{t('reinterpretation.confirmation')}</p> : (
            <p role="status" className="text-text-secondary">{t(`errors.${preview.reasonCode}`, { defaultValue: t('reinterpretation.unavailable') })}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={model.busy} onClick={() => void model.prepareReinterpretation()}>
          {t(preview ? 'refresh' : 'reinterpretation.check')}
        </Button>
        {preview?.canCreate && <Button size="sm" disabled={model.busy} onClick={() => void model.reinterpret()}>
          {t('reinterpretation.confirm')}
        </Button>}
      </div>
    </details>
  )
}
