import { AGENT_MESSAGE_CAPABILITIES, projectAgentMessageCapabilities } from './broker-agent-messages.js';
import { DURABLE_DRAFT_CAPABILITY, durableDraftReady } from './broker-durable-attachment-drafts.js';
import { supportsPeerMessages, projectPeerMessageHistory } from './broker-peer-message-compat.js';
import { ROUTER_CAPABILITY, BACKGROUND_REPLY_CAPABILITY, WAKE_READ_CAPABILITY } from './agent-message-router-private.js';
import { SESSION_READ_CAPABILITY } from './agent-message-router-session-read.js';
import { SESSION_ADDRESS_EXPECTATION_CAPABILITY } from '../shared/sessionAddressExpectation.mjs';
import { SHARED_THREADS_CAPABILITY } from './broker-shared-threads.js';
import { ASYNC_QUESTIONS_CAPABILITY, projectAsyncQuestionCapabilities } from './broker-async-questions.js';
import { TASK_EXPERT_CAPABILITY, EXPERT_CREATION_CAPABILITY, TASK_EXPERT_LIGHT_READ_CAPABILITY, projectTaskExpertCapabilities } from './broker-task-expert.js';
import { THREAD_RUNTIME_HANDOFF_CAPABILITY } from '../shared/threadRuntimeHandoff.mjs';
import { WEB_SEARCH_CAPABILITIES } from './broker-web-search.js';
import { projectMigrationHistoryWorkerState } from './broker-migration-history.js';
import { CONTINUOUS_WORK_CAPABILITY, CONTINUOUS_WORK_READ_CAPABILITY, CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY, CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY, CONTINUOUS_WORK_INPUT_CAPABILITY, CONTINUOUS_WORK_CONTROL_CAPABILITY } from './broker-continuous-work.mjs';
import { projectThreadRunSummary, projectThreadTranscriptObservation, projectThreadTranscriptSnapshot } from './broker-thread-summary.js';
import { INTEGRATION_CLIENT_CAPABILITIES, projectIntegrationCapabilities } from './integrations/core/admission.mjs';
import { publicSharedCapabilities } from './broker-native-session-capabilities.js';
import { MIGRATION_SOURCE_INTERNAL_CAPABILITY } from './migration-source-private.js';
import { THREAD_RESIDENCY_CAPABILITY, THREAD_MAINTENANCE_CAPABILITY, THREAD_MAINTENANCE_CANCEL_CAPABILITY, projectThreadResidencyCapabilities, projectThreadResidencyResponse } from './broker-thread-residency.js';

// Initialize negotiation: the backend opt-ins the shared broker always requests,
// per-client frozen choices, and the per-client projection of the cached
// initialize result. Projections read the owning broker and only record the
// client's negotiated peer-message flag.

export const PROTOCOL_VERSION = "2026-07-27";
export const COMPUTER_USE_TURN_STATUS_METHOD = "computerUse/turn/status";
export const COMPUTER_USE_TURN_STATUS_CAPABILITY = "computerUseTurnStatusV1";
export const THREAD_PRESENCE_READ_METHOD = "thread/presence/read";
export const THREAD_PRESENCE_READ_CAPABILITY = "threadPresenceReadV1";
export const INTERACTION_STATUS_READ_METHOD = "interaction/status/read";
export const INTERACTION_STATUS_READ_CAPABILITY = "interactionStatusReadV1";
export const EXTENSIONS_INVENTORY_CAPABILITY = "extensionsInventoryV1";
const PLUGIN_CONFLICT_METHODS = new Set(["plugin/install", "plugin/read"]);
export const CLIENT_EXPERIMENTAL_CHOICES = ["acpInboundV1", EXTENSIONS_INVENTORY_CAPABILITY, "migrationHistoryWorkerStateV1", "toolPathPreviewV1", COMPUTER_USE_TURN_STATUS_CAPABILITY, "computerUseSessionAuthorizationV1",
  "sessionLifetimeV1", "computerUseRecoveryV1", "threadRunSummaryV1", "threadGoalStatusBatchV1", "threadTranscriptSnapshotV1", "threadTranscriptObservationV1", "threadStreamContextV1", THREAD_PRESENCE_READ_CAPABILITY,
  INTERACTION_STATUS_READ_CAPABILITY, THREAD_RUNTIME_HANDOFF_CAPABILITY, ASYNC_QUESTIONS_CAPABILITY, TASK_EXPERT_CAPABILITY, EXPERT_CREATION_CAPABILITY, TASK_EXPERT_LIGHT_READ_CAPABILITY, CONTINUOUS_WORK_CAPABILITY, CONTINUOUS_WORK_READ_CAPABILITY, CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY, CONTINUOUS_WORK_INPUT_CAPABILITY, CONTINUOUS_WORK_CONTROL_CAPABILITY, ...WEB_SEARCH_CAPABILITIES, ...AGENT_MESSAGE_CAPABILITIES, ...INTEGRATION_CLIENT_CAPABILITIES, THREAD_RESIDENCY_CAPABILITY, THREAD_MAINTENANCE_CAPABILITY, THREAD_MAINTENANCE_CANCEL_CAPABILITY];

export function backendInitializeParams(params, nativeManagementOnly) {
  const experimental = publicSharedCapabilities(params?.capabilities?.experimental);
  delete experimental.migrationHistoryWorkerStateClientV1;
  delete experimental[SHARED_THREADS_CAPABILITY];
  return { ...params, capabilities: { ...params?.capabilities, experimental: {
    ...experimental, projectAutomations: true, sessionLifetimeV1: true,
    studioWorkModesV1: true, inlineWidgetsV1: true, isolatedWidgetsV1: true, mcpAppsV1: true,
    // Native binding must not depend on which presentation client connects first.
    interactionBindingV1: true,
    [MIGRATION_SOURCE_INTERNAL_CAPABILITY]: true,
    [ROUTER_CAPABILITY]: true, [BACKGROUND_REPLY_CAPABILITY]: true, [SESSION_READ_CAPABILITY]: true, [WAKE_READ_CAPABILITY]: true,
    [CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY]: true,
    ...Object.fromEntries(CLIENT_EXPERIMENTAL_CHOICES.map(name => [name, true])),
    // Only a dedicated legacy backend opts out of task routing. A control
    // client on the task broker cannot change the original host's capabilities.
    ...(nativeManagementOnly ? { taskSourcesV1: false, [THREAD_RUNTIME_HANDOFF_CAPABILITY]: false } : {}),
  } } };
}
export function finishClientInitialize(client, response) {
  if (!client) return;
  client.initialized = !response.error;
  if (!response.error) Object.assign(client, client.pendingInitializeChoices);
  client.pendingInitializeChoices = null;
}
export function projectClientResponse(message, pending) {
  message = projectThreadResidencyResponse(message, pending);
  message = projectPeerMessageHistory(message, pending.method, supportsPeerMessages(pending.client));
  message = projectMigrationHistoryWorkerState(message, pending.method, pending.client.migrationHistoryWorkerStateV1 === true);
  if (pending.method === "thread/resume" && message.result?.streamContext && pending.client.threadStreamContextV1 !== true) {
    const { streamContext, ...result } = message.result;
    message = { ...message, result };
  }
  // The shared backend always opts in; only clients that declared the
  // capability receive the additive plugin conflict preview.
  if (PLUGIN_CONFLICT_METHODS.has(pending.method) && message.result?.extensionConflicts !== undefined
      && pending.client[EXTENSIONS_INVENTORY_CAPABILITY] !== true) {
    const { extensionConflicts: _conflicts, ...result } = message.result;
    message = { ...message, result };
  }
  message = projectThreadTranscriptObservation(message, pending.method, pending.client.threadTranscriptObservationV1 === true);
  return projectThreadRunSummary(projectThreadTranscriptSnapshot(message, pending.method,
    pending.client.threadTranscriptSnapshotV1 === true), pending.client.threadRunSummaryV1 === true);
}

export function projectInitializeCapabilities(broker, message, client) {
  if (message.error || !message.result?.capabilities) return message;
  let ready = false;
  try {
    ready = broker.retentionParentV1 && message.result.capabilities.experimental?.workspaceOperationReceiptsV2 === true && Boolean(client?.retentionAuthority?.());
  } catch { /* Missing/stale identity is not a capability. */ }
  // The producer descriptor is private until the full lifecycle capability is enabled.
  const { attachmentUploadAdmission: _privateUploadAdmission, ...publicResult } = message.result;
  const experimental = { ...publicSharedCapabilities(message.result.capabilities.experimental), workspaceOperationReceiptsV2: ready,
    stagedAttachmentRetentionReceiptsV1: false };
  experimental[DURABLE_DRAFT_CAPABILITY] = durableDraftReady(broker, message);
  const routerReady = broker.supportsAgentMessageRouter(message);
  experimental[SESSION_ADDRESS_EXPECTATION_CAPABILITY] = routerReady;
  Object.assign(experimental, projectAgentMessageCapabilities(experimental, client));
  if (typeof client?.routeAgentMessage === 'function' && !routerReady)
    for (const capability of AGENT_MESSAGE_CAPABILITIES) if (Object.hasOwn(experimental, capability)) experimental[capability] = false;
  delete experimental[ROUTER_CAPABILITY];
  delete experimental[WAKE_READ_CAPABILITY];
  // A router feature fact between Gateway and Native; clients never call it.
  delete experimental[SESSION_READ_CAPABILITY];
  if (client) client.peerAgentMessagesNegotiatedV1 = experimental.peerAgentMessagesV1 === true;
  delete experimental[SHARED_THREADS_CAPABILITY];
  if (broker.shareability === "resident" && client?.[SHARED_THREADS_CAPABILITY] === true) experimental[SHARED_THREADS_CAPABILITY] = true;
  if (broker.targetTransport !== 'local') {
    for (const capability of ['computerUseTurnV1', 'computerUseStatusV1', 'computerUseRecoveryV1', 'computerUseSessionAuthorizationV1']) {
      if (Object.hasOwn(experimental, capability)) experimental[capability] = false;
    }
  }
  if (Object.hasOwn(message.result.capabilities.experimental ?? {}, COMPUTER_USE_TURN_STATUS_CAPABILITY)) {
    experimental[COMPUTER_USE_TURN_STATUS_CAPABILITY] = broker.targetTransport === 'local' &&
      client?.[COMPUTER_USE_TURN_STATUS_CAPABILITY] === true &&
      message.result.capabilities.experimental[COMPUTER_USE_TURN_STATUS_CAPABILITY] === true;
  }
  if (Object.hasOwn(message.result.capabilities.experimental ?? {}, "acpInboundV1")) {
    experimental.acpInboundV1 = client?.acpInboundV1 === true && message.result.capabilities.experimental.acpInboundV1 === true;
  }
  if (Object.hasOwn(message.result.capabilities.experimental ?? {}, "migrationHistoryWorkerStateV1")) {
    experimental.migrationHistoryWorkerStateV1 = client?.migrationHistoryWorkerStateV1 === true &&
      message.result.capabilities.experimental.migrationHistoryWorkerStateV1 === true;
  }
  if (Object.hasOwn(message.result.capabilities.experimental ?? {}, THREAD_PRESENCE_READ_CAPABILITY)) {
    experimental[THREAD_PRESENCE_READ_CAPABILITY] = client?.threadPresenceReadV1 === true &&
      message.result.capabilities.experimental[THREAD_PRESENCE_READ_CAPABILITY] === true;
  }
  if (Object.hasOwn(experimental, THREAD_RUNTIME_HANDOFF_CAPABILITY)) {
    experimental[THREAD_RUNTIME_HANDOFF_CAPABILITY] = client?.[THREAD_RUNTIME_HANDOFF_CAPABILITY] === true
      && experimental[THREAD_RUNTIME_HANDOFF_CAPABILITY] === true;
  }
  if (Object.hasOwn(message.result.capabilities.experimental ?? {}, INTERACTION_STATUS_READ_CAPABILITY)) {
    experimental[INTERACTION_STATUS_READ_CAPABILITY] = client?.[INTERACTION_STATUS_READ_CAPABILITY] === true &&
      message.result.capabilities.experimental[INTERACTION_STATUS_READ_CAPABILITY] === true;
  }
  projectThreadResidencyCapabilities(experimental, message.result.capabilities.experimental, client);
  if (Object.hasOwn(message.result.capabilities.experimental ?? {}, "threadTranscriptObservationV1")) {
    experimental.threadTranscriptObservationV1 = client?.threadTranscriptObservationV1 === true &&
      message.result.capabilities.experimental.threadTranscriptObservationV1 === true;
  }
  return { ...message, result: { ...publicResult, capabilities: { ...message.result.capabilities,
    experimental: broker.webSearchDiagnostics.capabilities(projectIntegrationCapabilities(
      broker.continuousWork.projectCapabilities(projectTaskExpertCapabilities(projectAsyncQuestionCapabilities(experimental, client), client), client), client), client),
  } } };
}
