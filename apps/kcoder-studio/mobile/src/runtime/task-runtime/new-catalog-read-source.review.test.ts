// Candidate for the static-02 New catalog source. Uses the real cache, profile
// fence, GatewayRpcClient, and catalog readers with a controlled WebSocket.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { GatewayRpcClient } from "@/gateway/rpc";
import { installGatewayAuthorizationResolver } from "@/gateway/http";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { clearModelCache, listModels } from "./modelCatalog";
import { clearWorkspaceOptionsCache, listWorkspaceOptions } from "./workspaces";
import { taskRuntimeTestHelpers } from "./connectionFactory";
import { createNewCatalogReadSource } from "./new-catalog-read-source";

type WireMessage = { id?: number; method?: string; params?: Record<string, unknown> };

class ControlledRpcSocket {
  static OPEN = 1;
  static instances: ControlledRpcSocket[] = [];
  static holdOpen = false;

  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: WireMessage[] = [];
  closeCount = 0;
  throwOnClose = false;

  constructor(readonly url: string, readonly protocols?: string | string[] | null) {
    ControlledRpcSocket.instances.push(this);
    if (!ControlledRpcSocket.holdOpen) queueMicrotask(() => this.open());
  }

  open(): void {
    this.readyState = ControlledRpcSocket.OPEN;
    this.onopen?.();
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as WireMessage;
    this.sent.push(message);
    if (message.method === "initialize") {
      queueMicrotask(() => this.receive({ id: message.id, result: { protocolVersion: "2026-07-27" } }));
    }
  }

  receive(value: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", ...value }) });
  }

  respond(method: string, result: unknown): void {
    const request = [...this.sent].reverse().find((item) => item.method === method && typeof item.id === "number");
    if (!request?.id) throw new Error(`no pending ${method} request`);
    this.receive({ id: request.id, result });
  }

  fail(method: string, message: string): void {
    const request = [...this.sent].reverse().find((item) => item.method === method && typeof item.id === "number");
    if (!request?.id) throw new Error(`no pending ${method} request`);
    this.receive({ id: request.id, error: { code: -32603, message } });
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.();
    if (this.throwOnClose) throw new Error("controlled close failure");
  }
}

let profile: GatewayProfile;
let server: KCoderServer;
let browserProfileFixture: ReturnType<typeof installBrowserProfileFixture>;
let uninstallAuthorization: (() => void) | undefined;

function workspaceResult(path: string) {
  return { items: [{ workspacePath: path, label: path.split("/").at(-1) ?? path }] };
}
function modelResult(name = "Model") {
  return { data: [{ id: `provider::${name}`, model: name, displayName: name, providerId: "provider", providerName: "Provider", isDefault: true }] };
}
function respondWorkspace(socket: ControlledRpcSocket, path: string): void {
  socket.respond("runtime.workspaces.list", workspaceResult(path));
  socket.respond("runtime.worktrees.list", { items: [] });
}
function respondModels(socket: ControlledRpcSocket, name = "Model"): void {
  socket.respond("runtime.models.list", modelResult(name));
}
function startBoth(profileValue = profile, serverValue = server, workspaceSignal?: AbortSignal, modelSignal?: AbortSignal) {
  const source = createNewCatalogReadSource(profileValue, serverValue, () => true);
  const workspaces = source.run("workspace", () => listWorkspaceOptions(profileValue, serverValue, { signal: workspaceSignal }, source));
  const models = source.run("models", () => listModels(profileValue, serverValue, { signal: modelSignal, source }));
  return { source, workspaces, models };
}
async function waitForMethods(socketIndex: number, methods: string[]): Promise<ControlledRpcSocket> {
  await vi.waitFor(() => {
    const socket = ControlledRpcSocket.instances[socketIndex];
    expect(socket).toBeDefined();
    for (const method of methods) expect(socket?.sent.some((item) => item.method === method)).toBe(true);
  });
  return ControlledRpcSocket.instances[socketIndex]!;
}
function installSocket(): void {
  vi.stubGlobal("WebSocket", ControlledRpcSocket as unknown as typeof WebSocket);
}

beforeEach(() => {
  profile = {
    id: "new-catalog-profile-A", label: "Gateway A", baseUrl: "https://gateway.invalid",
    accessToken: "access-A", rpcToken: "rpc-A", expiresAt: Date.now() + 60_000,
    authorizationGeneration: "family-A", deviceId: "device-A", authMode: "device",
  };
  server = {
    id: "target-A", label: "Target A", description: "fixture", runtime: "kcoder", transport: "ssh",
    host: "target.invalid", user: "operator", port: 22, workspacePath: "/workspace/A",
    accountIdentity: { principalId: "principal-A", username: "operator-A", role: "user" },
  };
  ControlledRpcSocket.instances = [];
  ControlledRpcSocket.holdOpen = false;
  browserProfileFixture = installBrowserProfileFixture([profile]);
  uninstallAuthorization = installGatewayAuthorizationResolver(async () => {});
  installSocket();
});

afterEach(() => {
  uninstallAuthorization?.();
  uninstallAuthorization = undefined;
  taskRuntimeTestHelpers.resetConnector();
  clearWorkspaceOptionsCache();
  clearModelCache();
  ControlledRpcSocket.instances = [];
  ControlledRpcSocket.holdOpen = false;
});

it("cold New catalog uses one actual GatewayRpcClient and issues all three reads before replies", async () => {
  const reads = startBoth();
  const socket = await waitForMethods(0, ["initialize", "runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);
  expect(ControlledRpcSocket.instances).toHaveLength(1);
  expect(socket.sent.filter((item) => item.method === "initialize")).toHaveLength(1);
  expect(socket.sent.filter((item) => ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"].includes(item.method ?? ""))).toHaveLength(3);

  respondWorkspace(socket, "/workspace/A");
  respondModels(socket);
  const [options, models] = await Promise.all([reads.workspaces, reads.models]);
  expect(options.map((item) => item.path)).toEqual(["/workspace/A"]);
  expect(models.map((item) => item.model)).toEqual(["Model"]);
  expect(socket.closeCount).toBe(1);
});

it("keeps the workspace result when the model branch fails, even if final close throws", async () => {
  const reads = startBoth();
  const socket = await waitForMethods(0, ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);
  socket.throwOnClose = true;
  respondWorkspace(socket, "/workspace/A");
  await expect(reads.workspaces).resolves.toMatchObject([{ path: "/workspace/A" }]);

  socket.fail("runtime.models.list", "controlled model read failure");
  await expect(reads.models).rejects.toThrow("controlled model read failure");
  expect(socket.closeCount).toBeGreaterThan(0);
});

it("reuses two warm caches without connecting, then connects only for the invalidated model branch", async () => {
  const first = startBoth();
  const firstSocket = await waitForMethods(0, ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);
  respondWorkspace(firstSocket, "/workspace/A");
  respondModels(firstSocket);
  await Promise.all([first.workspaces, first.models]);

  const warm = startBoth();
  await expect(Promise.all([warm.workspaces, warm.models])).resolves.toBeDefined();
  expect(ControlledRpcSocket.instances).toHaveLength(1);

  clearModelCache(profile.id);
  const oneCold = startBoth();
  const secondSocket = await waitForMethods(1, ["initialize", "runtime.models.list"]);
  expect(secondSocket.sent.map((item) => item.method).filter((method) => method?.startsWith("runtime."))).toEqual(["runtime.models.list"]);
  respondModels(secondSocket, "Fresh");
  const [, freshModels] = await Promise.all([oneCold.workspaces, oneCold.models]);
  expect(freshModels.map((item) => item.model)).toEqual(["Fresh"]);
  expect(ControlledRpcSocket.instances).toHaveLength(2);
});

it("does not lend its source socket to a foreign in-flight workspace cache loader", async () => {
  const foreignWorkspaceRead = listWorkspaceOptions(profile, server);
  const foreignSocket = await waitForMethods(0, ["runtime.workspaces.list", "runtime.worktrees.list"]);
  const reads = startBoth();
  const sourceSocket = await waitForMethods(1, ["initialize", "runtime.models.list"]);
  expect(foreignSocket.sent.some((item) => item.method === "runtime.models.list")).toBe(false);
  expect(sourceSocket.sent.some((item) => item.method === "runtime.workspaces.list" || item.method === "runtime.worktrees.list")).toBe(false);

  respondModels(sourceSocket);
  respondWorkspace(foreignSocket, "/workspace/A");
  const [options, models, external] = await Promise.all([reads.workspaces, reads.models, foreignWorkspaceRead]);
  expect(options).toEqual(external);
  expect(options.map((item) => item.path)).toEqual(["/workspace/A"]);
  expect(models.map((item) => item.model)).toEqual(["Model"]);
  expect(ControlledRpcSocket.instances).toHaveLength(2);
});

it("cancels the final waiters, closes a held connect, and sends nothing after a late open", async () => {
  ControlledRpcSocket.holdOpen = true;
  const workspaceController = new AbortController();
  const modelController = new AbortController();
  const reads = startBoth(profile, server, workspaceController.signal, modelController.signal);
  const rejectedWorkspaces = expect(reads.workspaces).rejects.toThrow("读取已取消");
  const rejectedModels = expect(reads.models).rejects.toThrow("读取已取消");
  await vi.waitFor(() => expect(ControlledRpcSocket.instances).toHaveLength(1));
  const socket = ControlledRpcSocket.instances[0]!;
  workspaceController.abort();
  modelController.abort();
  await Promise.all([rejectedWorkspaces, rejectedModels]);
  await vi.waitFor(() => expect(socket.closeCount).toBeGreaterThan(0));
  socket.open();
  await Promise.resolve();
  await Promise.resolve();
  expect(socket.sent.some((item) => item.method === "initialize" || item.method?.startsWith("runtime."))).toBe(false);
});

it("rejects profile, device, target, principal, role, and exact raw-root scope changes before connecting", () => {
  const baseProfile = { ...profile };
  const baseServer: KCoderServer = { ...server, workspacePath: undefined, accountIdentity: { ...server.accountIdentity! } };
  const changes: Array<[string, GatewayProfile, KCoderServer]> = [
    ["profile id", { ...baseProfile, id: "profile-B" }, baseServer],
    ["Gateway origin", { ...baseProfile, baseUrl: "https://other.invalid" }, baseServer],
    ["authorization family", { ...baseProfile, authorizationGeneration: "family-B" }, baseServer],
    ["device", { ...baseProfile, deviceId: "device-B" }, baseServer],
    ["target", baseProfile, { ...baseServer, id: "target-B" }],
    ["principal", baseProfile, { ...baseServer, accountIdentity: { ...baseServer.accountIdentity!, principalId: "principal-B" } }],
    ["role", baseProfile, { ...baseServer, accountIdentity: { ...baseServer.accountIdentity!, role: "admin" } }],
    ["undefined versus empty raw root", baseProfile, { ...baseServer, workspacePath: "" }],
  ];
  for (const [label, changedProfile, changedServer] of changes) {
    const source = createNewCatalogReadSource(baseProfile, baseServer, () => true);
    expect(() => source.assertOwner(changedProfile, changedServer), label).toThrow("目录读取授权或目标归属已变化");
  }
  expect(ControlledRpcSocket.instances).toHaveLength(0);
});

it("rejects a held catalog RPC after the authoritative device or authorization family changes", async () => {
  const originalDeviceId = profile.deviceId;
  const originalGeneration = profile.authorizationGeneration;
  const profileIndexKey = "kcoder-studio-mobile.gateway-profiles.v2";
  const persistCurrentIdentity = () => {
    browserProfileFixture.localStorage.setItem(profileIndexKey, JSON.stringify({ profiles: [{
      id: profile.id, baseUrl: profile.baseUrl, authorizationGeneration: profile.authorizationGeneration, deviceId: profile.deviceId,
    }] }));
  };

  for (const identityChange of ["deviceId", "authorizationGeneration"] as const) {
    clearWorkspaceOptionsCache(profile.id);
    clearModelCache(profile.id);
    ControlledRpcSocket.instances = [];
    profile.deviceId = originalDeviceId;
    profile.authorizationGeneration = originalGeneration;
    persistCurrentIdentity();

    const reads = startBoth();
    const socket = await waitForMethods(0, ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);
    respondWorkspace(socket, "/workspace/A");
    await expect(reads.workspaces).resolves.toMatchObject([{ path: "/workspace/A" }]);

    if (identityChange === "deviceId") profile.deviceId = "device-B";
    else profile.authorizationGeneration = "family-B";
    persistCurrentIdentity();
    // The server response is now released only after the authoritative identity changed.
    socket.respond("runtime.models.list", modelResult());
    await expect(reads.models).rejects.toThrow("Gateway 授权归属已变化");
  }

  profile.deviceId = originalDeviceId;
  profile.authorizationGeneration = originalGeneration;
  persistCurrentIdentity();
});

it("keeps same-family token refresh in scope and connects with the refreshed RPC credential", async () => {
  const latest = { access: "access-refreshed", rpc: "rpc-refreshed" };
  uninstallAuthorization?.();
  uninstallAuthorization = installGatewayAuthorizationResolver(async (candidate) => {
    if (candidate.accessToken !== latest.access) candidate.accessToken = latest.access;
    if (candidate.rpcToken !== latest.rpc) candidate.rpcToken = latest.rpc;
  });
  const reads = startBoth();
  const socket = await waitForMethods(0, ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);
  expect(new URL(socket.url).searchParams.get("token")).toBe("rpc-refreshed");
  expect(profile.deviceId).toBe("device-A");
  expect(profile.authorizationGeneration).toBe("family-A");
  respondWorkspace(socket, "/workspace/A");
  respondModels(socket);
  await Promise.all([reads.workspaces, reads.models]);
});
