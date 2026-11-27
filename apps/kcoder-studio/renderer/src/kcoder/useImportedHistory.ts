import {useCallback,useEffect,useMemo,useState} from 'react'
import {registerBackgroundIssue} from './backgroundIssues'
import {createMigrationApi} from './gatewayMigration'
import {captureAccountContextRevision,listenAccountContextChanges} from './accountContextEvents'
import type {MigrationContinuationSourceResult} from '../../../shared/generated/contracts'

/** Provenance is read from the selected native thread, never recovered from a client cache. */
export function useImportedHistory(deviceId:string|undefined,taskId:string|undefined,workspacePath?:string){
  const [revision,setRevision]=useState(0)
  const scope=useMemo(()=>({deviceId,taskId,workspacePath,revision,valid:captureAccountContextRevision()}),[deviceId,taskId,workspacePath,revision])
  const [state,setState]=useState<{scope:typeof scope,source:MigrationContinuationSourceResult['source'],error:string}>({scope,source:null,error:''})
  useEffect(()=>listenAccountContextChanges(target=>{if(target===deviceId)setRevision(value=>value+1)}),[deviceId])
  useEffect(()=>{
    const prefix=`kcoder:${deviceId}:`
    if(!deviceId||!taskId?.startsWith(prefix))return
    const threadId=taskId.slice(prefix.length)
    if(!threadId)return
    const controller=new AbortController(),api=createMigrationApi(deviceId,workspacePath)
    const valid=()=>!controller.signal.aborted&&scope.valid(deviceId)
    const timer=setTimeout(()=>{
      void api.continuationSource({threadId},{signal:controller.signal}).then(result=>{
        if(valid())setState({scope,source:result.source,error:''})
      }).catch(cause=>{
        const code=(cause instanceof Error?cause.message:'').match(/\b(?:migration|continuation|historical_seed)_[a-z_]+\b/)?.[0]??'error'
        // Older targets lack this observation; keep their ordinary conversation behavior compatible.
        if(valid())setState({scope,source:null,error:code.endsWith('update_required')?'':code})
      })
    },0)
    return()=>{controller.abort();clearTimeout(timer)}
  },[scope,deviceId,taskId,workspacePath])
  const isCurrent=useCallback(()=>Boolean(deviceId)&&scope.valid(deviceId!),[scope,deviceId])
  const current=state.scope===scope&&isCurrent()
  const dismissError=useCallback(()=>setState(previous=>previous.scope===scope?{...previous,error:''}:previous),[scope])
  const refresh=useCallback(()=>setRevision(value=>value+1),[])
  const error=current?state.error:''
  useEffect(()=>{
    if(!error||!deviceId||!taskId)return
    return registerBackgroundIssue({kind:'imported_history_check',code:'IMPORTED_HISTORY_READ_FAILED',
      target:{deviceId,taskId,workspacePath},isCurrent,retry:refresh,dismiss:dismissError})
  },[error,deviceId,taskId,workspacePath,isCurrent,refresh,dismissError])
  return {source:current?state.source:null,error,isCurrent,dismissError,refresh}
}
