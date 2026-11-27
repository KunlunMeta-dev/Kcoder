import {HistoricalSearch} from '@/components/chat/history/HistoricalSearch'
import {HistoricalTranscriptContent} from '@/components/chat/history/HistoricalTranscriptContent'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationTranscript } from '@/kcoder/useMigrationTranscript'
import { useMigrationBranch } from '@/kcoder/useMigrationBranch'
import { MigrationBranchControls } from './MigrationBranchControls'
import { MigrationBranchTools } from './MigrationBranchTools'
import { MigrationContinuationPanel } from './MigrationContinuationPanel'
import { Button } from '@/components/ui/button'
import { MigrationLocalAttachmentSelections } from './MigrationLocalAttachmentSelections'
import { useMigrationHistoryView } from '@/kcoder/useMigrationHistoryView'
import { MigrationHistoryViewStatus } from './MigrationHistoryViewStatus'
import { MigrationArchiveRetirement } from './MigrationArchiveRetirement'


export function MigrationTranscriptViewer(props: {deviceId: string, workspacePath?: string, jobId: string, archiveId?:string|null, isCurrent: () => boolean, allowBranches?:boolean, source?:string}) {
  const { t } = useTranslation('migration')
  const [currentBranch,setCurrentBranch]=useState(false)
  const [retired,setRetired]=useState(false)
  const branch=useMigrationBranch(props.deviceId,props.workspacePath,props.jobId,props.isCurrent,props.allowBranches!==false)
  const model = useMigrationTranscript(props.deviceId, props.workspacePath, props.jobId, props.isCurrent,currentBranch?branch.readyViewId:undefined)
  const view=useMigrationHistoryView({...props,viewId:currentBranch?branch.readyViewId:undefined})
  return <MigrationLocalAttachmentSelections sourceJobId={props.jobId} viewId={currentBranch?branch.readyViewId:undefined} targetScope={JSON.stringify([props.deviceId,props.workspacePath??''])}><section data-testid="migration-transcript" className="studio-card-spacing space-y-3 rounded-lg border border-border" aria-busy={model.busy}>
    <div className="flex items-center justify-between gap-3"><h3 className="min-w-0 truncate text-base font-medium" title={model.page?.title || undefined}>{model.page?.title || t('transcript.title')}</h3>
      <Button size="sm" variant="ghost" onClick={() => void model.refresh()} disabled={model.busy||retired}>{t('refresh')}</Button></div>
    {!retired&&<MigrationHistoryViewStatus model={view}/>}
    {props.archiveId&&<MigrationArchiveRetirement {...props} releaseView={view.release} onRetired={setRetired}/>}
    {retired?<p className="text-sm text-text-secondary" data-testid="migration-history-retired">{t('lifecycle.retired_body')}</p>:<>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={!currentBranch?'secondary':'ghost'} aria-pressed={!currentBranch} onClick={()=>setCurrentBranch(false)}>{t('branch.all_records')}</Button>
      <Button size="sm" variant={currentBranch?'secondary':'ghost'} aria-pressed={currentBranch} disabled={!branch.available} onClick={()=>setCurrentBranch(true)}>{t('branch.current')}</Button>
    </div>
    <p className="text-sm text-text-secondary">{t(currentBranch?'branch.view_boundary':'transcript.boundary')}</p>
    {!currentBranch&&!branch.available&&branch.error&&<div className="text-sm text-text-secondary">
      <p>{t(`errors.${branch.error}`,{defaultValue:t('branch.failed')})}</p>
      <Button size="sm" variant="ghost" disabled={branch.busy} onClick={()=>void branch.refresh()}>{t('refresh')}</Button>
    </div>}
    {currentBranch&&<MigrationBranchControls model={branch} source={props.source??model.page?.source??''} jobId={props.jobId}/>}
    {currentBranch&&branch.readyViewId&&<MigrationBranchTools key={branch.readyViewId} deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={props.jobId} viewId={branch.readyViewId} isCurrent={props.isCurrent}/>}
    {currentBranch&&branch.readyViewId&&branch.state?.progress?.structuralComplete&&<MigrationContinuationPanel key={`continuation:${branch.readyViewId}`} deviceId={props.deviceId} workspacePath={props.workspacePath} sourceJobId={props.jobId} viewId={branch.readyViewId} isCurrent={props.isCurrent}/>}
    {model.error && <p role="alert" className="text-sm text-destructive">{t(`errors.${model.error}`, {defaultValue:t('transcript.read_failed')})}</p>}
    {model.page && (!currentBranch||branch.readyViewId) && <>
      {!model.page.normalizationComplete && <p className="text-sm text-text-secondary">{t('transcript.partial')}</p>}
      <HistoricalSearch key={`search:${model.scope}`} deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={props.jobId} viewId={currentBranch?branch.readyViewId:undefined} isCurrent={props.isCurrent} model={model}/>
      <HistoricalTranscriptContent model={model}/>
    </>}
    </>}
  </section></MigrationLocalAttachmentSelections>
}
