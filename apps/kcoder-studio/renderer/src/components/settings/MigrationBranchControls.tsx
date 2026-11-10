import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { useMigrationBranch } from '@/kcoder/useMigrationBranch'
type Model=ReturnType<typeof useMigrationBranch>

export function MigrationBranchControls({model,source,jobId}:{model:Model,source:string,jobId:string}) {
  const {t}=useTranslation('migration')
  const [cursors,setCursors]=useState<Array<string|undefined>>([undefined])
  const progress=model.state?.progress
  const running=Boolean(model.state?.workerRunning)
  const stopped=progress&&['cancelled','failed'].includes(progress.stage)
  return <section className="studio-card-spacing space-y-3 rounded-lg border border-border" data-testid="migration-branch-controls" aria-busy={model.busy}>
    <p className="text-sm text-text-secondary">{t('branch.boundary')}</p>
    {model.error&&<p role="alert" className="text-sm text-destructive">{t(`errors.${model.error}`,{defaultValue:t('branch.failed')})}</p>}
    {model.state?.workerError&&!progress?.failureCode&&<p role="alert" className="text-sm text-destructive">{t(`errors.${model.state.workerError}`,{defaultValue:t('branch.failed')})}</p>}
    {source==='codex'&&<details>
      <summary className="cursor-pointer text-sm text-text-secondary" onClick={()=>{if(!model.jobs)void model.listJobs()}}>{t('branch.related')}</summary>
      <p className="my-2 text-sm text-text-secondary">{t('branch.related_boundary')}</p>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {model.jobs?.jobs.filter(item=>item.job.jobId!==jobId&&item.job.source==='codex'&&item.job.normalization?.normalizationComplete).map(item=><label key={item.job.jobId} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
          <input type="checkbox" checked={model.related.includes(item.job.jobId)} disabled={model.busy||running||(!model.related.includes(item.job.jobId)&&model.related.length>=255)}
            onChange={event=>model.setRelated(event.target.checked?[...model.related,item.job.jobId]:model.related.filter(id=>id!==item.job.jobId))}/>
          <span className="min-w-0 truncate" title={item.job.jobId}>{item.job.jobId}</span>
        </label>)}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-text-muted">{t('branch.related_count',{count:model.related.length})}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={model.busy||running||cursors.length<2} onClick={()=>{const previous=cursors.slice(0,-1);setCursors(previous);void model.listJobs(previous.at(-1))}}>{t('previous')}</Button>
          <Button size="sm" variant="ghost" disabled={model.busy||running||!model.jobs?.nextCursor} onClick={()=>{if(model.jobs?.nextCursor){setCursors([...cursors,model.jobs.nextCursor]);void model.listJobs(model.jobs.nextCursor)}}}>{t('next')}</Button>
        </div>
      </div>
    </details>}
    {progress&&<div className="space-y-1 text-sm text-text-secondary" role="status">
      <p>{t(!running&&['planned','reconstructing','saving'].includes(progress.stage)?'branch.inactive':`branch.stages.${progress.stage}`)}</p>
      {running&&<p>{progress.stage==='saving'?t('branch.saving',{count:progress.writtenItems,total:progress.totalItems??0}):t('branch.checks',{count:progress.checks})}</p>}
      {progress.stage==='ready'&&<p>{t(progress.structuralComplete?'branch.structural_complete':'branch.incomplete')}</p>}
      {progress.issues.length>0&&<p>{t('branch.review',{count:progress.issues.length})}</p>}
      {progress.failureCode&&<p role="alert" className="text-destructive">{t(`errors.${progress.failureCode}`,{defaultValue:t('branch.failed')})}</p>}
    </div>}
    {model.dirty&&<p className="text-sm text-text-secondary">{t('branch.draft')}</p>}
    <div className="flex flex-wrap gap-2">
      {(!progress||model.dirty)&&<Button size="sm" disabled={model.busy||running||!model.available} onClick={()=>void model.prepare()}>{t('branch.prepare')}</Button>}
      {progress&&progress.stage!=='ready'&&!running&&!model.dirty&&<Button size="sm" disabled={model.busy} onClick={()=>void model.resume()}>{t(stopped?'branch.resume':'branch.run')}</Button>}
      {running&&<Button size="sm" variant="outline" disabled={model.busy||progress?.cancelRequested} onClick={()=>void model.cancel()}>{t(progress?.cancelRequested?'branch.cancelling':'branch.cancel')}</Button>}
      <Button size="sm" variant="ghost" disabled={model.busy} onClick={()=>void model.refresh()}>{t('refresh')}</Button>
    </div>
  </section>
}
