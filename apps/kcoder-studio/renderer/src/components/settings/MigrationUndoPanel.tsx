import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { useMigrationUndo } from '@/kcoder/useMigrationUndo'

export function MigrationUndoPanel({ model }: { model: ReturnType<typeof useMigrationUndo> }) {
  const { t } = useTranslation('migration')
  const state = model.result,
    job = state?.job,
    preview = model.preview
  const running = Boolean(state?.workerRunning),
    done = job?.stage === 'undone'
  return (
    <section
      className="space-y-2 border-t border-border pt-3"
      data-testid="migration-undo"
      aria-busy={model.busy}
    >
      <h5 className="text-sm font-medium">{t('undo.title')}</h5>
      <p className="text-xs text-text-secondary">{t('undo.boundary')}</p>
      {!model.ready && (
        <p role="status" className="text-xs text-text-muted">
          {t('undo.loading')}
        </p>
      )}
      {model.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${model.error}`, { defaultValue: t('undo.check_outcome') })}
        </p>
      )}
      {job && (
        <>
          <p role="status" className="text-sm">
            {t(`undo.stages.${job.stage}`)}
          </p>
          {running && job.checkedBytes > 0 && (
            <p className="text-xs text-text-muted">
              {t('undo.checked', { bytes: job.checkedBytes.toLocaleString() })}
            </p>
          )}
          {(job.failureCode || state?.workerError) && (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${job.failureCode ?? state?.workerError}`, {
                defaultValue: t('undo.check_outcome'),
              })}
            </p>
          )}
        </>
      )}
      {!job && preview && (
        <div className="space-y-2">
          {preview.canUndo ? (
            <p className="text-sm">{t('undo.confirmation')}</p>
          ) : (
            <p role="status" className="text-sm text-text-secondary">
              {t(`errors.${preview.reasonCode}`, { defaultValue: t('undo.unavailable') })}
            </p>
          )}
          {preview.canUndo && (
            <Button
              size="sm"
              variant="destructive"
              disabled={model.busy}
              onClick={() => void model.start()}
            >
              {t('undo.confirm')}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!job && (!preview || !preview.canUndo) && model.ready && !model.unsupported && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy}
            onClick={() => void model.prepare()}
          >
            {t('undo.prepare')}
          </Button>
        )}
        {!job && model.error === 'historical_undo_job_recovery_required' && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy}
            onClick={() => void model.start()}
          >
            {t('undo.recover_record')}
          </Button>
        )}
        {job && !done && !running && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy}
            onClick={() => void model.start()}
          >
            {t(job.stage === 'planned' ? 'undo.start' : 'undo.reconcile')}
          </Button>
        )}
        {running && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy || job?.cancelRequested}
            onClick={() => void model.cancel()}
          >
            {t(job?.cancelRequested ? 'undo.cancelling' : 'undo.cancel')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={model.busy}
          onClick={() => void model.refresh()}
        >
          {t('refresh')}
        </Button>
      </div>
    </section>
  )
}
