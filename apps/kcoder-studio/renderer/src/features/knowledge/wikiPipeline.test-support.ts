import type { WikiJob } from '@/kcoder/knowledgeApi'
import {
  wikiPipelineStages,
  type WikiPipelineStageRecord,
  type WikiPipelineStageStatus,
} from '@/types/wikiPipeline'

export function pipelineJob(overrides: Partial<WikiJob> = {}): WikiJob {
  const status: WikiPipelineStageStatus[] = [
    'completed',
    'completed',
    'completed',
    'completed',
    'running',
    'waiting',
    'waiting',
  ]
  const records: WikiPipelineStageRecord[] = wikiPipelineStages.map((stage, index) => ({
    batch: 0,
    sourceRevision: 'revision',
    stage,
    stageKey: `stage-${stage}`,
    unitKey: 'unit-1',
    status: status[index],
    attempt: 1,
    reused: stage === 'analyze',
    updatedAtMs: 2000 + index,
    completedUnits: status[index] === 'completed' ? 3 : stage === 'verify' ? 1 : 0,
    totalUnits: 3,
    unitLabel: stage === 'verify' ? 'Protocol compatibility' : undefined,
    unitIndex: stage === 'verify' ? 1 : undefined,
  }))
  return {
    id: 'job',
    sourceId: 'source',
    sourceRevision: 'revision',
    status: 'running',
    afterChunk: 0,
    pipeline: { version: 1, batch: 0, sourceRevision: 'revision', currentStage: 'verify', records },
    ...overrides,
  }
}
