// Model-independent creation identity durability and interrupt confirmation boundaries.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
} }));
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { MobileRpcError } from "@/gateway/rpc";
beforeEach(() => storage.clear());
afterEach(() => taskRuntimeTestHelpers.resetConnector());
it("recovers a committed thread/start lost ACK using the durable same creation id", async () => {
  const client = new FakeClient([]);
  Object.assign(client, { supportsExperimental: (cap: string) => cap === "threadCreationReceiptsV1" });
  let id: unknown;
  client.request = vi.fn(async (method, params = {}) => {
    if (method === "thread/start") { id = params.clientRequestId; expect(storage.size).toBe(1); throw new MobileRpcError("lost ACK"); }
    if (method === "thread/creation/read") { expect(params.clientRequestId).toBe(id); return { receipt: { status: "ready", threadId: "created", thread: { id: "created" } } }; }
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  }) as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const runtime = await TaskRuntime.create({ profile, server, cwd: "/workspace", prompt: "synthetic" });
  expect(runtime.getSnapshot().threadId).toBe("created");
  expect(vi.mocked(client.request).mock.calls.filter((call: unknown[]) => call[0] === "thread/start")).toHaveLength(1);
  expect(storage.size).toBe(0); runtime.close();
});
it("an unknown creation survives reload and a second tap only reads the same receipt", async () => {
  const ids: unknown[] = [];
  const methods: string[] = [];
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => {
    const client = new FakeClient([]);
    Object.assign(client, { supportsExperimental: (cap: string) => cap === "threadCreationReceiptsV1" });
    client.request = vi.fn(async (method, params = {}) => {
      methods.push(method); ids.push(params.clientRequestId);
      if (method === "thread/start") throw new MobileRpcError("lost ACK");
      return { receipt: null };
    }) as never;
    return client as never;
  }) as never);
  const input = { profile, server, cwd: "/workspace", prompt: "synthetic" };
  await expect(TaskRuntime.create(input)).rejects.toThrow("创建结果仍未知");
  expect(storage.size).toBe(1);
  await expect(TaskRuntime.create(input)).rejects.toThrow("创建结果仍未知");
  expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
  expect(new Set(ids).size).toBe(1);
});
it("interrupt publishes pending immediately and ACK never claims terminal completion", async () => {
  let resolve!: () => void;
  const client = new FakeClient([]);
  client.request = vi.fn(() => new Promise<void>((done) => { resolve = done; })) as never;
  const runtime = TaskRuntime.demo("thread");
  runtime.attachClient(client as never);
  runtime.patch({ running: true, activeTurnId: "turn" });
  const pending = runtime.interrupt();
  expect(runtime.getSnapshot().stopRequestedTurnId).toBe("turn");
  await runtime.interrupt(); expect(client.request).toHaveBeenCalledOnce();
  resolve(); await pending;
  expect(runtime.getSnapshot().running).toBe(true);
  expect(runtime.getSnapshot().stopRequestedTurnId).toBe("turn");
  runtime.patch({ running: false, activeTurnId: null });
  expect(runtime.getSnapshot().stopRequestedTurnId).toBeUndefined(); runtime.close();
});
