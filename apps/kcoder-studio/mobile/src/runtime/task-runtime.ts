import { decodeProviderFailure } from '../../../shared/providerFailure';
import { gatewayReconnectDelay } from '../../../shared/gatewayConnectionBudget';
import { parseThreadRunSummary, threadRunActivity, threadRunSummaryIsActive } from '../../../shared/threadRunSummary';
import { startTurnWithReceipt, readTurnReceipt, type TurnStartResult } from '../../../shared/turnReceipt';
import { readModelConfiguration, type ModelConfigurationSummary } from '../../../shared/modelConfiguration';
import { NotificationReplayGuard } from '../../../shared/notificationReplayGuard';
import { negotiateModelSelector } from '../../../shared/modelSelection';
import type {
  GatewayProfile,
  KCoderServer,
  ThreadMessage,
  ThreadSummary,
} from "@/gateway/types";
import {
  GatewayRpcClient,
  MobileRpcError,
  type JsonRecord,
  type RpcMessage,
} from "@/gateway/rpc";
import { timestampMs, visibleUserContent } from "@/protocol/normalizers";
import {
  TerminalTranscriptBuffer,
  terminalTranscriptCharacterLimit,
} from "@/components/terminal-transcript-buffer";

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

interface AgentSummary {
  backgroundRun?: Record<string, unknown>;
  agentId: string;
  agentName?: string;
  status: string;
  acceptingMessages: boolean;
  queueDepth: number;
  headMessageId?: string;
  headStatus?: string;
}

interface AgentListResult {
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
  | "complete";

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  mode: GoalMode;
  verificationKind: "artifact" | "answer";
  status: GoalStatus;
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

type Listener = () => void;
type TaskClientConnector = typeof GatewayRpcClient.connect;
let taskClientConnector: TaskClientConnector = GatewayRpcClient.connect;
// Namespace prevents simultaneous clients from reusing a receipt identity. It is
// a uniqueness token, never an authentication credential.
const outgoingMessageNamespace = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
let outgoingMessageSequence = 0;

interface ReconnectContext {
  profile: GatewayProfile;
  server: KCoderServer;
  managedWorktreeSourcePath?: string;
  onSessionExpired?: () => void;
}

interface BufferedSubscription {
  activate(listener: (message: RpcMessage) => void): () => void;
  cancel(): void;
}

function bufferNotifications(client: GatewayRpcClient): BufferedSubscription {
  const messages: RpcMessage[] = [];
  let target: ((message: RpcMessage) => void) | null = null;
  let cancelled = false;
  let overflowed = false;
  let bufferedBytes = 0;
  const unsubscribe = client.subscribe((message) => {
    if (cancelled) return;
    if (target) target(message);
    else if (!overflowed) {
      const bytes = JSON.stringify(message).length * 2;
      if (messages.length >= 512 || bufferedBytes + bytes > 2 * 1024 * 1024) {
        overflowed = true;
        messages.length = 0;
        bufferedBytes = 0;
      } else {
        messages.push(message);
        bufferedBytes += bytes;
      }
    }
  });
  return {
    activate(listener) {
      if (overflowed) {
        cancelled = true;
        unsubscribe();
        throw new Error('会话更新超过缓存上限，请重新连接以读取完整记录。');
      }
      target = listener;
      // Replay is synchronous, so new notifications cannot overtake cached notifications.
      for (const message of messages.splice(0)) listener(message);
      bufferedBytes = 0;
      return unsubscribe;
    },
    cancel() {
      cancelled = true;
      messages.length = 0;
      unsubscribe();
    },
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function todosFromInput(value: unknown): TodoView[] | undefined {
  const rawTodos = record(value).TodoList;
  if (!Array.isArray(rawTodos)) return undefined;
  const todos = rawTodos.flatMap((value): TodoView[] => {
    const todo = record(value);
    const content = text(todo.content);
    const rawStatus = text(todo.status);
    if (!content) return [];
    const status: TodoView["status"] =
      rawStatus === "in_progress" ||
      rawStatus === "completed" ||
      rawStatus === "cancelled"
        ? rawStatus
        : "pending";
    return [{ content, status }];
  });
  return todos;
}

function attachmentsFromContent(
  content: string,
): StagedAttachment[] | undefined {
  const match = content.match(
    /<kcoder_attachments[^>]*>\s*([\s\S]*?)\s*<\/kcoder_attachments>/i,
  );
  if (!match?.[1]) return undefined;
  const attachments = match[1].split(/\r?\n/).flatMap((line) => {
    try {
      const value = record(JSON.parse(line));
      const filename = text(value.filename);
      const mimeType = text(value.mimeType) ?? text(value.mime_type);
      const path = text(value.path);
      if (!filename || !mimeType || !path) return [];
      return [
        {
          filename,
          mimeType,
          path,
          fileSize: Number(value.fileSize ?? value.file_size ?? 0),
        },
      ];
    } catch {
      return [];
    }
  });
  return attachments.length > 0 ? attachments : undefined;
}

function attachmentFromValue(value: unknown): StagedAttachment | undefined {
  const raw = record(value);
  const filename = text(raw.filename);
  const mimeType =
    text(raw.mimeType) ?? text(raw.mime_type) ?? "application/octet-stream";
  const path = text(raw.path);
  if (!filename || !path) return undefined;
  return {
    filename,
    mimeType,
    path,
    fileSize: Number(raw.fileSize ?? raw.file_size ?? 0),
  };
}

function structuredBlocks(blocks: unknown[] | undefined): {
  thinking?: string;
  tools?: ToolCallView[];
  todos?: TodoView[];
  attachments?: StagedAttachment[];
  fileChanges?: FileChangesView;
  interactionSummaries?: InteractionSummaryView[];
} {
  const thinking: string[] = [];
  const tools: ToolCallView[] = [];
  const attachments: StagedAttachment[] = [];
  let todos: TodoView[] | undefined;
  let fileChanges: FileChangesView | undefined;
  const interactionSummaries: InteractionSummaryView[] = [];
  for (const value of blocks ?? []) {
    const block = record(value);
    if (block.type === "thinking") {
      const content = text(block.content);
      if (content) thinking.push(content);
      continue;
    }
    if (block.type === "tool") {
      const id =
        text(block.id) ?? text(block.tool_use_id) ?? `tool-${tools.length + 1}`;
      const name = text(block.tool_name) ?? text(block.name) ?? "Tool";
      const renderPayload = record(block.render_payload ?? block.renderPayload);
      if (renderPayload.kind === "request_user_input") {
        const summaryCountBeforeBlock = interactionSummaries.length;
        const responseAnswers = record(record(renderPayload.response).answers);
        for (const questionValue of Array.isArray(renderPayload.questions)
          ? renderPayload.questions
          : []) {
          const question = record(questionValue);
          const questionId = text(question.id);
          if (!questionId) continue;
          const answer = record(responseAnswers[questionId]);
          const answers = Array.isArray(answer.answers)
            ? answer.answers.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          if (answers.length === 0) continue;
          interactionSummaries.push({
            id: questionId,
            header: text(question.header) ?? "交互记录",
            prompt: text(question.question) ?? text(question.prompt),
            answers,
          });
        }
        if (interactionSummaries.length > summaryCountBeforeBlock) continue;
      }
      if (name.toLowerCase() === "todowrite") {
        todos = todosFromInput(block.tool_input ?? block.input) ?? todos;
        continue;
      }
      const status =
        block.status === "error"
          ? "failed"
          : block.status === "done"
            ? "completed"
            : "running";
      tools.push({
        id,
        name,
        status,
        input: block.tool_input ?? block.input,
        output: block.tool_output ?? block.output,
      });
      continue;
    }
    if (block.type === "attachment") {
      const attachment = attachmentFromValue(block.attachment ?? block);
      if (attachment) attachments.push(attachment);
      continue;
    }
    if (block.type === "file_changes") {
      fileChanges =
        fileChangesFromValue(block.fileChanges ?? block.file_changes) ??
        fileChanges;
    }
  }
  return {
    thinking: thinking.length > 0 ? thinking.join("\n\n") : undefined,
    tools: tools.length > 0 ? tools : undefined,
    todos,
    attachments: attachments.length > 0 ? attachments : undefined,
    fileChanges,
    interactionSummaries:
      interactionSummaries.length > 0 ? interactionSummaries : undefined,
  };
}

function normalizeMessage(message: ThreadMessage): ChatMessage | null {
  const content =
    message.role === "user"
      ? visibleUserContent(message.content)
      : [
          ...(message.blocks ?? []).flatMap((value) => {
            const block = record(value);
            return block.type === "text" && typeof block.content === "string"
              ? [block.content]
              : [];
          }),
          message.content,
        ]
          .filter(Boolean)
          .join("\n\n");
  const blocks = structuredBlocks(message.blocks);
  const attachments =
    blocks.attachments ??
    (message.role === "user"
      ? attachmentsFromContent(message.content)
      : undefined);
  if (
    !content &&
    !blocks.thinking &&
    !blocks.tools &&
    !blocks.todos &&
    !blocks.fileChanges &&
    !blocks.interactionSummaries &&
    !attachments &&
    message.status !== "cancelled" && message.status !== "failed"
  )
    return null;
  return { ...message, content, ...blocks, attachments, providerFailure: decodeProviderFailure(message.providerFailure) };
}

function fileChangesFromValue(value: unknown): FileChangesView | undefined {
  const raw = record(value);
  const artifactId = text(raw.artifact_id) ?? text(raw.artifactId);
  const workspacePath = text(raw.workspace_path) ?? text(raw.workspacePath);
  if (!artifactId || !workspacePath) return undefined;
  return {
    artifactId,
    workspacePath,
    fileCount: Number(raw.file_count ?? raw.fileCount ?? 0),
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    files: Array.isArray(raw.files)
      ? raw.files.flatMap((file) => {
          if (typeof file === "string" && file.trim()) return [file.trim()];
          const path = text(record(file).path);
          return path ? [path] : [];
        })
      : [],
    status: text(raw.status) ?? "active",
    revertible: raw.revertible === true,
  };
}

function turnIdFrom(message: RpcMessage): string {
  const params = record(message.params);
  return text(params.turnId) ?? text(record(params.turn).id) ?? "current-turn";
}

interface ThreadReadPage {
  thread?: ThreadSummary;
  messages?: ThreadMessage[];
  hasMoreBefore?: boolean;
  beforeCursor?: string;
}

async function readHistoryPage(
  client: GatewayRpcClient,
  threadId: string,
  beforeCursor?: string,
): Promise<{
  thread?: ThreadSummary;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  beforeCursor: string | null;
}> {
  const method = client.supportsExperimental?.("threadIndexedPagesV1") ? "thread/read/indexed" : "thread/read";
  const page = await client.request<ThreadReadPage>(method, {
    threadId,
    limit: 50,
    ...(beforeCursor ? { beforeCursor } : {}),
  });
  return {
    thread: page.thread,
    messages: (page.messages ?? []).flatMap((message) => {
      const normalized = normalizeMessage(message);
      return normalized ? [normalized] : [];
    }),
    hasMoreBefore: page.hasMoreBefore === true && Boolean(page.beforeCursor),
    beforeCursor:
      page.hasMoreBefore === true ? (page.beforeCursor ?? null) : null,
  };
}

function attachmentPathsFromMessages(
  messages: readonly ChatMessage[],
): string[] {
  return messages.flatMap(
    (message) =>
      message.attachments?.map((attachment) => attachment.path) ?? [],
  );
}

async function collectThreadAttachmentPaths(
  client: GatewayRpcClient,
  threadId: string,
  knownPaths: readonly string[] = [],
): Promise<string[]> {
  const paths = new Set(knownPaths.filter(Boolean));
  const seenCursors = new Set<string>();
  let beforeCursor: string | undefined;
  for (;;) {
    const page = await readHistoryPage(client, threadId, beforeCursor);
    for (const path of attachmentPathsFromMessages(page.messages))
      paths.add(path);
    if (!page.hasMoreBefore || !page.beforeCursor) break;
    if (seenCursors.has(page.beforeCursor))
      throw new Error("thread/read 返回了重复的历史游标");
    seenCursors.add(page.beforeCursor);
    beforeCursor = page.beforeCursor;
  }
  return [...paths];
}

export function mergeReconciledMessages(
  authoritative: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] {
  const merged = new Map(authoritative.map((message) => [message.id, message]));
  const matchedAuthoritative = new Set<string>();
  for (const message of local) {
    let persisted = merged.get(message.id);
    if (!persisted) {
      persisted = authoritative.find((candidate) => {
        if (
          matchedAuthoritative.has(candidate.id) ||
          candidate.role !== message.role
        )
          return false;
        if (
          message.role === "assistant" &&
          message.turnId &&
          candidate.turnId === message.turnId
        ) {
          const failed = (value: ChatMessage) => value.status === 'failed' || value.status === 'cancelled';
          if (failed(message) !== failed(candidate)) return false;
          if (failed(message) || (message.attemptId && candidate.attemptId))
            return (message.attemptId ?? message.turnId) === (candidate.attemptId ?? candidate.turnId);
          return true;
        }
        return (
          candidate.content === message.content &&
          Math.abs(candidate.timestampMs - message.timestampMs) < 10 * 60_000
        );
      });
    }
    if (!persisted) {
      merged.set(message.id, message);
      continue;
    }
    matchedAuthoritative.add(persisted.id);
    const tools = new Map(
      (persisted.tools ?? []).map((tool) => [tool.id, tool]),
    );
    for (const localTool of message.tools ?? []) {
      const serverTool = tools.get(localTool.id);
      if (!serverTool) tools.set(localTool.id, localTool);
      else if (
        serverTool.status === "running" &&
        localTool.status !== "running"
      ) {
        tools.set(localTool.id, { ...serverTool, ...localTool });
      }
    }
    merged.set(persisted.id, {
      ...persisted,
      content:
        message.content.length > persisted.content.length
          ? message.content
          : persisted.content,
      thinking:
        (message.thinking?.length ?? 0) > (persisted.thinking?.length ?? 0)
          ? message.thinking
          : persisted.thinking,
      tools: tools.size > 0 ? [...tools.values()] : undefined,
      attachments: persisted.attachments ?? message.attachments,
      fileChanges: persisted.fileChanges ?? message.fileChanges,
    });
  }
  return [...merged.values()].sort(
    (left, right) => left.timestampMs - right.timestampMs,
  );
}

function historiesOverlap(
  authoritative: ChatMessage[],
  local: ChatMessage[],
): boolean {
  const localIds = new Set(local.map((message) => message.id));
  const localTurns = new Set(
    local.flatMap((message) => (message.turnId ? [message.turnId] : [])),
  );
  return authoritative.some(
    (message) =>
      localIds.has(message.id) ||
      Boolean(message.turnId && localTurns.has(message.turnId)),
  );
}

export class TaskRuntime {
  private readonly notificationReplayGuard = new NotificationReplayGuard();
  private readonly listeners = new Set<Listener>();
  private readonly protocolListeners = new Set<(message: RpcMessage) => void>();
  private unsubscribeRpc: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private reconnectPromise: Promise<void> | null = null;
  private readonly attemptByTurn = new Map<string, string>();
  private readonly attemptSequence = new Map<string, number>();
  private readonly finishedAttempts = new Set<string>();
  private reconnectRequested = false;
  private clientGeneration = 0;
  private disposed = false;
  private uncertainSend: JsonRecord | null = null;
  private pendingInteractions: PendingInteraction[] = [];
  private pendingAssistantDeltas = new Map<string, string[]>();
  private pendingThinkingDeltas = new Map<string, string[]>();
  private readonly terminalSessions = new Map<string, TaskTerminalSession>();
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: TaskSnapshot;

  private constructor(
    private client: GatewayRpcClient | null,
    initial: TaskSnapshot,
    private readonly reconnectContext: ReconnectContext | null = null,
  ) {
    this.snapshot = initial;
    for (const message of initial.messages) {
      if (message.turnId && message.attemptId) this.attemptByTurn.set(message.turnId, message.attemptId);
    }
    if (client) this.attachClient(client);
  }

  static async create(input: {
    sessionMode?: 'default' | 'orchestrate';
    turnMode?: 'standard' | 'moa' | 'moa-plan';
    profile: GatewayProfile;
    server: KCoderServer;
    cwd: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    managedWorktreeSourcePath?: string;
    onSessionExpired?: () => void;
  }): Promise<TaskRuntime> {
    const client = await taskClientConnector(
      input.profile,
      input.server,
      input.cwd,
    );
    if ((input.sessionMode === 'orchestrate' || (input.turnMode && input.turnMode !== 'standard')) && !client.supportsExperimental?.('sessionModes')) {
      client.close();
      throw new Error('目标 KCoder 不支持特殊执行模式，请升级后重试');
    }
    let wireModel: string | undefined;
    try { wireModel = await negotiateModelSelector(client, input.model); }
    catch (error) { client.close(); throw error; }
    const started = await client.request<{ thread?: ThreadSummary }>(
      "thread/start",
      {
        cwd: input.cwd,
        ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
        ...(wireModel ? { model: wireModel } : {}),
      },
    );
    const thread = started.thread;
    if (!thread?.id) {
      client.close();
      throw new Error("KCoder app-server 未返回 thread id");
    }
    const effectiveModel = input.model?.includes('::') && wireModel !== input.model
      ? wireModel : threadModelSelector(thread) ?? input.model;
    const title = input.prompt.split(/\r?\n/, 1)[0].slice(0, 80) || "新任务";
    if (input.managedWorktreeSourcePath) {
      const registryClient = await taskClientConnector(
        input.profile,
        input.server,
        input.managedWorktreeSourcePath,
      );
      try {
        const now = Date.now();
        await registryClient.request("runtime.worktrees.conversations.link", {
          deviceId: input.server.id,
          path: input.cwd,
          conversation: {
            deviceId: input.server.id,
            taskId: thread.id,
            threadId: thread.id,
            workspacePath: input.cwd,
            title,
            model: effectiveModel ?? null,
            createdAt: timestampMs(thread.createdAt) || now,
            updatedAt: timestampMs(thread.updatedAt) || now,
          },
        });
      } catch (error) {
        await client
          .request("thread/delete", { threadId: thread.id })
          .catch(() => {});
        client.close();
        throw error;
      } finally {
        registryClient.close();
      }
    }
    const runtime = new TaskRuntime(
      client,
      {
        threadId: thread.id,
        title,
        cwd: input.cwd,
        model: effectiveModel,
        reasoningEffort: input.reasoningEffort,
        messages: [
          {
            id: `local-user-${Date.now()}`,
            role: "user",
            content: input.prompt,
            timestampMs: Date.now(),
          },
        ],
        hasMoreBefore: false,
        beforeCursor: null,
        loadingOlder: false,
        running: true,
        connected: true,
        activeTurnId: null,
        interaction: null,
        error: null,
      },
      {
        profile: input.profile,
        server: input.server,
        managedWorktreeSourcePath: input.managedWorktreeSourcePath,
        onSessionExpired: input.onSessionExpired,
      },
    );
    try {
      await client.request("thread/metadata/update", {
        threadId: thread.id,
        title,
        ...(effectiveModel ? { model: effectiveModel } : {}),
      });
    } catch {
      // Continue the conversation when an older app-server lacks metadata support.
    }
    try {
      await runtime.startOrdinaryTurn({
          threadId: thread.id,
          input: [{ type: "text", text: input.prompt }],
          ...(input.turnMode ? { turnMode: input.turnMode } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(input.reasoningEffort
            ? { reasoningEffort: input.reasoningEffort }
            : {}),
        },
      );
      return runtime;
    } catch (error) {
      if (runtime.snapshot.sendAcceptanceUnknown) return runtime;
      // A transport failure says nothing about acceptance. Never delete a task
      // merely because its turn/start response was lost.
      if (error instanceof MobileRpcError && error.reason === 'remote' &&
          !runtime.snapshot.activeTurnId && runtime.finishedAttempts.size === 0) {
        try {
          await client.request("thread/delete", { threadId: thread.id });
        } catch {
          // Reclaim only an explicitly rejected empty thread, best effort.
        }
      }
      runtime.close();
      throw error;
    }
  }

  static async resume(input: {
    profile: GatewayProfile;
    server: KCoderServer;
    threadId: string;
    cwd?: string;
    title?: string;
    reasoningEffort?: string;
    onSessionExpired?: () => void;
  }): Promise<TaskRuntime> {
    const client = await taskClientConnector(
      input.profile,
      input.server,
      input.cwd,
    );
    const buffered = bufferNotifications(client);
    try {
      const resumed = await client.request<{ thread?: ThreadSummary }>(
        "thread/resume",
        {
          threadId: input.threadId,
        },
      );
      const history = await readHistoryPage(client, input.threadId);
      const agents =
        client.supportsExperimental?.("agentSteering") === true
          ? await client
              .request<AgentListResult>("agent/list", {
                threadId: input.threadId,
              })
              .then((result) =>
                Array.isArray(result.agents) ? result.agents : [],
              )
              .catch(() => [])
          : [];
      const historyThread = history.thread;
      const resumedThread = resumed.thread;
      const runtime = new TaskRuntime(
        null,
        {
          threadId: input.threadId,
          title:
            historyThread?.title ??
            resumedThread?.title ??
            input.title ??
            "KCoder 任务",
          cwd: historyThread?.cwd ?? resumedThread?.cwd ?? input.cwd ?? "/",
          model: threadModelSelector(resumedThread) ?? threadModelSelector(historyThread),
          archivedAt: historyThread?.archivedAt ?? resumedThread?.archivedAt,
          reasoningEffort: input.reasoningEffort,
          messages: history.messages,
          hasMoreBefore: history.hasMoreBefore,
          beforeCursor: history.beforeCursor,
          loadingOlder: false,
          running: threadRunSummaryIsActive(threadRunActivity(historyThread?.status ?? resumedThread?.status,
            parseThreadRunSummary(historyThread?.runSummary ?? resumedThread?.runSummary))),
          connected: true,
          activeTurnId: null,
          interaction: null,
          error: null,
        },
        {
          profile: input.profile,
          server: input.server,
          onSessionExpired: input.onSessionExpired,
        },
      );
      runtime.applySubagentSnapshot(agents);
      runtime.attachBufferedClient(client, buffered);
      runtime.flushPendingDeltas();
      return runtime;
    } catch (error) {
      buffered.cancel();
      client.close();
      throw error;
    }
  }

  static demo(threadId: string): TaskRuntime {
    return new TaskRuntime(null, {
      threadId,
      title:
        threadId === "demo-2" ? "修复移动端登录" : "设计 React Native 客户端",
      cwd: "/data/projects/kcoder",
      model: "MiniMax-M3",
      reasoningEffort: "medium",
      messages: [
        {
          id: "demo-user-1",
          role: "user",
          content:
            "请检查当前项目，并设计一个能远程控制多个 KCoder 服务器的手机客户端。",
          timestampMs: Date.now() - 65_000,
        },
        {
          id: "demo-assistant-1",
          role: "assistant",
          content:
            "我已经完成架构检查。移动端会使用 **Expo + React Native**，通过 Gateway 的 Bearer 会话和 app-server JSON-RPC 与本地或 SSH 服务器通信。\n\n下一步将实现任务历史、实时对话、审批、终端和远程浏览器。",
          timestampMs: Date.now() - 58_000,
          tools: [
            {
              id: "tool-1",
              name: "Read",
              status: "completed",
              output: "已读取项目结构",
            },
            {
              id: "tool-2",
              name: "TodoWrite",
              status: "completed",
              output: "已更新实现计划",
            },
          ],
          fileChanges: {
            artifactId: "demo-file-changes-1",
            workspacePath: "/data/projects/kcoder",
            fileCount: 2,
            additions: 18,
            deletions: 4,
            files: ["src/app.tsx", "src/theme.ts"],
            status: "applied",
            revertible: true,
          },
        },
      ],
      hasMoreBefore: false,
      beforeCursor: null,
      loadingOlder: false,
      running: false,
      connected: true,
      activeTurnId: null,
      interaction: null,
      error: null,
    });
  }

  getSnapshot = (): TaskSnapshot => this.snapshot;

  isDisposed(): boolean {
    return this.disposed;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeProtocol(listener: (message: RpcMessage) => void): () => void {
    this.protocolListeners.add(listener);
    return () => this.protocolListeners.delete(listener);
  }

  request<T = unknown>(
    method: string,
    params: JsonRecord = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.client)
      return Promise.reject(new Error("Web 演示模式没有真实 app-server 连接"));
    if (!this.snapshot.connected)
      return Promise.reject(new Error("KCoder app-server 正在重新连接"));
    return this.client.request<T>(method, params, timeoutMs);
  }

  terminalSession(
    panelId: string,
    initialSessionId?: string,
  ): TaskTerminalSession {
    const existing = this.terminalSessions.get(panelId);
    if (existing) return existing;
    const session = new TaskTerminalSession(
      this,
      panelId,
      this.snapshot.cwd,
      initialSessionId,
    );
    this.terminalSessions.set(panelId, session);
    return session;
  }

  closeTerminalSession(panelId: string): void {
    const session = this.terminalSessions.get(panelId);
    if (!session) return;
    this.terminalSessions.delete(panelId);
    session.dispose(true);
  }

  isLiveTerminalSession(panelId: string): boolean {
    const status = this.terminalSessions.get(panelId)?.getSnapshot().status;
    return (
      status === "starting" || status === "running" || status === "reconnecting"
    );
  }

  hasLiveTerminalSessions(): boolean {
    return [...this.terminalSessions.values()].some((session) => {
      const status = session.getSnapshot().status;
      return (
        status === "starting" ||
        status === "running" ||
        status === "reconnecting"
      );
    });
  }

  continuationState(messageId: string): { allowed: boolean; reason?: string; unknown: boolean } {
    const unknown = this.snapshot.continuationUnknown === messageId;
    const index = this.snapshot.messages.findIndex(message => message.id === messageId);
    const message = this.snapshot.messages[index];
    if (!message || message.status !== 'failed' || !message.turnId || message.continuedByAttemptId)
      return { allowed: false, unknown, reason: '此记录已处理或没有可用恢复点。' };
    if (this.snapshot.messages.slice(index + 1).some(item => item.role === 'user' || (item.role === 'assistant' && item.turnId !== message.turnId)))
      return { allowed: false, unknown, reason: '后续会话已经发生变化，不能自动继续这条旧记录。' };
    if (this.snapshot.archivedAt) return { allowed: false, unknown, reason: '请先恢复已归档的任务。' };
    if (!this.client || !this.client.supportsExperimental?.('failedTurnContinuationV1') ||
      !this.client.supportsExperimental?.('turnRetryOperationV1') ||
      !this.client.supportsExperimental?.('turnAttemptRetryV1'))
      return { allowed: false, unknown, reason: '目标不支持从失败处继续，请升级 KCoder；不会重新提交原消息。' };
    if (!this.snapshot.connected || this.snapshot.running || this.snapshot.continuationPending)
      return { allowed: false, unknown, reason: '请等待当前任务或连接恢复。' };
    return { allowed: true, unknown };
  }

  supportsCurrentConfigurationContinuation(): boolean {
    return this.client?.supportsExperimental?.('retryModelConfigurationV1') === true;
  }

  async continueFailed(messageId: string, useSelectedModel = false): Promise<void> {
    const state = this.continuationState(messageId);
    if (!state.allowed) throw new Error(state.reason);
    if (useSelectedModel && !state.unknown && !this.supportsCurrentConfigurationContinuation())
      throw new Error('目标不支持使用当前配置继续，请升级 KCoder。');
    const message = this.snapshot.messages.find(item => item.id === messageId)!;
    if (useSelectedModel && !state.unknown && (!message.attemptId || !this.snapshot.model))
      throw new Error('此记录缺少恢复身份或尚未选择模型，请刷新任务并选择模型。');
    const client = this.client!;
    const params: JsonRecord = {
      threadId: this.snapshot.threadId, input: [], retryFromTurnId: message.turnId,
      retryFromAttemptId: message.attemptId ?? message.turnId,
      retryOperationId: `retry:${this.snapshot.threadId}:${message.attemptId || message.turnId}`,
    };
    this.patch({ continuationPending: messageId, error: null });
    try {
      if (useSelectedModel && !state.unknown) {
        params.retryModelConfiguration = 'current';
        const model = await negotiateModelSelector(client, this.snapshot.model);
        if (!model) throw new Error('请选择可用模型后再使用当前配置继续。');
        params.model = model;
        if (this.snapshot.reasoningEffort) params.reasoningEffort = this.snapshot.reasoningEffort;
      }
      const recoverClient = async () => {
        if (this.disposed) throw new Error('会话已关闭');
        if (this.client && this.snapshot.connected) return this.client;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        await this.reconnect();
        if (!this.client || !this.snapshot.connected) throw new Error('连接尚未恢复');
        return this.client;
      };
      const submitted = state.unknown
        ? { client, result: await readTurnReceipt(client, params), recovered: true }
        : await startTurnWithReceipt(client, params, recoverClient, {
          invalidReply: () => new MobileRpcError('无效的执行接受回包', -1, 'protocol'),
          ambiguous: error => error instanceof MobileRpcError && error.code === -1 && error.reason !== 'remote',
          unknownOutcome: cause => Object.assign(new Error('执行是否已接受仍未知。请核对状态，不要重复执行。', { cause }), { acceptanceUnknown: true }),
        });
      if (this.disposed) return;
      const turn = submitted.result.turn!;
      const attemptId = turn.attemptId ?? this.attemptByTurn.get(turn.id!) ?? turn.id!;
      this.attemptByTurn.set(turn.id!, attemptId);
      const finished = this.finishedAttempts.has(attemptId) || (turn.status !== undefined && turn.status !== 'running');
      this.patch({ continuationUnknown: null, running: !finished, activeTurnId: finished ? null : turn.id!,
        messages: this.snapshot.messages.map(item => item.id === messageId ? { ...item, continuedByAttemptId: attemptId } : item) });
      // Recovered terminal replies have no live events to project. Read the real
      // attempts instead of synthesizing success or copying the user's input.
      if (submitted.recovered && finished) {
        const generation = this.clientGeneration;
        const history = await readHistoryPage(submitted.client, this.snapshot.threadId);
        if (!this.disposed && this.clientGeneration === generation && !this.snapshot.running)
          this.patch({ messages: mergeReconciledMessages(history.messages, this.snapshot.messages),
            hasMoreBefore: history.hasMoreBefore, beforeCursor: history.beforeCursor });
      }
    } catch (error) {
      if (!this.disposed) this.patch({
        ...(state.unknown || (typeof error === 'object' && error && 'acceptanceUnknown' in error) ? { continuationUnknown: messageId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (!this.disposed) this.patch({ continuationPending: null });
    }
  }

  private async acceptanceClient(): Promise<GatewayRpcClient> {
    if (this.disposed) throw new Error('会话已关闭');
    if (this.client && this.snapshot.connected) return this.client;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.reconnect();
    if (!this.client || !this.snapshot.connected) throw new Error('连接尚未恢复');
    return this.client;
  }

  private async acceptOrdinaryResult(result: TurnStartResult, client: GatewayRpcClient, recovered: boolean): Promise<void> {
    if (this.disposed) return;
    const turn = result.turn!;
    const finished = this.finishedAttempts.has(turn.attemptId ?? turn.id!) ||
      (turn.status !== undefined && turn.status !== 'running');
    this.uncertainSend = null;
    this.patch({ sendAcceptanceUnknown: false, error: null,
      activeTurnId: finished ? null : turn.id!, running: !finished });
    if (recovered && finished) {
      const generation = this.clientGeneration;
      try {
        const history = await readHistoryPage(client, this.snapshot.threadId);
        if (!this.disposed && this.clientGeneration === generation && !this.snapshot.running)
          this.patch({ messages: mergeReconciledMessages(history.messages, this.snapshot.messages),
            hasMoreBefore: history.hasMoreBefore, beforeCursor: history.beforeCursor });
      } catch {
        if (!this.disposed && this.clientGeneration === generation)
          this.patch({ error: '执行已确认，但完整记录读取失败，请重新连接以刷新记录。' });
      }
    }
  }

  private async startOrdinaryTurn(params: JsonRecord): Promise<TurnStartResult> {
    const request = { ...params, clientMessageId: `mobile-${outgoingMessageNamespace}-${Date.now().toString(36)}-${++outgoingMessageSequence}` };
    try {
      const submitted = await startTurnWithReceipt(this.client!, request, () => this.acceptanceClient(), {
        invalidReply: () => new MobileRpcError('无效的执行接受回包', -1, 'protocol'),
        ambiguous: error => error instanceof MobileRpcError && error.reason !== 'remote',
        unknownOutcome: cause => Object.assign(new Error('发送是否已接受仍未知，请核对执行状态；不会重复提交消息。', { cause }), { acceptanceUnknown: true }),
      });
      await this.acceptOrdinaryResult(submitted.result, submitted.client, submitted.recovered);
      return submitted.result;
    } catch (error) {
      if (typeof error === 'object' && error && 'acceptanceUnknown' in error && !this.disposed) {
        this.uncertainSend = request;
        this.patch({ sendAcceptanceUnknown: true, running: false, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  async reconcileSendAcceptance(): Promise<void> {
    if (!this.uncertainSend || this.snapshot.acceptanceChecking) return;
    this.patch({ acceptanceChecking: true });
    try {
      const client = await this.acceptanceClient();
      const result = await readTurnReceipt(client, this.uncertainSend);
      await this.acceptOrdinaryResult(result, client, true);
    } catch (error) {
      if (!this.disposed) this.patch({ error: '执行状态尚未确认，请稍后再次核对；不会重复提交消息。' });
      throw error;
    } finally {
      if (!this.disposed) this.patch({ acceptanceChecking: false });
    }
  }

  async send(
    content: string,
    attachments: StagedAttachment[] = [],
    turnMode?: 'standard' | 'moa' | 'moa-plan',
  ): Promise<void> {
    const command = /^\/(moa-plan|moa)\s+([\s\S]+)$/.exec(content.trim());
    if (command) { turnMode = command[1] as 'moa' | 'moa-plan'; content = command[2]; }
    if (turnMode && turnMode !== 'standard' && !this.client?.supportsExperimental?.('sessionModes')) {
      throw new Error('目标 KCoder 不支持特殊执行模式，请升级后重试');
    }
    if (turnMode === 'moa-plan' && attachments.length) throw new Error('MoA-plan 仅支持文字规划需求');
    const prompt =
      content.trim() || (attachments.length > 0 ? "请查看并分析附件。" : "");
    if (!prompt) return;
    if (this.snapshot.sendAcceptanceUnknown)
      throw new Error('上次发送的执行状态尚未确认，请先核对执行状态。');
    if (this.snapshot.continuationUnknown)
      throw new Error('上次继续请求的执行状态尚未确认，请先核对执行状态。');
    if (this.snapshot.running || this.snapshot.continuationPending)
      throw new Error("当前回合仍在运行，请将消息加入发送队列");
    if (this.snapshot.archivedAt)
      throw new Error("任务已归档，请先恢复后再发送消息");
    if (!this.client) {
      const user: ChatMessage = {
        id: `demo-user-${Date.now()}`,
        role: "user",
        content: prompt,
        timestampMs: Date.now(),
        attachments,
      };
      this.patch({
        messages: [...this.snapshot.messages, user],
        running: true,
      });
      setTimeout(() => {
        const assistant: ChatMessage = {
          id: `demo-assistant-${Date.now()}`,
          role: "assistant",
          content:
            "这是 Web 演示模式的模拟回复。连接真实 Gateway 后，这里会显示 KCoder app-server 的流式响应。",
          timestampMs: Date.now(),
        };
        this.patch({
          messages: [...this.snapshot.messages, assistant],
          running: false,
        });
      }, 650);
      return;
    }
    const user: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: prompt,
      timestampMs: Date.now(),
      attachments,
    };
    this.pendingInteractions = [];
    this.patch({
      messages: [...this.snapshot.messages, user],
      running: true,
      interaction: null,
      error: null,
    });
    try {
      const wirePrompt =
        attachments.length > 0
          ? `${prompt}\n\n<kcoder_attachments version="1">\n${attachments
              .map((attachment) => JSON.stringify(attachment))
              .join("\n")}\n</kcoder_attachments>`
          : prompt;
      const wireModel = await negotiateModelSelector(this.client, this.snapshot.model);
      await this.startOrdinaryTurn({
          threadId: this.snapshot.threadId,
          input: [{ type: "text", text: wirePrompt }],
          ...(turnMode ? { turnMode } : {}),
          ...(wireModel ? { model: wireModel } : {}),
          ...(this.snapshot.reasoningEffort
            ? { reasoningEffort: this.snapshot.reasoningEffort }
            : {}),
        },
      );
    } catch (error) {
      if (this.snapshot.sendAcceptanceUnknown) return;
      this.patch({
        messages: this.snapshot.messages.filter(
          (message) => message.id !== user.id,
        ),
        running: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async loadOlderMessages(): Promise<void> {
    if (
      !this.client ||
      !this.snapshot.connected ||
      !this.snapshot.hasMoreBefore ||
      !this.snapshot.beforeCursor ||
      this.snapshot.loadingOlder
    )
      return;
    const cursor = this.snapshot.beforeCursor;
    const client = this.client;
    const generation = this.clientGeneration;
    this.patch({ loadingOlder: true });
    try {
      let resetHistory = false;
      const page = await readHistoryPage(
        client,
        this.snapshot.threadId,
        cursor,
      ).catch(async error => {
        if (!cursor.startsWith("tp1:") || !(error instanceof Error) || error.message !== "TRANSCRIPT_CURSOR_STALE") throw error;
        if (this.disposed || this.client !== client || this.clientGeneration !== generation) throw error;
        resetHistory = true;
        return readHistoryPage(client, this.snapshot.threadId);
      });
      if (
        this.disposed ||
        this.client !== client ||
        this.clientGeneration !== generation ||
        this.snapshot.beforeCursor !== cursor
      )
        return;
      this.patch({
        messages: mergeReconciledMessages(
          page.messages,
          resetHistory
            ? this.snapshot.messages.filter(message => message.id.startsWith("local-") ||
                (Boolean(this.snapshot.activeTurnId) && message.turnId === this.snapshot.activeTurnId))
            : this.snapshot.messages,
        ),
        hasMoreBefore: page.hasMoreBefore,
        beforeCursor: page.beforeCursor,
        loadingOlder: false,
      });
    } catch (error) {
      if (
        !this.disposed &&
        this.client === client &&
        this.clientGeneration === generation &&
        this.snapshot.beforeCursor === cursor
      ) {
        this.patch({
          loadingOlder: false,
          error: `读取更早消息失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.snapshot.activeTurnId) return;
    await this.client.request("turn/interrupt", {
      threadId: this.snapshot.threadId,
      turnId: this.snapshot.activeTurnId,
    });
  }

  async steerSubagent(
    agentId: string,
    message: string,
    clientMessageId = `mobile-steer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  ): Promise<AgentSteerResult> {
    const normalizedAgentId = agentId.trim();
    const normalizedMessage = message.trim();
    if (!normalizedAgentId || !normalizedMessage)
      throw new Error("子智能体地址或调整消息不完整");
    if (new TextEncoder().encode(normalizedMessage).byteLength > 64 * 1024)
      throw new Error("子智能体调整消息超过 64 KiB 限制");
    if (!this.client || !this.snapshot.connected)
      throw new Error("KCoder app-server 尚未连接");
    if (!this.client.supportsExperimental("agentSteering"))
      throw new Error("当前 KCoder app-server 不支持定向调整子智能体");
    const result = await this.request<AgentSteerResult>("agent/steer", {
      threadId: this.snapshot.threadId,
      agentId: normalizedAgentId,
      message: normalizedMessage,
      clientMessageId,
    });
    this.updateSubagentSteer(
      normalizedAgentId,
      result.status,
      result.messageId,
      result.clientMessageId ?? clientMessageId,
    );
    return result;
  }

  async rename(title: string): Promise<void> {
    const normalized = title.trim();
    if (!normalized) throw new Error("任务标题不能为空");
    if (this.client) {
      await this.request("thread/metadata/update", {
        threadId: this.snapshot.threadId,
        title: normalized,
      });
    }
    this.patch({ title: normalized });
  }

  async setTurnPreferences(
    model: string,
    reasoningEffort?: string,
  ): Promise<void> {
    let normalizedModel = model.trim();
    const normalizedEffort = reasoningEffort?.trim() || undefined;
    if (!normalizedModel || normalizedModel.length > 256)
      throw new Error("模型标识无效");
    if (normalizedEffort && !/^[A-Za-z0-9._-]{1,40}$/.test(normalizedEffort))
      throw new Error("推理强度无效");
    if (this.snapshot.running) throw new Error("当前回合结束后才能切换模型");
    if (this.snapshot.archivedAt)
      throw new Error("任务已归档，请先恢复后再切换模型");
    if (this.client) normalizedModel = await negotiateModelSelector(this.client, normalizedModel) ?? normalizedModel;
    if (this.client && normalizedModel !== this.snapshot.model) {
      await this.request("thread/metadata/update", {
        threadId: this.snapshot.threadId,
        model: normalizedModel,
      });
    }
    this.patch({ model: normalizedModel, reasoningEffort: normalizedEffort });
  }

  async archive(): Promise<void> {
    const archivedAt = new Date().toISOString();
    if (this.client) {
      await this.request("thread/metadata/update", {
        threadId: this.snapshot.threadId,
        archivedAt,
      });
    }
    this.patch({ archivedAt });
  }

  async unarchive(): Promise<void> {
    if (!this.client) {
      this.patch({ archivedAt: undefined });
      return;
    }
    await this.request("thread/metadata/update", {
      threadId: this.snapshot.threadId,
      archivedAt: null,
    });
    this.patch({ archivedAt: undefined });
  }

  async compact(): Promise<ThreadCompactResult> {
    if (this.snapshot.running) throw new Error("任务运行中不能压缩上下文");
    if (!this.client) {
      return {
        threadId: this.snapshot.threadId,
        compacted: false,
        preTokens: 0,
        postTokens: 0,
      };
    }
    return this.request<ThreadCompactResult>(
      "thread/compact",
      { threadId: this.snapshot.threadId },
      60_000,
    );
  }

  async setGoal(
    objective: string,
    mode: GoalMode = "standard",
    options: {
      tokenBudget?: number;
      verificationKind?: "artifact" | "answer";
      expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">;
      requireNoGoal?: boolean;
    } = {},
  ): Promise<ThreadGoal | null> {
    const normalized = objective.trim();
    if (!normalized) throw new Error("目标不能为空");
    if (this.snapshot.running) throw new Error("当前回合结束后才能设置目标");
    if (this.snapshot.archivedAt)
      throw new Error("任务已归档，请先恢复后再设置目标");
    if (!this.client) return null;
    const result = await this.request<{ goal: ThreadGoal }>("thread/goal/set", {
      threadId: this.snapshot.threadId,
      objective: normalized,
      mode,
      ...(options.tokenBudget === undefined
        ? {}
        : { tokenBudget: options.tokenBudget }),
      ...(options.verificationKind === undefined
        ? {}
        : { verificationKind: options.verificationKind }),
      ...(options.expectedGoal === undefined
        ? {}
        : {
            expectedGoalId: options.expectedGoal.goalId,
            expectedRevision: options.expectedGoal.revision,
          }),
      ...(options.requireNoGoal ? { requireNoGoal: true } : {}),
      status: "active",
    });
    return result.goal;
  }

  async getGoal(): Promise<ThreadGoal | null> {
    if (!this.client) return null;
    const result = await this.request<{ goal?: ThreadGoal | null }>(
      "thread/goal/get",
      {
        threadId: this.snapshot.threadId,
      },
    );
    return result.goal ?? null;
  }

  async getGoalHistory(): Promise<ThreadGoal[]> {
    if (!this.client) return [];
    const result = await this.request<{ goals?: ThreadGoal[] }>(
      "thread/goal/history",
      {
        threadId: this.snapshot.threadId,
      },
    );
    return result.goals ?? [];
  }

  async updateGoalStatus(status: "active" | "paused"): Promise<ThreadGoal> {
    if (!this.client) throw new Error("当前任务未连接");
    const current = await this.getGoal();
    if (!current) throw new Error("当前没有目标");
    const result = await this.request<{ goal: ThreadGoal }>("thread/goal/set", {
      threadId: this.snapshot.threadId,
      status,
      expectedGoalId: current.goalId,
      expectedRevision: current.revision,
    });
    return result.goal;
  }

  async editGoal(
    objective: string,
    tokenBudget?: number,
    expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">,
  ): Promise<ThreadGoal> {
    const normalized = objective.trim();
    if (!normalized) throw new Error("目标不能为空");
    if (!this.client) throw new Error("当前任务未连接");
    const current = expectedGoal ?? (await this.getGoal());
    if (!current) throw new Error("当前没有目标");
    const result = await this.request<{ goal: ThreadGoal }>("thread/goal/set", {
      threadId: this.snapshot.threadId,
      objective: normalized,
      edit: true,
      expectedGoalId: current.goalId,
      expectedRevision: current.revision,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    });
    return result.goal;
  }

  async clearGoal(
    expectedGoal?: Pick<ThreadGoal, "goalId" | "revision">,
  ): Promise<boolean> {
    if (!this.client) return false;
    const current = expectedGoal ?? (await this.getGoal());
    if (!current) return false;
    const result = await this.request<{ cleared?: boolean }>(
      "thread/goal/clear",
      {
        threadId: this.snapshot.threadId,
        expectedGoalId: current.goalId,
        expectedRevision: current.revision,
      },
    );
    return result.cleared === true;
  }

  async deleteThread(): Promise<void> {
    if (this.snapshot.running) throw new Error("请先停止当前回合");
    if (!this.client) return;
    const attachmentPaths = await collectThreadAttachmentPaths(
      this.client,
      this.snapshot.threadId,
      attachmentPathsFromMessages(this.snapshot.messages),
    );
    await this.request("thread/delete", { threadId: this.snapshot.threadId });
    if (this.reconnectContext) {
      const registryClient = await taskClientConnector(
        this.reconnectContext.profile,
        this.reconnectContext.server,
        this.reconnectContext.managedWorktreeSourcePath ??
          this.reconnectContext.server.workspacePath,
      ).catch(() => null);
      await registryClient
        ?.request("runtime.worktrees.conversations.remove", {
          deviceId: this.reconnectContext.server.id,
          path: this.snapshot.cwd,
          taskId: this.snapshot.threadId,
        })
        .catch(() => {});
      registryClient?.close();
    }
    for (const path of attachmentPaths) {
      await this.request("attachment/delete", { path }).catch(() => {});
    }
  }

  respondApproval(
    decision: "accept" | "accept_for_session" | "decline" | "cancel",
  ): void {
    const interaction = this.snapshot.interaction;
    if (
      !this.client ||
      interaction?.kind !== "approval" ||
      interaction.responding
    )
      return;
    this.markInteractionResponding(interaction.requestId);
    try {
      this.client.respond(interaction.requestId, { decision });
    } catch (error) {
      this.markInteractionResponding(interaction.requestId, false);
      throw error;
    }
  }

  respondQuestions(answers: Record<string, string[]>): void {
    const interaction = this.snapshot.interaction;
    if (
      !this.client ||
      interaction?.kind !== "question" ||
      interaction.responding
    )
      return;
    this.markInteractionResponding(interaction.requestId);
    try {
      this.client.respond(interaction.requestId, {
        answers: Object.fromEntries(
          Object.entries(answers).map(([id, values]) => [
            id,
            { answers: values },
          ]),
        ),
      });
    } catch (error) {
      this.markInteractionResponding(interaction.requestId, false);
      throw error;
    }
  }

  cancelQuestions(): void {
    const interaction = this.snapshot.interaction;
    if (
      !this.client ||
      interaction?.kind !== "question" ||
      interaction.responding
    )
      return;
    this.markInteractionResponding(interaction.requestId);
    try {
      this.client.respondError(
        interaction.requestId,
        -32800,
        "the user cancelled the question request",
      );
    } catch (error) {
      this.markInteractionResponding(interaction.requestId, false);
      throw error;
    }
  }

  close(): void {
    if (this.disposed) return;
    for (const session of this.terminalSessions.values())
      session.dispose(false);
    this.terminalSessions.clear();
    this.disposed = true;
    this.uncertainSend = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.unsubscribeRpc?.();
    this.unsubscribeRpc = null;
    this.client?.close();
    this.client = null;
    this.clientGeneration += 1;
    this.pendingInteractions = [];
    if (this.deltaFlushTimer) clearTimeout(this.deltaFlushTimer);
    this.deltaFlushTimer = null;
    this.pendingAssistantDeltas.clear();
    this.pendingThinkingDeltas.clear();
    this.patch({
      connected: false,
      running: false,
      activeTurnId: null,
      interaction: null,
      interactionCount: 0,
    });
  }

  private attachClient(client: GatewayRpcClient): void {
    this.unsubscribeRpc?.();
    this.client = client;
    this.clientGeneration += 1;
    this.unsubscribeRpc = client.subscribe((message) =>
      this.handleRpc(message),
    );
  }

  private attachBufferedClient(
    client: GatewayRpcClient,
    buffered: BufferedSubscription,
  ): void {
    this.unsubscribeRpc?.();
    this.client = client;
    this.clientGeneration += 1;
    this.unsubscribeRpc = buffered.activate((message) =>
      this.handleRpc(message),
    );
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || !this.reconnectContext || this.reconnectTimer) return;
    if (this.reconnecting) {
      this.reconnectRequested = true;
      this.patch({
        connected: false,
        running: false,
        error: `${reason}，正在重新连接…`,
      });
      return;
    }
    if (this.reconnectAttempt >= 8 && Date.now() < this.reconnectContext.profile.expiresAt) {
      this.pendingInteractions = [];
      this.patch({ connected: false, running: false, interaction: null,
        error: '目标连接失败，已停止自动重连。可重试连接；其他目标仍保持登录。' });
      return;
    }
    if (Date.now() >= this.reconnectContext.profile.expiresAt) {
      this.reconnectContext.onSessionExpired?.();
      this.pendingInteractions = [];
      this.patch({
        connected: false,
        running: false,
        interaction: null,
        error: "Gateway 会话已失效，请前往设置重新连接",
      });
      return;
    }
    const delayMs = gatewayReconnectDelay(Math.min(500 * 2 ** this.reconnectAttempt, 8_000));
    this.pendingInteractions = [];
    this.patch({
      connected: false,
      running: false,
      interaction: null,
      error: `${reason}，正在重新连接…`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
  }

  async reconnectNow(): Promise<void> {
    if (this.disposed) throw new Error('会话已关闭');
    if (!this.reconnectContext || Date.now() >= this.reconnectContext.profile.expiresAt)
      throw new Error('Gateway 会话已失效，请前往设置重新连接');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    await this.reconnect();
  }

  private reconnect(): Promise<void> {
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = this.performReconnect().finally(() => { this.reconnectPromise = null; });
    return this.reconnectPromise;
  }

  private async performReconnect(): Promise<void> {
    if (this.disposed || !this.reconnectContext || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectRequested = false;
    let nextClient: GatewayRpcClient | null = null;
    let buffered: BufferedSubscription | null = null;
    try {
      nextClient = await taskClientConnector(
        this.reconnectContext.profile,
        this.reconnectContext.server,
        this.snapshot.cwd,
      );
      buffered = bufferNotifications(nextClient);
      const resumed = await nextClient.request<{ thread?: ThreadSummary }>(
        "thread/resume",
        {
          threadId: this.snapshot.threadId,
        },
      );
      const history = await readHistoryPage(nextClient, this.snapshot.threadId);
      if (this.disposed) {
        buffered.cancel();
        nextClient.close();
        return;
      }
      const historyThread = history.thread;
      const resumedThread = resumed.thread;
      const continuousHistory = historiesOverlap(
        history.messages,
        this.snapshot.messages,
      ) && ((!nextClient.supportsExperimental?.("threadIndexedPagesV1") &&
          !this.snapshot.beforeCursor?.startsWith("tp1:") && !history.beforeCursor?.startsWith("tp1:")) ||
        (nextClient.supportsExperimental?.("threadIndexedPagesV1") &&
          this.snapshot.beforeCursor?.startsWith("tp1:") === true &&
          history.beforeCursor?.startsWith("tp1:") === true &&
          this.snapshot.beforeCursor.split(':')[1] === history.beforeCursor.split(':')[1]));
      const newestTimestamp = history.messages.at(-1)?.timestampMs ?? 0;
      const optimisticTail = this.snapshot.messages.filter(
        (message) =>
          message.id.startsWith("local-") &&
          message.timestampMs >= newestTimestamp,
      );
      const messages = mergeReconciledMessages(
        history.messages,
        continuousHistory ? this.snapshot.messages : optimisticTail,
      );
      const retainedExpandedHistory =
        continuousHistory &&
        this.snapshot.messages.length > history.messages.length;
      this.unsubscribeRpc?.();
      this.unsubscribeRpc = null;
      this.client?.close();
      this.client = null;
      this.reconnectAttempt = 0;
      this.pendingInteractions = [];
      this.patch({
        title:
          historyThread?.title ?? resumedThread?.title ?? this.snapshot.title,
        cwd: historyThread?.cwd ?? resumedThread?.cwd ?? this.snapshot.cwd,
        model:
          threadModelSelector(resumedThread) ?? threadModelSelector(historyThread) ?? this.snapshot.model,
        archivedAt: historyThread?.archivedAt ?? resumedThread?.archivedAt,
        messages,
        hasMoreBefore: retainedExpandedHistory
          ? this.snapshot.hasMoreBefore
          : history.hasMoreBefore,
        beforeCursor: retainedExpandedHistory
          ? this.snapshot.beforeCursor
          : history.beforeCursor,
        loadingOlder: false,
        running: threadRunSummaryIsActive(threadRunActivity(historyThread?.status ?? resumedThread?.status,
          parseThreadRunSummary(historyThread?.runSummary ?? resumedThread?.runSummary))),
        connected: true,
        activeTurnId: null,
        interaction: null,
        error: null,
      });
      this.attachBufferedClient(nextClient, buffered);
      buffered = null;
      nextClient = null;
    } catch (error) {
      buffered?.cancel();
      nextClient?.close();
      this.reconnectAttempt += 1;
      this.patch({
        connected: false,
        running: false,
        error: `重新连接失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.reconnecting = false;
    }
    if (this.reconnectRequested || !this.snapshot.connected)
      this.scheduleReconnect("连接仍不可用");
  }

  private handleRpc(message: RpcMessage): void {
    const params = record(message.params);
    if (message.id == null && !this.notificationReplayGuard.accept(message.method ?? "", params)) return;
    try { this.handleAcceptedRpc(message); }
    catch (error) { this.notificationReplayGuard.release(message.method ?? "", params); throw error; }
  }

  private handleAcceptedRpc(message: RpcMessage): void {
    const params = record(message.params);
    for (const listener of this.protocolListeners) listener(message);
    if (message.method === "connection/closed") {
      this.scheduleReconnect(text(params.reason) ?? "连接已断开");
      return;
    }
    if (
      typeof message.id === "number" &&
      message.method === "approval/request"
    ) {
      this.enqueueInteraction({
        kind: "approval",
        requestId: message.id,
        approvalId: text(params.approvalId) ?? String(message.id),
        reason: text(params.reason) ?? "KCoder 请求执行此操作",
        action: record(params.action),
        availableDecisions: Array.isArray(params.availableDecisions)
          ? params.availableDecisions.filter(
              (
                value,
              ): value is
                "accept" | "accept_for_session" | "decline" | "cancel" =>
                value === "accept" ||
                value === "accept_for_session" ||
                value === "decline" ||
                value === "cancel",
            )
          : undefined,
      });
      return;
    }
    if (
      typeof message.id === "number" &&
      message.method === "question/request"
    ) {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      this.enqueueInteraction({
        kind: "question",
        requestId: message.id,
        questionId: text(params.questionId) ?? String(message.id),
        questions: questions.map((value, index) => {
          const question = record(value);
          return {
            id: text(question.id) ?? `question-${index + 1}`,
            header: text(question.header) ?? "问题",
            prompt: text(question.prompt) ?? "请选择",
            options: (Array.isArray(question.options)
              ? question.options
              : []
            ).map((option) => {
              const item = record(option);
              return {
                label: text(item.label) ?? text(item.value) ?? "选项",
                value: text(item.value) ?? text(item.label) ?? "",
                description: text(item.description),
              };
            }),
            allowsFreeform: question.allowsFreeform !== false,
            multiSelect: question.multiSelect === true,
          };
        }),
      });
      return;
    }
    if (
      message.method === "approval/resolved" ||
      message.method === "question/resolved"
    ) {
      this.resolveInteraction(
        message.method === "approval/resolved" ? "approval" : "question",
        params,
      );
      return;
    }
    if (message.method === "thread/goal/continuation" && text(params.reason)) {
      this.patch({ error: text(params.reason) });
      return;
    }
    if (message.method === "turn/started") {
      this.flushPendingDeltas();
      const turnId = turnIdFrom(message);
      const attemptId = text(params.attemptId) ?? text(record(params.turn).attemptId) ?? turnId;
      this.attemptByTurn.set(turnId, attemptId);
      if (Number.isSafeInteger(params.sequence)) this.attemptSequence.set(turnId, Number(params.sequence));
      if (this.attemptByTurn.size > 256) { const first = this.attemptByTurn.keys().next().value!; this.attemptByTurn.delete(first); this.attemptSequence.delete(first); }
      const messages = this.snapshot.messages.map(item => item.role === 'assistant' && item.turnId === turnId && item.status === 'failed' &&
        !item.continuedByAttemptId && (item.attemptId ?? turnId) !== attemptId ? { ...item, continuedByAttemptId: attemptId } : item);
      this.patch({ running: true, activeTurnId: turnId, messages, error: null, continuationUnknown: null });
      return;
    }
    const eventTurn = turnIdFrom(message);
    const floor = this.attemptSequence.get(eventTurn);
    if (floor !== undefined && Number.isSafeInteger(params.sequence) && Number(params.sequence) < floor) return;
    if (message.method === "item/delta") {
      const delta = text(record(params.delta).text);
      if (!delta) return;
      this.appendAssistantDelta(turnIdFrom(message), delta);
      return;
    }
    if (message.method === "agent/steer/applied") {
      const agentId = text(params.agentId);
      const messageId = text(params.messageId);
      if (agentId && messageId) {
        this.updateSubagentSteer(
          agentId,
          "applied",
          messageId,
          text(params.clientMessageId),
        );
      }
      return;
    }
    if (message.method === "item/event") {
      const event = record(params.event);
      if (event.type === "assistant_thinking_delta") {
        const delta = text(event.text);
        if (delta) this.appendThinkingDelta(turnIdFrom(message), delta);
        return;
      }
      this.updateActivity(turnIdFrom(message), event);
      return;
    }
    if (message.method === "item/started") {
      this.flushPendingDeltas();
      const item = record(params.item);
      if (item.type === "toolCall") {
        if (text(item.name)?.toLowerCase() === "todowrite")
          this.updateTodos(turnIdFrom(message), item);
        else this.updateTool(turnIdFrom(message), item, false);
      }
      return;
    }
    if (message.method === "item/completed") {
      this.flushPendingDeltas();
      const item = record(params.item);
      if (
        item.type === "toolCall" &&
        text(item.name)?.toLowerCase() !== "todowrite"
      )
        this.updateTool(turnIdFrom(message), item, true);
      return;
    }
    if (message.method === "turn/completed") {
      const turnId = turnIdFrom(message);
      const turn = record(params.turn);
      const attemptId = text(turn.attemptId) ?? this.attemptByTurn.get(turnId) ?? turnId;
      if (this.attemptByTurn.has(turnId) && this.attemptByTurn.get(turnId) !== attemptId) return;
      this.flushPendingDeltas();
      this.attemptByTurn.set(turnId, attemptId);
      this.finishedAttempts.add(attemptId);
      if (this.finishedAttempts.size > 256) this.finishedAttempts.delete(this.finishedAttempts.values().next().value!);
      const error = text(record(params.error).message);
      const providerFailure = decodeProviderFailure(record(params.error).details);
      const messages = [...this.snapshot.messages];
      const index = this.ensureAssistantMessage(messages, turnId);
      const status = turn.status === 'failed' || error ? 'failed' : ['interrupted', 'cancelled'].includes(String(turn.status)) ? 'cancelled' : 'completed';
      const fileChanges = fileChangesFromValue(params.fileChanges ?? params.file_changes);
      messages[index] = { ...messages[index], status, attemptId, ...(providerFailure ? { providerFailure } : {}), ...(error ? { error } : {}), ...(fileChanges ? { fileChanges } : {}) };
      if (this.snapshot.activeTurnId && this.snapshot.activeTurnId !== turnId) { this.patch({ messages }); return; }
      this.pendingInteractions = [];
      this.patch({ messages, running: false, activeTurnId: null, interaction: null, interactionCount: 0, error: error ?? null });
    }
  }

  private enqueueInteraction(interaction: PendingInteraction): void {
    const existing = this.pendingInteractions.findIndex(
      (item) => item.requestId === interaction.requestId,
    );
    if (existing >= 0) this.pendingInteractions[existing] = interaction;
    else this.pendingInteractions.push(interaction);
    this.patch({
      interaction: this.pendingInteractions[0] ?? null,
      interactionCount: this.pendingInteractions.length,
    });
  }

  private resolveInteraction(
    kind: PendingInteraction["kind"],
    params: JsonRecord,
  ): void {
    const requestId =
      typeof params.requestId === "number" ? params.requestId : undefined;
    const identity =
      kind === "approval" ? text(params.approvalId) : text(params.questionId);
    const index = this.pendingInteractions.findIndex((item) => {
      if (item.kind !== kind) return false;
      if (requestId !== undefined) return item.requestId === requestId;
      return kind === "approval"
        ? (item as ApprovalInteraction).approvalId === identity
        : (item as QuestionInteraction).questionId === identity;
    });
    // An unmatched stale notification must not clear an interaction still awaiting the user.
    if (index < 0) return;
    this.pendingInteractions.splice(index, 1);
    this.patch({
      interaction: this.pendingInteractions[0] ?? null,
      interactionCount: this.pendingInteractions.length,
    });
  }

  private markInteractionResponding(
    requestId: number,
    responding = true,
  ): void {
    const index = this.pendingInteractions.findIndex(
      (item) => item.requestId === requestId,
    );
    if (index < 0) return;
    this.pendingInteractions[index] = {
      ...this.pendingInteractions[index],
      responding,
    };
    this.patch({
      interaction: this.pendingInteractions[0] ?? null,
      interactionCount: this.pendingInteractions.length,
    });
  }

  private appendAssistantDelta(turnId: string, delta: string): void {
    const pending = this.pendingAssistantDeltas.get(turnId) ?? [];
    pending.push(delta);
    this.pendingAssistantDeltas.set(turnId, pending);
    this.scheduleDeltaFlush();
  }

  private appendThinkingDelta(turnId: string, delta: string): void {
    const pending = this.pendingThinkingDeltas.get(turnId) ?? [];
    pending.push(delta);
    this.pendingThinkingDeltas.set(turnId, pending);
    this.scheduleDeltaFlush();
  }

  private scheduleDeltaFlush(): void {
    if (this.deltaFlushTimer || this.disposed) return;
    this.deltaFlushTimer = setTimeout(() => {
      this.deltaFlushTimer = null;
      this.flushPendingDeltas();
    }, 80);
  }

  private flushPendingDeltas(): void {
    if (this.deltaFlushTimer) clearTimeout(this.deltaFlushTimer);
    this.deltaFlushTimer = null;
    if (
      this.pendingAssistantDeltas.size === 0 &&
      this.pendingThinkingDeltas.size === 0
    )
      return;
    const messages = [...this.snapshot.messages];
    const turnIds = new Set([
      ...this.pendingAssistantDeltas.keys(),
      ...this.pendingThinkingDeltas.keys(),
    ]);
    for (const turnId of turnIds) {
      const index = this.ensureAssistantMessage(messages, turnId);
      const current = messages[index];
      const contentDelta =
        this.pendingAssistantDeltas.get(turnId)?.join("") ?? "";
      const thinkingDelta =
        this.pendingThinkingDeltas.get(turnId)?.join("") ?? "";
      messages[index] = {
        ...current,
        content: contentDelta
          ? current.content + contentDelta
          : current.content,
        thinking: thinkingDelta
          ? `${current.thinking ?? ""}${thinkingDelta}`
          : current.thinking,
      };
    }
    this.pendingAssistantDeltas.clear();
    this.pendingThinkingDeltas.clear();
    this.patch({ messages });
  }

  private updateTool(
    turnId: string,
    item: JsonRecord,
    completed: boolean,
  ): void {
    const messages = [...this.snapshot.messages];
    const index = this.ensureAssistantMessage(messages, turnId);
    const current = messages[index];
    const tools = [...(current.tools ?? [])];
    const id = text(item.id) ?? `tool-${tools.length + 1}`;
    const toolIndex = tools.findIndex((tool) => tool.id === id);
    const existingTool = toolIndex >= 0 ? tools[toolIndex] : undefined;
    const tool: ToolCallView = {
      id,
      name: text(item.name) ?? existingTool?.name ?? "Tool",
      status: completed
        ? item.status === "failed"
          ? "failed"
          : "completed"
        : "running",
      input: item.input ?? existingTool?.input,
      output: item.output ?? existingTool?.output,
    };
    if (toolIndex >= 0) tools[toolIndex] = tool;
    else tools.push(tool);
    messages[index] = { ...current, tools };
    this.patch({ messages });
  }

  private ensureAssistantMessage(
    messages: ChatMessage[],
    turnId: string,
  ): number {
    const attemptId = this.attemptByTurn.get(turnId);
    let index = messages.length - 1;
    while (index >= 0 && !(messages[index].role === 'assistant' && messages[index].turnId === turnId &&
      (!attemptId || (messages[index].attemptId ?? messages[index].turnId) === attemptId))) index -= 1;
    if (index < 0) {
      messages.push({ id: `assistant-${attemptId || turnId}`, turnId, ...(attemptId ? { attemptId } : {}),
        role: 'assistant', content: '', timestampMs: Date.now() });
      index = messages.length - 1;
    }
    return index;
  }

  private updateTodos(turnId: string, item: JsonRecord): void {
    if (text(item.name)?.toLowerCase() !== "todowrite") return;
    const todos = todosFromInput(item.input);
    if (!todos) return;
    const messages = [...this.snapshot.messages];
    const index = this.ensureAssistantMessage(messages, turnId);
    messages[index] = { ...messages[index], todos };
    this.patch({ messages });
  }

  private updateSubagentSteer(
    agentId: string,
    steerStatus: string,
    messageId?: string,
    clientMessageId?: string | null,
  ): void {
    const messages = [...this.snapshot.messages];
    let updated = false;
    for (let index = 0; index < messages.length; index += 1) {
      const activities = messages[index].activities;
      if (!activities?.some((activity) => activity.agentId === agentId))
        continue;
      messages[index] = {
        ...messages[index],
        activities: activities.map((activity) =>
          activity.agentId === agentId
            ? {
                ...activity,
                steerStatus,
                steerMessageId: messageId ?? activity.steerMessageId,
                clientMessageId: clientMessageId ?? activity.clientMessageId,
              }
            : activity,
        ),
      };
      updated = true;
    }
    if (!updated) {
      const turnId = this.snapshot.activeTurnId ?? this.snapshot.threadId;
      const index = this.ensureAssistantMessage(messages, turnId);
      messages[index] = {
        ...messages[index],
        activities: [
          ...(messages[index].activities ?? []),
          {
            id: `background-${agentId}`,
            type: "activity",
            label: `子智能体 ${agentId}`,
            status: "running",
            agentId,
            steerStatus,
            steerMessageId: messageId,
            clientMessageId: clientMessageId ?? undefined,
          },
        ],
      };
    }
    this.patch({ messages });
  }

  private applySubagentSnapshot(agents: AgentSummary[]): void {
    const accepted = agents.filter(agent => this.notificationReplayGuard.canSeedBackgroundRun(agent.backgroundRun ?? {}, agent.status));
    const messages = [...this.snapshot.messages].map(message => ({ ...message, activities: message.activities?.map(activity => {
      const agent = accepted.find(agent => agent.agentId === activity.agentId);
      if (!agent || !["completed", "failed", "cancelled", "halted", "paused"].includes(agent.status)) return activity;
      const status: TaskActivityView["status"] = agent.status === "paused" ? "paused" : agent.status === "completed" ? "completed" : agent.status === "failed" ? "failed" : "cancelled";
      return { ...activity, status };
    }) }));
    const visibleAgents = accepted.filter(
      (agent) =>
        ["pending", "running", "paused"].includes(agent.status) ||
        agent.queueDepth > 0,
    );
    if (visibleAgents.length === 0) {
      this.patch({ messages });
      for (const agent of accepted) this.notificationReplayGuard.seedBackgroundRun(agent.backgroundRun ?? {}, agent.status);
      return;
    }
    const index = this.ensureAssistantMessage(messages, this.snapshot.threadId);
    const activities = [...(messages[index].activities ?? [])];
    for (const agent of visibleAgents) {
      if (!this.notificationReplayGuard.canSeedBackgroundRun(agent.backgroundRun ?? {}, agent.status)) continue;
      const id = `background-${agent.agentId}`;
      const steerStatus =
        agent.queueDepth === 0
          ? undefined
          : agent.headStatus === "blocked"
            ? "queued_behind_blocked"
            : agent.status === "paused"
              ? "queued_paused"
              : ["failed", "completed", "cancelled", "halted"].includes(
                    agent.status,
                  )
                ? "resuming"
                : "queued_live";
      const activity: TaskActivityView = {
        id,
        type: "activity",
        label: agent.agentName?.trim() || `子智能体 ${agent.agentId}`,
        status: agent.status === "paused" ? "paused" : "running",
        agentId: agent.agentId,
        steerStatus,
        steerMessageId: agent.headMessageId,
      };
      const existing = activities.findIndex((item) => item.id === id);
      if (existing >= 0) activities[existing] = activity;
      else activities.push(activity);
    }
    messages[index] = { ...messages[index], activities };
    this.patch({ messages });
    for (const agent of accepted) this.notificationReplayGuard.seedBackgroundRun(agent.backgroundRun ?? {}, agent.status);
  }

  private updateActivity(turnId: string, event: JsonRecord): void {
    const eventType = text(event.type);
    if (!eventType) return;
    const messages = [...this.snapshot.messages];
    const currentIndex = messages.findIndex(
      (message) => message.role === "assistant" && message.turnId === turnId,
    );
    const activities =
      currentIndex >= 0 ? [...(messages[currentIndex].activities ?? [])] : [];
    let activity: TaskActivityView | undefined;
    if (eventType.startsWith("background_job_")) {
      const jobId = text(event.id) ?? "unknown";
      const id = `background-${jobId}`;
      const existing = activities.find((item) => item.id === id);
      const current = Number(event.current);
      const total = Number(event.total);
      const progress =
        Number.isFinite(current) && Number.isFinite(total) && total > 0
          ? `${current} / ${total}`
          : undefined;
      if (eventType === "background_job_started")
        activity = {
          id,
          type: "activity",
          label: text(event.description) ?? "后台任务已启动",
          status: "running",
          agentId: jobId,
        };
      else if (eventType === "background_job_progress")
        activity = {
          id,
          type: "activity",
          label: text(event.message) ?? existing?.label ?? "后台任务运行中",
          detail: text(event.detail) ?? progress,
          status: "running",
          agentId: jobId,
        };
      else if (eventType === "background_job_paused")
        activity = { id, type: "activity", label: existing?.label ?? "后台任务已暂停", detail: text(event.reason), status: "paused", agentId: jobId };
      else if (eventType === "background_job_completed")
        activity = {
          id,
          type: "activity",
          label: existing?.label ?? "后台任务已完成",
          detail: text(event.text),
          status: event.is_error === true ? "failed" : "completed",
          agentId: jobId,
        };
      else if (eventType === "background_job_failed")
        activity = {
          id,
          type: "activity",
          label: existing?.label ?? "后台任务失败",
          detail: text(event.error),
          status: "failed",
          agentId: jobId,
        };
      else if (eventType === "background_job_cancelled" || eventType === "background_job_halted")
        activity = {
          id,
          type: "cancelled",
          label: existing?.label ?? "后台任务已取消",
          detail: text(event.reason),
          status: "cancelled",
          agentId: jobId,
        };
    } else if (eventType === "system_notice") {
      const notice = text(event.text);
      if (notice && /compact/i.test(notice))
        activity = {
          id: `compaction-${activities.length}`,
          type: "compaction",
          label: "上下文已压缩",
          detail: notice,
          status: "completed",
        };
      else if (notice)
        activity = {
          id: `notice-${activities.length}`,
          type: "notice",
          label: notice,
          status: "completed",
        };
    } else if (eventType === "compaction_failed") {
      activity = {
        id: `compaction-${activities.length}`,
        type: "compaction",
        label: "上下文压缩失败",
        detail: text(event.error),
        status: "failed",
      };
    } else if (eventType === "stream_aborted") {
      const reason = text(event.reason) ?? "任务流已中止";
      const cancelled = /cancel/i.test(reason);
      activity = {
        id: `aborted-${activities.length}`,
        type: cancelled ? "cancelled" : "activity",
        label: cancelled ? "本轮已取消" : "任务流已中止",
        detail: reason,
        status: cancelled ? "cancelled" : "failed",
      };
    } else if (eventType === "error") {
      activity = {
        id: `error-${activities.length}`,
        type: "activity",
        label: "运行失败",
        detail: text(event.error),
        status: "failed",
      };
    } else if (eventType === "hook_message") {
      activity = {
        id: `hook-${activities.length}`,
        type: "activity",
        label: text(event.text) ?? "Hook 消息",
        status: event.is_error === true ? "failed" : "completed",
      };
    }
    if (!activity) return;
    const activityId = activity.id;
    const previousActivity = activities.find((item) => item.id === activityId);
    if (previousActivity) {
      activity = {
        ...activity,
        steerStatus: previousActivity.steerStatus,
        steerMessageId: previousActivity.steerMessageId,
        clientMessageId: previousActivity.clientMessageId,
      };
    }
    const index =
      currentIndex >= 0
        ? currentIndex
        : this.ensureAssistantMessage(messages, turnId);
    const existingIndex = activities.findIndex(
      (item) => item.id === activityId,
    );
    if (existingIndex >= 0) activities[existingIndex] = activity;
    else activities.push(activity);
    messages[index] = { ...messages[index], activities };
    this.patch({ messages });
  }

  private patch(update: Partial<TaskSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}

export interface TaskTerminalSnapshot {
  panelId: string;
  sessionId: string | null;
  cwd: string;
  status: "idle" | "starting" | "running" | "reconnecting" | "exited" | "error";
  error: string | null;
  sequence: number;
}

export interface TaskTerminalOutputEvent {
  kind: "append" | "replace";
  data: string;
  sequence: number;
}

interface BufferedTerminalProtocolEvent {
  sequence: number;
  kind: "output" | "exit";
  data?: string;
  exitCode?: string;
}

/**
 * The task runtime owns the terminal rather than a page component. WebSocket and PTY
 * can therefore survive route pop, and re-entering the task only reattaches the
 * renderer to the same bounded transcript.
 */
export class TaskTerminalSession {
  private readonly listeners = new Set<Listener>();
  private readonly outputListeners = new Set<
    (event: TaskTerminalOutputEvent) => void
  >();
  private readonly transcript = new TerminalTranscriptBuffer();
  private readonly unsubscribeProtocol: () => void;
  private readonly unsubscribeTask: () => void;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private reconnectQueued = false;
  private lastProtocolSequence = 0;
  private readonly pendingProtocolEvents: BufferedTerminalProtocolEvent[] = [];
  private scrollbackLines = 10_000;
  private terminalSize = { rows: 28, cols: 100 };
  private snapshot: TaskTerminalSnapshot;

  constructor(
    private readonly task: TaskRuntime,
    panelId: string,
    cwd: string,
    initialSessionId?: string,
  ) {
    this.snapshot = {
      panelId,
      sessionId: initialSessionId ?? null,
      cwd,
      status: "idle",
      error: null,
      sequence: 0,
    };
    this.unsubscribeProtocol = task.subscribeProtocol((message) =>
      this.handleProtocol(message),
    );
    this.unsubscribeTask = task.subscribe(() => this.handleTaskState());
  }

  getSnapshot = (): TaskTerminalSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeOutput(
    listener: (event: TaskTerminalOutputEvent) => void,
  ): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  getTranscript(): string {
    return this.transcript.toString();
  }

  setScrollbackLines(lines: number): void {
    this.scrollbackLines = Math.max(
      1_000,
      Math.min(100_000, Math.round(lines)),
    );
    const maxCharacters = terminalTranscriptCharacterLimit(
      this.scrollbackLines,
    );
    this.transcript.setLimits(maxCharacters, this.scrollbackLines);
  }

  async start(): Promise<void> {
    if (this.disposed || this.snapshot.status === "running") return;
    if (this.startPromise) return this.startPromise;
    if (!this.task.getSnapshot().connected) {
      this.patch({
        status: "reconnecting",
        error: this.snapshot.sessionId
          ? "主连接恢复后将重新附着原终端"
          : "主连接恢复后将创建终端会话",
      });
      return;
    }
    const generation = ++this.generation;
    const startSize = { ...this.terminalSize };
    const previousSessionId = this.snapshot.sessionId;
    let createdSessionId: string | null = null;
    this.patch({ status: "starting", error: null });
    this.pendingProtocolEvents.length = 0;
    this.startPromise = (async () => {
      let sessionId = previousSessionId;
      let cwd = this.snapshot.cwd;
      let created = false;
      if (!sessionId) {
        const result = await this.task.request<{
          session_id?: string;
          cwd?: string;
        }>("terminal/start", {
          cwd,
          rows: startSize.rows,
          cols: startSize.cols,
        });
        if (!result.session_id)
          throw new Error("app-server 未返回 terminal session id");
        sessionId = result.session_id;
        createdSessionId = sessionId;
        cwd = result.cwd ?? cwd;
        created = true;
        if (this.disposed || generation !== this.generation) {
          void this.task
            .request("terminal/close", { session_id: sessionId })
            .catch(() => {});
          return;
        }
        this.patch({ sessionId, cwd });
      }
      const attached = await this.task.request<{
        session_id?: string;
        cwd?: string;
        transcript?: string;
        through_sequence?: number;
      }>("terminal/attach", {
        session_id: sessionId,
        rows: startSize.rows,
        cols: startSize.cols,
      });
      if (!attached.session_id)
        throw new Error("app-server 未返回 terminal attach session id");
      if (this.disposed || generation !== this.generation) {
        if (created)
          void this.task
            .request("terminal/close", { session_id: sessionId })
            .catch(() => {});
        return;
      }
      cwd = attached.cwd ?? cwd;
      this.lastProtocolSequence = Math.max(
        0,
        Number(attached.through_sequence ?? 0),
      );
      this.replace(
        `\u001b[1;32mKCoder Terminal\u001b[0m · ${cwd}\r\n${attached.transcript ?? ""}`,
      );
      this.patch({ sessionId, cwd, status: "running", error: null });
      const buffered = this.pendingProtocolEvents
        .splice(0)
        .sort((left, right) => left.sequence - right.sequence);
      for (const event of buffered) this.applyProtocolEvent(event);
      if (
        this.terminalSize.rows !== startSize.rows ||
        this.terminalSize.cols !== startSize.cols
      ) {
        this.sendResize(
          sessionId,
          this.terminalSize.rows,
          this.terminalSize.cols,
        );
      }
    })()
      .catch((value) => {
        if (this.disposed || generation !== this.generation) return;
        this.pendingProtocolEvents.length = 0;
        const reconnectFailed = Boolean(previousSessionId);
        if (createdSessionId && this.task.getSnapshot().connected) {
          void this.task
            .request("terminal/close", { session_id: createdSessionId })
            .catch(() => {});
        }
        this.patch({
          sessionId: null,
          status: "error",
          error: reconnectFailed
            ? `原终端已不可用：${value instanceof Error ? value.message : String(value)}`
            : value instanceof Error
              ? value.message
              : String(value),
        });
      })
      .finally(() => {
        if (generation === this.generation) this.startPromise = null;
      });
    return this.startPromise;
  }

  async restart(): Promise<void> {
    const previous = this.snapshot.sessionId;
    this.generation += 1;
    this.startPromise = null;
    this.pendingProtocolEvents.length = 0;
    this.lastProtocolSequence = 0;
    this.patch({ sessionId: null, status: "idle", error: null });
    if (previous && this.task.getSnapshot().connected) {
      await this.task
        .request("terminal/close", { session_id: previous })
        .catch(() => {});
    }
    await this.start();
  }

  write(data: string): void {
    const sessionId = this.snapshot.sessionId;
    if (!sessionId || !data) return;
    void this.task
      .request("terminal/write", { session_id: sessionId, data })
      .catch((value) => {
        this.patch({
          error: value instanceof Error ? value.message : String(value),
        });
      });
  }

  resize(rows: number, cols: number): void {
    if (
      !Number.isFinite(rows) ||
      !Number.isFinite(cols) ||
      rows < 1 ||
      cols < 1
    )
      return;
    this.terminalSize = { rows: Math.floor(rows), cols: Math.floor(cols) };
    const sessionId = this.snapshot.sessionId;
    if (!sessionId) return;
    this.sendResize(sessionId, this.terminalSize.rows, this.terminalSize.cols);
  }

  private sendResize(sessionId: string, rows: number, cols: number): void {
    void this.task
      .request("terminal/resize", {
        session_id: sessionId,
        rows,
        cols,
      })
      .catch(() => {});
  }

  captureSnapshot(data: string, sequence: number): void {
    if (sequence !== this.snapshot.sequence) return;
    this.transcript.replace(data);
  }

  dispose(closeRemote: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.unsubscribeProtocol();
    this.unsubscribeTask();
    const sessionId = this.snapshot.sessionId;
    this.outputListeners.clear();
    this.listeners.clear();
    if (closeRemote && sessionId && this.task.getSnapshot().connected) {
      void this.task
        .request("terminal/close", { session_id: sessionId })
        .catch(() => {});
    }
  }

  private handleTaskState(): void {
    if (this.disposed) return;
    if (!this.task.getSnapshot().connected) {
      if (
        this.snapshot.status === "running" ||
        this.snapshot.status === "starting"
      ) {
        this.generation += 1;
        this.startPromise = null;
        this.pendingProtocolEvents.length = 0;
        this.patch({
          status: "reconnecting",
          error: "连接中断，恢复后将重新附着原终端",
        });
      }
      return;
    }
    if (this.snapshot.status !== "reconnecting" || this.reconnectQueued) return;
    this.reconnectQueued = true;
    queueMicrotask(() => {
      this.reconnectQueued = false;
      if (!this.disposed && this.snapshot.status === "reconnecting")
        void this.start();
    });
  }

  private handleProtocol(message: RpcMessage): void {
    const params = record(message.params);
    if (message.method === "terminal/output") {
      const eventSession = String(params.session_id ?? "");
      const data = String(params.data ?? "");
      const sequence = Number(params.sequence ?? this.lastProtocolSequence + 1);
      if (
        eventSession !== this.snapshot.sessionId ||
        !Number.isFinite(sequence)
      )
        return;
      const event: BufferedTerminalProtocolEvent = {
        sequence,
        kind: "output",
        data,
      };
      if (
        this.snapshot.status === "starting" ||
        this.snapshot.status === "reconnecting"
      )
        this.pendingProtocolEvents.push(event);
      else this.applyProtocolEvent(event);
      return;
    }
    if (message.method === "terminal/exit") {
      const eventSession = String(params.session_id ?? "");
      const exit = String(params.exit_code ?? 0);
      const sequence = Number(params.sequence ?? this.lastProtocolSequence + 1);
      if (
        eventSession !== this.snapshot.sessionId ||
        !Number.isFinite(sequence)
      )
        return;
      const event: BufferedTerminalProtocolEvent = {
        sequence,
        kind: "exit",
        exitCode: exit,
      };
      if (
        this.snapshot.status === "starting" ||
        this.snapshot.status === "reconnecting"
      )
        this.pendingProtocolEvents.push(event);
      else this.applyProtocolEvent(event);
    }
  }

  private applyProtocolEvent(event: BufferedTerminalProtocolEvent): void {
    if (event.sequence <= this.lastProtocolSequence) return;
    if (event.sequence !== this.lastProtocolSequence + 1) {
      this.patch({
        status: "reconnecting",
        error: "终端输出出现缺口，正在重新同步…",
      });
      if (!this.reconnectQueued) {
        this.reconnectQueued = true;
        setTimeout(() => {
          this.reconnectQueued = false;
          if (!this.disposed && this.snapshot.status === "reconnecting")
            void this.start();
        }, 0);
      }
      return;
    }
    this.lastProtocolSequence = event.sequence;
    if (event.kind === "output") {
      this.append(event.data ?? "");
      return;
    }
    this.append(
      `\r\n\u001b[33m[进程已退出：${event.exitCode ?? "0"}]\u001b[0m\r\n`,
    );
    this.patch({
      sessionId: null,
      status: "exited",
      error: "终端进程已退出，可点击重新启动",
    });
  }

  private append(data: string): void {
    if (!data) return;
    this.transcript.append(data);
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    for (const listener of this.outputListeners)
      listener({ kind: "append", data, sequence });
  }

  private replace(data: string): void {
    this.transcript.replace(data);
    const sequence = this.snapshot.sequence + 1;
    this.snapshot = { ...this.snapshot, sequence };
    for (const listener of this.outputListeners)
      listener({ kind: "replace", data: this.transcript.toString(), sequence });
  }

  private patch(update: Partial<TaskTerminalSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}

class TaskRuntimeRegistry {
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly maxHotRuntimes = 8;

  key(profileId: string, serverId: string, threadId: string): string {
    return `${profileId}\0${serverId}\0${threadId}`;
  }

  get(
    profileId: string,
    serverId: string,
    threadId: string,
  ): TaskRuntime | undefined {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    if (runtime) {
      this.runtimes.delete(key);
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  put(profileId: string, serverId: string, runtime: TaskRuntime): void {
    const key = this.key(profileId, serverId, runtime.getSnapshot().threadId);
    const previous = this.runtimes.get(key);
    if (previous && previous !== runtime) previous.close();
    this.runtimes.delete(key);
    this.runtimes.set(key, runtime);
    while (this.runtimes.size > this.maxHotRuntimes) {
      const idle = [...this.runtimes.entries()].find(([, candidate]) => {
        if (candidate === runtime) return false;
        const snapshot = candidate.getSnapshot();
        return (
          !snapshot.running &&
          !snapshot.interaction &&
          !candidate.hasLiveTerminalSessions()
        );
      });
      // Active turns and tasks awaiting user responses must never be cancelled silently because of UI cache limits.
      if (!idle) break;
      this.runtimes.delete(idle[0]);
      idle[1].close();
    }
  }

  remove(profileId: string, serverId: string, threadId: string): void {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    this.runtimes.delete(key);
    runtime?.close();
  }

  removeProfile(profileId: string): void {
    const prefix = `${profileId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      runtime.close();
    }
  }

  removeServer(profileId: string, serverId: string): void {
    const prefix = `${profileId}\0${serverId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      runtime.close();
    }
  }
}

export const taskRuntimeRegistry = new TaskRuntimeRegistry();

export const taskRuntimeTestHelpers = {
  fileChangesFromValue,
  setConnector(connector: TaskClientConnector): void {
    taskClientConnector = connector;
  },
  resetConnector(): void {
    taskClientConnector = GatewayRpcClient.connect;
  },
};

export interface ThreadListPage {
  threads: ThreadSummary[];
  nextCursor?: string;
  completeness: "complete" | "partial";
  issueCount: number;
}

export interface ThreadListFilter {
  archived?: boolean;
  query?: string;
}

function readThreadListPage(result: Partial<ThreadListPage>, allowPartial: boolean): ThreadListPage {
  const completeness = result.completeness ?? (allowPartial ? undefined : "complete");
  const issueCount = result.issueCount ?? (allowPartial ? undefined : 0);
  if ((allowPartial && !Array.isArray(result.threads)) ||
    (completeness !== "complete" && completeness !== "partial") ||
    typeof issueCount !== "number" || !Number.isSafeInteger(issueCount) || issueCount < 0 ||
    (completeness === "complete" && issueCount !== 0)) {
    throw new Error("app-server 未返回有效的会话列表完整性");
  }
  return { threads: result.threads ?? [], nextCursor: result.nextCursor?.trim() || undefined, completeness, issueCount };
}

/** A thread/list cursor belongs to one app-server connection, so the paginator keeps that connection until explicit close. */
export class ThreadListPager {
  private client: GatewayRpcClient | null = null;
  private connecting: Promise<GatewayRpcClient> | null = null;
  private closed = false;
  private snapshot: ThreadListPage | null = null;
  private readonly cursors = new Set<string>();

  constructor(
    private readonly profile: GatewayProfile,
    private readonly server: KCoderServer,
    private readonly filter: ThreadListFilter = {},
  ) {}

  async page(cursor?: string, limit = 50): Promise<ThreadListPage> {
    if (this.closed) throw new Error("历史分页器已关闭");
    if (cursor && this.cursors.size >= 200) throw new Error("会话列表分页超过安全上限，请缩小搜索范围");
    const client = await this.connect();
    const allowPartial = client.supportsExperimental?.("threadListCompleteness") === true;
    const result = await client.request<Partial<ThreadListPage>>("thread/list", {
      limit: Math.max(1, Math.min(100, Math.floor(limit))),
      ...(allowPartial ? { allowPartial: true } : {}),
      ...(cursor ? { cursor } : {}),
      ...(this.filter.archived === undefined
        ? {}
        : { archived: this.filter.archived }),
      ...(this.filter.query?.trim() ? { query: this.filter.query.trim() } : {}),
    });
    const { completeness, issueCount, nextCursor } = readThreadListPage(result, allowPartial);
    if (cursor && this.snapshot && (
      this.snapshot.completeness !== completeness || this.snapshot.issueCount !== issueCount
    )) throw new Error("app-server 会话列表快照完整性在分页期间发生变化");
    if (!cursor) this.cursors.clear();
    if (nextCursor && this.cursors.has(nextCursor)) throw new Error("app-server 返回了重复的 thread/list cursor");
    if (nextCursor) this.cursors.add(nextCursor);
    const threads = new Map((cursor ? this.snapshot?.threads ?? [] : []).map((thread) => [thread.id, thread]));
    for (const thread of result.threads ?? []) threads.set(thread.id, thread);
    this.snapshot = {
      threads: [...threads.values()].sort(
        (a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt),
      ),
      nextCursor,
      completeness,
      issueCount,
    };
    return this.snapshot;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client?.close();
    this.client = null;
    void this.connecting?.then((client) => client.close()).catch(() => {});
    this.connecting = null;
  }

  private async connect(): Promise<GatewayRpcClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = taskClientConnector(
        this.profile,
        this.server,
        this.server.workspacePath,
      );
    }
    const client = await this.connecting;
    if (this.closed) {
      client.close();
      throw new Error("历史分页器已关闭");
    }
    this.client = client;
    this.connecting = null;
    return client;
  }
}

export async function listThreads(
  profile: GatewayProfile,
  server: KCoderServer,
  limit = 100,
  filter: ThreadListFilter = {},
): Promise<ThreadListPage> {
  const pager = new ThreadListPager(profile, server, filter);
  try {
    let page = await pager.page(undefined, limit);
    while (page.nextCursor) {
      if (page.threads.length > 10_000) throw new Error("会话列表超过 10000 条，请使用历史搜索");
      page = await pager.page(page.nextCursor, limit);
    }
    return page;
  } finally {
    pager.close();
  }
}

export async function updateThreadMetadata(
  profile: GatewayProfile,
  server: KCoderServer,
  threadId: string,
  update: { title?: string; archivedAt?: string | null },
  cwd?: string,
): Promise<void> {
  const client = await taskClientConnector(
    profile,
    server,
    cwd ?? server.workspacePath,
  );
  try {
    await client.request("thread/metadata/update", { threadId, ...update });
  } finally {
    client.close();
  }
}

export async function deleteStoredThread(
  profile: GatewayProfile,
  server: KCoderServer,
  threadId: string,
  cwd?: string,
  attachmentPaths: readonly string[] = [],
): Promise<void> {
  const client = await taskClientConnector(
    profile,
    server,
    cwd ?? server.workspacePath,
  );
  try {
    const allAttachmentPaths = await collectThreadAttachmentPaths(
      client,
      threadId,
      attachmentPaths,
    );
    await client.request("thread/delete", { threadId });
    if (cwd) {
      const registryClient = await taskClientConnector(
        profile,
        server,
        server.workspacePath,
      ).catch(() => null);
      await registryClient
        ?.request("runtime.worktrees.conversations.remove", {
          deviceId: server.id,
          path: cwd,
          taskId: threadId,
        })
        .catch(() => {});
      registryClient?.close();
    }
    for (const path of allAttachmentPaths) {
      await client.request("attachment/delete", { path }).catch(() => {});
    }
  } finally {
    client.close();
  }
}

export interface ModelOption {
  configuration?: ModelConfigurationSummary;
  id: string;
  model: string;
  displayName: string;
  providerId: string;
  providerName: string;
  providerCurrent?: boolean;
  isDefault?: boolean;
  supportsVision?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  supportsFastMode?: boolean;
}

export function defaultModelOption(
  models: readonly ModelOption[],
): ModelOption | undefined {
  return (
    models.find((model) => model.providerCurrent && model.isDefault) ??
    models.find((model) => model.isDefault) ??
    models.find((model) => model.providerCurrent) ??
    models[0]
  );
}

export function modelOptionSelector(model: ModelOption): string {
  return model.id.includes("::") ? model.id : `${model.providerId}::${model.model}`;
}

export function threadModelSelector(thread?: Pick<ThreadSummary, "model" | "modelProvider" | "model_provider" | "providerId">): string | undefined {
  const model = thread?.model;
  const provider = thread?.modelProvider ?? thread?.model_provider ?? thread?.providerId;
  return model && provider && !model.includes("::") ? `${provider}::${model}` : model;
}

export function selectedModelOption(models: readonly ModelOption[], selection?: string): ModelOption | undefined {
  return models.find(model => modelOptionSelector(model) === selection)
    ?? models.find(model => model.model === selection)
    ?? (models.filter(model => model.providerId === selection).length === 1
      ? models.find(model => model.providerId === selection) : undefined);
}

export async function listModels(
  profile: GatewayProfile,
  server: KCoderServer,
): Promise<ModelOption[]> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const result = await client.request<{ data?: ModelOption[] }>(
      "runtime.models.list",
    );
    return Array.isArray(result.data) ? result.data.map(model => ({ ...model, configuration: readModelConfiguration(model.configuration) })) : [];
  } finally {
    client.close();
  }
}

export async function openWorkspace(
  profile: GatewayProfile,
  server: KCoderServer,
  workspacePath: string,
  create = false,
): Promise<string> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    if (create) {
      const prepared = await client.request<{
        mapping?: { workspacePath?: string };
      }>("runtime.workspaces.prepare", {
        deviceId: server.id,
        workspacePath,
        action: "create",
        label: workspacePath.split("/").filter(Boolean).at(-1) ?? "Workspace",
      });
      return prepared.mapping?.workspacePath ?? workspacePath;
    }
    const result = await client.request<{ workspacePath?: string }>(
      "runtime.workspaces.open",
      {
        deviceId: server.id,
        workspacePath,
        label: workspacePath.split("/").filter(Boolean).at(-1) ?? "Workspace",
      },
    );
    return result.workspacePath ?? workspacePath;
  } finally {
    client.close();
  }
}

export interface WorkspaceOption {
  path: string;
  label: string;
  kind: "workspace" | "worktree";
}

export interface ManagedWorktree {
  deviceId: string;
  worktreeId: string;
  path: string;
  repositoryName: string;
  sourcePath?: string | null;
  permanent: boolean;
  revision: number;
  state:
    | "active"
    | "restorable"
    | "missing"
    | "snapshot_ready"
    | "restoring"
    | string;
  snapshotAt?: number | null;
  lastError?: string | null;
  conversations: JsonRecord[];
}

export interface ManagedWorktreeArchivePreview {
  path: string;
  state: string;
  revision: number;
  contentToken: string | null;
  dirty: boolean;
  untrackedFileCount: number;
  ignoredEntryCount: number;
  dirtySubmoduleCount: number;
  nestedRepositoryCount: number;
  baselineKnown: boolean;
  commitsSinceCreation: number | null;
  requiresConfirmation: boolean;
  archiveAllowed: boolean;
  blockingReasons: string[];
  archivedConversations: JsonRecord[];
}

function managedWorktree(item: JsonRecord): ManagedWorktree | null {
  const path = text(item.path);
  const worktreeId = text(item.worktreeId);
  if (!path || !worktreeId) return null;
  return {
    deviceId: text(item.deviceId) ?? "local",
    worktreeId,
    path,
    repositoryName: text(item.repositoryName) ?? worktreeId,
    sourcePath: text(item.sourcePath),
    permanent: item.permanent === true,
    revision: numberValue(item.revision) ?? 0,
    state: text(item.state) ?? "missing",
    snapshotAt: numberValue(item.snapshotAt),
    lastError: text(item.lastError),
    conversations: Array.isArray(item.conversations)
      ? item.conversations.filter(isRecord)
      : [],
  };
}

export async function listManagedWorktrees(
  profile: GatewayProfile,
  server: KCoderServer,
): Promise<ManagedWorktree[]> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const result = await client.request<{ items?: JsonRecord[] }>(
      "runtime.worktrees.list",
      {
        deviceId: server.id,
      },
    );
    return (result.items ?? [])
      .map(managedWorktree)
      .filter((item): item is ManagedWorktree => item !== null);
  } finally {
    client.close();
  }
}

export async function previewManagedWorktreeArchive(
  profile: GatewayProfile,
  server: KCoderServer,
  path: string,
): Promise<ManagedWorktreeArchivePreview> {
  const archivedConversations = await managedWorktreeConversations(
    profile,
    server,
    path,
  );
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    await client.request(
      "gateway/workspace/release",
      { workspacePath: path },
      60_000,
    );
    const result = await client.request<{
      preview?: ManagedWorktreeArchivePreview;
    }>(
      "runtime.worktrees.archive.preview",
      { deviceId: server.id, path },
      60_000,
    );
    if (!result.preview) throw new Error("app-server 未返回 worktree 归档预检");
    return { ...result.preview, archivedConversations };
  } finally {
    client.close();
  }
}

export async function archiveManagedWorktree(
  profile: GatewayProfile,
  server: KCoderServer,
  preview: ManagedWorktreeArchivePreview,
  riskAccepted: boolean,
): Promise<ManagedWorktree> {
  if (!preview.contentToken) throw new Error("worktree 内容校验 token 不可用");
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const result = await client.request<{ worktree?: JsonRecord }>(
      "runtime.worktrees.archive",
      {
        deviceId: server.id,
        path: preview.path,
        expectedRevision: preview.revision,
        expectedContentToken: preview.contentToken,
        riskAccepted,
        archivedConversations: preview.archivedConversations,
      },
      90_000,
    );
    const worktree = result.worktree ? managedWorktree(result.worktree) : null;
    if (!worktree) throw new Error("app-server 未返回已归档 worktree");
    return worktree;
  } finally {
    client.close();
  }
}

async function managedWorktreeConversations(
  profile: GatewayProfile,
  server: KCoderServer,
  path: string,
): Promise<JsonRecord[]> {
  const client = await taskClientConnector(profile, server, path);
  try {
    const conversations: JsonRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (seenCursors.size >= 200) throw new Error("worktree 关联会话分页超过安全上限");
      const allowPartial = client.supportsExperimental?.("threadListCompleteness") === true;
      const result = await client.request<Partial<ThreadListPage>>("thread/list", {
        limit: 100, ...(cursor ? { cursor } : {}), ...(allowPartial ? { allowPartial: true } : {}),
      });
      if (readThreadListPage(result, allowPartial).completeness === "partial")
        throw new Error("worktree 关联会话列表不完整，请修复来源或稍后重试归档");
      for (const thread of result.threads ?? []) {
        if (thread.cwd && thread.cwd !== path) continue;
        conversations.push({
          deviceId: server.id,
          taskId: thread.id,
          threadId: thread.id,
          workspacePath: path,
          title: thread.title ?? `KCoder 会话 ${thread.id.slice(0, 8)}`,
          model: thread.model ?? null,
          createdAt: timestampMs(thread.createdAt),
          updatedAt: timestampMs(thread.updatedAt),
        });
      }
      const nextCursor = result.nextCursor?.trim();
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor))
        throw new Error("app-server 返回了重复的 thread/list cursor");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (conversations.length > 10_000)
        throw new Error("worktree 关联会话数量超过 10000");
    } while (cursor);
    return conversations;
  } finally {
    client.close();
  }
}

export async function restoreManagedWorktree(
  profile: GatewayProfile,
  server: KCoderServer,
  worktree: ManagedWorktree,
): Promise<ManagedWorktree> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const result = await client.request<{ worktree?: JsonRecord }>(
      "runtime.worktrees.restore",
      {
        deviceId: server.id,
        path: worktree.path,
        expectedRevision: worktree.revision,
      },
      90_000,
    );
    const restored = result.worktree ? managedWorktree(result.worktree) : null;
    if (!restored) throw new Error("app-server 未返回已恢复 worktree");
    return restored;
  } finally {
    client.close();
  }
}

export async function forgetManagedWorktree(
  profile: GatewayProfile,
  server: KCoderServer,
  worktree: ManagedWorktree,
): Promise<void> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const result = await client.request<{ forgotten?: boolean }>(
      "runtime.worktrees.forget",
      {
        deviceId: server.id,
        path: worktree.path,
        expectedRevision: worktree.revision,
        confirmPermanent: true,
      },
      60_000,
    );
    if (result.forgotten !== true)
      throw new Error("app-server 未永久删除 worktree 快照");
  } finally {
    client.close();
  }
}

export async function listWorkspaceOptions(
  profile: GatewayProfile,
  server: KCoderServer,
): Promise<WorkspaceOption[]> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    const byPath = new Map<string, WorkspaceOption>();
    const [workspaces, worktrees] = await Promise.all([
      client.request<{ items?: JsonRecord[] }>("runtime.workspaces.list", {
        deviceId: server.id,
      }),
      client.request<{ items?: JsonRecord[] }>("runtime.worktrees.list", {
        deviceId: server.id,
      }),
    ]);
    for (const item of workspaces.items ?? []) {
      const path = text(item.workspacePath);
      if (!path) continue;
      byPath.set(path, {
        path,
        label: text(item.label) ?? path.split("/").at(-1) ?? path,
        kind: item.workspaceKind === "worktree" ? "worktree" : "workspace",
      });
    }
    for (const item of worktrees.items ?? []) {
      const path = text(item.path);
      if (!path || item.state !== "active") continue;
      byPath.set(path, {
        path,
        label:
          text(item.repositoryName) ??
          text(item.worktreeId) ??
          path.split("/").at(-1) ??
          path,
        kind: "worktree",
      });
    }
    return [...byPath.values()];
  } finally {
    client.close();
  }
}

export async function prepareManagedWorktree(
  profile: GatewayProfile,
  server: KCoderServer,
  sourcePath: string,
  gitRef?: string,
): Promise<string> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
  );
  try {
    await client.request("runtime.workspaces.open", {
      deviceId: server.id,
      workspacePath: sourcePath,
      label: sourcePath.split("/").filter(Boolean).at(-1) ?? "Workspace",
    });
    const worktreeId = `mobile-${Date.now().toString(36)}`;
    const result = await client.request<{
      success?: boolean;
      path?: string;
      error?: string;
    }>(
      "runtime.worktrees.prepare",
      {
        deviceId: server.id,
        sourcePath,
        worktreeId,
        permanent: false,
        ...(gitRef?.trim() ? { ref: gitRef.trim() } : {}),
      },
      60_000,
    );
    if (result.success !== true || !result.path)
      throw new Error(result.error || "app-server 未创建 worktree");
    return result.path;
  } finally {
    client.close();
  }
}
