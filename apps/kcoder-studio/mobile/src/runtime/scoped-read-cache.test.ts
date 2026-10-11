import { expect, it, vi } from "vitest";
import { ScopedReadCache } from "./scoped-read-cache";
import { threadListScopeKey } from "./thread-list-projection";
import { profile, server } from "./task-runtime/fixture.test-support";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
it("coalesces same scope reads and cancels the transport only when the last waiter leaves", async () => {
 const cache = new ScopedReadCache<string>(); const result = deferred<string>(); let owned!: AbortSignal;
 const load = vi.fn(async (signal: AbortSignal) => { owned = signal; return result.promise; });
 const a = new AbortController(); const b = new AbortController();
 const first = cache.get("scope", load, a.signal); const firstRejected = expect(first).rejects.toThrow("取消");
 const second = cache.get("scope", load, b.signal); await Promise.resolve();
 a.abort(); await firstRejected; expect(owned.aborted).toBe(false);
 result.resolve("page"); expect(await second).toBe("page"); expect(await cache.get("scope", load)).toBe("page"); expect(load).toHaveBeenCalledOnce(); cache.clear();
});
it("bounds completed entries and reloads after TTL or authorization generation changes", async () => {
 vi.useFakeTimers(); const cache = new ScopedReadCache<number>(2, 30_000); let value = 0; const load = vi.fn(async () => ++value);
 const key = threadListScopeKey({ ...profile, authorizationGeneration: "A" }, server);
 expect(await cache.get(key, load)).toBe(1); expect(await cache.get(key, load)).toBe(1);
 expect(await cache.get(threadListScopeKey({ ...profile, authorizationGeneration: "B" }, server), load)).toBe(2);
 await vi.advanceTimersByTimeAsync(30_001); expect(await cache.get(key, load)).toBe(3);
 await cache.get("other", load); expect(await cache.get(threadListScopeKey({ ...profile, authorizationGeneration: "B" }, server), load)).toBe(5);
 cache.clear(); vi.useRealTimers();
});
it("last waiter cancellation prevents late cache population", async () => {
 const cache = new ScopedReadCache<string>(); const old = deferred<string>(); let signal!: AbortSignal;
 const controller = new AbortController(); const read = cache.get("scope", async (owned) => { signal = owned; return old.promise; }, controller.signal);
 const rejected = expect(read).rejects.toThrow("取消"); await Promise.resolve(); controller.abort(); await rejected; expect(signal.aborted).toBe(true);
 old.resolve("stale"); await Promise.resolve(); expect(await cache.get("scope", async () => "fresh")).toBe("fresh"); cache.clear();
});
