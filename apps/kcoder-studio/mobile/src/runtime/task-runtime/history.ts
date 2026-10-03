import { GatewayRpcClient } from "@/gateway/rpc";
import type { ThreadSummary } from "@/gateway/types";
import { normalizeMessage } from "./normalizers";
import { type ChatMessage, type ThreadReadPage } from "./types";

export async function readHistoryPage(
  client: GatewayRpcClient,
  threadId: string,
  beforeCursor?: string,
): Promise<{
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
          const failed = (value: ChatMessage) =>
            value.status === "failed" || value.status === "cancelled";
          if (failed(message) !== failed(candidate)) return false;
          if (failed(message) || (message.attemptId && candidate.attemptId))
            return (
              (message.attemptId ?? message.turnId) ===
              (candidate.attemptId ?? candidate.turnId)
            );
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
