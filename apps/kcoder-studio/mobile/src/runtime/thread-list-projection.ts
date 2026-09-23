import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import type { ThreadListFilter, ThreadListPage } from "./task-runtime";
import { timestampMs } from "@/protocol/normalizers";

export function threadListScopeKey(
  profile: Pick<GatewayProfile, "id" | "baseUrl">,
  server: Pick<KCoderServer, "id" | "workspacePath"> & Partial<Pick<KCoderServer, "transport" | "host" | "user" | "port" | "command" | "profile" | "settingsFile">>,
  filter: ThreadListFilter = {},
): string {
  return JSON.stringify([
    profile.id, profile.baseUrl, server.id, server.workspacePath ?? "",
    server.transport, server.host, server.user, server.port, server.command, server.profile, server.settingsFile,
    filter.archived ?? null, filter.query?.trim() ?? "",
  ]);
}

/** Ephemeral UI projection; missing rows are not deletion evidence until a snapshot is complete. */
export class ThreadListProjection {
  private readonly scopes = new Map<string, ThreadListPage>();
  private mutationRevision = 0;

  /** Capture before a list request; an acknowledged mutation invalidates older snapshots. */
  get revision(): number { return this.mutationRevision; }

  get(scope: string): ThreadListPage | undefined { return this.scopes.get(scope); }

  update(scope: string, page: ThreadListPage): ThreadListPage {
    const previous = page.completeness === "partial" || page.nextCursor ? this.scopes.get(scope)?.threads ?? [] : [];
    const threads = new Map(previous.map((thread) => [thread.id, thread]));
    for (const thread of page.threads) threads.set(thread.id, thread);
    const projected = { ...page, threads: [...threads.values()].sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt)) };
    this.scopes.set(scope, projected);
    return projected;
  }

  retainScopes(scopes: string[]): void {
    const retained = new Set(scopes);
    for (const key of this.scopes.keys()) if (!retained.has(key)) this.scopes.delete(key);
  }

  changeThread(scope: string, thread: ThreadSummary): void {
    this.mutationRevision += 1;
    const page = this.scopes.get(scope);
    if (page) this.scopes.set(scope, { ...page, threads: page.threads.map((item) => item.id === thread.id ? thread : item) });
  }

  removeThread(scope: string, threadId: string): void {
    this.mutationRevision += 1;
    const page = this.scopes.get(scope);
    if (page) this.scopes.set(scope, { ...page, threads: page.threads.filter((thread) => thread.id !== threadId) });
  }
}

export function threadListNotice(page: ThreadListPage | undefined): string | null {
  if (page?.completeness === "partial") return `会话列表不完整（${page.issueCount} 个来源问题），已保留此前会话，请稍后重试。`;
  if (page?.nextCursor) return "会话列表尚未加载完，已保留此前会话。";
  return null;
}
