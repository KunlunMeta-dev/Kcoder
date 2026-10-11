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

import type { TaskRuntime } from "./core";
import type { TaskRuntimeRegistry } from "./registry";

import type { WorkspaceTaskHandoff } from "@/storage/pending-thread-creation";

export interface TaskCreationInput {
  workspaceHandoff?: WorkspaceTaskHandoff;
  sessionMode?: "default" | "orchestrate";
  turnMode?: "standard" | "moa" | "moa-plan";
  profile: GatewayProfile;
  server: KCoderServer;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  managedWorktreeSourcePath?: string;
  onSessionExpired?: () => void;
}

/** Independent consumer of a shared creation job; releasing never aborts another consumer. */
export interface TaskCreationClaim {
  readonly result: Promise<TaskRuntime>;
  adopt(registry: TaskRuntimeRegistry, profileId: string, serverId: string): boolean;
  release(): void;
}

export interface ToolCallView {
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
  responding?: boolean;
}

export type PendingInteraction = ApprovalInteraction | QuestionInteraction;

export interface TaskSnapshot {
  threadId: string;
  title: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  archivedAt?: string;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  beforeCursor: string | null;
  loadingOlder: boolean;
  running: boolean;
  connected: boolean;
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
}

export interface BufferedSubscription {
  activate(listener: (message: RpcMessage) => void): () => void;
  cancel(): void;
}

export interface ThreadReadPage {
  thread?: ThreadSummary;
  messages?: ThreadMessage[];
  rangeStart?: number;
  rangeEnd?: number;
  hasMoreBefore?: boolean;
  beforeCursor?: string;
}
