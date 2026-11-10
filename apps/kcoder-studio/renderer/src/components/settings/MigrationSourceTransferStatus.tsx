import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'

export function MigrationSourceTransferStatus({ model }: { model: ReturnType<typeof useMigrationSourceTransfer> }) {
  const { t } = useTranslation('migration')
  if (!model.requestId) return null
  const observation = model.result?.result
  const received = observation?.phase === 'ready' && observation.receipt !== null
  const running = model.result?.coordinatorState === 'running' || observation?.targetWorkerRunning === true
  const cancelled = observation?.phase === 'cancelled' && !running
  const status = received ? 'received' : cancelled ? 'cancelled'
    : running ? (observation?.phase === 'cancelling' || observation?.phase === 'cancelled' ? 'cancelling' : 'running')
      : observation?.phase === 'failed' ? 'failed'
        : observation?.phase === 'interrupted' ? 'interrupted'
          : observation?.phase === 'incomplete' ? 'incomplete' : 'unknown'
  const progress = model.result?.progress
  return <section className="studio-card-spacing space-y-3 rounded-lg border border-border" aria-busy={model.busy} data-testid="migration-transfer-status">
    <p role="status" className="text-sm font-medium">{t(`transferStatus.${status}`)}</p>
    {received && <p className="text-sm text-text-secondary">{t('transferStatus.notImported')}</p>}
    {progress?.phase === 'transferring' && <div className="space-y-1">
      <progress className="w-full" max={progress.totalBytes || 1} value={progress.acceptedBytes} aria-label={t('transferStatus.progress')} />
      <p className="text-xs text-text-secondary">{t('transferStatus.bytes', { accepted: progress.acceptedBytes, total: progress.totalBytes })}</p>
    </div>}
    {model.error && <p role="alert" className="text-sm text-destructive">{t('transferStatus.error')}</p>}
    <p className="text-xs text-text-secondary">{t('transferStatus.disconnect')}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={model.busy} onClick={() => void model.retry()}>{t(model.result ? 'refresh' : 'retry')}</Button>
      {!received && !cancelled && <Button size="sm" variant="ghost" disabled={model.busy} onClick={() => void model.cancel()}>{t('cancel')}</Button>}
    </div>
    <details className="text-xs text-text-secondary">
      <summary className="cursor-pointer">{t('details')}</summary>
      <p className="mt-2 break-all">{t('transferStatus.reference', { id: model.requestId })}</p>
      {(model.error || model.result?.errorCode) && <p>{model.error || model.result?.errorCode}</p>}
    </details>
  </section>
}
