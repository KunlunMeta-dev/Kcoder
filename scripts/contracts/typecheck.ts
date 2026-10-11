// Compile-time compatibility checks for the generated wire contracts.
import {
  isTaskStatus,
  isTurnAttemptStatus,
  isMcpConnectionAttempt,
  type TaskStatus,
  type TurnAttemptStatus,
  type McpFailureReason,
  type McpFailureReasonErrorCode,
  type McpConnectionAttempt,
  type McpServerSummary,
  type WikiPipelineProgress,
  type WikiPipelineStageRecord,
} from '../../apps/kcoder-studio/shared/generated/contracts'

const future: TaskStatus = 'future_review'
const unicode: TaskStatus = '汉'.repeat(85) + 'a'
const futureAttempt: TurnAttemptStatus = 'waiting_for_remote_cleanup'
const reason: McpFailureReason = 'protocolFailed'
const code: McpFailureReasonErrorCode = 'mcp_protocol_failed'
const legacyAttempt: McpConnectionAttempt = { status: 'unavailable' }
const currentAttempt: McpConnectionAttempt = { status: 'unavailable', failureReason: reason }
const legacyServer: McpServerSummary = { name: 'fixture', transport: 'stdio', authorization: 'notApplicable' }
// @ts-expect-error Wire reasons use actual serde camelCase labels.
const invalidReason: McpFailureReason = 'mcp_protocol_failed'
// @ts-expect-error Public error codes form a finite generated label union.
const invalidCode: McpFailureReasonErrorCode = 'arbitrary_provider_error_text'
// @ts-expect-error Future statuses remain strings, never arbitrary JSON scalars.
const invalidStatus: TaskStatus = 3
// @ts-expect-error Attempt facts also retain only raw strings.
const invalidAttemptStatus: TurnAttemptStatus = false

void [future, unicode, reason, code, legacyAttempt, currentAttempt, legacyServer, invalidReason, invalidCode, invalidStatus]
void [isTaskStatus(future), isTurnAttemptStatus(futureAttempt), invalidAttemptStatus, isMcpConnectionAttempt(legacyAttempt)]


// Stage addresses are flattened in actual Rust records; optional counters and
// nullable recovery addresses keep their serde wire semantics.
const plannedRecord: WikiPipelineStageRecord = {
  batch: 8,
  sourceRevision: 'source-v1',
  stageKey: 'page-draft',
  stage: 'generate',
  unitKey: 'topic-1',
  status: 'running',
  attempt: 1,
  reused: false,
  updatedAtMs: 1000,
  unitIndex: 0,
  completedUnits: 1,
  totalUnits: 2,
}
const pipeline: WikiPipelineProgress = {
  version: 1,
  batch: 8,
  sourceRevision: 'source-v1',
  currentStage: 'generate',
  resumeStage: null,
  records: [plannedRecord],
}
// @ts-expect-error Pipeline stages follow the actual Rust enum, not arbitrary strings.
const invalidPipelineStage: WikiPipelineStageRecord['stage'] = 'future'
// @ts-expect-error A flattened stage record has no nested address property.
const invalidNestedAddress: WikiPipelineStageRecord['address'] = {}
void [pipeline, invalidPipelineStage, invalidNestedAddress]
