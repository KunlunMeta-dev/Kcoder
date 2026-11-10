import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationRetirement } from '@/kcoder/useMigrationRetirement'
import type { MigrationArchiveRetirementStateResult } from '../../../../shared/generated/contracts'

type Props = { deviceId: string; workspacePath?: string; jobId: string; isCurrent: () => boolean; releaseView: () => Promise<void>; onRetired: (value: boolean) => void }
export function MigrationArchiveRetirement(props: Props) {
  const { t } = useTranslation('migration')
  const model = useMigrationRetirement(props)
  const [confirm, setConfirm] = useState<{ scope: typeof model.scope; action: 'run' | 'resume'; value: MigrationArchiveRetirementStateResult; word: string } | null>(null)
  const result = model.result, value = result?.retirement
  const onRetired = props.onRetired, retired = value?.logicalRetired === true
  useEffect(() => onRetired(retired), [retired, onRetired])
  const completed = value?.phase === 'collected' || value?.logicalRetired && !value.ownsArchive
  const canRun = !!value && !model.running && result?.workerState === 'stopped' && !value.cancelRequested && ['prepared', 'retired'].includes(value.phase) && !completed
  const canResume = !!value && !model.running && (!completed || result?.workerState === 'unknown')
  const frozen = confirm?.scope === model.scope && value?.operationId === confirm.value.retirement.operationId && value.sequence === confirm.value.retirement.sequence ? confirm : null
  const keyword = frozen?.action === 'run' ? 'RETIRE' : 'RESUME'
  async function execute() {
    if (!frozen || frozen.word !== keyword) return
    if (await model.perform(frozen.action, frozen.value, props.releaseView) && model.valid()) setConfirm(null)
  }
  const unsupported = model.error === 'migration_history_retirement_update_required'
  if (unsupported) return null
  return <details className="space-y-3 border-t border-border pt-3" data-testid="migration-archive-retirement">
    <summary className="cursor-pointer text-sm text-text-secondary">{t('lifecycle.retirement_title')}</summary>
    <p className="text-sm leading-6 text-text-secondary">{t('lifecycle.retirement_boundary')}</p>
    {model.error && <p role="alert" className="text-sm text-destructive">{t(`lifecycle.errors.${model.error}`, { defaultValue: t('lifecycle.check_outcome') })}</p>}
    {model.preview?.reasonCode && <p className="text-sm text-text-secondary">{t(`errors.${model.preview.reasonCode}`, { defaultValue: t('lifecycle.legacy_retained') })}</p>}
    {!!(value?.retainedReferences ?? model.preview?.retainedReferences) && <p className="text-sm text-text-secondary">{t('lifecycle.references', { count: value?.retainedReferences ?? model.preview?.retainedReferences })}</p>}
    {value && <div className="space-y-1 text-sm text-text-secondary" role="status">
      <p data-testid="migration-retirement-phase">{t(`lifecycle.phase_${value.phase}`)}</p>
      <p>{t(`lifecycle.worker_${result?.workerState ?? 'unknown'}`)}{result?.workerScheduled ? ` · ${t('lifecycle.scheduled')}` : ''}</p>
      <p>{t(value.logicalRetired ? 'lifecycle.logically_retired' : 'lifecycle.still_active')}</p>
      {value.collectedBytes > 0 && <p>{t('lifecycle.collected_bytes', { count: value.collectedBytes })}</p>}
      {(value.failureCode || result?.workerError) && <p>{t(`errors.${value.failureCode ?? result?.workerError}`, { defaultValue: t('lifecycle.check_outcome') })}</p>}
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={model.busy} onClick={() => void model.refresh()}>{t('lifecycle.inspect')}</Button>
      {!value && <Button size="sm" variant="outline" data-testid="migration-retirement-prepare" disabled={model.busy || !model.preview?.canPrepare} onClick={() => void model.perform('prepare', null)}>{t('lifecycle.prepare')}</Button>}
      {canRun && <Button size="sm" variant="outline" data-testid="migration-retirement-run" disabled={model.busy} onClick={() => setConfirm({ scope: model.scope, action: 'run', value: result!, word: '' })}>{t('lifecycle.run')}</Button>}
      {canResume && <Button size="sm" variant="outline" data-testid="migration-retirement-resume" disabled={model.busy} onClick={() => setConfirm({ scope: model.scope, action: 'resume', value: result!, word: '' })}>{t('lifecycle.resume')}</Button>}
      {value && !completed && <Button size="sm" variant="ghost" data-testid="migration-retirement-cancel" disabled={model.busy || value.cancelRequested} onClick={() => void model.perform('cancel', result!)}>{t('lifecycle.cancel')}</Button>}
    </div>
    {frozen && <div className="space-y-2 border-l border-border pl-3" data-testid="migration-retirement-confirm">
      <p className="text-sm text-text-secondary">{t(frozen.action === 'run' ? 'lifecycle.confirm_retire' : 'lifecycle.confirm_resume', { word: keyword })}</p>
      <input data-testid="migration-retirement-confirm-input" aria-label={t('lifecycle.confirm_label')} className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm" value={frozen.word} onChange={event => setConfirm({ ...frozen, word: event.target.value })}/>
      <div className="flex gap-2"><Button size="sm" variant="outline" data-testid="migration-retirement-confirm-submit" disabled={model.busy || frozen.word !== keyword} onClick={() => void execute()}>{t('lifecycle.confirm')}</Button><Button size="sm" variant="ghost" disabled={model.busy} onClick={() => setConfirm(null)}>{t('cancel')}</Button></div>
    </div>}
    <details data-testid="migration-retirement-audit" onToggle={event => { if (event.currentTarget.open && !model.items.length) void model.page(null, 'first') }}>
      <summary className="cursor-pointer text-sm text-text-secondary">{t('lifecycle.audit_list')}</summary>
      <div className="divide-y divide-border">{model.items.map(item => <div data-testid="migration-retirement-audit-row" key={item.retirement.operationId} className="space-y-1 py-3 text-sm"><p className="break-all">{item.retirement.jobId}</p><p className="text-text-secondary">{t(`lifecycle.phase_${item.retirement.phase}`)}</p></div>)}</div>
      <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={model.busy || model.pages.length < 2} onClick={() => void model.page(model.pages.at(-2) ?? null, 'previous')}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={model.busy || !model.next} onClick={() => void model.page(model.next, 'next')}>{t('next')}</Button></div>
    </details>
  </details>
}
