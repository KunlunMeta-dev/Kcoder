import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
// Independent deletion boundary review: server ACK gates local removal.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const cache = vi.hoisted(() => ({ invalidateThread: vi.fn(async () => {}) }));
vi.mock("@/storage/session-transcript-cache", () => ({ sessionTranscriptCache: {
  capture: async (scope: unknown, isCurrent: () => boolean) => { if (!isCurrent()) throw new Error("stale owner"); return { scope, isCurrent }; },
  invalidateThread: cache.invalidateThread,
} }));
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), failWrites: false, failConfirmedWrites: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    if (storage.failWrites) throw new Error("storage unavailable");
    const parsed = JSON.parse(value);
    if (storage.failConfirmedWrites && Array.isArray(parsed) && parsed.some((ticket: { confirmed?: boolean }) => ticket.confirmed)) throw new Error("confirmation storage unavailable");
    storage.values.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => { storage.values.delete(key); }),
  multiRemove: vi.fn(async (keys: string[]) => { for (const key of keys) storage.values.delete(key); }),
} }));
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import {
  deleteStoredThread,
  subscribeThreadMutations,
  taskRuntimeTestHelpers,
  TaskRuntime,
  taskRuntimeRegistry,
  type ThreadMutationEvent,
} from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { installThreadDeletionCleanupAuthorityResolver, isSessionTranscriptDeletionPending, retryThreadDeletionCleanup, threadDeletionCleanupKey, ThreadDeletionCleanupConfirmationPendingError } from "@/storage/thread-deletion-cleanup";
import { loadWorkspaceState, saveWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";

let uninstallAuthority: (() => void) | undefined;
beforeEach(() => {
  cache.invalidateThread.mockClear();
  uninstallAuthority = installThreadDeletionCleanupAuthorityResolver((profileId, serverId) =>
    profileId === profile.id && serverId === server.id ? workspaceStateAuthorizationScope(profile, server) : null);
});
afterEach(() => { uninstallAuthority?.(); uninstallAuthority = undefined; vi.restoreAllMocks(); taskRuntimeTestHelpers.resetConnector(); storage.values.clear(); storage.failWrites = false; storage.failConfirmedWrites = false; });

it("waits for delete ACK before publishing removal or attempting local cleanup", async () => {
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
  const methods: string[] = [];
  const primary = {
    close: vi.fn(),
    request: vi.fn(async (method: string, _params: JsonRecord = {}) => {
      methods.push(method);
      if (method === "thread/read") return { messages: [] };
      if (method === "thread/delete") await acknowledgement;
      return {};
    }),
  };
  const cleanupClient = { close: vi.fn(), request: vi.fn(async (method: string, params: { paths?: string[] } = {}) =>
    method === "gateway/attachments/discardRetained" ? { cleared: params.paths ?? [], pending: [] } : {}) };
  const registry = { close: vi.fn(), request: vi.fn(async () => ({})) };
  taskRuntimeTestHelpers.setConnector(vi.fn()
    .mockResolvedValueOnce(primary as never)
    .mockResolvedValueOnce(cleanupClient as never)
    .mockResolvedValueOnce(registry as never) as never);
  const events: ThreadMutationEvent[] = [];
  const unsubscribe = subscribeThreadMutations(event => events.push(event));
  const deleting = deleteStoredThread(profile, server, "thread-review", "/workspace", ["attachment-review"]);
  await vi.waitFor(() => expect(methods).toContain("thread/delete"));

  expect(events).toEqual([]);
  expect(cache.invalidateThread).not.toHaveBeenCalled();
  expect(methods).not.toContain("attachment/delete");
  expect(registry.request).not.toHaveBeenCalled();

  acknowledge();
  await deleting;
  expect(events).toEqual([expect.objectContaining({ threadId: "thread-review", mutation: { kind: "delete" } })]);
  await vi.waitFor(() => expect(registry.request).toHaveBeenCalledWith("runtime.worktrees.conversations.remove", {
    deviceId: server.id, path: "/workspace", taskId: "thread-review",
  }));
  expect(cleanupClient.close).toHaveBeenCalledOnce();
  expect(cache.invalidateThread).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ threadId: "thread-review", cwd: "/workspace" }) }));
  expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id)) ?? "[]")).toEqual([]);
  expect(cleanupClient.request).not.toHaveBeenCalledWith("attachment/delete", expect.anything());
  expect(cleanupClient.request).not.toHaveBeenCalledWith("thread/delete", expect.anything());
  expect(primary.close).toHaveBeenCalledOnce();
  unsubscribe();
});

it("deletes a previously opened idle thread through its registered owner and still waits for ACK", async () => {
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
  const owner = new FakeClient([]);
  const originalRequest = owner.request.bind(owner);
  const ownerRequest = vi.spyOn(owner, "request").mockImplementation(async (method, params) => {
    if (method === "thread/delete") { await acknowledgement; return { deleted: true }; }
    return originalRequest(method, params);
  });
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => owner as never));
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
  taskRuntimeRegistry.put(profile.id, server.id, runtime);
  const stranger = { close: vi.fn(), request: vi.fn(async (method: string) => {
    if (method === "thread/delete") throw new MobileRpcError("thread is already active in another Gateway client", -32023, "remote", "unknown");
    return {};
  }) };
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => stranger as never));
  const events: ThreadMutationEvent[] = [];
  const unsubscribe = subscribeThreadMutations(event => events.push(event));
  try {
    const deleting = deleteStoredThread(profile, server, "thread-1", "/workspace");
    const outcome = deleting.then(() => null, error => error);
    await vi.waitFor(() => expect(ownerRequest).toHaveBeenCalledWith("thread/delete", { threadId: "thread-1" }, undefined));
    expect(events).toEqual([]);
    expect(owner.closed).toBe(false);
    acknowledge();
    expect(await outcome).toBeNull();
    expect(events.filter(event => event.mutation.kind === "delete")).toHaveLength(1);
    expect(stranger.request).not.toHaveBeenCalledWith("thread/delete", expect.anything());
  } finally {
    acknowledge(); unsubscribe();
    taskRuntimeRegistry.remove(profile.id, server.id, "thread-1");
  }
});

it.each([
  ["Gateway URL", { ...profile, baseUrl: "http://other-gateway.invalid" }, server, "/workspace"],
  ["authorization mode", { ...profile, authMode: "device" }, server, "/workspace"],
  ["authorization generation", { ...profile, authorizationGeneration: "renewed" }, server, "/workspace"],
  ["device", { ...profile, deviceId: "other-device" }, server, "/workspace"],
  ["server configuration", profile, { ...server, host: "other-target.invalid" }, "/workspace"],
  ["account", profile, { ...server, accountIdentity: { principalId: "other-account", username: "other-user", role: "user" } }, "/workspace"],
  ["observation target identity", profile, { ...server, observationTargetIdentity: "a".repeat(64) }, "/workspace"],
  ["workspace", profile, server, "/other-workspace"],
] as const)("does not reuse a cached owner across a changed %s", async (_label, targetProfile, targetServer, cwd) => {
  const owner = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => owner as never));
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
  taskRuntimeRegistry.put(profile.id, server.id, runtime);
  try {
    expect(taskRuntimeRegistry.getForTarget(targetProfile, targetServer, "thread-1", cwd)).toBeUndefined();
    expect(taskRuntimeRegistry.getForTarget(profile, server, "thread-1", "/workspace/")).toBe(runtime);
  } finally { taskRuntimeRegistry.remove(profile.id, server.id, "thread-1"); }
});

it("keeps a running owner and rejects deletion without opening a replacement connection", async () => {
  const owner = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => owner as never));
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
  taskRuntimeRegistry.put(profile.id, server.id, runtime);
  runtime.patch({ running: true });
  const replacement = vi.fn();
  taskRuntimeTestHelpers.setConnector(replacement);
  try {
    await expect(deleteStoredThread(profile, server, "thread-1", "/workspace")).rejects.toThrow("请先停止当前回合");
    expect(replacement).not.toHaveBeenCalled();
    expect(owner.closed).toBe(false);
  } finally { taskRuntimeRegistry.remove(profile.id, server.id, "thread-1"); }
});

it("keeps the local row and skips cleanup when delete delivery is unknown", async () => {
  const primary = {
    close: vi.fn(),
    request: vi.fn(async (method: string) => {
      if (method === "thread/read") return { messages: [] };
      if (method === "thread/delete") throw new MobileRpcError("delete ACK lost", -1, "transport", "unknown");
      return {};
    }),
  };
  const connector = vi.fn(async () => primary as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const events: ThreadMutationEvent[] = [];
  const unsubscribe = subscribeThreadMutations(event => events.push(event));

  await expect(deleteStoredThread(profile, server, "thread-review", "/workspace", ["attachment-review"]))
    .rejects.toThrow("delete ACK lost");

  expect(events).toEqual([]);
  expect(connector).toHaveBeenCalledOnce();
  expect(primary.request).toHaveBeenCalledWith("thread/delete", { threadId: "thread-review" });
  expect(primary.close).toHaveBeenCalledOnce();
  expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id)) ?? "[]")).toMatchObject([
    { threadId: "thread-review", confirmed: false, attachments: ["attachment-review"] },
  ]);
  unsubscribe();
});

it("keeps a durable ticket when registry cleanup fails, then retries without attachment/delete", async () => {
  const scope = workspaceStateAuthorizationScope(profile, server);
  const threadId = "thread-retain-cleanup";
  await saveWorkspaceState(profile.id, server.id, threadId, { composerDraft: "retain until cleanup" }, scope);
  const primary = {
    close: vi.fn(),
    request: vi.fn(async (method: string) => {
      if (method === "thread/read") return { messages: [] };
      return {};
    }),
  };
  const cleanupClient = { close: vi.fn(), request: vi.fn(async (method: string, params: { paths?: string[] } = {}) =>
    method === "gateway/attachments/discardRetained" ? { cleared: params.paths ?? [], pending: [] } : {}) };
  const failedRegistry = { close: vi.fn(), request: vi.fn(async () => { throw new Error("registry cleanup offline"); }) };
  const connector = vi.fn().mockResolvedValueOnce(primary as never).mockResolvedValueOnce(cleanupClient as never).mockResolvedValueOnce(failedRegistry as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const events: ThreadMutationEvent[] = [];
  const unsubscribe = subscribeThreadMutations(event => events.push(event));

  await expect(deleteStoredThread(profile, server, threadId, "/workspace", ["attachment-review"]))
    .resolves.toBeUndefined();

  expect(events).toHaveLength(1);
  expect(events[0].mutation).toEqual({ kind: "delete" });
  await vi.waitFor(() => expect(failedRegistry.request).toHaveBeenCalledWith("runtime.worktrees.conversations.remove", {
    deviceId: server.id, path: "/workspace", taskId: threadId,
  }));
  expect(primary.close).toHaveBeenCalledOnce();
  expect(cleanupClient.close).toHaveBeenCalledOnce();
  expect(cleanupClient.request).toHaveBeenCalledWith("gateway/attachments/discardRetained", { threadId, paths: ["attachment-review"] });
  expect(cleanupClient.request).not.toHaveBeenCalledWith("attachment/delete", expect.anything());
  expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id)) ?? "[]")).toMatchObject([
    { threadId, confirmed: true, attachments: [] },
  ]);
  expect((await loadWorkspaceState(profile.id, server.id, threadId, scope)).composerDraft).toBe("retain until cleanup");

  const retryClient = { close: vi.fn(), request: vi.fn(async (method: string, params: { paths?: string[] } = {}) =>
    method === "gateway/attachments/discardRetained" ? { cleared: params.paths ?? [], pending: [] } : {}) };
  const retryRegistry = { close: vi.fn(), request: vi.fn(async () => ({})) };
  taskRuntimeTestHelpers.setConnector(vi.fn()
    .mockResolvedValueOnce(retryClient as never)
    .mockResolvedValueOnce(retryRegistry as never) as never);
  const retryTimeValue = Date.now() + 2_000;
  const retryTime = vi.spyOn(Date, "now").mockReturnValue(retryTimeValue);
  await retryThreadDeletionCleanup(profile, [server]);
  retryTime.mockRestore();
  expect(retryRegistry.request).toHaveBeenCalledWith("runtime.worktrees.conversations.remove", {
    deviceId: server.id, path: "/workspace", taskId: threadId,
  });
  expect(retryClient.request).not.toHaveBeenCalledWith("thread/delete", expect.anything());
  expect(retryClient.request).not.toHaveBeenCalledWith("attachment/delete", expect.anything());
  expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id)) ?? "[]")).toEqual([]);
  expect((await loadWorkspaceState(profile.id, server.id, threadId, scope)).composerDraft).toBeUndefined();
  unsubscribe();
});

it("persists a confirmed ACK locally before cleanup resumes without replaying deletion", async () => {
  const threadId = "thread-confirm-gap";
  const scope = workspaceStateAuthorizationScope(profile, server);
  await saveWorkspaceState(profile.id, server.id, threadId, { composerDraft: "keep until authoritative" }, scope);
  const primary = { close: vi.fn(), request: vi.fn(async () => ({})) };
  const cleanupClient = { close: vi.fn(), request: vi.fn(async () => ({})) };
  const registry = { close: vi.fn(), request: vi.fn(async () => ({})) };
  const connector = vi.fn().mockResolvedValueOnce(primary as never)
    .mockResolvedValueOnce(cleanupClient as never).mockResolvedValueOnce(registry as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  storage.failConfirmedWrites = true;

  await expect(deleteStoredThread(profile, server, threadId, "/workspace"))
    .rejects.toBeInstanceOf(ThreadDeletionCleanupConfirmationPendingError);
  expect(primary.request).toHaveBeenCalledWith("thread/delete", { threadId });
  expect(primary.close).toHaveBeenCalledOnce();
  const pendingRaw = storage.values.get(threadDeletionCleanupKey(profile.id));
  expect(pendingRaw).not.toBeNull();
  expect(JSON.parse(pendingRaw!)).toMatchObject([{ threadId, confirmed: false }]);
  expect(connector).toHaveBeenCalledOnce();
  storage.failConfirmedWrites = false;
  await retryThreadDeletionCleanup(profile, [server]);
  expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id)) ?? "[]")).toEqual([]);
  expect(connector).toHaveBeenCalledTimes(3);
  expect(primary.request).toHaveBeenCalledTimes(1);
  expect(primary.request).toHaveBeenCalledWith("thread/delete", { threadId });
  expect(cleanupClient.request).not.toHaveBeenCalledWith("thread/delete", expect.anything());
  expect(cleanupClient.request).not.toHaveBeenCalledWith("thread/read", expect.anything());
  expect(registry.request).toHaveBeenCalledWith("runtime.worktrees.conversations.remove", {
    deviceId: server.id, path: "/workspace", taskId: threadId,
  });
  expect(cleanupClient.close).toHaveBeenCalledOnce();
  expect(registry.close).toHaveBeenCalledOnce();
  const [ticket] = JSON.parse(pendingRaw!) as Array<{ cacheScope: Parameters<typeof isSessionTranscriptDeletionPending>[0] }>;
  expect(await isSessionTranscriptDeletionPending(ticket.cacheScope)).toBe(false);
  expect(cache.invalidateThread).toHaveBeenCalledOnce();
  expect((await loadWorkspaceState(profile.id, server.id, threadId, scope)).composerDraft).toBeUndefined();
});

it.each([
  ["transport loss", new MobileRpcError("connection lost", -1, "transport", "unknown")],
  ["other remote error", new MobileRpcError("persisted thread belongs to another workspace", -32021, "remote", "unknown")],
  ["wrong code", new MobileRpcError("persisted thread not found: thread-unknown", -32022, "remote", "unknown")],
])("retains an unconfirmed deletion ticket on %s instead of treating it as absence", async (_label, error) => {
  const scope = workspaceStateAuthorizationScope(profile, server);
  await saveWorkspaceState(profile.id, server.id, "thread-unknown", { composerDraft: "keep" }, scope);
  await (await import("@/storage/thread-deletion-cleanup")).prepareThreadDeletionCleanup(profile, server, "thread-unknown", "/workspace", []);
  const cleanupClient = { close: vi.fn(), request: vi.fn(async () => { throw error; }) };
  const connector = vi.fn(async () => cleanupClient as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const pendingRaw = storage.values.get(threadDeletionCleanupKey(profile.id));
  expect(pendingRaw).not.toBeNull();

  await retryThreadDeletionCleanup(profile, [server]);

  expect(connector).not.toHaveBeenCalled();
  expect(cleanupClient.request).not.toHaveBeenCalled();
  expect(cleanupClient.close).not.toHaveBeenCalled();
  expect(storage.values.get(threadDeletionCleanupKey(profile.id))).toBe(pendingRaw);
  const [ticket] = JSON.parse(pendingRaw!) as Array<{ cacheScope: Parameters<typeof isSessionTranscriptDeletionPending>[0] }>;
  expect(await isSessionTranscriptDeletionPending(ticket.cacheScope)).toBe(true);
  expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id)) ?? "[]")).toMatchObject([
    { threadId: "thread-unknown", confirmed: false },
  ]);
  expect((await loadWorkspaceState(profile.id, server.id, "thread-unknown", scope)).composerDraft).toBe("keep");
});

beforeEach(() => installBrowserProfileFixture([profile]));
