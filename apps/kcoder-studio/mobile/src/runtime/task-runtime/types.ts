import type { WebSourcesV1 } from "../../../../shared/webSources";
import type { AgentDefinitionRef, ThreadTranscriptObservationV1, ThreadTranscriptSnapshotV1 } from "../../../../shared/generated/contracts";
import type {
  AsyncQuestionAnswerRecord as AsyncQuestionAnswerContract,
  AsyncQuestionAnswerValue as AsyncQuestionAnswerValueContract,
  AsyncQuestionItem as AsyncQuestionItemContract,
  AsyncQuestionOption as AsyncQuestionOptionContract,
  AsyncQuestionRecord as AsyncQuestionRecordContract,
  AsyncQuestionStatus as AsyncQuestionStatusContract,
} from "../../../../shared/generated/contracts";
import {
  GatewayRpcClient,
  type JsonRecord,
  type RpcMessage,
} from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadMessage,
  ThreadSummary,
} from "@/gateway/types";
import type { PermissionMode } from "@/protocol/task-permission-mode";

import type { TaskRuntime } from "./core";
import type { TaskRuntimeRegistry } from "./registry";

import type { WorkspaceTaskHandoff } from "@/storage/pending-thread-creation";

export interface TaskCreationInput {
  isCurrentOwner?: () => boolean;
  workspaceHandoff?: WorkspaceTaskHandoff;
  agentDefinition?: AgentDefinitionRef;
  sessionMode?: "default" | "orchestrate";
  turnMode?: "standard" | "moa" | "moa-plan";
  profile: GatewayProfile;
  server: KCoderServer;
  cwd: string;
  prompt: string;
  permissionMode?: PermissionMode;
  localAttachmentIds?: string[];
  attachmentDraftId?: string;
  attachmentTransport?: "legacy";
  reprepareInitialAttachments?: boolean;
  model?: string;
  reasoningEffort?: string;
  managedWorktreeSourcePath?: string;
  onSessionExpired?: () => void;
  profileActivationEpoch?: number;
  isCurrentInteractionOwner?: (owner: InteractionAuthorizationOwner) => boolean;
}

/** Independent consumer of a shared creation job; releasing never aborts another consumer. */
export interface TaskCreationClaim {
  readonly result: Promise<TaskRuntime>;
  adopt(registry: TaskRuntimeRegistry, profileId: string, serverId: string): boolean;
  release(): void;
}

export interface ToolCallView {
  webSources?: WebSourcesV1;
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "unknown";
  rawStatus?: string;
  input?: unknown;
  output?: unknown;
}

export interface AssistantTextBlock {
  kind: "text";
  id: string;
  content: string;
  /** Live app-server item identity; several ordered segments may belong to one item. */
  producerId?: string;
  sequence?: number;
  endSequence?: number;
  arrivalOrdinal?: number;
  endArrivalOrdinal?: number;
  /** Persistent chunk chain used only if a late event splits a streamed text run. */
  chunkTail?: AssistantTextChunkNode;
}

export interface AssistantTextChunk {
  content: string;
  sequence?: number;
  arrivalOrdinal?: number;
}

export interface AssistantTextChunkNode extends AssistantTextChunk {
  previous?: AssistantTextChunkNode;
}

export interface AssistantThinkingBlock {
  kind: "thinking";
  id: string;
  content: string;
  sequence?: number;
  endSequence?: number;
  arrivalOrdinal?: number;
  endArrivalOrdinal?: number;
}

export interface AssistantToolBlock extends ToolCallView {
  kind: "tool";
  sequence?: number;
  arrivalOrdinal?: number;
  interactionSummaries?: InteractionSummaryView[];
}

export interface AssistantActivityBlock {
  kind: "activity";
  id: string;
  activity: TaskActivityView;
  sequence?: number;
  arrivalOrdinal?: number;
}

export type AssistantTranscriptBlock =
  | AssistantTextBlock
  | AssistantThinkingBlock
  | AssistantToolBlock
  | AssistantActivityBlock;

export interface ChatMessage extends ThreadMessage {
  clientMessageId?: string;
  rawStatus?: string;
  thinking?: string;
  tools?: ToolCallView[];
  todos?: TodoView[];
  activities?: TaskActivityView[];
  orderedBlocks?: AssistantTranscriptBlock[];
  historyOrdinal?: number;
  attachments?: StagedAttachment[];
  fileChanges?: FileChangesView;
  interactionSummaries?: InteractionSummaryView[];
}

export interface InteractionSummaryView {
  id: string;
  header: string;
  prompt?: string;
  answers: string[];
}

export interface TodoView {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface TaskActivityView {
  /** Structured model retry progress; presentation must not treat it as a successful operation. */
  providerRetry?: { attempt: number; maxRetries: number };
  id: string;
  type: "activity" | "compaction" | "notice" | "cancelled";
  label: string;
  detail?: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  agentId?: string;
  steerStatus?: string;
  steerMessageId?: string;
  clientMessageId?: string;
}

export interface AgentSteerResult {
  agentId: string;
  messageId?: string;
  clientMessageId?: string;
  status: string;
  queued: boolean;
  queuePosition?: number;
  reasonCode?: string;
}

export interface AgentSummary {
  backgroundRun?: Record<string, unknown>;
  agentId: string;
  agentName?: string;
  status: string;
  acceptingMessages: boolean;
  queueDepth: number;
  headMessageId?: string;
  headStatus?: string;
  presentation?: {
    role?: string;
    goal: string;
    directory: string;
    progress?: string;
    canStop: boolean;
    journalScope: string;
  };
}

export interface AgentListResult {
  threadId: string;
  agents: AgentSummary[];
}

export interface FileChangesView {
  artifactId: string;
  workspacePath: string;
  fileCount: number;
  additions: number;
  deletions: number;
  files: string[];
  status: string;
  revertible: boolean;
}

export interface StagedAttachment {
  filename: string;
  mimeType: string;
  fileSize: number;
  path: string;
}

export interface ThreadCompactResult {
  threadId: string;
  compacted: boolean;
  preTokens: number;
  postTokens: number;
}

export type GoalMode = "standard" | "strict" | "arrangement";

export interface TaskSendOptions {
  clientMessageId?: string;
  /** Captured at submit/dispatch time so async preparation cannot change the request. */
  permissionMode?: PermissionMode;
}

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"
  | "cancelled";

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  mode: GoalMode;
  verificationKind: "artifact" | "answer";
  status: GoalStatus;
  blockedCandidateCount?: number;
  blockerId?: string;
  blockerReason?: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  events?: Array<{ kind: string; timestamp: number; summary: string }>;
}

export interface ApprovalInteraction {
  kind: "approval";
  requestId: number;
  approvalId: string;
  reason: string;
  action: JsonRecord;
  availableDecisions?: Array<
    "accept" | "accept_for_session" | "decline" | "cancel"
  >;
  responding?: boolean;
  /** Local terminal evidence; a pending receipt cannot reopen this request. */
  turnEnded?: true;
  owner: InteractionOwnerBinding;
}

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface QuestionView {
  id: string;
  header: string;
  prompt: string;
  options: QuestionOption[];
  allowsFreeform: boolean;
  multiSelect: boolean;
}

export interface SourceAgent {
  parentSessionId: string;
  agentId: string;
  backgroundRun?: JsonRecord;
}

export interface QuestionInteraction {
  kind: "question";
  requestId: number;
  questionId: string;
  questions: QuestionView[];
  sourceAgent?: SourceAgent;
  /** Local source conflict evidence cannot be cleared by a pending status read. */
  sourceBindingConflict?: true;
  responding?: boolean;
  /** Local terminal evidence; a pending receipt cannot reopen this request. */
  turnEnded?: true;
  owner: InteractionOwnerBinding;
}

export type PendingInteraction = ApprovalInteraction | QuestionInteraction;

/** Durable, non-blocking AskUserQuestionAsync wire contract returned by asyncQuestion/list. */
export type AsyncQuestionOption = AsyncQuestionOptionContract;
export type AsyncQuestionItem = AsyncQuestionItemContract;
export type AsyncQuestionAnswerValue = AsyncQuestionAnswerValueContract;
export type AsyncQuestionAnswer = AsyncQuestionAnswerContract;
export type AsyncQuestionStatus = AsyncQuestionStatusContract;
export type AsyncQuestionRecord = AsyncQuestionRecordContract;

export type AsyncQuestionAnswerPayload = Record<
  string,
  AsyncQuestionAnswerValue
>;

/** Independent presentation state; async questions do not participate in interaction counts. */
export interface AsyncQuestionSnapshot {
  supported: boolean;
  loading: boolean;
  questions: AsyncQuestionRecord[];
  mutatingQuestionIds: string[];
  error?: string;
}

export type InteractionReceiptStatus = "pending" | "unknown" | "unsupported";

/** Local owner data is never sent in the route; it binds requests to their receiving socket. */
export interface InteractionOwnerBinding {
  profileId: string;
  profileAuthorizationScopeKey: string;
  /** Gateway target selected by the profile. */
  serverId: string;
  /** App-server identity derived from initialize.sessionId and used by interaction RPCs. */
  appServerId: string;
  serverConfigIdentity: string;
  threadId: string;
  turnId: string | null;
  appServerEpoch: string | null;
  runtimeInstanceNonce: number;
  profileActivationEpoch: number;
  originClientGeneration: number;
  status: InteractionReceiptStatus;
}

export type InteractionAuthorizationOwner = Pick<
  InteractionOwnerBinding,
  "profileId" | "profileAuthorizationScopeKey" | "serverId" |
  "serverConfigIdentity" | "profileActivationEpoch"
>;

/** Non-secret route locator; every field is revalidated against a live runtime on mount. */
export interface InteractionSelector {
  kind: PendingInteraction["kind"];
  requestId: number;
  interactionId: string;
  serverId: string;
  appServerId: string;
  serverConfigIdentity: string;
  profileId: string;
  profileAuthorizationScopeKey: string;
  threadId: string;
  turnId: string | null;
  appServerEpoch: string | null;
  runtimeInstanceNonce: number;
  profileActivationEpoch: number;
  originClientGeneration: number;
}

/** Compact realm-local row retained after its live socket owner is released. */
export interface InteractionInboxRow {
  profileId: string;
  profileAuthorizationScopeKey: string;
  serverId: string;
  appServerId: string;
  serverConfigIdentity: string;
  threadId: string;
  title: string;
  cwd: string;
  kind: PendingInteraction["kind"];
  requestId: number;
  interactionId: string;
  sourceAgent?: Pick<SourceAgent, "parentSessionId" | "agentId">;
  turnId: string | null;
  appServerEpoch: string | null;
  runtimeInstanceNonce: number;
  profileActivationEpoch: number;
  originClientGeneration: number;
  status: InteractionReceiptStatus;
  liveActionable: boolean;
}

export interface InteractionLedgerObserver {
  ownerFor(interaction: PendingInteraction): InteractionOwnerBinding | undefined;
  wasResolved(interaction: PendingInteraction): boolean;
  changed(interaction: PendingInteraction, liveActionable: boolean): void;
  resolved(interaction: PendingInteraction): void;
}

export interface TaskSnapshot {
  /** A durable history mutation must settle before another send or rewind. */
  transcriptActionPending?: boolean;
  /** Rebuildable projection of the target's current Goal, never local authority. */
  goal?: ThreadGoal | null;
  goalError?: string | null;
  goalMutationUnknown?: boolean;
  /** The edit was rejected, but its current Goal state has not yet been observed. */
  goalEditReadRequired?: boolean;
  goalContinuation?: { status: string; reason?: string } | null;
  threadId: string;
  title: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  /** Client selection for this thread's next turn; undefined delegates to the target default. */
  permissionMode?: PermissionMode;
  archivedAt?: string;
  messages: ChatMessage[];
  /** Identity of the published history rows/cursor, never a background cache read. */
  transcriptSnapshotV1?: ThreadTranscriptSnapshotV1;
  /** Coherent read identity only; not a committed snapshot or event watermark. */
  transcriptObservationV1?: ThreadTranscriptObservationV1;
  hasMoreBefore: boolean;
  beforeCursor: string | null;
  loadingOlder: boolean;
  running: boolean;
  connected: boolean;
  /** Client-owned connection recovery state, independent of message outcomes. */
  connectionPhase?: "reconnecting" | "failed" | "reauthorization-required";
  /** History can be readable before the restored execution configuration is checked. */
  configurationReady?: boolean;
  pendingTurnPreferences?: { model: string; reasoningEffort?: string };
  metadataPending?: string[];
  metadataUnknown?: string[];
  activeTurnId: string | null;
  stopRequestedTurnId?: string;
  stopAcceptanceUnknown?: boolean;
  interaction: PendingInteraction | null;
  interactionCount?: number;
  interactionFocusStatus?: "stale" | "readOnly";
  error: string | null;
  continuationPending?: string | null;
  continuationUnknown?: string | null;
  sendAcceptanceUnknown?: boolean;
  acceptanceChecking?: boolean;
}

export type Listener = () => void;

export type TaskClientConnector = typeof GatewayRpcClient.connect;

export interface ReconnectContext {
  profile: GatewayProfile;
  server: KCoderServer;
  threadCwd?: string;
  managedWorktreeSourcePath?: string;
  onSessionExpired?: () => void;
  profileActivationEpoch?: number;
  isCurrentInteractionOwner?: (owner: InteractionAuthorizationOwner) => boolean;
}

export interface BufferedSubscription {
  hasOverflowed(): boolean;
  activate(listener: (message: RpcMessage) => void): () => void;
  cancel(): void;
}

export interface ThreadReadPage {
  transcriptSnapshotV1?: ThreadTranscriptSnapshotV1;
  transcriptObservationV1?: ThreadTranscriptObservationV1;
  thread?: ThreadSummary;
  messages?: ThreadMessage[];
  rangeStart?: number;
  rangeEnd?: number;
  hasMoreBefore?: boolean;
  beforeCursor?: string;
}
