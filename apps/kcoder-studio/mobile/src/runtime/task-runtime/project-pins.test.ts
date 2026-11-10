import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { taskRuntimeTestHelpers } from "./connectionFactory";
import { groupThreadsByProject } from "@/components/thread-list-presentation";
import { clearWorkspaceOptionsCache, listWorkspaceThreadScopes, readWorkspaceCatalogOnClient, type WorkspaceOption } from "./workspaces";
import { setRuntimeProjectPinned } from "./project-pins";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null } }));
const profile: GatewayProfile = { id: "owner", baseUrl: "https://synthetic.test", label: "Owner", accessToken: "token", rpcToken: "rpc", expiresAt: Number.MAX_SAFE_INTEGER, authorizationGeneration: "family", deviceId: "device" };
const server: KCoderServer = { id: "target", label: "Target", runtime: "kcoder", transport: "local", description: "", workspacePath: "/repo" };
type Row = Record<string, unknown>;
type PinCall = { method: string; params?: Row; server: KCoderServer; profile: GatewayProfile };
let pinned: boolean;
let rootPinned: boolean;
let methods: PinCall[];
let closed: number;
let loseReceipt: boolean;
let denyWrite: boolean;
let rootSupported: boolean;
let registryKey: string;
let registryPaths: string[];
let beforeConnect: (() => Promise<void>) | undefined;
let unreachable: boolean;
let worktreesUnavailable: boolean;
function rows(): Row[] {
  return registryPaths.map(workspacePath => ({ workspacePath, label: "Project", projectKey: registryKey, projectName: "Project", projectPinned: pinned, projectPinnedOrder: pinned ? 2 : null }));
}
function client(owner = profile, target = server) {
  return {
    supportsExperimental: () => rootSupported,
    close: () => { closed++; },
    async request<T>(method: string, params?: Row): Promise<T> {
      methods.push({ method, params, server: target, profile: owner });
      if (method === "runtime.workspaces.list") return { items: rows(), rootProjectPinned: rootPinned } as T;
      if (method === "runtime.worktrees.list") {
        if (worktreesUnavailable) throw new Error("worktree index unavailable");
        return { items: [] } as T;
      }
      if (method === "runtime.sidebar.projects.pin") {
        if (denyWrite) throw new Error("write denied");
        if (params?.rootProject) rootPinned = params.pinned === true; else pinned = params?.pinned === true;
        if (loseReceipt) throw new Error("receipt lost after commit");
        return { success: true, accepted: true } as T;
      }
      throw new Error("unexpected method");
    },
  };
}
beforeEach(() => {
  installBrowserProfileFixture([profile]);
  clearWorkspaceOptionsCache(profile.id);
  pinned = false; rootPinned = true; methods = []; closed = 0; loseReceipt = false; denyWrite = false; rootSupported = true; beforeConnect = undefined; unreachable = false; worktreesUnavailable = false;
  registryKey = "registry-key"; registryPaths = ["/repo/main", "/repo/tools"];
  taskRuntimeTestHelpers.setConnector((async (owner: GatewayProfile, target: KCoderServer) => {
    await beforeConnect?.();
    if (unreachable) throw new Error("Target is unreachable");
    return client(owner, target);
  }) as never);
});
afterEach(() => { taskRuntimeTestHelpers.resetConnector(); });

describe("app-server-owned project pinning", () => {
  it("pins and unpins an ordinary registry project through the app-server and returns its workspace state", async () => {
    const confirmation = await setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true);
    expect(confirmation).toMatchObject({ pinned: true, pinnedOrder: 2 });
    expect(confirmation.workspaces.filter(option => option.projectKey === "registry-key")).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectKey: "registry-key", projectPinned: true, rootProject: false }),
    ]));
    const options = (await readWorkspaceCatalogOnClient(client(), server)).options;
    expect(groupThreadsByProject(profile, server, [], options).find(item => item.projectKey === "registry-key")).toMatchObject({ pinned: true, pinnedOrder: 2 });
    const unpinned = await setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, false, () => true);
    expect(unpinned).toMatchObject({ pinned: false });
    expect(methods.filter(item => item.method === "runtime.sidebar.projects.pin").map(item => item.params)).toEqual([
      { deviceId: "target", projectKey: "registry-key", pinned: true },
      { deviceId: "target", projectKey: "registry-key", pinned: false },
    ]);
    expect(methods.filter(item => item.method === "runtime.workspaces.list")).toHaveLength(3);
    expect(closed).toBe(2);
  });

  it("keeps a same-key registry project separate from root pinning", async () => {
    registryKey = "runtime-target:target";
    registryPaths = ["/repo"];
    const initial = (await readWorkspaceCatalogOnClient(client(), server)).options;
    const projects = groupThreadsByProject(profile, server, [], initial);
    expect(projects.map(item => [item.projectKey, item.rootProject, item.pinned])).toEqual([[registryKey, false, false]]);
    await setRuntimeProjectPinned(profile, server, { projectKey: registryKey, rootProject: false }, true, () => true);
    expect(pinned).toBe(true);
    expect(rootPinned).toBe(true);
    expect(methods.find(item => item.method === "runtime.sidebar.projects.pin")?.params).toEqual({ deviceId: "target", projectKey: registryKey, pinned: true });
  });

  it("maps root pins to server.workspacePath and requires sidebarRootPinning", async () => {
    await setRuntimeProjectPinned(profile, server, { projectKey: "runtime-target:target", rootProject: true }, false, () => true);
    expect(methods.find(item => item.method === "runtime.sidebar.projects.pin")?.params).toEqual({ deviceId: "target", projectKey: "/repo", rootProject: true, pinned: false });
    expect(rootPinned).toBe(false);
    methods = []; rootSupported = false;
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "runtime-target:target", rootProject: true }, true, () => true)).rejects.toThrow("support");
    expect(methods).toEqual([]);
    expect(closed).toBe(2);
  });

  it("does not claim support for an older server, while retaining supported ordinary-project pins", async () => {
    rootSupported = false;
    const legacy = { supportsExperimental: () => false, request: async <T>(method: string) => ({ items: method === "runtime.workspaces.list" ? [{ workspacePath: "/repo", label: "Legacy" }] : [] }) as T };
    const legacyOptions = (await readWorkspaceCatalogOnClient(legacy, server)).options;
    expect(groupThreadsByProject(profile, server, [], legacyOptions)[0]?.pinned).toBeUndefined();
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "runtime-target:target", rootProject: true }, true, () => true)).rejects.toThrow("support");
    expect(methods).toEqual([]);
    rootSupported = false;
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true)).resolves.toMatchObject({ pinned: true });
    expect(methods.filter(item => item.method === "runtime.sidebar.projects.pin")).toHaveLength(1);
  });

  it("does not report an offline target as pinned", async () => {
    unreachable = true;
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true)).rejects.toThrow("Target is unreachable");
    expect(methods).toEqual([]);
    expect(pinned).toBe(false);
    expect(closed).toBe(0);
  });

  it("confirms a committed pin without depending on unrelated worktree reads", async () => {
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true)).resolves.toBeDefined();
    expect(pinned).toBe(true);
    expect(methods.some(item => item.method === "runtime.worktrees.list")).toBe(false);
    expect(methods.filter(item => item.method === "runtime.sidebar.projects.pin")).toHaveLength(1);
  });

  it("reconciles a lost receipt by reading once and never sends the mutation again", async () => {
    loseReceipt = true;
    const confirmation = await setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true);
    expect(confirmation.pinned).toBe(true);
    expect(methods.filter(item => item.method === "runtime.sidebar.projects.pin")).toHaveLength(1);
    expect(methods.filter(item => item.method === "runtime.workspaces.list")).toHaveLength(1);
    expect(closed).toBe(2);
  });

  it("does not publish a rejected state when the target did not commit the pin", async () => {
    denyWrite = true;
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true)).rejects.toMatchObject({
      name: "ProjectPinReconciliationError", stage: "write", cause: { message: "write denied" },
    });
    expect(pinned).toBe(false);
    expect(methods.filter(item => item.method === "runtime.sidebar.projects.pin")).toHaveLength(1);
  });

  it("does not dispatch if ownership or online readiness changes during connection", async () => {
    let current = true;
    beforeConnect = async () => { current = false; };
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => current)).rejects.toThrow();
    expect(methods).toEqual([]);
    expect(closed).toBe(1);

    current = true;
    let online = true;
    beforeConnect = async () => { online = false; };
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true, () => online)).rejects.toThrow();
    expect(methods).toEqual([]);
  });

  it("does not read or publish a late write receipt after the interaction owner changes", async () => {
    let current = true;
    let resolveReceipt!: (value: unknown) => void;
    const receipt = new Promise(resolve => { resolveReceipt = resolve; });
    const mutation = vi.fn(() => receipt);
    const owned = client();
    taskRuntimeTestHelpers.setConnector((async () => ({ ...owned, request: (method: string, params?: Row) => {
      if (method === "runtime.sidebar.projects.pin") { methods.push({ method, params, server, profile }); return mutation(); }
      return owned.request(method, params);
    } })) as never);
    const pending = setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => current);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    current = false;
    resolveReceipt({ success: true, accepted: true });
    await rejected;
    expect(methods.filter(item => item.method === "runtime.workspaces.list")).toHaveLength(0);
    expect(closed).toBe(1);
  });

  it("rejects replaced authorization and target/account owners while connecting", async () => {
    installBrowserProfileFixture([{ ...profile, authorizationGeneration: "replacement" }]);
    await expect(setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true)).rejects.toThrow();
    expect(methods).toEqual([]);
    installBrowserProfileFixture([profile]);
    for (const replacement of [
      { ...server, observationTargetIdentity: "a".repeat(64) },
      { ...server, accountIdentity: { principalId: "other", username: "other", role: "user" } },
    ]) {
      const requestedServer = { ...server };
      let activeServer: KCoderServer = requestedServer;
      beforeConnect = async () => { activeServer = replacement; };
      await expect(setRuntimeProjectPinned(profile, requestedServer, { projectKey: "registry-key", rootProject: false }, true,
        () => activeServer === requestedServer)).rejects.toThrow();
      expect(methods).toEqual([]);
      beforeConnect = undefined;
    }
    const mutableServer = { ...server };
    beforeConnect = async () => { mutableServer.observationTargetIdentity = "b".repeat(64); };
    await expect(setRuntimeProjectPinned(profile, mutableServer, { projectKey: "registry-key", rootProject: false }, true, () => true)).rejects.toThrow();
    expect(methods).toEqual([]);
  });

  it("returns complete sidebar workspaces from the authoritative readback", async () => {
    const confirmation = await setRuntimeProjectPinned(profile, server, { projectKey: "registry-key", rootProject: false }, true, () => true);
    expect(confirmation.workspaces.map((option: WorkspaceOption) => option.path)).toEqual(["/repo", "/repo/main", "/repo/tools"]);
    expect(confirmation.workspaces.filter(option => option.projectKey === "registry-key").every(option => option.projectPinned === true && option.rootProject === false)).toBe(true);
  });

  it("keeps fresh root pin metadata and known worktrees when the managed worktree index fails", async () => {
    rootPinned = false;
    worktreesUnavailable = true;
    const known: WorkspaceOption[] = [
      { path: "/repo", label: "Target", kind: "workspace", projectKey: "runtime-target:target", projectPinned: true, rootProject: true },
      { path: "/repo/.worktrees/retained", label: "retained", kind: "worktree", projectKey: "runtime-target:target", projectPinned: true, rootProject: true },
    ];
    const result = await listWorkspaceThreadScopes(profile, server, known);
    expect(result.error).toBe("worktree index unavailable");
    expect(result.options.find(option => option.path === "/repo")).toMatchObject({ projectPinned: false, rootProject: true });
    expect(result.options.find(option => option.path === "/repo/.worktrees/retained")).toMatchObject({ kind: "worktree", projectPinned: false, rootProject: true });
  });

  it("fails fast when the workspace registry rejects while worktree listing hangs", async () => {
    const registryError = new Error("workspace registry unavailable");
    let worktreeStarted = false;
    const pendingClient = {
      request<T>(method: string): Promise<T> {
        if (method === "runtime.workspaces.list") return Promise.reject(registryError);
        if (method === "runtime.worktrees.list") {
          worktreeStarted = true;
          return new Promise<T>(() => {});
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ status: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ status: "timeout" }), 300); });
    const outcome = await Promise.race([
      readWorkspaceCatalogOnClient(pendingClient, server).then(
        () => ({ status: "resolved" as const }),
        error => ({ status: "rejected" as const, error }),
      ),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    expect(worktreeStarted).toBe(true);
    expect(outcome).toEqual({ status: "rejected", error: registryError });
  });
});
