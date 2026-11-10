import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import type { MigrationBranchStateResult, MigrationHistoryJobsResult } from '../../../shared/generated/contracts'

const code=(cause:unknown)=>(cause instanceof Error?cause.message:'').match(/\b(?:migration|history|external_history)_[a-z_]+\b/)?.[0]??'error'
const equal=(left:string[],right:string[])=>JSON.stringify([...left].sort())===JSON.stringify([...right].sort())
const BUSY_READ_RETRIES=3

export function useMigrationBranch(deviceId:string,workspacePath:string|undefined,jobId:string,isCurrent:()=>boolean,enabled:boolean) {
  const api=useMemo(()=>createMigrationApi(deviceId,workspacePath),[deviceId,workspacePath])
  const current=useRef(isCurrent);useEffect(()=>{current.current=isCurrent},[isCurrent])
  const mounted=useRef(false),running=useRef(false),edited=useRef(false)
  const [state,setState]=useState<MigrationBranchStateResult|null>(null)
  const stateRef=useRef<MigrationBranchStateResult|null>(null)
  const [related,setRelated]=useState<string[]>([])
  const [jobs,setJobs]=useState<MigrationHistoryJobsResult|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[available,setAvailable]=useState(false)
  const valid=useCallback(()=>mounted.current&&current.current(),[])
  const accept=useCallback((value:MigrationBranchStateResult)=>{
    if(!valid())return
    const previous=stateRef.current
    if(previous?.progress?.viewId===value.progress?.viewId && (previous?.progress?.sequence??0)>(value.progress?.sequence??0))return
    if(!value.choice && previous?.progress?.viewId===value.progress?.viewId)value={...value,choice:previous?.choice??null}
    stateRef.current=value;setState(value);setAvailable(true)
    if(!edited.current&&value.choice)setRelated(value.choice.relatedJobIds)
  },[valid])
  useEffect(()=>{
    mounted.current=true
    const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>,busyReads=0
    const read=async()=>{
      if(!enabled||controller.signal.aborted||!valid())return
      try{
        const value=await api.branchRead({jobId},{signal:controller.signal})
        if(!controller.signal.aborted&&valid()){
          accept(value);setError(previous=>previous==='history_catalog_busy'?'':previous)
        }
      }catch(cause){
        if(!controller.signal.aborted&&valid()){
          const failure=code(cause)
          if(failure==='history_catalog_busy'&&busyReads++<BUSY_READ_RETRIES){
            timer=setTimeout(read,250)
          }else{
            setError(failure)
            setAvailable(!['migration_branch_update_required','migration_update_required','migration_scope_changed','error'].includes(failure))
          }
        }
      }
    }
    timer=setTimeout(read,0)
    return()=>{mounted.current=false;clearTimeout(timer);controller.abort()}
  },[api,jobId,enabled,accept,valid])
  const perform=async(action:()=>Promise<void>)=>{
    if(!valid()||running.current)return
    running.current=true;setBusy(true);setError('')
    try{await action()}catch(cause){if(valid())setError(code(cause))}finally{running.current=false;if(valid())setBusy(false)}
  }
  const prepare=()=>perform(async()=>{
    const chosen=[...related]
    let value:MigrationBranchStateResult
    try{value=await api.branchPrepare({jobId,relatedJobIds:chosen})}
    catch(cause){
      if(!valid()||code(cause)==='migration_scope_changed')throw cause
      try{const observed=await api.branchRead({jobId});if(observed.choice&&equal(observed.choice.relatedJobIds,chosen))accept(observed)}catch{/* Preserve the last acknowledged view. */}
      throw cause
    }
    if(!valid())return
    if(value.progress&&!value.choice)value={...value,choice:{viewId:value.progress.viewId,relatedJobIds:chosen}}
    edited.current=false;accept(value)
    if(value.progress&&!['ready','failed','cancelled'].includes(value.progress.stage)){
      try{accept(await api.branchRun({jobId,viewId:value.progress.viewId}))}catch(cause){
        if(valid()&&code(cause)!=='migration_scope_changed')try{accept(await api.branchRead({jobId,viewId:value.progress.viewId}))}catch{/* No automatic replay. */}
        throw cause
      }
    }
  })
  const refresh=()=>perform(async()=>accept(await api.branchRead({jobId,viewId:stateRef.current?.progress?.viewId})))
  const resume=()=>perform(async()=>{
    const previous=stateRef.current?.progress;if(!previous||previous.stage==='ready')return
    if(['failed','cancelled'].includes(previous.stage))accept(await api.branchResume({jobId,viewId:previous.viewId,expectedSequence:previous.sequence}))
    if(!valid())return
    accept(await api.branchRun({jobId,viewId:previous.viewId}))
  })
  const cancel=()=>perform(async()=>{
    const progress=stateRef.current?.progress;if(!progress)return
    await api.branchCancel({jobId,viewId:progress.viewId})
    if(valid())accept(await api.branchRead({jobId,viewId:progress.viewId}))
  })
  const listJobs=(cursor?:string)=>perform(async()=>{const result=await api.historyJobs({cursor});if(valid())setJobs(result)})
  const progress=state?.progress
  const activeViewId=progress?.viewId
  const polling=Boolean(progress&&state?.workerRunning&&!['ready','failed','cancelled'].includes(progress.stage))
  useEffect(()=>{
    if(!activeViewId||!polling)return
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
    let busyReads=0
    const poll=async()=>{
      if(controller.signal.aborted||!valid())return
      try{const value=await api.branchRead({jobId,viewId:activeViewId},{signal:controller.signal});if(!controller.signal.aborted&&valid()){
        busyReads=0;accept(value);setError(previous=>previous==='history_catalog_busy'?'':previous)
        if(value.workerRunning&&!['ready','failed','cancelled'].includes(value.progress?.stage??''))timer=setTimeout(poll,750)
      }}catch(cause){if(!controller.signal.aborted&&valid()){
        const failure=code(cause)
        // Keep the last authoritative checkpoint; never restart the branch writer.
        if(failure==='history_catalog_busy'&&busyReads++<BUSY_READ_RETRIES)timer=setTimeout(poll,250)
        else setError(failure)
      }}
    }
    timer=setTimeout(poll,300);return()=>{controller.abort();if(timer)clearTimeout(timer)}
  },[api,jobId,activeViewId,polling,accept,valid])
  const dirty=Boolean(state?.choice&&!equal(related,state.choice.relatedJobIds))
  return {state,related,jobs,busy,error,available:enabled&&available,dirty,prepare,refresh,resume,cancel,listJobs,
    setRelated:(ids:string[])=>{edited.current=true;setRelated(ids)},
    readyViewId:enabled&&available&&!dirty&&progress?.stage==='ready'?progress.viewId:undefined}
}
