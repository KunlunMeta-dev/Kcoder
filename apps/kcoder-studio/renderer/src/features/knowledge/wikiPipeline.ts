import {
  wikiPipelineStages,
  wikiPipelineStatuses,
  type WikiPipelineStageAddress,
  type WikiPipelineStageKind,
  type WikiPipelineStageRecord,
  type WikiPipelineStageStatus,
  type WikiPipelineProgress,
} from '@/types/wikiPipeline'
import type { WikiJob, WikiSource } from '@/kcoder/knowledgeApi'

const stages = new Set<string>(wikiPipelineStages)
const statuses = new Set<string>(wikiPipelineStatuses)
export const wikiDisplayStages = [
  { id: 'read', stages: ['extract'] },
  { id: 'analyze', stages: ['analyze'] },
  { id: 'organize', stages: ['retrieve', 'generate'] },
  { id: 'check', stages: ['verify', 'coverage'] },
  { id: 'save', stages: ['commit'] },
] as const

export function knownWikiCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Unknown protocol values remain read-only rather than inventing completed steps. */
export function readableWikiPipeline(job: WikiJob): WikiPipelineProgress | undefined {
  const pipeline = job.pipeline
  if (
    !pipeline ||
    pipeline.version !== 1 ||
    !Array.isArray(pipeline.records) ||
    !knownWikiCount(pipeline.batch) ||
    typeof pipeline.sourceRevision !== 'string'
  )
    return undefined
  if (pipeline.currentStage != null && !stages.has(pipeline.currentStage)) return undefined
  if (pipeline.resumeStage && !stages.has(pipeline.resumeStage.stage)) return undefined
  if (
    pipeline.records.some(
      record =>
        !record ||
        !stages.has(record.stage) ||
        !statuses.has(record.status) ||
        !knownWikiCount(record.batch) ||
        typeof record.sourceRevision !== 'string'
    )
  )
    return undefined
  return pipeline
}

function sameAddress(record: WikiPipelineStageAddress, address: WikiPipelineStageAddress) {
  return (
    record.batch === address.batch &&
    record.sourceRevision === address.sourceRevision &&
    record.stage === address.stage &&
    record.stageKey === address.stageKey &&
    record.unitKey === address.unitKey
  )
}

export function wikiPipelineCurrentRecords(pipeline: WikiPipelineProgress) {
  const records = new Map<string, WikiPipelineStageRecord>()
  for (const record of pipeline.records) {
    if (record.batch !== pipeline.batch || record.sourceRevision !== pipeline.sourceRevision)
      continue
    const key = JSON.stringify([record.stage, record.stageKey, record.unitKey])
    const previous = records.get(key)
    if (
      !previous ||
      record.attempt > previous.attempt ||
      (record.attempt === previous.attempt && record.updatedAtMs >= previous.updatedAtMs)
    )
      records.set(key, record)
  }
  return [...records.values()]
}

export function wikiPipelineFocus(job: WikiJob) {
  const pipeline = readableWikiPipeline(job)
  if (!pipeline) return undefined
  const records = wikiPipelineCurrentRecords(pipeline)
  const resume = pipeline.resumeStage
  const recovering = ['failed', 'paused', 'awaiting_review'].includes(job.status)
  const addressed = Boolean(
    resume && (recovering || !pipeline.currentStage || resume.stage === pipeline.currentStage)
  )
  const exact =
    resume && addressed
      ? pipeline.records
          .filter(record => sameAddress(record, resume))
          .reduce<WikiPipelineStageRecord | undefined>(
            (previous, record) =>
              !previous ||
              record.attempt > previous.attempt ||
              (record.attempt === previous.attempt && record.updatedAtMs > previous.updatedAtMs)
                ? record
                : previous,
            undefined
          )
      : undefined
  const stage = recovering
    ? (resume?.stage ?? pipeline.currentStage)
    : (pipeline.currentStage ?? resume?.stage)
  if (!stage) return undefined
  const latest = addressed
    ? exact
    : records
        .filter(record => record.stage === stage)
        .reduce<WikiPipelineStageRecord | undefined>(
          (previous, record) =>
            !previous || record.updatedAtMs > previous.updatedAtMs ? record : previous,
          undefined
        )
  return { stage, record: latest, resume }
}

function indexedUnits(records: WikiPipelineStageRecord[]) {
  const units = new Map<number, WikiPipelineStageRecord>()
  for (const record of records) {
    if (!knownWikiCount(record.unitIndex)) continue
    const previous = units.get(record.unitIndex)
    if (
      !previous ||
      record.updatedAtMs > previous.updatedAtMs ||
      (record.updatedAtMs === previous.updatedAtMs && record.attempt > previous.attempt)
    )
      units.set(record.unitIndex, record)
  }
  return [...units.values()]
}

/** Indexed records count real planned units; parent/correction calls do not add topics. */
export function wikiPipelineStageCounts(
  pipeline: WikiPipelineProgress,
  stage: WikiPipelineStageKind
) {
  const records = wikiPipelineCurrentRecords(pipeline).filter(record => record.stage === stage)
  const units = indexedUnits(records)
  if (units.length) {
    const reported = units.filter(record => knownWikiCount(record.completedUnits))
    const totals = new Set(
      units.flatMap(record => (knownWikiCount(record.totalUnits) ? [record.totalUnits] : []))
    )
    const completedUnits = reported.length
      ? reported.reduce((total, record) => total + record.completedUnits!, 0)
      : undefined
    const totalUnits = totals.size === 1 ? [...totals][0] : undefined
    return { completedUnits, totalUnits }
  }
  const latest = records.reduce<WikiPipelineStageRecord | undefined>(
    (previous, record) =>
      !previous || record.updatedAtMs > previous.updatedAtMs ? record : previous,
    undefined
  )
  return { completedUnits: latest?.completedUnits, totalUnits: latest?.totalUnits }
}

function aggregateStatus(
  records: WikiPipelineStageRecord[],
  requiredStages: readonly WikiPipelineStageKind[]
): WikiPipelineStageStatus {
  for (const status of [
    'failed',
    'needs_review',
    'paused',
    'running',
    'received',
    'validated',
  ] as const) {
    if (records.some(record => record.status === status)) return status
  }
  const allRecorded = requiredStages.every(stage => records.some(record => record.stage === stage))
  const allCompleted =
    records.length > 0 &&
    records.every(
      record =>
        record.status === 'completed' &&
        !(
          !knownWikiCount(record.unitIndex) &&
          knownWikiCount(record.completedUnits) &&
          knownWikiCount(record.totalUnits) &&
          record.completedUnits < record.totalUnits
        )
    )
  const allPlannedUnits = requiredStages.every(stage => {
    const units = indexedUnits(records.filter(record => record.stage === stage))
    const totals = units.flatMap(record =>
      knownWikiCount(record.totalUnits) ? [record.totalUnits] : []
    )
    return !totals.length || units.length >= Math.max(...totals)
  })
  return allRecorded && allCompleted && allPlannedUnits ? 'completed' : 'waiting'
}

export function wikiPipelineDisplay(job: WikiJob) {
  const pipeline = readableWikiPipeline(job)
  if (!pipeline) return undefined
  const records = wikiPipelineCurrentRecords(pipeline)
  const focus = wikiPipelineFocus(job)
  return wikiDisplayStages.map(display => {
    const members: readonly WikiPipelineStageKind[] = display.stages
    const stageRecords = records.filter(record => members.includes(record.stage))
    return {
      id: display.id,
      status: aggregateStatus(stageRecords, members),
      current: Boolean(focus && members.includes(focus.stage)),
      reused: stageRecords.some(record => record.reused),
    }
  })
}

export function wikiSourceJob(jobs: WikiJob[], source: WikiSource) {
  // The authority's overview prioritizes active work, then newest records within each status.
  const matching = jobs.filter(job => job.sourceId === source.sourceId)
  return (
    matching.find(
      job => (job.sourceRevision ?? job.pipeline?.sourceRevision) === source.revisionId
    ) ?? matching[0]
  )
}
