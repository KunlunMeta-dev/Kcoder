import { ensureGatewayAuthorization } from "@/gateway/http";
import type { GatewayRpcClient, JsonRecord } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc, withWorkspaceProfileWrite } from "@/storage/workspace-profile-fence";
import { threadListScopeKey } from "../thread-list-projection";
import { taskClientConnector } from "./connectionFactory";

type Branch = "workspace" | "models";
type CatalogClient = Pick<GatewayRpcClient, "request">;

/** Catalog values have a device and exact raw-root owner; thread projection keys are unchanged. */
export function catalogReadScopeKey(profile: GatewayProfile, server: KCoderServer): string {
  return JSON.stringify([profile.id, threadListScopeKey(profile, server), profile.deviceId ?? null,
    server.workspacePath === undefined ? ["undefined"] : ["string", server.workspacePath],
    profile.authorizationGeneration === undefined ? ["undefined"] : ["string", profile.authorizationGeneration],
    server.runtime, server.accountIdentity?.username ?? null, "runtime"]);
}

export async function prepareCatalogRead(profile: GatewayProfile, server: KCoderServer, signal?: AbortSignal): Promise<string> {
  const owner = catalogReadScopeKey(profile, server);
  if (signal?.aborted) throw cancelled();
  // The resolver refreshes tokens on this caller only after confirming its original authorization family.
  await ensureGatewayAuthorization(profile);
  if (signal?.aborted) throw cancelled();
  if (catalogReadScopeKey(profile, server) !== owner) throw changed();
  if (profile.expiresAt <= Date.now()) throw new Error("Gateway 会话已失效，请重新授权");
  return owner;
}

const cancelled = () => new Error("目录读取已取消");
const changed = () => new Error("目录读取授权或目标归属已变化");
function closeClient(client: GatewayRpcClient): void {
  try { client.close(); } catch {
    try { console.warn("New catalog source cleanup failed"); } catch { /* Cleanup never replaces the read result. */ }
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** One New loader only. Fixed candidates are registered before either cache can run its loader. */
export interface NewCatalogReadSource {
  run<T>(branch: Branch, read: () => Promise<T>): Promise<T>;
  assertOwner(profile: GatewayProfile, server: KCoderServer): void;
  cacheRead<T>(branch: Branch, read: () => Promise<T>): Promise<T>;
  withClient<T>(branch: Branch, signal: AbortSignal, read: (client: CatalogClient) => Promise<T>): Promise<T>;
}
export function createNewCatalogReadSource(
  profile: GatewayProfile, server: KCoderServer, isIdentityCurrent: () => boolean,
): NewCatalogReadSource {
  const owner = catalogReadScopeKey(profile, server);
  const capturedProfile = { ...profile };
  const capturedServer = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
  const authorization = captureWorkspaceProfileIdentity(capturedProfile);
  const connectionAbort = new AbortController();
  // Reservations persist until both cache calls settle, including warm/foreign-inflight calls.
  const candidate = () => ({ started: false, finished: false, lookup: "pending" as "pending" | "queued" | "complete" });
  const candidates = { workspace: candidate(), models: candidate() };
  const active = new Map<Branch, AbortSignal>(); // At most two fixed branch entries; never shared across operations.
  let connecting: Promise<GatewayRpcClient> | undefined;
  let client: GatewayRpcClient | undefined;
  let closed = false;
  let connectionFinished = false;
  const assertOwner = (inputProfile = profile, inputServer = server) => {
    if (closed || !isIdentityCurrent() || catalogReadScopeKey(profile, server) !== owner ||
      catalogReadScopeKey(capturedProfile, capturedServer) !== owner || catalogReadScopeKey(inputProfile, inputServer) !== owner) throw changed();
  };
  const finishIfIdle = () => {
    if (candidates.workspace.lookup !== "complete" || candidates.models.lookup !== "complete" ||
      [...active.values()].some(signal => !signal.aborted)) return;
    // The lookup barrier proves neither cache can introduce another owned loader.
    // A foreign-inflight waiter does not extend this operation's already-finished socket.
    if (!connectionFinished) {
      connectionFinished = true;
      try { connectionAbort.abort(); } catch { /* Late connect is also closed below. */ }
      if (client) closeClient(client);
    }
    if (candidates.workspace.finished && candidates.models.finished) closed = true;
  };

  const connect = () => {
    if (connectionFinished) return Promise.reject(cancelled());
    if (!connecting) connecting = (async () => {
      assertOwner();
      await prepareCatalogRead(capturedProfile, capturedServer, connectionAbort.signal);
      assertOwner();
      const result = await taskClientConnector(capturedProfile, capturedServer, capturedServer.workspacePath, "runtime", { signal: connectionAbort.signal });
      try { assertOwner(); if (connectionAbort.signal.aborted) throw cancelled(); }
      catch (error) { closeClient(result); throw error; }
      client = result;
      return result;
    })();
    return connecting;
  };
  return {
    assertOwner,
    cacheRead(branch, read) {
      const candidate = candidates[branch];
      if (!candidate.started || candidate.lookup !== "pending") throw new Error("目录缓存分支已登记");
      candidate.lookup = "queued";
      try { return read(); }
      finally {
        // ScopedReadCache schedules an owned loader before this barrier. A cancelled page waiter
        // cannot close the source before a surviving foreign waiter enters that original loader.
        void Promise.resolve().then(() => { candidate.lookup = "complete"; finishIfIdle(); });
      }
    },
    async run(branch, read) {
      const candidate = candidates[branch];
      if (candidate.started) throw new Error("目录读取分支已登记");
      candidate.started = true;
      try { assertOwner(); const result = await read(); assertOwner(); return result; }
      finally {
        candidate.finished = true;
        if (candidate.lookup === "pending") candidate.lookup = "complete"; // Authorization/read failed before cache admission.
        finishIfIdle();
      }
    },
    async withClient(branch, signal, read) {
      if (!candidates[branch].started || candidates[branch].lookup !== "queued" || active.has(branch)) throw new Error("目录连接仅供本次缓存 loader 使用");
      assertOwner(); if (signal.aborted || connectionFinished) throw cancelled();
      active.set(branch, signal);
      const abort = () => finishIfIdle();
      signal.addEventListener("abort", abort, { once: true });
      const assertCurrent = () => { assertOwner(); if (signal.aborted) throw cancelled(); };
      try {
        const connected = await abortable(connect(), signal);
        assertCurrent();
        const guarded: CatalogClient = {
          async request<T = unknown>(method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<T> {
            if (branch === "workspace" ? !["runtime.workspaces.list", "runtime.worktrees.list"].includes(method) : method !== "runtime.models.list") throw new Error("目录连接不支持此请求");
            assertCurrent();
            const started = await startWorkspaceProfileRpc(authorization, () => {
              assertCurrent(); return connected.request<T>(method, params, timeoutMs);
            });
            const result = await abortable(started.response, signal);
            await withWorkspaceProfileWrite(authorization, async () => { assertCurrent(); });
            assertCurrent();
            return result;
          },
        };
        const result = await read(guarded);
        assertCurrent();
        return result;
      } finally {
        signal.removeEventListener("abort", abort); active.delete(branch); finishIfIdle();
      }
    },
  };
}
