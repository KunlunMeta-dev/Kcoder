import { describe, expect, it } from 'vitest'
import {
  wikiJobDiagnostic,
  wikiJobPhase,
  wikiJobRecovery,
  type WikiObservedJob,
} from './wikiJobProgress'

describe('Wiki job host status projection', () => {
  const job: WikiObservedJob = {
    id: 'job',
    sourceId: 'source',
    status: 'running',
    afterChunk: 2,
    recipeKey: 'wiki-v4:hash',
    progress: {
      phase: 'generation',
      startedAtMs: 100,
      phaseStartedAtMs: 200,
      heartbeatAtMs: 400,
      modelProgressAtMs: 300,
      model: 'provider/model',
      textBytes: 0,
      reasoningBytes: 20,
      reservedCalls: 2,
      repairCalls: 1,
      usageReportedCalls: 0,
    },
  }
  it('exports organization identity/placement categories without raw hashes, unit IDs or text', () => {
    for (const failure of [
      {
        stage: 'organization_validation',
        errorType: 'wiki_organization_binding',
        field: '/organizationPlan/binding/sourceRevision',
      },
      {
        stage: 'organization_validation',
        errorType: 'wiki_organization_target_lines',
        field: '/organizationProof/placements/0/firstLine',
      },
      {
        stage: 'organization_validation',
        errorType: 'wiki_organization_line_mode',
        field: '/organizationProof/placements/0/allLines',
      },
      {
        stage: 'format_repair',
        errorType: 'wiki_organization_plan_repair_schema',
        field: '/organizationPlan',
      },
      {
        stage: 'organization_repair',
        errorType: 'wiki_organization_proof_repair_schema',
        field: '/organizationProof',
      },
    ]) {
      expect(wikiJobDiagnostic({ ...job, errorDetail: JSON.stringify(failure) }).failure).toEqual(
        failure
      )
      expect(
        wikiJobDiagnostic({
          ...job,
          errorDetail: JSON.stringify({ ...failure, reason: 'PRIVATE' }),
        }).failure
      ).toBeUndefined()
      expect(
        wikiJobDiagnostic({
          ...job,
          errorDetail: JSON.stringify({
            ...failure,
            field: '/organizationProof/hostBodyHashes/PRIVATE_UUID',
          }),
        }).failure
      ).toBeUndefined()
    }
  })

  it('uses the registered organization-repair phase and exports only known parse fields', () => {
    const current = { ...job, progress: { ...job.progress!, phase: 'organization_repair' } }
    expect(wikiJobPhase(current)).toBe('organization_repair')
    expect(wikiJobRecovery(current)).toBe('resume')
    const failure = {
      stage: 'organization_repair',
      errorType: 'wiki_json_schema',
      field: '/pages/0/markdown',
    }
    expect(wikiJobDiagnostic({ ...current, errorDetail: JSON.stringify(failure) }).failure).toEqual(
      failure
    )
    expect(
      wikiJobDiagnostic({
        ...current,
        errorDetail: JSON.stringify({ ...failure, privateBody: 'PRIVATE' }),
      }).failure
    ).toBeUndefined()
  })

  it('exports private citation-reference failures without exposing the supplied ref value', () => {
    const failure = {
      stage: 'generation',
      errorType: 'wiki_evidence_ref_not_supplied',
      field: '/pages/0/citations/1/ref',
    }
    expect(wikiJobDiagnostic({ ...job, errorDetail: JSON.stringify(failure) }).failure).toEqual(
      failure
    )
    expect(
      wikiJobDiagnostic({ ...job, errorDetail: JSON.stringify({ ...failure, ref: 'PRIVATE_REF' }) })
        .failure
    ).toBeUndefined()
  })

  it('exports known support-evidence fields without including raw review data', () => {
    const failure = {
      stage: 'support_validation',
      errorType: 'wiki_support_evidence',
      field: '/units/33/citationIndices',
    }
    expect(wikiJobDiagnostic({ ...job, errorDetail: JSON.stringify(failure) }).failure).toEqual(
      failure
    )
    expect(
      wikiJobDiagnostic({
        ...job,
        errorDetail: JSON.stringify({ ...failure, field: '/units/33/privatePayload' }),
      }).failure
    ).toBeUndefined()
    expect(
      wikiJobDiagnostic({
        ...job,
        errorDetail: JSON.stringify({ ...failure, response: 'PRIVATE' }),
      }).failure
    ).toBeUndefined()
  })

  it('shows source support separately from citation repair and permits normal recovery', () => {
    const checking = { ...job, progress: { ...job.progress!, phase: 'source_support' } }
    expect(wikiJobPhase(checking)).toBe('source_support')
    expect(wikiJobRecovery(checking)).toBe('resume')
  })

  it('shows a terminal state even when the last model stage is generation', () => {
    expect(wikiJobPhase(job)).toBe('generation')
    expect(wikiJobPhase({ ...job, status: 'paused' })).toBe('paused')
    expect(wikiJobPhase({ ...job, progress: { ...job.progress!, phase: 'unsafe_input' } })).toBe(
      'unknown'
    )
  })
  it('keeps future status and phase values read-only without inventing running state', () => {
    const future = { ...job, status: 'future_status' }
    expect(wikiJobPhase(future)).toBe('unknown')
    expect(wikiJobRecovery(future)).toBe('unavailable')
    expect(wikiJobDiagnostic(future).status).toBe('future_status')
    expect(wikiJobRecovery({ ...job, progress: { ...job.progress!, phase: 'future_phase' } })).toBe(
      'unavailable'
    )
    expect(wikiJobPhase({ ...job, progress: null })).toBe('running')
  })
  it('offers actions that match persisted failure and review states', () => {
    expect(wikiJobRecovery({ ...job, status: 'failed' })).toBe('retry')
    expect(wikiJobRecovery({ ...job, errorCode: 'configuration_changed' })).toBe('reorganize')
    expect(wikiJobRecovery({ ...job, errorCode: 'budget_exceeded' })).toBe('extend')
    expect(wikiJobRecovery({ ...job, errorCode: 'repair_budget_exceeded' })).toBe('reorganize')
    expect(wikiJobRecovery({ ...job, errorCode: 'source_removed' })).toBe('unavailable')
    expect(wikiJobRecovery({ ...job, status: 'awaiting_review' })).toBe('review')
  })
  it('exports only safe facts, preserving unknown usage and separate heartbeat/model activity', () => {
    const withSecrets = {
      ...job,
      errorDetail: 'PRIVATE RAW RESPONSE',
      originalText: 'PRIVATE SOURCE',
    }
    const diagnostic = wikiJobDiagnostic(withSecrets)
    expect(diagnostic.inputTokens).toBeNull()
    expect(diagnostic.outputTokens).toBeNull()
    expect(diagnostic.heartbeatAtMs).toBe(400)
    expect(diagnostic.modelProgressAtMs).toBe(300)
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE')
  })
  it('exports exact host validation fields alongside the existing public error code', () => {
    const failure = {
      stage: 'citation_repair',
      errorType: 'wiki_evidence_quote_span',
      field: '/pages/2/citations/3/quote',
    }
    const failed = {
      ...job,
      status: 'failed',
      errorCode: 'invalid_evidence',
      errorDetail: JSON.stringify(failure),
    }
    expect(wikiJobDiagnostic(failed)).toMatchObject({ errorCode: 'invalid_evidence', failure })
    expect(wikiJobRecovery(failed)).toBe('retry')
    for (const field of ['sourceId', 'revisionId', 'chunkId']) {
      expect(
        wikiJobDiagnostic({
          ...failed,
          errorDetail: JSON.stringify({
            ...failure,
            stage: 'commit_validation',
            errorType: `wiki_evidence_${field === 'sourceId' ? 'source' : field === 'revisionId' ? 'revision' : 'chunk'}_missing`,
            field: `/pages/0/citations/0/${field}`,
          }),
        }).failure?.field
      ).toBe(`/pages/0/citations/0/${field}`)
    }
    expect(
      wikiJobDiagnostic({
        ...failed,
        errorDetail: JSON.stringify({
          stage: 'candidate_validation',
          errorType: 'wiki_candidate_related_target_missing',
          field: '/pages/0/relatedPageIds/0',
        }),
      }).failure?.field
    ).toBe('/pages/0/relatedPageIds/0')
  })
  it('omits legacy and private values without altering the original job detail', () => {
    const failure = {
      stage: 'citation_repair',
      errorType: 'wiki_evidence_quote_span',
      field: '/pages/0/citations/0/quote',
    }
    for (const errorDetail of [
      'PRIVATE RAW RESPONSE',
      'null',
      '[]',
      '{',
      JSON.stringify(failure).repeat(100),
      JSON.stringify({ ...failure, stage: 'PRIVATE_AUTH' }),
      JSON.stringify({ ...failure, errorType: 'wiki_evidence_PRIVATE_VALUE' }),
      JSON.stringify({ ...failure, field: '/pages/PRIVATE_TITLE/citations/0/quote' }),
      JSON.stringify({ ...failure, field: '/pages/0/citations/0/PRIVATE_QUOTE' }),
      JSON.stringify({ ...failure, field: '/pages/0/citations/0/quote/PRIVATE_VALUE' }),
      JSON.stringify({ ...failure, field: '/pages/0/citations/0/quote\n' }),
      JSON.stringify({ ...failure, field: '/pages/0/citations/-1/quote' }),
      JSON.stringify({ ...failure, field: '/pages/0/citations/0001/quote' }),
      JSON.stringify({ ...failure, cause: 'PRIVATE_CREDENTIAL_PATH' }),
      JSON.stringify({ ...failure, sourceId: 'PRIVATE_SOURCE' }),
    ]) {
      const legacy = { ...job, errorCode: 'invalid_evidence', errorDetail }
      expect(wikiJobDiagnostic(legacy).failure).toBeUndefined()
      expect(JSON.stringify(wikiJobDiagnostic(legacy))).not.toContain('PRIVATE')
      expect(legacy.errorDetail).toBe(errorDetail)
    }
  })
})
