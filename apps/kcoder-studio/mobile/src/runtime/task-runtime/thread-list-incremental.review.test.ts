// Runtime/page/projection contracts over a controlled client and real metadata
// fence. These are not mounted React, Browser, Gateway RTT or real-device tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import type { GatewayRpcClient } from "@/gateway/rpc";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { listThreads, mapThreadListDependencies, type ThreadListPage } from "./threadDirectory";
import { orderThreadScopeRows, threadListReadOwner, ThreadListProjection } from "../thread-list-projection";

const profile: GatewayProfile = { id: "progress-profile", label: "Synthetic", baseUrl: "http://127.0.0.1:4173", accessToken: "synthetic", rpcToken: "synthetic-rpc", expiresAt: Number.MAX_SAFE_INTEGER, authorizationGeneration: "generation-a", deviceId: "device-a" };
const server: KCoderServer = { id: "progress-target", label: "Synthetic", description: "Test", runtime: "kcoder", transport: "local", workspacePath: "/workspace" };
const row = (id: string, cwd = "/workspace", updatedAt = 1): ThreadSummary => ({ id, cwd, updatedAt, createdAt: 1, status: "idle" });
const page = (threads: ThreadSummary[], nextCursor?: string, partial = false): ThreadListPage => ({ threads, nextCursor, completeness: partial ? "partial" : "complete", issueCount: partial ? 1 : 0 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class PageClient {
  calls: Array<string | undefined> = []; closeCount = 0;
  constructor(private readonly read: (cursor?: string) => Promise<ThreadListPage>) {}
  async request<T>(method: string, params: { cursor?: string }): Promise<T> { expect(method).toBe("thread/list"); this.calls.push(params.cursor); return await this.read(params.cursor) as T; }
  supportsExperimental() { return true; }
  close() { this.closeCount += 1; }
  borrowed() { return this as unknown as GatewayRpcClient; }
}
beforeEach(() => installBrowserProfileFixture([profile]));
afterEach(() => vi.unstubAllGlobals());

describe("incremental thread reads", () => {
  it("publishes the first cumulative page before requesting a held later cursor; only final replaces old rows", async () => {
    const later = deferred<ThreadListPage>(); const projection = new ThreadListProjection(); const events: string[] = [];
    projection.update("scope", page([row("previous")]));
    const client = new PageClient(async cursor => { events.push(cursor ? "request:second" : "request:first"); return cursor ? later.promise : page([row("first", "/workspace", 3)], "second"); });
    let settled = false;
    const operation = listThreads(profile, server, 100, {}, { client: client.borrowed(), isCurrent: () => true, onPage: snapshot => { events.push(snapshot.nextCursor ? "publish:first" : "publish:final"); projection.update("scope", snapshot); } }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(client.calls).toEqual([undefined, "second"]));
    expect(events).toEqual(["request:first", "publish:first", "request:second"]);
    expect(projection.get("scope")?.threads.map(thread => thread.id)).toEqual(["first", "previous"]);
    expect(settled).toBe(false);
    later.resolve(page([row("second", "/workspace", 2)]));
    const final = await operation;
    expect(final.threads.map(thread => thread.id)).toEqual(["first", "second"]);
    expect(projection.get("scope")?.threads.map(thread => thread.id)).toEqual(["first", "second"]);
    expect(events.at(-1)).toBe("publish:final"); expect(client.closeCount).toBe(0); // Borrowed client belongs to its source.
  });

  it("later-page failure retains first page and previous rows without publishing an authoritative terminal", async () => {
    const later = deferred<ThreadListPage>(); const projection = new ThreadListProjection(); const snapshots: ThreadListPage[] = [];
    projection.update("scope", page([row("previous")]));
    const client = new PageClient(async cursor => cursor ? later.promise : page([row("first")], "second"));
    const operation = listThreads(profile, server, 100, {}, { client: client.borrowed(), onPage: snapshot => { snapshots.push(snapshot); projection.update("scope", snapshot); } });
    const result = operation.then(() => null, error => error);
    await vi.waitFor(() => expect(client.calls.length).toBe(2)); later.reject(new Error("held page failed"));
    expect(String(await result)).toContain("held page failed"); expect(snapshots).toHaveLength(1);
    expect(projection.get("scope")?.threads.map(thread => thread.id).sort()).toEqual(["first", "previous"]);
  });

  it("a fast target publishes its page while another discovery is held, without waiting for global discovery", async () => {
    const heldDiscovery = deferred<string>(); const published: string[] = []; const registered = new Set<string>();
    const clients = new Map(["A", "B"].map(id => [id, new PageClient(async () => page([row(id)]))]));
    let settled = false;
    const operation = mapThreadListDependencies(["A", "B"], async id => id === "B" ? heldDiscovery.promise : id,
      id => [id], async id => listThreads(profile, server, 100, {}, { client: clients.get(id)!.borrowed(), onPage: () => { expect(registered.has(id)).toBe(true); published.push(id); } }),
      { onTargetDiscovered: id => { registered.add(id); } }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(published).toEqual(["A"])); expect(settled).toBe(false); expect(registered.has("B")).toBe(false);
    heldDiscovery.resolve("B"); const result = await operation;
    expect(published).toEqual(["A", "B"]); expect(result.results.map(snapshot => snapshot.threads[0]?.id)).toEqual(["A", "B"]);
  });

  it("invalidation after a first page prevents the held response and settled callback from publishing", async () => {
    const later = deferred<ThreadListPage>(); let current = true; const published: ThreadListPage[] = []; const settled = vi.fn();
    const client = new PageClient(async cursor => cursor ? later.promise : page([row("first")], "second"));
    const operation = mapThreadListDependencies(["A"], async id => id, id => [id], async () => listThreads(profile, server, 100, {},
      { client: client.borrowed(), isCurrent: () => current, onPage: snapshot => published.push(snapshot) }), { isCurrent: () => current, onReadSettled: settled });
    const result = operation.then(() => null, error => error);
    await vi.waitFor(() => expect(client.calls.length).toBe(2)); current = false; later.resolve(page([row("late")]));
    expect(String(await result)).toContain("历史分页器已关闭或归属变化"); expect(published).toHaveLength(1); expect(settled).not.toHaveBeenCalled();
  });

  it("partial terminal cannot delete previous rows, including an empty snapshot", async () => {
    const projection = new ThreadListProjection(); projection.update("scope", page([row("previous")]));
    const client = new PageClient(async () => page([], undefined, true));
    await listThreads(profile, server, 100, {}, { client: client.borrowed(), onPage: snapshot => projection.update("scope", snapshot) });
    expect(projection.get("scope")?.threads.map(thread => thread.id)).toEqual(["previous"]);
    expect(projection.get("scope")?.completeness).toBe("partial");
  });

  it("deduplicates overlapping actual cwd answers deterministically without losing same IDs from another cwd/server", () => {
    const records = [
      { serverId: "A", workspacePath: undefined, scope: "default", thread: row("same", "/x", 9) },
      { serverId: "A", workspacePath: "/x", scope: "exact", thread: { ...row("same", "/x", 8), title: "exact" } },
      { serverId: "A", workspacePath: "/y", scope: "y", thread: row("same", "/y", 7) },
      { serverId: "B", workspacePath: "/x", scope: "other", thread: row("same", "/x", 6) },
      { serverId: "A", workspacePath: "/z", scope: "z", thread: { ...row("same"), cwd: undefined } },
    ];
    const result = orderThreadScopeRows(records);
    expect(result).toEqual(orderThreadScopeRows([...records].reverse())); expect(result).toHaveLength(4);
    expect(result.find(item => item.serverId === "A" && item.thread.cwd === "/x")?.thread.title).toBe("exact");
  });

  it("read owner includes device, auth generation, principal and raw undefined/empty workspace paths", () => {
    const owner = threadListReadOwner(profile, server);
    for (const next of [{ ...profile, deviceId: "other" }, { ...profile, authorizationGeneration: "other" }]) expect(threadListReadOwner(next, server)).not.toBe(owner);
    expect(threadListReadOwner(profile, { ...server, accountIdentity: { principalId: "other", username: "user" } })).not.toBe(owner);
    expect(threadListReadOwner(profile, { ...server, workspacePath: undefined })).not.toBe(threadListReadOwner(profile, { ...server, workspacePath: "" }));
  });
});
