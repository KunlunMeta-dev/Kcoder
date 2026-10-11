import { describe, expect, test } from 'vitest'
import type { WikiPipelineProgress } from '@/types/wikiPipeline'
import {
  wikiJobDiagnostic,
  wikiJobPhase,
  wikiJobRecovery,
  wikiJobResumeStage,
} from './wikiJobProgress'
import {
  readableWikiPipeline,
  wikiPipelineCurrentRecords,
  wikiPipelineDisplay,
  wikiPipelineFocus,
  wikiSourceJob,
  wikiPipelineStageCounts,
} from './wikiPipeline'
import { pipelineJob } from './wikiPipeline.test-support'
import examples from '../../../../shared/generated/examples.json'
import { isWikiPipelineProgress } from '../../../../shared/generated/contracts'

// QA: public stage-record interpretation, protocol compatibility and diagnostic privacy.
// These fixtures exercise model-independent contracts, not model output quality.
describe('Wiki pipeline public progress', () => {
  test('the renderer consumes Rust-generated flattened and nullable stage fixtures', () => {
    for (const fixture of examples.WikiPipelineProgress) {
      expect(isWikiPipelineProgress(fixture.value)).toBe(true)
      const job = pipelineJob({ pipeline: fixture.value as WikiPipelineProgress })
      expect(readableWikiPipeline(job)).toBe(fixture.value.version === 1 ? job.pipeline : undefined)
    }
  })
  test('groups seven recorded stages into five honest display steps', () => {
    expect(wikiPipelineDisplay(pipelineJob())).toMatchObject([
      { id: 'read', status: 'completed' },
      { id: 'analyze', status: 'completed', reused: true },
      { id: 'organize', status: 'completed' },
      { id: 'check', status: 'running', current: true },
      { id: 'save', status: 'waiting' },
    ])
  })

  test('previous batches and source revisions cannot complete missing stages in the current batch', () => {
    const job = pipelineJob()
    job.pipeline = {
      ...job.pipeline!,
      batch: 4,
      records: [
        ...job.pipeline!.records,
        { ...job.pipeline!.records[3], batch: 4, status: 'running' },
        { ...job.pipeline!.records[0], batch: 4, sourceRevision: 'old-revision' },
      ],
      currentStage: 'generate',
    }
    expect(wikiPipelineCurrentRecords(job.pipeline)).toHaveLength(1)
    expect(wikiPipelineDisplay(job)).toMatchObject([
      { id: 'read', status: 'waiting' },
      { id: 'analyze', status: 'waiting' },
      { id: 'organize', status: 'running' },
      { id: 'check', status: 'waiting' },
      { id: 'save', status: 'waiting' },
    ])
  })

  test('a completed item cannot complete a stage with outstanding declared units', () => {
    const job = pipelineJob()
    job.pipeline!.records[4].status = 'completed'
    job.pipeline!.records[5].status = 'completed'
    job.pipeline!.records[5].completedUnits = 3
    expect(wikiPipelineDisplay(job)?.find(stage => stage.id === 'check')?.status).toBe('waiting')
  })

  test('planned unit completions sum exactly once and full planned coverage can complete the stage', () => {
    const job = pipelineJob()
    const verify = job.pipeline!.records[4]
    job.pipeline!.records = job.pipeline!.records.filter(record => record.stage !== 'verify')
    for (let unitIndex = 0; unitIndex < 3; unitIndex++)
      job.pipeline!.records.push({
        ...verify,
        unitIndex,
        unitKey: `unit-${unitIndex}`,
        status: 'completed',
        completedUnits: 1,
      })
    job.pipeline!.records.push({
      ...verify,
      unitIndex: 0,
      stageKey: 'repair-call',
      unitKey: 'unit-0',
      status: 'completed',
      completedUnits: 1,
      updatedAtMs: 4000,
    })
    const coverage = job.pipeline!.records.find(record => record.stage === 'coverage')!
    coverage.status = 'completed'
    coverage.completedUnits = 3
    expect(wikiPipelineStageCounts(job.pipeline!, 'verify')).toEqual({
      completedUnits: 3,
      totalUnits: 3,
    })
    expect(wikiPipelineDisplay(job)?.find(stage => stage.id === 'check')?.status).toBe('completed')
  })

  test('resume targets the exact persisted failed unit while a resumed worker follows its current stage', () => {
    const job = pipelineJob({ status: 'failed', errorCode: 'invalid_evidence' })
    const verify = { ...job.pipeline!.records[4], status: 'failed' as const }
    job.pipeline!.records[4] = verify
    job.pipeline!.resumeStage = verify
    expect(wikiJobResumeStage(job)).toMatchObject({ stage: 'verify', unitKey: 'unit-1', batch: 0 })
    expect(wikiPipelineFocus(job)).toMatchObject({
      stage: 'verify',
      record: { unitLabel: 'Protocol compatibility' },
    })
    job.status = 'running'
    job.pipeline!.currentStage = 'commit'
    expect(wikiPipelineFocus(job)?.stage).toBe('commit')
    expect(wikiJobResumeStage({ ...job, errorCode: 'configuration_changed' })).toBeUndefined()
  })

  test('the authoritative address selects the active unit ahead of later waiting record timestamps', () => {
    const job = pipelineJob()
    job.pipeline!.resumeStage = job.pipeline!.records[4]
    job.pipeline!.records.push({
      ...job.pipeline!.records[4],
      unitKey: 'next-unit',
      unitIndex: 2,
      unitLabel: 'Waiting future topic',
      updatedAtMs: 10000,
      status: 'waiting',
    })
    expect(wikiPipelineFocus(job)?.record?.unitLabel).toBe('Protocol compatibility')
  })

  test('a missing addressed unit never borrows another topic label from the same stage', () => {
    const job = pipelineJob({ status: 'failed' })
    job.pipeline!.resumeStage = { ...job.pipeline!.records[4], unitKey: 'not-yet-recorded' }
    expect(wikiPipelineFocus(job)).toMatchObject({ stage: 'verify', record: undefined })
  })

  test('future versions, stage names and statuses stay read-only without false liveness', () => {
    for (const pipeline of [
      { ...pipelineJob().pipeline!, version: 2 },
      { ...pipelineJob().pipeline!, currentStage: 'future-stage' },
      {
        ...pipelineJob().pipeline!,
        records: [{ ...pipelineJob().pipeline!.records[0], status: 'future-status' }],
      },
    ]) {
      const job = pipelineJob({ pipeline: pipeline as WikiPipelineProgress })
      expect(readableWikiPipeline(job)).toBeUndefined()
      expect(wikiJobPhase(job)).toBe('unknown')
      expect(wikiJobRecovery(job)).toBe('unavailable')
    }
    expect(wikiJobPhase({ ...pipelineJob(), pipeline: undefined, progress: null })).toBe('running')
  })

  test('source rows prefer current revision and diagnostics omit labels, raw errors and artifacts', () => {
    const old = pipelineJob({ sourceRevision: 'older' })
    const current = pipelineJob({ status: 'completed' })
    expect(
      wikiSourceJob([old, current], {
        sourceId: 'source',
        revisionId: 'revision',
        title: 'source',
        bodyHash: 'hash',
      })
    ).toBe(current)
    current.pipeline!.records[4].unitLabel = 'PRIVATE SOURCE TITLE'
    current.pipeline!.records[4].errorDetail = 'PRIVATE PROVIDER RESPONSE'
    current.pipeline!.records[4].artifactHash = 'PRIVATE ARTIFACT'
    const diagnostic = wikiJobDiagnostic(current)
    expect(diagnostic.pipeline?.records[4]).toMatchObject({
      stage: 'verify',
      attempt: 1,
      completedUnits: 1,
      totalUnits: 3,
    })
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE')
    current.pipeline!.records[4].errorCode = 'wiki_evidence_quote_span'
    current.pipeline!.records[4].errorDetail = '/pages/1/citations/0/quote'
    expect(wikiJobDiagnostic(current).pipeline?.records[4].failure).toMatchObject({
      stage: 'verify',
      errorType: 'wiki_evidence_quote_span',
      field: '/pages/1/citations/0/quote',
    })
  })
})
