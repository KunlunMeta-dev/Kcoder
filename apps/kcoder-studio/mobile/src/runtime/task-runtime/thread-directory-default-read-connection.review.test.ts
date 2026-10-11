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

describe("default workspace read connection handoff candidate", () => {
  it("uses one real GatewayRpcClient handshake for both catalog RPCs and all default cursor pages", async () => {
    installProfileIndex(profile);
    ControlledWebSocket.handleRequest = (socket, frame) => {
      if (frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") {
        replyCatalogAndEmptyThreads(socket, frame);
        return;
      }
      if (frame.method === "thread/list") {
        socket.reply(frame, frame.params?.cursor
          ? { threads: [{ id: "thread-old", status: "idle", createdAt: 1, updatedAt: 1 }] }
          : { threads: [{ id: "thread-new", status: "idle", createdAt: 2, updatedAt: 2 }], nextCursor: "default-page-2" });
        return;
      }
      throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
    };

    const captured: WorkspaceDefaultReadConnection[] = [];
    const resolved = await listWorkspaceThreadScopes(profile, server, [], {}, {
      isCurrent: () => true,
      onOwned: (connection) => captured.push(connection),
    });
    expect(resolved.defaultRead).toBe(captured[0]);
    expect(captured).toHaveLength(1);

    const result = await resolved.defaultRead!.read(profile, server, () => true, (client) =>
      listThreads(profile, server, 100, {}, { client, isCurrent: () => true }),
    );

    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-new", "thread-old"]);
    expect(ControlledWebSocket.instances).toHaveLength(1);
    const [socket] = ControlledWebSocket.instances;
    expect(requestMethods(socket!).filter((method) => method === "initialize")).toHaveLength(1);
    expect(requestMethods(socket!).filter((method) => method === "runtime.workspaces.list")).toHaveLength(1);
    expect(requestMethods(socket!).filter((method) => method === "runtime.worktrees.list")).toHaveLength(1);
    expect(requestMethods(socket!).filter((method) => method === "thread/list")).toHaveLength(2);
    expect(new URL(socket!.url).searchParams.get("workspace")).toBe("/workspace");
    expect(socket!.closeCount).toBe(1);
  });

  it("does not lend a connection from a warm directory cache hit", async () => {
    installProfileIndex(profile);
    await listWorkspaceOptions(profile, server);
    const owned = vi.fn();

    const resolved = await listWorkspaceThreadScopes(profile, server, [], {}, {
      isCurrent: () => true,
      onOwned: owned,
    });

    expect(resolved.error).toBeNull();
    expect(resolved.defaultRead).toBeUndefined();
    expect(owned).not.toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(requestMethods(ControlledWebSocket.instances[0]!).filter((method) => method === "initialize")).toHaveLength(1);
    expect(ControlledWebSocket.instances[0]!.closeCount).toBe(1);
  });

  it("keeps a foreign in-flight cache waiter from borrowing the loader owner's connection", async () => {
    installProfileIndex(profile);
    const pendingCatalog = new Map<string, { socket: ControlledWebSocket; frame: RequestFrame }>();
    ControlledWebSocket.handleRequest = (socket, frame) => {
      if (frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") {
        pendingCatalog.set(frame.method, { socket, frame });
        return;
      }
      throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
    };
    const firstOwned = vi.fn();
    const secondOwned = vi.fn();
    const firstPromise = listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned: firstOwned });
    await waitFor(() => pendingCatalog.size === 2);
    const secondPromise = listWorkspaceThreadScopes(profile, server, [], {}, { isCurrent: () => true, onOwned: secondOwned });

    for (const pending of pendingCatalog.values()) pending.socket.reply(pending.frame, { items: [] });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.defaultRead).toBeDefined();
    expect(second.defaultRead).toBeUndefined();
    expect(firstOwned).toHaveBeenCalledTimes(1);
    expect(secondOwned).not.toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(1);
    first.defaultRead!.close();
    expect(ControlledWebSocket.instances[0]!.closeCount).toBe(1);
  });

  it("closes a transferred lease on its owner's cancellation while leaving another cache waiter alive", async () => {
    installProfileIndex(profile);
    const pendingCatalog = new Map<string, { socket: ControlledWebSocket; frame: RequestFrame }>();
    ControlledWebSocket.handleRequest = (socket, frame) => {
      if (frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") {
        pendingCatalog.set(frame.method, { socket, frame });
        return;
      }
      throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
    };
    const ownerAbort = new AbortController();
    const otherWaiterAbort = new AbortController();
    const transferred: WorkspaceDefaultReadConnection[] = [];
    const otherOwned = vi.fn();
    const ownerPromise = listWorkspaceThreadScopes(profile, server, [], { signal: ownerAbort.signal }, {
      isCurrent: () => true,
      onOwned: (connection) => {
        transferred.push(connection);
        ownerAbort.abort();
      },
    });
    await waitFor(() => pendingCatalog.size === 2);
    const otherPromise = listWorkspaceThreadScopes(profile, server, [], { signal: otherWaiterAbort.signal }, {
      isCurrent: () => true,
      onOwned: otherOwned,
    });

    for (const pending of pendingCatalog.values()) pending.socket.reply(pending.frame, { items: [] });
    const [ownerResult, otherResult] = await Promise.all([ownerPromise, otherPromise]);

    expect(ownerResult.error).toBe("读取已取消");
    expect(ownerResult.defaultRead).toBeUndefined();
    expect(transferred).toHaveLength(1);
    expect(otherResult.error).toBeNull();
    expect(otherResult.defaultRead).toBeUndefined();
    expect(otherOwned).not.toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(ControlledWebSocket.instances[0]!.closeCount).toBe(1);
    expect(requestMethods(ControlledWebSocket.instances[0]!).filter((method) => method === "thread/list")).toHaveLength(0);
  });

  it("starts extra workspace pages while a two-page default read is held, with four jobs and clients active", async () => {
    installProfileIndex(profile);
    const pageRequests: PendingPage[] = [];
    ControlledWebSocket.handleRequest = (socket, frame) => {
      if (frame.method === "runtime.workspaces.list") {
        socket.reply(frame, { items: [
          { workspacePath: "/workspace/extra-a", label: "A" },
          { workspacePath: "/workspace/extra-b", label: "B" },
          { workspacePath: "/workspace/extra-c", label: "C" },
        ] });
        return;
      }
      if (frame.method === "runtime.worktrees.list") {
        socket.reply(frame, { items: [] });
        return;
      }
      if (frame.method === "thread/list") {
        const workspacePath = new URL(socket.url).searchParams.get("workspace") ?? undefined;
        pageRequests.push(pageRequest(socket, frame, workspacePath));
        return;
      }
      throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
    };

    const controller = new AbortController();
    const owned: WorkspaceDefaultReadConnection[] = [];
    let activeReads = 0;
    let peakReads = 0;
    const onDiscovered = vi.fn();
    const operation = mapThreadListDependencies(
      [server],
      async (target) => ({
        target,
        resolved: await listWorkspaceThreadScopes(profile, target, [], { signal: controller.signal }, {
          isCurrent: () => !controller.signal.aborted,
          onOwned: (connection) => owned.push(connection),
        }),
      }),
      ({ target, resolved }) => resolved.servers.map((workspaceServer) => ({
        workspaceServer,
        defaultRead: workspaceServer.workspacePath === target.workspacePath ? resolved.defaultRead : undefined,
      })),
      async (scope) => {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        try {
          if (scope.defaultRead) {
            return await scope.defaultRead.read(profile, scope.workspaceServer, () => !controller.signal.aborted, (client) =>
              listThreads(profile, scope.workspaceServer, 100, {}, { client, isCurrent: () => !controller.signal.aborted, signal: controller.signal }),
            );
          }
          return await listThreads(profile, scope.workspaceServer, 100, {}, { isCurrent: () => !controller.signal.aborted, signal: controller.signal });
        } finally {
          activeReads -= 1;
        }
      },
      {
        isCurrent: () => !controller.signal.aborted,
        readFirstInDiscovery: (scope) => Boolean(scope.defaultRead),
        onDiscovered,
      },
    );

    try {
      await waitFor(() => pageRequests.length === 4);
      expect(onDiscovered).toHaveBeenCalledTimes(1);
      expect(activeReads).toBe(4);
      expect(peakReads).toBe(4);
      expect(ControlledWebSocket.instances).toHaveLength(4);
      expect(ControlledWebSocket.instances.filter((socket) => socket.closeCount === 0)).toHaveLength(4);
      const defaultFirst = pageRequests.find((page) => page.workspacePath === "/workspace" && page.cursor === undefined)!;
      expect(defaultFirst.replied).toBe(false);
      expect(pageRequests.filter((page) => page.workspacePath?.startsWith("/workspace/extra-")).map((page) => page.workspacePath).sort()).toEqual([
        "/workspace/extra-a", "/workspace/extra-b", "/workspace/extra-c",
      ]);

      defaultFirst.reply({ threads: [{ id: "default-1", status: "idle", createdAt: 1, updatedAt: 2 }], nextCursor: "default-page-2" });
      await waitFor(() => pageRequests.some((page) => page.workspacePath === "/workspace" && page.cursor === "default-page-2"));
      const defaultSecond = pageRequests.find((page) => page.workspacePath === "/workspace" && page.cursor === "default-page-2")!;
      expect(defaultSecond.socket).toBe(defaultFirst.socket);
      expect(activeReads).toBe(4);

      defaultSecond.reply({ threads: [{ id: "default-2", status: "idle", createdAt: 2, updatedAt: 1 }] });
      for (const page of pageRequests) if (page !== defaultFirst && page !== defaultSecond) page.reply({ threads: [] });
      const completed = await operation;
      expect(completed.discoveries).toHaveLength(1);
      expect(completed.results).toHaveLength(4);
      expect(activeReads).toBe(0);
      expect(owned).toHaveLength(1);
      expect(ControlledWebSocket.instances.every((socket) => requestMethods(socket).filter((method) => method === "initialize").length === 1)).toBe(true);
      expect(ControlledWebSocket.instances.every((socket) => socket.closeCount === 1)).toBe(true);
    } finally {
      controller.abort();
      for (const page of pageRequests) page.reply({ threads: [] });
      await operation.catch(() => {});
      for (const connection of owned) connection.close();
    }
  });

  it("rejects undefined/empty and normalized-path aliases plus auth/device/role changes before using the lease", async () => {
    const roleMember: KCoderServer = {
      ...server,
      accountIdentity: { principalId: "review-principal", username: "review-user", role: "member" },
    };
    const cases: Array<{
      name: string;
      ownerProfile: GatewayProfile;
      ownerServer: KCoderServer;
      readProfile: GatewayProfile;
      readServer: KCoderServer;
    }> = [
      { name: "undefined to empty", ownerProfile: profile, ownerServer: { ...server, workspacePath: undefined }, readProfile: profile, readServer: { ...server, workspacePath: "" } },
      { name: "trailing slash alias", ownerProfile: profile, ownerServer: { ...server, workspacePath: "/workspace/" }, readProfile: profile, readServer: { ...server, workspacePath: "/workspace" } },
      { name: "authorization generation", ownerProfile: profile, ownerServer: server, readProfile: { ...profile, authorizationGeneration: "review-generation-b" }, readServer: server },
      { name: "device identity", ownerProfile: profile, ownerServer: server, readProfile: { ...profile, deviceId: "review-device-b" }, readServer: server },
      { name: "server account role", ownerProfile: profile, ownerServer: roleMember, readProfile: profile, readServer: { ...roleMember, accountIdentity: { ...roleMember.accountIdentity!, role: "admin" } } },
    ];

    for (const testCase of cases) {
      taskRuntimeTestHelpers.resetConnector();
      clearWorkspaceOptionsCache();
      ControlledWebSocket.instances = [];
      installProfileIndex(testCase.ownerProfile);
      const loaded = await acquireDefaultRead(testCase.ownerProfile, testCase.ownerServer);
      expect(loaded.connection, testCase.name).toBeDefined();
      const body = vi.fn(async (_client: GatewayRpcClient) => "must not execute");
      await expect(loaded.connection!.read(testCase.readProfile, testCase.readServer, () => true, body), testCase.name).rejects.toThrow("默认目录读取归属已变化");
      expect(body, testCase.name).not.toHaveBeenCalled();
      expect(ControlledWebSocket.instances).toHaveLength(1);
      expect(requestMethods(ControlledWebSocket.instances[0]!).filter((method) => method === "thread/list")).toHaveLength(0);
      expect(ControlledWebSocket.instances[0]!.closeCount).toBe(1);
    }
  });

  it("stops pagination when auth, device, role, or exact raw workspacePath changes during a held page", async () => {
    const roleOwner: KCoderServer = {
      ...server,
      accountIdentity: { principalId: "review-principal", username: "review-user", role: "member" },
    };
    const cases: Array<{
      name: string;
      ownerServer: KCoderServer;
      mutateAfterSend(currentServer: { value: KCoderServer }): void;
    }> = [
      { name: "authorization generation", ownerServer: server, mutateAfterSend: () => installProfileIndex({ ...profile, authorizationGeneration: "review-generation-b" }) },
      { name: "device identity", ownerServer: server, mutateAfterSend: () => installProfileIndex({ ...profile, deviceId: "review-device-b" }) },
      { name: "account role", ownerServer: roleOwner, mutateAfterSend: (current) => { current.value = { ...roleOwner, accountIdentity: { ...roleOwner.accountIdentity!, role: "admin" } }; } },
      { name: "raw default path undefined to empty", ownerServer: { ...server, workspacePath: undefined }, mutateAfterSend: (current) => { current.value = { ...current.value, workspacePath: "" }; } },
    ];

    for (const testCase of cases) {
      taskRuntimeTestHelpers.resetConnector();
      clearWorkspaceOptionsCache();
      ControlledWebSocket.instances = [];
      installProfileIndex(profile);
      const pendingPages: PendingPage[] = [];
      ControlledWebSocket.handleRequest = (socket, frame) => {
        if (frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") {
          replyCatalogAndEmptyThreads(socket, frame);
          return;
        }
        if (frame.method === "thread/list") {
          pendingPages.push(pageRequest(socket, frame, new URL(socket.url).searchParams.get("workspace") ?? undefined));
          return;
        }
        throw new Error(`unexpected test RPC: ${frame.method ?? "<notification>"}`);
      };

      const currentServer = { value: testCase.ownerServer };
      const ownerScopeKey = threadListScopeKey(profile, testCase.ownerServer);
      const ownerRawPath = rawWorkspacePathIdentity(testCase.ownerServer.workspacePath);
      const isCurrent = () => threadListScopeKey(profile, currentServer.value) === ownerScopeKey
        && rawWorkspacePathIdentity(currentServer.value.workspacePath) === ownerRawPath;
      const loaded = await acquireDefaultRead(profile, testCase.ownerServer);
      expect(loaded.connection, testCase.name).toBeDefined();
      const read = loaded.connection!.read(profile, testCase.ownerServer, isCurrent, (client) =>
        listThreads(profile, testCase.ownerServer, 100, {}, { client, isCurrent }),
      );
      await waitFor(() => pendingPages.length === 1);
      testCase.mutateAfterSend(currentServer);
      pendingPages[0]!.reply({ threads: [{ id: "stale-first-page", status: "idle", createdAt: 1, updatedAt: 1 }], nextCursor: "must-not-run" });

      await expect(read, testCase.name).rejects.toThrow();
      expect(pendingPages, testCase.name).toHaveLength(1);
      expect(ControlledWebSocket.instances[0]!.closeCount, testCase.name).toBe(1);
    }
  });

  it("contains close failures without masking either a successful page or the original RPC error", async () => {
    installProfileIndex(profile);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    ControlledWebSocket.handleRequest = (socket, frame) => replyCatalogAndEmptyThreads(socket, frame);
    const successful = await acquireDefaultRead(profile, { ...server, id: "close-success" });
    const successSocket = ControlledWebSocket.instances[0]!;
    successSocket.throwOnClose = true;
    const result = await successful.connection!.read(profile, { ...server, id: "close-success" }, () => true, (client) =>
      listThreads(profile, { ...server, id: "close-success" }, 100, {}, { client, isCurrent: () => true }),
    );
    expect(result.threads).toEqual([]);
    expect(successSocket.closeCount).toBe(1);
    expect(warning).toHaveBeenCalledWith("workspace_directory_cleanup_pending");

    taskRuntimeTestHelpers.resetConnector();
    clearWorkspaceOptionsCache();
    ControlledWebSocket.instances = [];
    ControlledWebSocket.handleRequest = (socket, frame) => {
      if (frame.method === "thread/list") {
        socket.replyError(frame, "primary thread/list failure");
        return;
      }
      replyCatalogAndEmptyThreads(socket, frame);
    };
    const failed = await acquireDefaultRead(profile, { ...server, id: "close-error" });
    const errorSocket = ControlledWebSocket.instances[0]!;
    errorSocket.throwOnClose = true;
    await expect(failed.connection!.read(profile, { ...server, id: "close-error" }, () => true, (client) =>
      listThreads(profile, { ...server, id: "close-error" }, 100, {}, { client, isCurrent: () => true }),
    )).rejects.toThrow("primary thread/list failure");
    expect(errorSocket.closeCount).toBe(1);
    expect(warning).toHaveBeenCalledWith("workspace_directory_cleanup_pending");
  });
});

// New private regression: exercise the production lease and pager, not a mirror.
it("claimed lazy pager remains alive when a competing read fails its single-use claim", async () => {
  installProfileIndex(profile);
  ControlledWebSocket.handleRequest = (socket, frame) => {
    if (frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") {
      replyCatalogAndEmptyThreads(socket, frame); return;
    }
    if (frame.method === "thread/list") {
      socket.reply(frame, frame.params?.cursor
        ? { threads: [{ id: "later", status: "idle", createdAt: 1, updatedAt: 1 }] }
        : { threads: [{ id: "first", status: "idle", createdAt: 2, updatedAt: 2 }], nextCursor: "keep-original-socket" });
      return;
    }
    throw new Error("unexpected RPC");
  };
  const { connection } = await acquireDefaultRead();
  expect(connection).toBeDefined();
  const client = connection!.claim(profile, server, () => true);
  const pager = new ThreadListPager(profile, server, {}, "foreground", {
    client, isCurrent: () => true, releaseClient: () => connection!.close(),
  });
  const body = vi.fn(async () => "must-not-run");
  const socket = ControlledWebSocket.instances[0]!;
  try {
    const first = await pager.page(undefined, 50);
    expect(first.nextCursor).toBe("keep-original-socket");
    await expect(connection!.read(profile, server, () => true, body)).rejects.toThrow("默认目录读取连接已使用");
    expect(body).not.toHaveBeenCalled();
    expect(socket.closeCount).toBe(0);
    expect(ControlledWebSocket.instances).toHaveLength(1);
    const later = await pager.page(first.nextCursor, 50);
    expect(later.threads.map(row => row.id)).toEqual(["first", "later"]);
    expect(requestMethods(socket).filter(method => method === "initialize")).toHaveLength(1);
    expect(requestMethods(socket).filter(method => method === "thread/list")).toHaveLength(2);
  } finally { pager.close(); }
  expect(socket.closeCount).toBe(1);
});

it("a first read failing its owner check still cleans up its own unclaimed connection", async () => {
  const { connection } = await acquireDefaultRead();
  const body = vi.fn(async () => "must-not-run");
  await expect(connection!.read(profile, server, () => false, body)).rejects.toThrow("默认目录读取归属已变化");
  expect(body).not.toHaveBeenCalled();
  expect(ControlledWebSocket.instances[0]!.closeCount).toBe(1);
});
it("a read that successfully claims still closes on its original callback failure", async () => {
  const { connection } = await acquireDefaultRead();
  const error = new Error("original-reader-error");
  await expect(connection!.read(profile, server, () => true, async () => { throw error; })).rejects.toBe(error);
  expect(ControlledWebSocket.instances[0]!.closeCount).toBe(1);
});

it("an in-flight first read survives a concurrent rejected second read and completes on the same socket", async () => {
  installProfileIndex(profile);
  let held: PendingPage | undefined;
  ControlledWebSocket.handleRequest = (socket, frame) => {
    if (frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") {
      replyCatalogAndEmptyThreads(socket, frame); return;
    }
    if (frame.method === "thread/list") { held = pageRequest(socket, frame, server.workspacePath); return; }
    throw new Error("unexpected RPC");
  };
  const { connection } = await acquireDefaultRead();
  const socket = ControlledWebSocket.instances[0]!;
  const first = connection!.read(profile, server, () => true, client =>
    listThreads(profile, server, 50, {}, { client, isCurrent: () => true }));
  const secondBody = vi.fn(async () => "must-not-run");
  try {
    await waitFor(() => held !== undefined);
    await expect(connection!.read(profile, server, () => true, secondBody)).rejects.toThrow("默认目录读取连接已使用");
    expect(secondBody).not.toHaveBeenCalled();
    expect(socket.closeCount).toBe(0);
    expect(held!.socket).toBe(socket);
    expect(requestMethods(socket).filter(method => method === "thread/list")).toHaveLength(1);
    held!.reply({ threads: [{ id: "first-read-completed", status: "idle", createdAt: 1, updatedAt: 1 }] });
    await expect(first).resolves.toMatchObject({ threads: [{ id: "first-read-completed" }] });
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(requestMethods(socket).filter(method => method === "initialize")).toHaveLength(1);
    expect(socket.closeCount).toBe(1);
  } finally {
    connection!.close();
    await first.catch(() => undefined);
  }
});
