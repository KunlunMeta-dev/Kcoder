import { MigrationInstructionMapping } from './MigrationInstructionMapping'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationSourceAdoption } from '@/kcoder/useMigrationSourceAdoption'
import { adoptionProjectMappingRequired } from '@/kcoder/migrationSourceAdoptionController'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceAdoptionState, MigrationSourceReceipt } from '../../../../shared/generated/contracts'

export type MigrationAdoptionOpenBatch = (jobId: string) => void
export function MigrationSourceAdoptionPanel({ target, receipt, isCurrent, onOpenBatch, onBusy }: {
  target: GatewayServer; receipt: MigrationSourceReceipt; isCurrent: () => boolean; onOpenBatch?: MigrationAdoptionOpenBatch; onBusy?: (value: boolean) => void
}) {
  const { t } = useTranslation('migration')
  const model = useMigrationSourceAdoption(target, receipt, isCurrent)
  const [expanded, setExpanded] = useState(false), [recordPage, setRecordPage] = useState(0)
  const [confirmation, setConfirmation] = useState<{ mode: 'cancel' | 'resume'; value: MigrationSourceAdoptionState; word: string } | null>(null)
  const state = model.result?.state
  const running = state?.workerState === 'running'
  const confirmed = confirmation && state?.adoptionId === confirmation.value.adoptionId && (confirmation.mode === 'cancel' || state.control?.sequence === confirmation.value.control?.sequence)
    && state.control?.cancelWatermark === confirmation.value.control?.cancelWatermark ? confirmation : null
  useEffect(() => { onBusy?.(model.busy || running); return () => onBusy?.(false) }, [model.busy, running, onBusy])
  const selected = new Map(model.selected.map(row => [row.item.entryId, row]))
  const keyword = confirmed?.mode === 'cancel' ? 'CANCEL' : 'RESUME'
  return <section className="studio-card-spacing space-y-3 rounded-lg border border-border" data-testid="migration-source-adoption">
    <Button variant="ghost" data-testid="migration-adoption-expand" onClick={() => { setExpanded(value => !value); if (!expanded) void model.load() }}>{t('adoption.title')}</Button>
    {expanded && <>
      <p className="text-sm text-text-secondary">{t('adoption.boundary')}</p>
      {model.error && <p role="alert" className="text-sm text-destructive">{t('adoption.error')} <span className="break-all">{model.error}</span></p>}
      {model.page && <>
        <ul className="divide-y divide-border">{model.page.items.map(item => {
          const chosen = selected.get(item.entryId), mapping = adoptionProjectMappingRequired(item)
          return <li key={item.entryId} data-testid="migration-adoption-received-row" className="space-y-2 py-3 text-sm">
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" aria-label={item.entryId} checked={!!chosen}
              disabled={model.busy || !chosen && model.selected.length >= 64} onChange={event => model.select(item.entryId, event.target.checked)}/>
              <span>{item.source === 'codex' ? 'Codex' : 'Claude Code'} · {t(`adoption.class_${item.class}`)} · {item.entryId}</span>
            </label>
            {item.project && <p className="break-all text-text-secondary">{item.project.displayName} · {item.project.roots}</p>}
            <p className="text-text-secondary">{t('adoption.files', { count: item.files, bytes: item.bytes })}</p>
            {mapping ? <>
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" data-testid={`migration-adoption-map-${item.entryId}`} checked={chosen?.mapped ?? false}
                disabled={model.busy || !chosen || !target.workspacePath} onChange={event => model.map(item.entryId, event.target.checked)}/>{t('adoption.map_workspace')}</label>
              {!target.workspacePath && <p className="text-sm text-destructive">{t('adoption.workspace_required')}</p>}
            </> : item.projectScoped && <p className="text-text-secondary">{t('adoption.history_provenance')}</p>}
            {item.class === 'instructions' && chosen?.mapped && <MigrationInstructionMapping target={target} receipt={receipt} entryId={item.entryId} disabled={model.busy} isCurrent={isCurrent} value={chosen.instructionMapping} onChange={value => model.mapInstructions(item.entryId, value)}/>}

          </li>
        })}</ul>
        <div className="flex items-center justify-between gap-2 text-sm"><span>{t('page', { page: model.pageIndex + 1 })}</span><div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={model.busy || model.pageIndex === 0} onClick={() => void model.load(model.pageIndex - 1)}>{t('previous')}</Button>
          <Button size="sm" variant="ghost" disabled={model.busy || model.page.nextPage === null} onClick={() => { const next = model.page?.nextPage; if (next !== null && next !== undefined) void model.load(next) }}>{t('next')}</Button>
        </div></div>
        <p className="text-sm text-text-secondary">{t('adoption.selected', { count: model.selected.length })}</p>
        <Button data-testid="migration-adoption-prepare" disabled={model.busy || !model.canPrepare} onClick={() => void model.prepare()}>{t('adoption.prepare')}</Button>
      </>}
      {model.input && <div className="space-y-2 border-t border-border pt-3" data-testid="migration-adoption-state">
        <p role="status" data-testid="migration-adoption-phase">{t(state ? `adoption.phase_${state.phase}` : 'adoption.unobserved')}</p>
        {state && <>
          <p className="text-sm text-text-secondary">{t(`adoption.worker_${state.workerState}`)}</p>
          <p className="text-sm text-text-secondary">{t('adoption.progress', { done: state.completedSources, total: state.totalSources, blocked: state.blockedItems })}</p>
          {!state.control && <p className="text-sm text-text-secondary">{t('adoption.control_unknown')}</p>}
          {state.errorCode && <p className="break-all text-sm text-destructive">{state.errorCode}</p>}
        </>}
        {model.pollingPaused && <p className="text-sm text-text-secondary">{t('adoption.poll_paused')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" data-testid="migration-adoption-read" disabled={model.busy} onClick={() => void model.read(model.input!)}>{t('adoption.read')}</Button>
          {state?.control && state.phase !== 'preview_ready' && <>
            <Button variant="outline" data-testid="migration-adoption-cancel" disabled={model.busy || state.cancelRequested === true} onClick={() => setConfirmation({ mode: 'cancel', value: state, word: '' })}>{t('adoption.cancel')}</Button>
            <Button variant="outline" data-testid="migration-adoption-resume" disabled={model.busy || state.workerState !== 'stopped'} onClick={() => setConfirmation({ mode: 'resume', value: state, word: '' })}>{t('adoption.resume')}</Button>
          </>}
        </div>
        {confirmed && <div className="space-y-2">
          <p className="text-sm text-text-secondary">{t('adoption.confirm', { keyword })}</p>
          <input className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm" aria-label={t('adoption.confirm_label')} data-testid="migration-adoption-confirm-input"
            value={confirmed.word} onChange={event => setConfirmation({ ...confirmed, word: event.target.value })}/>
          <Button data-testid="migration-adoption-confirm-submit" disabled={model.busy || confirmed.word !== keyword} onClick={() => {
            void model.operate(confirmed.mode, confirmed.value).then(() => setConfirmation(null))
          }}>{t('adoption.confirm_button')}</Button>
          <Button variant="ghost" disabled={model.busy} onClick={() => setConfirmation(null)}>{t('cancel')}</Button>
        </div>}
        {state?.jobs.map(job => <div key={job.jobId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{job.source === 'codex' ? 'Codex' : 'Claude Code'} · {t(job.targetScope === 'current_workspace' ? 'adoption.scope_project' : 'adoption.scope_user')}</span>
          <Button data-testid={`migration-adoption-open-${job.jobId}`} disabled={model.busy || !job.previewReady || !onOpenBatch || job.targetScope === 'current_workspace' && !target.workspacePath}
            onClick={() => { if (isCurrent() && job.previewReady) onOpenBatch?.(job.jobId) }}>{t('adoption.open_preview')}</Button>
        </div>)}
      </div>}
      {!!model.records.length && <details data-testid="migration-adoption-records">
        <summary className="cursor-pointer text-sm text-text-secondary">{t('adoption.records')}</summary>
        <ul>{model.records.slice(recordPage * 10, recordPage * 10 + 10).map(record => <li className="flex min-h-11 items-center justify-between gap-2 text-sm" key={record.locator.adoptionId}>
          <span>{record.locator.adoptionId.slice(0, 8)}</span><Button variant="ghost" disabled={model.busy} onClick={() => void model.read(record)}>{t('adoption.read')}</Button>
        </li>)}</ul>
        {model.records.length > 10 && <div className="flex gap-2"><Button variant="ghost" disabled={model.busy || recordPage === 0} onClick={() => setRecordPage(value => value - 1)}>{t('previous')}</Button>
          <Button variant="ghost" disabled={model.busy || (recordPage + 1) * 10 >= model.records.length} onClick={() => setRecordPage(value => value + 1)}>{t('next')}</Button></div>}
      </details>}
    </>}
  </section>
}
