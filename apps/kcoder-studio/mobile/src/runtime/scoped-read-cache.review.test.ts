import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { ScopedReadCache } from "./scoped-read-cache";
import { threadListScopeKey } from "./thread-list-projection";
import { clearModelCache, listModels } from "./task-runtime/modelCatalog";
import { clearWorkspaceOptionsCache, listWorkspaceOptions } from "./task-runtime/workspaces";
import { taskRuntimeTestHelpers } from "./task-runtime/connectionFactory";

const profile: GatewayProfile = {
  id: "mobile-review-gateway",
  label: "review",
  baseUrl: "https://gateway.review",
  accessToken: "access",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "rpc",
  authorizationGeneration: "mobile-session-family-1",
};

const server: KCoderServer = {
  id: "secure-target",
  label: "secure target",
  description: "review fixture",
  runtime: "kcoder",
  transport: "ssh",
  host: "target.review",
  user: "operator",
  port: 22,
  workspacePath: "/workspace",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class PendingRpcSocket {
  static OPEN = 1;
  static initializeResult: unknown = { protocolVersion: "2026-07-27" };
  static instances: PendingRpcSocket[] = [];

  readyState = PendingRpcSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closeCount = 0;
  sent: Array<{ id?: number; method?: string }> = [];

  constructor(_url: string, _protocols?: unknown, _options?: unknown) {
    PendingRpcSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as { id?: number; method?: string };
    this.sent.push(request);
    if (request.method === "initialize") {
      queueMicrotask(() => this.receive({ id: request.id, result: PendingRpcSocket.initializeResult }));
    }
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", ...value as object }) });
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }
}

const originalWebSocket = globalThis.WebSocket;

async function waitForPendingMethod(socketIndex: number, methods: string[]) {
  await vi.waitFor(() => {
    const socket = PendingRpcSocket.instances[socketIndex];
    expect(socket).toBeDefined();
    for (const method of methods) {
      expect(socket?.sent.some((request) => request.method === method)).toBe(true);
    }
  });
  return PendingRpcSocket.instances[socketIndex]!;
}

afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  globalThis.WebSocket = originalWebSocket;
  PendingRpcSocket.instances = [];
});

it("clear rejects existing waiters even when a loader ignores abort and resolves later", async () => {
  const cache = new ScopedReadCache<string>();
  const result = deferred<string>();
  let ownedSignal!: AbortSignal;
  const read = cache.get("scope", (signal) => {
    ownedSignal = signal;
    return result.promise;
  });
  const rejected = expect(read).rejects.toThrow("读取已取消");
  await vi.waitFor(() => expect(ownedSignal).toBeDefined());

  cache.clear();
  expect(ownedSignal.aborted).toBe(true);
  await rejected;

  result.resolve("stale result");
  await Promise.resolve();
  expect(await cache.get("scope", async () => "fresh result")).toBe("fresh result");
  cache.clear();
});

it("rejects a cleared caller even when its loader ignores cancellation and returns late", async () => {
  const cache = new ScopedReadCache<string>();
  const result = deferred<string>();
  let ownedSignal!: AbortSignal;
  const read = cache.get("scope", (signal) => {
    ownedSignal = signal;
    return result.promise;
  });
  const rejected = expect(read).rejects.toThrow("读取已取消");
  await vi.waitFor(() => expect(ownedSignal).toBeDefined());

  cache.clear();
  expect(ownedSignal.aborted).toBe(true);
  result.resolve("stale result");
  await rejected;
  expect(await cache.get("scope", async () => "fresh result")).toBe("fresh result");
  cache.clear();
});

it("separates reads when the Gateway profile stays fixed but the target principal changes", async () => {
  const cache = new ScopedReadCache<string>();
  const alice = { ...server, accountIdentity: { principalId: "principal-a", username: "Alice", role: "user" } };
  const bob = { ...server, accountIdentity: { principalId: "principal-b", username: "Bob", role: "user" } };
  const keyAlice = threadListScopeKey(profile, alice);
  const keyBob = threadListScopeKey(profile, bob);
  expect(keyAlice).not.toBe(keyBob);
  expect(await cache.get(keyAlice, async () => "Alice projection")).toBe("Alice projection");
  expect(await cache.get(keyBob, async () => "Bob projection")).toBe("Bob projection");
  cache.clear();
});

it("closes a connected Gateway RPC and rejects a model read when its cache scope is cleared", async () => {
  globalThis.WebSocket = PendingRpcSocket as unknown as typeof WebSocket;
  const read = listModels(profile, server);
  const rejected = expect(read).rejects.toThrow("读取已取消");
  const socket = await waitForPendingMethod(0, ["runtime.models.list"]);
  const request = socket.sent.find((value) => value.method === "runtime.models.list");

  clearModelCache(profile.id);
  await rejected;

  expect(socket.closeCount).toBe(1);
  socket.receive({ id: request?.id, result: { data: [{ id: "stale", model: "stale" }] } });
  expect(socket.closeCount).toBe(1);
});

it("closes both in-flight workspace option RPCs when the caller cancels after connect", async () => {
  globalThis.WebSocket = PendingRpcSocket as unknown as typeof WebSocket;
  const controller = new AbortController();
  const read = listWorkspaceOptions(profile, server, { signal: controller.signal });
  const rejected = expect(read).rejects.toThrow("读取已取消");
  const socket = await waitForPendingMethod(0, [
    "runtime.workspaces.list",
    "runtime.worktrees.list",
  ]);

  controller.abort();
  await rejected;

  expect(socket.closeCount).toBe(1);
  expect(socket.sent.filter((request) => request.method?.startsWith("runtime.")).map((request) => request.method)).toEqual([
    "runtime.workspaces.list",
    "runtime.worktrees.list",
  ]);
  clearWorkspaceOptionsCache(profile.id);
});
