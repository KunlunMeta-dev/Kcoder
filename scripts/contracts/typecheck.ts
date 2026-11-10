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
  type WorkflowCollaborationPlan,
  type TaskWorkspaceSnapshot,
  type IntegrationTaskCapabilityScopeSnapshot,
  type AgentStreamSubscribeParams,
  type AgentStreamClosedParams,
  type ContinuousWorkInputSubmitParams,
  type ContinuousWorkControlParams,
  type ContinuousWorkControlResult,
  type ContinuousWorkView,
} from '../../apps/kcoder-studio/shared/generated/contracts'
import type { WorkflowCollaborationPlan as LegacyCorePlan } from '../../apps/kcoder-studio/shared/generated/contracts.core.js'
import type { AgentStreamSubscribeParams as LegacyCoreObserver } from '../../apps/kcoder-studio/shared/generated/contracts.core.js'
import type {
  TaskWorkspaceSnapshot as LegacyTaskSnapshot,
  IntegrationTaskCapabilityScopeSnapshot as LegacyTaskCapabilityScope,
} from '../../apps/kcoder-studio/shared/generated/contracts.integrations-core.js'

// Domain extraction preserves the established public type import paths.
const preserveWorkflowImport = (value: WorkflowCollaborationPlan): LegacyCorePlan => value
const preserveTaskImport = (value: TaskWorkspaceSnapshot): LegacyTaskSnapshot => value
const preserveSourceImport = (value: IntegrationTaskCapabilityScopeSnapshot): LegacyTaskCapabilityScope => value
void [preserveWorkflowImport, preserveTaskImport, preserveSourceImport]

const preserveAgentImport = (value: AgentStreamSubscribeParams): LegacyCoreObserver => value
const oldObserver: AgentStreamSubscribeParams = { threadId: 'parent', agentId: 'child', subscriptionId: 'observer' }
const originalRun = { parentSessionId: 'parent', agentId: 'child', runId: 'run' }
const exactObserver: AgentStreamSubscribeParams = { ...oldObserver, expectedBackgroundRun: originalRun }
const closedObserver: AgentStreamClosedParams = { ...exactObserver, expectedBackgroundRun: originalRun, reasonCode: 'run_changed' }
// @ts-expect-error The close reason reports observer loss, not worker completion.
const wrongCloseReason: AgentStreamClosedParams['reasonCode'] = 'completed'
void [preserveAgentImport, oldObserver, exactObserver, closedObserver, wrongCloseReason]

// Draft continuous work contracts expose no caller-selected authority and keep
// the original attempt when targeting one run. Status labels remain readable.
const workInput: ContinuousWorkInputSubmitParams = {
  threadId: 'thread', workId: 'work', inputId: 'input', requestId: 'request',
  expectedRevision: 1, text: 'Continue the task',
}
const workControl: ContinuousWorkControlParams = {
  threadId: 'thread', workId: 'work', requestId: 'control', expectedRevision: 2,
  action: 'cancel_run', target: { kind: 'turn', threadId: 'thread', turnId: 'turn', attemptId: 'attempt' },
}
const futureWork: ContinuousWorkView = {
  threadId: 'thread', workId: 'work', phase: 'future_phase', freshness: 'unknown',
  revision: 1, requirementsRevision: 1,
}
const futureTarget: ContinuousWorkControlResult = {
  workId: 'work', requestId: 'control', action: 'future_action', state: 'unknown',
  revision: 3, controlEpoch: 2, target: { kind: 'future_target', opaque: { revision: 1 } },
}
// @ts-expect-error An original turn target includes its exact attempt ID.
const incompleteWorkTarget: ContinuousWorkControlParams['target'] = { kind: 'turn', threadId: 'thread', turnId: 'turn' }
// @ts-expect-error A client cannot grant itself a different target or account.
const forgedWorkInput: ContinuousWorkInputSubmitParams = { ...workInput, targetId: 'other-host' }
// @ts-expect-error A readable future target still requires its original kind.
const missingTargetKind: ContinuousWorkControlResult['target'] = { opaque: true }
void [workInput, workControl, futureWork, futureTarget, incompleteWorkTarget, forgedWorkInput, missingTargetKind]

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
