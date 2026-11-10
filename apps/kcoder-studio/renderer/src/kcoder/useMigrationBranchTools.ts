import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {createMigrationApi} from './gatewayMigration'
import type {MigrationBranchToolsStateResult,MigrationBranchToolsPageResult} from '../../../shared/generated/contracts'
const code=(cause:unknown)=>(cause instanceof Error?cause.message:'').match(/\b(?:migration|history|external_history)_[a-z_]+\b/)?.[0]??'error'

export function useMigrationBranchTools(deviceId:string,workspacePath:string|undefined,jobId:string,viewId:string,isCurrent:()=>boolean) {
  const api=useMemo(()=>createMigrationApi(deviceId,workspacePath),[deviceId,workspacePath])
  const current=useRef(isCurrent);useEffect(()=>{current.current=isCurrent},[isCurrent])
  const mounted=useRef(false),active=useRef(false)
  const [result,setResult]=useState<MigrationBranchToolsStateResult|null>(null)
  const resultRef=useRef<MigrationBranchToolsStateResult|null>(null)
  const [page,setPage]=useState<MigrationBranchToolsPageResult|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const valid=useCallback(()=>mounted.current&&current.current(),[])
  const accept=useCallback((value:MigrationBranchToolsStateResult)=>{
    if(!valid())return
    if((resultRef.current?.state.run?.sequence??0)>(value.state.run?.sequence??0))return
    resultRef.current=value;setResult(value)
  },[valid])
  useEffect(()=>{
    mounted.current=true;const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>,busyReads=0
    const read=async()=>{
      if(controller.signal.aborted||!valid())return
      try{
        const value=await api.branchToolsRead({jobId,viewId},{signal:controller.signal})
        if(!controller.signal.aborted&&valid()){
          accept(value);setError(previous=>previous==='history_catalog_busy'?'':previous)
        }
      }catch(cause){if(!controller.signal.aborted&&valid()){
        const failure=code(cause)
        if(failure==='history_catalog_busy'&&busyReads++<3)timer=setTimeout(read,250)
        else setError(failure)
      }}
    }
    timer=setTimeout(read,0)
    return()=>{mounted.current=false;controller.abort();clearTimeout(timer)}
  },[api,jobId,viewId,accept,valid])
  const perform=async(action:()=>Promise<void>)=>{
    if(!valid()||active.current)return false
    active.current=true;setBusy(true);setError('')
    try{await action();return true}catch(cause){
      if(valid())setError(code(cause))
      if(valid()&&code(cause)!=='migration_scope_changed')try{accept(await api.branchToolsRead({jobId,viewId}))}catch{/* Observation does not authorize replay. */}
      return false
    }finally{active.current=false;if(valid())setBusy(false)}
  }
  const run=()=>perform(async()=>{
    const before=resultRef.current?.state.run
    if(before&&['cancelled','failed'].includes(before.stage))accept(await api.branchToolsResume({jobId,viewId,expectedSequence:before.sequence}))
    else accept(await api.branchToolsRun({jobId,viewId}))
  })
  const cancel=()=>perform(async()=>{await api.branchToolsCancel({jobId,viewId});if(valid())accept(await api.branchToolsRead({jobId,viewId}))})
  const refresh=()=>perform(async()=>accept(await api.branchToolsRead({jobId,viewId})))
  const loadPage=(cursor?:string)=>perform(async()=>{const value=await api.branchToolsPage({jobId,viewId,cursor});if(valid())setPage(value)})
  const running=Boolean(result?.state.workerRunning)
  useEffect(()=>{
    if(!running)return
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
    let busyReads=0
    const poll=async()=>{
      if(controller.signal.aborted||!valid())return
      try{const value=await api.branchToolsRead({jobId,viewId},{signal:controller.signal});if(!controller.signal.aborted&&valid()){
        busyReads=0;accept(value);setError(previous=>previous==='history_catalog_busy'?'':previous)
        if(value.state.workerRunning)timer=setTimeout(poll,750)
      }}catch(cause){if(!controller.signal.aborted&&valid()){
        const failure=code(cause)
        if(failure==='history_catalog_busy'&&busyReads++<3)timer=setTimeout(poll,250)
        else setError(failure)
      }}
    }
    timer=setTimeout(poll,300);return()=>{controller.abort();if(timer)clearTimeout(timer)}
  },[api,jobId,viewId,running,accept,valid])
  return {result,page,busy,error,run,cancel,refresh,loadPage}
}
