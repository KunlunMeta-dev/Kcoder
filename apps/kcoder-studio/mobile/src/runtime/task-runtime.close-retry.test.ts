import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}), gatewaySessionExpired: vi.fn(async () => false) }));
import { GatewayRpcClient } from "@/gateway/rpc";
import { TaskRuntime } from "./task-runtime";
import { profile, server } from "./task-runtime/fixture.test-support";
const originalSocket = globalThis.WebSocket;
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closeAttempts = 0;
  readonly sentMethods: string[] = [];
  constructor() { Socket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.sentMethods.push(frame.method);
    if (frame.method === "initialize") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2026-07-27" } }) }));
  }
  close() {
    this.closeAttempts += 1;
    if (this.closeAttempts === 1) throw new Error("socket close failed once");
    this.readyState = 3;
  }
}
afterEach(() => { globalThis.WebSocket = originalSocket; Socket.instances = []; });

it("retries actual RPC socket closure while rejecting pending and new requests immediately", async () => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const client = await GatewayRpcClient.connect(profile, server);
  const pending = client.request("thread/read", { threadId: "held" });
  const pendingRejected = expect(pending).rejects.toThrow("RPC 连接已关闭");
  expect(() => client.close()).toThrow("socket close failed once");
  await pendingRejected;
  await expect(client.request("thread/read", { threadId: "new" })).rejects.toMatchObject({ message: "RPC 连接已关闭", delivery: "not-sent" });
  expect(Socket.instances[0].sentMethods.filter(method => method === "thread/read")).toHaveLength(1);
  const socket = Socket.instances[0]; expect(socket.readyState).toBe(1);
  client.close(); client.close();
  expect(socket.readyState).toBe(3); expect(socket.closeAttempts).toBe(2);
});

it("retries actual TaskRuntime closure until its retained RPC socket is released", async () => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const client = await GatewayRpcClient.connect(profile, server);
  const runtime = TaskRuntime.demo("closing-runtime");
  runtime.attachClient(client);
  expect(() => runtime.close()).toThrow("socket close failed once");
  expect(runtime.isDisposed()).toBe(true);
  expect(runtime.closeComplete).toBe(false);
  expect(runtime.client).toBe(client);
  expect(runtime.reconnectTimer).toBeNull();
  runtime.close(); runtime.close();
  expect(runtime.closeComplete).toBe(true); expect(runtime.client).toBeNull();
  expect(Socket.instances[0].closeAttempts).toBe(2);
});
