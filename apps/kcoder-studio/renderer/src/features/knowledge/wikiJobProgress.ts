import { readModelConfiguration } from '../../../../shared/modelConfiguration'
import type { WikiJob } from '@/kcoder/knowledgeApi'
import { readableWikiPipeline } from './wikiPipeline'
import { wikiPipelineStages, type WikiPipelineStageRecord } from '@/types/wikiPipeline'

import { knownValues, type WikiJobProgress } from '../../../../shared/generated/contracts'
export type { WikiJobProgress } from '../../../../shared/generated/contracts'

export type WikiObservedJob = WikiJob & {
  recipeKey?: string
  progress?: WikiJobProgress | null
  errorDetail?: unknown
}
const phases = new Set(knownValues.WikiJobPhase)
const statuses = new Set(knownValues.WikiJobStatus)
export function wikiJobPhase(job: WikiObservedJob) {
  if (!statuses.has(job.status)) return 'unknown'
  if (job.pipeline && !readableWikiPipeline(job)) return 'unknown'
  if (job.status === 'awaiting_review' && job.reviewAvailable === false) return 'failed'
  if (job.status !== 'running') return job.status
  const stage = readableWikiPipeline(job)?.currentStage
  if (stage)
    return {
      extract: 'running',
      analyze: 'analysis',
      retrieve: 'running',
      generate: 'generation',
      verify: 'source_support',
      coverage: 'organization_repair',
      commit: 'commit',
    }[stage]
  if (!job.progress) return 'running'
  return phases.has(job.progress.phase) ? job.progress.phase : 'unknown'
}
export function wikiJobRecovery(job: WikiObservedJob) {
  if (wikiJobPhase(job) === 'unknown') return 'unavailable'
  if (job.status === 'awaiting_review') return job.reviewAvailable === false ? 'retry' : 'review'
  if (['configuration_changed', 'repair_budget_exceeded'].includes(job.errorCode ?? ''))
    return 'reorganize'
  if (job.errorCode === 'budget_exceeded') return 'extend'
  if (
    ['source_removed', 'source_updated', 'source_revision_changed', 'library_archived'].includes(
      job.errorCode ?? ''
    )
  )
    return 'unavailable'
  if (job.status === 'failed') return 'retry'
  return 'resume'
}
export function wikiJobResumeStage(job: WikiObservedJob) {
  if (!['resume', 'retry'].includes(wikiJobRecovery(job))) return undefined
  return readableWikiPipeline(job)?.resumeStage ?? undefined
}
// These exact host categories mirror the domain validator. Unknown/legacy
// details remain on the job but cannot enter the exported diagnostic.
const validationStages = new Set([
  'analysis',
  'generation',
  'format_repair',
  'truncation_retry',
  'analysis_validation',
  'candidate_validation',
  'citation_repair',
  'commit_validation',
  'support_validation',
  'source_support',
  'organization_repair',
  'organization_validation',
])
const validationCodes = new Set([
  'wiki_json_schema',
  'wiki_json_syntax',
  'wiki_json_eof',
  'wiki_json_io',
  'wiki_json_type',
  'wiki_analysis_query_bounds',
  'wiki_analysis_summary_bounds',
  'wiki_analysis_conflict_bounds',
  'wiki_candidate_page_count',
  'wiki_candidate_review_bounds',
  'wiki_candidate_new_topic_count',
  'wiki_candidate_duplicate_identity',
  'wiki_candidate_page_bounds',
  'wiki_candidate_title',
  'wiki_candidate_new_page_output_bounds',
  'wiki_candidate_empty_markdown',
  'wiki_candidate_unreserved_overview',
  'wiki_candidate_base_revision',
  'wiki_candidate_existing_citations_removed',
  'wiki_candidate_unallocated_page_id',
  'wiki_candidate_self_reference',
  'wiki_candidate_related_target_missing',
  'wiki_candidate_relations_bounds',
  'wiki_evidence_citations_bounds',
  'wiki_evidence_reference_missing',
  'wiki_evidence_source_not_supplied',
  'wiki_evidence_revision_not_supplied',
  'wiki_evidence_chunk_not_supplied',
  'wiki_evidence_source_missing',
  'wiki_evidence_revision_missing',
  'wiki_evidence_chunk_missing',
  'wiki_evidence_quote_bounds',
  'wiki_evidence_quote_span',
  'wiki_evidence_ref_not_supplied',
  'wiki_evidence_ref_conflict',
  'wiki_evidence_ref_expansion_bounds',
  'wiki_support_coverage',
  'wiki_support_evidence',
  'wiki_support_evidence_missing',
  'wiki_support_evidence_out_of_range',
  'wiki_support_evidence_too_many',
  'wiki_support_schema',
  'wiki_support_review_bounds',
  'wiki_support_cache_mismatch',
  'wiki_organization_aspect_identity',
  'wiki_organization_aspect_units',
  'wiki_organization_binding',
  'wiki_organization_body_changed',
  'wiki_organization_disposition',
  'wiki_organization_disposition_reason',
  'wiki_organization_draft_content_removed',
  'wiki_organization_draft_removed',
  'wiki_organization_duplicate_placement',
  'wiki_organization_empty_target',
  'wiki_organization_inventory_capacity',
  'wiki_organization_line_mode',
  'wiki_organization_page_kind',
  'wiki_organization_page_target',
  'wiki_organization_plan_coverage',
  'wiki_organization_plan_repair_schema',
  'wiki_organization_proof_repair_schema',
  'wiki_organization_proof_bounds',
  'wiki_organization_ref_not_cited',
  'wiki_organization_ref_not_supplied',
  'wiki_organization_ref_scope',
  'wiki_organization_required_aspect',
  'wiki_organization_target_lines',
  'wiki_organization_unit_identity',
])
const index = '(?:0|[1-9][0-9]{0,6})'
const citationField = `citations(?:/${index}(?:/(?:sourceId|revisionId|chunkId|quote|ref))?)?`
const pageField = `(?:pageId|expectedRevision|kind|title|markdown|${citationField}|relatedPageIds(?:/${index})?)`
const organizationBinding =
  '(?:libraryId|sourceId|sourceRevision|purposeHash|inventoryHash|afterChunk|throughChunk)'
const organizationPlanField = `organizationPlan(?:/(?:binding(?:/${organizationBinding})?|aspects(?:/${index}(?:/(?:aspectId|unitIds(?:/${index})?))?)?|units(?:/${index}(?:/(?:unitId|disposition|purposeAspectIds(?:/${index})?|reason))?)?))?`
const organizationProofField = `organizationProof(?:/(?:binding(?:/${organizationBinding})?|placements(?:/${index}(?:/(?:unitId|pageId|firstLine|lastLine|allLines|citationRefs(?:/${index})?))?)?|hostBodyHashes))?`
const validationField = new RegExp(
  `^(?:/|/(?:summary|queries(?:/${index})?|conflicts(?:/${index})?|reviewNotes(?:/${index})?|pages(?:/${index}(?:/${pageField})?)?|units(?:/${index}(?:/(?:pageId|unit|verdict|citationIndices(?:/${index})?))?)?|sourceCoverage|${organizationPlanField}|${organizationProofField}))$`
)
function safeValidationFailure(detail: unknown) {
  if (typeof detail !== 'string' || detail.length > 1024) return undefined
  try {
    const value: unknown = JSON.parse(detail)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const object = value as Record<string, unknown>
    if (Object.keys(object).length !== 3) return undefined
    const { stage, errorType, field } = object
    if (
      typeof stage !== 'string' ||
      !validationStages.has(stage) ||
      typeof errorType !== 'string' ||
      !validationCodes.has(errorType) ||
      typeof field !== 'string' ||
      validationField.exec(field)?.[0] !== field
    )
      return undefined
    return { stage, errorType, field }
  } catch {
    return undefined
  }
}
/** Stage records carry a public validation pointer, never a provider response body. */
export function safeWikiPipelineFailure(record: WikiPipelineStageRecord) {
  const legacy = safeValidationFailure(record.errorDetail)
  if (legacy) return legacy
  if (
    !wikiPipelineStages.some(stage => stage === record.stage) ||
    !record.errorCode ||
    !validationCodes.has(record.errorCode) ||
    typeof record.errorDetail !== 'string' ||
    validationField.exec(record.errorDetail)?.[0] !== record.errorDetail
  )
    return undefined
  return { stage: record.stage, errorType: record.errorCode, field: record.errorDetail }
}
/** Explicit host facts only. Never export provider error text, source or response. */
export function wikiJobDiagnostic(job: WikiObservedJob) {
  const progress = job.progress
  const failure = safeValidationFailure(job.errorDetail)
  return {
    version: 1,
    jobId: job.id,
    recipe: job.recipeKey,
    sourceId: job.sourceId,
    status: job.status,
    phase: wikiJobPhase(job),
    errorCode: job.errorCode,
    ...(failure ? { failure } : {}),
    completedChunks: job.afterChunk,
    suggestedAction: wikiJobRecovery(job),
    ...(readableWikiPipeline(job)
      ? {
          pipeline: {
            version: job.pipeline!.version,
            batch: job.pipeline!.batch,
            sourceRevision: job.pipeline!.sourceRevision,
            currentStage: job.pipeline!.currentStage,
            records: job.pipeline!.records.map(record => ({
              stage: record.stage,
              status: record.status,
              batch: record.batch,
              attempt: record.attempt,
              reused: record.reused,
              unitIndex: record.unitIndex,
              completedUnits: record.completedUnits,
              totalUnits: record.totalUnits,
              startedAtMs: record.startedAtMs,
              completedAtMs: record.completedAtMs,
              updatedAtMs: record.updatedAtMs,
              errorCode: record.errorCode,
              ...(safeWikiPipelineFailure(record)
                ? { failure: safeWikiPipelineFailure(record) }
                : {}),
            })),
          },
        }
      : {}),
    ...(progress
      ? {
          model: progress.model,
          reasoningEffort: progress.reasoningEffort,
          modelConfiguration: readModelConfiguration(progress.modelConfiguration),
          startedAtMs: progress.startedAtMs,
          phaseStartedAtMs: progress.phaseStartedAtMs,
          heartbeatAtMs: progress.heartbeatAtMs,
          modelProgressAtMs: progress.modelProgressAtMs,
          textBytes: progress.textBytes,
          reasoningBytes: progress.reasoningBytes,
          throughChunk: progress.throughChunk,
          totalChunks: progress.totalChunks,
          callLimit: progress.callLimit ?? null,
          requestedOutputTokens: progress.requestedOutputTokens ?? null,
          estimatedInputTokens: progress.estimatedInputTokens ?? null,
          reservedCalls: progress.reservedCalls,
          repairCalls: progress.repairCalls,
          usageReportedCalls: progress.usageReportedCalls,
          inputTokens: progress.inputTokens ?? null,
          outputTokens: progress.outputTokens ?? null,
        }
      : {}),
  }
}
