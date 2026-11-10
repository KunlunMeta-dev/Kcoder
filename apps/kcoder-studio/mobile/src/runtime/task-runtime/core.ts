import {
  GatewayRpcClient,
  type JsonRecord,
  type RpcMessage,
} from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { NotificationReplayGuard } from "../../../../shared/notificationReplayGuard";
import * as agents from "./agents";
import * as asyncQuestions from "./async-questions";
import * as connection from "./connection";
import * as factories from "./factories";
import * as experts from "./experts";
import type { TaskCreationClaim, TaskCreationInput } from "./types";
import type { TaskRuntimeRegistry } from "./registry";
import type { ThreadPresenceObservation } from "./thread-presence";
import { normalizeHistoryPage, readHistoryPage, reconcileConfirmedHistoryPage, transcriptReadIdentityKey } from "./history";
import type { ThreadReadPage } from "./types";
import * as interactions from "./interactions";
import * as metadata from "./metadata";
import * as notifications from "./notifications";
import * as paging from "./paging";
import * as resources from "./resources";
import * as snapshotReducer from "./snapshotReducer";
import { TaskTerminalSession } from "./terminalLeases";
import * as turns from "./turns";
import * as transcriptActions from "./transcriptActions";
import {
  type AsyncQuestionSnapshot,
  type Listener,
  type InteractionLedgerObserver,
  type InteractionSelector,
  type PendingInteraction,
  type ReconnectContext,
  type TaskSnapshot,
} from "./types";

let nextRuntimeInstanceNonce = 0;

export interface PendingAssistantDelta {
  itemId?: string;
  delta: string;
  sequence?: number;
  arrivalOrdinal: number;
  attemptId?: string;
}

export interface PendingThinkingDelta {
  delta: string;
  sequence?: number;
  arrivalOrdinal: number;
  attemptId?: string;
}

/** Single owner of task state, clients, notification cursors and terminal leases. */
export class TaskRuntime {
  readonly runtimeInstanceNonce = ++nextRuntimeInstanceNonce;
  readonly notificationReplayGuard = new NotificationReplayGuard();
  readonly listeners = new Set<Listener>();
  readonly protocolListeners = new Set<(message: RpcMessage) => void>();
  unsubscribeRpc: (() => void) | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectAttempt = 0;
  reconnecting = false;
  reconnectPromise: Promise<void> | null = null;
  readonly attemptByTurn = new Map<string, string>();
  readonly attemptSequence = new Map<string, number>();
  readonly finishedAttempts = new Set<string>();
  transcriptArrivalOrdinal = 0;
  reconnectRequested = false;
  clientGeneration = 0;
  disposed = false;
  closeComplete = false;
  uncertainSend: JsonRecord | null = null;
  asyncQuestionSnapshot: AsyncQuestionSnapshot = {
    supported: false,
    loading: false,
    questions: [],
    mutatingQuestionIds: [],
  };
  asyncQuestionListSequence = 0;
  readonly asyncQuestionMutationIds = new Map<string, { current(): boolean }>();
  pendingInteractions: PendingInteraction[] = [];
  focusedInteractionSelector: InteractionSelector | null = null;
  interactionLedgerObserver: InteractionLedgerObserver | null = null;
  pendingAssistantDeltas = new Map<string, string[]>();
  pendingOrderedAssistantDeltas = new Map<string, PendingAssistantDelta[]>();
  pendingThinkingDeltas = new Map<string, PendingThinkingDelta[]>();
  readonly terminalSessions = new Map<string, TaskTerminalSession>();
  deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  metadataTail: Promise<void> = Promise.resolve();
  readonly metadataRevisions = new Map<string, number>();
  readonly metadataConfirmed = new Map<string, unknown>();
  goalProjectionVersion = 0;
  /** Undefined for ordinary resumes; null while same-owner workspace preferences are pending. */
  workspaceConfiguration: { reasoningEffort?: string; isCurrent: () => boolean } | null | undefined;
  restoreWorkspaceConfiguration = factories.restoreWorkspaceConfiguration;
  /** Raw authority only; never built from optimistic/streaming snapshot rows. */
  confirmedTranscriptPage: { page: ThreadReadPage; confirmedAt: number } | null = null;
  /** Explicit rewind invalidates in-flight reads even on legacy targets without snapshot identities. */
  transcriptMutationRevision = 0;
  completedTranscriptRevision = 0;
  confirmedTranscriptRevision = 0;
  private deferredConfirmedReconciliation: {
    authority: NonNullable<TaskRuntime["confirmedTranscriptPage"]>;
    revision: number;
    isCurrent: () => boolean;
  } | null = null;
  async readConfirmedTranscriptPage(isCurrent: () => boolean,
    mayReconcileUi: (page: ThreadReadPage) => boolean = () => true): Promise<{ page: ThreadReadPage; confirmedAt: number } | null> {
    const client = this.client;
    const generation = this.clientGeneration;
    const threadId = this.snapshot.threadId;
    const identity = transcriptReadIdentityKey(this.snapshot);
    const mutationRevision = this.transcriptMutationRevision;
    const current = () => isCurrent() && !this.disposed && this.client === client &&
      this.clientGeneration === generation && this.snapshot.threadId === threadId &&
      this.transcriptMutationRevision === mutationRevision && transcriptReadIdentityKey(this.snapshot) === identity;
    if (!client || !current()) return null;
    const revision = this.completedTranscriptRevision;
    const result = await readHistoryPage(client, threadId);
    if (!current() || (result.thread?.id && result.thread.id !== threadId)) return null;
    const proved = transcriptReadIdentityKey(result) !== null;
    if (proved) {
      this.flushPendingDeltas();
      if (!current()) return null;
    }
    // Resolve reading intent against the displayed page before replacing raw authority.
    const reconcileUi = proved && mayReconcileUi(result.sourcePage);
    if (!current()) return null;
    const value = { page: result.sourcePage, confirmedAt: Date.now() };
    this.confirmedTranscriptPage = value;
    this.confirmedTranscriptRevision = revision;
    this.deferredConfirmedReconciliation = null;
    if (reconcileUi) reconcileConfirmedHistoryPage(this, result);
    else if (proved && this.completedTranscriptRevision === revision) {
      // This guard references the accepted raw page, not a second transcript projection.
      this.deferredConfirmedReconciliation = { authority: value, revision,
        isCurrent: () => current() && mayReconcileUi(value.page) };
    }
    return value;
  }
  applyDeferredConfirmedTranscriptPage(isCurrent: () => boolean): boolean {
    const deferred = this.deferredConfirmedReconciliation;
    if (!deferred) return false;
    const current = () => isCurrent() && deferred.isCurrent() &&
      this.confirmedTranscriptPage === deferred.authority && this.completedTranscriptRevision === deferred.revision;
    if (!current()) { this.deferredConfirmedReconciliation = null; return false; }
    const page = normalizeHistoryPage(deferred.authority.page);
    if (transcriptReadIdentityKey(page) === null) { this.deferredConfirmedReconciliation = null; return false; }
    this.flushPendingDeltas();
    if (!current()) { this.deferredConfirmedReconciliation = null; return false; }
    this.deferredConfirmedReconciliation = null;
    reconcileConfirmedHistoryPage(this, page);
    return true;
  }
  snapshot: TaskSnapshot;
  getSnapshot = (): TaskSnapshot => this.snapshot;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isDisposed = resources.isDisposed;
  getAsyncQuestionSnapshot = (): AsyncQuestionSnapshot => this.asyncQuestionSnapshot;
  canMutateAsyncQuestions = asyncQuestions.canMutateAsyncQuestions;
  refreshAsyncQuestions = asyncQuestions.refreshAsyncQuestions;
  answerAsyncQuestion = asyncQuestions.answerAsyncQuestion;
  cancelAsyncQuestion = asyncQuestions.cancelAsyncQuestion;
  handleAsyncQuestionChanged = asyncQuestions.handleAsyncQuestionChanged;
  subscribeProtocol = resources.subscribeProtocol;
  request = resources.request;
  terminalSession = resources.terminalSession;
  closeTerminalSession = resources.closeTerminalSession;
  isLiveTerminalSession = resources.isLiveTerminalSession;
  hasLiveTerminalSessions = resources.hasLiveTerminalSessions;
  continuationState = turns.continuationState;
  supportsTurnPermissions = turns.supportsTurnPermissions;
  setPermissionMode = metadata.setPermissionMode;
  supportsCurrentConfigurationContinuation =
    turns.supportsCurrentConfigurationContinuation;
  continueFailed = turns.continueFailed;
  acceptanceClient = turns.acceptanceClient;
  acceptOrdinaryResult = turns.acceptOrdinaryResult;
  startOrdinaryTurn = turns.startOrdinaryTurn;
  reconcileSendAcceptance = turns.reconcileSendAcceptance;
  reconcileSubmissionHistory = turns.reconcileSubmissionHistory;
  transcriptActionSendId: string | undefined;
  pendingTranscriptAction = transcriptActions.pendingTranscriptAction;
  editLastMessage = transcriptActions.editLastMessage;
  forkCompletedTurn = transcriptActions.forkCompletedTurn;
  recoverTranscriptAction = transcriptActions.recoverTranscriptAction;
  dismissTranscriptAction = transcriptActions.dismissTranscriptAction;
  send = turns.send;
  loadOlderMessages = paging.loadOlderMessages;
  interrupt = turns.interrupt;
  steerSubagent = turns.steerSubagent;
  agentCapabilities = agents.agentCapabilities;
  listSubagents = agents.listSubagents;
  readSubagent = agents.readSubagent;
  readSubagentCommands = agents.readSubagentCommands;
  readSubagentCommand = agents.readSubagentCommand;
  stopSubagent = agents.stopSubagent;
  supportsExperts = experts.supportsExperts;
  readExpert = experts.readExpert;
  selectExpert = experts.selectExpert;
  listExperts = experts.listExperts;
  listExpertVersions = experts.listExpertVersionsForTask;
  rename = metadata.rename;
  setTurnPreferences = metadata.setTurnPreferences;
  archive = metadata.archive;
  unarchive = metadata.unarchive;
  compact = metadata.compact;
  setGoal = metadata.setGoal;
  getGoal = metadata.getGoal;
  getGoalHistory = metadata.getGoalHistory;
  updateGoalStatus = metadata.updateGoalStatus;
  editGoal = metadata.editGoal;
  clearGoal = metadata.clearGoal;
  deleteThread = metadata.deleteThread;
  respondApproval = interactions.respondApproval;
  respondQuestions = interactions.respondQuestions;
  respondAgentQuestions = interactions.respondAgentQuestions;
  cancelQuestions = interactions.cancelQuestions;
  close = connection.close;
  attachClient = connection.attachClient;
  attachBufferedClient = connection.attachBufferedClient;
  scheduleReconnect = connection.scheduleReconnect;
  reconnectNow = connection.reconnectNow;
  reconnect = connection.reconnect;
  performReconnect = connection.performReconnect;
  handleRpc = notifications.handleRpc;
  handleAcceptedRpc = notifications.handleAcceptedRpc;
  enqueueInteraction = interactions.enqueueInteraction;
  resolveInteraction = interactions.resolveInteraction;
  markInteractionResponding = interactions.markInteractionResponding;
  focusInteraction = interactions.focusInteraction;
  reconcilePendingInteractions = interactions.reconcilePendingInteractions;
  isInteractionActionable = interactions.isInteractionActionable;
  markInteractionsDisconnected = interactions.markInteractionsDisconnected;
  setInteractionLedgerObserver(observer: InteractionLedgerObserver | null): void {
    this.interactionLedgerObserver = observer;
    if (!observer) return;
    const retained: PendingInteraction[] = [];
    for (const interaction of this.pendingInteractions) {
      if (observer.wasResolved(interaction)) continue;
      const owner = observer.ownerFor(interaction);
      const normalized = owner ? { ...interaction, owner } as PendingInteraction : interaction;
      retained.push(normalized);
      observer.changed(normalized, this.isInteractionActionable(normalized));
    }
    this.pendingInteractions = retained;
    interactions.publishInteractionProjection(this);
  }
  publishInteractionProjection(): void {
    interactions.publishInteractionProjection(this);
  }
  notifyInteractionChanged(interaction: PendingInteraction): void {
    this.interactionLedgerObserver?.changed(interaction, this.isInteractionActionable(interaction));
  }
  notifyInteractionResolved(interaction: PendingInteraction): void {
    this.interactionLedgerObserver?.resolved(interaction);
  }
  appendAssistantDelta = snapshotReducer.appendAssistantDelta;
  appendThinkingDelta = snapshotReducer.appendThinkingDelta;
  scheduleDeltaFlush = snapshotReducer.scheduleDeltaFlush;
  flushPendingDeltas = snapshotReducer.flushPendingDeltas;
  updateTool = snapshotReducer.updateTool;
  updateAssistantItem = snapshotReducer.updateAssistantItem;
  ensureAssistantMessage = snapshotReducer.ensureAssistantMessage;
  updateTodos = snapshotReducer.updateTodos;
  updateSubagentSteer = snapshotReducer.updateSubagentSteer;
  applySubagentSnapshot = snapshotReducer.applySubagentSnapshot;
  updateActivity = snapshotReducer.updateActivity;
  patch = snapshotReducer.patch;
  private constructor(
    public client: GatewayRpcClient | null,
    initial: TaskSnapshot,
    public reconnectContext: ReconnectContext | null = null,
  ) {
    this.snapshot = initial;
    for (const message of initial.messages) {
      if (message.turnId && message.attemptId)
        this.attemptByTurn.set(message.turnId, message.attemptId);
    }
    if (client) this.attachClient(client);
  }
  static create(input: TaskCreationInput): Promise<TaskRuntime> {
    return factories.create(
      (client, initial, context) => new TaskRuntime(client, initial, context),
      input,
    );
  }
  static claimCreation(input: TaskCreationInput, registry: TaskRuntimeRegistry): TaskCreationClaim {
    return factories.claimCreation(
      (client, initial, context) => new TaskRuntime(client, initial, context),
      input,
      registry,
    );
  }
  static resume(input: {
    profile: GatewayProfile;
    server: KCoderServer;
    threadId: string;
    cwd?: string;
    title?: string;
    reasoningEffort?: string;
    deferConfiguration?: boolean;
    onSessionExpired?: () => void;
    profileActivationEpoch?: number;
    isCurrentInteractionOwner?: ReconnectContext["isCurrentInteractionOwner"];
    presenceOwnerToken?: object;
    isCurrentOwner?: () => boolean;
    signal?: AbortSignal;
    onThreadPresence?: (observation: ThreadPresenceObservation) => void;
  }): Promise<TaskRuntime> {
    return factories.resume(
      (client, initial, context) => new TaskRuntime(client, initial, context),
      input,
    );
  }
  /** Keep runtime construction here so transcript operations depend only on the runtime type. */
  resumeForkThread(input: Parameters<typeof TaskRuntime.resume>[0]): Promise<TaskRuntime> {
    return TaskRuntime.resume(input);
  }
  static demo(threadId: string): TaskRuntime {
    return factories.demo(
      (client, initial, context) => new TaskRuntime(client, initial, context),
      threadId,
    );
  }
  /** An isolated transcript reducer. It owns no client, executor, registry slot or reconnect context. */
  static transcriptProjection(initial: TaskSnapshot): TaskRuntime {
    return new TaskRuntime(null, initial);
  }
}
