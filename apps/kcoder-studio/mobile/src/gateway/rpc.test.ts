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

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closeCount = 0;
  sent: string[] = [];

  constructor() {
    MockWebSocket.instances.push(this);
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
    expect(MockWebSocket.instances[0]?.sent.map(raw => JSON.parse(raw))).toContainEqual({
      jsonrpc: "2.0",
      method: "initialized",
    });
    client.close();
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

    await expect(client.request("thread/list")).rejects.toThrow("尚未就绪");
    const pending = (client as unknown as { pending: Map<number, unknown> }).pending;
    expect(pending.size).toBe(0);
  });
});
