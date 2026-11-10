import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {createMigrationApi} from './gatewayMigration'
import {captureAccountContextRevision} from './accountContextEvents'
import {sha256} from '@noble/hashes/sha2.js'
import type {MigrationContinuationStateResult,MigrationContinuationCreateParams,HistoricalLocalAttachmentBinding} from '../../../shared/generated/contracts'
const NO_LOCAL_ATTACHMENTS:HistoricalLocalAttachmentBinding[]=[]
const code=(cause:unknown)=>(cause instanceof Error?cause.message:'').match(/\b(?:migration|history|external_history|continuation|historical_projection|historical_seed)_[a-z_]+\b/)?.[0]??'error'

/** The client caches only a receipt identity; journals remain authoritative. */
export function useMigrationContinuation(deviceId:string,workspacePath:string|undefined,sourceJobId:string,viewId:string,isCurrent:()=>boolean,localAttachments:HistoricalLocalAttachmentBinding[]=NO_LOCAL_ATTACHMENTS){
  const api=useMemo(()=>createMigrationApi(deviceId,workspacePath),[deviceId,workspacePath])
  const localSelection=useMemo(()=>[...localAttachments].sort((left,right)=>left.operationId.localeCompare(right.operationId)),[localAttachments])
  const localIdentity=useMemo(()=>localSelection.length?Array.from(sha256(new TextEncoder().encode(JSON.stringify(localSelection))),value=>value.toString(16).padStart(2,'0')).join(''):'',[localSelection])
  const key=useMemo(()=>`kcoder.migration.continuation:${JSON.stringify([deviceId,workspacePath??'',sourceJobId,viewId])}${localIdentity?`:local:${localIdentity}`:''}`,[deviceId,workspacePath,sourceJobId,viewId,localIdentity])
  const scope=useMemo(()=>({api,key,account:captureAccountContextRevision()}),[api,key])
  const owner=useRef(scope),mounted=useRef(false),current=useRef(isCurrent),active=useRef<typeof scope|null>(null)
  const latest=useRef<MigrationContinuationStateResult|null>(null),request=useRef<string|undefined>(undefined)
  const [state,setState]=useState({scope,result:null as MigrationContinuationStateResult|null,busy:false,error:''})
  const result=state.scope===scope?state.result:null,busy=state.scope===scope&&state.busy,error=state.scope===scope?state.error:''
  useLayoutEffect(()=>{current.current=isCurrent},[isCurrent])
  useLayoutEffect(()=>{
    owner.current=scope;mounted.current=true;latest.current=null;request.current=undefined
    try{request.current=localStorage.getItem(key)??undefined}catch{/* Unavailable cache does not prevent receipt checks. */}
    return()=>{if(owner.current===scope)mounted.current=false}
  },[scope,key])
  const valid=useCallback(()=>mounted.current&&owner.current===scope&&scope.account(deviceId)&&current.current(),[scope,deviceId])
  const update=useCallback((partial:Partial<Omit<typeof state,'scope'>>)=>{
    if(valid())setState(before=>({...((before.scope===scope)?before:{scope,result:null,busy:false,error:''}),...partial,scope}))
  },[scope,valid])
  const accept=useCallback((value:MigrationContinuationStateResult)=>{
    if(!valid())return
    const before=latest.current
    if(before?.job.jobId===value.job.jobId&&(before.job.sequence>value.job.sequence||(before.job.sequence===value.job.sequence&&before.job.cancelRevision>value.job.cancelRevision)))return
    latest.current=value;update({result:value})
  },[valid,update])
  useEffect(()=>{
    const controller=new AbortController(),cached=request.current
    const timer=setTimeout(()=>{if(cached)void api.continuationRead({jobId:cached},{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)accept(value)}).catch(cause=>{if(!controller.signal.aborted)update({error:code(cause)})})},0)
    return()=>{controller.abort();clearTimeout(timer)}
  },[api,scope,accept,update])
  const perform=async(action:()=>Promise<void>)=>{
    if(!valid()||active.current===scope)return false
    active.current=scope;update({busy:true,error:''})
    try{await action();return true}catch(cause){
      if(valid())update({error:code(cause)})
      if(valid()&&request.current)try{accept(await api.continuationRead({jobId:request.current}))}catch{/* Observation cannot authorize replay. */}
      return false
    }finally{if(active.current===scope)active.current=null;update({busy:false})}
  }
  const create=(mode:'kcoder'|'kworker')=>perform(async()=>{
    const jobId=request.current??crypto.randomUUID();request.current=jobId
    try{localStorage.setItem(key,jobId)}catch{/* The in-memory identity still fences this submission. */}
    const params:MigrationContinuationCreateParams={requestId:jobId,sourceJobId,viewId,policy:{maxContextBytes:4194304,maxEntries:2048,maxAttachments:256,maxAttachmentBytes:536870912},options:{model:null,settingsTemplate:null,studioWorkMode:mode,...(localSelection.length?{localAttachments:localSelection}:{})}}
    const value=await api.continuationCreate(params);if(!valid())return;accept(value)
    if(value.job.stage==='planned'){const next=await api.continuationRun({jobId,expectedSequence:value.job.sequence});if(valid())accept(next)}
  })
  const resume=()=>perform(async()=>{
    const value=latest.current;if(!value)return
    const params={jobId:value.job.jobId,expectedSequence:value.job.sequence}
    accept(await(value.job.stage==='planned'?api.continuationRun(params):api.continuationResume(params)))
  })
  const refresh=()=>perform(async()=>{if(request.current)accept(await api.continuationRead({jobId:request.current}))})
  const cancel=()=>perform(async()=>{if(latest.current)accept(await api.continuationCancel({jobId:latest.current.job.jobId}))})
  const running=Boolean(result?.workerRunning),jobId=result?.job.jobId
  useEffect(()=>{
    if(!running||!jobId)return
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
    const poll=async()=>{try{const value=await api.continuationRead({jobId},{signal:controller.signal});if(!controller.signal.aborted&&valid()){
      accept(value);if(latest.current?.workerRunning)timer=setTimeout(poll,750)
    }}catch(cause){if(!controller.signal.aborted)update({error:code(cause)})}}
    timer=setTimeout(poll,300);return()=>{controller.abort();if(timer)clearTimeout(timer)}
  },[api,running,jobId,accept,valid,update])
  return {result,busy,error,create,resume,refresh,cancel}
}
