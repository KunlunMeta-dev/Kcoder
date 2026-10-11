import {
  Check,
  Circle,
  CircleAlert,
  CircleDot,
  CircleHelp,
  LoaderCircle,
  Pause,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { WikiJob } from '@/kcoder/knowledgeApi'
import type { WikiPipelineStageRecord } from '@/types/wikiPipeline'
import { safeWikiPipelineFailure } from './wikiJobProgress'
import {
  knownWikiCount,
  readableWikiPipeline,
  wikiPipelineDisplay,
  wikiPipelineFocus,
  wikiPipelineCurrentRecords,
  wikiPipelineStageCounts,
} from './wikiPipeline'

export function WikiPipelineUnitCount({
  record,
  preparing = true,
}: {
  record?: Pick<WikiPipelineStageRecord, 'completedUnits' | 'totalUnits'>
  preparing?: boolean
}) {
  const { t } = useTranslation('knowledge')
  if (!record) return null
  const completed = knownWikiCount(record.completedUnits) ? record.completedUnits : undefined
  const total =
    knownWikiCount(record.totalUnits) && (completed === undefined || completed <= record.totalUnits)
      ? record.totalUnits
      : undefined
  if (!preparing && completed === undefined && total === undefined) return null
  return (
    <span className="tabular-nums" data-testid="wiki-pipeline-unit-count">
      {completed !== undefined && total !== undefined
        ? t('pipeline.units', { completed, total })
        : completed !== undefined && (completed > 0 || !preparing)
          ? t('pipeline.completedUnits', { completed })
          : total !== undefined
            ? t('pipeline.totalUnits', { total })
            : t('pipeline.preparing')}
    </span>
  )
}

function unitLabel(
  record: WikiPipelineStageRecord | undefined,
  t: ReturnType<typeof useTranslation>['t']
) {
  if (record?.unitLabel?.trim()) return record.unitLabel.trim()
  if (!knownWikiCount(record?.unitIndex)) return undefined
  return knownWikiCount(record?.totalUnits) && record.unitIndex < record.totalUnits
    ? t('pipeline.unitNumberOf', { number: record.unitIndex + 1, total: record.totalUnits })
    : t('pipeline.unitNumber', { number: record.unitIndex + 1 })
}

export function WikiPipelineSummary({
  job,
  now,
  disconnected = false,
}: {
  job: WikiJob
  now?: number
  disconnected?: boolean
}) {
  const { t } = useTranslation('knowledge')
  const focus = wikiPipelineFocus(job)
  if (!focus) return null
  const pipeline = readableWikiPipeline(job)!
  const counts = wikiPipelineStageCounts(pipeline, focus.stage)
  const record = focus.record
  const end = knownWikiCount(record?.completedAtMs)
    ? record.completedAtMs
    : record?.status === 'running' && job.status === 'running' && !disconnected
      ? now
      : undefined
  const elapsed =
    knownWikiCount(record?.startedAtMs) &&
    record.startedAtMs > 0 &&
    end !== undefined &&
    end >= record.startedAtMs
      ? Math.floor((end - record.startedAtMs) / 1000)
      : undefined
  const label = unitLabel(focus.record, t)
  const stage = t(`pipeline.stage.${focus.stage}`)
  const statusKey =
    job.status === 'awaiting_review' && job.reviewAvailable === false ? 'failed' : job.status
  const status = ['failed', 'paused', 'awaiting_review', 'completed', 'cancelled'].includes(
    statusKey
  )
    ? t(`jobStatus.${statusKey}`)
    : focus.record
      ? t(`pipeline.status.${focus.record.status}`)
      : undefined
  return (
    <div className="space-y-1" data-testid="wiki-pipeline-summary" aria-live="polite">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {stage}
          {status ? ` · ${status}` : ''}
        </span>
        {focus.record?.reused && <span className="text-text-muted">{t('pipeline.reused')}</span>}
      </p>
      {(label ||
        knownWikiCount(counts.completedUnits) ||
        knownWikiCount(counts.totalUnits) ||
        elapsed !== undefined ||
        ['running', 'queued'].includes(job.status)) && (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-text-muted">
          {label && (
            <span className="min-w-0 truncate" title={label} data-testid="wiki-pipeline-unit-label">
              {label}
            </span>
          )}
          <WikiPipelineUnitCount
            record={counts}
            preparing={['running', 'queued'].includes(job.status)}
          />
          {elapsed !== undefined && (
            <span className="tabular-nums">
              {t('pipeline.duration', { seconds: elapsed, count: elapsed })}
            </span>
          )}
        </p>
      )}
    </div>
  )
}

export function WikiPipelineProgress({
  job,
  disconnected,
}: {
  job: WikiJob
  disconnected: boolean
}) {
  const { t } = useTranslation('knowledge')
  const steps = wikiPipelineDisplay(job)
  if (!steps) return null
  return (
    <ol
      className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2 text-xs"
      aria-label={t('pipeline.title')}
      data-testid="wiki-pipeline-progress"
    >
      {steps.map(step => {
        const Icon =
          step.status === 'completed'
            ? Check
            : step.status === 'failed'
              ? CircleAlert
              : step.status === 'needs_review'
                ? CircleHelp
                : step.status === 'paused'
                  ? Pause
                  : step.status === 'running' && !disconnected
                    ? LoaderCircle
                    : ['received', 'validated'].includes(step.status)
                      ? CircleDot
                      : Circle
        const label = `${t(`pipeline.display.${step.id}`)} · ${t(`pipeline.status.${step.status}`)}`
        return (
          <li
            key={step.id}
            data-testid={`wiki-pipeline-step-${step.id}`}
            data-state={step.status}
            data-reused={step.reused ? 'true' : 'false'}
            aria-current={step.current ? 'step' : undefined}
            aria-label={step.reused ? `${label} · ${t('pipeline.reused')}` : label}
            title={label}
            className={step.current ? 'text-text-primary' : 'text-text-muted'}
          >
            <span className="flex items-center gap-1">
              <Icon
                className={`size-3 ${step.status === 'running' && !disconnected ? 'animate-spin' : ''} ${step.status === 'failed' ? 'text-red-500' : ''}`}
                aria-hidden="true"
              />
              {t(`pipeline.display.${step.id}`)}
            </span>
            {step.reused && (
              <span className="ml-4 block text-xs text-text-muted">{t('pipeline.reused')}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function WikiPipelineDetails({ job }: { job: WikiJob }) {
  const { t } = useTranslation('knowledge')
  const pipeline = readableWikiPipeline(job)
  if (!pipeline) return null
  const records = wikiPipelineCurrentRecords(pipeline)
  return (
    <section className="space-y-3" data-testid="wiki-pipeline-details">
      <h3 className="text-sm font-medium text-text-primary">{t('pipeline.title')}</h3>
      <ol className="divide-y divide-border/40">
        {records.map(record => {
          const label = unitLabel(record, t)
          const failure = safeWikiPipelineFailure(record)
          return (
            <li
              key={JSON.stringify([record.stage, record.stageKey, record.unitKey])}
              className="space-y-1 py-2"
              data-testid={`wiki-pipeline-record-${record.stage}`}
            >
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <span className="text-text-primary">{t(`pipeline.stage.${record.stage}`)}</span>
                <span>
                  {t(`pipeline.status.${record.status}`)}
                  {record.reused ? ` · ${t('pipeline.reused')}` : ''}
                </span>
              </div>
              {label && <p className="break-words">{label}</p>}
              <div className="flex flex-wrap gap-x-3 text-xs text-text-muted">
                {(record.completedUnits != null || record.totalUnits != null) && (
                  <WikiPipelineUnitCount record={record} />
                )}
                {knownWikiCount(record.attempt) && record.attempt > 0 && (
                  <span>{t('pipeline.attempt', { attempt: record.attempt })}</span>
                )}
                {knownWikiCount(record.startedAtMs) &&
                  record.startedAtMs > 0 &&
                  knownWikiCount(record.completedAtMs) &&
                  record.completedAtMs >= record.startedAtMs && (
                    <span>
                      {t('pipeline.duration', {
                        seconds: Math.floor((record.completedAtMs - record.startedAtMs) / 1000),
                      })}
                    </span>
                  )}
              </div>
              {record.errorCode && (
                <p className="text-xs text-text-muted">
                  {t(`jobErrors.${record.errorCode}`, { defaultValue: t('jobError') })}
                </p>
              )}
              {failure && failure.field !== '/' && (
                <p className="break-all text-xs text-text-muted">
                  {t('pipeline.validationField', { field: failure.field })}
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
