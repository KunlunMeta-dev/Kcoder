import {
  GatewayRpcClient,
  type JsonRecord,
  type RpcMessage,
} from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { NotificationReplayGuard } from "../../../../shared/notificationReplayGuard";
import * as agents from "./agents";
import * as connection from "./connection";
import * as factories from "./factories";
import type { TaskCreationClaim, TaskCreationInput } from "./types";
import type { TaskRuntimeRegistry } from "./registry";
import * as interactions from "./interactions";
import * as metadata from "./metadata";
import * as notifications from "./notifications";
import * as paging from "./paging";
import * as resources from "./resources";
import * as snapshotReducer from "./snapshotReducer";
import { TaskTerminalSession } from "./terminalLeases";
import * as turns from "./turns";
import {
  type Listener,
  type PendingInteraction,
  type ReconnectContext,
  type TaskSnapshot,
} from "./types";

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
  pendingInteractions: PendingInteraction[] = [];
  pendingAssistantDeltas = new Map<string, string[]>();
  pendingOrderedAssistantDeltas = new Map<string, PendingAssistantDelta[]>();
  pendingThinkingDeltas = new Map<string, PendingThinkingDelta[]>();
  readonly terminalSessions = new Map<string, TaskTerminalSession>();
  deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  metadataTail: Promise<void> = Promise.resolve();
  readonly metadataRevisions = new Map<string, number>();
  readonly metadataConfirmed = new Map<string, unknown>();
  snapshot: TaskSnapshot;
  getSnapshot = (): TaskSnapshot => this.snapshot;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isDisposed = resources.isDisposed;
  subscribeProtocol = resources.subscribeProtocol;
  request = resources.request;
  terminalSession = resources.terminalSession;
  closeTerminalSession = resources.closeTerminalSession;
  isLiveTerminalSession = resources.isLiveTerminalSession;
  hasLiveTerminalSessions = resources.hasLiveTerminalSessions;
  continuationState = turns.continuationState;
  supportsCurrentConfigurationContinuation =
    turns.supportsCurrentConfigurationContinuation;
  continueFailed = turns.continueFailed;
  acceptanceClient = turns.acceptanceClient;
  acceptOrdinaryResult = turns.acceptOrdinaryResult;
  startOrdinaryTurn = turns.startOrdinaryTurn;
  reconcileSendAcceptance = turns.reconcileSendAcceptance;
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
    onSessionExpired?: () => void;
  }): Promise<TaskRuntime> {
    return factories.resume(
      (client, initial, context) => new TaskRuntime(client, initial, context),
      input,
    );
  }
  static demo(threadId: string): TaskRuntime {
    return factories.demo(
      (client, initial, context) => new TaskRuntime(client, initial, context),
      threadId,
    );
  }
}
