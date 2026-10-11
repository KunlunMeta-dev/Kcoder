// PRIVATE TEST CANDIDATE ONLY. Intended destination after product review:
// apps/kcoder-studio/mobile/src/runtime/task-runtime/.
// It exercises the real GatewayRpcClient and production catalog/pager/scheduler
// functions over a controlled WebSocket. It does not exercise live Gateway RTT,
// mounted React rendering, or a real mobile/browser transport.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRpcClient, type RpcMessage } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { PROFILE_INDEX_KEY } from "@/storage/profile-store";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime";
import {
  clearWorkspaceOptionsCache,
  listWorkspaceOptions,
  listWorkspaceThreadScopes,
  type WorkspaceDefaultReadConnection,
} from "./workspaces";
import { ThreadListPager, listThreads, mapThreadListDependencies } from "./threadDirectory";
import { threadListScopeKey } from "@/runtime/thread-list-projection";

type RequestFrame = RpcMessage & { params?: Record<string, unknown> };
type RequestHandler = (socket: ControlledWebSocket, frame: RequestFrame) => void;

class ControlledWebSocket {
  static readonly OPEN = 1;
  static readonly initializeResult = { protocolVersion: "2026-07-27" };
  static instances: ControlledWebSocket[] = [];
  static handleRequest: RequestHandler = (_socket, frame) => {
    throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
  };

  readonly sent: RequestFrame[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closeCount = 0;
  throwOnClose = false;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[] | null,
    readonly options?: { headers?: Record<string, string> },
  ) {
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = ControlledWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as RequestFrame;
    this.sent.push(frame);
    if (frame.method === "initialize") {
      queueMicrotask(() => this.reply(frame, ControlledWebSocket.initializeResult));
      return;
    }
    if (frame.method === "initialized") return;
    ControlledWebSocket.handleRequest(this, frame);
  }

  reply(frame: RequestFrame, result: unknown): void {
    if (typeof frame.id !== "number") throw new Error("test response requires a request id");
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) });
  }

  replyError(frame: RequestFrame, message: string): void {
    if (typeof frame.id !== "number") throw new Error("test error response requires a request id");
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message } }) });
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.();
    if (this.throwOnClose) throw new Error("controlled close failure");
  }
}

type PendingPage = {
  socket: ControlledWebSocket;
  frame: RequestFrame;
  workspacePath: string | undefined;
  cursor: string | undefined;
  replied: boolean;
  reply(result: unknown): void;
};

const originalWebSocket = globalThis.WebSocket;
const profile: GatewayProfile = {
  id: "handoff-review-gateway",
  label: "Review Gateway",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "synthetic-access",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "synthetic-rpc",
  authorizationGeneration: "review-generation-a",
  deviceId: "review-device-a",
};
const server: KCoderServer = {
  id: "review-target",
  label: "Review target",
  description: "synthetic test target",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace",
};

let profileFixture: ReturnType<typeof installBrowserProfileFixture>;

function installProfileIndex(value: GatewayProfile): void {
  profileFixture.localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify({
    profiles: [{
      id: value.id,
      baseUrl: value.baseUrl,
      authorizationGeneration: value.authorizationGeneration,
      deviceId: value.deviceId,
    }],
  }));
}

function requestMethods(socket: ControlledWebSocket): string[] {
  return socket.sent.flatMap((frame) => typeof frame.method === "string" ? [frame.method] : []);
}

function rawWorkspacePathIdentity(path: string | undefined): string {
  return JSON.stringify(path === undefined ? ["undefined"] : ["path", path]);
}

function replyCatalogAndEmptyThreads(
  socket: ControlledWebSocket,
  frame: RequestFrame,
  workspaces: unknown[] = [],
): void {
  if (frame.method === "runtime.workspaces.list") {
    socket.reply(frame, { items: workspaces });
    return;
  }
  if (frame.method === "runtime.worktrees.list") {
    socket.reply(frame, { items: [] });
    return;
  }
  if (frame.method === "thread/list") {
    socket.reply(frame, { threads: [] });
    return;
  }
  throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pageRequest(
  socket: ControlledWebSocket,
  frame: RequestFrame,
  workspacePath: string | undefined,
): PendingPage {
  let replied = false;
  return {
    socket,
    frame,
    workspacePath,
    cursor: typeof frame.params?.cursor === "string" ? frame.params.cursor : undefined,
    get replied() { return replied; },
    set replied(value: boolean) { replied = value; },
    reply(result: unknown) {
      if (replied) return;
      replied = true;
      socket.reply(frame, result);
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000 });
}

async function acquireDefaultRead(
  ownerProfile: GatewayProfile = profile,
  ownerServer: KCoderServer = server,
  connectOptions: { signal?: AbortSignal } = {},
): Promise<{ scopes: Awaited<ReturnType<typeof listWorkspaceThreadScopes>>; connection?: WorkspaceDefaultReadConnection }> {
  const scopes = await listWorkspaceThreadScopes(ownerProfile, ownerServer, [], connectOptions, {
    isCurrent: () => true,
    onOwned: () => {},
  });
  return { scopes, connection: scopes.defaultRead };
}

beforeEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  clearWorkspaceOptionsCache();
  ControlledWebSocket.instances = [];
  ControlledWebSocket.handleRequest = (socket, frame) => replyCatalogAndEmptyThreads(socket, frame);
  globalThis.WebSocket = ControlledWebSocket as unknown as typeof WebSocket;
  profileFixture = installBrowserProfileFixture([profile]);
});

afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  clearWorkspaceOptionsCache();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe("cold loader parallel ownership and TTL", () => {
  it("page completion defers source close until both catalog responses arrive", async () => {
    const catalogs: Array<() => void> = []; let body: Promise<unknown> | undefined;
    ControlledWebSocket.handleRequest = (socket, frame) => {
      if (frame.method?.startsWith("runtime.")) catalogs.push(() => socket.reply(frame, { items: [] }));
      else socket.reply(frame, { threads: [] });
    };
    const discover = listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned() {},
      onReady: connection => { body = connection.read(profile, server, () => true, client => listThreads(profile, server, 100, {}, { client })); } });
    await waitFor(() => catalogs.length === 2 && Boolean(body)); await body;
    const socket = ControlledWebSocket.instances[0]!;
    expect(socket.closeCount).toBe(0); expect(requestMethods(socket).filter(method => method === "thread/list")).toHaveLength(1);
    catalogs[0]!(); await Promise.resolve(); expect(socket.closeCount).toBe(0);
    catalogs[1]!(); await discover; expect(socket.closeCount).toBe(1);
  });
  it("catalog completion cannot close a first page whose body is still held", async () => {
    let release!: () => void; let body: Promise<unknown> | undefined;
    ControlledWebSocket.handleRequest = (socket, frame) => frame.method?.startsWith("runtime.") ? socket.reply(frame, { items: [] }) :
      release = () => socket.reply(frame, { threads: [] });
    const discover = listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned() {},
      onReady: connection => { body = connection.read(profile, server, () => true, client => listThreads(profile, server, 100, {}, { client })); } });
    await discover; await waitFor(() => Boolean(release));
    const socket = ControlledWebSocket.instances[0]!; expect(socket.closeCount).toBe(0);
    release(); await body; expect(socket.closeCount).toBe(1);
  });
  it("warm TTL lends no client; expiration admits exactly one new cold source", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await listWorkspaceOptions(profile, server);
    const onReady = vi.fn();
    await listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned() {}, onReady });
    expect(onReady).not.toHaveBeenCalled(); expect(ControlledWebSocket.instances).toHaveLength(1);
    now += 30_001;
    const owned: WorkspaceDefaultReadConnection[] = [];
    await listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned: connection => owned.push(connection), onReady });
    expect(onReady).toHaveBeenCalledOnce(); expect(ControlledWebSocket.instances).toHaveLength(2);
    owned[0]!.close(); expect(ControlledWebSocket.instances.every(socket => socket.closeCount === 1)).toBe(true);
  });
  it("failed catalog is not cached, even when its independent page completed", async () => {
    ControlledWebSocket.handleRequest = (socket, frame) => frame.method?.startsWith("runtime.") ? socket.replyError(frame, "directory refused") : socket.reply(frame, { threads: [] });
    let body: Promise<unknown> | undefined;
    const result = await listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned() {},
      onReady: connection => { body = connection.read(profile, server, () => true, client => listThreads(profile, server, 100, {}, { client })); } });
    await body; expect(result.error).toContain("directory refused");
    ControlledWebSocket.handleRequest = (socket, frame) => replyCatalogAndEmptyThreads(socket, frame);
    await listWorkspaceOptions(profile, server); expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(ControlledWebSocket.instances.every(socket => socket.closeCount === 1)).toBe(true);
  });
});
