import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { useMigrationTransferRecords } from '@/kcoder/useMigrationTransferRecords'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'

export function MigrationTransferRecords({ target, isCurrent, onBusy, onOpenBatch }: {
  target: GatewayServer; isCurrent: () => boolean; onBusy: (value: boolean) => void; onOpenBatch?: (jobId: string) => void
}) {
  const { t } = useTranslation('migration')
  const model = useMigrationTransferRecords(target, isCurrent)
  const [adoptionBusy, setAdoptionBusy] = useState(false)
  useEffect(() => { onBusy(model.busy || adoptionBusy); return () => onBusy(false) }, [model.busy, adoptionBusy, onBusy])
  const received = model.result?.result?.phase === 'ready' && !!model.result.result.receipt
  const phase = model.result?.result?.phase
  const status = received ? 'received' : phase && phase !== 'pending' && phase !== 'ready' ? phase
    : model.result?.result?.targetWorkerRunning ? 'running' : 'unknown'
  return <details className="studio-card-spacing rounded-lg border border-border" data-testid="migration-transfer-records">
    <summary className="cursor-pointer text-sm font-medium">{t('transferRecords.title')}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-text-secondary">{t('transferRecords.description')}</p>
      <Button size="sm" variant="ghost" disabled={model.busy} onClick={() => void model.refresh(model.page.pageIndex)}>{t('refresh')}</Button>
      {model.error && <p role="alert" className="text-sm text-destructive">{t('transferRecords.error')}</p>}
      {!!model.page.invalidRequestIds.length && <p role="alert" className="text-sm text-text-secondary">{t('transferRecords.invalid')}</p>}
      {!model.page.total && <p className="text-sm text-text-secondary">{t('transferRecords.empty')}</p>}
      <ul className="space-y-2">{model.page.records.map(record => <li key={record.request.requestId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{t('transferRecords.record', { id: record.request.requestId.slice(0, 8) })}</span>
        <Button size="sm" variant="outline" disabled={model.busy} onClick={() => void model.read(record.request.requestId)}>{t('transferRecords.read')}</Button>
      </li>)}</ul>
      {model.page.total > 10 && <div className="flex items-center justify-between gap-2 text-sm">
        <span>{t('page', { page: model.page.pageIndex + 1 })}</span><div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={model.busy || model.page.pageIndex === 0} onClick={() => void model.refresh(model.page.pageIndex - 1)}>{t('previous')}</Button>
          <Button size="sm" variant="ghost" disabled={model.busy || (model.page.pageIndex + 1) * 10 >= model.page.total} onClick={() => void model.refresh(model.page.pageIndex + 1)}>{t('next')}</Button>
        </div>
      </div>}
      {model.selectedId && <section className="space-y-2 border-t border-border pt-3" data-testid="migration-recovered-transfer">
        <p className="text-sm font-medium">{t('transferRecords.record', { id: model.selectedId.slice(0, 8) })}</p>
        <p role="status" className="text-sm">{t(`transferStatus.${status}`)}</p>
        {received && <p className="text-sm text-text-secondary">{t('transferStatus.notImported')}</p>}
        <Button size="sm" variant="ghost" disabled={model.busy} onClick={() => void model.read(model.selectedId!)}>{t('transferRecords.read')}</Button>
        {received && model.result?.result?.receipt && <MigrationSourceAdoptionPanel key={`${model.selectedId}:${model.result.result.receipt.manifestSha256}`}
          target={target} receipt={model.result.result.receipt} isCurrent={isCurrent} onBusy={setAdoptionBusy} onOpenBatch={onOpenBatch}/>}
      </section>}
    </div>
  </details>
}
