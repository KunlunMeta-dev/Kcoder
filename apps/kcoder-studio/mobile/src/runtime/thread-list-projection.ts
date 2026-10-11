import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import type { ThreadListFilter, ThreadListPage } from "./task-runtime";
import type { ThreadMutationEvent } from "./task-runtime/threadDirectory";
import type { WorkspaceOption } from "./task-runtime/workspaces";
import { workspaceThreadScopeIdentity, workspaceThreadScopeServers } from "./task-runtime/workspaces";
import { threadMutationServerIdentity } from "./task-runtime/threadDirectory";
import { timestampMs } from "@/protocol/normalizers";

export function threadListScopeKey(
  profile: Pick<GatewayProfile, "id" | "baseUrl"> & Partial<Pick<GatewayProfile, "authorizationGeneration">>,
  server: Pick<KCoderServer, "id" | "workspacePath"> & Partial<Pick<KCoderServer, "transport" | "host" | "user" | "port" | "command" | "profile" | "settingsFile" | "accountIdentity">>,
  filter: ThreadListFilter = {},
): string {
  return JSON.stringify([
    profile.id, profile.baseUrl, profile.authorizationGeneration ?? `legacy:${profile.id}`, server.id, server.workspacePath ?? "",
    server.transport, server.host, server.user, server.port, server.command, server.profile, server.settingsFile,
    server.accountIdentity?.principalId, server.accountIdentity?.role,
    filter.archived ?? null, filter.query?.trim() ?? "",
  ]);
}

/** Owner of one route's read; keep raw default path distinct from an explicit empty path. */
export function threadListReadOwner(profile: GatewayProfile, server: KCoderServer, filter: ThreadListFilter = {}): string {
  return JSON.stringify([threadListScopeKey(profile, server, filter), profile.deviceId ?? null,
    server.workspacePath === undefined ? ["undefined"] : ["path", server.workspacePath], "runtime"]);
}

export interface ThreadScopeRow {
  serverId: string;
  workspacePath?: string;
  scope?: string;
  thread: ThreadSummary;
}

/** Merge overlapping workspace answers without collapsing different cwd tasks with the same id. */
export function orderThreadScopeRows<T extends ThreadScopeRow>(rows: readonly T[]): T[] {
  const key = (row: T) => JSON.stringify([row.serverId,
    workspaceThreadScopeIdentity(row.thread.cwd?.trim() || row.workspacePath), row.thread.id]);
  const exact = (row: T) => Boolean(row.thread.cwd?.trim()) && row.workspacePath !== undefined &&
    workspaceThreadScopeIdentity(row.thread.cwd) === workspaceThreadScopeIdentity(row.workspacePath);
  const merged = new Map<string, T>();
  for (const row of rows) {
    const identity = key(row); const previous = merged.get(identity);
    if (!previous || (exact(row) && !exact(previous)) || (exact(row) === exact(previous) &&
      (timestampMs(row.thread.updatedAt) > timestampMs(previous.thread.updatedAt) ||
       (timestampMs(row.thread.updatedAt) === timestampMs(previous.thread.updatedAt) &&
        (row.scope ?? "").localeCompare(previous.scope ?? "") < 0)))) merged.set(identity, row);
  }
  return [...merged.values()].sort((a, b) => timestampMs(b.thread.updatedAt) - timestampMs(a.thread.updatedAt) || key(a).localeCompare(key(b)));
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
    this.changeThreadWhere(scope, thread, (item) => item.id === thread.id);
  }

  changeThreadWhere(
    scope: string,
    thread: ThreadSummary,
    matches: (item: ThreadSummary) => boolean,
  ): void {
    this.mutationRevision += 1;
    const page = this.scopes.get(scope);
    if (page) this.scopes.set(scope, { ...page, threads: page.threads.map((item) => matches(item) ? thread : item) });
  }

  removeThread(scope: string, threadId: string): void {
    this.removeThreadWhere(scope, (thread) => thread.id === threadId);
  }

  removeThreadWhere(
    scope: string,
    matches: (thread: ThreadSummary) => boolean,
  ): void {
    this.mutationRevision += 1;
    const page = this.scopes.get(scope);
    if (page) this.scopes.set(scope, { ...page, threads: page.threads.filter((thread) => !matches(thread)) });
  }

  invalidatePendingLists(): void { this.mutationRevision += 1; }
}

/** Apply an acknowledged active-thread mutation to every cached workspace projection. */
export function acknowledgeWorkspaceThreadMutation(
  projection: ThreadListProjection,
  profile: Pick<GatewayProfile, "id" | "baseUrl"> & Partial<Pick<GatewayProfile, "authorizationGeneration">>,
  server: KCoderServer,
  options: readonly WorkspaceOption[],
  mutation:
    | { kind: "rename"; thread: ThreadSummary }
    | { kind: "remove"; threadId: string },
): void {
  for (const workspaceServer of workspaceThreadScopeServers(server, options)) {
    const scope = threadListScopeKey(profile, workspaceServer, { archived: false });
    if (mutation.kind === "rename") projection.changeThread(scope, mutation.thread);
    else projection.removeThread(scope, mutation.threadId);
  }
}

/** Apply one acknowledged mutation only to the exact workspace/query projection. */
export function acknowledgeThreadMutationAtWorkspace(
  projection: ThreadListProjection,
  profile: Pick<GatewayProfile, "id" | "baseUrl"> & Partial<Pick<GatewayProfile, "authorizationGeneration">>,
  server: KCoderServer,
  workspacePath: string | undefined,
  actualCwd: string,
  filter: ThreadListFilter,
  threadId: string,
  mutation:
    | { kind: "rename"; title: string }
    | { kind: "archive"; archivedAt: string }
    | { kind: "unarchive" }
    | { kind: "delete" },
): string {
  const scope = threadListScopeKey(
    profile,
    { ...server, workspacePath },
    filter,
  );
  const matches = (thread: ThreadSummary) =>
    threadMutationMatchesRow(thread, threadId, actualCwd, workspacePath);
  if (mutation.kind === "rename") {
    const existing = projection
      .get(scope)
      ?.threads.find(matches);
    if (existing)
      projection.changeThreadWhere(scope, { ...existing, title: mutation.title }, matches);
    else projection.invalidatePendingLists();
  } else projection.removeThreadWhere(scope, matches);
  return scope;
}

export function threadMutationMatchesRow(
  thread: ThreadSummary,
  threadId: string,
  actualCwd: string,
  scopePath: string | undefined,
): boolean {
  if (thread.id !== threadId) return false;
  const cwdIdentity = workspaceThreadScopeIdentity(actualCwd);
  if (thread.cwd?.trim())
    return workspaceThreadScopeIdentity(thread.cwd) === cwdIdentity;
  return scopePath !== undefined &&
    workspaceThreadScopeIdentity(scopePath) === cwdIdentity;
}

/** Resolve an ACK to one exact workspace scope, using a cached row only for the default-scope fallback. */
export function threadMutationWorkspaceServers(
  projection: ThreadListProjection,
  profile: Pick<GatewayProfile, "id" | "baseUrl"> & Partial<Pick<GatewayProfile, "authorizationGeneration">>,
  server: KCoderServer,
  options: readonly WorkspaceOption[],
  filter: ThreadListFilter,
  event: ThreadMutationEvent,
): KCoderServer[] {
  if (
    event.profileId !== profile.id ||
    event.profileBaseUrl !== profile.baseUrl ||
    event.profileAuthorizationGeneration !== profile.authorizationGeneration ||
    event.serverId !== server.id ||
    event.serverConfigIdentity !== threadMutationServerIdentity(server)
  )
    return [];

  const cwdIdentity = workspaceThreadScopeIdentity(event.cwd);
  const candidates = workspaceThreadScopeServers(server, options);
  const exact = candidates.filter(
    (candidate) =>
      candidate.workspacePath !== undefined &&
      workspaceThreadScopeIdentity(candidate.workspacePath) === cwdIdentity,
  );
  if (exact.length > 0) return exact;

  const defaultServer = candidates.find(
    (candidate) => candidate.workspacePath === undefined,
  );
  if (defaultServer) {
    const defaultScope = threadListScopeKey(profile, defaultServer, filter);
    const hasExplicitRow = projection
      .get(defaultScope)
      ?.threads.some(
        (thread) =>
          thread.id === event.threadId &&
          Boolean(thread.cwd) &&
          workspaceThreadScopeIdentity(thread.cwd) === cwdIdentity,
      );
    if (hasExplicitRow) return [defaultServer];
  }

  // The acknowledged cwd is authoritative even before the workspace registry has loaded.
  return [{ ...server, workspacePath: event.cwd }];
}

/** Read cached rows from registered scopes plus an explicitly acknowledged cwd scope. */
export function projectWorkspaceThreadRows(
  projection: ThreadListProjection,
  profile: Pick<GatewayProfile, "id" | "baseUrl"> & Partial<Pick<GatewayProfile, "authorizationGeneration">>,
  server: KCoderServer,
  options: readonly WorkspaceOption[],
  filter: ThreadListFilter,
  additionalScopes: readonly KCoderServer[] = [],
): ThreadSummary[] {
  const scopes = new Map<string, KCoderServer>();
  for (const candidate of [
    ...workspaceThreadScopeServers(server, options),
    ...additionalScopes,
  ]) {
    const identity = workspaceThreadScopeIdentity(candidate.workspacePath);
    if (!scopes.has(identity)) scopes.set(identity, candidate);
  }
  return [...scopes.values()].flatMap((candidate) =>
    projection.get(threadListScopeKey(profile, candidate, filter))?.threads ?? [],
  );
}

export function threadListNotice(page: ThreadListPage | undefined): string | null {
  if (page?.completeness === "partial") return `会话列表不完整（${page.issueCount} 个来源问题），已保留此前会话，请稍后重试。`;
  if (page?.nextCursor) return "会话列表尚未加载完，已保留此前会话。";
  return null;
}
