import {HistoricalSearch} from './HistoricalSearch'
import {HistoricalTranscriptContent} from './HistoricalTranscriptContent'
import {useMigrationTranscript} from '@/kcoder/useMigrationTranscript'
import {useTranslation} from '@/hooks/useTranslation'
import {Button} from '@/components/ui/button'
import type {MigrationContinuationSourceResult} from '../../../../../shared/generated/contracts'

export function ImportedHistoryPanel(props:{deviceId:string,workspacePath?:string,source:NonNullable<MigrationContinuationSourceResult['source']>,isCurrent:()=>boolean}){
  const {t}=useTranslation('migration')
  const model=useMigrationTranscript(props.deviceId,props.workspacePath,props.source.sourceJobId,props.isCurrent,props.source.viewId)
  return <details open className="studio-card-spacing mb-4 rounded-lg border border-border" data-testid="imported-conversation-history">
    <summary className="cursor-pointer text-sm font-medium">{t('conversation_history.title')}{model.page?` · ${t(`conversation_history.sources.${model.page.source}`,{defaultValue:model.page.source})}`:''}</summary>
    <p className="my-3 text-sm text-text-secondary">{t('conversation_history.boundary')}</p>
    {model.reconstructed && <p className="my-3 text-sm text-text-secondary" role="note">{t('conversation_history.reconstructed')}</p>}
    {model.page?.title&&<p className="mb-3 break-words text-sm font-medium">{model.page.title}</p>}
    {model.error&&<div role="alert" className="text-sm text-text-secondary"><p>{t('conversation_history.unavailable')}</p><Button size="sm" variant="ghost" disabled={model.busy} onClick={()=>void model.refresh()}>{t('refresh')}</Button></div>}
    {model.page?<><HistoricalSearch key={`search:${model.scope}`} deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={props.source.sourceJobId} viewId={props.source.viewId} isCurrent={props.isCurrent} model={model}/><HistoricalTranscriptContent model={model}/></>:!model.error&&<p role="status" className="text-sm text-text-muted">{t('conversation_history.loading')}</p>}
  </details>
}
