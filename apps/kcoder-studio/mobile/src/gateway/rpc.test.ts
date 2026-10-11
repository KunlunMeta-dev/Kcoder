import { afterEach, describe, expect, it } from "vitest";
import { GatewayRpcClient } from "./rpc";
import type { GatewayProfile, KCoderServer } from "./types";

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

  static connections: Array<{
    url: string;
    protocols?: string | string[] | null;
    options?: { headers?: Record<string, string> };
  }> = [];

  readyState = MockWebSocket.OPEN;
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
    queueMicrotask(() => this.onopen?.());
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
});

describe("GatewayRpcClient initialize", () => {
  it("保存 capabilities 并发送 initialized notification", async () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.initializeResult = {
      protocolVersion: "2026-07-27",
      capabilities: { threadResume: true, experimental: { browserAttachments: true } },
    };

    const connect = GatewayRpcClient.connect;
    const client = await connect(profile, server);

    expect(client.supportsThreadResume()).toBe(true);
    expect(client.supportsExperimental("browserAttachments")).toBe(true);
    expect(client.supportsExperimental("workspaceBinaryRevisionV1")).toBe(false);
    expect(JSON.parse(MockWebSocket.instances[0].sent[0])).toMatchObject({
      method: "initialize", params: { capabilities: { experimental: { workspaceBinaryRevisionV1: true } } },
    });
    expect(MockWebSocket.instances[0]?.sent.map(raw => JSON.parse(raw))).toContainEqual({
      jsonrpc: "2.0",
      method: "initialized",
    });
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
