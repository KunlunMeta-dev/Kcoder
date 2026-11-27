import { MigrationHistoryResourceBudgetPanel } from './MigrationHistoryResourceBudgetPanel'
import { MigrationInitialResourceForm } from './MigrationInitialResourceForm'
import { createInitialResourceDraft, initialResourceSelection } from '../../../../shared/migrationInitialResourceLimits'
import { MigrationHistoryGroups } from './MigrationHistoryGroup'
import { canReconcileLegacyHistory } from '@/kcoder/migrationHistoryExecution'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationHistory } from '@/kcoder/useMigrationHistory'
import { MigrationTranscriptViewer } from './MigrationTranscriptViewer'
import { MigrationReinterpretPanel } from './MigrationReinterpretPanel'
import { IconSelect } from './settings-ui'
import { Archive } from 'lucide-react'
import type { MigrationHistoryJobResult } from '../../../../shared/generated/contracts'

function statusKey(value: MigrationHistoryJobResult) {
  if (value.workerState === 'unknown') return 'history.worker_unknown'
  return !value.workerRunning && value.workerState !== 'running' && ['capturing', 'archiving', 'normalizing'].includes(value.job.stage)
    ? value.workerState === 'stopped' ? 'history.idle' : 'history.observing'
    : `history.stages.${value.job.stage}`
}

export function MigrationHistoryWorkspace(props: { deviceId: string, workspacePath?: string, isCurrent: () => boolean, onBusy: (value: boolean) => void }) {
  const { t } = useTranslation('migration')
  const model = useMigrationHistory(props.deviceId, props.workspacePath, props.isCurrent)
  const { onBusy } = props
  const [mode, setMode] = useState<'sources' | 'jobs'>('sources')
  const [sourceCursors, setSourceCursors] = useState<Array<string | undefined>>([undefined])
  const [jobCursors, setJobCursors] = useState<Array<string | undefined>>([undefined])
  const initialized = useRef(false)
  const { listJobs } = model
  useEffect(() => { if (!initialized.current) { initialized.current = true; void listJobs() } }, [listJobs])
  useEffect(() => { onBusy(model.busy); return () => onBusy(false) }, [model.busy, onBusy])
  const [initialResources, setInitialResources] = useState(createInitialResourceDraft)
  const initialSelection = initialResourceSelection(initialResources)
  const active = model.active
  const workerRunning = Boolean(active?.workerRunning || active?.workerState === 'running')
  const needsRecovery = active?.job.failureCode === 'history_projection_recovery_required'
  const done = active?.job.stage === 'normalized' && !needsRecovery
  const stopped = active && ['cancelled', 'failed'].includes(active.job.stage)
  const controls = (kind: 'sources' | 'jobs', next?: string | null) => {
    const cursors = kind === 'sources' ? sourceCursors : jobCursors
    const change = kind === 'sources' ? setSourceCursors : setJobCursors
    const load = kind === 'sources' ? model.sourcePage : model.listJobs
    return <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" disabled={model.busy || cursors.length === 1} onClick={() => { const previous = cursors.slice(0, -1); void load(previous.at(-1)).then(ok => { if (ok && props.isCurrent()) change(previous) }) }}>{t('previous')}</Button>
      <Button size="sm" variant="ghost" disabled={model.busy || !next} onClick={() => { if (next) void load(next).then(ok => { if (ok && props.isCurrent()) change([...cursors, next]) }) }}>{t('next')}</Button>
    </div>
  }
  return <section className="mt-4 space-y-4" data-testid="migration-history" aria-busy={model.busy}>
    <p className="text-sm leading-6 text-text-secondary">{t('history.boundary')}</p>
    {model.error && <p role="alert" className="text-sm text-destructive">{t(`errors.${model.error}`, { defaultValue: t('error') })}</p>}
    {model.error === 'migration_update_required' ? null : active ? <>
      <Button size="sm" variant="ghost" onClick={model.back} disabled={model.busy}>{t('history.back')}</Button>
      <div className="studio-card-spacing space-y-3 rounded-lg border border-border" data-testid="migration-history-job">
        <p className="text-base font-medium" role="status">{t(statusKey(active))}</p>
        <p className="text-sm text-text-secondary">{t('history.job_id', { id: active.job.jobId })}</p>
        {workerRunning && active.progress && <p className="text-sm text-text-secondary">{t(`history.phases.${active.progress.phase}`)} · {t(`history.progress_${active.progress.unit}`, { processed: active.progress.processed.toLocaleString(), total: active.progress.total.toLocaleString() })}</p>}
        {active.job.normalization && <p className="text-sm text-text-secondary">{t('history.parsed', { count: active.job.normalization.normalizedRecords, total: active.job.normalization.sourceRecords })}</p>}
        {Boolean(active.job.normalization?.recordsWithDiagnostics) && <p className="text-sm text-text-secondary">{t('history.issues', { count: active.job.normalization?.recordsWithDiagnostics })}</p>}
        {(active.job.failureCode || active.workerError) && <p role="alert" className="text-sm text-destructive">{t(`errors.${active.job.failureCode ?? active.workerError}`, { defaultValue: t('history.failed') })}</p>}
        {done ? <p className="text-sm text-text-secondary">{t('history.normalized_boundary')}</p> : <div className="flex flex-wrap gap-2">
          {!workerRunning && <Button size="sm" onClick={() => void model.resume()} disabled={model.busy || (active.workerState === 'unknown' && !canReconcileLegacyHistory(active)) || active.workerState === 'running'}>{t(canReconcileLegacyHistory(active) ? 'history.reconcile_resume' : needsRecovery ? 'history.recover' : stopped ? 'history.resume' : 'history.run')}</Button>}
          {!stopped && <Button size="sm" variant="outline" onClick={() => void model.cancel()} disabled={model.busy || active.job.cancelRequested}>{t(active.job.cancelRequested ? 'history.cancelling' : 'history.cancel')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => void model.open(active.job.jobId)} disabled={model.busy}>{t('refresh')}</Button>
        </div>}
        {done && canReconcileLegacyHistory(active) && <Button size="sm" onClick={() => void model.resume()} disabled={model.busy}>{t('history.verify_owner')}</Button>}
        {done && active.workerState === 'unknown' && <Button size="sm" variant="ghost" onClick={() => void model.open(active.job.jobId)} disabled={model.busy}>{t('refresh')}</Button>}
        {active.job.archived && !workerRunning && <MigrationReinterpretPanel model={model} />}
      </div>
      <MigrationHistoryResourceBudgetPanel deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={active.job.jobId} cancelled={active.job.cancelRequested || active.job.stage === 'cancelled'} isCurrent={props.isCurrent}/>
      {active.job.archived && active.job.normalization && !needsRecovery && <MigrationTranscriptViewer key={active.job.jobId} deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={active.job.jobId} archiveId={active.job.archiveId} isCurrent={props.isCurrent} source={active.job.source} allowBranches={active.job.stage==='normalized'} />}
    </> : <>
      <div className="flex gap-2">
        <Button size="sm" variant={mode === 'sources' ? 'secondary' : 'ghost'} disabled={model.busy} onClick={() => setMode('sources')}>{t('history.sources')}</Button>
        <Button size="sm" variant={mode === 'jobs' ? 'secondary' : 'ghost'} disabled={model.busy} onClick={() => { setMode('jobs'); setJobCursors([undefined]); void model.listJobs() }}>{t('history.records')}</Button>
      </div>
      {mode === 'sources' ? <>
        <label htmlFor="migration-history-source" className="block text-sm">{t('history.source_label')}</label>
        <IconSelect id="migration-history-source" icon={<Archive className="h-4 w-4" />} value={model.kind} disabled={model.busy} onChange={event => { model.setKind(event.target.value as 'codex' | 'claude-code'); setSourceCursors([undefined]) }}>
          <option value="claude-code">Claude Code</option><option value="codex">Codex</option>
        </IconSelect>
        <Button size="sm" disabled={model.busy} onClick={() => { setSourceCursors([undefined]); void model.discover() }}>{t('history.discover')}</Button>
        <MigrationInitialResourceForm draft={initialResources} onChange={setInitialResources} disabled={model.busy}/>
        {model.sources && <>
          <p className="text-sm text-text-secondary">{t('history.source_count', { count: model.sources.totalItems })}</p>
          {!model.sources.discoveryComplete && <p className="text-sm text-text-secondary">{t('history.partial')}</p>}
          <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            <MigrationHistoryGroups items={model.sources.items}>{item => <div key={item.sourceHandle} className="flex min-h-11 items-center justify-between gap-3 px-3 py-3">
              <div className="min-w-0"><p className="truncate text-sm" title={item.title ?? item.sourceSessionId}>{item.title || item.sourceSessionId}</p>
                {item.project && <p className="truncate text-xs text-text-muted" title={item.project}>{item.project}</p>}
                {item.parentSessionId && <p className="text-xs text-text-muted">{t('history.child')}</p>}
                {item.importIssues.length > 0 && <p className="text-xs text-destructive">{t('history.source_blocked')}</p>}
              </div>
              <Button data-testid={`migration-history-create-${item.sourceHandle}`} size="sm" variant="outline" disabled={model.busy || !initialSelection.valid || item.importIssues.length > 0} onClick={() => void model.importSource(item.sourceHandle, initialSelection.limits)}>{t('history.import')}</Button>
            </div>}</MigrationHistoryGroups>
          </div>
          {controls('sources', model.sources.nextCursor)}
        </>}
      </> : <>
        {model.jobs?.jobs.length === 0 && <p className="text-sm text-text-secondary">{t('history.empty')}</p>}
        <div className="divide-y divide-border">
          {model.jobs?.jobs.map(item => <Button data-testid={`migration-history-record-${item.job.jobId}`} key={item.job.jobId} variant="ghost" className="h-auto min-h-11 w-full justify-between gap-3 py-3" disabled={model.busy} onClick={() => void model.open(item.job.jobId)}>
            <span className="min-w-0 truncate">{item.job.source} · {item.job.jobId}</span><span>{t(statusKey(item))}</span>
          </Button>)}
        </div>
        {controls('jobs', model.jobs?.nextCursor)}
      </>}
    </>}
  </section>
}
