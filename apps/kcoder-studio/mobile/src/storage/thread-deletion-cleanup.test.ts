const cache = vi.hoisted(() => ({ fail: false, capture: vi.fn(async (scope: unknown, isCurrent: () => boolean) => {
  if (!isCurrent()) throw new Error("stale"); return { scope };
}), invalidateThread: vi.fn(async () => { if (cache.fail) throw new Error("cache unavailable"); }) }));
vi.mock("./session-transcript-cache", () => ({ sessionTranscriptCache: cache }));
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), fail: false, failNextSetItemKey: null as string | null }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
 getItem: async (key: string) => storage.values.get(key) ?? null,
 setItem: async (key: string, value: string) => {
  if (storage.fail) throw new Error("storage unavailable");
  if (storage.failNextSetItemKey === key) { storage.failNextSetItemKey = null; throw new Error("storage unavailable"); }
  storage.values.set(key, value);
 },
 multiRemove: async (keys: string[]) => { keys.forEach(key => storage.values.delete(key)); },
 removeItem: async (key: string) => { storage.values.delete(key); },
} }));
import { MobileRpcError } from "@/gateway/rpc";
import { FakeClient, profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { TaskRuntime } from "@/runtime/task-runtime";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { deleteStoredThread } from "@/runtime/task-runtime/threadDirectory";
import { isSessionTranscriptDeletionPending, prepareThreadDeletionCleanup, confirmThreadDeletionCleanup, retryThreadDeletionCleanup, threadDeletionCleanupKey, installThreadDeletionCleanupAuthorityResolver, ThreadDeletionCleanupConfirmationPendingError } from "./thread-deletion-cleanup";
import { saveWorkspaceState, loadWorkspaceState, workspaceStateAuthorizationScope, workspacePreferencesTestHelpers } from "./workspace-preferences";
let uninstallAuthority: (() => void) | undefined;
beforeEach(() => { cache.fail = false; cache.capture.mockClear(); cache.invalidateThread.mockClear(); uninstallAuthority = installThreadDeletionCleanupAuthorityResolver(() => workspaceStateAuthorizationScope(profile, server)); storage.values.clear(); storage.fail = false; storage.failNextSetItemKey = null; workspacePreferencesTestHelpers.reset(); });
afterEach(() => { uninstallAuthority?.(); taskRuntimeTestHelpers.resetConnector(); });
function acknowledgedDeleteConnector() {
 const methods: string[] = [];
 const connector = vi.fn(async () => {
  const client = new FakeClient([]);
  const originalRequest = client.request.bind(client);
  client.request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
   methods.push(method);
   if (method === "thread/delete") {
    storage.failNextSetItemKey = threadDeletionCleanupKey(profile.id);
    return undefined as never;
   }
   if (method === "runtime.worktrees.conversations.remove") return { removed: true } as never;
   return originalRequest(method, params as never) as never;
  }) as never;
  return client as never;
 });
 taskRuntimeTestHelpers.setConnector(connector as never);
 return methods;
}
it("persists before dispatch, never cleans unknown deletes, retries acknowledged cleanup after failure", async () => {
 const request = vi.fn(async (_method: string, _params: { paths?: string[] }) => { throw new Error("offline"); });
 const close = vi.fn(); taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ request, close })) as never);
 const scope = workspaceStateAuthorizationScope(profile, server);
 await saveWorkspaceState(profile.id, server.id, "thread", { composerDraft: "retain until cleanup" }, scope);
 const id = await prepareThreadDeletionCleanup(profile, server, "thread", "/workspace", ["attachment"]);
 await retryThreadDeletionCleanup(profile, [server]); expect(request).not.toHaveBeenCalledWith("attachment/delete", expect.anything());
 await confirmThreadDeletionCleanup(profile.id, id);
 await retryThreadDeletionCleanup(profile, [server]);
 expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)).toHaveLength(1);
 expect((await loadWorkspaceState(profile.id, server.id, "thread", scope)).composerDraft).toBe("retain until cleanup");
 request.mockImplementation(async (method: string, params: { paths?: string[] }) => method === "gateway/attachments/discardRetained" ? { cleared: params.paths, pending: [] } as never : undefined as never);
 const now = Date.now(); const time = vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
 await retryThreadDeletionCleanup({ ...profile, expiresAt: profile.expiresAt + 1 }, [server]);
 time.mockRestore();
 expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)).toEqual([]);
 expect((await loadWorkspaceState(profile.id, server.id, "thread", scope)).composerDraft).toBeUndefined();
 expect(request).not.toHaveBeenCalledWith("attachment/delete", expect.anything()); expect(close).toHaveBeenCalled();
});
it("different authorization cannot execute retained old cleanup", async () => {
 const connector = vi.fn(); taskRuntimeTestHelpers.setConnector(connector as never);
 const id = await prepareThreadDeletionCleanup(profile, server, "thread", "/workspace", []); await confirmThreadDeletionCleanup(profile.id, id);
 await retryThreadDeletionCleanup({ ...profile, authorizationGeneration: "different" }, [server]); expect(connector).not.toHaveBeenCalled();
});
it("storage failure prevents creation of a deletion ticket", async () => {
 storage.fail = true; await expect(prepareThreadDeletionCleanup(profile, server, "thread", "/workspace", [])).rejects.toThrow("storage unavailable");
 expect(storage.values.size).toBe(0);
});

it.each(["active task runtime", "inactive task directory"])("reports confirmed deletion with local ACK pending and recovers without replaying thread/delete (%s)", async mode => {
 const methods = acknowledgedDeleteConnector();
 let runtime: TaskRuntime | undefined;
 try {
  if (mode === "active task runtime") {
   runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
   await expect(runtime.deleteThread()).rejects.toBeInstanceOf(ThreadDeletionCleanupConfirmationPendingError);
   expect(runtime.getSnapshot().error).toMatch(/已删除|deleted/i);
  } else {
   await expect(deleteStoredThread(profile, server, "thread-1"))
    .rejects.toBeInstanceOf(ThreadDeletionCleanupConfirmationPendingError);
  }
  const key = threadDeletionCleanupKey(profile.id);
  expect(JSON.parse(storage.values.get(key)!)[0].confirmed).toBe(false);
  expect(methods.filter(method => method === "thread/delete")).toHaveLength(1);

  await retryThreadDeletionCleanup(profile, [server]);

  expect(JSON.parse(storage.values.get(key)!)).toEqual([]);
  expect(methods.filter(method => method === "thread/delete")).toHaveLength(1);
 } finally {
  runtime?.close();
 }
});

it("keeps an ACK-confirmation storage gap pending without probing or claiming it", async () => {
 const request = vi.fn(async () => { throw new MobileRpcError("persisted thread not found: thread", -32021, "remote"); });
 const connector = vi.fn(async () => ({ request, close: vi.fn() }));
 taskRuntimeTestHelpers.setConnector(connector as never);
 await prepareThreadDeletionCleanup(profile, server, "thread", undefined, []);
 const before = storage.values.get(threadDeletionCleanupKey(profile.id));
 await retryThreadDeletionCleanup(profile, [server]);
 await retryThreadDeletionCleanup(profile, [server]);
 expect(storage.values.get(threadDeletionCleanupKey(profile.id))).toBe(before);
 expect(connector).not.toHaveBeenCalled();
 expect(request).not.toHaveBeenCalled();
});
it("preserves an unconfirmed ticket until an explicit delete ACK permits cleanup", async () => {
 const request = vi.fn(async (method: string, params: { paths?: string[] } = {}) => {
  if (method === "thread/read") throw new MobileRpcError("persisted thread not found: thread", -32021, "remote");
  if (method === "gateway/attachments/discardRetained") return { cleared: params.paths ?? [], pending: [] } as never;
  if (method === "runtime.worktrees.conversations.remove") return { removed: true } as never;
  return undefined as never;
 });
 const connector = vi.fn(async () => ({ request, close: vi.fn() }));
 taskRuntimeTestHelpers.setConnector(connector as never);
 const id = await prepareThreadDeletionCleanup(profile, server, "thread", "/workspace", ["attachment"]);
 const before = storage.values.get(threadDeletionCleanupKey(profile.id));
 await retryThreadDeletionCleanup(profile, [server]);
 expect(storage.values.get(threadDeletionCleanupKey(profile.id))).toBe(before);
 const scope = JSON.parse(before!)[0].cacheScope;
 expect(await isSessionTranscriptDeletionPending(scope)).toBe(true);
 expect(connector).not.toHaveBeenCalled();
 expect(request).not.toHaveBeenCalled();
 await confirmThreadDeletionCleanup(profile.id, id);
 await retryThreadDeletionCleanup(profile, [server]);
 expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)).toEqual([]);
 expect(request.mock.calls.map(([method]) => method)).toEqual(["gateway/attachments/discardRetained", "runtime.worktrees.conversations.remove"]);
 expect(cache.invalidateThread).toHaveBeenCalledTimes(1);
});
it("merges only cleared paths while preserving a same-ticket claim and new references", async () => {
 let finish!: (result: { cleared: string[]; pending: string[] }) => void;
 let started!: () => void;
 const entered = new Promise<void>(resolve => { started = resolve; });
 const ack = new Promise<{ cleared: string[]; pending: string[] }>(resolve => { finish = resolve; });
 const request = vi.fn(async (method: string) => {
   if (method === "gateway/attachments/discardRetained") { started(); return ack; }
   return undefined;
 });
 taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ request, close: vi.fn() })) as never);
 const id = await prepareThreadDeletionCleanup(profile, server, "thread", undefined, ["a"]);
 await confirmThreadDeletionCleanup(profile.id, id);
 const running = retryThreadDeletionCleanup(profile, [server]); await entered;
 const prior = JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)[0];
 await prepareThreadDeletionCleanup(profile, server, "thread", undefined, ["b"]);
 const during = JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)[0];
 expect(during.claim).toEqual(prior.claim);
 finish({ cleared: ["a"], pending: [] }); await running;
 const remaining = JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!);
 expect(remaining).toHaveLength(1); expect(remaining[0].attachments).toEqual(["b"]); expect(remaining[0].claim).toBeUndefined();
});
it("does not starve another ticket behind a repeatedly failing cleanup", async () => {
 const request = vi.fn(async (_method: string, _params: unknown) => { throw new Error("offline"); });
 taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ request, close: vi.fn() })) as never);
 await confirmThreadDeletionCleanup(profile.id, await prepareThreadDeletionCleanup(profile, server, "first", undefined, ["first-attachment"]));
 await confirmThreadDeletionCleanup(profile.id, await prepareThreadDeletionCleanup(profile, server, "second", undefined, ["second-attachment"]));
 await retryThreadDeletionCleanup(profile, [server]);
 await retryThreadDeletionCleanup(profile, [server]);
 expect(request.mock.calls).toHaveLength(2);
 expect(request.mock.calls[0]).toEqual(["gateway/attachments/discardRetained", { threadId: "first", paths: ["first-attachment"] }]);
 expect(request.mock.calls[1]).toEqual(["gateway/attachments/discardRetained", { threadId: "second", paths: ["second-attachment"] }]);
});

beforeEach(() => installBrowserProfileFixture([profile]));

it("keeps the acknowledged deletion ticket and suppresses stale cached display until cache cleanup succeeds", async () => {
 const request = vi.fn(async () => undefined);
 taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ request, close: vi.fn() })) as never);
 const id = await prepareThreadDeletionCleanup(profile, server, "thread", "/workspace", []);
 await confirmThreadDeletionCleanup(profile.id, id);
 const scope = JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)[0].cacheScope;
 cache.fail = true;
 await retryThreadDeletionCleanup(profile, [server]);
 expect(await isSessionTranscriptDeletionPending(scope)).toBe(true);
 expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)[0].confirmed).toBe(true);
 const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
 cache.fail = false; await retryThreadDeletionCleanup(profile, [server]); time.mockRestore();
 expect(await isSessionTranscriptDeletionPending(scope)).toBe(false);
 expect(request).not.toHaveBeenCalledWith("thread/delete", expect.anything());
});
