import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), fail: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
 getItem: async (key: string) => storage.values.get(key) ?? null,
 setItem: async (key: string, value: string) => { if (storage.fail) throw new Error("storage unavailable"); storage.values.set(key, value); },
 multiRemove: async (keys: string[]) => { keys.forEach(key => storage.values.delete(key)); },
 removeItem: async (key: string) => { storage.values.delete(key); },
} }));
import { MobileRpcError } from "@/gateway/rpc";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { prepareThreadDeletionCleanup, confirmThreadDeletionCleanup, retryThreadDeletionCleanup, threadDeletionCleanupKey, installThreadDeletionCleanupAuthorityResolver } from "./thread-deletion-cleanup";
import { saveWorkspaceState, loadWorkspaceState, workspaceStateAuthorizationScope, workspacePreferencesTestHelpers } from "./workspace-preferences";
let uninstallAuthority: (() => void) | undefined;
beforeEach(() => { uninstallAuthority = installThreadDeletionCleanupAuthorityResolver(() => workspaceStateAuthorizationScope(profile, server)); storage.values.clear(); storage.fail = false; workspacePreferencesTestHelpers.reset(); });
afterEach(() => { uninstallAuthority?.(); taskRuntimeTestHelpers.resetConnector(); });
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

it("recovers an ACK-confirmation storage gap only from exact authoritative absence", async () => {
 const request = vi.fn(async () => { throw new MobileRpcError("persisted thread not found: thread", -32021, "remote"); });
 taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ request, close: vi.fn() })) as never);
 await prepareThreadDeletionCleanup(profile, server, "thread", undefined, []);
 await retryThreadDeletionCleanup(profile, [server]);
 expect(JSON.parse(storage.values.get(threadDeletionCleanupKey(profile.id))!)).toEqual([]);
 expect(request).toHaveBeenCalledWith("thread/read", { threadId: "thread", limit: 1 });
 expect(request).not.toHaveBeenCalledWith("thread/delete", expect.anything());
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
 await prepareThreadDeletionCleanup(profile, server, "first", undefined, []);
 await prepareThreadDeletionCleanup(profile, server, "second", undefined, []);
 await retryThreadDeletionCleanup(profile, [server]);
 await retryThreadDeletionCleanup(profile, [server]);
 expect(request.mock.calls).toHaveLength(2);
 expect(request.mock.calls[0]).toEqual(["thread/read", { threadId: "first", limit: 1 }]);
 expect(request.mock.calls[1]).toEqual(["thread/read", { threadId: "second", limit: 1 }]);
});

beforeEach(() => installBrowserProfileFixture([profile]));
