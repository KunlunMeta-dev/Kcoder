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

export interface ToolCallView {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
}

export interface ChatMessage extends ThreadMessage {
  thinking?: string;
  tools?: ToolCallView[];
  todos?: TodoView[];
  activities?: TaskActivityView[];
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

export interface QuestionInteraction {
  kind: "question";
  requestId: number;
  questionId: string;
  questions: QuestionView[];
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
  activeTurnId: string | null;
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
  hasMoreBefore?: boolean;
  beforeCursor?: string;
}
