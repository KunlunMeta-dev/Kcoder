// Model-independent admission, cancellation and history/config readiness contracts.
import { afterEach, expect, it, vi } from "vitest";
import { GatewayConnectionBudget } from "../../../shared/gatewayConnectionBudget";
import { TaskRuntime, taskRuntimeTestHelpers, ThreadListPager } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => taskRuntimeTestHelpers.resetConnector());
it("admits foreground ahead of queued background and cancels queued work before invocation", async () => {
  const budget = new GatewayConnectionBudget(1);
  const gate = deferred<void>();
  const calls: string[] = [];
  const active = budget.run(() => gate.promise);
  const abort = new AbortController();
  const cancelled = budget.run(async () => { calls.push("cancelled"); }, abort.signal, "background");
  const rejection = expect(cancelled).rejects.toThrow("cancelled");
  const background = budget.run(async () => { calls.push("background"); }, undefined, "background");
  const foreground = budget.run(async () => { calls.push("foreground"); });
  abort.abort(); gate.resolve();
  await Promise.all([active, background, foreground, rejection]);
  expect(calls).toEqual(["foreground", "background"]);
});
it("limits background handshakes to one while admitting foreground independently", async () => {
  const budget = new GatewayConnectionBudget(4);
  const gate = deferred<void>(); const calls: string[] = [];
  const first = budget.run(() => gate.promise, undefined, "background");
  const second = budget.run(async () => { calls.push("background"); }, undefined, "background");
  await budget.run(async () => { calls.push("foreground"); });
  expect(calls).toEqual(["foreground"]); gate.resolve();
  await Promise.all([first, second]); expect(calls).toEqual(["foreground", "background"]);
});
it("returns readable history while delayed configuration still gates sending", async () => {
  const client = new FakeClient([{ id: "history", role: "user", content: "history", timestampMs: 1 }]);
  const configuration = deferred<unknown>(); const original = client.request.bind(client);
  client.request = vi.fn(async (method: string, params = {}) => {
    if (method === "runtime.models.list") return configuration.promise;
    if (method === "thread/resume") return { thread: { id: "thread-1", model: "M2" } };
    return original(method, params);
  }) as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1", reasoningEffort: "ultra" });
  expect(runtime.getSnapshot().messages[0]?.content).toBe("history");
  expect(runtime.getSnapshot().connected).toBe(true);
  expect(runtime.getSnapshot().configurationReady).toBe(false);
  await expect(runtime.send("must wait")).rejects.toThrow("正在校验");
  configuration.resolve({});
  await vi.waitFor(() => expect(runtime.getSnapshot().configurationReady).toBe(true)); runtime.close();
});
it("closing a pager cancels its queued connector and cannot accept a late page", async () => {
  const gate = deferred<never>(); let signal: AbortSignal | undefined; const client = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(vi.fn(async (_profile, _server, _cwd, _channel, options) => {
    signal = options?.signal; return gate.promise;
  }) as never);
  const pager = new ThreadListPager(profile, server, {}, "background"); const page = pager.page();
  pager.close(); expect(signal?.aborted).toBe(true); gate.resolve(client as never);
  await expect(page).rejects.toThrow("已关闭"); expect(client.closed).toBe(true);
});

it("projects latest rename immediately and a stale rejection cannot roll it back", async () => {
  const first = deferred<unknown>(); const second = deferred<unknown>();
  const client = new FakeClient([]); let call = 0;
  client.request = vi.fn(async () => (++call === 1 ? first.promise : second.promise)) as never;
  const runtime = TaskRuntime.demo("thread"); runtime.attachClient(client as never);
  const a = runtime.rename("A"); const rejection = expect(a).rejects.toThrow("denied");
  const b = runtime.rename("B");
  expect(runtime.getSnapshot().title).toBe("B");
  await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
  const { MobileRpcError } = await import("@/gateway/rpc");
  // Rejected RPC is explicit, so only the still-current projection may roll back.
  first.resolve(Promise.reject(new MobileRpcError("denied", 1, "remote")));
  await rejection;
  expect(runtime.getSnapshot().title).toBe("B");
  second.resolve({}); await b;
  expect(runtime.getSnapshot().title).toBe("B");
  expect(runtime.getSnapshot().metadataPending).toEqual([]); runtime.close();
});

it("shows pending model selection while keeping the confirmed model and blocking send", async () => {
  const update = deferred<unknown>();
  const client = new FakeClient([]);
  client.request = vi.fn(async () => update.promise) as never;
  const runtime = TaskRuntime.demo("thread"); runtime.attachClient(client as never);
  const previous = runtime.getSnapshot().model;
  const changed = runtime.setTurnPreferences("M2");
  expect(runtime.getSnapshot().model).toBe(previous);
  expect(runtime.getSnapshot().pendingTurnPreferences?.model).toBe("M2");
  await expect(runtime.send("must wait")).rejects.toThrow("正在校验");
  update.resolve({}); await changed;
  expect(runtime.getSnapshot().model).toBe("M2");
  expect(runtime.getSnapshot().configurationReady).toBe(true); runtime.close();
});
