import { type JsonRecord } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { timestampMs } from "@/protocol/normalizers";
import { taskClientConnector } from "./connectionFactory";
import { isRecord, numberValue, text } from "./normalizers";
import { readThreadListPage, type ThreadListPage } from "./threadDirectory";

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

export function managedWorktree(item: JsonRecord): ManagedWorktree | null {
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

export async function managedWorktreeConversations(
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
      if (seenCursors.size >= 200)
        throw new Error("worktree 关联会话分页超过安全上限");
      const allowPartial =
        client.supportsExperimental?.("threadListCompleteness") === true;
      const result = await client.request<Partial<ThreadListPage>>(
        "thread/list",
        {
          limit: 100,
          ...(cursor ? { cursor } : {}),
          ...(allowPartial ? { allowPartial: true } : {}),
        },
      );
      if (readThreadListPage(result, allowPartial).completeness === "partial")
        throw new Error(
          "worktree 关联会话列表不完整，请修复来源或稍后重试归档",
        );
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
