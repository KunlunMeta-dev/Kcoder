import { useTranslation } from '@/hooks/useTranslation'
import type { WikiJob, WikiSource } from '@/kcoder/knowledgeApi'
import { wikiJobPhase } from './wikiJobProgress'
import {
  readableWikiPipeline,
  wikiPipelineFocus,
  wikiSourceJob,
  wikiPipelineStageCounts,
} from './wikiPipeline'
import { WikiPipelineUnitCount } from './WikiPipelineProgress'

export function WikiSourceJobStatus({
  source,
  jobs,
  disconnected,
}: {
  source: WikiSource
  jobs: WikiJob[]
  disconnected: boolean
}) {
  const { t } = useTranslation('knowledge')
  const job = wikiSourceJob(jobs, source)
  if (!job) return null
  const revision = job.sourceRevision ?? job.pipeline?.sourceRevision
  if (revision && revision !== source.revisionId)
    return (
      <span
        className="mt-1 block text-xs font-normal text-text-muted"
        data-testid={`wiki-source-job-${source.sourceId}`}
        data-state="updated"
      >
        {t('pipeline.sourceUpdated')}
      </span>
    )
  const phase = wikiJobPhase(job)
  const pipeline = phase !== 'unknown' ? readableWikiPipeline(job) : undefined
  const focus =
    pipeline && !['completed', 'cancelled'].includes(job.status)
      ? wikiPipelineFocus(job)
      : undefined
  const status =
    focus?.record && ['running', 'queued'].includes(job.status)
      ? t(`pipeline.status.${focus.record.status}`)
      : t(`jobStatus.${job.status}`, { defaultValue: t('jobPhase.unknown') })
  const label = focus ? `${t(`pipeline.stage.${focus.stage}`)} · ${status}` : t(`jobPhase.${phase}`)
  return (
    <span
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-text-muted"
      data-testid={`wiki-source-job-${source.sourceId}`}
      data-state={job.status}
    >
      <span>{disconnected ? t('pipeline.lastKnown', { state: label }) : label}</span>
      {focus?.record && pipeline && (
        <WikiPipelineUnitCount
          record={wikiPipelineStageCounts(pipeline, focus.stage)}
          preparing={['running', 'queued'].includes(job.status)}
        />
      )}
    </span>
  )
}
