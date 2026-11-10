import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRpcClient } from "./rpc";
import type { GatewayProfile, KCoderServer } from "./types";

vi.mock("expo-constants", () => ({ default: { nativeAppVersion: "2.4.1", expoConfig: { version: "2.4.0" } } }));

const routeApi = vi.hoisted(() => ({
  resolve: vi.fn(async (profile: { baseUrl: string }, _options?: { signal?: AbortSignal; force?: boolean }) => profile.baseUrl),
  invalidate: vi.fn(),
  selectPairing: vi.fn(async (baseUrl: string) => baseUrl),
  normalize: vi.fn((value: unknown) => value),
}));
const peerApi = vi.hoisted(() => ({
  createSocket: vi.fn(),
  alive: vi.fn(() => true),
}));
vi.mock("./connection-routes", () => ({
  GatewayRouteResolutionError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
  resolveGatewayRoute: routeApi.resolve,
  invalidateGatewayRoute: routeApi.invalidate,
  selectPairingGatewayRoute: routeApi.selectPairing,
  normalizeGatewayConnectionRoutes: routeApi.normalize,
}));
vi.mock("./peer-transport", () => ({
  createPeerSocket: peerApi.createSocket,
  isPeerTransportAlive: peerApi.alive,
  isPeerTransportUrl: (value: string) => value.startsWith("kcoder-p2p://"),
  invalidatePeerTransport: vi.fn(),
  peerFetch: vi.fn(),
  releasePeerTransports: vi.fn(),
  tryCreatePeerTransport: vi.fn(),
}));

const profile: GatewayProfile = {
  id: "vm",
  label: "VM",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "access",
  expiresAt: 9_999_999_999_999,
  rpcToken: "rpc",
};
const server: KCoderServer = {
  id: "local",
  label: "Local",
  description: "test",
  runtime: "kcoder",
  transport: "local",
};

const originalWebSocket = globalThis.WebSocket;

class MockWebSocket {
  static OPEN = 1;
  static initializeResult: unknown;
  static instances: MockWebSocket[] = [];
  static failOpen = false;
  static deferOpen = false;

  static connections: Array<{
    url: string;
    protocols?: string | string[] | null;
    options?: { headers?: Record<string, string> };
  }> = [];

  readyState = MockWebSocket.deferOpen ? 0 : MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closeCount = 0;
  sent: string[] = [];

  constructor(
    url: string,
    protocols?: string | string[] | null,
    options?: { headers?: Record<string, string> },
  ) {
    MockWebSocket.instances.push(this);
    MockWebSocket.connections.push({ url, protocols, options });
    queueMicrotask(() => {
      if (MockWebSocket.deferOpen) return;
      if (MockWebSocket.failOpen) this.onerror?.();
      else this.onopen?.();
    });
  }

  send(raw: string): void {
    this.sent.push(raw);
    const request = JSON.parse(raw) as { id?: number; method?: string };
    if (request.method === "initialize") {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: MockWebSocket.initializeResult }),
      }));
    }
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }
}

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  MockWebSocket.instances = [];
  MockWebSocket.connections = [];
  MockWebSocket.failOpen = false;
  MockWebSocket.deferOpen = false;
  routeApi.resolve.mockReset().mockImplementation(async profile => profile.baseUrl);
  routeApi.invalidate.mockReset();
  routeApi.selectPairing.mockReset().mockImplementation(async baseUrl => baseUrl);
  routeApi.normalize.mockReset().mockImplementation(value => value);
  peerApi.createSocket.mockReset();
  peerApi.alive.mockReset().mockReturnValue(true);
});

it("cancels a pending Web upgrade without aborting the browser handshake or sending initialization", async () => {
  vi.useFakeTimers();
  try {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket; MockWebSocket.deferOpen = true;
    const controller = new AbortController();
    const pending = GatewayRpcClient.connect(profile, server, undefined, "runtime", { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(socket.closeCount).toBe(0);
    expect(routeApi.invalidate).not.toHaveBeenCalled();
    socket.readyState = MockWebSocket.OPEN; socket.onopen?.();
    expect(socket.closeCount).toBe(1); expect(socket.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("bounds an abandoned Web handshake by the original connection deadline", async () => {
  vi.useFakeTimers();
  try {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket; MockWebSocket.deferOpen = true;
    const controller = new AbortController();
    const pending = GatewayRpcClient.connect(profile, server, undefined, "runtime", { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    controller.abort(); await pending;
    const socket = MockWebSocket.instances[0];
    await vi.advanceTimersByTimeAsync(12_000);
    expect(socket.closeCount).toBe(1); expect(socket.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("retains a socket whose close throws so its owner can retry cleanup", async () => {
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
  const client = await GatewayRpcClient.connect(profile, server);
  const socket = MockWebSocket.instances[0];
  const close = vi.fn().mockImplementationOnce(() => { throw new Error("close failed"); }).mockImplementation(() => { socket.readyState = 3; });
  socket.close = close;
  expect(() => client.close()).toThrow("close failed");
  expect(client.isTransportOpen()).toBe(false);
  client.close(); expect(close).toHaveBeenCalledTimes(2);
});

describe("GatewayRpcClient initialize", () => {
  it("保存 capabilities 并发送 initialized notification", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = {
      protocolVersion: "2026-07-27",
      sessionId: "engine-S",
      capabilities: { threadResume: true, experimental: { browserAttachments: true, threadPresenceReadV1: true, asyncUserQuestionsV1: true } },
    };

    const connect = GatewayRpcClient.connect;
    const client = await connect(profile, server);

    expect(client.supportsThreadResume()).toBe(true);
    expect(client.supportsExperimental("browserAttachments")).toBe(true);
    expect(client.supportsExperimental("threadPresenceReadV1")).toBe(true);
    expect(client.supportsExperimental("asyncUserQuestionsV1")).toBe(true);
    expect(client.supportsExperimental("workspaceBinaryRevisionV1")).toBe(false);
    expect(client.getAppServerId()).toBe("server-engine-S");
    expect(JSON.parse(MockWebSocket.instances[0].sent[0])).toMatchObject({
      method: "initialize", params: { capabilities: { experimental: { workspaceBinaryRevisionV1: true, threadTranscriptSnapshotV1: true, threadTranscriptObservationV1: true, threadPresenceReadV1: true, migrationHistoryWorkerStateClientV1: true, asyncUserQuestionsV1: true, integrationScopeV1: true, officeSettingsV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true, agentTurnConfigurationV1: true } } },
    });
    expect(JSON.parse(MockWebSocket.instances[0].sent[0]).params.clientInfo).toEqual({
      name: "kcoder-studio-mobile", version: "2.4.1",
    });
    // Mobile does not consume desktop transient stream scopes; keep the opt-in absent.
    expect(JSON.parse(MockWebSocket.instances[0].sent[0]).params.capabilities.experimental.threadStreamContextV1).toBeUndefined();
    for (const capability of ["studioWorkModesV1", "inlineWidgetsV1", "isolatedWidgetsV1", "mcpAppsV1"])
      expect(JSON.parse(MockWebSocket.instances[0].sent[0]).params.capabilities.experimental[capability]).toBeUndefined();
    expect(MockWebSocket.instances[0]?.sent.map(raw => JSON.parse(raw))).toContainEqual({
      jsonrpc: "2.0",
      method: "initialized",
    });
    client.close();
  });

  it("requests history ownership explicitly while preserving a missing or declined old-target capability", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    for (const capabilities of [{}, { experimental: { migrationHistoryWorkerStateV1: false } }, { experimental: { migrationHistoryWorkerStateV1: true } }]) {
      MockWebSocket.initializeResult = { protocolVersion: "2026-07-27", capabilities };
      const client = await GatewayRpcClient.connect(profile, server);
      const request = JSON.parse(MockWebSocket.instances.at(-1)!.sent[0]);
      expect(request.params.capabilities.experimental.migrationHistoryWorkerStateClientV1).toBe(true);
      expect(request.params.capabilities.experimental.asyncUserQuestionsV1).toBe(true);
      expect(request.params.capabilities.experimental.migrationHistoryWorkerStateV1).toBeUndefined();
      expect(client.supportsExperimental("migrationHistoryWorkerStateV1")).toBe(capabilities.experimental?.migrationHistoryWorkerStateV1 === true);
      client.close();
    }
  });

  it("保留完整 initialize capabilities，并在关闭后清理快照", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = {
      protocolVersion: "2026-07-27",
      capabilities: {
        approvals: true,
        questions: false,
        threadResume: true,
        experimental: { providerConfiguration: true, browserSessions: false },
      },
    };

    const client = await GatewayRpcClient.connect(profile, server);
    const capabilities = client.getCapabilities();
    expect(capabilities).toEqual({
      approvals: true,
      questions: false,
      threadResume: true,
      experimental: { providerConfiguration: true, browserSessions: false },
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities?.experimental)).toBe(true);

    client.close();
    expect(client.getCapabilities()).toBeUndefined();
  });

  it("缺少 initialize.sessionId 时不推测 app-server identity", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const client = await GatewayRpcClient.connect(profile, server);
    expect(client.getAppServerId()).toBeNull();
    client.close();
  });

  it("为同域不同 Gateway 路由分别保留 RPC 路径和令牌", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const gatewayA = {
      ...profile,
      id: "relay-a",
      baseUrl: "https://relay.example/g/a",
      accessToken: "access-a",
      rpcToken: "rpc-a",
    };
    const gatewayB = {
      ...profile,
      id: "relay-b",
      baseUrl: "https://relay.example/g/b",
      accessToken: "access-b",
      rpcToken: "rpc-b",
    };

    const clientA = await GatewayRpcClient.connect(gatewayA, server);
    const clientB = await GatewayRpcClient.connect(gatewayB, server);
    const connectionA = MockWebSocket.connections[0]!;
    const connectionB = MockWebSocket.connections[1]!;
    const urlA = new URL(connectionA.url);
    const urlB = new URL(connectionB.url);
    const authA =
      connectionA.options?.headers?.Authorization ??
      (Array.isArray(connectionA.protocols) ? connectionA.protocols[1] : undefined);
    const authB =
      connectionB.options?.headers?.Authorization ??
      (Array.isArray(connectionB.protocols) ? connectionB.protocols[1] : undefined);

    expect(urlA.pathname).toBe("/g/a/rpc");
    expect(urlB.pathname).toBe("/g/b/rpc");
    expect(urlA.searchParams.get("token")).toBe("rpc-a");
    expect(urlB.searchParams.get("token")).toBe("rpc-b");
    expect(["Bearer access-a", "kcoder-session.access-a"]).toContain(authA);
    expect(["Bearer access-b", "kcoder-session.access-b"]).toContain(authB);

    clientA.close();
    clientB.close();
  });

  it("协议不兼容时关闭已经打开的 socket", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "old" };

    await expect(GatewayRpcClient.connect(profile, server)).rejects.toThrow("协议不兼容");
    expect(MockWebSocket.instances[0]?.closeCount).toBe(1);
  });

  it("远端关闭后拒绝新请求且不遗留 pending timer", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const client = await GatewayRpcClient.connect(profile, server);
    MockWebSocket.instances[0]?.onclose?.();

    await expect(client.request("thread/list")).rejects.toThrow("RPC 连接已关闭");
    const pending = (client as unknown as { pending: Map<number, unknown> }).pending;
    expect(pending.size).toBe(0);
  });

  it("用 resolver 选出的完整 route 建立 RPC，但保留 canonical profile.baseUrl", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const gateway = { ...profile, baseUrl: "https://relay.example/g/tenant-a" };
    const selected = "https://192.168.1.30/g/tenant-a";
    routeApi.resolve.mockResolvedValueOnce(selected);

    const client = await GatewayRpcClient.connect(gateway, server);

    expect(routeApi.resolve).toHaveBeenCalledWith(gateway, { signal: undefined });
    expect(new URL(MockWebSocket.connections[0]!.url).pathname).toBe("/g/tenant-a/rpc");
    expect(new URL(MockWebSocket.connections[0]!.url).origin).toBe("wss://192.168.1.30");
    expect(gateway.baseUrl).toBe("https://relay.example/g/tenant-a");
    client.close();
  });

  it("invalidates a selected route when the WebSocket handshake cannot open", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.failOpen = true;
    const selected = "https://192.168.1.30/g/tenant-a";
    routeApi.resolve.mockResolvedValueOnce(selected);

    await expect(GatewayRpcClient.connect(profile, server)).rejects.toThrow("无法连接");

    expect(routeApi.invalidate).toHaveBeenCalledOnce();
    expect(routeApi.invalidate).toHaveBeenCalledWith(profile, selected);
  });

  it("builds an opaque peer RPC URL and creates a logical socket on the shared peer session", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const gateway = {
      ...profile,
      baseUrl: "https://relay.example/g/tenant-a",
      accessToken: "a".repeat(64),
    };
    const peerUrl = "kcoder-p2p://session-a";
    routeApi.resolve.mockResolvedValueOnce(peerUrl);
    peerApi.createSocket.mockImplementation((url, protocols, headers) =>
      new MockWebSocket(url, protocols, headers ? { headers } : undefined));

    const client = await GatewayRpcClient.connect(gateway, server);

    expect(peerApi.createSocket).toHaveBeenCalledOnce();
    expect(peerApi.createSocket.mock.calls[0]).toMatchObject([
      "kcoder-p2p://session-a/rpc?token=rpc&server=local&channel=runtime",
      ["kcoder-studio", `kcoder-session.${gateway.accessToken}`],
      undefined,
    ]);
    expect(MockWebSocket.connections[0]?.url).toContain("kcoder-p2p://session-a/rpc");
    expect(gateway.baseUrl).toBe("https://relay.example/g/tenant-a");
    client.close();
  });

  it("keeps a healthy peer session when a logical RPC socket closes and invalidates a failed one", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const peerUrl = "kcoder-p2p://session-close";
    routeApi.resolve.mockResolvedValue(peerUrl);
    peerApi.createSocket.mockImplementation((url, protocols, headers) =>
      new MockWebSocket(url, protocols, headers ? { headers } : undefined));

    const healthy = await GatewayRpcClient.connect(profile, server);
    MockWebSocket.instances.at(-1)?.onclose?.();
    expect(routeApi.invalidate).not.toHaveBeenCalled();

    peerApi.alive.mockReturnValue(false);
    const failed = await GatewayRpcClient.connect(profile, server);
    MockWebSocket.instances.at(-1)?.onclose?.();
    expect(routeApi.invalidate).toHaveBeenCalledWith(profile, peerUrl);
    healthy.close();
    failed.close();
  });

  it("只通知订阅者远端关闭，且关闭后的订阅立即得到状态", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const client = await GatewayRpcClient.connect(profile, server);
    const closed = vi.fn();
    const unsubscribe = client.subscribeClose(closed);

    MockWebSocket.instances[0]?.onclose?.();

    expect(closed).toHaveBeenCalledTimes(1);
    unsubscribe();
    const lateSubscriber = vi.fn();
    client.subscribeClose(lateSubscriber);
    expect(lateSubscriber).toHaveBeenCalledTimes(1);
  });

  it("owner主动关闭不会作为意外断线通知", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const client = await GatewayRpcClient.connect(profile, server);
    const closed = vi.fn();
    client.subscribeClose(closed);

    client.close();

    expect(closed).not.toHaveBeenCalled();
  });

  it("关闭 owner client 时立即拒绝并清理已发出的 pending RPC", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = { protocolVersion: "2026-07-27" };
    const client = await GatewayRpcClient.connect(profile, server);
    const pending = client.request("settings/write", { value: 1 }).catch((error: unknown) => error);
    const rpc = MockWebSocket.instances[0]?.sent
      .map((raw) => JSON.parse(raw) as { method?: string })
      .find((message) => message.method === "settings/write");
    expect(rpc).toBeDefined();

    client.close();
    expect(await pending).toMatchObject({ name: "MobileRpcError", delivery: "unknown" });
    const pendingRequests = (client as unknown as { pending: Map<number, unknown> }).pending;
    expect(pendingRequests.size).toBe(0);
  });
});

it('Gateway expiry remains ambiguous so acceptance receipts can recover', async () => {
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.initializeResult = { protocolVersion: '2026-07-27' };
  const client = await GatewayRpcClient.connect(profile, server);
  const result = client.request('turn/start', { threadId: 'owned' }).catch(error => error);
  const socket = MockWebSocket.instances.at(-1)!;
  const sent = JSON.parse(socket.sent.at(-1)!);
  socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32000,
    message: 'upstream outcome unknown', data: { kind: 'gatewayRequestExpired', outcome: 'unknown' } } }) });
  expect(await result).toMatchObject({ code: -1, reason: 'transport' });
  client.close();
});
