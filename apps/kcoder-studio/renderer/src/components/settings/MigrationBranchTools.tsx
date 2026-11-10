import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {useTranslation} from '@/hooks/useTranslation'
import {useMigrationBranchTools} from '@/kcoder/useMigrationBranchTools'

export function MigrationBranchTools(props:{deviceId:string,workspacePath?:string,jobId:string,viewId:string,isCurrent:()=>boolean}) {
  const {t}=useTranslation('migration')
  const model=useMigrationBranchTools(props.deviceId,props.workspacePath,props.jobId,props.viewId,props.isCurrent)
  const [cursors,setCursors]=useState<Array<string|undefined>>([undefined])
  const state=model.result?.state,ready=state?.run?.stage==='ready',running=Boolean(state?.workerRunning)
  return <section data-testid="migration-branch-tools" className="studio-card-spacing space-y-2 rounded-lg border border-border" aria-busy={model.busy}>
    <h4 className="text-sm font-medium">{t('branch_tools.title')}</h4>
    <p className="text-sm text-text-secondary">{t('branch_tools.boundary')}</p>
    {model.error&&<p role="alert" className="text-sm text-destructive">{t(`errors.${model.error}`,{defaultValue:t('branch_tools.failed')})}</p>}
    {(state?.run?.failureCode||model.result?.workerError)&&<p role="alert" className="text-sm text-destructive">{t(`errors.${state?.run?.failureCode??model.result?.workerError}`,{defaultValue:t('branch_tools.failed')})}</p>}
    {state?.run&&<p role="status" className="text-sm text-text-secondary">{t(`branch_tools.stages.${state.run.stage}`)}</p>}
    {state?.progress&&<p className="text-sm text-text-secondary">{t('branch_tools.counts',{records:state.progress.processedRecords,count:state.progress.recordedLinks,unresolved:state.progress.unresolvedLinks})}</p>}
    <div className="flex flex-wrap gap-2">
      {!ready&&!running&&model.result&&<Button size="sm" disabled={model.busy} onClick={()=>void model.run()}>{t(state?.run&&['cancelled','failed'].includes(state.run.stage)?'branch_tools.resume':'branch_tools.run')}</Button>}
      {running&&<Button size="sm" variant="outline" disabled={model.busy||state?.cancelRequested} onClick={()=>void model.cancel()}>{t(state?.cancelRequested?'branch.cancelling':'branch_tools.cancel')}</Button>}
      {ready&&<Button size="sm" variant="outline" disabled={model.busy} onClick={()=>{setCursors([undefined]);void model.loadPage()}}>{t('branch_tools.inspect')}</Button>}
      <Button size="sm" variant="ghost" disabled={model.busy} onClick={()=>void model.refresh()}>{t('refresh')}</Button>
    </div>
    {model.page&&<div className="space-y-2">
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {model.page.links.map(link=><details key={link.id} className="studio-card-spacing rounded-lg border border-border text-sm">
          <summary className="cursor-pointer break-words">{link.namespace?`${link.namespace}.`:''}{link.name??link.callId} · {t(`branch_tools.statuses.${link.status}`)} · {t(`transcript.outcomes.${link.outcome}`)}</summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-xs text-text-muted">
            <dt>{t('branch_tools.call_id')}</dt><dd>{link.callId}</dd>
            {link.executionOutcome&&<><dt>{t('branch_tools.execution_outcome')}</dt><dd>{t(`transcript.outcomes.${link.executionOutcome}`)}</dd></>}
            {(['call','result','executionEvent'] as const).map(kind=>link[kind]&&<div key={kind} className="contents"><dt>{t(`branch_tools.locations.${kind}`)}</dt><dd>{t('branch_tools.location',{position:link[kind]!.sequence,record:link[kind]!.record,source:link[kind]!.sourceIndex??0})}{link[kind]!.block!=null?` · ${t('branch_tools.block')} ${link[kind]!.block}`:''}{link[kind]!.replacementIndex!=null?` · ${t('branch.replacement')} ${link[kind]!.replacementIndex}`:''}{link[kind]!.sourceBlock!=null?` · ${t('branch_tools.original_block')} ${link[kind]!.sourceBlock}`:''}</dd></div>)}
          </dl>
        </details>)}
        {model.page.links.length===0&&<p className="text-sm text-text-secondary">{t('branch_tools.empty')}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={model.busy||cursors.length<2} onClick={()=>{const previous=cursors.slice(0,-1);void model.loadPage(previous.at(-1)).then(ok=>{if(ok&&props.isCurrent())setCursors(previous)})}}>{t('previous')}</Button>
        <Button size="sm" variant="ghost" disabled={model.busy||!model.page?.nextCursor} onClick={()=>{
          if(model.page?.nextCursor){
            const next=model.page.nextCursor
            void model.loadPage(next).then(ok=>{if(ok&&props.isCurrent())setCursors([...cursors,next])})
          }
        }}>{t('next')}</Button>
      </div>
    </div>}
  </section>
}
