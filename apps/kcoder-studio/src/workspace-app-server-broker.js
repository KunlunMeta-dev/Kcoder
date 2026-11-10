import { BrokerSessionAttachments } from './broker-session-attachments.js';
import { BrokerSharedThreads, SHARED_THREADS_CAPABILITY, SHARED_RESUME } from './broker-shared-threads.js';
import { ASYNC_QUESTIONS_CAPABILITY, ASYNC_QUESTION_METHODS, asyncQuestionAdmissionError, projectAsyncQuestionRequest,
  projectAsyncQuestionCapabilities, allowsAsyncQuestionNotification, projectAsyncQuestionResponse } from './broker-async-questions.js';
import { TASK_EXPERT_CAPABILITY, EXPERT_CREATION_CAPABILITY, taskExpertAdmissionError, projectTaskExpertCapabilities } from './broker-task-expert.js';
import { assertThreadRuntimeHandoffAdmission, projectThreadRuntimeHandoffResponse } from './broker-thread-runtime-handoff.js';
import { THREAD_RUNTIME_HANDOFF_CAPABILITY, THREAD_RUNTIME_HANDOFF_READ, THREAD_RUNTIME_HANDOFF_RELEASE, confirmsReleasedThreadRuntime } from '../shared/threadRuntimeHandoff.mjs';
import { BrokerSharedInteractions, hasConflictingTurnIdentity } from './broker-shared-interactions.js';
import { BrokerWebSearchDiagnostics, SearchDiagnosticOwnerError, WEB_SEARCH_CAPABILITIES } from './broker-web-search.js';
import { acceptedOfficeTask, isOfficeTaskAdoption, BrokerOfficeTaskOwnerHandoff } from './broker-office-task-owner.js';
import { isNativeRemoteHostMethod, isNativeRemoteHostRequestId } from "./remotes/host-backchannel.mjs";
import { projectMigrationHistoryWorkerState } from "./broker-migration-history.js";
import { BrokerStudioPresentation } from "./broker-studio-presentation.js";
import { BrokerContinuousWork, CONTINUOUS_WORK_CAPABILITY, CONTINUOUS_WORK_READ_CAPABILITY, CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY, CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY, CONTINUOUS_WORK_INPUT_CAPABILITY, CONTINUOUS_WORK_CONTROL_CAPABILITY } from "./broker-continuous-work.mjs";
import { PRIVATE_RETENTION_FIELD, RETENTION_METHODS, WORKSPACE_RECEIPT_METHODS_V2, RetentionAuthorityError, hasRawReservedRetentionFields, hasRawDuplicateRetentionFields, hasReservedRetentionFields, injectRetentionAuthority, injectWorkspaceReceiptAuthority, isRetainedTurn, injectRetainedTurnAuthority } from "./retention-context.js";
import { GATEWAY_EXPIRED_REQUEST_DATA } from '../shared/gatewayRequestDeadline.js';
import { BrokerMcpOAuth, MCP_OAUTH_RECEIVER, MCP_OAUTH_COMPLETION } from "./broker-mcp-oauth.js";
import { BoundedJsonlDecoder } from "./bounded-jsonl-decoder.js";
import { inspectGatewayChannelMessage } from "./gateway-channel.js";
import { isTargetWorkspaceAbsolute } from './remotes/target-workspace-path.mjs';
import { BrokerLifecycleMetrics } from "./broker-lifecycle-metrics.js";
import { BrokerIdleShutdown } from "./broker-idle-shutdown.js";
import { BrokerHistoryRefresh, HISTORY_REFRESH_METHOD, HistoryRefreshRequestError } from "./broker-history-refresh.js";
import { BrokerMigrationViewLeases, MIGRATION_VIEW_CREATIONS, MigrationViewOwnerError } from './broker-migration-view-leases.js';
import { BrokerRequestBudget, compactRequestParams } from "./broker-request-budget.js";
import { RequestLoadTracker } from "./request-load.js";
import { projectThreadRunSummary, projectThreadTranscriptObservation, projectThreadTranscriptSnapshot } from "./broker-thread-summary.js";
import { BrokerResumeNotificationBuffer, makeResumeNotificationHandoffIncompleteResponse } from "./broker-resume-notification-buffer.js";
import { isContract } from "../shared/generated/validator.mjs";
import { INTEGRATION_CLIENT_CAPABILITIES, IntegrationAdmissionError, assertIntegrationAdmission, projectIntegrationCapabilities, projectTaskStateNotification } from './integrations/core/admission.mjs';
import { publicSharedCapabilities, requestsDedicatedCapabilities, suppliesTemporaryThreadMcp, requestsNativeManagement, nativeManagementMethodAllowed } from './broker-native-session-capabilities.js';
import { MIGRATION_SOURCE_INTERNAL_PREFIX, MIGRATION_SOURCE_INTERNAL_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY, MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY, MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY, MIGRATION_SOURCE_ATTEMPT_CAPABILITY, MIGRATION_SOURCE_ADOPTION_CAPABILITY, MigrationSourceBridgeError, hasPrivateMigrationSourceField, migrationSourcePrivateFrame } from './migration-source-private.js';

const PROTOCOL_VERSION = "2026-07-27";
const THREAD_PRESENCE_READ_METHOD = "thread/presence/read";
const THREAD_PRESENCE_READ_CAPABILITY = "threadPresenceReadV1";
const INTERACTION_STATUS_READ_METHOD = "interaction/status/read";
const INTERACTION_STATUS_READ_CAPABILITY = "interactionStatusReadV1";
const TASK_COMPARISON_METHODS = new Set([
  "runtime.worktrees.comparison.bind", "runtime.worktrees.comparison.read", "runtime.worktrees.comparison.select",
]);
const CLIENT_EXPERIMENTAL_CHOICES = ["acpInboundV1", "migrationHistoryWorkerStateV1", "toolPathPreviewV1", "computerUseSessionAuthorizationV1",
  "sessionLifetimeV1", "computerUseRecoveryV1", "threadRunSummaryV1", "threadGoalStatusBatchV1", "threadTranscriptSnapshotV1", "threadTranscriptObservationV1", "threadStreamContextV1", THREAD_PRESENCE_READ_CAPABILITY,
  INTERACTION_STATUS_READ_CAPABILITY, THREAD_RUNTIME_HANDOFF_CAPABILITY, ASYNC_QUESTIONS_CAPABILITY, TASK_EXPERT_CAPABILITY, EXPERT_CREATION_CAPABILITY, CONTINUOUS_WORK_CAPABILITY, CONTINUOUS_WORK_READ_CAPABILITY, CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY, CONTINUOUS_WORK_INPUT_CAPABILITY, CONTINUOUS_WORK_CONTROL_CAPABILITY, ...WEB_SEARCH_CAPABILITIES, ...INTEGRATION_CLIENT_CAPABILITIES];
function backendInitializeParams(params, nativeManagementOnly) {
  const experimental = publicSharedCapabilities(params?.capabilities?.experimental);
  delete experimental.migrationHistoryWorkerStateClientV1;
  delete experimental[SHARED_THREADS_CAPABILITY];
  return { ...params, capabilities: { ...params?.capabilities, experimental: {
    ...experimental, projectAutomations: true, sessionLifetimeV1: true,
    studioWorkModesV1: true, inlineWidgetsV1: true, isolatedWidgetsV1: true, mcpAppsV1: true,
    // Native binding must not depend on which presentation client connects first.
    interactionBindingV1: true,
    [MIGRATION_SOURCE_INTERNAL_CAPABILITY]: true,
    [CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY]: true,
    ...Object.fromEntries(CLIENT_EXPERIMENTAL_CHOICES.map(name => [name, true])),
    // Only a dedicated legacy backend opts out of task routing. A control
    // client on the task broker cannot change the original host's capabilities.
    ...(nativeManagementOnly ? { taskSourcesV1: false, [THREAD_RUNTIME_HANDOFF_CAPABILITY]: false } : {}),
  } } };
}
function finishClientInitialize(client, response) {
  if (!client) return;
  client.initialized = !response.error;
  if (!response.error) Object.assign(client, client.pendingInitializeChoices);
  client.pendingInitializeChoices = null;
}
function projectClientResponse(message, pending) {
  message = projectMigrationHistoryWorkerState(message, pending.method, pending.client.migrationHistoryWorkerStateV1 === true);
  if (pending.method === "thread/resume" && message.result?.streamContext && pending.client.threadStreamContextV1 !== true) {
    const { streamContext, ...result } = message.result;
    message = { ...message, result };
  }
  message = projectThreadTranscriptObservation(message, pending.method, pending.client.threadTranscriptObservationV1 === true);
  return projectThreadRunSummary(projectThreadTranscriptSnapshot(message, pending.method,
    pending.client.threadTranscriptSnapshotV1 === true), pending.client.threadRunSummaryV1 === true);
}

function threadIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  if (TASK_COMPARISON_METHODS.has(message?.method)) {
    // Comparison threadId identifies candidate B; only ownerThreadId names the requesting runtime A.
    const owner = params.ownerThreadId;
    return typeof owner === "string" && owner.length > 0 && owner.length <= 512 && !/[\x00-\x1f\x7f]/.test(owner)
      ? owner : null;
  }
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.thread_id === "string"
      ? params.thread_id
      : typeof params.thread?.threadId === "string"
        ? params.thread.threadId
        : typeof params.thread?.id === "string"
          ? params.thread.id
          : typeof params.widget?.threadId === "string"
            ? params.widget.threadId
          : null;
}

function turnIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  return typeof params.turnId === "string"
    ? params.turnId
    : typeof params.turn_id === "string"
      ? params.turn_id
      : typeof params.turn?.turnId === "string"
        ? params.turn.turnId
        : typeof params.turn?.id === "string"
          ? params.turn.id
          : null;
}

function cloneWithId(message, id) {
  return { ...message, id };
}

function terminalSessionIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  const sessionId =
    params.session_id ?? params.terminalId ?? params.terminal?.id;
  return typeof sessionId === "string" ? sessionId : null;
}

function attachmentPathsFromTurn(request) {
  const open = '<kcoder_attachments version="1">\n';
  const close = "\n</kcoder_attachments>";
  const paths = [];
  // Match Rust prompt_from_params exactly: explicit prompt wins; otherwise join
  // direct input.text entries and trim Unicode White_Space (not JavaScript BOM).
  const params = request.params ?? {};
  const prompt = typeof params.prompt === "string" ? params.prompt
    : (Array.isArray(params.input) ? params.input : [])
      .map(item => item?.text).filter(value => typeof value === "string")
      .join("\n").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const openIndex = prompt.lastIndexOf(open);
  if (openIndex < 0 || !prompt.endsWith(close)) return paths;
  const bodyStart = openIndex + open.length;
  const bodyEnd = prompt.length - close.length;
  for (const line of prompt.slice(bodyStart, bodyEnd).split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.path === "string") paths.push(record.path);
    } catch {
      // App-server owns the canonical validation error for malformed envelopes.
    }
  }
  return paths;
}

const STAGED_INPUT_METHODS = new Set([
  "workspace/file/importAttachment",
  "knowledge/attachment/digest",
  "knowledge/source/importAttachment", "knowledge/importArchive",
  "knowledge/markdown/import", "knowledge/export/read",
]);
const WIKI_ARTIFACT_METHODS = new Set(["knowledge/export", "knowledge/markdown/export", "knowledge/source/original/export"]);
const WIKI_ARCHIVE_START_METHODS = new Set(["knowledge/archiveTransfer/exportStart", "knowledge/archiveTransfer/importStart"]);
const WIKI_ARCHIVE_OWNED_METHODS = new Set(["knowledge/archiveTransfer/status", "knowledge/archiveTransfer/read",
  "knowledge/archiveTransfer/chunk", "knowledge/archiveTransfer/importFinish", "knowledge/archiveTransfer/cancel"]);


const LATE_CREATION_METHODS = new Set([
  ...MIGRATION_VIEW_CREATIONS,
  ...WIKI_ARTIFACT_METHODS,
  ...WIKI_ARCHIVE_START_METHODS,
  "knowledge/source/directoryStage",
  "mcp/login",
  "thread/start",
  "thread/fork",
  "terminal/start",
  "browser/start",
  "attachment/save",
  "attachment/upload/start",
  "attachment/upload/finish",
]);

const CLIENT_NOTIFICATION_METHODS = new Set(["initialized"]);
const THREAD_READONLY_METHODS = new Set([
  "asyncQuestion/list",
  "session/modes",
  "thread/read",
  "turn/receipt/read",
  "thread/creation/read",
  "thread/read/indexed",
  "thread/goal/get",
  "thread/goal/history",
  THREAD_PRESENCE_READ_METHOD,
  THREAD_RUNTIME_HANDOFF_READ,
  INTERACTION_STATUS_READ_METHOD,
  "attachment/read",
  "attachment/read/chunk",
]);
const THREAD_DRAIN_TIMEOUT_MS = 15_000;
const INTERNAL_REQUEST_TIMEOUT_MS = 30_000;

// The app-server reserves -32041 for a stale transcript cursor, and clients
// answer it by rebuilding their transcript projection. Resource failures that
// are not about the transcript must therefore carry their own codes.
const RESOURCE_OWNERSHIP_CONFLICT = -32048;
const RESOURCE_NOT_READY = -32049;
const THREAD_RESUME_CLAIM = Symbol("thread-resume-claim");

function threadClaimOwner(claim) {
  return claim?.[THREAD_RESUME_CLAIM] === true ? claim.client : claim;
}

/**
 * Multiplex several gateway WebSockets over one workspace app-server stdio connection.
 *
 * The broker handles wire-protocol multiplexing only. The gateway host still owns
 * process creation, termination, and idle grace.
 */
export class WorkspaceAppServerBroker {
  #lifecycleMetrics;
  #requestLoad = new RequestLoadTracker();
  #onLifecycleMetrics;
  #pendingBudget;
  #resumeNotificationBuffer = new BrokerResumeNotificationBuffer();
  sessionAttachments = new BrokerSessionAttachments(this);
  #resumePreappliedNotifications = new WeakSet();
  #officeTaskOwnerHandoff = new BrokerOfficeTaskOwnerHandoff();
  #nativeRemoteHostBackchannel;
  #internalRequestOwner = { channel: "other" };
  #lifecycleRequestOwner = { channel: "other" };

  constructor({
    child,
    adapter,
    maxMessageBytes,
    serverId,
    targetTransport,
    remotePlatform,
    onClose,
    onRestart,
    onIdleStateChange,
    onWorkspaceRemoved,
    onReleaseWorkspace,
    residentThreads,
    monotonicNow,
    onLifecycleMetrics,
    retentionParentV1 = false,
    migrationSourceParentV1 = false,
    retentionRevocationTrusted = false,
    registerRetentionRoute,
    pendingBudget,
    nativeRemoteHostBackchannel,
    nativeManagementOnly = false,
    ownsChannelHost = false,
  }) {
    this.nativeManagementOnly = nativeManagementOnly === true;
    this.ownsChannelHost = ownsChannelHost === true;
    this.#lifecycleMetrics = new BrokerLifecycleMetrics(monotonicNow);
    this.#onLifecycleMetrics = onLifecycleMetrics;
    this.#pendingBudget = new BrokerRequestBudget(pendingBudget, id => this.expireRequest(id));
    if (typeof retentionParentV1 !== "boolean") throw new RetentionAuthorityError();
    this.retentionParentV1 = retentionParentV1;
    if (typeof migrationSourceParentV1 !== 'boolean') throw new MigrationSourceBridgeError('source_transfer_authority_unavailable');
    this.migrationSourceParentV1 = migrationSourceParentV1;
    if (typeof retentionRevocationTrusted !== "boolean" || (retentionRevocationTrusted && !retentionParentV1)) throw new RetentionAuthorityError();
    this.retentionRevocationTrusted = retentionRevocationTrusted;
    this.registerRetentionRoute = registerRetentionRoute;
    if (nativeRemoteHostBackchannel !== undefined &&
        (typeof nativeRemoteHostBackchannel?.receiveBackend !== "function" ||
         typeof nativeRemoteHostBackchannel?.close !== "function")) throw new Error("Native Remote host callbacks are required");
    this.#nativeRemoteHostBackchannel = nativeRemoteHostBackchannel;
    this.child = child;
    this.adapter = adapter;
    this.maxMessageBytes = maxMessageBytes;
    this.serverId = serverId;
    this.targetTransport = targetTransport;
    this.remotePlatform = remotePlatform;
    this.onClose = onClose;
    this.onRestart = onRestart;
    this.onIdleStateChange = onIdleStateChange;
    this.onWorkspaceRemoved = onWorkspaceRemoved;
    this.onReleaseWorkspace = onReleaseWorkspace;
    this.clients = new Set();
    this.restartAdmissionRetired = false;
    this.threadOwners = new Map();
    this.sharedThreads = new BrokerSharedThreads(this);
    this.sharedInteractions = new BrokerSharedInteractions(this);
    this.studioPresentation = new BrokerStudioPresentation();
    this.continuousWork = new BrokerContinuousWork();
    this.mcpFlowOwners = new Map();
    this.mcpOAuth = new BrokerMcpOAuth({
      attached: client => this.clients.has(client) && !this.closed,
      forward: (client, message) => this.forwardClientRequest(client, message),
      cancel: flowId => { this.mcpFlowOwners.delete(flowId); this.cancelMcpFlow(flowId); },
      notify: (client, params) => client.send({ jsonrpc: "2.0", method: "mcp/authorizationChanged", params }),
    });
    this.ephemeralThreadOwners = new Map();
    this.threadClaims = new Map();
    this.activeTurns = new Map();
    // After detach, turn/interrupt must await the terminal app-server notification.
    // During drain, do not write thread/resume or turn/start early to the same resident app-server.
    this.threadDrains = new Map();
    this.pending = new Map();
    this.detachedRequestIds = new Set();
    this.detachedRequestsUnknown = false;
    this.historyRefresh = new BrokerHistoryRefresh();
    this.historyViewLeases = new BrokerMigrationViewLeases();
    this.webSearchDiagnostics = new BrokerWebSearchDiagnostics();
    this.serverRequests = new Map();
    this.repliedServerRequests = new Map();
    this.resourceOwners = new Map();
    this.liveTerminals = new Set();
    this.terminalClaims = new Map();
    this.exitedTerminalIds = new Set();
    this.persistentResources = new Set();
    this.retainedAttachmentBindings = new Map();
    this.automationThreads = new Set();
    this.automationAdmissions = new Map();
    this.automationFailures = new Map();
    this.projectAutomationJobCount = 0;
    this.projectAutomationPendingCount = 0;
    this.activeAutomationThreads = new Set();
    this.materializedAttachments = new Map();
    this.nextRequestId = 1;
    this.initializeResponse = null;
    this.initializePending = null;
    this.initializeWaiters = [];
    this.shareability =
      residentThreads === true
        ? "resident"
        : residentThreads === false
          ? "legacy"
          : "unknown";
    this.shareabilityPromise =
      this.shareability === "unknown"
        ? new Promise((resolve) => {
            this.resolveShareability = resolve;
          })
        : Promise.resolve(this.shareability);
    this.closed = false;
    this.idleShutdown = new BrokerIdleShutdown(this, monotonicNow);
    this.lastUsedAt = this.idleShutdown.now();
    this.restartRequest = null;
    this.stdinBackpressured = false;
    this.stdoutBlockedClients = new Set();
    this.stderr = "";
    this.stdoutDecoder = new BoundedJsonlDecoder(maxMessageBytes);

    child.stdout.on("data", (chunk) => this.processStdoutChunk(chunk));
    child.stdout.on("end", () => {
      try {
        const tail = this.stdoutDecoder.finish();
        for (const dropped of tail.dropped) this.handleDroppedFrame(dropped);
        for (const line of tail.lines) this.processStdoutLine(line);
      } catch (error) {
        this.fail(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4096);
      process.stderr.write(`[app-server] ${chunk}`);
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.resolveShareability?.("closed");
      const disconnected = {
        jsonrpc: "2.0",
        method: "server/disconnected",
        params: { serverId: this.serverId, code, signal },
      };
      for (const client of this.clients) {
        if (client === this.restartRequest?.client) continue;
        client.send(disconnected);
        client.close();
      }
      this.clients.clear();
      this.clearTransientState();
      this.onClose?.(this);
      this.#finishLifecycleMetrics();
    });
  }

  get clientCount() {
    return this.clients.size;
  }

  get reusable() {
    return !this.closed && !this.idleShutdown.closing && this.shareability === "resident";
  }

  get hasProtectedIdleResources() {
    if (this.clientCount !== 0 || this.hasLiveTerminals || this.hasProjectAutomations ||
      this.hasPendingWork || this.resourceOwners.size > 0) return true;
    for (const key of this.persistentResources) {
      if (!this.materializedAttachments.has(key)) return true;
    }
    return false;
  }

  stopWhenIdle() { return this.idleShutdown.stop(); }
  readResourceSnapshot() { return this.idleShutdown.readResources(); }

  get hasLiveTerminals() {
    return this.liveTerminals.size > 0;
  }

  get hasPendingWork() {
    return [...this.#pendingBudget.records.values()].some(entry => entry.work) || this.pending.size > 0 || this.activeTurns.size > 0 ||
      this.threadDrains.size > 0 || this.serverRequests.size > 0 ||
      this.detachedRequestIds.size > 0 || this.detachedRequestsUnknown;
  }

  get pendingLoad() { return this.#pendingBudget.snapshot(); }

  /** Counts only: how many forwarded requests are still unanswered, per channel. */
  get requestLoad() {
    return this.#requestLoad.snapshot();
  }

  get hasProjectAutomations() {
    return this.projectAutomationJobCount > 0 || this.projectAutomationPendingCount > 0 || this.activeAutomationThreads.size > 0;
  }

  get acceptsClient() {
    return (
      !this.closed &&
      !this.idleShutdown.closing &&
      !this.restartRequest &&
      !this.restartAdmissionRetired &&
      (this.shareability === "resident" || this.clientCount === 0 ||
        (this.ownsChannelHost && this.shareability === "unknown"))
    );
  }

  whenShareabilityKnown() {
    return this.shareabilityPromise;
  }

  retireAdmissionForRestart() {
    if (this.restartAdmissionRetired) return;
    this.restartAdmissionRetired = true;
    this.onIdleStateChange?.(this);
  }

  attach(client) {
    if (this.closed || this.restartRequest || this.restartAdmissionRetired || this.idleShutdown.closing) throw new Error("workspace app-server broker is closed or restarting");
    this.#lifecycleMetrics.attach(this.clientCount === 0);
    this.lastUsedAt = this.idleShutdown.now();
    client.nativeManagementOnly = this.nativeManagementOnly || client.nativeManagementOnly === true;
    client.browserStarted = false;
    client.initialized = false;
    client.toolPathPreviewV1 = undefined;
    client.threadStreamContextV1 = undefined;
    client.threadRunSummaryV1 = undefined;
    client.threadGoalStatusBatchV1 = undefined;
    client.migrationHistoryWorkerStateV1 = undefined;
    client.threadTranscriptSnapshotV1 = undefined;
    client.threadTranscriptObservationV1 = undefined;
    client[CONTINUOUS_WORK_CAPABILITY] = undefined;
    client[CONTINUOUS_WORK_READ_CAPABILITY] = undefined;
    client[CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY] = undefined;
    client.pendingInitializeChoices = null;
    client[SHARED_THREADS_CAPABILITY] = undefined;
    client.computerUseRecoveryV1 = undefined;
    client.computerUseSessionAuthorizationV1 = undefined;
    this.studioPresentation.attach(client);
    this.continuousWork.attach(client);
    this.clients.add(client);
  }

  detach(client) {
    const hostOwnsLifetime = this.sessionAttachments.enabled();
    this.sessionAttachments.detach(client);
    this.sharedThreads.detach(client);
    this.continuousWork.detach(client);
    for (const request of this.historyViewLeases.detach(client)) this.sendInternalRequest(request.method, request.params);
    for (const request of this.webSearchDiagnostics.detach(client)) this.sendInternalRequest(request.method, request.params);
    if (this.initializeResponse?.result?.capabilities?.experimental?.mcpAppsV1 === true) {
      for (const [threadId, owner] of this.threadOwners) {
        if (owner !== client) continue;
        // A retained shared backend is not the detached Studio owner's authority.
        this.sendInternalRequest('mcp/apps/revoke', { threadId });
      }
    }
    this.mcpOAuth.detach(client);
    for (const [flowId, owner] of this.mcpFlowOwners) {
      if (owner.client === client) {
        this.mcpFlowOwners.delete(flowId);
        this.cancelMcpFlow(flowId);
      }
    }
    if (this.initializeResponse?.result?.capabilities?.experimental?.computerUseRecoveryV1) {
      for (const [threadId, owner] of this.threadOwners) {
        if (owner !== client) continue;
        this.sendInternalRequest("computerUse/revoke", { threadId });
      }
    }
    if (!hostOwnsLifetime && this.initializeResponse?.result?.capabilities?.experimental?.goalContinuation) {
      for (const [threadId, owner] of this.threadOwners) {
        if (owner !== client) continue;
        // Disarm idle automatic work as well as any currently running turn.
        // Read-only/transient clients never own a thread and cannot suspend it.
        this.sendInternalRequest("thread/automation/suspend", { threadId });
      }
    }
    for (const [threadId, owner] of this.ephemeralThreadOwners) {
      if (owner !== client) continue;
      const retirement = this.continuousWork.retireEphemeral(threadId);
      this.ephemeralThreadOwners.delete(threadId);
      this.sendInternalRequest("thread/dispose", { threadId }, { onResponse: response =>
        this.continuousWork.settleEphemeral(threadId, retirement, response,
          this.initializeResponse?.result?.capabilities?.experimental, this.ephemeralThreadOwners) });
    }
    if (this.clients.delete(client) && this.clientCount === 0) {
      this.#lifecycleMetrics.clientFree();
      this.lastUsedAt = this.idleShutdown.now();
    }
    this.releaseStdout(client);
    this.sharedThreads.handoff(client);
    this.sharedInteractions.detach(client);
    for (const [threadId, active] of this.activeTurns) {
      if (active.owner !== client || hostOwnsLifetime) continue;
      this.beginThreadDrain(threadId, active.turnId);
      this.sendInternalRequest("turn/interrupt", { threadId, turnId: active.turnId });
      this.activeTurns.delete(threadId);
    }
    for (const [id, pending] of this.pending) {
      if (pending.client !== client) continue;
      pending.params = compactRequestParams(pending.params, pending.method);
      this.#pendingBudget.compact(id, Buffer.byteLength(JSON.stringify({ params: pending.params, attachmentPaths: pending.attachmentPaths })));
      pending.clientId = null;
      delete pending.oauthReceiver;
      delete pending.oauthCompletion;
      if (pending.refreshTicket) pending.client = null;
      else if (pending.method === "initialize") pending.client = null;
      else if (pending.method === 'asyncQuestion/answer') {
        // A legacy host can interrupt only a newly admitted turn, never peer steering.
        pending.client = null;
        pending.interruptOnResponse = !hostOwnsLifetime;
      }
      else if (["turn/start", "computerUse/recover"].includes(pending.method)) {
        // Retain a detached tombstone until the original admission settles.
        pending.client = null;
        pending.interruptOnResponse = !hostOwnsLifetime;
        const threadId = threadIdFrom({ method: pending.method, params: pending.params });
        if (threadId && pending.interruptOnResponse) this.beginThreadDrain(threadId);
      } else if (pending.method === "thread/start"
          && typeof pending.params?.clientRequestId === "string"
          && pending.params.clientRequestId.trim()
          && this.initializeResponse?.result?.capabilities?.experimental?.threadCreationReceiptsV1 === true) {
        // The durable creation receipt lets a reconnect discover this exact thread.
        // Deleting it here would destroy accepted work and invite another startup lifecycle.
        pending.client = null;
        pending.preserveCreationOnResponse = true;
      } else if (LATE_CREATION_METHODS.has(pending.method)) {
        // A successful creation response may carry a previously unknown thread/resource
        // ID. Retain the tombstone and perform compensating cleanup with the real ID when
        // the response arrives, preventing disconnect retries from exhausting resident slots or session resources.
        pending.client = null;
        pending.cleanupOnResponse = true;
      } else if (["terminal/close", "thread/delete", "thread/dispose", THREAD_RUNTIME_HANDOFF_RELEASE].includes(pending.method)) {
        // Retain the authoritative close/release receipt so earlier answer
        // admissions cannot recreate a binding after its owner disconnects.
        pending.client = null;
      } else {
        this.#lifecycleMetrics.resumeAbandoned(pending.resumeStartedAt);
        this.#resumeNotificationBuffer.discard(pending);
        this.releaseThreadClaim(pending);
        this.releaseTerminalClaim(pending);
        this.pending.delete(id);
        // Keep only correlation IDs, never disconnected client objects or prompts.
        // Overflow remains conservatively busy until process exit.
        if (this.detachedRequestIds.size < 4096) this.detachedRequestIds.add(id);
        else this.detachedRequestsUnknown = true;
      }
    }
    this.pruneOfficeTaskOwnerHandoff();
    this.sendRefreshCleanup(this.historyRefresh.detach(client));
    for (const drain of this.threadDrains.values()) {
      drain.queue = drain.queue.filter((entry) => entry.client !== client);
    }
    for (const [threadId, owner] of this.threadOwners) {
      if (owner === client) this.threadOwners.delete(threadId);
    }
    for (const [threadId, claim] of this.threadClaims) {
      if (threadClaimOwner(claim) === client) this.threadClaims.delete(threadId);
    }
    for (const [sessionId, owner] of this.terminalClaims) {
      if (owner === client) this.terminalClaims.delete(sessionId);
    }
    this.initializeWaiters = this.initializeWaiters.filter(waiter => {
      if (waiter.client !== client) return true;
      this.settleRequest(waiter.budgetId);
      client.pendingInitializeChoices = null;
      return false;
    });
    for (const [id, owner] of this.repliedServerRequests) {
      if (owner === client) this.repliedServerRequests.delete(id);
    }
    for (const [id, owner] of this.serverRequests) {
      if (owner !== client) continue;
      this.serverRequests.delete(id);
      this.safeWriteMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32040, message: "owning Gateway client disconnected" },
      });
    }
    for (const [key, owner] of this.resourceOwners) {
      if (owner !== client) continue;
      this.resourceOwners.delete(key);
      const [kind, resourceId] = key.split("\0", 2);
      const method =
        kind === "terminal"
          ? this.liveTerminals.has(resourceId)
            ? null
            : "terminal/close"
          : kind === "browser"
            ? "browser/close"
            : null;
      if (method) this.sendInternalRequest(method, { session_id: resourceId });
      if (kind === "wiki-archive") this.cancelArchiveTransfer(resourceId);
      if (kind === "attachment-upload") {
        this.sendInternalRequest("attachment/upload/cancel", { upload_id: resourceId });
      }
      const persistent = this.persistentResources.has(key);
      if (kind === "attachment" && !persistent) {
        this.sendInternalRequest("attachment/delete", { path: resourceId });
      }
    }
  }

  blockStdout(client) {
    if (this.closed || this.stdoutBlockedClients.has(client)) return;
    this.stdoutBlockedClients.add(client);
    this.child.stdout.pause();
  }

  releaseStdout(client) {
    if (!this.stdoutBlockedClients.delete(client)) return;
    if (!this.closed && this.stdoutBlockedClients.size === 0)
      this.child.stdout.resume();
  }

  clearTransientState() {
    this.sharedThreads.clear();
    this.sharedInteractions.clear();
    this.#nativeRemoteHostBackchannel?.close();
    this.historyViewLeases.clear();
    this.webSearchDiagnostics.clear();
    this.historyRefresh.reset();
    this.ephemeralThreadOwners.clear();
    this.threadOwners.clear();
    this.mcpFlowOwners.clear();
    this.mcpOAuth.close();
    this.threadClaims.clear();
    this.#resumeNotificationBuffer.clear();
    this.sessionAttachments.clear();
    this.#officeTaskOwnerHandoff.clear();
    this.activeTurns.clear();
    this.activeAutomationThreads.clear();
    this.automationThreads.clear();
    this.automationAdmissions.clear();
    this.automationFailures.clear();
    this.projectAutomationJobCount = 0;
    this.projectAutomationPendingCount = 0;
    for (const drain of this.threadDrains.values()) {
      clearTimeout(drain.timer);
      drain.resolveDone?.(false);
    }
    this.threadDrains.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.internalRequestTimer);
      pending.internalRequestTimer = null;
      pending.onResponse?.({ error: { message: "app-server broker closed" } });
      this.#lifecycleMetrics.resumeAbandoned(pending.resumeStartedAt);
    }
    this.pending.clear();
    this.#pendingBudget.clear();
    this.#requestLoad = new RequestLoadTracker();
    this.detachedRequestIds.clear();
    this.detachedRequestsUnknown = false;
    this.serverRequests.clear();
    this.repliedServerRequests.clear();
    this.resourceOwners.clear();
    this.liveTerminals.clear();
    this.terminalClaims.clear();
    this.exitedTerminalIds.clear();
    this.persistentResources.clear();
    this.retainedAttachmentBindings.clear();
    this.materializedAttachments.clear();
    for (const waiter of this.initializeWaiters) waiter.client.pendingInitializeChoices = null;
    this.initializeWaiters.length = 0;
    this.initializePending = null;
    this.initializeResponse = null;
    this.stdoutBlockedClients.clear();
  }

  receive(client, raw) {
    if (!this.clients.has(client))
      throw new Error("gateway client is not attached");
    const inspected = inspectGatewayChannelMessage(client.channel, raw, {
      browserStarted: client.browserStarted,
    });
    if (!inspected.allowed) {
      client.send({
        jsonrpc: "2.0",
        id: inspected.request?.id ?? null,
        error: {
          code: -32601,
          message: "Method not available on this gateway channel",
        },
      });
      return;
    }

    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      // After multiplexing, an app-server id:null parse error cannot be associated with
      // the original connection. Return a standard JSON-RPC parse error at the boundary
      // and never spread a malformed frame to other clients.
      client.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (client.nativeManagementOnly && request?.method !== 'gateway/client/detach' &&
        !nativeManagementMethodAllowed(request?.method)) {
      client.send({ jsonrpc: '2.0', id: request?.id ?? null,
        error: { code: -32601, message: 'Native management transport cannot execute task commands' } });
      return;
    }
    if (isNativeRemoteHostMethod(request?.method) || isNativeRemoteHostRequestId(request?.id) ||
        request?.method === 'kcoder/nativeRemote/controlV1') {
      client.send({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32601, message: "Native Remote host methods are private to the owning Gateway" } });
      return;
    }
    // Desktop authority belongs to this host. Shell/SSH target access and a
    // client-supplied approval cannot select or grant another host's desktop.
    if (this.targetTransport !== 'local' &&
        (typeof request?.method === 'string' && request.method.startsWith('computerUse/') ||
         request?.method === 'turn/start' && request.params?.computerUse != null)) {
      client.send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32602,
        message: 'Computer Use requires a local target and explicit local desktop authorization' } });
      return;
    }
    if (hasPrivateMigrationSourceField(raw) ||
        (typeof request?.method === 'string' && request.method.startsWith(MIGRATION_SOURCE_INTERNAL_PREFIX))) {
      client.send({ jsonrpc: "2.0", id: request?.id ?? null,
        error: { code: -32602, message: "Migration source authority is private to the Gateway" } });
      return;
    }
    if (RETENTION_METHODS.has(request.method) && hasRawDuplicateRetentionFields(raw)) {
      client.send({ jsonrpc: "2.0", id: request?.id ?? null,
        error: { code: -32602, message: "Retention fields must be unique and bounded" } });
      return;
    }
    if (hasRawReservedRetentionFields(raw) || hasReservedRetentionFields(request)) {
      client.send({ jsonrpc: "2.0", id: request?.id ?? null,
        error: { code: -32602, message: "Client retention authority fields are reserved" } });
      return;
    }

    if (request.method === "gateway/mcp/login") {
      if (!(typeof request.id === "string" || Number.isSafeInteger(request.id))) {
        client.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP authorization requires a request ID" } });
        return;
      }
      if (!client.initialized) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32002, message: "Initialize is required before authorization" } });
        return;
      }
      void this.mcpOAuth.login(client, request).catch(error => {
        if (this.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id ?? null,
          error: { code: -32021, message: error.message } });
      });
      return;
    }
    if (request.method?.startsWith("mcp/")) {
      for (const [flowId, owner] of this.mcpFlowOwners) {
        if (owner.expiresAt <= Date.now()) this.mcpFlowOwners.delete(flowId);
      }
      if (["mcp/callback", "mcp/cancel"].includes(request.method) &&
          this.mcpFlowOwners.get(request.params?.flowId)?.client !== client) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
          code: -32021, message: "MCP authorization flow is unavailable on this Gateway connection",
        } });
        return;
      }
    }

    if (request.method === "server/shutdown/idle") {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32601, message: "idle shutdown is reserved for the Gateway lifecycle owner",
      } });
      return;
    }
    if (['thread/attach', 'thread/detach'].includes(request.method)) {
      client.send({ jsonrpc:'2.0', id:request.id ?? null,
        error:{code:-32601,message:'Attachment handles belong to the authenticated Gateway transport'} });
      return;
    }
    if (['gateway/thread/attach', 'gateway/thread/detach'].includes(request.method)) {
      const threadId = request.params?.threadId, viewId = request.params?.viewId;
      const owned = this.threadOwners.get(threadId) === client || this.sharedThreads.has(threadId, client);
      if (request.id == null || !this.clients.has(client) || !client.initialized || !owned ||
          typeof viewId !== 'string' || viewId.length === 0 || viewId.length > 64) {
        client.send({jsonrpc:'2.0', id:request.id ?? null,
          error:{code:-32023,message:'A current authorized conversation view is required'}}); return;
      }
      const changed = request.method === 'gateway/thread/attach'
        ? this.sessionAttachments.attach(client, threadId, viewId)
        : this.sessionAttachments.release(client, threadId, viewId);
      client.send({jsonrpc:'2.0',id:request.id,result:{changed}}); return;
    }
    if (request.method === "gateway/client/detach") {
      const reject = (code, message) => client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
      const params = request.params;
      if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) {
        reject(-32600, "Detach requires a JSON-RPC request with an id"); return;
      }
      if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true || typeof params.force !== "boolean" ||
          Object.keys(params).some(key => !["confirm", "force"].includes(key))) {
        reject(-32602, "Detach requires {confirm:true, force:boolean}"); return;
      }
      if (!client.initialized) { reject(-32002, "Initialize is required before detach"); return; }
      const ownThreads = new Set([...this.activeTurns].filter(([, turn]) => turn.owner === client).map(([threadId]) => threadId));
      for (const pending of this.pending.values()) {
        if (pending.client === client && pending.method === "turn/start") ownThreads.add(threadIdFrom({ method: pending.method, params: pending.params }));
      }
      if (!this.sessionAttachments.enabled() && ownThreads.size && !params.force) { reject(-32043, "Client has active turns; explicit cancellation is required"); return; }
      this.detach(client);
      const drains = [...ownThreads].map(threadId => this.threadDrains.get(threadId)?.done ?? Promise.resolve(true));
      Promise.all(drains).then(results => {
        if (results.some(completed => !completed)) reject(-32043, "Unable to confirm detached turns have stopped");
        else client.send({ jsonrpc: "2.0", id: request.id, result: { detached: true } });
        client.close();
      });
      return;
    }
    if (request.method === "gateway/app-server/restart") {
      const reject = (code, message) => client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
      if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) {
        reject(-32600, "Restart requires a JSON-RPC request with an id");
        return;
      }
      const params = request.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true ||
          Object.keys(params).some(key => !["confirm", "force"].includes(key)) ||
          (params.force !== undefined && typeof params.force !== "boolean")) {
        reject(-32602, "Restart requires {confirm:true, force?:boolean}");
        return;
      }
      if (!client.initialized) { reject(-32002, "Initialize is required before restart"); return; }
      if (typeof this.onRestart !== "function") { reject(-32601, "Restart is not available"); return; }
      if (this.restartRequest || this.clients.size !== 1 || this.pending.size || this.liveTerminals.size ||
          this.threadDrains.size || [...this.resourceOwners.keys()].some(key => key.startsWith("browser\0")) ||
          this.projectAutomationPendingCount ||
          ((this.activeTurns.size || this.activeAutomationThreads.size) && params.force !== true)) {
        reject(-32043, "Restart refused: another client, terminal, browser or request is using this app-server; close other connections first");
        return;
      }
      this.restartRequest = { client, id: request.id };
      Promise.resolve().then(() => this.onRestart(this)).then(() => {
        client.send({ jsonrpc: "2.0", id: request.id, result: { restarted: false, stopped: true, reconnectRequired: true } });
        client.close();
      }, () => {
        reject(-32044, "Unable to stop app-server for restart");
        this.restartRequest = null;
        if (this.closed) client.close();
      });
      return;
    }
    if (this.restartRequest) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32043, message: "App-server restart is in progress" } });
      return;
    }
    if (request.method === "gateway/workspace/release") {
      if (request.id === undefined) return;
      const workspacePath = request.params?.workspacePath;
      if (!isTargetWorkspaceAbsolute({ transport: this.targetTransport, remotePlatform: this.remotePlatform }, workspacePath)) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "workspace release requires an absolute workspacePath",
          },
        });
        return;
      }
      Promise.resolve(this.onReleaseWorkspace?.(workspacePath))
        .then((result) => {
          if (!this.clients.has(client)) return;
          client.send({
            jsonrpc: "2.0",
            id: request.id,
            result: result ?? { released: true, releasedCount: 0 },
          });
        })
        .catch((error) => {
          if (!this.clients.has(client)) return;
          client.send({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32042,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return;
    }
    if (request.method === "gateway/attachments/discardRetained") {
      const { threadId, paths } = request.params ?? {};
      if (request.id === undefined || !client.initialized || typeof threadId !== "string" || !threadId ||
          !client.authorizationOwner || !Array.isArray(paths) || !paths.length || paths.length > 256 ||
          paths.some(path => typeof path !== "string" || !path || path.length > 4096) || new Set(paths).size !== paths.length) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "Scoped retained cleanup requires initialize, threadId and unique bounded paths" } }); return;
      }
      void this.discardRetainedAttachments(client, threadId, paths).then(result => {
        if (this.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id, result });
      }).catch(() => {
        if (this.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_NOT_READY, message: "Retained cleanup could not be confirmed" } });
      });
      return;
    }
    if (request.method === "gateway/attachments/retain") {
      if (request.id === undefined) return;
      const requestedPaths = request.params?.paths;
      const paths = Array.isArray(requestedPaths)
        ? [
            ...new Set(
              requestedPaths.filter(
                (path) => typeof path === "string" && path.length > 0,
              ),
            ),
          ]
        : [];
      if (paths.length === 0 || paths.length !== requestedPaths.length) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "attachment retain requires unique non-empty paths",
          },
        });
        return;
      }
      const keys = paths.map((path) => `attachment\0${path}`);
      if (keys.some((key) => this.resourceOwners.get(key) !== client)) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: RESOURCE_OWNERSHIP_CONFLICT,
            message: "attachment does not belong to this Gateway client",
          },
        });
        return;
      }
      const threadId = request.params?.threadId;
      if (threadId !== undefined && (typeof threadId !== "string" || !threadId || threadId.length > 128 || !client.authorizationOwner)) {
        client.send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Scoped attachment retention requires a thread and authenticated Gateway owner" } }); return;
      }
      if (threadId && keys.some(key => {
        const prior = this.retainedAttachmentBindings.get(key);
        return prior && (prior.cleared || prior.threadId !== threadId || prior.owner !== client.authorizationOwner);
      })) {
        client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_OWNERSHIP_CONFLICT, message: "Retained attachment is bound to another thread or authorization" } }); return;
      }
      if (threadId && keys.some(key => this.retainedAttachmentBindings.get(key)?.cleaning)) {
        client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_NOT_READY, message: "Retained attachment cleanup is pending; path cannot be retained again" } }); return;
      }
      if (threadId && this.retainedAttachmentBindings.size + keys.filter(key => !this.retainedAttachmentBindings.has(key)).length > 4096) {
        client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_NOT_READY, message: "Retained attachment cleanup ledger capacity reached" } }); return;
      }
      for (const key of keys) {
        this.persistentResources.add(key);
        if (threadId && !this.retainedAttachmentBindings.has(key)) this.retainedAttachmentBindings.set(key, { threadId, owner: client.authorizationOwner, cleared: false, cleaning: false });
      }
      client.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { retained: true, paths },
      });
      return;
    }
    if (request.method === "initialize") {
      // Rust RequestId also accepts u64; JSON/JS transports deliberately admit
      // only its exactly representable nonnegative safe-integer/string subset.
      if (request.id === undefined) return;
      const validId = typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0);
      const reject = (code, message) => client.send({ jsonrpc: "2.0", id: validId ? request.id : null, error: { code, message } });
      if (!validId || (request.jsonrpc !== undefined && request.jsonrpc !== "2.0")) {
        reject(-32600, "Initialize requires a valid JSON-RPC request ID"); return;
      }
      if (client.initialized || client.pendingInitializeChoices) {
        reject(-32600, "Initialize already completed or pending"); return;
      }
      if (!isContract("InitializeParams", request.params) || request.params.protocolVersion !== PROTOCOL_VERSION) {
        reject(-32602, "Invalid initialize parameters or protocol version"); return;
      }
      if (requestsNativeManagement(request.params) !== client.nativeManagementOnly) {
        reject(-32602, "Native management requires its control transport and task opt-outs"); return;
      }
      if (requestsDedicatedCapabilities(request.params)) {
        reject(-32602, "Requested capabilities require a dedicated native app-server connection"); return;
      }
      this.studioPresentation.initialize(client, request);
      client.pendingInitializeChoices = Object.fromEntries(CLIENT_EXPERIMENTAL_CHOICES.map(name =>
        [name, request.params.capabilities?.experimental?.[name === "migrationHistoryWorkerStateV1" ? "migrationHistoryWorkerStateClientV1" : name] === true]));
      client.pendingInitializeChoices[SHARED_THREADS_CAPABILITY] = request.params.capabilities?.experimental?.[SHARED_THREADS_CAPABILITY] === true;
      if (this.initializeResponse) {
        finishClientInitialize(client, this.initializeResponse);
        client.send(this.studioPresentation.project(
          this.projectWorkspaceReceiptCapability(cloneWithId(this.initializeResponse, request.id), client), client));
        return;
      }
      if (this.initializePending !== null) {
        const budgetId = this.nextRequestId++;
        if (!this.#pendingBudget.admit(budgetId, client, request)) {
          client.pendingInitializeChoices = null;
          reject(-32000, "Gateway request capacity reached; request was not forwarded");
          return;
        }
        this.initializeWaiters.push({ client, clientId: request.id, budgetId });
        return;
      }
    }
    if (
      request.method &&
      request.id === undefined &&
      !CLIENT_NOTIFICATION_METHODS.has(request.method)
    ) {
      // Every current client-protocol operation except initialized requires a response.
      // Reject ID-less operations so they cannot create threads, terminals, browsers, or attachments without ownership and cleanup.
      return;
    }
    if (suppliesTemporaryThreadMcp(request)) {
      client.send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602,
        message: 'Temporary MCP servers require a dedicated native app-server connection' } });
      return;
    }
    const commandKey = request.params?.command_key;
    if (
      request.method === "device/execute" &&
      ["turn_file_changes_review", "turn_file_changes_revert"].includes(
        commandKey,
      ) &&
      !threadIdFrom(request)
    ) {
      const owned = [...this.threadOwners]
        .filter(([, owner]) => owner === client)
        .map(([threadId]) => threadId);
      if (owned.length !== 1) {
        client.send({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code: -32602,
            message:
              "turn file changes command requires threadId when the client owns zero or multiple threads",
          },
        });
        return;
      }
      request.params = { ...request.params, threadId: owned[0] };
    }
    if (request.method === "turn/start" && typeof request.params?.computerUse?.useSessionAuthorization === "boolean" && client.computerUseSessionAuthorizationV1 !== true) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "computerUseSessionAuthorizationV1 negotiation is required" } });
      return;
    }
    const expertError = taskExpertAdmissionError(request, client, this.initializeResponse?.result?.capabilities?.experimental);
    if (expertError) {
      client.send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: expertError } });
      return;
    }
    const asyncQuestionError = asyncQuestionAdmissionError(request, client, this.initializeResponse?.result?.capabilities?.experimental);
    if (asyncQuestionError) {
      client.send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: asyncQuestionError } });
      return;
    }
    request = projectAsyncQuestionRequest(request, client, this.initializeResponse?.result?.capabilities?.experimental);
    const requestedThreadId = threadIdFrom(request);
    // A resident backend can outlive its Gateway owner. An absent owner or an
    // in-flight resume claim does not bind this client to the original task.
    if (ASYNC_QUESTION_METHODS.has(request.method) &&
        this.threadOwners.get(requestedThreadId) !== client &&
        !this.sharedThreads.has(requestedThreadId, client)) {
      client.send({ jsonrpc: '2.0', id: request.id, error: { code: -32023,
        message: 'Async question operations require a task resumed by this Gateway client' } });
      return;
    }
    if (TASK_COMPARISON_METHODS.has(request.method) &&
        (!requestedThreadId || client.initialized !== true || this.threadOwners.get(requestedThreadId) !== client)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32023, message: "comparison requires ownerThreadId resumed by this Gateway client",
      } });
      return;
    }
    const presentationError = this.studioPresentation.validate(client, request,
      this.initializeResponse?.result?.capabilities?.experimental,
      requestedThreadId ? this.threadOwners.get(requestedThreadId) : null,
      this.sharedThreads.has(requestedThreadId, client));
    if (presentationError) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: presentationError } });
      return;
    }
    if (["computerUse/recover", "computerUse/revoke"].includes(request.method) &&
        (!requestedThreadId || this.threadOwners.get(requestedThreadId) !== client)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32023, message: "Desktop recovery requires the original owned resident thread",
      } });
      return;
    }
    if (["computerUse/recover", "computerUse/revoke"].includes(request.method) && client.computerUseRecoveryV1 !== true) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "computerUseRecoveryV1 negotiation is required" } });
      return;
    }
    // Catalogs describe the effective resident session, not public thread history.
    // An in-flight resume claim or detached resident is not completed ownership.
    if (request.method === "tools/catalog" && requestedThreadId &&
        this.threadOwners.get(requestedThreadId) !== client &&
        !this.sharedThreads.allowsRead(requestedThreadId, client, request.method)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32023, message: "tools/catalog requires a thread resumed by this Gateway client",
      } });
      return;
    }
    const ephemeralOwner = requestedThreadId ? this.ephemeralThreadOwners.get(requestedThreadId) : null;
    if (ephemeralOwner && ephemeralOwner !== client) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32023, message: "temporary thread belongs to another Gateway client",
      } });
      return;
    }
    // Forking reads the source but binds a new independent child to this client.
    const ephemeralFork = request.method === "thread/fork" && request.params?.ephemeral === true;
    const threadDrain = requestedThreadId
      ? this.threadDrains.get(requestedThreadId)
      : null;
    if (
      threadDrain &&
      request.method &&
      !THREAD_READONLY_METHODS.has(request.method) && request.method !== "computerUse/revoke"
    ) {
      if (request.id !== undefined) {
        if (threadDrain.timedOut) this.rejectUnconfirmedDrain(client, request.id);
        else threadDrain.queue.push({ client, raw, id: request.id });
      }
      return;
    }
    const currentClaim = requestedThreadId
      ? this.threadClaims.get(requestedThreadId)
      : null;
    const currentOwner = requestedThreadId
      ? (this.threadOwners.get(requestedThreadId) ?? threadClaimOwner(currentClaim))
      : null;
    const sharedResume = request.method === "thread/resume" && requestedThreadId &&
      this.sharedThreads.canJoin(client, requestedThreadId, currentOwner) &&
      (currentOwner !== client || !currentClaim);
    if (sharedResume && currentOwner && currentOwner !== client) request[SHARED_RESUME] = true;
    const sharedControl = this.sharedThreads.has(requestedThreadId, client) &&
      ["turn/start", "turn/steer", "turn/interrupt", "thread/expert", "thread/lifetime/read", "thread/lifetime/set",
        'asyncQuestion/answer', 'asyncQuestion/cancel'].includes(request.method);
    const sharedAdmissionError = this.sharedThreads.admissionError(requestedThreadId, client, request.method);
    if (sharedAdmissionError) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null,
        error: { code: -32044, message: sharedAdmissionError,
          ...(sharedAdmissionError.startsWith('Another device') ? { data: { gatewaySharedThreadsV1: { kind: 'turn_busy' } } } : {}) } });
      return;
    }
    if (
      request.method &&
      requestedThreadId &&
      currentOwner &&
      (currentOwner !== client ||
        (request.method === "thread/resume" && currentClaim)) &&
      !THREAD_READONLY_METHODS.has(request.method) && !ephemeralFork && !sharedResume && !sharedControl &&
      !this.sharedThreads.allowsRead(requestedThreadId, client, request.method)
    ) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32023,
            message: "thread is already active in another Gateway client",
          },
        });
      }
      return;
    }
    const requestedResourceKey = this.resourceKeyFrom(request);
    const requestedTerminalId = request.method?.startsWith("terminal/")
      ? terminalSessionIdFrom(request)
      : null;
    const resourceOwner = requestedResourceKey
      ? (this.resourceOwners.get(requestedResourceKey) ??
        (requestedTerminalId
          ? this.terminalClaims.get(requestedTerminalId)
          : null))
      : null;
    if (WIKI_ARCHIVE_OWNED_METHODS.has(request.method) && (!requestedResourceKey || !resourceOwner)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_NOT_READY,
        message: "Wiki archive transfer must be owned by this connection" } });
      return;
    }
    if (request.method === "attachment/delete" && requestedResourceKey) {
      const retained = this.retainedAttachmentBindings.get(requestedResourceKey);
      if (retained && (retained.owner !== client.authorizationOwner || resourceOwner !== client || retained.cleaning || retained.cleared)) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_OWNERSHIP_CONFLICT, message: "Retained attachment deletion requires its current original owner or scoped cleanup" } }); return;
      }
    }
    if (STAGED_INPUT_METHODS.has(request.method) && requestedResourceKey && !resourceOwner) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_NOT_READY, message: "Input must be an upload owned by this client" } });
      return;
    }
    const terminalClaimInFlight = requestedTerminalId
      ? this.terminalClaims.has(requestedTerminalId)
      : false;
    if (["attachment/read", "attachment/read/chunk"].includes(request.method) &&
        requestedResourceKey && !resourceOwner && this.persistentResources.has(requestedResourceKey) &&
        !this.materializedAttachments.has(requestedResourceKey)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_NOT_READY, message: "Retained staged attachment must be claimed by its next turn before preview" } });
      return;
    }
    if (
      request.method &&
      resourceOwner &&
      (resourceOwner !== client ||
        (request.method === "terminal/attach" && terminalClaimInFlight)) &&
      !(["attachment/read", "attachment/read/chunk"].includes(request.method) &&
        requestedThreadId && this.materializedAttachments.get(requestedResourceKey) === requestedThreadId)
    ) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: RESOURCE_OWNERSHIP_CONFLICT,
            message: "resource belongs to another Gateway client",
          },
        });
      }
      return;
    }
    if (
      request.method?.startsWith("terminal/") &&
      request.method !== "terminal/attach" &&
      requestedTerminalId &&
      this.liveTerminals.has(requestedTerminalId) &&
      !resourceOwner
    ) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: RESOURCE_NOT_READY,
            message: "terminal must be attached before use",
          },
        });
      }
      return;
    }
    if (request.method === "turn/start") {
      const attachmentPaths = attachmentPathsFromTurn(request);
      const foreignAttachment = attachmentPaths.find((path) => {
        const owner = this.resourceOwners.get(`attachment\0${path}`);
        return owner && owner !== client;
      });
      if (foreignAttachment) {
        if (request.id !== undefined) {
          client.send({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: RESOURCE_OWNERSHIP_CONFLICT,
              message: "attachment belongs to another Gateway client",
            },
          });
        }
        return;
      }
      if (attachmentPaths.some(path => {
        const binding = this.retainedAttachmentBindings.get(`attachment\0${path}`);
        return binding && (binding.cleaning || binding.cleared || binding.threadId !== requestedThreadId || binding.owner !== client.authorizationOwner);
      })) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_OWNERSHIP_CONFLICT, message: "Retained attachment is bound to another thread or authorization" } }); return;
      }
      for (const path of attachmentPaths) {
        const key = `attachment\0${path}`;
        if (
          !this.resourceOwners.has(key) &&
          this.persistentResources.has(key)
        ) {
          this.resourceOwners.set(key, client);
        }
      }
    }
    if (!request.method && request.id !== undefined) {
      if (this.sharedInteractions.reply(client, request)) return;
      const owner = this.serverRequests.get(request.id) ?? this.repliedServerRequests.get(request.id);
      if (!owner)
        throw new Error("unsolicited app-server response from Gateway client");
      if (owner !== client)
        throw new Error("server request belongs to another client");
      request = this.sharedInteractions.bindExclusiveReply(client, request);
      this.serverRequests.delete(request.id);
      // Only an interaction actually delivered to this owner may be replayed.
      // The app-server returns its existing receipt; closing the owner here would
      // cancel a newer turn merely because an earlier reply was retransmitted.
      this.repliedServerRequests.set(request.id, client);
      while (this.repliedServerRequests.size > 512) {
        this.repliedServerRequests.delete(this.repliedServerRequests.keys().next().value);
      }
    }

    if (this.adapter.rawPassthrough) {
      this.forwardClientRequest(client, request);
      return;
    }
    const translated = this.adapter.toUpstream(request);
    for (const upstream of translated.upstream) {
      this.forwardClientRequest(client, upstream);
    }
    for (const response of translated.client) client.send(response);
  }

  completeInitialization(response, originClient) {
    this.#lifecycleMetrics.initialize(!response.error);
    finishClientInitialize(originClient, response);
    this.initializeResponse = response.error ? null : cloneWithId(response, null);
    this.initializePending = null;
    const resident = response.result?.capabilities?.experimental?.residentThreads === true;
    if (!response.error) {
      this.shareability = resident ? "resident" : "legacy";
      this.resolveShareability?.(this.shareability);
      this.resolveShareability = null;
    }
    for (const waiter of this.initializeWaiters.splice(0)) {
      this.settleRequest(waiter.budgetId);
      if (!this.clients.has(waiter.client)) {
        waiter.client.pendingInitializeChoices = null;
        continue;
      }
      if (response.error || resident) {
        finishClientInitialize(waiter.client, response);
        waiter.client.send(this.studioPresentation.project(
          this.projectWorkspaceReceiptCapability(cloneWithId(response, waiter.clientId), waiter.client), waiter.client));
      } else {
        waiter.client.pendingInitializeChoices = null;
        waiter.client.send({ jsonrpc: "2.0", method: "server/transportError", params: {
          serverId: this.serverId, message: "legacy app-server requires a dedicated connection",
        } });
        waiter.client.close();
      }
    }
  }

  rewriteClientRequest(client, message) {
    if (!message?.method || message.id === undefined) return message;
    const upstreamId = this.nextRequestId++;
    if (!this.#pendingBudget.admit(upstreamId, client, message)) {
      if (message.method === "initialize") client.pendingInitializeChoices = null;
      client.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000,
        message: "Gateway request capacity reached; request was not forwarded" } });
      return null;
    }
    const webSearchTicket = this.webSearchDiagnostics.claim(client, message, this.initializeResponse?.result?.capabilities?.experimental, this.threadOwners);
    message = this.webSearchDiagnostics.rewrite(message, webSearchTicket);
    const refreshTicket = message.method === HISTORY_REFRESH_METHOD
      ? this.historyRefresh.claim(client, message.params) : null;
    if (message.method === "initialize") message = { ...message, params: backendInitializeParams(message.params, this.nativeManagementOnly) };
    if (message.method === "browser/start") client.browserStarted = true;
    const claimedThreadId =
      message.method === "thread/resume" ? threadIdFrom(message) : null;
    const claimedTerminalId =
      message.method === "terminal/attach"
        ? terminalSessionIdFrom(message)
        : null;
    if (claimedTerminalId) this.terminalClaims.set(claimedTerminalId, client);
    const pending = {
      upstreamId,
      client,
      clientId: message.id,
      method: message.method,
      params: message.params,
      historyViewTicket: this.historyViewLeases.claim(client, message),
      webSearchTicket,
      ...(message[MCP_OAUTH_RECEIVER] ? { oauthReceiver: message[MCP_OAUTH_RECEIVER] } : {}),
      ...(message[MCP_OAUTH_COMPLETION] ? { oauthCompletion: message[MCP_OAUTH_COMPLETION] } : {}),
      ...(refreshTicket ? { refreshTicket } : {}),
      ...(claimedThreadId ? { claimedThreadId } : {}),
      ...(claimedTerminalId ? { claimedTerminalId } : {}),
    };
    if (message[SHARED_RESUME]) {
      pending.sharedResume = true;
      this.sharedThreads.pendingResume(pending);
    }
    if (claimedThreadId && !pending.sharedResume && !this.threadOwners.has(claimedThreadId)) {
      const claim = { [THREAD_RESUME_CLAIM]: true, client, pending };
      pending.threadClaim = claim;
      this.threadClaims.set(claimedThreadId, claim);
    }
    this.sharedThreads.start(pending);
    this.pending.set(upstreamId, pending);
    if (message.method === "initialize") this.initializePending = upstreamId;
    return cloneWithId(message, upstreamId);
  }

  forwardClientRequest(client, message) {
    const workError = this.continuousWork.admit(client, message,
      this.initializeResponse?.result?.capabilities?.experimental, this.threadOwners, this.ephemeralThreadOwners);
    if (workError) {
      client?.send({ jsonrpc: "2.0", id: message.id ?? null, error: workError });
      return;
    }
    if (message.method === "thread/goal/status/readMany" &&
        (client?.initialized !== true || client.threadGoalStatusBatchV1 !== true ||
         this.initializeResponse?.result?.capabilities?.experimental?.threadGoalStatusBatchV1 !== true)) {
      client?.send({ jsonrpc: "2.0", id: message.id ?? null, error: {
        code: -32601, message: "threadGoalStatusBatchV1 is unsupported or was not negotiated",
      } });
      return;
    }
    if (message.method === INTERACTION_STATUS_READ_METHOD) {
      if (client?.initialized !== true || client[INTERACTION_STATUS_READ_CAPABILITY] !== true ||
          this.initializeResponse?.result?.capabilities?.experimental?.[INTERACTION_STATUS_READ_CAPABILITY] !== true) {
        client?.send({ jsonrpc: "2.0", id: message.id ?? null, error: {
          code: -32601, message: `${INTERACTION_STATUS_READ_CAPABILITY} is unsupported or was not negotiated`,
        } });
        return;
      }
      const threadId = threadIdFrom(message);
      if (!threadId || (this.threadOwners.get(threadId) !== client &&
          !this.sharedInteractions.canRead(client, message.params))) {
        client.send({ jsonrpc: "2.0", id: message.id ?? null, error: {
          code: -32023, message: "interaction status read requires the current Gateway thread owner",
        } });
        return;
      }
    }
    if (message.method === THREAD_PRESENCE_READ_METHOD &&
        (client?.initialized !== true || client.threadPresenceReadV1 !== true ||
          this.initializeResponse?.result?.capabilities?.experimental?.[THREAD_PRESENCE_READ_CAPABILITY] !== true)) {
      client.send({ jsonrpc: "2.0", id: message.id ?? null, error: {
        code: -32602, message: `${THREAD_PRESENCE_READ_CAPABILITY} negotiation is required`,
      } });
      return;
    }
    if (message.method === 'attachment/retention/deviceRevoked') {
      client.send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'Parent-only retention operation' } });
      return;
    }
    if (message.method === HISTORY_REFRESH_METHOD) {
      const validId = typeof message.id === "string" ||
        (Number.isSafeInteger(message.id) && message.id >= 0);
      if (message.jsonrpc !== "2.0" || !validId) {
        client.send({ jsonrpc: "2.0", id: validId ? message.id : null,
          error: { code: -32600, message: "History refresh requires a valid JSON-RPC request" } });
        return;
      }
    }
    let upstream;
    try {
      upstream = this.rewriteClientRequest(client, message);
      if (!upstream) return;
    } catch (error) {
      this.settleRequest(this.nextRequestId - 1);
      if (!(error instanceof HistoryRefreshRequestError) && !(error instanceof MigrationViewOwnerError) && !(error instanceof SearchDiagnosticOwnerError)) throw error;
      client.send({ jsonrpc: "2.0", id: message.id,
        error: { code: error.code, message: error.message } });
      return;
    }
    const expectsResponse = Boolean(upstream.method) && upstream.id !== undefined;
    if (expectsResponse) this.#requestLoad.begin(client?.channel, upstream.id);
    const allocation = ['attachment/retention/upload/start', 'attachment/retention/upload/save', 'attachment/retention/reserve'].includes(message.method) || isRetainedTurn(message);
    if (allocation && this.registerRetentionRoute && this.retentionParentV1 && client?.initialized && this.clients.has(client) &&
        this.initializeResponse?.result?.capabilities?.experimental?.stagedAttachmentRetentionReceiptsV1 === true) {
      Promise.resolve().then(() => this.registerRetentionRoute(client.retentionAuthority?.())).then(() => {
        // Registration may have raced revoke/disconnect/timeout. writeMessage
        // repeats the full live-authority check at the exact stdio send point.
        if (this.closed || !this.clients.has(client) || !this.pending.has(upstream.id)) throw new RetentionAuthorityError();
        this.finishClientForward(client, message, upstream, expectsResponse);
      }).catch(() => {
        if (!this.pending.has(upstream.id)) return;
        const pending = this.pending.get(upstream.id);
        this.pending.delete(upstream.id); this.settleRequest(upstream.id);
        this.sharedThreads.response(pending, { error: true });
        this.sharedThreads.abandon(pending);
        this.#resumeNotificationBuffer.discard(pending);
        this.releaseThreadClaim(pending); this.releaseTerminalClaim(pending);
        if (this.clients.has(client)) client.send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Durable retention route unavailable; original outcome unknown' } });
      });
      return;
    }
    this.finishClientForward(client, message, upstream, expectsResponse);
  }

  finishClientForward(client, message, upstream, expectsResponse) {
    try {
      this.writeMessage(upstream, client);
    } catch (error) {
      if (expectsResponse) this.settleRequest(upstream.id);
      else this.repliedServerRequests.delete(upstream.id);
      const pending = this.pending.get(upstream.id);
      if (pending) {
        this.pending.delete(upstream.id);
        this.sharedThreads.response(pending, { error: true });
        this.sharedThreads.abandon(pending);
        this.#resumeNotificationBuffer.discard(pending);
        if (this.initializePending === upstream.id) {
          this.initializePending = null;
          client.pendingInitializeChoices = null;
        }
        this.releaseThreadClaim(pending);
        this.releaseTerminalClaim(pending);
        if (pending.method === "browser/start") client.browserStarted = false;
        if (pending.refreshTicket) this.historyRefresh.abortWrite(pending.refreshTicket);
      }
      if (error instanceof RetentionAuthorityError || error instanceof IntegrationAdmissionError) {
        this.pending.delete(upstream.id);
        client.send({ jsonrpc: "2.0", id: message.id ?? null, error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  }

  async discardRetainedAttachments(client, threadId, paths) {
    const cleared = [];
    const pending = [];
    for (const path of paths) {
      const key = `attachment\0${path}`;
      const binding = this.retainedAttachmentBindings.get(key);
      const owner = this.resourceOwners.get(key);
      const materialized = this.materializedAttachments.get(key);
      if (!this.clients.has(client) || !binding || binding.threadId !== threadId || binding.owner !== client.authorizationOwner ||
          binding.cleaning || (owner && owner !== client) || (materialized && materialized !== threadId)) { pending.push(path); continue; }
      if (binding.cleared) { cleared.push(path); continue; }
      // Claim synchronously before the first await. Retain preserves this exact
      // object and next-turn admission refuses paths while cleanup owns it.
      binding.cleaning = true;
      try {
        const absence = await new Promise(resolve => this.sendInternalRequest("thread/read", { threadId, limit: 1 }, { onResponse: resolve }));
        if (absence.error?.code !== -32021 || absence.error?.message !== `persisted thread not found: ${threadId}`) { pending.push(path); continue; }
        const currentOwner = this.resourceOwners.get(key);
        const currentMaterialized = this.materializedAttachments.get(key);
        if (!this.clients.has(client) || (currentOwner && currentOwner !== client) || this.retainedAttachmentBindings.get(key) !== binding ||
            (currentMaterialized && currentMaterialized !== threadId)) { pending.push(path); continue; }
        if (!currentMaterialized) {
          const response = await new Promise(resolve => this.sendInternalRequest("attachment/delete", { path }, { onResponse: resolve }));
          if (response.error || response.result?.removed !== true) { pending.push(path); continue; }
        }
        binding.cleared = true;
        this.resourceOwners.delete(key);
        this.persistentResources.delete(key);
        this.materializedAttachments.delete(key);
        cleared.push(path);
      } finally { binding.cleaning = false; }
    }
    this.onIdleStateChange?.(this);
    return { cleared, pending };
  }

  settleRequest(id) {
    const entry = this.#pendingBudget.settle(id);
    this.#requestLoad.settle(entry?.channel ?? "other", id);
  }

  expireRequest(id) {
    const waiterIndex = this.initializeWaiters.findIndex(waiter => waiter.budgetId === id);
    if (waiterIndex !== -1) {
      const [waiter] = this.initializeWaiters.splice(waiterIndex, 1);
      // This correlation was never forwarded. Release only its local budget;
      // the shared upstream request keeps its late-response tombstone.
      this.settleRequest(id);
      waiter.client.pendingInitializeChoices = null;
      if (this.clients.has(waiter.client)) waiter.client.send({ jsonrpc: "2.0", id: waiter.clientId,
        error: { code: -32000, message: "Gateway request expired; upstream outcome is unknown. Check its receipt before retrying.", data: GATEWAY_EXPIRED_REQUEST_DATA } });
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    const client = pending.client;
    const viewCleanup = this.historyViewLeases.abandon(pending.historyViewTicket);
    if (viewCleanup) this.sendInternalRequest(viewCleanup.method, viewCleanup.params);
    this.#resumeNotificationBuffer.discard(pending);
    this.sharedThreads.abandon(pending);
    if (pending.method === "initialize" && client) client.pendingInitializeChoices = null;
    if (this.clients.has(client)) client.send({ jsonrpc: "2.0", id: pending.clientId,
      error: { code: -32000, message: "Gateway request expired; upstream outcome is unknown. Check its receipt before retrying.", data: GATEWAY_EXPIRED_REQUEST_DATA } });
    this.releaseThreadClaim(pending);
    this.releaseTerminalClaim(pending);
    if (pending.method === "turn/start") pending.attachmentPaths = attachmentPathsFromTurn({ params: pending.params });
    pending.params = compactRequestParams(pending.params, pending.method);
    this.#pendingBudget.compact(id, Buffer.byteLength(JSON.stringify({ params: pending.params, attachmentPaths: pending.attachmentPaths })));
    if (pending.refreshTicket && client) this.historyRefresh.detach(client);
    delete pending.oauthReceiver;
    delete pending.oauthCompletion;
    const keepRequestOwner = this.clients.has(client) && ["turn/start", "computerUse/recover", 'asyncQuestion/answer',
      "thread/delete", "thread/dispose", THREAD_RUNTIME_HANDOFF_RELEASE].includes(pending.method);
    pending.client = keepRequestOwner ? client : null;
    pending.clientId = null;
    pending.expired = true;
    this.pruneOfficeTaskOwnerHandoff();
    if (pending.method === "thread/start" && pending.params.clientRequestId &&
        this.initializeResponse?.result?.capabilities?.experimental?.threadCreationReceiptsV1 === true) pending.preserveCreationOnResponse = true;
    else if (LATE_CREATION_METHODS.has(pending.method)) pending.cleanupOnResponse = true;
    if (!keepRequestOwner && !this.sessionAttachments.enabled()) {
      if (pending.method === 'asyncQuestion/answer') pending.interruptOnResponse = true;
      if (["turn/start", "computerUse/recover"].includes(pending.method)) {
        pending.interruptOnResponse = true;
        const threadId = threadIdFrom({ method: pending.method, params: pending.params });
        if (threadId) this.beginThreadDrain(threadId);
      }
    }
    if (pending.method === "browser/start" && client) client.browserStarted = false;
    // A late ordinary reply must not bind resources/threads to a null owner.
    if (!keepRequestOwner && !pending.cleanupOnResponse && !pending.preserveCreationOnResponse &&
        !pending.interruptOnResponse && !pending.refreshTicket &&
        !["initialize", "terminal/close", "thread/delete", "thread/dispose", THREAD_RUNTIME_HANDOFF_RELEASE].includes(pending.method)) {
      this.pending.delete(id);
      this.#pendingBudget.compact(id);
      this.detachedRequestIds.add(id);
    }
  }

  sendRefreshCleanup(ticket) {
    if (!ticket) return;
    // Refresh is request-only in app-server. Track the internal response instead of sending
    // a notification that would be ignored or recursively cancelling a cancellation.
    this.sendInternalRequest(HISTORY_REFRESH_METHOD, ticket.params, { refreshTicket: ticket });
  }

  sendInternalRequest(method, params, pendingFields = {}) {
    if (method === "initialize") params = backendInitializeParams(params, this.nativeManagementOnly);
    const id = this.nextRequestId++;
    let message = { jsonrpc: "2.0", id, method, params };
    if (Object.hasOwn(pendingFields, 'migrationSourceProof')) {
      message = migrationSourcePrivateFrame(message, pendingFields.migrationSourceProof);
    }
    const pending = {
      ...pendingFields,
      client: null,
      clientId: null,
      method,
      params,
      internalRequest: true,
    };
    const finish = error => {
      if (this.pending.get(id) !== pending) return false;
      this.pending.delete(id);
      if (method === 'initialize' && this.initializePending === id) this.completeInitialization({ error }, null);
      this.settleRequest(id);
      clearTimeout(pending.internalRequestTimer);
      pending.internalRequestTimer = null;
      if (pending.refreshTicket) this.historyRefresh.complete(pending.refreshTicket, { error });
      pending.onResponse?.({ error });
      this.onIdleStateChange?.(this);
      return true;
    };
    pending.internalRequestTimer = setTimeout(
      () => finish({ message: "internal app-server request timed out" }),
      INTERNAL_REQUEST_TIMEOUT_MS,
    );
    pending.internalRequestTimer.unref?.();
    this.pending.set(id, pending);
    if (!this.safeWriteMessage(message)) {
      finish({ message: "internal app-server request write failed" });
      return null;
    }
    this.onIdleStateChange?.(this);
    return id;
  }

  sendMigrationSourceRequest(method, params, proof) {
    if (method === MIGRATION_SOURCE_INTERNAL_PREFIX + 'target/private/prepare-status' &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('private_credentials_update_required'));
    }
    if (method === MIGRATION_SOURCE_INTERNAL_PREFIX + 'source/private/observe' &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('private_credentials_update_required'));
    }
    if (method === MIGRATION_SOURCE_INTERNAL_PREFIX + 'target/private/prepare' && Object.hasOwn(params ?? {}, 'additionalOffers') &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('private_credentials_update_required'));
    }
    if (['source/private/', 'target/private/'].some(prefix => method.startsWith(MIGRATION_SOURCE_INTERNAL_PREFIX + prefix)) &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('private_credentials_update_required'));
    }
    if ((method === MIGRATION_SOURCE_INTERNAL_PREFIX + 'target/received/read' ||
        method.startsWith(MIGRATION_SOURCE_INTERNAL_PREFIX + 'target/adoption/')) &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_ADOPTION_CAPABILITY] !== true) {
      throw new MigrationSourceBridgeError('source_transfer_unsupported_native');
    }
    if (method.startsWith(MIGRATION_SOURCE_INTERNAL_PREFIX + 'target/attempt/') &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_ATTEMPT_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('source_transfer_authority_unavailable'));
    }
    if (this.closed || !(this.retentionParentV1 || this.migrationSourceParentV1) ||
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_INTERNAL_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('source_transfer_authority_unavailable'));
    }
    if (['peer/recover-target', 'target/summary'].some(suffix => method === MIGRATION_SOURCE_INTERNAL_PREFIX + suffix) &&
        this.initializeResponse?.result?.capabilities?.experimental?.[MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY] !== true) {
      return Promise.reject(new MigrationSourceBridgeError('source_transfer_authority_unavailable'));
    }
    // Validate before allocating a pending request. This explicit lane is not
    // reachable through receive(), and never accepts client authority fields.
    migrationSourcePrivateFrame({ method, params }, proof);
    return new Promise(resolve => this.sendInternalRequest(method, params, {
      migrationSourceProof: proof, onResponse: resolve,
    }));
  }

  async revokeRetainedDevice(params) {
    if (!this.retentionParentV1 || !this.retentionRevocationTrusted || this.closed) throw new RetentionAuthorityError();
    if (!this.initializeResponse) {
      if (this.initializePending !== null) throw new Error('Initialization pending');
      const initialized = await new Promise(resolve => {
        const id = this.sendInternalRequest('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'kcoder-retention-cleanup', version: '1' } }, { onResponse: resolve });
        if (this.pending.has(id)) this.initializePending = id;
      });
      if (initialized.error) throw new RetentionAuthorityError();
    }
    return new Promise(resolve => this.sendInternalRequest('attachment/retention/deviceRevoked', params, { onResponse: resolve }));
  }

  releaseThreadClaim(pending) {
    if (!pending.claimedThreadId) return;
    if (pending.threadClaim && this.threadClaims.get(pending.claimedThreadId) === pending.threadClaim) {
      this.threadClaims.delete(pending.claimedThreadId);
    }
  }

  releaseTerminalClaim(pending) {
    if (!pending.claimedTerminalId) return;
    if (this.terminalClaims.get(pending.claimedTerminalId) === pending.client) {
      this.terminalClaims.delete(pending.claimedTerminalId);
    }
  }

  writeRaw(raw, client, resumePending) {
    if (Buffer.byteLength(raw) > this.maxMessageBytes) {
      throw new Error("Adapted app-server request is too large");
    }
    if (!this.child.stdin.writable || this.child.stdin.destroyed) {
      throw new Error("KCoder app-server stdin is closed");
    }
    if (
      this.child.stdin.writableLength + Buffer.byteLength(raw) + 1 >
      this.maxMessageBytes * 2
    ) {
      throw new Error("KCoder app-server stdin queue is full");
    }
    const resumeStartedAt = resumePending ? this.#lifecycleMetrics.timestamp() : undefined;
    const writable = this.child.stdin.write(`${raw}\n`);
    if (resumePending)
      resumePending.resumeStartedAt = this.#lifecycleMetrics.resumeStarted(resumeStartedAt);
    if (!writable && !this.stdinBackpressured) {
      this.stdinBackpressured = true;
      client?.pause();
      this.child.stdin.once("drain", () => {
        this.stdinBackpressured = false;
        for (const attached of this.clients) attached.resume();
      });
    }
  }

  projectWorkspaceReceiptCapability(message, client) {
    if (message.error || !message.result?.capabilities) return message;
    let ready = false;
    try {
      ready = this.retentionParentV1 && message.result.capabilities.experimental?.workspaceOperationReceiptsV2 === true && Boolean(client?.retentionAuthority?.());
    } catch { /* Missing/stale identity is not a capability. */ }
    // The producer descriptor is private until the full lifecycle capability is enabled.
    const { attachmentUploadAdmission: _privateUploadAdmission, ...publicResult } = message.result;
    const experimental = { ...publicSharedCapabilities(message.result.capabilities.experimental), workspaceOperationReceiptsV2: ready,
      stagedAttachmentRetentionReceiptsV1: false };
    delete experimental[SHARED_THREADS_CAPABILITY];
    if (this.shareability === "resident" && client?.[SHARED_THREADS_CAPABILITY] === true) experimental[SHARED_THREADS_CAPABILITY] = true;
    if (this.targetTransport !== 'local') {
      for (const capability of ['computerUseTurnV1', 'computerUseStatusV1', 'computerUseRecoveryV1', 'computerUseSessionAuthorizationV1']) {
        if (Object.hasOwn(experimental, capability)) experimental[capability] = false;
      }
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
    if (Object.hasOwn(message.result.capabilities.experimental ?? {}, "threadTranscriptObservationV1")) {
      experimental.threadTranscriptObservationV1 = client?.threadTranscriptObservationV1 === true &&
        message.result.capabilities.experimental.threadTranscriptObservationV1 === true;
    }
    return { ...message, result: { ...publicResult, capabilities: { ...message.result.capabilities,
      experimental: this.webSearchDiagnostics.capabilities(projectIntegrationCapabilities(
        this.continuousWork.projectCapabilities(projectTaskExpertCapabilities(projectAsyncQuestionCapabilities(experimental, client), client), client), client), client),
    } } };
  }

  writeMessage(message, client) {
    assertThreadRuntimeHandoffAdmission(message,client,this.initializeResponse?.result?.capabilities?.experimental,this.clients.has(client));
    assertIntegrationAdmission(message, client, this.initializeResponse?.result?.capabilities?.experimental, this.clients.has(client));
    if ((RETENTION_METHODS.has(message.method) || isRetainedTurn(message)) && this.initializeResponse?.result?.capabilities?.experimental?.stagedAttachmentRetentionReceiptsV1 !== true)
      throw new RetentionAuthorityError();
    if (WORKSPACE_RECEIPT_METHODS_V2.has(message.method) && this.initializeResponse?.result?.capabilities?.experimental?.workspaceOperationReceiptsV2 !== true)
      throw new RetentionAuthorityError();
    if (RETENTION_METHODS.has(message.method) || WORKSPACE_RECEIPT_METHODS_V2.has(message.method) || isRetainedTurn(message)) {
      if (!this.retentionParentV1 || !client?.initialized || !this.clients.has(client)) throw new RetentionAuthorityError();
      // Revalidate at the exact synchronous stdio send point, never at cached initialize.
      const authority = client.retentionAuthority?.();
      message = WORKSPACE_RECEIPT_METHODS_V2.has(message.method)
        ? injectWorkspaceReceiptAuthority(message, authority)
        : isRetainedTurn(message) ? injectRetainedTurnAuthority(message, authority) : injectRetentionAuthority(message, authority);
      if (WORKSPACE_RECEIPT_METHODS_V2.has(message.method) || RETENTION_METHODS.has(message.method) || isRetainedTurn(message)) {
        const pending = this.pending.get(message.id);
        if (!pending || pending.client !== client) throw new RetentionAuthorityError();
        if (WORKSPACE_RECEIPT_METHODS_V2.has(message.method)) pending.workspaceReceiptAuthority = JSON.stringify(message[PRIVATE_RETENTION_FIELD]);
        else pending.retentionReceiptAuthority = JSON.stringify(message[PRIVATE_RETENTION_FIELD]);
      }
    }
    const lifecycle = ["server/resources/read", "server/shutdown/idle"].includes(message.method);
    if (message.method && message.id !== undefined &&
        !this.#pendingBudget.records.has(message.id) &&
        !this.#pendingBudget.admit(message.id, lifecycle ? this.#lifecycleRequestOwner : this.#internalRequestOwner,
          message, true, lifecycle ? 2 : this.#pendingBudget.limits.total)) {
      throw new Error("Gateway lifecycle request capacity reached; prior upstream outcome is unknown");
    }
    try {
      this.writeRaw(JSON.stringify(message), client,
        message.method === "thread/resume" ? this.pending.get(message.id) : undefined);
    } catch (error) {
      if (message.method && message.id !== undefined) this.settleRequest(message.id);
      throw error;
    }
    if (message.method && message.id !== undefined) this.#requestLoad.begin(
      client?.channel ?? this.#pendingBudget.records.get(message.id)?.channel ??
      this.pending.get(message.id)?.client?.channel ?? "other", message.id);
  }

  safeWriteMessage(message, client) {
    if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed) return false;
    if (message.id !== undefined && message.method && this.pending.has(message.id) &&
        !this.#pendingBudget.records.has(message.id) &&
        !this.#pendingBudget.admit(message.id, this.#internalRequestOwner, message, true)) {
      this.fail(new Error("Gateway cleanup request capacity reached"));
      return false;
    }
    try {
      this.writeMessage(message, client);
      return true;
    } catch {
      if (message.method && message.id !== undefined) this.settleRequest(message.id);
      return false;
    }
  }

  processStdoutChunk(chunk) {
    let batch;
    try {
      batch = this.stdoutDecoder.push(chunk);
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const dropped of batch.dropped) this.handleDroppedFrame(dropped);
    try {
      for (const line of batch.lines) this.processStdoutLine(line);
    } catch (error) {
      this.fail(error);
    }
  }

  handleDroppedFrame(dropped) {
    const preview = typeof dropped?.preview === "string" ? dropped.preview : "";
    const idMatch = preview.match(/"id"\s*:\s*(\d+)/);
    if (/"jsonrpc"\s*:\s*"2\.0"/.test(preview) && idMatch) {
      const id = Number(idMatch[1]);
      if (this.pending.has(id)) {
        // A single oversized response must not tear down every client sharing
        // this app-server: answer the owning request and keep the pool alive.
        this.routeServerMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32045,
            message: "app-server response exceeded the frame limit",
          },
        });
        return;
      }
    }
    console.error("[KCoder] dropped oversized app-server frame", {
      serverId: this.serverId,
      bytes: dropped?.bytes,
    });
  }

  processStdoutLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { throw new Error('Invalid app-server JSON-RPC frame'); }
    if (message.id === null && [-32700, -32600].includes(message.error?.code)) {
      // All forwarded frames were already parsed and assigned IDs here. An
      // unattributed rejection indicates a corrupted upstream protocol stream;
      // never leave clients waiting or replay potentially mutating requests.
      this.fail(new Error("KCoder app-server rejected a protocol frame; reconnect before retrying"));
      return;
    }
    if (isNativeRemoteHostMethod(message?.method)) {
      if (!this.#nativeRemoteHostBackchannel?.receiveBackend(message)) {
        this.safeWriteMessage({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Native Remote host owner unavailable" } });
      }
      return;
    }
    const translated = this.adapter.fromUpstream(message);
    for (const upstream of translated.upstream) this.writeMessage(upstream);
    for (const clientMessage of translated.client)
      this.routeServerMessage(clientMessage);
  }

  routeServerMessage(message) {
    this.pruneOfficeTaskOwnerHandoff();
    // Question snapshots are notifications, never transport waiters. Request
    // envelopes could overwrite another input's owner or reject its waiter.
    if (message.method === 'asyncQuestion/changed' && message.id !== undefined) return;
    if (hasConflictingTurnIdentity(message)) return;
    // A task/turn pair is local to its app-server lifetime. Check explicit
    // producer identity before changing client turns, closing input or buffering replay.
    const sessionId = this.initializeResponse?.result?.sessionId;
    if (message.id === undefined && ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted', 'asyncQuestion/changed'].includes(message.method) &&
        sessionId && message.params?.serverId !== undefined &&
        message.params.serverId !== `server-${sessionId}`) return;
    if (message.id === undefined && ['turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method) &&
        !threadIdFrom(message)) {
      const turnId = turnIdFrom(message);
      if (!turnId) return;
      // Compatibility turn IDs are task-local. Resolve one original task before
      // buffering, closing input, fencing answer receipts or notifying clients.
      const nestedThreadId = message.params?.turn?.threadId;
      const threads = new Set();
      if (typeof nestedThreadId === 'string' && nestedThreadId) threads.add(nestedThreadId);
      else {
        for (const threadId of this.sharedInteractions.threadsForTurn(turnId)) threads.add(threadId);
        for (const turns of [this.activeTurns, this.threadDrains]) {
          for (const [threadId, turn] of turns) if (turn.turnId === turnId) threads.add(threadId);
        }
        for (const pending of this.pending.values()) {
          if (['turn/start', 'computerUse/recover', 'asyncQuestion/answer'].includes(pending.method) && pending.params?.threadId)
            threads.add(pending.params.threadId);
        }
        // A terminal may arrive before its admission or first question. Keep the
        // single-task legacy path without guessing across multiple task bindings.
        if (!threads.size) {
          for (const bindings of [this.threadOwners, this.threadClaims])
            for (const threadId of bindings.keys()) threads.add(threadId);
        }
      }
      if (threads.size !== 1) return;
      message = { ...message, params: { ...message.params, threadId: threads.values().next().value } };
    }
    if (message.method && message.id === undefined) {
      const threadId = threadIdFrom(message);
      if (!this.#resumePreappliedNotifications.has(message)) this.sharedThreads.capture(threadId, message);
      const claim = threadId ? this.threadClaims.get(threadId) : null;
      const pending = claim?.[THREAD_RESUME_CLAIM] === true ? claim.pending : null;
      if (
        pending &&
        pending.method === "thread/resume" &&
        pending.claimedThreadId === threadId &&
        pending.threadClaim === claim &&
        this.pending.get(pending.upstreamId) === pending &&
        !pending.expired &&
        pending.clientId !== null &&
        this.clients.has(pending.client) &&
        !this.threadOwners.has(threadId) &&
        this.ownerFor(message) === null
      ) {
        // Apply live interaction and question fences before reserving recovery capacity.
        if (!this.sharedInteractions.acceptsResolution(message)) return;
        if (!allowsAsyncQuestionNotification(message, pending.client,
          this.initializeResponse?.result?.capabilities?.experimental)) return;
        this.#applyResumeHeldNotificationLifecycle(message);
        this.#resumeNotificationBuffer.capture(pending, message);
        return;
      }
    }
    if (!message.method && message.id !== undefined) this.settleRequest(message.id);
    if (this.idleShutdown.response(message)) return;
    if (
      ["turn/completed", "turn/failed", "turn/interrupted"].includes(
        message.method,
      ) && !this.#resumePreappliedNotifications.has(message)
    ) {
      this.clearTerminalTurn(message);
    }
    // Internal schedule admissions have no client RPC owner. Do not discard
    // their failures as unknown request IDs and leave an empty running thread.
    if (!message.method && this.automationAdmissions.has(message.id)) {
      const admission = this.automationAdmissions.get(message.id);
      this.automationAdmissions.delete(message.id);
      if (message.error) {
        this.activeAutomationThreads.delete(admission.threadId);
        this.onIdleStateChange?.(this);
        const failure = { jsonrpc: '2.0', method: 'automation/runFailed', params: {
          ...admission, requestId: message.id, error: message.error,
        }};
        this.automationFailures.set(admission.threadId, failure);
        while (this.automationFailures.size > 2048) this.automationFailures.delete(this.automationFailures.keys().next().value);
        this.broadcast(failure);
      }
      return;
    }
    if (message.id !== undefined && !message.method) {
      if (this.detachedRequestIds.delete(message.id)) { this.settleRequest(message.id); this.onIdleStateChange?.(this); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.internalRequestTimer);
      pending.internalRequestTimer = null;
      // A forwarded request is only "unfinished" until its answer routes back.
      this.settleRequest(message.id);
      this.#lifecycleMetrics.resumeFinished(pending.resumeStartedAt, !message.error);
      if (pending.internalRequest) this.onIdleStateChange?.(this);
      let response = cloneWithId(message, pending.clientId);
      response = projectThreadRuntimeHandoffResponse(response,pending);
      response = projectAsyncQuestionResponse(response, pending);
      const terminalTurnReceipt = pending.method === 'turn/start' && !response.error &&
        ['completed', 'failed', 'interrupted'].includes(response.result?.turn?.status);
      let resumeHandoffMessages = [];
      let resumeFreshOwnerCommitted = false;
      if (WORKSPACE_RECEIPT_METHODS_V2.has(pending.method) || RETENTION_METHODS.has(pending.method) || isRetainedTurn({ method: pending.method, params: pending.params })) {
        const workspaceReceipt = WORKSPACE_RECEIPT_METHODS_V2.has(pending.method);
        let currentAuthority = null;
        try {
          if (this.clients.has(pending.client) && pending.client.initialized) {
            const inject = workspaceReceipt ? injectWorkspaceReceiptAuthority : isRetainedTurn({ method: pending.method, params: pending.params }) ? injectRetainedTurnAuthority : injectRetentionAuthority;
            const current = inject({ jsonrpc: "2.0", id: pending.clientId,
              method: pending.method, params: pending.params }, pending.client.retentionAuthority?.());
            currentAuthority = JSON.stringify(current[PRIVATE_RETENTION_FIELD]);
          }
        } catch { /* A missing or changed parent cannot certify the old response. */ }
        const sentAuthority = workspaceReceipt ? pending.workspaceReceiptAuthority : pending.retentionReceiptAuthority;
        if (!sentAuthority || currentAuthority !== sentAuthority) {
          response = { jsonrpc: "2.0", id: pending.clientId,
            error: { code: -32001, message: workspaceReceipt
              ? "Workspace receipt authority changed; original outcome remains unknown"
              : "Retention authority changed; original outcome remains unknown" } };
        }
      }
      this.sharedThreads.response(pending, response);
      response = this.webSearchDiagnostics.response(response, pending.webSearchTicket);
      pending.onResponse?.(response);
      try {
        const cleanup = this.historyViewLeases.response(pending.historyViewTicket, response,
          !pending.expired && this.clients.has(pending.client));
        if (cleanup) this.sendInternalRequest(cleanup.method, cleanup.params);
        if (this.historyViewLeases.abandoned(pending.historyViewTicket) && response.result?.lease?.state === 'active')
          response = { jsonrpc: '2.0', id: pending.clientId, error: { code: -32020, message: 'Expired history view cleanup is unconfirmed; explicitly open a new view' } };
      } catch (error) {
        if (!(error instanceof MigrationViewOwnerError)) throw error;
        response = { jsonrpc: '2.0', id: pending.clientId, error: { code: error.code, message: error.message } };
      }
      if (pending.refreshTicket) {
        this.sendRefreshCleanup(this.historyRefresh.complete(pending.refreshTicket, response));
        if (!pending.expired && this.clients.has(pending.client)) pending.client.send(projectClientResponse(response, pending));
        return;
      }
      if (pending.method === "initialize") this.completeInitialization(response, pending.client);
      if (pending.method !== "thread/resume") this.releaseThreadClaim(pending);
      if (["turn/start", "computerUse/recover"].includes(pending.method) && pending.interruptOnResponse &&
          (response.error || terminalTurnReceipt)) {
        const rejectedThread = threadIdFrom({ method: pending.method, params: pending.params });
        const drain = rejectedThread ? this.threadDrains.get(rejectedThread) : null;
        if (drain && !drain.turnId && !this.activeTurns.has(rejectedThread)) this.finishThreadDrain(rejectedThread);
      }
      if (pending.preserveCreationOnResponse) return;
      if (pending.cleanupOnResponse) {
        this.compensateLateCreation(pending, response);
        return;
      }
      if (this.mcpOAuth.response(pending, response)) {
        if (!response.error) this.mcpFlowOwners.delete(pending.params?.flowId);
        else this.cancelMcpFlow(pending.params?.flowId);
        return;
      }
      if (!response.error && pending.method === "mcp/login" &&
          typeof response.result?.flowId === "string" && this.clients.has(pending.client)) {
        this.mcpFlowOwners.set(response.result.flowId, {
          client: pending.client, expiresAt: Date.now() + 600_000,
        });
      }
      if (!response.error && ["mcp/callback", "mcp/cancel"].includes(pending.method)) {
        this.mcpFlowOwners.delete(pending.params?.flowId);
      }
      if (pending.method === "thread/resume" && !pending.sharedResume) {
        const requestedThreadId = pending.claimedThreadId;
        const resumedThreadId = threadIdFrom(response.result);
        const currentOwner = requestedThreadId ? this.threadOwners.get(requestedThreadId) : null;
        const claim = pending.threadClaim;
        const claimIsCurrent = Boolean(
          claim &&
          claim[THREAD_RESUME_CLAIM] === true &&
          claim.pending === pending &&
          claim.client === pending.client &&
          this.threadClaims.get(requestedThreadId) === claim
        );
        const alreadyOwnedByClient = !claim && currentOwner === pending.client;
        if (response.error || pending.expired || !this.clients.has(pending.client)) {
          this.#resumeNotificationBuffer.discard(pending);
          this.releaseThreadClaim(pending);
        } else if (
          !requestedThreadId ||
          resumedThreadId !== requestedThreadId ||
          (!claimIsCurrent && !alreadyOwnedByClient) ||
          (currentOwner && currentOwner !== pending.client)
        ) {
          this.#resumeNotificationBuffer.discard(pending);
          this.releaseThreadClaim(pending);
          response = { jsonrpc: "2.0", id: pending.clientId, error: {
            code: -32023,
            message: "thread resume ownership changed before its response; reconcile the current owner before retrying",
          } };
        } else {
          const handoff = this.#resumeNotificationBuffer.take(pending);
          this.releaseThreadClaim(pending);
          if (handoff.overflowed) {
            response = makeResumeNotificationHandoffIncompleteResponse(pending.clientId);
          } else {
            if (!currentOwner) {
              this.threadOwners.set(requestedThreadId, pending.client);
              resumeFreshOwnerCommitted = true;
            }
            resumeHandoffMessages = handoff.messages;
          }
        }
      }
      let sharedHandoffMessages = [];
      if (pending.sharedResume) {
        const handoff = this.sharedThreads.finishResume(pending);
        if (!response.error && !pending.expired && this.clients.has(pending.client)) {
          if (threadIdFrom(response.result) !== pending.claimedThreadId || handoff.overflowed) {
            response = makeResumeNotificationHandoffIncompleteResponse(pending.clientId);
          } else {
            if (!this.threadOwners.has(pending.claimedThreadId)) {
              this.threadOwners.set(pending.claimedThreadId, pending.client);
              resumeFreshOwnerCommitted = true;
            }
            this.sharedThreads.join(pending.claimedThreadId, pending.client);
            sharedHandoffMessages = handoff.messages;
          }
        }
      }
      let officeTask = acceptedOfficeTask(pending, response);
      if (officeTask && this.clients.has(pending.client)) {
        const owner = this.threadOwners.get(officeTask.threadId);
        if (owner && owner !== pending.client) {
          officeTask = null;
          response = { jsonrpc: '2.0', id: pending.clientId, error: { code: -32023,
            message: 'Office task already has another connected owner; reconcile the original operation' } };
        } else {
          this.threadOwners.set(officeTask.threadId, pending.client);
          if (['queued', 'running', 'waiting_for_user'].includes(officeTask.state))
            this.activeTurns.set(officeTask.threadId, { owner: pending.client, turnId: officeTask.turnId });
        }
      } else officeTask = null;
      if (!response.error) this.studioPresentation.response(pending.method, response.result);
      // Async-question receipts already certify the captured request's task.
      // Result metadata must never be interpreted as another routing envelope.
      const threadId = ASYNC_QUESTION_METHODS.has(pending.method)
        ? pending.params?.threadId
        : threadIdFrom(response.result) ??
          threadIdFrom({ method: pending.method, params: pending.params });
      if (
        !response.error &&
        threadId &&
        (pending.method === "thread/start" ||
          (pending.method === "thread/fork" && response.result?.ephemeral === true))
      ) {
        const previousOwner=this.threadOwners.get(threadId);
        if(previousOwner&&previousOwner!==pending.client&&this.initializeResponse?.result?.capabilities?.experimental?.mcpAppsV1===true)
          this.sendInternalRequest('mcp/apps/revoke',{threadId});
        this.threadOwners.set(threadId, pending.client);
        if (pending.method === "thread/fork" && response.result?.ephemeral === true) {
          this.continuousWork.noteEphemeralOwner(threadId);
          this.ephemeralThreadOwners.set(threadId, pending.client);
        }
      }
      if (
        !response.error &&
        threadId &&
        (["thread/delete", "thread/dispose"].includes(pending.method)
          || (pending.method === THREAD_RUNTIME_HANDOFF_RELEASE && confirmsReleasedThreadRuntime(pending.params,response.result))) &&
        this.threadOwners.get(threadId) === pending.client
      ) {
        this.threadOwners.delete(threadId);
        this.studioPresentation.deleteThread(threadId);
        const retirement = this.ephemeralThreadOwners.has(threadId) ? this.continuousWork.retireEphemeral(threadId) : null;
        this.ephemeralThreadOwners.delete(threadId);
        this.continuousWork.settleEphemeral(threadId, retirement, response,
          this.initializeResponse?.result?.capabilities?.experimental, this.ephemeralThreadOwners);
      }
      // A retry can return a saved terminal turn without admitting execution.
      // Preserve any newer async answer's owner and never interrupt the old turn.
      if (!response.error && !terminalTurnReceipt && threadId && ["turn/start", "computerUse/recover"].includes(pending.method)) {
        const turnId = turnIdFrom(response.result);
        if (turnId && pending.interruptOnResponse) {
          this.beginThreadDrain(threadId, turnId);
          this.sendInternalRequest("turn/interrupt", { threadId, turnId });
        } else if (turnId && pending.client && !(pending.method === "computerUse/recover" && response.result?.status === "completed")) {
          this.activeTurns.set(threadId, { owner: pending.client, turnId,
            ...(pending.params?.clientPresentation ? { clientPresentation: structuredClone(pending.params.clientPresentation) } : {}) });
        }
      }
      // startedTurn describes only a new admission by this RPC, including a
      // retry that recovers a durably saved but previously unclaimed answer.
      if (!response.error && threadId && pending.method === 'asyncQuestion/answer' && !pending.asyncQuestionBindingReleased &&
          response.result?.accepted === true && response.result?.startedTurn?.status === 'running') {
        const turnId = turnIdFrom({ turn: response.result.startedTurn });
        const alreadyTerminal = pending.asyncQuestionTerminalUnknown || pending.asyncQuestionTerminalTurns?.has(turnId);
        const active = this.activeTurns.get(threadId);
        // A late receipt cannot replace a different observed turn. Still cancel
        // the disconnected client's exact admission without draining its peer.
        const canTrackTurn = !active || active.turnId === turnId;
        if (turnId && !alreadyTerminal && pending.interruptOnResponse) {
          if (canTrackTurn) this.beginThreadDrain(threadId, turnId);
          this.sendInternalRequest('turn/interrupt', { threadId, turnId });
        } else if (turnId && !alreadyTerminal && canTrackTurn && this.clients.has(pending.client)) {
          this.threadOwners.set(threadId, pending.client);
          this.activeTurns.set(threadId, { turnId, owner: pending.client });
        }
      }
      if (!response.error && threadId && pending.client && !pending.expired &&
          this.clients.has(pending.client) && ["thread/start", "thread/resume"].includes(pending.method)) {
        this.sharedThreads.join(threadId, pending.client);
        if (pending.method === 'thread/start' || pending.client.sessionLifetimeV1 !== true)
          this.sessionAttachments.attach(pending.client, threadId);
      }
      if (!response.error && (["thread/delete", "thread/dispose"].includes(pending.method) ||
          (pending.method === THREAD_RUNTIME_HANDOFF_RELEASE && confirmsReleasedThreadRuntime(pending.params, response.result)))) {
        this.sharedThreads.delete(threadId);
        // Confirmed deletion or runtime release ends the original binding even
        // while an answer admission receipt is in transit. Preserve the answer
        // fact without recreating ownership or sending stale cleanup work.
        for (const answer of this.pending.values()) {
          if (threadId === pending.params?.threadId && answer.method === 'asyncQuestion/answer' &&
              answer.params?.threadId === threadId)
            answer.asyncQuestionBindingReleased = true;
        }
      }
      this.bindCreatedResource(pending, response);
      this.releaseTerminalClaim(pending);
      this.promoteReferencedAttachments(pending, response);
      let resumeResponseSent = false;
      if (!pending.expired && this.clients.has(pending.client)) {
        const projected = pending.method === "initialize"
          ? this.studioPresentation.project(this.projectWorkspaceReceiptCapability(response, pending.client), pending.client)
          : response;
        try {
          const clientResponse = this.continuousWork.projectResponse(projectClientResponse(projected, pending), pending,
            this.threadOwners, this.ephemeralThreadOwners);
          let sendResult;
          if ((pending.method?.startsWith('work/') || pending.method === 'thread/resume') &&
              typeof pending.client.sendWithQueueStatus === 'function') {
            const delivery = pending.client.sendWithQueueStatus(clientResponse);
            // Backpressure can leave a successfully queued resume awaiting drain.
            // Keep its membership and question handoff once the frame is queued.
            sendResult = delivery.queued;
            if (delivery.queued === true) this.continuousWork.observe(pending.client, pending, clientResponse);
          } else {
            sendResult = pending.client.send(clientResponse);
            if (sendResult !== false) this.continuousWork.observe(pending.client, pending, clientResponse);
          }
          resumeResponseSent = sendResult !== false;
        } catch (error) {
          if (pending.method === 'thread/resume') this.sharedThreads.leave(pending.claimedThreadId, pending.client);
          if (resumeFreshOwnerCommitted && this.threadOwners.get(pending.claimedThreadId) === pending.client) {
            this.threadOwners.delete(pending.claimedThreadId);
          }
          throw error;
        }
      }
      if (resumeResponseSent && pending.sharedResume) {
        for (const notification of sharedHandoffMessages) this.sendServerNotification(pending.client, notification);
      } else if (pending.sharedResume && !resumeResponseSent) {
        this.sharedThreads.leave(pending.claimedThreadId, pending.client);
      }
      if (!response.error && pending.method === 'thread/resume' && this.clients.has(pending.client)) {
        this.sharedInteractions.replay(threadId, pending.client);
        const failure = this.automationFailures.get(threadId);
        if (failure) pending.client.send(failure);
      }

      if (
        !response.error &&
        pending.method === "runtime.workspaces.remove" &&
        response.result?.accepted !== false
      ) {
        this.onWorkspaceRemoved?.(pending.params);
      }
      if (
        resumeResponseSent &&
        resumeHandoffMessages.length > 0 &&
        this.clients.has(pending.client) &&
        this.threadOwners.get(pending.claimedThreadId) === pending.client
      ) {
        for (const notification of resumeHandoffMessages) this.routeServerMessage(notification);
      } else if (
        resumeFreshOwnerCommitted &&
        !resumeResponseSent &&
        this.threadOwners.get(pending.claimedThreadId) === pending.client
      ) {
        this.threadOwners.delete(pending.claimedThreadId);
        this.sharedThreads.leave(pending.claimedThreadId, pending.client);
      }
      this.#officeTaskOwnerHandoff.settle(pending, resumeResponseSent ? officeTask : null,
        held => this.routeServerMessage(held), held => this.refuseUnownedOfficeInteraction(held));
      if (officeTask && !resumeResponseSent && this.threadOwners.get(officeTask.threadId) === pending.client) {
        this.threadOwners.delete(officeTask.threadId);
        this.activeTurns.delete(officeTask.threadId);
      }
      return;
    }

    if (message.method && message.id === undefined && !this.ownerFor(message)
      && this.#officeTaskOwnerHandoff.capture(message, this.pending.values())) return;
    const resumePreapplied = this.#resumePreappliedNotifications.has(message);
    if (!resumePreapplied && !this.sharedInteractions.resolved(message)) return;
    if (message.method === 'turn/started' && !resumePreapplied) this.automationFailures.delete(threadIdFrom(message));
    if (message.method === 'automation/stateChanged' && message.id === undefined) {
      const { jobCount, pendingCount } = message.params ?? {};
      if (Number.isSafeInteger(jobCount) && jobCount >= 0 && Number.isSafeInteger(pendingCount) && pendingCount >= 0) {
        this.projectAutomationJobCount = jobCount;
        this.projectAutomationPendingCount = pendingCount;
        this.onIdleStateChange?.(this);
      }
      return;
    }
    if (message.method === 'automation/runStarted' && message.id === undefined) {
      const threadId = threadIdFrom(message);
      if (threadId) {
        if (!resumePreapplied) {
          this.automationThreads.add(threadId);
          if (typeof message.params?.requestId === 'string') {
            this.automationAdmissions.set(message.params.requestId, { threadId, jobId: message.params.jobId });
          }
          this.activeAutomationThreads.add(threadId);
          this.onIdleStateChange?.(this);
          while (this.automationThreads.size > 2048) this.automationThreads.delete(this.automationThreads.values().next().value);
        }
        if (resumePreapplied) {
          const owner = this.ownerFor(message);
          if (owner) this.sendServerNotification(owner, message);
        } else this.broadcast(message);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      // An early Office interaction owns its transport ID before adoption.
      // A collision cannot bypass that binding by naming an already-owned task,
      // or settle its waiter through another task's lifecycle refusal.
      if (this.#officeTaskOwnerHandoff.hasRequest(message.id)) return;
      if (this.sharedInteractions.rejectUnownedRequest(message)) return;
      const owner = this.ownerFor(message) ?? (this.automationThreads.has(threadIdFrom(message))
        ? [...this.clients].find(client => client.channel === 'runtime' && client.initialized && !client.nativeManagementOnly) : null);
      if (!owner) {
        if (this.#officeTaskOwnerHandoff.capture(message, this.pending.values())) return;
        this.refuseUnownedOfficeInteraction(message);
        return;
      }
      this.serverRequests.set(message.id, owner);
      this.sharedInteractions.request(message, owner);
      owner.send(message);
      return;
    }
    if (message.method === 'turn/completed' && !resumePreapplied && this.activeAutomationThreads.delete(threadIdFrom(message))) {
      this.onIdleStateChange?.(this);
    }
    const owner = this.ownerFor(message);
    this.sharedThreads.notify(threadIdFrom(message), message, owner);
    if (owner) this.sendServerNotification(owner, message);
    else if (this.automationThreads.has(threadIdFrom(message))) this.broadcast(message);
    else if (!threadIdFrom(message) && !this.resourceKeyFrom(message))
      this.broadcast(message);
    if (message.method === "terminal/exit") {
      const sessionId = terminalSessionIdFrom(message);
      if (sessionId) {
        this.exitedTerminalIds.add(sessionId);
        while (this.exitedTerminalIds.size > 1_024) {
          this.exitedTerminalIds.delete(
            this.exitedTerminalIds.values().next().value,
          );
        }
        this.forgetTerminal(sessionId);
      }
    }
  }

  #applyResumeHeldNotificationLifecycle(message) {
    // Settle the first valid interaction receipt before buffering delivery.
    // Conflicting replays must not consume recovery capacity or reopen input.
    this.sharedInteractions.resolved(message);
    this.#resumePreappliedNotifications.add(message);
    if (["turn/completed", "turn/failed", "turn/interrupted"].includes(message.method)) {
      this.clearTerminalTurn(message);
    }
    const threadId = threadIdFrom(message);
    if (message.method === "turn/started") this.automationFailures.delete(threadId);
    if (message.method === "automation/runStarted" && threadId) {
      this.automationThreads.add(threadId);
      if (typeof message.params?.requestId === "string") {
        this.automationAdmissions.set(message.params.requestId, { threadId, jobId: message.params.jobId });
      }
      this.activeAutomationThreads.add(threadId);
      this.onIdleStateChange?.(this);
      while (this.automationThreads.size > 2048) this.automationThreads.delete(this.automationThreads.values().next().value);
    }
    if (message.method === "turn/completed" && this.activeAutomationThreads.delete(threadId)) {
      this.onIdleStateChange?.(this);
    }
  }

  refuseUnownedOfficeInteraction(message) {
    if (message.id === undefined) return;
    if (this.sharedInteractions.rejectUnownedRequest(message, true)) return;
    this.safeWriteMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32040,
      message: `app-server request has no connected owner: ${message.method}` } });
  }

  pruneOfficeTaskOwnerHandoff() {
    this.#officeTaskOwnerHandoff.prune(pending => isOfficeTaskAdoption(pending)
      && this.pending.get(pending.upstreamId) === pending && this.clients.has(pending.client),
    held => this.refuseUnownedOfficeInteraction(held));
  }

  ownerFor(message) {
    const threadId = threadIdFrom(message);
    const owner = threadId ? this.threadOwners.get(threadId) : null;
    if (owner && this.clients.has(owner)) return owner;
    const resourceKey = this.resourceKeyFrom(message);
    const sessionId = message?.method?.startsWith("terminal/")
      ? terminalSessionIdFrom(message)
      : null;
    const resourceOwner = resourceKey
      ? (this.resourceOwners.get(resourceKey) ??
        (sessionId ? this.terminalClaims.get(sessionId) : null))
      : null;
    return resourceOwner && this.clients.has(resourceOwner)
      ? resourceOwner
      : null;
  }

  clearTerminalTurn(message) {
    const threadId = threadIdFrom(message);
    const turnId = turnIdFrom(message);
    if (!threadId) return;
    for (const pending of this.pending.values()) {
      if (pending.method !== 'asyncQuestion/answer' || pending.params?.threadId !== threadId) continue;
      if (!turnId) { pending.asyncQuestionTerminalUnknown = true; continue; }
      pending.asyncQuestionTerminalTurns ??= new Set();
      // Replayed terminal frames do not consume another completion identity.
      if (pending.asyncQuestionTerminalTurns.has(turnId)) continue;
      if (pending.asyncQuestionTerminalTurns.size < 64) pending.asyncQuestionTerminalTurns.add(turnId);
      else pending.asyncQuestionTerminalUnknown = true;
    }
    const active = this.activeTurns.get(threadId);
    if (active && (!turnId || active.turnId === turnId))
      this.activeTurns.delete(threadId);
    const drain = this.threadDrains.get(threadId);
    if (drain && (!turnId || !drain.turnId || drain.turnId === turnId)) {
      this.finishThreadDrain(threadId);
    }
  }

  beginThreadDrain(threadId, turnId = null) {
    if (!threadId) return;
    const existing = this.threadDrains.get(threadId);
    if (existing) {
      if (turnId) existing.turnId = turnId;
      return;
    }
    const drain = {
      turnId,
      queue: [],
      timer: setTimeout(
        () => this.finishThreadDrain(threadId, false),
        THREAD_DRAIN_TIMEOUT_MS,
      ),
    };
    drain.done = new Promise(resolve => { drain.resolveDone = resolve; });
    drain.timer.unref?.();
    this.threadDrains.set(threadId, drain);
  }

  finishThreadDrain(threadId, completed = true) {
    const drain = this.threadDrains.get(threadId);
    if (!drain) return;
    clearTimeout(drain.timer);
    drain.resolveDone?.(completed);
    const queue = drain.queue.splice(0);
    if (!completed) {
      // A waiting deadline is not evidence that the upstream turn has stopped.
      drain.timedOut = true;
      for (const entry of queue) {
        if (this.clients.has(entry.client)) this.rejectUnconfirmedDrain(entry.client, entry.id);
      }
      return;
    }
    this.threadDrains.delete(threadId);
    for (const entry of queue) {
      if (!this.clients.has(entry.client)) continue;
      queueMicrotask(() => {
        if (this.clients.has(entry.client))
          this.receive(entry.client, entry.raw);
      });
    }
  }

  rejectUnconfirmedDrain(client, id) {
    client.send({ jsonrpc: "2.0", id, error: {
      code: -32043, message: "Unable to confirm the previous turn has stopped; retry after its terminal event",
    } });
  }

  resourceKeyFrom(message) {
    const params = message?.params ?? message;
    if (!params || typeof params !== "object") return null;
    const method = String(message?.method ?? "");
    if (WIKI_ARCHIVE_OWNED_METHODS.has(method) && typeof params.transferId === "string" && params.transferId) {
      return `wiki-archive\0${params.transferId}`;
    }
    if (STAGED_INPUT_METHODS.has(method) && typeof params.attachmentPath === "string") {
      return `attachment\0${params.attachmentPath}`;
    }

    if (
      method.startsWith("attachment/upload/") &&
      typeof params.upload_id === "string"
    ) {
      return `attachment-upload\0${params.upload_id}`;
    }
    if (
      [
        "attachment/read",
        "attachment/read/chunk",
        "attachment/delete",
      ].includes(method) &&
      typeof params.path === "string"
    ) {
      return `attachment\0${params.path}`;
    }
    const terminalId = method.startsWith("terminal/")
      ? terminalSessionIdFrom(message)
      : null;
    if (typeof terminalId === "string") return `terminal\0${terminalId}`;
    const browserId =
      params.browserId ??
      params.sessionId ??
      (method === 'browser/profile/humanAction' ? params.action?.session_id : null) ??
      (method.startsWith("browser/") ? params.session_id : null) ??
      params.browser?.id ??
      params.session?.id;
    if (typeof browserId === "string") return `browser\0${browserId}`;
    return null;
  }

  bindCreatedResource(pending, response) {
    if (response.error) {
      if (pending.method === "browser/start" && pending.client) pending.client.browserStarted = false;
      if (pending.method === "attachment/upload/finish") {
        const uploadKey = this.resourceKeyFrom({
          method: pending.method,
          params: pending.params,
        });
        if (uploadKey) this.resourceOwners.delete(uploadKey);
      }
      return;
    }
    const result = response.result;
    if (pending.method === "workspace/file/importAttachment" && result?.status === "uploaded") {
      const key = this.resourceKeyFrom({ method: pending.method, params: pending.params });
      if (key) this.resourceOwners.delete(key);
    }

    if (WIKI_ARCHIVE_START_METHODS.has(pending.method) && typeof result?.transferId === "string") {
      // The upstream archive registry retains one current collection per process.
      // A successful new admission supersedes all previous terminal transfer IDs.
      for (const key of this.resourceOwners.keys()) if (key.startsWith("wiki-archive\0")) this.resourceOwners.delete(key);
      this.resourceOwners.set(`wiki-archive\0${result.transferId}`, pending.client);
    }
    if (pending.method === "knowledge/archiveTransfer/cancel") {
      const key = this.resourceKeyFrom({ method: pending.method, params: pending.params });
      if (key) this.resourceOwners.delete(key);
    }
    if (pending.method === "knowledge/source/directoryStage" && Array.isArray(result?.items)) {
      for (const item of result.items) if (typeof item?.attachmentPath === "string") {
        this.resourceOwners.set(`attachment\0${item.attachmentPath}`, pending.client);
      }
    }

    if (pending.method.startsWith('cron/')) {
      if (Number.isSafeInteger(result?.jobCount) && result.jobCount >= 0) this.projectAutomationJobCount = result.jobCount;
      else if (Array.isArray(result?.jobs)) this.projectAutomationJobCount = result.jobs.length;
      else if (result?.job) this.projectAutomationJobCount = Math.max(1, this.projectAutomationJobCount);
      this.onIdleStateChange?.(this);
    }
    if (pending.method === "terminal/start") {
      const id = terminalSessionIdFrom(result);
      if (id) {
        if (this.exitedTerminalIds.delete(id)) return;
        const wasLive = this.liveTerminals.has(id);
        this.liveTerminals.add(id);
        this.resourceOwners.set(`terminal\0${id}`, pending.client);
        if (!wasLive) this.onIdleStateChange?.(this);
      }
    }
    if (pending.method === "terminal/attach") {
      const id = terminalSessionIdFrom(result) ?? pending.claimedTerminalId;
      if (id && pending.client) {
        if (this.exitedTerminalIds.delete(id)) return;
        const wasLive = this.liveTerminals.has(id);
        this.liveTerminals.add(id);
        this.resourceOwners.set(`terminal\0${id}`, pending.client);
        if (!wasLive) this.onIdleStateChange?.(this);
      }
    }
    if (pending.method === "browser/start") {
      const id =
        result?.browser?.id ??
        result?.session?.id ??
        result?.browserId ??
        result?.sessionId ??
        result?.session_id;
      if (typeof id === "string")
        this.resourceOwners.set(`browser\0${id}`, pending.client);
    }
    if (
      (pending.method === "attachment/save" || WIKI_ARTIFACT_METHODS.has(pending.method)) &&
      typeof result?.path === "string"
    ) {
      this.resourceOwners.set(`attachment\0${result.path}`, pending.client);
    }
    if (
      pending.method === "attachment/upload/start" &&
      typeof result?.upload_id === "string"
    ) {
      this.resourceOwners.set(
        `attachment-upload\0${result.upload_id}`,
        pending.client,
      );
    }
    if (
      pending.method === "attachment/upload/finish" &&
      typeof result?.path === "string"
    ) {
      const uploadKey = this.resourceKeyFrom({
        method: pending.method,
        params: pending.params,
      });
      if (uploadKey) this.resourceOwners.delete(uploadKey);
      this.resourceOwners.set(`attachment\0${result.path}`, pending.client);
    }
    if (
      [
        "terminal/close",
        "browser/close",
        "attachment/delete",
        "attachment/upload/cancel",
      ].includes(pending.method)
    ) {
      if (pending.method === "browser/close" && result?.closed !== true) return;
      const key = this.resourceKeyFrom({
        method: pending.method,
        params: pending.params,
      });
      const closedOwnBrowser = pending.method === "browser/close" && key && this.resourceOwners.get(key) === pending.client;
      if (key) {
        this.resourceOwners.delete(key);
        this.persistentResources.delete(key);
        this.materializedAttachments.delete(key);
      }
      if (pending.method === "terminal/close") {
        const sessionId = terminalSessionIdFrom({
          method: pending.method,
          params: pending.params,
        });
        if (sessionId) this.forgetTerminal(sessionId);
      }
      if (closedOwnBrowser && pending.client) pending.client.browserStarted = false;
    }
  }

  forgetTerminal(sessionId) {
    const wasLive = this.liveTerminals.delete(sessionId);
    this.resourceOwners.delete(`terminal\0${sessionId}`);
    this.terminalClaims.delete(sessionId);
    if (wasLive) this.onIdleStateChange?.(this);
  }

  cancelArchiveTransfer(transferId) {
    // Stateful cleanup is a real RPC, never an unsupported executable notification.
    this.sendInternalRequest("knowledge/archiveTransfer/cancel", { transferId });
  }

  cancelMcpFlow(flowId) {
    this.sendInternalRequest("mcp/cancel", { flowId });
  }

  compensateLateCreation(pending, response) {
    if (response.error) return;
    if (pending.method === "mcp/login") {
      if (typeof response.result?.flowId === "string") this.cancelMcpFlow(response.result.flowId);
      return;
    }
    const result = response.result;
    if (WIKI_ARCHIVE_START_METHODS.has(pending.method)) {
      if (typeof result?.transferId === "string") this.cancelArchiveTransfer(result.transferId);
      return;
    }
    if (["thread/start", "thread/fork"].includes(pending.method)) {
      const threadId = threadIdFrom(result);
      if (threadId) {
        this.sendInternalRequest(result?.ephemeral === true ? "thread/dispose" : "thread/delete", { threadId });
      }
      return;
    }
    if (pending.method === "terminal/start") {
      const sessionId = terminalSessionIdFrom(result);
      if (sessionId) {
        this.sendInternalRequest("terminal/close", { session_id: sessionId });
      }
      return;
    }
    if (pending.method === "browser/start") {
      const sessionId =
        result?.browser?.id ??
        result?.session?.id ??
        result?.browserId ??
        result?.sessionId ??
        result?.session_id;
      if (typeof sessionId === "string") {
        this.sendInternalRequest("browser/close", { session_id: sessionId });
      }
      return;
    }
    if (pending.method === "knowledge/source/directoryStage" && Array.isArray(result?.items)) {
      for (const item of result.items) if (typeof item?.attachmentPath === "string") {
        this.sendInternalRequest("attachment/delete", { path: item.attachmentPath });
      }
      return;
    }
    if (
      (pending.method === "attachment/save" || WIKI_ARTIFACT_METHODS.has(pending.method)) &&
      typeof result?.path === "string"
    ) {
      this.sendInternalRequest("attachment/delete", { path: result.path });
    }
    if (
      pending.method === "attachment/upload/start" &&
      typeof result?.upload_id === "string"
    ) {
      this.sendInternalRequest("attachment/upload/cancel", { upload_id: result.upload_id });
    }
    if (
      pending.method === "attachment/upload/finish" &&
      typeof result?.path === "string"
    ) {
      this.sendInternalRequest("attachment/delete", { path: result.path });
    }
  }

  promoteReferencedAttachments(pending, response) {
    if (response.error || pending.method !== "turn/start") return;
    const paths = new Set(pending.attachmentPaths ?? attachmentPathsFromTurn({ params: pending.params }));
    const threadId = threadIdFrom({ method: pending.method, params: pending.params });
    for (const [key, owner] of this.resourceOwners) {
      if (owner !== pending.client || !key.startsWith("attachment\0")) continue;
      const path = key.slice("attachment\0".length);
      if (threadId && paths.has(path)) {
        this.persistentResources.add(key);
        this.materializedAttachments.set(key, threadId);
      }
    }
  }

  sendServerNotification(client, message) {
    if (client.nativeManagementOnly && !['server/transportError', 'server/disconnected'].includes(message.method) &&
        !nativeManagementMethodAllowed(message.method)) return;
    if (!allowsAsyncQuestionNotification(message, client, this.initializeResponse?.result?.capabilities?.experimental)) return;
    message = this.continuousWork.notification(client, message,
      this.initializeResponse?.result?.capabilities?.experimental, this.ephemeralThreadOwners);
    if (!message) return;
    message = projectTaskStateNotification(message, client, this.initializeResponse?.result?.capabilities?.experimental);
    if (!message) return;
    message = this.studioPresentation.notification(client, message);
    if (!message) return;
    if (message.method === "computerUse/stateChanged" && client.computerUseRecoveryV1 !== true) {
      const { diagnostic, recoveryAvailable, ...params } = message.params ?? {};
      message = { ...message, params };
    }
    if (message.method === "item/event" && message.params?.event?.type === "tool_path_preview") {
      if (!client.initialized || client.channel !== "runtime" || client.toolPathPreviewV1 !== true
        || this.initializeResponse?.result?.capabilities?.experimental?.toolPathPreviewV1 !== true) return;
    }
    client.send(projectThreadRunSummary(message, client.threadRunSummaryV1 === true));
  }

  broadcast(message) {
    for (const client of this.clients) this.sendServerNotification(client, message);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.resolveShareability?.("closed");
    this.resolveShareability = null;
    this.broadcast({
      jsonrpc: "2.0",
      method: "server/transportError",
      params: {
        serverId: this.serverId,
        message: error instanceof Error ? error.message : String(error),
        // Account authentication failures carry a dedicated flag so the
        // login endpoint can answer 401 with actionable guidance instead of
        // the generic transport message.
        ...(error?.authenticationRejected === true ? { authenticationRejected: true } : {}),
      },
    });
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.clearTransientState();
    if (this.child.stdin.writable && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.end();
      } catch {}
    }
    this.onClose?.(this);
    this.#finishLifecycleMetrics();
  }

  #finishLifecycleMetrics() {
    if (!this.#lifecycleMetrics.close()) return;
    try {
      this.#onLifecycleMetrics?.(this.#lifecycleMetrics.snapshot());
    } catch {
      // Diagnostics must never change transport cleanup or client behavior.
    }
  }
}
