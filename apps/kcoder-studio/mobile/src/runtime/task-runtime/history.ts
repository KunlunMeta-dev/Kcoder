import { isThreadTranscriptObservationV1, isThreadTranscriptSnapshotV1,
  type ThreadTranscriptObservationV1, type ThreadTranscriptSnapshotV1 } from "../../../../shared/generated/contracts";
import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import type { ThreadMessage, ThreadSummary } from "@/gateway/types";
import { normalizeMessage } from "./normalizers";
import { type ChatMessage, type ThreadReadPage, type TaskSnapshot } from "./types";
import type { TaskRuntime } from "./core";

// Body provenance only: auxiliary row projections do not make historical text
// live. This neither orders events nor proves an observed body committed.
const pureHistoryRows = new WeakSet<ChatMessage>();
const observedDecorations = new WeakMap<ChatMessage, Set<keyof ChatMessage>>();
const decorationKeys = ["tools", "todos", "activities", "fileChanges", "fileChangesCapture", "reviewEvidence", "status", "error", "providerFailure",
  "continuedByAttemptId", "interactionSummaries"] as const;

/** Preserve historical body through auxiliary projection, including read-ahead
 * stream adoption. Only changed rows with a historical body are inspected. */
export function preserveHistoryBodyProvenance(previous: ChatMessage, next: ChatMessage): ChatMessage {
  if (previous === next || pureHistoryRows.has(next) || !pureHistoryRows.has(previous)) return next;
  const bodyBlocks = (message: ChatMessage, kind: "text" | "thinking") =>
    (message.orderedBlocks ?? []).flatMap(block => block.kind === kind ? [block.content] : []).join("");
  if (previous.content !== next.content || previous.thinking !== next.thinking ||
      bodyBlocks(previous, "text") !== bodyBlocks(next, "text") ||
      bodyBlocks(previous, "thinking") !== bodyBlocks(next, "thinking")) return next;
  pureHistoryRows.add(next);
  const dirty = new Set(observedDecorations.get(previous));
  for (const key of decorationKeys) if (previous[key] !== next[key]) dirty.add(key);
  const nonBody = (message: ChatMessage) => (message.orderedBlocks ?? [])
    .filter(block => block.kind !== "text" && block.kind !== "thinking");
  const before = nonBody(previous); const after = nonBody(next);
  if (before.length !== after.length || before.some((block, index) => block !== after[index])) dirty.add("orderedBlocks");
  if (dirty.size) observedDecorations.set(next, dirty);
  return next;
}

export async function readHistoryPage(
  client: GatewayRpcClient,
  threadId: string,
  beforeCursor?: string,
): Promise<{
  sourcePage: ThreadReadPage;
  transcriptSnapshotV1?: ThreadTranscriptSnapshotV1;
  transcriptObservationV1?: ThreadTranscriptObservationV1;
  thread?: ThreadSummary;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  beforeCursor: string | null;
}> {
  const method = client.supportsExperimental?.("threadIndexedPagesV1")
    ? "thread/read/indexed"
    : "thread/read";
  const page = await client.request<ThreadReadPage>(method, {
    threadId,
    limit: 50,
    ...(beforeCursor ? { beforeCursor } : {}),
  });
  if (page.thread && page.thread.id !== threadId)
    throw new MobileRpcError("Thread history belongs to a different thread", -32603, "protocol");
  return { ...normalizeHistoryPage(page), sourcePage: page };
}

/** Shared projection only. Legacy read parsing deliberately remains tolerant. */
export function normalizeHistoryPage(page: ThreadReadPage) {
  return {
    thread: page.thread,
    transcriptSnapshotV1: parseTranscriptSnapshot(page.transcriptSnapshotV1),
    transcriptObservationV1: parseTranscriptObservation(page.transcriptObservationV1),
    messages: (page.messages ?? []).flatMap((message, index) => {
      const normalized = normalizeMessage(message, page.thread?.id);
      if (!normalized) return [];
      const row = Number.isSafeInteger(page.rangeStart)
        ? { ...normalized, historyOrdinal: Number(page.rangeStart) + index }
        : normalized;
      pureHistoryRows.add(row);
      return [row];
    }),
    hasMoreBefore: page.hasMoreBefore === true && Boolean(page.beforeCursor),
    beforeCursor:
      page.hasMoreBefore === true ? (page.beforeCursor ?? null) : null,
  };
}

/** Strict validation belongs only to the newly negotiated inline contract.
 * Null means unavailable or budget-omitted history, for one same-client read. */
export function inlineResumeHistoryPage(
  result: unknown,
  expectedThreadId: string,
): ThreadReadPage | null {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const invalid = () => new MobileRpcError(
    "KCoder app-server 返回了无效的恢复历史页", -1, "protocol",
  );
  if (!object(result) || !object(result.thread) || result.thread.id !== expectedThreadId) throw invalid();
  const rawThread = result.thread;
  const threadStatus = (value: unknown): value is ThreadSummary["status"] =>
    value === "idle" || value === "running" || value === "waiting_for_approval" ||
    value === "waiting_for_answer" || value === "background" || value === "aggregating" ||
    value === "unknown" || value === "failed";
  const timestamp = (value: unknown): value is string | number =>
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
  if (typeof rawThread.id !== "string" || !threadStatus(rawThread.status) ||
      !timestamp(rawThread.createdAt) || !timestamp(rawThread.updatedAt)) throw invalid();
  const thread: ThreadSummary = { ...rawThread, id: rawThread.id, status: rawThread.status,
    createdAt: rawThread.createdAt, updatedAt: rawThread.updatedAt };
  if (!("history" in result)) return null;
  if (!object(result.history)) throw invalid();
  const history = result.history;
  if (history.status === "unavailable") {
    if (Object.keys(history).some(key => key !== "status" && key !== "code") ||
        (history.code !== "readFailed" && history.code !== "responseBudgetExceeded")) throw invalid();
    return null;
  }
  if (history.status !== "ready" || !object(history.page) ||
      Object.keys(history).some(key => key !== "status" && key !== "page")) throw invalid();
  const page = history.page;
  const ordinal = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (Object.keys(page).some(key => ![
        "messages", "rangeStart", "rangeEnd", "hasMoreBefore", "beforeCursor", "transcriptSnapshotV1", "transcriptObservationV1",
      ].includes(key)) || !Array.isArray(page.messages) ||
      !ordinal(page.rangeStart) || !ordinal(page.rangeEnd) || page.rangeEnd < page.rangeStart ||
      page.messages.length !== page.rangeEnd - page.rangeStart ||
      typeof page.hasMoreBefore !== "boolean" ||
      (page.beforeCursor !== undefined && page.beforeCursor !== null &&
        (typeof page.beforeCursor !== "string" || !page.beforeCursor)) ||
      (page.hasMoreBefore && (typeof page.beforeCursor !== "string" || !page.beforeCursor)) ||
      (!page.hasMoreBefore && page.beforeCursor != null) ||
      page.messages.some(message => !object(message) ||
        typeof message.id !== "string" || !message.id ||
        typeof message.role !== "string" || !message.role ||
        typeof message.content !== "string" || !ordinal(message.timestampMs))) throw invalid();
  const messages: ThreadMessage[] = page.messages.map((message: unknown) => {
    if (!object(message) || typeof message.id !== "string" || !message.id ||
        typeof message.role !== "string" || !message.role ||
        typeof message.content !== "string" || !ordinal(message.timestampMs)) throw invalid();
    return { ...message, id: message.id, role: message.role,
      content: message.content, timestampMs: message.timestampMs };
  });
  return { thread, messages, transcriptSnapshotV1: parseTranscriptSnapshot(page.transcriptSnapshotV1),
    transcriptObservationV1: parseTranscriptObservation(page.transcriptObservationV1), rangeStart: page.rangeStart, rangeEnd: page.rangeEnd,
    hasMoreBefore: page.hasMoreBefore,
    ...(typeof page.beforeCursor === "string" ? { beforeCursor: page.beforeCursor } : {}) };
}

/** Missing identity remains legacy compatibility, never a verified snapshot. */
function parseTranscriptSnapshot(value: unknown): ThreadTranscriptSnapshotV1 | undefined {
  if (value === undefined) return undefined;
  if (!isThreadTranscriptSnapshotV1(value))
    throw new MobileRpcError("Invalid transcript snapshot identity", -32603, "protocol");
  return value;
}

function parseTranscriptObservation(value: unknown): ThreadTranscriptObservationV1 | undefined {
  if (value === undefined) return undefined;
  if (!isThreadTranscriptObservationV1(value))
    throw new MobileRpcError("Invalid transcript observation identity", -32603, "protocol");
  return value;
}

type TranscriptReadIdentity = Pick<ThreadReadPage, "transcriptSnapshotV1" | "transcriptObservationV1">;

/** Capture both proof domains for an in-flight owner's publication guard.
 * Neither identity orders notifications or authorizes local history deletion. */
export function transcriptReadIdentityKey(value: TranscriptReadIdentity): string | null {
  const snapshot = value.transcriptSnapshotV1;
  const observation = value.transcriptObservationV1;
  const committed = snapshot?.status === "available" ? `${snapshot.snapshotId}:${snapshot.viewKey}` : "";
  const observed = observation ? `${observation.observationId}:${observation.viewKey}` : "";
  return committed || observed ? `${committed}|${observed}` : null;
}

/** Missing proof is compatible with first-page display, never page union. */
export function transcriptReadIdentityMatches(previous: TranscriptReadIdentity, next: TranscriptReadIdentity): boolean {
  const before = previous.transcriptSnapshotV1; const after = next.transcriptSnapshotV1;
  if (before?.status === "available" && after?.status === "available" &&
      before.snapshotId === after.snapshotId && before.viewKey === after.viewKey) return true;
  const observedBefore = previous.transcriptObservationV1; const observedAfter = next.transcriptObservationV1;
  return Boolean(observedBefore && observedAfter && observedBefore.observationId === observedAfter.observationId &&
    observedBefore.viewKey === observedAfter.viewKey);
}

/** Retain the original first page, never the merged/live UI projection. A
 * terminal arriving during this read still requires its own later confirmation. */
export function publishConfirmedHistoryPage(runtime: TaskRuntime, page: ThreadReadPage,
  completedRevision: number, isCurrent: () => boolean): void {
  if (!isCurrent() || runtime.disposed || transcriptReadIdentityKey(page) === null ||
      (page.thread?.id && page.thread.id !== runtime.getSnapshot().threadId)) return;
  runtime.confirmedTranscriptPage = { page, confirmedAt: Date.now() };
  runtime.confirmedTranscriptRevision = completedRevision;
}

/** A confirmed bounded read can repair UI rows without replacing its raw
 * authority with a live projection. Proofs bind history, not notification time. */
export function reconcileConfirmedHistoryPage(runtime: TaskRuntime,
  page: Omit<Awaited<ReturnType<typeof readHistoryPage>>, "sourcePage">): void {
  if (transcriptReadIdentityKey(page) === null) return;
  const snapshot = runtime.getSnapshot();
  const compatible = transcriptReadIdentityMatches(snapshot, page);
  const readOwnerChanged = transcriptReadIdentityKey(snapshot) !== transcriptReadIdentityKey(page);
  runtime.patch({
    messages: mergeReconciledMessages(page.messages,
      compatible ? snapshot.messages : historyResetTail(snapshot, page.messages)),
    transcriptSnapshotV1: page.transcriptSnapshotV1,
    transcriptObservationV1: page.transcriptObservationV1,
    ...(compatible ? {} : { hasMoreBefore: page.hasMoreBefore, beforeCursor: page.beforeCursor }),
    ...(readOwnerChanged ? { loadingOlder: false } : {}),
  });
}

/** These identities bind pages, not event ordering or thread deletion. */
export function transcriptSnapshotChanged(
  previous: ThreadTranscriptSnapshotV1 | undefined,
  next: ThreadTranscriptSnapshotV1 | undefined,
): boolean {
  if (previous?.status !== "available" && next?.status !== "available") return false;
  return previous?.status !== "available" || next?.status !== "available" ||
    previous.snapshotId !== next.snapshotId || previous.viewKey !== next.viewKey;
}

/** A fresh authoritative first page replaces historical body, including legacy rows without
 * ordinals. Observed decorations can update an existing exact row, never revive
 * a removed row. Actual live body remains conservative tail retention without
 * a commit watermark; this is not cross-client deletion authority. */
export function historyResetTail(snapshot: TaskSnapshot, authoritative: ChatMessage[]): ChatMessage[] {
  const byId = new Map(authoritative.map(message => [message.id, message]));
  return snapshot.messages.flatMap(message => {
    if (!pureHistoryRows.has(message) || message.id.startsWith("local-")) return [message];
    const dirty = observedDecorations.get(message);
    const current = byId.get(message.id);
    if (!dirty?.size || !current || current.role !== message.role ||
        (current.turnId && message.turnId && current.turnId !== message.turnId) ||
        (current.attemptId && message.attemptId && current.attemptId !== message.attemptId)) return [];
    const overlay: ChatMessage = { ...current };
    for (const key of decorationKeys) if (dirty.has(key)) Object.assign(overlay, { [key]: message[key] });
    if (dirty.has("orderedBlocks")) overlay.orderedBlocks = mergeOrderedBlocks(current.orderedBlocks,
      message.orderedBlocks?.filter(block => block.kind !== "text" && block.kind !== "thinking"));
    pureHistoryRows.add(overlay);
    observedDecorations.set(overlay, dirty);
    return [overlay];
  });
}

export interface CompletedLivePair {
  readonly user: ChatMessage;
  readonly assistant: ChatMessage;
  readonly turnId: string;
  readonly attemptId: string;
}

/** Capture only an accepted canonical user and its already completed live attempt.
 * The caller must also fence request-time owner and notification changes. */
export function completedLivePairsAtReadStart(
  snapshot: TaskSnapshot,
  finishedAttempts: ReadonlySet<string>,
  attemptByTurn: ReadonlyMap<string, string>,
): CompletedLivePair[] {
  const byTurn = new Map<string, ChatMessage[]>();
  for (const message of snapshot.messages) {
    if (!message.turnId) continue;
    const rows = byTurn.get(message.turnId) ?? [];
    rows.push(message);
    byTurn.set(message.turnId, rows);
  }
  return [...byTurn].flatMap(([turnId, rows]) => {
    if (rows.length !== 2) return [];
    const user = rows.find(row => row.role === "user");
    const assistant = rows.find(row => row.role === "assistant");
    const attemptId = assistant?.attemptId;
    if (!user || !assistant || !attemptId ||
        rows.some(row => pureHistoryRows.has(row) || row.id.startsWith("local-") || row.id.startsWith("demo-")) ||
        !user.id || !assistant.id || user.id === assistant.id ||
        !user.clientMessageId || !user.clientMessageId.trim() ||
        assistant.status !== "completed" ||
        !finishedAttempts.has(attemptId) || attemptByTurn.get(turnId) !== attemptId) return [];
    return [{ user, assistant, turnId, attemptId }];
  });
}

export function attachmentPathsFromMessages(
  messages: readonly ChatMessage[],
): string[] {
  return messages.flatMap(
    (message) =>
      message.attachments?.map((attachment) => attachment.path) ?? [],
  );
}

export async function collectThreadAttachmentPaths(
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
      persisted = findReconciledMessage(
        authoritative,
        message,
        matchedAuthoritative,
      );
    }
    if (!persisted) {
      merged.set(message.id, message);
      continue;
    }
    // An already-loaded authoritative user row can coexist with a new local
    // optimistic copy of the same stable turn during receipt recovery. Its
    // exact-ID projection must not consume the candidate before that copy is
    // reconciled. Fuzzy matches still consume their row to prevent reuse.
    if (persisted.id !== message.id || message.role !== "user")
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
    const transcriptSource = chooseTranscriptSource(persisted, message);
    const otherSource = transcriptSource === message ? persisted : message;
    const observedTerminal = !pureHistoryRows.has(message) && message.role === "assistant" &&
      persisted.role === "assistant" && Boolean(message.turnId) && message.turnId === persisted.turnId &&
      (!message.attemptId || !persisted.attemptId || message.attemptId === persisted.attemptId) &&
      ["completed", "failed", "cancelled"].includes(message.status ?? "") &&
      !["completed", "failed", "cancelled"].includes(persisted.status ?? "");
    const reconciled: ChatMessage = {
      ...persisted,
      clientMessageId: messageClientMessageId(persisted) ?? messageClientMessageId(message),
      content: transcriptSource.content,
      attemptId: persisted.attemptId ?? message.attemptId,
      fileChangesCapture: persisted.fileChangesCapture ?? message.fileChangesCapture,
      reviewEvidence: persisted.reviewEvidence ?? message.reviewEvidence,
      continuedByAttemptId:
        persisted.continuedByAttemptId ?? message.continuedByAttemptId,
      thinking:
        (message.thinking?.length ?? 0) > (persisted.thinking?.length ?? 0)
          ? message.thinking
          : persisted.thinking,
      activities: mergeActivities(persisted.activities, message.activities),
      tools: tools.size > 0 ? [...tools.values()] : undefined,
      orderedBlocks: mergeOrderedBlocks(
        transcriptSource.orderedBlocks,
        otherSource.orderedBlocks,
      ),
      historyOrdinal: persisted.historyOrdinal ?? message.historyOrdinal,
      attachments: persisted.attachments ?? message.attachments,
      fileChanges: persisted.fileChanges ?? message.fileChanges,
      ...(observedTerminal ? { status: message.status, error: message.error, providerFailure: message.providerFailure } : {}),
    };
    if (pureHistoryRows.has(persisted) && pureHistoryRows.has(message)) {
      pureHistoryRows.add(reconciled);
      // Auxiliary updates have their own observed provenance. They cannot
      // choose the historical body, but must survive the ordinary row merge.
      for (const key of decorationKeys)
        if (key !== "tools" && key !== "activities" && observedDecorations.get(message)?.has(key))
          Object.assign(reconciled, { [key]: message[key] });
    }
    const dirty = new Set([...observedDecorations.get(persisted) ?? [], ...observedDecorations.get(message) ?? []]);
    if (dirty.size) observedDecorations.set(reconciled, dirty);
    merged.set(persisted.id, reconciled);
  }
  const reconciled = [...merged.values()];
  const indexed = reconciled
    .filter((message) => Number.isSafeInteger(message.historyOrdinal))
    .sort((left, right) => left.historyOrdinal! - right.historyOrdinal!);
  const unindexed = reconciled.filter(
    (message) => !Number.isSafeInteger(message.historyOrdinal),
  );
  return [...indexed, ...unindexed];
}

function mergeActivities(
  persisted: ChatMessage["activities"],
  local: ChatMessage["activities"],
): ChatMessage["activities"] {
  if (!persisted?.length) return local;
  if (!local?.length) return persisted;
  const activities = new Map(persisted.map((activity) => [activity.id, activity]));
  for (const activity of local) {
    const existing = activities.get(activity.id);
    activities.set(activity.id, existing ? { ...existing, ...activity } : activity);
  }
  return [...activities.values()];
}

function findReconciledMessage(
  authoritative: ChatMessage[],
  local: ChatMessage,
  matched: Set<string>,
): ChatMessage | undefined {
  const candidates = authoritative.flatMap((candidate, index) => {
    if (matched.has(candidate.id) || candidate.role !== local.role) return [];
    if (
      local.role === "assistant" &&
      local.turnId &&
      candidate.turnId === local.turnId
    ) {
      const failed = (value: ChatMessage) =>
        value.status === "failed" || value.status === "cancelled";
      if (failed(local) !== failed(candidate)) return [];
      if (
        local.attemptId &&
        candidate.attemptId &&
        local.attemptId !== candidate.attemptId
      )
        return [];
      return [{ candidate, index, score: transcriptMatchScore(candidate, local) }];
    }
    if (local.role === "user") {
      const localClientMessageId = messageClientMessageId(local);
      const candidateClientMessageId = messageClientMessageId(candidate);
      if (
        localClientMessageId &&
        candidateClientMessageId &&
        localClientMessageId !== candidateClientMessageId
      )
        return [];
      if (
        local.turnId &&
        candidate.turnId &&
        local.turnId !== candidate.turnId
      )
        return [];
      const sameClientMessage =
        Boolean(localClientMessageId) &&
        localClientMessageId === candidateClientMessageId;
      const sameTurn = Boolean(local.turnId) && local.turnId === candidate.turnId;
      if (
        (!sameClientMessage && !sameTurn) ||
        !sameUserPayload(local, candidate)
      )
        return [];
      return [{ candidate, index, score: sameClientMessage ? 20 : 10 }];
    }
    if (
      local.role !== "assistant" &&
      candidate.content === local.content &&
      Math.abs(candidate.timestampMs - local.timestampMs) < 10 * 60_000
    )
      return [{ candidate, index, score: 0 }];
    return [];
  });
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates[0]?.candidate;
}

function messageClientMessageId(message: ChatMessage): string | undefined {
  const value = (message as ChatMessage & { clientMessageId?: unknown })
    .clientMessageId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sameUserPayload(left: ChatMessage, right: ChatMessage): boolean {
  if (left.content !== right.content) return false;
  if (left.attachments && right.attachments) {
    const leftPaths = left.attachments.map((attachment) => attachment.path);
    const rightPaths = right.attachments.map((attachment) => attachment.path);
    if (
      leftPaths.length !== rightPaths.length ||
      leftPaths.some((path, index) => path !== rightPaths[index])
    )
      return false;
  }
  return true;
}

function transcriptMatchScore(left: ChatMessage, right: ChatMessage): number {
  const leftTokens = transcriptTokens(left.orderedBlocks, left.content);
  const rightTokens = transcriptTokens(right.orderedBlocks, right.content);
  if (coveragePrefix(leftTokens, rightTokens) || coveragePrefix(rightTokens, leftTokens))
    return 10_000 + Math.min(leftTokens.length, rightTokens.length);
  let score = 0;
  for (const token of leftTokens) {
    if (token.kind === "tool") {
      if (rightTokens.some((other) => other.kind === "tool" && other.id === token.id))
        score += 10;
    }
  }
  const leftText = leftTokens
    .filter((token) => token.kind === "text")
    .map((token) => token.content)
    .join("");
  const rightText = rightTokens
    .filter((token) => token.kind === "text")
    .map((token) => token.content)
    .join("");
  if (leftText && rightText && (leftText.startsWith(rightText) || rightText.startsWith(leftText)))
    score += Math.min(leftText.length, rightText.length);
  return score;
}

type TranscriptToken =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; id: string };

function transcriptTokens(
  blocks: ChatMessage["orderedBlocks"],
  fallbackContent?: string,
): TranscriptToken[] {
  const tokens: TranscriptToken[] = [];
  for (const block of blocks ?? []) {
    if (block.kind === "text") {
      const previous = tokens.at(-1);
      if (previous?.kind === "text") previous.content += block.content;
      else tokens.push({ kind: "text", content: block.content });
    } else if (block.kind === "thinking") {
      const previous = tokens.at(-1);
      if (previous?.kind === "thinking") previous.content += block.content;
      else tokens.push({ kind: "thinking", content: block.content });
    } else if (block.kind === "tool") {
      tokens.push({ kind: "tool", id: block.id });
    }
  }
  if (tokens.length === 0 && fallbackContent)
    tokens.push({ kind: "text", content: fallbackContent });
  return tokens;
}

function coveragePrefix(
  prefix: TranscriptToken[],
  candidate: TranscriptToken[],
): boolean {
  if (prefix.length > candidate.length) return false;
  return prefix.every((token, index) => {
    const other = candidate[index];
    if (token.kind !== other.kind) return false;
    if (token.kind === "text" || token.kind === "thinking")
      return (
        (other.kind === "text" || other.kind === "thinking") &&
        other.content.startsWith(token.content)
      );
    return other.kind === token.kind && other.id === token.id;
  });
}

function chooseTranscriptSource(
  authoritative: ChatMessage,
  local: ChatMessage,
): ChatMessage {
  const historyTokens = transcriptTokens(
    authoritative.orderedBlocks,
    authoritative.content,
  );
  const localTokens = transcriptTokens(local.orderedBlocks, local.content);
  const historyCoversLocal = coveragePrefix(localTokens, historyTokens);
  const localCoversHistory = coveragePrefix(historyTokens, localTokens);
  if (
    historyCoversLocal &&
    localCoversHistory &&
    hasUnmatchedLiveActivity(local, authoritative)
  )
    return local;
  if (localCoversHistory && !historyCoversLocal) return local;
  if (historyCoversLocal || localCoversHistory) return authoritative;
  // With divergent coverage, the persisted transcript remains the structural
  // source. A live running turn is only promoted when it proves a full prefix.
  return authoritative;
}

function hasUnmatchedLiveActivity(
  local: ChatMessage,
  authoritative: ChatMessage,
): boolean {
  const persistedActivities = new Set(
    (authoritative.orderedBlocks ?? [])
      .flatMap((block) => (block.kind === "activity" ? [block.id] : [])),
  );
  return (local.orderedBlocks ?? []).some(
    (block) => block.kind === "activity" && !persistedActivities.has(block.id),
  );
}

function mergeOrderedBlocks(
  preferred: ChatMessage["orderedBlocks"],
  secondary: ChatMessage["orderedBlocks"],
): ChatMessage["orderedBlocks"] {
  if (!preferred) return secondary;
  if (!secondary) return preferred;
  const blocks = [...preferred];
  for (const candidate of secondary) {
    const index = blocks.findIndex(
      (block) => block.id === candidate.id && block.kind === candidate.kind,
    );
    if (index >= 0) {
      const current = blocks[index];
      if (current.kind === "text" && candidate.kind === "text") {
        blocks[index] = {
          ...current,
          content:
            candidate.content.length > current.content.length
              ? candidate.content
              : current.content,
          sequence: earlierSequence(current.sequence, candidate.sequence),
        };
      } else if (current.kind === "thinking" && candidate.kind === "thinking") {
        blocks[index] = {
          ...current,
          content:
            candidate.content.length > current.content.length
              ? candidate.content
              : current.content,
          sequence: earlierSequence(current.sequence, candidate.sequence),
        };
      } else if (current.kind === "tool" && candidate.kind === "tool") {
        const candidateIsNewer =
          current.status === "running" && candidate.status !== "running";
        blocks[index] = {
          ...current,
          ...(candidateIsNewer ? candidate : {}),
          input: current.input ?? candidate.input,
          output: candidateIsNewer
            ? (candidate.output ?? current.output)
            : (current.output ?? candidate.output),
          interactionSummaries:
            current.interactionSummaries ?? candidate.interactionSummaries,
          sequence: earlierSequence(current.sequence, candidate.sequence),
        };
      } else if (
        current.kind === "activity" &&
        candidate.kind === "activity"
      ) {
        blocks[index] = {
          ...current,
          activity:
            current.activity.status === "running" &&
            candidate.activity.status !== "running"
              ? candidate.activity
              : current.activity,
          sequence: earlierSequence(current.sequence, candidate.sequence),
        };
      }
      continue;
    }
    // Text and thinking have no cross-source producer ID. Keep one complete
    // source projection selected by ordered transcript coverage above; merging
    // individual equal contents would erase valid repeated segments.
    if (candidate.kind === "text" || candidate.kind === "thinking") continue;
    const insertionIndex =
      candidate.sequence === undefined
        ? blocks.length
        : blocks.findIndex(
            (block) =>
              block.sequence !== undefined &&
              block.sequence > candidate.sequence!,
          );
    blocks.splice(insertionIndex < 0 ? blocks.length : insertionIndex, 0, candidate);
  }
  return blocks;
}

function earlierSequence(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export function historiesOverlap(
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
