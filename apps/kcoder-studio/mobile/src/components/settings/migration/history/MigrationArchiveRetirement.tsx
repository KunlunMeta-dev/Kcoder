import { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { Button } from '@/components/ui'
import { t } from '@/i18n'
import { useThemedStyles } from '@/theme'
import { migrationRequestId, type MobileMigrationClient } from '@/runtime/migration-client'
import type { MigrationArchiveRetirementStateResult } from '../../../../../../shared/generated/contracts'
import { PageControls, appendPage, makeStyles } from '../migration-result-ui'
import { Confirm, MigrationProblem } from '../workbench/WorkbenchUi'
import { useMigrationAction } from '../workbench/useMigrationAction'
import { useHistoricalRead } from './useHistoricalRead'
import { useHistoricalWorker } from './useHistoricalWorker'

type Props={client:MobileMigrationClient;jobId:string;releaseView:()=>Promise<void>;onRetired:(value:boolean)=>void}
export function MigrationArchiveRetirement({client,jobId,releaseView,onRetired}:Props) {
  const styles=useThemedStyles(makeStyles), action=useMigrationAction(client)
  const scope=useMemo(()=>({client,jobId}),[client,jobId]), owner=useRef(scope);owner.current=scope
  const mounted=useRef(false), request=useRef<{scope:typeof scope;id:string}|null>(null)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  const valid=()=>mounted.current&&owner.current===scope&&client.available()
  const check=()=>{if(!valid())throw new Error('migration_scope_changed')}
  const [expanded,setExpanded]=useState(false), [revision,setRevision]=useState(0)
  const preview=useHistoricalRead(client,'retirementPreview',{jobId},client.supports('retirementPreview'),revision)
  const [selected,setSelected]=useState<{scope:typeof scope;id:string}|null>(null)
  const operation=selected?.scope===scope?selected.id:preview.result?.existing?.retirement.operationId
  const task=useHistoricalWorker(client,'retirementRead',{jobId,operationId:operation??''},!!operation)
  const result=task.result??preview.result?.existing??null, value=result?.retirement
  const retired=value?.logicalRetired===true
  useEffect(()=>onRetired(retired),[retired,onRetired])
  const [pagination,setPagination]=useState<{scope:typeof scope;pages:Array<string|null>}>({scope,pages:[null]})
  const pages=pagination.scope===scope?pagination.pages:[null]
  const list=useHistoricalRead(client,'retirementList',{cursor:pages.at(-1)},expanded,revision)
  const [confirmation,setConfirmation]=useState<{scope:typeof scope;mode:'RETIRE'|'RESUME';value:MigrationArchiveRetirementStateResult;word:string}|null>(null)
  const confirm=confirmation?.scope===scope&&confirmation.value.retirement.operationId===value?.operationId&&confirmation.value.retirement.sequence===value.sequence?confirmation:null
  const running=result?.workerState==='running'||result?.workerScheduled
  const complete=value?.phase==='collected'||value?.logicalRetired&&!value.ownsArchive
  const refresh=()=>{setRevision(old=>old+1);task.refresh()}
  async function prepare() {
    await action.run(async()=>{
      const fresh=await client.call('retirementPreview',{jobId});check()
      if(fresh.existing)return fresh.existing
      if(!fresh.canPrepare)throw new Error(fresh.reasonCode??'history_job_retirement_legacy_retained')
      if(request.current?.scope!==scope)request.current={scope,id:migrationRequestId()}
      return client.call('retirementPrepare',{operationId:request.current.id,jobId,expectedJobSequence:fresh.jobSequence})
    },state=>{if(valid()){setSelected({scope,id:state.retirement.operationId});refresh()}})
  }
  async function operate() {
    if(!confirm||confirm.word!==confirm.mode||!valid())return
    const frozen=confirm
    await task.perform(async()=>{
      const fresh=(await client.call('retirementPreview',{jobId})).existing;check()
      if(!fresh||fresh.retirement.operationId!==frozen.value.retirement.operationId||fresh.retirement.sequence!==frozen.value.retirement.sequence||fresh.retirement.cancelRevision!==frozen.value.retirement.cancelRevision)throw new Error('external_history_retirement_stale_sequence')
      if(fresh.workerState==='running'||fresh.workerScheduled)throw new Error('external_history_retirement_execution_busy')
      if(frozen.mode==='RETIRE'&&fresh.workerState!=='stopped')throw new Error('external_history_retirement_execution_unknown')
      await releaseView();check()
      const params={operationId:fresh.retirement.operationId,jobId,expectedSequence:fresh.retirement.sequence}
      return client.call(frozen.mode==='RETIRE'?'retirementRun':'retirementResume',params)
    })
    if(valid()){setConfirmation(null);setRevision(old=>old+1)}
  }
  async function cancel() {
    if(!value||!valid())return
    await task.perform(()=>client.call('retirementCancel',{jobId,operationId:value.operationId}))
    if(valid())setRevision(old=>old+1)
  }
  if(!client.supports('retirementPreview'))return null
  return <View style={styles.stack} testID="migration-archive-retirement">
    <Button variant="ghost" testID="migration-retirement-expand" onPress={()=>setExpanded(old=>!old)}>{t('migration_history.lifecycle.retirement_title')}</Button>
    {expanded?<>
      <Text style={styles.note}>{t('migration_history.lifecycle.retirement_boundary')}</Text>
      <MigrationProblem code={action.error??task.error??preview.error??list.error}/>
      {preview.result?.reasonCode?<Text style={styles.warning}>{t(`migration_history.lifecycle.errors.${preview.result.reasonCode}`)}</Text>:null}
      {!!(value?.retainedReferences??preview.result?.retainedReferences)&&<Text style={styles.note}>{t('migration_history.lifecycle.references',{count:value?.retainedReferences??preview.result?.retainedReferences??0})}</Text>}
      {value?<View style={styles.stack}>
        <Text style={styles.title} testID="migration-retirement-phase">{t(`migration_history.lifecycle.phase_${value.phase}`)}</Text>
        <Text style={styles.note}>{t(`migration_history.lifecycle.worker_${result?.workerState??'unknown'}`)}</Text>
        <Text style={styles.note}>{t(value.logicalRetired?'migration_history.lifecycle.logically_retired':'migration_history.lifecycle.still_active')}</Text>
        {value.collectedBytes>0?<Text style={styles.note}>{t('migration_history.lifecycle.collected_bytes',{count:value.collectedBytes})}</Text>:null}
        {value.failureCode||result?.workerError?<Text style={styles.warning}>{t(`migration_history.lifecycle.errors.${value.failureCode??result?.workerError}`)}</Text>:null}
      </View>:null}
      <View style={styles.actions}>
        <Button variant="ghost" onPress={refresh}>{t('migration_history.lifecycle.inspect')}</Button>
        {!value?<Button testID="migration-retirement-prepare" disabled={action.busy||!preview.result?.canPrepare} onPress={()=>{void prepare()}}>{t('migration_history.lifecycle.prepare')}</Button>:null}
        {value&&!complete&&!running&&result?.workerState==='stopped'&&!value.cancelRequested&&['prepared','retired'].includes(value.phase)?<Button testID="migration-retirement-run" disabled={task.busy||action.busy} onPress={()=>setConfirmation({scope,mode:'RETIRE',value:result!,word:''})}>{t('migration_history.lifecycle.run')}</Button>:null}
        {value&&!running&&(!complete||result?.workerState==='unknown')?<Button testID="migration-retirement-resume" disabled={task.busy||action.busy} onPress={()=>setConfirmation({scope,mode:'RESUME',value:result!,word:''})}>{t('migration_history.lifecycle.resume')}</Button>:null}
        {value&&!complete?<Button testID="migration-retirement-cancel" variant="ghost" disabled={task.busy||value.cancelRequested} onPress={()=>{void cancel()}}>{t('migration_history.lifecycle.cancel')}</Button>:null}
      </View>
      {confirm?<><Text style={styles.note}>{t(confirm.mode==='RETIRE'?'migration_history.lifecycle.confirm_retire':'migration_history.lifecycle.confirm_resume',{word:confirm.mode})}</Text><Confirm testID="migration-retirement-confirm" keyword={confirm.mode} value={confirm.word} onChange={word=>setConfirmation({...confirm,word})} onConfirm={()=>{void operate()}} onDismiss={()=>setConfirmation(null)} busy={task.busy||action.busy}/></>:null}
      <View style={styles.stack} testID="migration-retirement-audit">
      <Text style={styles.note}>{t('migration_history.lifecycle.audit_list')}</Text>
      {list.result?.items.map(item=>{
        const current=result&&result.retirement.operationId===item.retirement.operationId&&result.retirement.sequence>item.retirement.sequence?result:item;
        return <Text testID="migration-retirement-audit-row" key={current.retirement.operationId} style={styles.note}>{current.retirement.jobId.slice(0,8)} · {t(`migration_history.lifecycle.phase_${current.retirement.phase}`)}</Text>
      })}
      <PageControls previous={pages.length>1} next={!!list.result?.nextCursor} onPrevious={()=>setPagination({scope,pages:pages.slice(0,-1)})} onNext={()=>{const next=list.result?.nextCursor;if(next)setPagination({scope,pages:appendPage(pages,next)})}}/>
      </View>
    </>:null}
  </View>
}
