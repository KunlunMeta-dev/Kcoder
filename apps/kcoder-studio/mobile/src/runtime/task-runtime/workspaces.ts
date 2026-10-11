import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc } from "@/storage/workspace-profile-fence";
import { prepareCatalogRead, type NewCatalogReadSource } from "./new-catalog-read-source";
import { ScopedReadCache } from "../scoped-read-cache";
import { threadListScopeKey } from "../thread-list-projection";
import { type ConfirmedWorkspaceOperation, type WorkspaceOperationStage } from "@/storage/pending-workspace-operation";
import { recoverableWorkspaceOperationV2 } from "@/storage/pending-workspace-operation-v2";
import { WORKSPACE_RECEIPTS_V2, WORKSPACE_SCOPE_V2, workspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
import { type GatewayRpcClient, type GatewayConnectOptions, type JsonRecord } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { timestampMs } from "@/protocol/normalizers";
import { taskClientConnector } from "./connectionFactory";
import { isRecord, numberValue, text } from "./normalizers";
import { readThreadListPage, type ThreadListPage } from "./threadDirectory";

export async function openWorkspaceWithReceipt(
  profile: GatewayProfile,
  server: KCoderServer,
  workspacePath: string,
  create = false,
  onProgress?: (stage: WorkspaceOperationStage) => void,
): Promise<ConfirmedWorkspaceOperation> {
  const capturedProfile = { ...profile };
  const capturedServer = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
  const authorization = captureWorkspaceProfileIdentity(capturedProfile);
  clearWorkspaceOptionsCache(profile.id);
  const client = await taskClientConnector(
    capturedProfile,
    capturedServer,
    capturedServer.workspacePath,
  );
  try {
    if (client.supportsExperimental(WORKSPACE_RECEIPTS_V2) !== true) throw new Error("目标版本不支持安全工作区回执；请升级目标，原操作 ID 将保留，不会按旧协议重复创建");
    const started = await startWorkspaceProfileRpc(authorization, () => client.request(WORKSPACE_SCOPE_V2, {}));
    const scope = workspaceScopeV2(await started.response);
    return await recoverableWorkspaceOperationV2({
      profile: capturedProfile, server: capturedServer, scope, path: workspacePath, kind: create ? "create" : "open", intent: workspacePath,
      phases: () => [{ method: create ? "runtime.workspaces.prepareV2" : "runtime.workspaces.openV2", params: { workspacePath, ...(create ? { action: "create" } : {}), label: workspacePath.split("/").filter(Boolean).at(-1) ?? "Workspace" } }],
      request: (method, params, timeoutMs) => client.request(method, params, timeoutMs),
      onProgress,
    });
  } finally {
    client.close();
  }
}

export interface WorkspaceOption {
  path: string;
  label: string;
  kind: "workspace" | "worktree";
}

export interface WorkspaceThreadScopes {
  options: WorkspaceOption[];
  servers: KCoderServer[];
  error: string | null;
  defaultRead?: WorkspaceDefaultReadConnection;
}

/** One cache-loader invocation owns this transport; the cache stores only directory values. */
export interface WorkspaceDefaultReadConnection {
  /** Claim once for a lazy pager; that pager must release this lease when it closes. */
  claim(profile: GatewayProfile, server: KCoderServer, isCurrent: () => boolean): GatewayRpcClient;
  read<T>(profile: GatewayProfile, server: KCoderServer, isCurrent: () => boolean, body: (client: GatewayRpcClient) => Promise<T>): Promise<T>;
  close(): void;
}

function defaultReadOwner(profile: GatewayProfile, server: KCoderServer): string {
  return JSON.stringify([threadListScopeKey(profile, server), profile.deviceId ?? null, server.workspacePath === undefined ? ["undefined"] : ["path", server.workspacePath], "runtime"]);
}

function closeDirectoryClient(client: GatewayRpcClient): void {
  try { client.close(); }
  catch { try { console.warn("workspace_directory_cleanup_pending"); } catch { /* Diagnostic must not mask the read. */ } }
}

class LoadedDefaultReadConnection implements WorkspaceDefaultReadConnection {
  private active = true;
  private used = false;
  private closed = false;
  private readonly owner: string;
  private readonly cancel = () => this.close();
  constructor(private readonly profile: GatewayProfile, private readonly server: KCoderServer, private readonly client: GatewayRpcClient, private readonly signal?: AbortSignal, private catalogPending = false, private readonly closeSource: () => void = () => closeDirectoryClient(client)) {
    this.owner = defaultReadOwner(profile, server);
    signal?.addEventListener("abort", this.cancel, { once: true });
  }
  private assertOwner(profile: GatewayProfile, server: KCoderServer, isCurrent: () => boolean): void {
    if (!this.active || this.signal?.aborted || !isCurrent() || this.owner !== defaultReadOwner(this.profile, this.server) || this.owner !== defaultReadOwner(profile, server)) throw new Error("默认目录读取归属已变化");
  }
  claim(profile: GatewayProfile, server: KCoderServer, isCurrent: () => boolean): GatewayRpcClient {
    if (this.used) throw new Error("默认目录读取连接已使用");
    this.used = true;
    try {
      this.assertOwner(profile, server, isCurrent);
      return this.client;
    } catch (error) { this.close(); throw error; }
  }
  async read<T>(profile: GatewayProfile, server: KCoderServer, isCurrent: () => boolean, body: (client: GatewayRpcClient) => Promise<T>): Promise<T> {
    let claimed = false;
    try {
      const client = this.claim(profile, server, isCurrent);
      claimed = true;
      const result = await body(client);
      this.assertOwner(profile, server, isCurrent);
      return result;
    } finally { if (claimed) this.close(); }
  }
  private closePhysical(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeSource();
  }
  finishCatalog(): void {
    this.catalogPending = false;
    if (!this.active) this.closePhysical();
  }
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.signal?.removeEventListener("abort", this.cancel);
    // A cancelled/finished page cannot close another live catalog waiter.
    if (!this.catalogPending) this.closePhysical();
  }
}

export function workspaceThreadScopeIdentity(path: string | undefined): string {
  if (path === undefined) return "\u0000default";
  if (/^[A-Za-z]:[\\/]+$/.test(path)) return `${path.slice(0, 2)}\\`;
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed || (path.startsWith("\\") ? "\\" : "/");
}

export function workspaceThreadScopeServers(
  server: KCoderServer,
  options: readonly WorkspaceOption[],
): KCoderServer[] {
  const paths = new Map<string, string | undefined>();
  const addPath = (path: string | undefined) => {
    const identity = workspaceThreadScopeIdentity(path);
    if (!paths.has(identity)) paths.set(identity, path);
  };
  addPath(server.workspacePath);
  for (const option of options) addPath(option.path);
  if (paths.size === 0) addPath(undefined);
  return [...paths.values()].map((workspacePath) => ({
    ...server,
    workspacePath,
  }));
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
  clearWorkspaceOptionsCache(profile.id);
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
  clearWorkspaceOptionsCache(profile.id);
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
  clearWorkspaceOptionsCache(profile.id);
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

const workspaceOptionsCache = new ScopedReadCache<WorkspaceOption[]>(32, 30_000);
export function clearWorkspaceOptionsCache(profileId?: string): void {
  workspaceOptionsCache.clear(profileId ? (key) => JSON.parse(key)[0] === profileId : undefined);
}
export function listWorkspaceOptions(profile: GatewayProfile, server: KCoderServer, options: GatewayConnectOptions = {}, source?: NewCatalogReadSource): Promise<WorkspaceOption[]> {
  return readWorkspaceOptions(profile, server, options, undefined, source);
}

async function readWorkspaceOptions(profile: GatewayProfile, server: KCoderServer, options: GatewayConnectOptions, borrowLoaded?: (client: GatewayRpcClient) => boolean, source?: NewCatalogReadSource, borrowEarly?: (client: GatewayRpcClient, close: () => void) => (() => void) | undefined): Promise<WorkspaceOption[]> {
  const key = await prepareCatalogRead(profile, server, options.signal);
  source?.assertOwner(profile, server);
  const read = () => workspaceOptionsCache.get(key, signal => source
    ? source.withClient("workspace", signal, client => readWorkspaceOptionsOnClient(client, server))
    : loadWorkspaceOptions(profile, server, { ...options, signal }, borrowLoaded, borrowEarly), options.signal);
  return source ? source.cacheRead("workspace", read) : read();
}

async function loadWorkspaceOptions(
  profile: GatewayProfile,
  server: KCoderServer,
  options: GatewayConnectOptions = {},
  borrowLoaded?: (client: GatewayRpcClient) => boolean,
  borrowEarly?: (client: GatewayRpcClient, close: () => void) => (() => void) | undefined,
): Promise<WorkspaceOption[]> {
  const client = await taskClientConnector(
    profile,
    server,
    server.workspacePath,
    "runtime",
    options,
  );
  let transferred = false;
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeDirectoryClient(client); } };
  let finishCatalog: (() => void) | undefined;
  const cancel = close;
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) throw new Error("项目列表加载已取消");
    // Only this actual cold cache loader may lend its initialized connection.
    // The directory requests and default page start in the same job/slot.
    finishCatalog = borrowEarly?.(client, close);
    transferred = Boolean(finishCatalog);
    const result = await readWorkspaceOptionsOnClient(client, server);
    if (!transferred && !options.signal?.aborted && borrowLoaded) transferred = borrowLoaded(client);
    return result;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    finishCatalog?.();
    if (!transferred) close();
  }
}

async function readWorkspaceOptionsOnClient(client: Pick<GatewayRpcClient, "request">, server: KCoderServer): Promise<WorkspaceOption[]> {
  const byPath = new Map<string, WorkspaceOption>();
  const [workspaces, worktrees] = await Promise.all([
    client.request<{ items?: JsonRecord[] }>("runtime.workspaces.list", {
      deviceId: server.id,
    }),
    client.request<{ items?: JsonRecord[] }>("runtime.worktrees.list", {
      deviceId: server.id,
    }),
  ]);
  if (!Array.isArray(workspaces.items) || !Array.isArray(worktrees.items))
    throw new Error("app-server 未返回有效的已登记项目列表");
  for (const item of workspaces.items) {
    const path = text(item.workspacePath);
    if (!path) continue;
    byPath.set(path, {
      path,
      label: text(item.label) ?? path.split("/").at(-1) ?? path,
      kind: item.workspaceKind === "worktree" ? "worktree" : "workspace",
    });
  }
  for (const item of worktrees.items) {
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
}

/** Resolve the default workspace plus every registered workspace/worktree for history queries. */
export async function listWorkspaceThreadScopes(
  profile: GatewayProfile,
  server: KCoderServer,
  knownOptions: readonly WorkspaceOption[] = [],
  connectOptions: GatewayConnectOptions = {},
  borrowDefault?: { isCurrent: () => boolean; onOwned: (connection: WorkspaceDefaultReadConnection) => void; onReady?: (connection: WorkspaceDefaultReadConnection) => void },
): Promise<WorkspaceThreadScopes> {
  let defaultRead: WorkspaceDefaultReadConnection | undefined;
  const owner = defaultReadOwner(profile, server);
  let options: WorkspaceOption[] = [];
  let error: string | null = null;
  try {
    options = await readWorkspaceOptions(profile, server, connectOptions, borrowDefault ? client => {
      if (connectOptions.signal?.aborted || !borrowDefault.isCurrent() || owner !== defaultReadOwner(profile, server)) return false;
      const connection = new LoadedDefaultReadConnection(profile, server, client, connectOptions.signal);
      try { borrowDefault.onOwned(connection); } catch (error) { connection.close(); throw error; }
      defaultRead = connection;
      return true;
    } : undefined, undefined, borrowDefault?.onReady ? (client, close) => {
      // Page cancellation removes its ownership only; a foreign cache waiter
      // may still legitimately need this loader's catalog response.
      if (connectOptions.signal?.aborted || !borrowDefault.isCurrent() || owner !== defaultReadOwner(profile, server)) return undefined;
      const connection = new LoadedDefaultReadConnection(profile, server, client, connectOptions.signal, true, close);
      try {
        borrowDefault.onOwned(connection);
        defaultRead = connection;
        borrowDefault.onReady?.(connection);
      } catch (error) {
        connection.close(); connection.finishCatalog(); throw error;
      }
      return () => connection.finishCatalog();
    } : undefined);
  } catch (value) {
    // An independent catalog failure must not cancel an already-started page.
    if (!borrowDefault?.onReady) { defaultRead?.close(); defaultRead = undefined; }
    options = [...knownOptions];
    error = value instanceof Error ? value.message : String(value);
  }

  return {
    options,
    servers: workspaceThreadScopeServers(server, options),
    error,
    ...(defaultRead ? { defaultRead } : {}),
  };
}

export async function prepareManagedWorktreeWithReceipt(
  profile: GatewayProfile,
  server: KCoderServer,
  sourcePath: string,
  gitRef?: string,
  onProgress?: (stage: WorkspaceOperationStage) => void,
): Promise<ConfirmedWorkspaceOperation> {
  const capturedProfile = { ...profile };
  const capturedServer = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
  const authorization = captureWorkspaceProfileIdentity(capturedProfile);
  clearWorkspaceOptionsCache(profile.id);
  const client = await taskClientConnector(
    capturedProfile,
    capturedServer,
    capturedServer.workspacePath,
  );
  try {
    if (client.supportsExperimental(WORKSPACE_RECEIPTS_V2) !== true) throw new Error("目标版本不支持安全工作区回执；请升级目标后创建 worktree，原操作 ID 将保留");
    const started = await startWorkspaceProfileRpc(authorization, () => client.request(WORKSPACE_SCOPE_V2, {}));
    const scope = workspaceScopeV2(await started.response);
    return await recoverableWorkspaceOperationV2({
      profile: capturedProfile, server: capturedServer, scope, path: sourcePath, kind: "worktree", intent: JSON.stringify([sourcePath, gitRef?.trim() ?? ""]), onProgress,
      phases: (id) => [
        { method: "runtime.workspaces.openV2", suffix: ":source", params: { workspacePath: sourcePath, label: sourcePath.split("/").filter(Boolean).at(-1) ?? "Workspace" } },
        { method: "runtime.worktrees.prepareV2", params: { sourcePath, worktreeId: id, permanent: false, ...(gitRef?.trim() ? { ref: gitRef.trim() } : {}) } },
      ],
      request: (method, params, timeoutMs) => client.request(method, params, timeoutMs),
    });
  } finally {
    client.close();
  }
}

/** Existing string-returning callers keep their contract. */
export async function openWorkspace(profile: GatewayProfile, server: KCoderServer, workspacePath: string, create = false, onProgress?: (stage: WorkspaceOperationStage) => void): Promise<string> {
  return (await openWorkspaceWithReceipt(profile, server, workspacePath, create, onProgress)).path;
}
export async function prepareManagedWorktree(profile: GatewayProfile, server: KCoderServer, sourcePath: string, gitRef?: string, onProgress?: (stage: WorkspaceOperationStage) => void): Promise<string> {
  return (await prepareManagedWorktreeWithReceipt(profile, server, sourcePath, gitRef, onProgress)).path;
}
