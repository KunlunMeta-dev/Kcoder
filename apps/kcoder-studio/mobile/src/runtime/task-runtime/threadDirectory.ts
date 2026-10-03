import { GatewayRpcClient } from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import { timestampMs } from "@/protocol/normalizers";
import { taskClientConnector } from "./connectionFactory";
import { collectThreadAttachmentPaths } from "./history";

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

export function readThreadListPage(
  result: Partial<ThreadListPage>,
  allowPartial: boolean,
): ThreadListPage {
  const completeness =
    result.completeness ?? (allowPartial ? undefined : "complete");
  const issueCount = result.issueCount ?? (allowPartial ? undefined : 0);
  if (
    (allowPartial && !Array.isArray(result.threads)) ||
    (completeness !== "complete" && completeness !== "partial") ||
    typeof issueCount !== "number" ||
    !Number.isSafeInteger(issueCount) ||
    issueCount < 0 ||
    (completeness === "complete" && issueCount !== 0)
  ) {
    throw new Error("app-server 未返回有效的会话列表完整性");
  }
  return {
    threads: result.threads ?? [],
    nextCursor: result.nextCursor?.trim() || undefined,
    completeness,
    issueCount,
  };
}

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
    if (cursor && this.cursors.size >= 200)
      throw new Error("会话列表分页超过安全上限，请缩小搜索范围");
    const client = await this.connect();
    const allowPartial =
      client.supportsExperimental?.("threadListCompleteness") === true;
    const result = await client.request<Partial<ThreadListPage>>(
      "thread/list",
      {
        limit: Math.max(1, Math.min(100, Math.floor(limit))),
        ...(allowPartial ? { allowPartial: true } : {}),
        ...(cursor ? { cursor } : {}),
        ...(this.filter.archived === undefined
          ? {}
          : { archived: this.filter.archived }),
        ...(this.filter.query?.trim()
          ? { query: this.filter.query.trim() }
          : {}),
      },
    );
    const { completeness, issueCount, nextCursor } = readThreadListPage(
      result,
      allowPartial,
    );
    if (
      cursor &&
      this.snapshot &&
      (this.snapshot.completeness !== completeness ||
        this.snapshot.issueCount !== issueCount)
    )
      throw new Error("app-server 会话列表快照完整性在分页期间发生变化");
    if (!cursor) this.cursors.clear();
    if (nextCursor && this.cursors.has(nextCursor))
      throw new Error("app-server 返回了重复的 thread/list cursor");
    if (nextCursor) this.cursors.add(nextCursor);
    const threads = new Map(
      (cursor ? (this.snapshot?.threads ?? []) : []).map((thread) => [
        thread.id,
        thread,
      ]),
    );
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
      if (page.threads.length > 10_000)
        throw new Error("会话列表超过 10000 条，请使用历史搜索");
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
