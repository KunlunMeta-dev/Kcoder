import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { TaskCapabilityScopeSelector } from '@/features/connectivity/TaskCapabilityScopeSelector'
import { TaskCapabilityScopePicker } from '@/features/connectivity/TaskCapabilityScopePicker'
import { NativeTaskCapabilityScopeSettings } from '@/features/connectivity/NativeTaskCapabilityScopeSettings'
import { createTaskCapabilityScopeDirectoryTransport } from '@/kcoder/taskCapabilityScopeDirectoryTransport'
import { createTaskCapabilityScopeRecordTransport } from '@/kcoder/taskCapabilityScopeRecordTransport'
import type { TaskWorkspaceTarget } from '@/kcoder/taskWorkspaceTransport'
import type { IntegrationTaskCapabilityScopeControlTarget, IntegrationTaskCapabilityScopeDirectoryEntry, IntegrationTaskCapabilityScopeSnapshot } from '../../../../../shared/generated/contracts'

const tuple=(target:IntegrationTaskCapabilityScopeControlTarget)=>JSON.stringify([target.initialAttempt.threadId,target.initialAttempt.turnId,target.initialAttempt.attemptId,target.runtimeOperationId??null])
export function TaskCapabilityScopeRecords({target,threadId,onSelectedTarget}:{target:TaskWorkspaceTarget;threadId:string;onSelectedTarget?:(target:IntegrationTaskCapabilityScopeControlTarget|undefined)=>void}){
  const scope=usePluginTargetScope(target.serverId,target.workspacePath)
  return <OwnedCapabilityScopeRecords key={JSON.stringify([scope.key,target,threadId])} target={target} threadId={threadId} current={scope.isCurrent} onSelectedTarget={onSelectedTarget}/>
}
function OwnedCapabilityScopeRecords({target,threadId,current,onSelectedTarget}:{target:TaskWorkspaceTarget;threadId:string;current:()=>boolean;onSelectedTarget?:(target:IntegrationTaskCapabilityScopeControlTarget|undefined)=>void}){
  const {t}=useTranslation('taskCapabilityScopeRecords')
  const [owner]=useState(()=>({...target})),[selected,setSelected]=useState<IntegrationTaskCapabilityScopeDirectoryEntry>(),[live,setLive]=useState<IntegrationTaskCapabilityScopeSnapshot>(),[status,setStatus]=useState<'reading'|'current'|'unknown'>('unknown')
  const notify=useRef(onSelectedTarget)
  useEffect(()=>{notify.current=onSelectedTarget},[onSelectedTarget])
  const metadata=useRef(new Map<string,IntegrationTaskCapabilityScopeDirectoryEntry>()),ambiguous=useRef(new Set<string>()),generation=useRef(0),active=useRef(false)
  const reads=useRef(new Set<AbortController>()),pending=useRef<AbortController|null>(null)
  useEffect(()=>{const live=active,sequence=generation,pendingReads=reads.current;live.current=true;return()=>{live.current=false;sequence.current++;for(const abort of pendingReads)abort.abort();pendingReads.clear();notify.current?.(undefined)}},[])
  const loadPage=useCallback(async(cursor:string|null)=>{
    const cancel=new AbortController(),transport=createTaskCapabilityScopeDirectoryTransport(owner,current);reads.current.add(cancel)
    try{
      const value=await transport.read({threadId,...(cursor?{cursor}:{})},cancel.signal)
      if(!active.current||!current())throw new Error('TASK_CAPABILITY_SCOPE_RECORD_OWNER_CHANGED')
      if(!cursor){metadata.current.clear();ambiguous.current.clear()}
      for(const row of value.entries){if(!row.target)continue;const k=tuple(row.target),previous=metadata.current.get(k);if(previous&&previous.referenceId!==row.referenceId)ambiguous.current.add(k);else metadata.current.set(k,structuredClone(row))}
      return {...value,nextCursor:value.nextCursor??null,reasonCode:value.reasonCode??null,entries:value.entries.map(row=>({...row,target:row.target??null,savedSnapshot:row.savedSnapshot??null,reasonCode:row.reasonCode??null,detail:row.target?[row.target.initialAttempt.threadId,row.target.initialAttempt.turnId,row.target.initialAttempt.attemptId,row.target.runtimeOperationId].filter(Boolean).join(' · '):undefined}))}
    }finally{reads.current.delete(cancel);transport.dispose()}
  },[owner,current,threadId])
  const choose=useCallback(async(original:IntegrationTaskCapabilityScopeControlTarget)=>{
    const k=tuple(original),entry=metadata.current.get(k)
    if(!entry||ambiguous.current.has(k)||original.initialAttempt.threadId!==threadId||!active.current||!current())throw new Error('TASK_CAPABILITY_SCOPE_RECORD_INVALID_REFERENCE')
    const selectedGeneration=++generation.current;pending.current?.abort()
    const cancel=new AbortController(),transport=createTaskCapabilityScopeRecordTransport(owner,current);pending.current=cancel;reads.current.add(cancel)
    notify.current?.(structuredClone(original))
    setSelected(structuredClone(entry));setLive(undefined);setStatus('reading')
    try{
      const value=await transport.read(original,entry.savedSnapshot?.revision??0,cancel.signal)
      if(active.current&&current()&&generation.current===selectedGeneration){setLive(value);setStatus('current')}
    }catch(error){if(active.current&&current()&&generation.current===selectedGeneration)setStatus('unknown');throw error}
    finally{reads.current.delete(cancel);transport.dispose()}
  },[owner,current,threadId])
  return <section className="space-y-4" data-testid="task-capability-scope-records">
    <h2 className="text-lg font-medium">{t('title')}</h2>
    <TaskCapabilityScopeSelector ownerKey={JSON.stringify([owner,threadId])} loadPage={loadPage} onChoose={choose}/>
    {selected&&<section className="studio-card-spacing space-y-4 rounded-xl border border-border bg-surface" data-testid="task-capability-scope-selected-record" data-state={status}>
      <div className="flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-sm text-text-secondary">{t(status==='reading'?'reading':status==='current'?'current':'currentUnknown')}</p>{status==='reading'&&<Button variant="ghost" className="min-h-11 md:min-h-0" onClick={()=>{pending.current?.abort();generation.current++;setLive(undefined);setStatus('unknown');notify.current?.(undefined)}}>{t('cancel')}</Button>}</div>
      <p className="text-sm text-text-secondary">{t('savedOnly')}</p>
      <section className="space-y-2"><h3 className="text-base font-medium">{t('savedSnapshot')}</h3>{selected.savedSnapshot?<TaskCapabilityScopePicker readOnly snapshot={selected.savedSnapshot} ownerKey={`saved:${selected.referenceId}`} descriptors={[]} catalogState="unknown"/>:<p className="text-sm text-text-secondary">{t('savedUnknown')}</p>}</section>
      {live&&<section className="space-y-2"><h3 className="text-base font-medium">{t('currentSnapshot')}</h3><TaskCapabilityScopePicker readOnly snapshot={live} ownerKey={`current:${selected.referenceId}`} descriptors={[]} catalogState="unknown"/></section>}
      {live&&selected.target&&<NativeTaskCapabilityScopeSettings key={selected.referenceId} target={owner} original={selected.target} snapshot={live} onChanged={value=>setLive(old=>!old||value.revision>=old.revision?value:old)}/>}
      <details className="text-xs text-text-muted"><summary>{t('original')}</summary><p className="mt-2 break-all">{selected.referenceId}</p>{selected.target&&<p className="break-all">{selected.target.initialAttempt.threadId} · {selected.target.initialAttempt.turnId} · {selected.target.initialAttempt.attemptId}{selected.target.runtimeOperationId?` · ${selected.target.runtimeOperationId}`:''}</p>}</details>
    </section>}
  </section>
}
