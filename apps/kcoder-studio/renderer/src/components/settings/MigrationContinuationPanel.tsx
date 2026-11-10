import { SettingsSelect } from '@/components/settings/SettingsSelect'
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {captureAccountContextRevision} from '@/kcoder/accountContextEvents'
import {Button} from '@/components/ui/button'
import {useTranslation} from '@/hooks/useTranslation'
import {useMigrationContinuation} from '@/kcoder/useMigrationContinuation'
import {useMigrationUndo} from '@/kcoder/useMigrationUndo'
import {MigrationUndoPanel} from './MigrationUndoPanel'
import {useWorkbench} from '@/features/workbench/useWorkbench'
import {useMigrationLocalAttachmentSelections} from '@/kcoder/migrationLocalAttachmentSelections'
export function MigrationContinuationPanel(props:{deviceId:string,workspacePath?:string,sourceJobId:string,viewId:string,isCurrent:()=>boolean}){
  const selected=useMigrationLocalAttachmentSelections()
  const {t}=useTranslation('migration'),model=useMigrationContinuation(props.deviceId,props.workspacePath,props.sourceJobId,props.viewId,props.isCurrent,selected?.bindings)
  const {openRuntimeTask,refreshWorkLists}=useWorkbench()
  const [mode,setMode]=useState<'kcoder'|'kworker'>('kcoder'),[page,setPage]=useState(0)
  const state=model.result,job=state?.job,running=Boolean(state?.workerRunning)
  const undo=useMigrationUndo(props.deviceId,props.workspacePath,job?.stage==='imported'?job.jobId:null,job?.sequence??0,props.isCurrent)
  const undone=undo.result?.job.stage==='undone',undoRunning=Boolean(undo.result?.workerRunning)
  const navigationScope=useMemo(()=>({}),[props.deviceId,props.workspacePath,props.sourceJobId,props.viewId,job?.jobId,job?.threadId])
  const navigationOwner=useRef(navigationScope),navigationMounted=useRef(false),canNavigate=useRef<()=>boolean>(()=>false)
  const [openState,setOpenState]=useState<{scope:typeof navigationScope|null,opening:boolean,error:boolean}>({scope:null,opening:false,error:false})
  const opening=openState.scope===navigationScope&&openState.opening,openError=openState.scope===navigationScope&&openState.error
  useLayoutEffect(()=>{
    navigationOwner.current=navigationScope;navigationMounted.current=true
    return()=>{if(navigationOwner.current===navigationScope)navigationMounted.current=false}
  },[navigationScope])
  useLayoutEffect(()=>{canNavigate.current=()=>props.isCurrent()&&!undone&&undo.ready&&!undo.busy&&!undoRunning},[props.isCurrent,undone,undo.ready,undo.busy,undoRunning])
  const refreshedUndo=useRef<string|null>(null)
  useEffect(()=>{
    const id=undo.result?.job.stage==='undone'?undo.result.job.jobId:null
    if(id&&refreshedUndo.current!==id){refreshedUndo.current=id;void refreshWorkLists().catch(()=>{/* The confirmed undo remains visible; the normal list refresh can be retried. */})}
  },[undo.result,refreshWorkLists])
  const issues=[...(job?.compilation?.issues??[]),...(job?.projection?.issues??[])]
  const open=async()=>{
    if(!props.isCurrent()||!job?.threadId||opening||undone||!undo.ready||undo.busy||undoRunning)return
    const account=captureAccountContextRevision()
    const owns=()=>navigationMounted.current&&navigationOwner.current===navigationScope&&account(props.deviceId)
    const allowed=()=>owns()&&canNavigate.current()
    const address={deviceId:props.deviceId,taskId:`kcoder:${props.deviceId}:${job.threadId}`,workspacePath:props.workspacePath}
    setOpenState({scope:navigationScope,opening:true,error:false})
    try{await refreshWorkLists();if(allowed())await openRuntimeTask(address)}
    catch{if(allowed())setOpenState({scope:navigationScope,opening:false,error:true})}
    finally{if(owns())setOpenState(before=>before.scope===navigationScope?{...before,opening:false}:before)}
  }

  return <section data-testid="migration-continuation" className="studio-card-spacing space-y-3 rounded-lg border border-border" aria-busy={model.busy}>
    <h4 className="text-sm font-medium">{t('continuation.title')}</h4>
    <p className="text-sm text-text-secondary">{t('continuation.boundary')}</p>
    {Boolean(selected?.bindings.length)&&<p className="text-sm text-text-secondary">{t('local_attachment.continuation_count',{count:selected?.bindings.length})}</p>}
    {model.error&&<p role="alert" className="text-sm text-destructive">{t(`errors.${model.error}`,{defaultValue:t('continuation.failed')})}</p>}
    {openError&&<p role="alert" className="text-sm text-destructive">{t('continuation.open_failed')}</p>}
    {!job?<>
      <label className="flex min-h-11 items-center gap-3 text-sm">{t('continuation.mode')}
        <SettingsSelect className="min-h-9 rounded-md border border-border bg-surface px-2 text-sm" value={mode} disabled={model.busy} onChange={event=>setMode(event.target.value as 'kcoder'|'kworker')}><option value="kcoder">KCoder</option><option value="kworker">KWorker</option></SettingsSelect>
      </label>
      <p className="text-xs text-text-muted">{t('continuation.default_model')}</p>
      <Button size="sm" disabled={model.busy||model.error==='migration_continuation_update_required'} onClick={()=>void model.create(mode)}>{t('continuation.create')}</Button>
    </>:<>
      <p role="status" className="text-sm">{t(undone?'undo.stages.undone':`continuation.stages.${job.stage}`)}</p>
      {running&&job.processedBytes>0&&<p className="text-xs text-text-muted">{t('continuation.processed',{bytes:job.processedBytes.toLocaleString()})}</p>}
      {(job.failureCode||state?.workerError)&&<p role="alert" className="text-sm text-destructive">{t(`errors.${job.failureCode??state?.workerError}`,{defaultValue:t('continuation.failed')})}</p>}
      {job.projection?.estimatedInputTokens!=null&&<p className="text-xs text-text-muted">{t('continuation.estimate',{tokens:job.projection.estimatedInputTokens.toLocaleString()})}</p>}
      {issues.length>0&&<details><summary className="cursor-pointer text-sm">{t('continuation.issues',{count:issues.length})}</summary>
        <ul className="mt-2 space-y-2 text-sm text-text-secondary">{issues.slice(page*10,page*10+10).map((issue,index)=><li key={`${page}:${index}`} className="break-words">{t(`errors.${issue.code}`,{defaultValue:issue.code})}{issue.position!=null?` · ${issue.position+1}`:''}</li>)}</ul>
        <div className="mt-2 flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={page===0} onClick={()=>setPage(value=>value-1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={(page+1)*10>=issues.length} onClick={()=>setPage(value=>value+1)}>{t('next')}</Button></div>
      </details>}
      <div className="flex flex-wrap gap-2">
        {job.stage==='imported'&&job.threadId?<Button size="sm" disabled={opening||undone||!undo.ready||undo.busy||undoRunning} onClick={()=>void open()}>{t(opening?'continuation.opening':'continuation.open')}</Button>:!running&&<Button size="sm" disabled={model.busy} onClick={()=>void model.resume()}>{t('continuation.resume')}</Button>}
        {running&&<Button size="sm" variant="outline" disabled={model.busy||job.cancelRequested} onClick={()=>void model.cancel()}>{t(job.cancelRequested?'history.cancelling':'history.cancel')}</Button>}
        <Button size="sm" variant="ghost" disabled={model.busy} onClick={()=>void model.refresh()}>{t('refresh')}</Button>
      </div>
      {job.stage==='imported'&&<MigrationUndoPanel model={undo}/>}
    </>}
  </section>
}
