// Real factories/core + FakeClient RPC; no Provider or model transport.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
} }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}), gatewaySessionExpired: vi.fn(async () => false) }));
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { TaskRuntimeRegistry } from "./task-runtime/registry";
import { claimCreationResult, creationCleanupStatus, retryCreationCleanup } from "./task-runtime/factories";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

function fixture() {
  let resolve!: (value: { thread: { id: string; cwd: string } }) => void;
  const start = new Promise<{ thread: { id: string; cwd: string } }>(done => { resolve = done; });
  const client = new FakeClient([]);
  client.supportsExperimental = capability => capability === "threadCreationReceiptsV1";
  client.request = vi.fn(async (method: string) => {
    if (method === "thread/start") return start;
    if (method === "turn/start") return { turn: { id: "turn-created", status: "running" } };
    return {};
  }) as never;
  const connector = vi.fn(async () => client as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const input = { profile, server, cwd: "/workspace", prompt: "create once" };
  return { client, connector, input, registry: new TaskRuntimeRegistry(), resolve: () => resolve({ thread: { id: "shared-created", cwd: "/workspace" } }) };
}
beforeEach(() => { storage.clear(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks(); retryCreationCleanup(32); });

it("releases an old claim without closing the current adopted shared job", async () => {
  const f = fixture();
  const old = TaskRuntime.claimCreation(f.input, f.registry);
  old.release(); old.release(); // A leaves before the returning A consumer exists.
  const current = TaskRuntime.claimCreation({ ...f.input }, f.registry);
  expect(old.result).toBe(current.result);
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledWith("thread/start", expect.anything()));
  f.resolve();
  const runtime = await current.result;
  const close = vi.spyOn(runtime, "close");
  const registry = f.registry;
  expect(current.adopt(registry, profile.id, server.id)).toBe(true);
  expect(current.adopt(registry, profile.id, server.id)).toBe(true);
  current.release();
  expect(old.adopt(registry, profile.id, server.id)).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(runtime.isDisposed()).toBe(false);
  expect(registry.get(profile.id, server.id, "shared-created")).toBe(runtime);
  expect(f.connector).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.client.request).mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
  expect(vi.mocked(f.client.request).mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  registry.removeProfile(profile.id);
});

it("closes a late result exactly once when every claim released before resolution", async () => {
  const f = fixture();
  const first = TaskRuntime.claimCreation(f.input, f.registry);
  const second = TaskRuntime.claimCreation(f.input, f.registry);
  first.release(); second.release(); first.release();
  const clientClose = vi.spyOn(f.client, "close");
  f.resolve();
  const runtime = await first.result;
  expect(runtime.isDisposed()).toBe(true);
  expect(clientClose).toHaveBeenCalledTimes(1);
  second.release();
  expect(clientClose).toHaveBeenCalledTimes(1);
  expect(first.adopt(new TaskRuntimeRegistry(), profile.id, server.id)).toBe(false);
});

it("closes only after the final unadopted resolved claim releases", async () => {
  const f = fixture();
  const first = TaskRuntime.claimCreation(f.input, f.registry);
  const second = TaskRuntime.claimCreation(f.input, f.registry);
  f.resolve();
  const runtime = await first.result;
  const close = vi.spyOn(runtime, "close");
  first.release(); expect(close).not.toHaveBeenCalled();
  second.release(); second.release(); expect(close).toHaveBeenCalledTimes(1);
  expect(runtime.isDisposed()).toBe(true);
});

it("preserves legacy shared Promise and caller-owned handoff while another claim releases", async () => {
  const f = fixture();
  const claim = TaskRuntime.claimCreation(f.input, f.registry);
  const first = TaskRuntime.create(f.input);
  const second = TaskRuntime.create(f.input);
  expect(first).toBe(second); expect(first).toBe(claim.result);
  claim.release(); f.resolve();
  const runtime = await first;
  expect(runtime.isDisposed()).toBe(false);
  runtime.close();
});

it("does not adopt before registry commit, and closes on release after precommit failure", async () => {
  const f = fixture();
  const claim = TaskRuntime.claimCreation(f.input, f.registry);
  f.resolve(); const runtime = await claim.result;
  const registry = f.registry;
  vi.spyOn(registry, "key").mockImplementation(() => { throw new Error("precommit key failed"); });
  expect(() => claim.adopt(registry, profile.id, server.id)).toThrow("precommit key failed");
  expect(runtime.isDisposed()).toBe(false);
  claim.release(); expect(runtime.isDisposed()).toBe(true);
});

it("keeps the committed runtime alive and diagnoses previous cleanup independently", async () => {
  const f = fixture();
  const registry = f.registry;
  const previous = TaskRuntime.demo("shared-created");
  registry.put(profile.id, server.id, previous);
  const previousClose = vi.spyOn(previous, "close").mockImplementation(() => { throw new Error("previous cleanup failed"); });
  const claim = TaskRuntime.claimCreation(f.input, f.registry);
  f.resolve(); const runtime = await claim.result;
  const close = vi.spyOn(runtime, "close");
  expect(claim.adopt(registry, profile.id, server.id)).toBe(true);
  expect(registry.getPendingCleanupCount()).toBe(1);
  expect(console.warn).toHaveBeenCalledWith("task_registry_cleanup_pending:previous");
  expect(registry.get(profile.id, server.id, "shared-created")).toBe(runtime);
  claim.release(); expect(close).not.toHaveBeenCalled();
  expect(runtime.isDisposed()).toBe(false);
  previousClose.mockRestore(); registry.retryCleanup();
  expect(registry.getPendingCleanupCount()).toBe(0);
  expect(previous.closeComplete).toBe(true); registry.removeProfile(profile.id);
});

it("protects the committed runtime and retains failed eviction cleanup for retry", async () => {
  const f = fixture();
  const registry = f.registry;
  const old = Array.from({ length: 8 }, (_, i) => TaskRuntime.demo(`idle-${i}`));
  for (const runtime of old) registry.put(profile.id, server.id, runtime);
  const failed = vi.spyOn(old[0], "close").mockImplementation(() => { throw new Error("eviction cleanup failed"); });
  const claim = TaskRuntime.claimCreation(f.input, f.registry);
  f.resolve(); const runtime = await claim.result;
  expect(claim.adopt(registry, profile.id, server.id)).toBe(true);
  expect(registry.getPendingCleanupCount()).toBe(1);
  expect(console.warn).toHaveBeenCalledWith("task_registry_cleanup_pending:eviction");
  claim.release();
  expect(runtime.isDisposed()).toBe(false);
  expect(registry.get(profile.id, server.id, "shared-created")).toBe(runtime);
  failed.mockRestore(); registry.retryCleanup();
  expect(registry.getPendingCleanupCount()).toBe(0); registry.removeProfile(profile.id);
});

it("preserves old three-argument precommit failure and rejects disposed registration", () => {
  const registry = new TaskRuntimeRegistry();
  const previous = TaskRuntime.demo("same-thread");
  const next = TaskRuntime.demo("same-thread");
  registry.put(profile.id, server.id, previous);
  const close = vi.spyOn(previous, "close").mockImplementation(() => { throw new Error("legacy cleanup failed"); });
  expect(() => registry.put(profile.id, server.id, next)).toThrow("legacy cleanup failed");
  expect(registry.get(profile.id, server.id, "same-thread")).toBe(previous);
  next.close();
  expect(() => registry.put(profile.id, server.id, next)).toThrow("已关闭");
  close.mockRestore(); registry.removeProfile(profile.id);
});

it("rejects a different in-flight intent without disposing the valid claimant", async () => {
  const f = fixture();
  const claim = TaskRuntime.claimCreation(f.input, f.registry);
  const conflict = TaskRuntime.claimCreation({ ...f.input, prompt: "another intent" }, f.registry);
  await expect(conflict.result).rejects.toThrow("仍在处理中"); conflict.release();
  f.resolve(); const runtime = await claim.result;
  expect(runtime.isDisposed()).toBe(false);
  const registry = f.registry; claim.adopt(registry, profile.id, server.id); claim.release();
  registry.removeProfile(profile.id);
});

it("isolates orphan close failure and retries the exact runtime without losing another claim", async () => {
  const orphan = TaskRuntime.demo("orphan-cleanup");
  const close = vi.spyOn(orphan, "close").mockImplementationOnce(() => { throw new Error("secret-close-error"); });
  const released = claimCreationResult(Promise.resolve(orphan), new TaskRuntimeRegistry().reserveCreation());
  released.release();
  await released.result;
  expect(creationCleanupStatus()).toEqual({ reserved: 1, pending: 1 });
  expect(close).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith("task_creation_cleanup_pending");
  const other = TaskRuntime.demo("another-cleanup");
  const otherClaim = claimCreationResult(Promise.resolve(other), new TaskRuntimeRegistry().reserveCreation());
  await otherClaim.result; otherClaim.release();
  expect(other.closeComplete).toBe(true);
  retryCreationCleanup();
  expect(close).toHaveBeenCalledTimes(2);
  expect(orphan.closeComplete).toBe(true);
  expect(creationCleanupStatus()).toEqual({ reserved: 0, pending: 0 });
  retryCreationCleanup(); expect(close).toHaveBeenCalledTimes(2);
});

it("retains a failed pre-result runtime cleanup and preserves the original creation error", async () => {
  const f = fixture();
  f.client.request = vi.fn(async (method: string) => {
    if (method === "thread/start") return { thread: { id: "rejected-turn", cwd: "/workspace" } };
    if (method === "turn/start") throw new Error("original turn rejection");
    return {};
  }) as never;
  const failed = vi.spyOn(f.client, "close").mockImplementation(() => { throw new Error("close error"); });
  const claim = TaskRuntime.claimCreation(f.input, f.registry);
  await expect(claim.result).rejects.toThrow("original turn rejection");
  claim.release();
  expect(creationCleanupStatus()).toEqual({ reserved: 1, pending: 1 });
  failed.mockRestore(); retryCreationCleanup();
  expect(f.client.closed).toBe(true);
  expect(creationCleanupStatus()).toEqual({ reserved: 0, pending: 0 });
});

it("bounds failed orphan references and rejects new creation before connector dispatch", async () => {
  const closes: Array<{ mockRestore(): void }> = [];
  for (let i = 0; i < 32; i += 1) {
    const runtime = TaskRuntime.demo(`budget-${i}`);
    closes.push(vi.spyOn(runtime, "close").mockImplementation(() => { throw new Error("busy resource"); }));
    const claim = claimCreationResult(Promise.resolve(runtime), new TaskRuntimeRegistry().reserveCreation());
    await claim.result; claim.release();
  }
  expect(creationCleanupStatus()).toEqual({ reserved: 32, pending: 32 });
  const f = fixture();
  expect(() => TaskRuntime.claimCreation(f.input, f.registry)).toThrow("本机任务资源清理尚未完成");
  expect(f.connector).not.toHaveBeenCalled();
  for (const close of closes) close.mockRestore();
  retryCreationCleanup(32);
  expect(creationCleanupStatus()).toEqual({ reserved: 0, pending: 0 });
});

it("bounds registry cleanup jobs without dropping registry references at capacity", () => {
  const registry = new TaskRuntimeRegistry();
  const failedCloses: Array<{ mockRestore(): void }> = [];
  for (let i = 0; i < 32; i += 1) {
    const old = TaskRuntime.demo(`registry-budget-${i}`);
    registry.put(profile.id, server.id, old);
    failedCloses.push(vi.spyOn(old, "close").mockImplementation(() => { throw new Error("busy old resource"); }));
    const replacement = TaskRuntime.demo(`registry-budget-${i}`);
    replacement.patch({ running: true });
    registry.put(profile.id, server.id, replacement, () => {});
  }
  expect(registry.getPendingCleanupCount()).toBe(32);
  const f = fixture();
  expect(() => TaskRuntime.claimCreation(f.input, registry)).toThrow("本机任务资源清理尚未完成");
  expect(f.connector).not.toHaveBeenCalled();
  expect(f.client.request).not.toHaveBeenCalled();
  const blocked = TaskRuntime.demo("blocked-new");
  const registered = vi.fn();
  expect(() => registry.put(profile.id, server.id, blocked, registered)).toThrow("本机任务资源清理尚未完成");
  expect(registered).not.toHaveBeenCalled();
  expect(registry.get(profile.id, server.id, "blocked-new")).toBeUndefined();
  expect(registry.get(profile.id, server.id, "registry-budget-31")).toBeDefined();
  for (const close of failedCloses) close.mockRestore();
  registry.retryCleanup(32); expect(registry.getPendingCleanupCount()).toBe(0);
  blocked.close(); registry.removeProfile(profile.id);
});

it("protects a pre-wire registry reservation when unrelated cleanup fills the remaining capacity", async () => {
  const f = fixture();
  const registry = f.registry;
  const claim = TaskRuntime.claimCreation(f.input, registry);
  const closes: Array<{ mockRestore(): void }> = [];
  for (let i = 0; i < 31; i += 1) {
    const old = TaskRuntime.demo(`other-pending-${i}`);
    registry.put(profile.id, server.id, old);
    closes.push(vi.spyOn(old, "close").mockImplementation(() => { throw new Error("busy other"); }));
    const next = TaskRuntime.demo(`other-pending-${i}`); next.patch({ running: true });
    registry.put(profile.id, server.id, next, () => {});
  }
  expect(registry.getPendingCleanupCount()).toBe(31);
  expect(() => registry.reserveCreation()).toThrow("本机任务资源清理尚未完成");
  f.resolve(); const runtime = await claim.result;
  expect(claim.adopt(registry, profile.id, server.id)).toBe(true);
  claim.release();
  expect(runtime.isDisposed()).toBe(false);
  expect(registry.get(profile.id, server.id, "shared-created")).toBe(runtime);
  for (const close of closes) close.mockRestore();
  registry.retryCleanup(32); registry.removeProfile(profile.id);
});
