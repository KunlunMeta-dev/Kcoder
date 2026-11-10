import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileMigrationClient } from "@/runtime/migration-client";
const host = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], memos: [] as any[], effects: [] as any[], si: 0, ri: 0, mi: 0, ei: 0 }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const same = (a: any[], b: any[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...actual,
    useState: (initial: any) => { const index = host.si++; if (!(index in host.states)) host.states[index] = typeof initial === "function" ? initial() : initial; return [host.states[index], (value: any) => { host.states[index] = typeof value === "function" ? value(host.states[index]) : value; }]; },
    useRef: (current: any) => host.refs[host.ri++] ??= { current },
    useMemo: (factory: () => any, deps: any[]) => { const index = host.mi++, old = host.memos[index]; if (old && same(old.deps, deps)) return old.value; const value = factory(); host.memos[index] = { value, deps }; return value; },
    useEffect: (callback: () => void | (() => void), deps: any[] = []) => { const index = host.ei++, old = host.effects[index]; if (!old || !same(old.deps, deps)) { old?.cleanup?.(); host.effects[index] = { callback, deps, pending: true }; } },
  };
});
import { useHistoricalWorker } from "./useHistoricalWorker";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const state = (sequence: number, workerRunning: boolean, cancelRevision = 0) => ({ job: { jobId: "history", sequence, cancelRevision }, workerRunning });
function render<N extends "historyRead" | "branchRead" = "historyRead">(client: MobileMigrationClient, jobId = "history", name: N = "historyRead" as N) {
  host.si = host.ri = host.mi = host.ei = 0;
  const value = useHistoricalWorker(client, name, { jobId });
  for (const effect of host.effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.callback(); }
  return value;
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => { host.states = []; host.refs = []; host.memos = []; host.effects = []; vi.useFakeTimers(); });
afterEach(() => { for (const effect of host.effects) effect.cleanup?.(); vi.useRealTimers(); });
it("a delayed stopped read cannot overwrite an acknowledged running mutation or stop subsequent read-only polling", async () => {
  const stale = deferred<any>(), call = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(state(4, true)).mockResolvedValue(state(5, false));
  const client = { call, available: () => true } as unknown as MobileMigrationClient;
  let task = render(client);
  await task.perform(async () => state(3, true) as never);
  task = render(client); await settle(); stale.resolve(state(1, false)); await settle();
  task = render(client); expect(task.result?.job.sequence).toBe(4);
  await vi.advanceTimersByTimeAsync(600); task = render(client);
  expect(task.result?.job.sequence).toBe(5); expect(call).toHaveBeenCalledTimes(3);
});
it("reopening a read after bounded catalog-busy exhaustion restarts observation without replaying a mutation", async () => {
  const call = vi.fn().mockRejectedValue(new Error("history_catalog_busy"));
  const client = { call, available: () => true } as unknown as MobileMigrationClient;
  let task = render(client); await settle(); await vi.advanceTimersByTimeAsync(3000); task = render(client);
  expect(task.error).toBe("history_catalog_busy"); expect(call).toHaveBeenCalledTimes(9);
  call.mockResolvedValue(state(7, false)); task.refresh(); task = render(client); await settle(); task = render(client);
  expect(task.result?.job.sequence).toBe(7); expect(call.mock.calls.every(row => row[0] === "historyRead")).toBe(true);
});
it("a late source or account completion cannot adopt an old result even before the old effect cleanup runs", async () => {
  const late = deferred<any>(), call = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(state(8, false));
  const client = { call, available: () => true } as unknown as MobileMigrationClient;
  render(client, "source-a"); render(client, "source-b"); await settle(); late.resolve(state(99, false)); await settle();
  const task = render(client, "source-b"); expect(task.result?.job.sequence).toBe(8);
  const mutation = deferred<any>(), operation = task.perform(() => mutation.promise);
  render(client, "source-c"); mutation.resolve(state(200, true)); await operation; await settle();
  expect(render(client, "source-c").result?.job.sequence).toBe(8);
});
it("lower sequence or cancellation watermarks do not reverse the latest acknowledged facts", async () => {
  const call = vi.fn().mockResolvedValueOnce(state(4, true, 3)).mockResolvedValueOnce(state(4, false, 2)).mockResolvedValueOnce(state(5, false, 3));
  const client = { call, available: () => true } as unknown as MobileMigrationClient;
  let task = render(client); await settle(); await vi.advanceTimersByTimeAsync(600); task = render(client);
  expect((task.result?.job as any)?.cancelRevision).toBe(3); expect(task.result?.workerRunning).toBe(true);
  await vi.advanceTimersByTimeAsync(600); task = render(client); expect(task.result?.job.sequence).toBe(5);
});
it("an explicitly selected different branch starts an independent sequence rather than retaining the old view", async () => {
  const branch = (viewId: string, sequence: number) => ({ choice: { viewId, relatedJobIds: [] }, progress: { viewId, sequence }, workerRunning: false });
  const call = vi.fn().mockResolvedValueOnce(branch("old-view", 20)).mockResolvedValue(branch("new-view", 0));
  const client = { call, available: () => true } as unknown as MobileMigrationClient;
  let task = render(client, "history", "branchRead"); await settle(); task = render(client, "history", "branchRead");
  await task.perform(async () => branch("new-view", 0) as never); task = render(client, "history", "branchRead"); await settle(); task = render(client, "history", "branchRead");
  expect((task.result as any)?.choice.viewId).toBe("new-view"); expect((task.result as any)?.progress.sequence).toBe(0);
});
it("a batch-owned history checkpoint continues read-only observation even when this coordinator has no local worker", async () => {
  const call = vi.fn().mockResolvedValueOnce({ ...state(0, false), job: { ...state(0, false).job, stage: "capturing" } }).mockResolvedValueOnce({ ...state(1, false), job: { ...state(1, false).job, stage: "normalizing" } }).mockResolvedValue({ ...state(2, false), job: { ...state(2, false).job, stage: "normalized" } });
  const client = { call, available: () => true } as unknown as MobileMigrationClient;
  let task = render(client); await settle(); await vi.advanceTimersByTimeAsync(600); task = render(client);
  expect(task.result?.job.sequence).toBe(1); expect(task.result?.workerRunning).toBe(false);
  await vi.advanceTimersByTimeAsync(600); task = render(client); expect(task.result?.job.stage).toBe("normalized");
  await vi.advanceTimersByTimeAsync(20000); expect(call).toHaveBeenCalledTimes(3); expect(call.mock.calls.every(row => row[0] === "historyRead")).toBe(true);
});
it("idle planned history is not polled forever and slow external observation backs off to a bounded cadence", async () => {
  const planned = vi.fn().mockResolvedValue({ ...state(0, false), job: { ...state(0, false).job, stage: "planned" } });
  const idle = { call: planned, available: () => true } as unknown as MobileMigrationClient;
  render(idle); await settle(); await vi.advanceTimersByTimeAsync(20000); expect(planned).toHaveBeenCalledTimes(1);
  const external = vi.fn().mockResolvedValue({ ...state(0, false), job: { ...state(0, false).job, stage: "archiving" } });
  const active = { call: external, available: () => true } as unknown as MobileMigrationClient;
  render(active); await settle(); await vi.advanceTimersByTimeAsync(20000); expect(external.mock.calls.length).toBeGreaterThan(3); expect(external.mock.calls.length).toBeLessThan(10);
});
it("a terminal checkpoint does not stop observation before its proven execution owner releases the lease", async () => {
  const call = vi.fn().mockResolvedValueOnce({ ...state(4, true), job: { ...state(4, true).job, stage: "normalized" }, workerState: "running" }).mockResolvedValue({ ...state(4, false), job: { ...state(4, false).job, stage: "normalized" }, workerState: "stopped" });
  const client = { call, available: () => true, supportsCapability: () => true } as unknown as MobileMigrationClient;
  render(client); await settle(); await vi.advanceTimersByTimeAsync(600); const task = render(client);
  expect(task.result?.workerRunning).toBe(false); expect(call).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20000); expect(call).toHaveBeenCalledTimes(2);
});
it("explicit stopped ownership stops intermediate polling while unknown retains only bounded read-only observation", async () => {
  const stopped = vi.fn().mockResolvedValue({ ...state(0, false), job: { ...state(0, false).job, stage: "archiving" }, workerState: "stopped" });
  render({ call: stopped, available: () => true, supportsCapability: () => true } as unknown as MobileMigrationClient); await settle(); await vi.advanceTimersByTimeAsync(20000); expect(stopped).toHaveBeenCalledTimes(1);
  const unknown = vi.fn().mockResolvedValue({ ...state(0, false), job: { ...state(0, false).job, stage: "archiving" }, workerState: "unknown" });
  render({ call: unknown, available: () => true, supportsCapability: () => true } as unknown as MobileMigrationClient); await settle(); await vi.advanceTimersByTimeAsync(20000);
  expect(unknown.mock.calls.length).toBeGreaterThan(3); expect(unknown.mock.calls.length).toBeLessThan(10); expect(unknown.mock.calls.every(row => row[0] === "historyRead")).toBe(true);
});
