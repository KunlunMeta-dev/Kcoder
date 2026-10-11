import { prepareThreadDeletionCleanup, confirmThreadDeletionCleanup, retryThreadDeletionCleanup } from "@/storage/thread-deletion-cleanup";
import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadSummary,
} from "@/gateway/types";
import { timestampMs } from "@/protocol/normalizers";
import { taskClientConnector } from "./connectionFactory";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc, withWorkspaceProfileWrite } from "@/storage/workspace-profile-fence";

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

export type ThreadMutation =
  | { kind: "rename"; title: string }
  | { kind: "archive"; archivedAt: string }
  | { kind: "unarchive" }
  | { kind: "delete" };

export interface ThreadMutationEvent {
  profileId: string;
  profileBaseUrl: string;
  profileAuthorizationGeneration?: string;
  serverId: string;
  serverConfigIdentity: string;
  threadId: string;
  cwd: string;
  mutation: ThreadMutation;
}

type ThreadMutationListener = (event: ThreadMutationEvent) => void;
type ThreadMutationServer = Pick<KCoderServer, "id"> &
  Partial<
    Pick<
      KCoderServer,
      | "transport"
      | "host"
      | "user"
      | "port"
      | "command"
      | "profile"
      | "settingsFile"
      | "accountIdentity"
    >
  >;

const threadMutationListeners = new Set<ThreadMutationListener>();

export function threadMutationServerIdentity(
  server: ThreadMutationServer,
): string {
  return JSON.stringify([
    server.id,
    server.transport,
    server.host,
    server.user,
    server.port,
    server.command,
    server.profile,
    server.settingsFile,
    ...(server.accountIdentity ? [server.accountIdentity.principalId, server.accountIdentity.role] : []),
  ]);
}

export function subscribeThreadMutations(
  listener: ThreadMutationListener,
): () => void {
  threadMutationListeners.add(listener);
  return () => threadMutationListeners.delete(listener);
}

export function publishThreadMutation(
  profile: Pick<GatewayProfile, "id" | "baseUrl"> & Partial<Pick<GatewayProfile, "authorizationGeneration">>,
  server: ThreadMutationServer,
  threadId: string,
  cwd: string | undefined,
  mutation: ThreadMutation,
): void {
  if (!profile.id || !profile.baseUrl || !server.id || !threadId || !cwd)
    return;
  const event: ThreadMutationEvent = {
    profileId: profile.id,
    profileBaseUrl: profile.baseUrl,
    ...(profile.authorizationGeneration ? { profileAuthorizationGeneration: profile.authorizationGeneration } : {}),
    serverId: server.id,
    serverConfigIdentity: threadMutationServerIdentity(server),
    threadId,
    cwd,
    mutation,
  };
  for (const listener of [...threadMutationListeners]) {
    try {
      listener(event);
    } catch {
      // A projection consumer cannot turn an acknowledged server mutation into a UI failure.
    }
  }
}

/** Keep fan-out across registered workspaces from opening an unbounded number of RPC clients. */
export async function mapThreadListScopes<T, R>(
  scopes: readonly T[],
  map: (scope: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(scopes.length);
  let next = 0;
  const workerCount = Math.min(4, scopes.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < scopes.length) {
        const index = next++;
        results[index] = await map(scopes[index]!, index);
      }
    }),
  );
  return results;
}

/** One operation's discovery and dependent page jobs share four slots; parents never await children. */
export async function mapThreadListDependencies<T, D, S, R>(
  targets: readonly T[],
  discover: (target: T, targetIndex: number) => Promise<D>,
  scopesFor: (discovery: D, targetIndex: number) => readonly S[],
  read: (scope: S, scopeIndex: number, targetIndex: number) => Promise<R>,
  options: { isCurrent?: () => boolean; onDiscovered?: (discoveries: readonly D[]) => void; onTargetDiscovered?: (discovery: D, targetIndex: number) => void; onReadSettled?: (result: R, scope: S, scopeIndex: number, targetIndex: number) => void; readFirstInDiscovery?: (scope: S) => boolean } = {},
): Promise<{ discoveries: D[]; results: R[] }> {
  const discoveries = new Array<D>(targets.length);
  const results = new Array<R[]>(targets.length);
  const reads: Array<{ scope: S; scopeIndex: number; targetIndex: number }> = [];
  let nextTarget = 0;
  let nextRead = 0;
  let active = 0;
  let discovered = 0;
  let preferRead = true;
  let failed = false;
  let failure: unknown;
  const current = () => options.isCurrent?.() !== false;
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => { if (!failed) { failed = true; failure = error; } };
    const settleRead = async (scope: S, scopeIndex: number, targetIndex: number) => {
      const result = await read(scope, scopeIndex, targetIndex);
      if (failed || !current()) throw new Error("会话列表读取已取消");
      results[targetIndex]![scopeIndex] = result;
      options.onReadSettled?.(result, scope, scopeIndex, targetIndex);
    };
    const pump = () => {
      try { if (!current()) fail(new Error("会话列表读取已取消")); }
      catch (error) { fail(error); }
      while (!failed && active < 4 && (nextTarget < targets.length || nextRead < reads.length)) {
        const dependent = nextRead < reads.length && (preferRead || nextTarget >= targets.length);
        const page = dependent ? reads[nextRead++]! : undefined;
        const targetIndex = page ? page.targetIndex : nextTarget++;
        // Alternate ready reads and new discoveries so neither class monopolizes slots.
        preferRead = !dependent;
        active += 1;
        void Promise.resolve().then(async () => {
          if (failed || !current()) throw new Error("会话列表读取已取消");
          if (page) {
            await settleRead(page.scope, page.scopeIndex, targetIndex);
          } else {
            const value = await discover(targets[targetIndex]!, targetIndex);
            if (failed || !current()) throw new Error("会话列表读取已取消");
            discoveries[targetIndex] = value;
            const scopes = scopesFor(value, targetIndex);
            results[targetIndex] = new Array<R>(scopes.length);
            const inline = scopes.length > 0 && options.readFirstInDiscovery?.(scopes[0]!) === true;
            scopes.forEach((scope, scopeIndex) => { if (!inline || scopeIndex !== 0) reads.push({ scope, scopeIndex, targetIndex }); });
            options.onTargetDiscovered?.(value, targetIndex);
            discovered += 1;
            if (discovered === targets.length) options.onDiscovered?.(discoveries);
            if (inline) {
              // The catalog slot becomes the default pager slot. Extras are already ready;
              // it never waits for a child job to acquire another slot.
              pump();
              if (failed || !current()) throw new Error("会话列表读取已取消");
              await settleRead(scopes[0]!, 0, targetIndex);
            }
          }
        }).catch(fail).finally(() => {
          active -= 1;
          pump();
        });
      }
      // Wait for already-running readers' own finally cleanup before settling cancellation/failure.
      if (active === 0) {
        if (failed) reject(failure);
        else if (nextTarget === targets.length && nextRead === reads.length) {
          try {
            if (targets.length === 0) options.onDiscovered?.([]);
            resolve({ discoveries, results: results.flat() });
          } catch (error) { reject(error); }
        }
      }
    };
    pump();
  });
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

export interface ThreadListReadOptions {
  client?: GatewayRpcClient; // Borrowed for this call only; its source owner closes it.
  /** Optional ownership handoff: close this pager releases its single source lease. */
  releaseClient?: () => void;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  /** Cumulative snapshot: a nextCursor still means more of this scope is unread. */
  onPage?: (page: ThreadListPage) => void;
}

export class ThreadListPager {
  private client: GatewayRpcClient | null = null;
  private connecting: Promise<GatewayRpcClient> | null = null;
  private closed = false;
  private snapshot: ThreadListPage | null = null;
  private readonly cursors = new Set<string>();
  private readonly controller = new AbortController();

  constructor(
    private readonly profile: GatewayProfile,
    private readonly server: KCoderServer,
    private readonly filter: ThreadListFilter = {},
    private readonly priority: "foreground" | "background" = "foreground",
    private readonly readOptions?: ThreadListReadOptions,
  ) { readOptions?.signal?.addEventListener("abort", this.cancel, { once: true }); }

  private readonly cancel = () => this.close();
  private assertCurrent(): void {
    if (this.closed || this.readOptions?.signal?.aborted || this.readOptions?.isCurrent?.() === false) throw new Error("历史分页器已关闭或归属变化");
  }

  async page(cursor?: string, limit = 50): Promise<ThreadListPage> {
    this.assertCurrent();
    if (cursor && this.cursors.size >= 200)
      throw new Error("会话列表分页超过安全上限，请缩小搜索范围");
    const client = await this.connect();
    const allowPartial =
      client.supportsExperimental?.("threadListCompleteness") === true;
    const params = {
      limit: Math.max(1, Math.min(100, Math.floor(limit))),
      ...(allowPartial ? { allowPartial: true } : {}),
      ...(cursor ? { cursor } : {}),
      ...(this.filter.archived === undefined
        ? {}
        : { archived: this.filter.archived }),
      ...(this.filter.query?.trim()
        ? { query: this.filter.query.trim() }
        : {}),
    };
    this.assertCurrent();
    const authorization = this.readOptions ? captureWorkspaceProfileIdentity(this.profile) : undefined;
    const response = authorization
      ? (await startWorkspaceProfileRpc(authorization, () => { this.assertCurrent(); return client.request<Partial<ThreadListPage>>("thread/list", params); })).response
      : client.request<Partial<ThreadListPage>>("thread/list", params);
    const result = await response;
    this.assertCurrent();
    if (authorization) await withWorkspaceProfileWrite(authorization, async () => this.assertCurrent());
    this.assertCurrent();
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
    this.readOptions?.signal?.removeEventListener("abort", this.cancel);
    this.controller.abort();
    if (this.readOptions?.releaseClient) {
      try { this.readOptions.releaseClient(); }
      catch { try { console.warn("thread_list_cleanup_pending"); } catch { /* Keep the original read result. */ } }
    } else if (!this.readOptions?.client && this.client) this.closeClient(this.client);
    this.client = null;
    void this.connecting?.then(client => this.closeClient(client)).catch(() => {});
    this.connecting = null;
  }

  private closeClient(client: GatewayRpcClient): void {
    if (!this.readOptions) { client.close(); return; }
    try { client.close(); }
    catch { try { console.warn("thread_list_cleanup_pending"); } catch { /* Keep the original read result. */ } }
  }

  private async connect(): Promise<GatewayRpcClient> {
    this.assertCurrent();
    if (this.readOptions?.client) return this.readOptions.client;
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = taskClientConnector(
        this.profile,
        this.server,
        this.server.workspacePath,
        "runtime",
        { signal: this.controller.signal, priority: this.priority },
      );
    }
    const client = await this.connecting;
    if (this.closed || this.readOptions?.signal?.aborted || this.readOptions?.isCurrent?.() === false) {
      this.closeClient(client);
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
  readOptions?: ThreadListReadOptions,
): Promise<ThreadListPage> {
  const pager = new ThreadListPager(profile, server, filter, "foreground", readOptions);
  try {
    const publish = (page: ThreadListPage) => {
      if (readOptions?.signal?.aborted || readOptions?.isCurrent?.() === false)
        throw new Error("会话列表读取已取消");
      readOptions?.onPage?.({ ...page, threads: [...page.threads] });
    };
    let page = await pager.page(undefined, limit);
    publish(page);
    while (page.nextCursor) {
      if (page.threads.length > 10_000)
        throw new Error("会话列表超过 10000 条，请使用历史搜索");
      page = await pager.page(page.nextCursor, limit);
      publish(page);
    }
    return page;
  } finally {
    pager.close();
  }
}

const metadataOperations = new Map<string, { sequence: number; confirmed?: ThreadSummary; tail: Promise<void> }>();
export function updateThreadMetadata(
  profile: GatewayProfile,
  server: KCoderServer,
  threadId: string,
  update: { title?: string; archivedAt?: string | null },
  cwd?: string,
  previous?: ThreadSummary,
  onProjection?: (thread: ThreadSummary) => void,
): Promise<void> {
  const key = JSON.stringify([profile.baseUrl, profile.authorizationGeneration ?? profile.id, threadMutationServerIdentity(server), cwd, threadId]);
  const state = metadataOperations.get(key) ?? { sequence: 0, confirmed: previous, tail: Promise.resolve() };
  const sequence = ++state.sequence;
  metadataOperations.set(key, state);
  const publish = (value: { title?: string; archivedAt?: string | null }) => {
    if (typeof value.title === "string") publishThreadMutation(profile, server, threadId, cwd, { kind: "rename", title: value.title });
    if (typeof value.archivedAt === "string") publishThreadMutation(profile, server, threadId, cwd, { kind: "archive", archivedAt: value.archivedAt });
    else if (value.archivedAt === null) publishThreadMutation(profile, server, threadId, cwd, { kind: "unarchive" });
  };
  const project = (base: ThreadSummary, value: typeof update) => ({ ...base, ...(value.title !== undefined ? { title: value.title } : {}), ...(value.archivedAt !== undefined ? { archivedAt: value.archivedAt ?? undefined } : {}) });
  if (previous) { publish(update); onProjection?.(project(previous, update)); }
  const operation = state.tail.catch(() => {}).then(async () => {
    let client: GatewayRpcClient | undefined;
    try {
      client = await taskClientConnector(profile, server, cwd ?? server.workspacePath);
      await client.request("thread/metadata/update", { threadId, ...update });
      if (state.confirmed) state.confirmed = project(state.confirmed, update);
      if (!previous && state.sequence === sequence) publish(update);
    } catch (error) {
      const ambiguous = error instanceof MobileRpcError && error.reason !== "remote" && error.delivery !== "not-sent";
      if (ambiguous && client) {
        try {
          const result = await client.request<{ thread?: ThreadSummary }>("thread/read", { threadId, limit: 1 });
          if (!result.thread || result.thread.id !== threadId) throw error;
          state.confirmed = result.thread;
          if (state.sequence === sequence) { publish({ title: result.thread.title, archivedAt: result.thread.archivedAt ?? null }); onProjection?.(result.thread); }
          if ((update.title === undefined || result.thread.title === update.title) && (update.archivedAt === undefined || (result.thread.archivedAt ?? null) === update.archivedAt)) return;
        } catch { throw new Error("操作结果仍未知，保留待确认状态；请重新连接核对。"); }
      } else if (state.confirmed && state.sequence === sequence) {
        publish({ title: state.confirmed.title, archivedAt: state.confirmed.archivedAt ?? null }); onProjection?.(state.confirmed);
      }
      throw error;
    } finally { client?.close(); }
  });
  state.tail = operation;
  void operation.finally(() => { if (state.tail === operation) metadataOperations.delete(key); }).catch(() => {});
  return operation;
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
    const cleanupId = await prepareThreadDeletionCleanup(profile, server, threadId, cwd, attachmentPaths);
    await client.request("thread/delete", { threadId });
    publishThreadMutation(profile, server, threadId, cwd, { kind: "delete" });
    // Remote deletion remains authoritative even if local storage is unavailable.
    await confirmThreadDeletionCleanup(profile.id, cleanupId).catch(() => {});
    void retryThreadDeletionCleanup(profile, [server]).catch(() => {});
  } finally {
    client.close();
  }
}
