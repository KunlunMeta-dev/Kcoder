// Model-independent creation receipt scope and duplicate-admission boundaries.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

import { MobileRpcError } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { pendingThreadCreationKey } from "@/storage/pending-thread-creation";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile as fixtureProfile,
  server as fixtureServer,
} from "./task-runtime/fixture.test-support";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const profile = (authorizationGeneration: string): GatewayProfile => ({
  ...fixtureProfile,
  authorizationGeneration,
});

const server = (overrides: Partial<KCoderServer> = {}): KCoderServer => ({
  ...fixtureServer,
  ...overrides,
});

beforeEach(() => storage.clear());
afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
});

it("keeps a pending receipt key across expiry/token renewal but separates auth generation and target route", () => {
  const originalProfile = {
    ...profile("principal-A"),
    accessToken: "old-access-secret",
    rpcToken: "old-rpc-secret",
    expiresAt: 1_000,
  };
  const renewedProfile = {
    ...originalProfile,
    accessToken: "rotated-access-secret",
    rpcToken: "rotated-rpc-secret",
    expiresAt: 2_000,
  };
  const key = pendingThreadCreationKey(originalProfile, fixtureServer, "/workspace");

  expect(pendingThreadCreationKey(renewedProfile, fixtureServer, "/workspace")).toBe(key);
  expect(
    pendingThreadCreationKey(
      { ...renewedProfile, authorizationGeneration: "principal-B" },
      fixtureServer,
      "/workspace",
    ),
  ).not.toBe(key);
  expect(
    pendingThreadCreationKey(originalProfile, server({ port: 2222 }), "/workspace"),
  ).not.toBe(key);
  expect(
    pendingThreadCreationKey(originalProfile, server({ command: "kcoder --profile other" }), "/workspace"),
  ).not.toBe(key);
  expect(key).not.toContain("old-access-secret");
  expect(key).not.toContain("old-rpc-secret");
});

it("coalesces concurrent same-intent create taps before a single thread/start", async () => {
  const allowStart = deferred<{ thread: { id: string; cwd: string } }>();
  const client = new FakeClient([]);
  client.supportsExperimental = (capability: string) =>
    capability === "threadCreationReceiptsV1";
  client.request = vi.fn(async (method: string, _params = {}) => {
    if (method === "thread/start") return allowStart.promise;
    if (method === "turn/start") return { turn: { id: "turn-created", status: "running" } };
    return {};
  }) as never;
  const connector = vi.fn(async () => client as never);
  taskRuntimeTestHelpers.setConnector(connector as never);
  const input = {
    profile: profile("principal-parallel"),
    server: fixtureServer,
    cwd: "/workspace",
    prompt: "create once",
  };

  const first = TaskRuntime.create(input);
  const second = TaskRuntime.create({ ...input });
  expect(second).toBe(first);
  await vi.waitFor(() =>
    expect(
      vi.mocked(client.request).mock.calls.filter((call) => call[0] === "thread/start"),
    ).toHaveLength(1),
  );
  expect(connector).toHaveBeenCalledTimes(1);
  allowStart.resolve({ thread: { id: "created-once", cwd: "/workspace" } });

  const [firstRuntime, secondRuntime] = await Promise.all([first, second]);
  expect(firstRuntime).toBe(secondRuntime);
  expect(firstRuntime.getSnapshot().threadId).toBe("created-once");
  expect(
    vi.mocked(client.request).mock.calls.filter((call) => call[0] === "thread/start"),
  ).toHaveLength(1);
  expect(
    vi.mocked(client.request).mock.calls.filter((call) => call[0] === "turn/start"),
  ).toHaveLength(1);
  firstRuntime.close();
});

it("retains an old-generation unknown intent without reading its receipt under a new identity", async () => {
  const oldProfile = profile("principal-before-reauthorization");
  const newProfile = {
    ...oldProfile,
    authorizationGeneration: "principal-after-reauthorization",
    accessToken: "new-account-access",
    rpcToken: "new-account-rpc",
    expiresAt: oldProfile.expiresAt + 60_000,
  };
  const oldClient = new FakeClient([]);
  oldClient.supportsExperimental = (capability: string) =>
    capability === "threadCreationReceiptsV1";
  oldClient.request = vi.fn(async (method: string) => {
    if (method === "thread/start") throw new MobileRpcError("lost creation ACK");
    if (method === "thread/creation/read") return { receipt: null };
    return {};
  }) as never;
  const newClient = new FakeClient([]);
  newClient.supportsExperimental = (capability: string) =>
    capability === "threadCreationReceiptsV1";
  newClient.request = vi.fn(async (method: string) => {
    if (method === "thread/start")
      return { thread: { id: "new-identity-thread", cwd: "/workspace" } };
    if (method === "turn/start")
      return { turn: { id: "new-identity-turn", status: "running" } };
    return {};
  }) as never;
  const clients = [oldClient, newClient];
  taskRuntimeTestHelpers.setConnector(
    vi.fn(async () => clients.shift() as never) as never,
  );
  const input = {
    server: fixtureServer,
    cwd: "/workspace",
    prompt: "same visible prompt",
  };
  const oldKey = pendingThreadCreationKey(oldProfile, fixtureServer, input.cwd);

  await expect(TaskRuntime.create({ ...input, profile: oldProfile })).rejects.toThrow(
    "创建结果仍未知",
  );
  expect(storage.has(oldKey)).toBe(true);

  const runtime = await TaskRuntime.create({ ...input, profile: newProfile });

  expect(
    vi.mocked(oldClient.request).mock.calls.filter((call) => call[0] === "thread/creation/read"),
  ).toHaveLength(1);
  expect(
    vi.mocked(newClient.request).mock.calls.some((call) => call[0] === "thread/creation/read"),
  ).toBe(false);
  expect(
    vi.mocked(newClient.request).mock.calls.filter((call) => call[0] === "thread/start"),
  ).toHaveLength(1);
  expect(storage.has(oldKey)).toBe(true);
  runtime.close();
});
