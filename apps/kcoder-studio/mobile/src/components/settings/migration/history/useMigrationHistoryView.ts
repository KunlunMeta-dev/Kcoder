import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { HistoryViewLeaseController, type HistoryViewSnapshot } from '../../../../../../shared/historyViewLease'
import { migrationRequestId, type MobileMigrationClient } from '@/runtime/migration-client'

const EMPTY:HistoryViewSnapshot={state:'idle',lease:null,error:''}
export function useMigrationHistoryView(client:MobileMigrationClient,jobId:string,archiveId:string|null|undefined,viewId?:string) {
  const key=JSON.stringify([jobId,archiveId,viewId]), controller=useRef<HistoryViewLeaseController|null>(null)
  const [value,setValue]=useState<{client:MobileMigrationClient;key:string;value:HistoryViewSnapshot}>({client,key,value:EMPTY})
  useEffect(()=>{
    if(!archiveId || !client.supports('historyViewOpen')) return
    let current=true
    const lease=new HistoryViewLeaseController({
      historyViewOpen:p=>client.call('historyViewOpen',p), historyViewRead:p=>client.call('historyViewRead',p),
      historyViewRenew:p=>client.call('historyViewRenew',p), historyViewRelease:p=>client.call('historyViewRelease',p),
    },{jobId,archiveId,viewId},migrationRequestId)
    controller.current=lease
    const unsubscribe=lease.subscribe(()=>{if(current)setValue({client,key,value:lease.snapshot()})})
    const invalidate=()=>lease.invalidate()
    const subscription=AppState.addEventListener('change',state=>{if(state!=='active')invalidate()})
    if(typeof window!=='undefined') window.addEventListener('offline',invalidate)
    if(client.available()) void lease.open()
    return()=>{
      current=false;unsubscribe();subscription.remove()
      if(typeof window!=='undefined')window.removeEventListener('offline',invalidate)
      if(controller.current===lease)controller.current=null
      lease.dispose()
    }
  },[client,key,jobId,archiveId,viewId])
  const open=useCallback(()=>{if(client.available())void controller.current?.open()},[client])
  const release=useCallback(async()=>{if(!client.available())throw new Error('history_view_scope_changed');await controller.current?.release()},[client])
  const status=value.client===client&&value.key===key?value.value:EMPTY
  return {...status,open,release}
}
