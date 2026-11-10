// Review candidate: one bounded, scope-owned workspace snapshot is shared by
// the Open Project projections. Transport stays injected; this is not RTT proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { MobileRpcError } from "@/gateway/rpc";
import { WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { PROFILE_INDEX_KEY } from "@/storage/profile-store";
import { taskRuntimeTestHelpers } from "./task-runtime/connectionFactory";
import {
  clearWorkspaceOptionsCache,
  forgetManagedWorktree,
  listManagedWorktrees,
  listWorkspaceCatalog,
  listWorkspaceOptions,
  workspaceEntryIdentity,
  workspaceProjectIdentity,
} from "./task-runtime/workspaces";

const operationStorage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => operationStorage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { operationStorage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { operationStorage.delete(key); }),
  getAllKeys: vi.fn(async () => [...operationStorage.keys()]),
} }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

type CatalogRow = Record<string, unknown>;
type Pending = { method: string; resolve(value: unknown): void; reject(reason: unknown): void };
type CatalogClientOptions = {
  worktrees?: CatalogRow[];
  workspaces?: CatalogRow[];
  holdCatalog?: boolean;
  holdMethods?: string[];
  workspaceFailure?: Error;
  omitWorkspaceItems?: boolean;
  keepPendingOnClose?: boolean;
};

class CatalogClient {
  readonly methods: string[] = [];
  readonly pending: Pending[] = [];
  closeCount = 0;

  constructor(private readonly options: CatalogClientOptions = {}) {}

  request<T>(method: string): Promise<T> {
    this.methods.push(method);
    const isCatalog = method === "runtime.workspaces.list" || method === "runtime.worktrees.list";
    if ((this.options.holdCatalog && isCatalog) || this.options.holdMethods?.includes(method)) {
      return new Promise<T>((resolve, reject) => this.pending.push({
        method,
        resolve: value => resolve(value as T),
        reject,
      }));
    }
    if (method === "runtime.workspaces.list") {
      if (this.options.workspaceFailure) return Promise.reject(this.options.workspaceFailure);
      if (this.options.omitWorkspaceItems) return Promise.resolve({} as T);
      return Promise.resolve({ items: this.options.workspaces ?? [] } as T);
    }
    if (method === "runtime.worktrees.list") return Promise.resolve({ items: this.options.worktrees ?? [] } as T);
    if (method === "runtime.worktrees.forget") return Promise.resolve({ forgotten: true } as T);
    return Promise.reject(new Error(`unexpected catalog RPC: ${method}`));
  }

  resolvePending(method: string, value: unknown): void {
    const index = this.pending.findIndex(item => item.method === method);
    if (index < 0) throw new Error(`no pending RPC to resolve: ${method}`);
    this.pending.splice(index, 1)[0]!.resolve(value);
  }

  rejectPending(method: string, error: unknown): void {
    const index = this.pending.findIndex(item => item.method === method);
    if (index < 0) throw new Error(`no pending RPC to reject: ${method}`);
    this.pending.splice(index, 1)[0]!.reject(error);
  }

  close(): void {
    this.closeCount += 1;
    if (!this.options.keepPendingOnClose) {
      for (const pending of this.pending) pending.reject(new Error("owned catalog transport closed"));
      this.pending.length = 0;
    }
  }
}

let profile: GatewayProfile;
let server: KCoderServer;
let profileStorage: ReturnType<typeof installBrowserProfileFixture>;

function setProfileIndex(value: GatewayProfile): void {
  profileStorage.localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify({ profiles: [{
    id: value.id,
    baseUrl: value.baseUrl,
    authorizationGeneration: value.authorizationGeneration,
    deviceId: value.deviceId,
  }] }));
}

function worktree(path: string, state: string, worktreeId = path.split("/").at(-1) ?? "tree"): CatalogRow {
  return {
    deviceId: "device-a",
    worktreeId,
    path,
    repositoryName: worktreeId,
    permanent: false,
    revision: 3,
    state,
    conversations: [{ threadId: `thread-${worktreeId}` }],
  };
}

beforeEach(() => {
  operationStorage.clear();
  profile = {
    id: "catalog-profile-a", label: "Gateway A", baseUrl: "http://127.0.0.1:4173",
    accessToken: "access-a", rpcToken: "rpc-a", expiresAt: Number.MAX_SAFE_INTEGER,
    authorizationGeneration: "auth-a", deviceId: "device-a",
  };
  server = {
    id: "target-a", label: "Target A", description: "fixture", runtime: "kcoder", transport: "local",
    workspacePath: "/workspace",
  };
  profileStorage = installBrowserProfileFixture([profile]);
  taskRuntimeTestHelpers.resetConnector();
  clearWorkspaceOptionsCache();
});

afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  clearWorkspaceOptionsCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceCatalogSnapshot v1 review contract", () => {
  it("coalesces the catalog and workspace-options projections into one connector and one request per catalog", async () => {
    const client = new CatalogClient({
      worktrees: [worktree("/workspace/tree-active", "active"), worktree("/workspace/tree-old", "restorable")],
      workspaces: [{ workspacePath: "/workspace", label: "Root" }],
    });
    const connect = vi.fn(async () => client as never);
    taskRuntimeTestHelpers.setConnector(connect as never);

    const [snapshot, options] = await Promise.all([
      listWorkspaceCatalog(profile, server),
      listWorkspaceOptions(profile, server),
    ]);

    expect(connect).toHaveBeenCalledOnce();
    expect(client.methods.filter(method => method === "runtime.workspaces.list")).toHaveLength(1);
    expect(client.methods.filter(method => method === "runtime.worktrees.list")).toHaveLength(1);
    expect(options).toEqual(snapshot.options);
    expect(snapshot.options).toEqual([
      { path: "/workspace", label: "Root", kind: "workspace" },
      { path: "/workspace/tree-active", label: "tree-active", kind: "worktree", projectKey: "runtime-target:target-a", rootProject: true, projectName: "Target A", projectRoots: ["/workspace"] },
    ]);
    expect(snapshot.managedWorktrees.map(item => [item.path, item.state, item.conversations.length])).toEqual([
      ["/workspace/tree-active", "active", 1],
      ["/workspace/tree-old", "restorable", 1],
    ]);
    expect(client.closeCount).toBe(1);
  });

  it("preserves registry project identity and scopes same-path entries to the owning target", async () => {
    const client = new CatalogClient({
      workspaces: [{
        workspacePath: "/workspace/project-a",
        label: "Project folder",
        projectName: "Project A",
        projectKey: "registry-project-a",
        projectRoots: ["/workspace/project-a", "/workspace/shared-root"],
        labelKey: "currentComputer",
      }],
      worktrees: [worktree("/workspace/tree", "active")],
    });
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);

    const options = await listWorkspaceOptions(profile, server);
    expect(options).toEqual([
      {
        path: "/workspace/project-a",
        label: "Project folder",
        kind: "workspace",
        projectKey: "registry-project-a",
        projectName: "Project A",
        projectRoots: ["/workspace/project-a", "/workspace/shared-root"],
        projectNameKey: "currentComputer",
      },
      {
        path: "/workspace/tree",
        label: "tree",
        kind: "worktree",
        projectKey: "runtime-target:target-a",
        rootProject: true,
        projectName: "Target A",
        projectRoots: ["/workspace"],
      },
    ]);

    const samePathOtherTarget = { ...server, id: "target-b", transport: "ssh" as const };
    expect(workspaceProjectIdentity(profile, server, "registry-project-a"))
      .not.toBe(workspaceProjectIdentity(profile, samePathOtherTarget, "registry-project-a"));
    expect(workspaceEntryIdentity(profile, server, "registry-project-a", "/workspace/project-a"))
      .not.toBe(workspaceEntryIdentity(profile, samePathOtherTarget, "registry-project-a", "/workspace/project-a"));
    expect(workspaceEntryIdentity(profile, server, "registry-project-a", "/workspace/project-a/"))
      .toBe(workspaceEntryIdentity(profile, server, "registry-project-a", "/workspace/project-a"));
    expect(workspaceEntryIdentity(profile, server, "registry-project-a", "C:/"))
      .toBe(workspaceEntryIdentity(profile, server, "registry-project-a", "C:\\"));
    expect(workspaceProjectIdentity(profile, server, "registry-project-a"))
      .not.toBe(workspaceProjectIdentity({ ...profile, authorizationGeneration: "auth-b" }, server, "registry-project-a"));
  });

  it("keeps a shared loader for a surviving waiter and closes only when the final waiter leaves", async () => {
    const held = new CatalogClient({ holdCatalog: true, keepPendingOnClose: true });
    const fresh = new CatalogClient({ workspaces: [{ workspacePath: "/fresh", label: "Fresh" }] });
    const connectSignals: AbortSignal[] = [];
    const connect = vi.fn(async (_profile, _server, _path, _channel, options) => {
      const index = connectSignals.length;
      if (options?.signal) connectSignals.push(options.signal);
      return (index === 0 ? held : fresh) as never;
    });
    taskRuntimeTestHelpers.setConnector(connect as never);
    const firstAbort = new AbortController();
    const peerAbort = new AbortController();
    const first = listWorkspaceCatalog(profile, server, { signal: firstAbort.signal });
    const peer = listWorkspaceCatalog(profile, server, { signal: peerAbort.signal });
    const peerSettled = vi.fn();
    void peer.then(() => peerSettled("resolved"), () => peerSettled("rejected"));
    await vi.waitFor(() => expect(held.pending).toHaveLength(2));

    firstAbort.abort();
    await expect(first).rejects.toThrow("取消");
    expect(connectSignals[0]?.aborted).toBe(false);
    expect(held.closeCount).toBe(0);
    expect(peerSettled).not.toHaveBeenCalled();

    peerAbort.abort();
    await expect(peer).rejects.toThrow("取消");
    await vi.waitFor(() => expect(held.closeCount).toBe(1));
    expect(connectSignals[0]?.aborted).toBe(true);

    // The transport may deliver a late success after close/abort. It must not
    // repopulate the removed cache entry or satisfy the next generation of reads.
    held.resolvePending("runtime.workspaces.list", { items: [{ workspacePath: "/stale", label: "Stale" }] });
    held.resolvePending("runtime.worktrees.list", { items: [worktree("/workspace/stale", "active")] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const retry = await listWorkspaceCatalog(profile, server);
    expect(retry.options).toEqual([{ path: "/fresh", label: "Fresh", kind: "workspace" }]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(fresh.closeCount).toBe(1);
  });

  it.each(["ack", "unknown"] as const)("invalidates a peer snapshot filled during a worktree forget (%s)", async outcome => {
    const oldLoader = new CatalogClient({
      holdCatalog: true,
      keepPendingOnClose: true,
    });
    const mutation = new CatalogClient({ holdMethods: ["runtime.worktrees.forget"] });
    const peerLoader = new CatalogClient({ holdCatalog: true });
    const fresh = new CatalogClient({ workspaces: [{ workspacePath: "/workspace", label: "Root" }] });
    const clients = [oldLoader, mutation, peerLoader, fresh];
    let clientIndex = 0;
    const connect = vi.fn(async () => clients[clientIndex++] as never);
    taskRuntimeTestHelpers.setConnector(connect as never);

    const staleBeforeMutation = listWorkspaceCatalog(profile, server);
    const staleBeforeMutationRejected = expect(staleBeforeMutation).rejects.toThrow("取消");
    await vi.waitFor(() => expect(oldLoader.pending).toHaveLength(2));
    const forget = forgetManagedWorktree(profile, server, {
      deviceId: "device-a", worktreeId: "tree", path: "/workspace/tree", repositoryName: "tree",
      permanent: false, revision: 3, state: "restorable", conversations: [],
    });
    await vi.waitFor(() => expect(mutation.pending).toHaveLength(1));
    await staleBeforeMutationRejected;
    expect(oldLoader.closeCount).toBe(1);

    // A peer can start after the mutation's pre-clear and repopulate the old
    // directory while the mutation is still awaiting its ACK.
    const peer = listWorkspaceCatalog(profile, server);
    await vi.waitFor(() => expect(peerLoader.pending).toHaveLength(2));
    peerLoader.resolvePending("runtime.workspaces.list", { items: [{ workspacePath: "/workspace", label: "Root" }] });
    peerLoader.resolvePending("runtime.worktrees.list", { items: [worktree("/workspace/tree", "active")] });
    expect((await peer).managedWorktrees.map(item => item.path)).toEqual(["/workspace/tree"]);

    if (outcome === "ack") {
      mutation.resolvePending("runtime.worktrees.forget", { forgotten: true });
      await expect(forget).resolves.toBeUndefined();
    } else {
      const lostAck = new MobileRpcError("forget ACK unavailable", -1, "transport", "unknown");
      mutation.rejectPending("runtime.worktrees.forget", lostAck);
      await expect(forget).rejects.toBe(lostAck);
    }

    // Complete the pre-mutation loader after the last waiter already cancelled.
    // Its stale success must not win over either the peer entry's post-clear or
    // the next fresh catalog.
    oldLoader.resolvePending("runtime.workspaces.list", { items: [{ workspacePath: "/stale", label: "Stale" }] });
    oldLoader.resolvePending("runtime.worktrees.list", { items: [worktree("/workspace/stale", "active")] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const refreshed = await listWorkspaceCatalog(profile, server);
    expect(refreshed.managedWorktrees).toEqual([]);
    expect(refreshed.options).toEqual([{ path: "/workspace", label: "Root", kind: "workspace" }]);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(mutation.methods).toEqual(["runtime.worktrees.forget"]);
    expect(fresh.methods.filter(method => method === "runtime.worktrees.list")).toHaveLength(1);
  });

  it("keeps the legacy managed-worktree reader worktree-only and fresh", async () => {
    const first = new CatalogClient({ worktrees: [worktree("/workspace/first", "active")] });
    const second = new CatalogClient({ worktrees: [worktree("/workspace/second", "active")] });
    const strictCatalogError = new MobileRpcError("workspace list unavailable", -32601, "remote");
    const catalog = new CatalogClient({ worktrees: [], workspaceFailure: strictCatalogError });
    const clients = [first, second, catalog];
    let clientIndex = 0;
    const connect = vi.fn(async () => clients[clientIndex++] as never);
    taskRuntimeTestHelpers.setConnector(connect as never);

    await expect(listManagedWorktrees(profile, server)).resolves.toMatchObject([{ path: "/workspace/first", state: "active" }]);
    await expect(listManagedWorktrees(profile, server)).resolves.toMatchObject([{ path: "/workspace/second", state: "active" }]);
    expect(first.methods).toEqual(["runtime.worktrees.list"]);
    expect(second.methods).toEqual(["runtime.worktrees.list"]);
    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);

    await expect(listWorkspaceCatalog(profile, server)).rejects.toBe(strictCatalogError);
    expect(catalog.methods).toEqual(["runtime.workspaces.list", "runtime.worktrees.list"]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("keeps the combined snapshot strict for transport, protocol, profile-fence, and abort failures", async () => {
    const failures: Error[] = [
      new MobileRpcError("socket closed", -1, "transport", "unknown"),
      new MobileRpcError("invalid RPC response", -1, "protocol", "unknown"),
      new WorkspaceProfileFenceError(),
    ];
    for (const failure of failures) {
      clearWorkspaceOptionsCache();
      const client = new CatalogClient({ worktrees: [worktree("/workspace/tree", "active")], workspaceFailure: failure });
      taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
      await expect(listWorkspaceCatalog(profile, server)).rejects.toBe(failure);
      expect(client.closeCount).toBe(1);
    }

    clearWorkspaceOptionsCache();
    const held = new CatalogClient({ holdCatalog: true });
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => held as never) as never);
    const controller = new AbortController();
    const read = listWorkspaceCatalog(profile, server, { signal: controller.signal });
    const cancelled = expect(read).rejects.toThrow("取消");
    await vi.waitFor(() => expect(held.pending).toHaveLength(2));
    controller.abort();
    await cancelled;
    expect(held.closeCount).toBe(1);
  });

  it("keeps cache entries separate across exact target and authorization scope dimensions", async () => {
    const clients: CatalogClient[] = [];
    const connect = vi.fn(async () => {
      const client = new CatalogClient();
      clients.push(client);
      return client as never;
    });
    taskRuntimeTestHelpers.setConnector(connect as never);

    await listWorkspaceCatalog(profile, server);
    await listWorkspaceCatalog(profile, { ...server, workspacePath: "/workspace/" });
    await listWorkspaceCatalog(profile, { ...server, workspacePath: undefined });
    await listWorkspaceCatalog(profile, { ...server, workspacePath: "" });
    await listWorkspaceCatalog(profile, {
      ...server,
      accountIdentity: { principalId: "principal-b", username: "operator", role: "user" },
    });
    await listWorkspaceCatalog(profile, {
      ...server,
      accountIdentity: { principalId: "principal-b", username: "operator", role: "admin" },
    });

    const routeProfile = { ...profile, baseUrl: `${profile.baseUrl}/g/route-b` };
    setProfileIndex(routeProfile);
    await listWorkspaceCatalog(routeProfile, server);
    const generationProfile = { ...profile, authorizationGeneration: "auth-b" };
    setProfileIndex(generationProfile);
    await listWorkspaceCatalog(generationProfile, server);

    expect(connect).toHaveBeenCalledTimes(8);
    expect(clients).toHaveLength(8);
    expect(clients.every(client => client.closeCount === 1)).toBe(true);
  });

  it("does not expose a delayed old-generation snapshot to the new authorization scope", async () => {
    const delayedOld = new CatalogClient({ holdCatalog: true, keepPendingOnClose: true });
    const current = new CatalogClient({
      worktrees: [worktree("/workspace/current", "active")],
      workspaces: [{ workspacePath: "/current", label: "Current" }],
    });
    const clients = [delayedOld, current];
    let clientIndex = 0;
    const connect = vi.fn(async () => clients[clientIndex++] as never);
    taskRuntimeTestHelpers.setConnector(connect as never);

    const oldRead = listWorkspaceCatalog(profile, server);
    await vi.waitFor(() => expect(delayedOld.pending).toHaveLength(2));
    const nextGeneration = { ...profile, authorizationGeneration: "auth-b" };
    setProfileIndex(nextGeneration);
    const currentRead = await listWorkspaceCatalog(nextGeneration, server);
    expect(currentRead.options).toEqual([
      { path: "/current", label: "Current", kind: "workspace" },
      { path: "/workspace/current", label: "current", kind: "worktree", projectKey: "runtime-target:target-a", rootProject: true, projectName: "Target A", projectRoots: ["/workspace"] },
    ]);

    delayedOld.resolvePending("runtime.workspaces.list", { items: [{ workspacePath: "/stale", label: "Stale" }] });
    delayedOld.resolvePending("runtime.worktrees.list", { items: [worktree("/workspace/stale", "active")] });
    await oldRead;
    await expect(listWorkspaceCatalog(nextGeneration, server)).resolves.toEqual(currentRead);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(current.closeCount).toBe(1);
  });
});
