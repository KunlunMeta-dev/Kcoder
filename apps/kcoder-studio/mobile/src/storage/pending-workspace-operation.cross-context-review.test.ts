import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
// Two JS realms have separate module-level single-flight Maps but share Web AsyncStorage.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
beforeEach(() => installBrowserProfileFixture([{ ...fixtureProfile, authorizationGeneration: "same-family" }]));

const shared = vi.hoisted(() => ({
  values: new Map<string, string>(),
  keysSeen: [] as string[],
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => {
    shared.keysSeen.push(key);
    return shared.values.get(key) ?? null;
  }),
  setItem: vi.fn(async (key: string, value: string) => { shared.values.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { shared.values.delete(key); }),
} }));
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { profile as fixtureProfile, server as fixtureServer } from "@/runtime/task-runtime/fixture.test-support";

afterEach(() => {
  shared.values.clear(); shared.keysSeen.length = 0;
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("serializes the same intent across separate web-tab module realms and returns one durable result", async () => {
  const lockTails = new Map<string, Promise<void>>();
  const requestLock = vi.fn(async <T>(_name: string, _options: { mode: "exclusive" }, operation: () => Promise<T>): Promise<T> => {
    const previous = lockTails.get(_name) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => queued);
    lockTails.set(_name, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (lockTails.get(_name) === tail) lockTails.delete(_name); }
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { locks: { request: requestLock } });
  const profileOne: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const profileTwo: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };

  vi.resetModules();
  const firstRealm = await import("./pending-workspace-operation");
  vi.resetModules();
  const secondRealm = await import("./pending-workspace-operation");
  const ids: string[] = [];
  const makeInput = (profile: GatewayProfile) => ({
    profile, server, path: "/workspace/review", kind: "worktree" as const, intent: JSON.stringify(["/workspace/review", "main"]),
    mutate: async (id: string) => { ids.push(id); return `/workspace/review-${ids.length}`; },
    readback: async () => undefined,
  });

  const results = await Promise.all([
    firstRealm.recoverableWorkspaceOperation(makeInput(profileOne)),
    secondRealm.recoverableWorkspaceOperation(makeInput(profileTwo)),
  ]);

  const operationLocks = requestLock.mock.calls.filter(([key]) =>
    key.startsWith("kcoder-mobile:workspace-operation:"),
  );
  expect(operationLocks).toHaveLength(2);
  expect(operationLocks[0]?.[0]).toBe(operationLocks[1]?.[0]);
  expect(ids).toHaveLength(1);
  expect(new Set(ids).size).toBe(1);
  expect(new Set(shared.keysSeen).size).toBe(1);
  expect(results).toEqual(["/workspace/review-1", "/workspace/review-1"]);
  expect(shared.values.size).toBe(1);
  expect(JSON.parse([...shared.values.values()][0]!)).toMatchObject({ dispatched: true, completedAt: expect.any(Number), result: "/workspace/review-1" });
});

it("reuses a durable completed result after the operation module is reconstructed", async () => {
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const { pendingWorkspaceOperationPrefix, recoverableWorkspaceOperation } = await import("./pending-workspace-operation");
  const key = pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "create", pendingThreadCreationKey(profile, server, path),
  ]));
  const originalRecord = {
    id: "mobile-workspace-stable-review-id",
    intent: path,
    dispatched: true,
    completedAt: Date.now() - 60_000,
    result: "/workspace/review",
  };
  shared.values.set(key, JSON.stringify(originalRecord));
  const mutate = vi.fn(async () => "/workspace/duplicate");
  const readback = vi.fn(async () => undefined);

  vi.resetModules();
  const reconstructedRealm = await import("./pending-workspace-operation");
  const result = await reconstructedRealm.recoverableWorkspaceOperation({
    profile, server, path, kind: "create", intent: path, mutate, readback,
  });

  expect(result).toBe(originalRecord.result);
  expect(mutate).not.toHaveBeenCalled();
  expect(readback).not.toHaveBeenCalled();
  expect(JSON.parse(shared.values.get(key)!)).toEqual(originalRecord);
});

it("mints a new ID only after the prior completed result was consumed", async () => {
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const operations = await import("./pending-workspace-operation");
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "create", pendingThreadCreationKey(profile, server, path),
  ]));
  shared.values.set(key, JSON.stringify({
    id: "mobile-workspace-consumed-review-id", intent: path, dispatched: true,
    completedAt: Date.now() - 60_000, result: path, consumed: true,
  }));
  const ids: string[] = [];
  const mutate = vi.fn(async (id: string) => { ids.push(id); return "/workspace/recreated"; });

  const result = await operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "create", intent: path, newIntent: true,
    mutate, readback: vi.fn(async () => undefined),
  });

  expect(result).toBe("/workspace/recreated");
  expect(ids).toHaveLength(1);
  expect(ids[0]).not.toBe("mobile-workspace-consumed-review-id");
  expect(JSON.parse(shared.values.get(key)!).id).toBe(ids[0]);
});

it("does not let a requested new intent replay an older unknown operation", async () => {
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const operations = await import("./pending-workspace-operation");
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "create", pendingThreadCreationKey(profile, server, path),
  ]));
  const pending = { id: "mobile-workspace-unknown-review-id", intent: path, dispatched: true };
  shared.values.set(key, JSON.stringify(pending));
  const mutate = vi.fn(async () => "/workspace/duplicate");
  const readback = vi.fn(async (id: string) => {
    expect(id).toBe(pending.id);
    return undefined;
  });

  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "create", intent: path, newIntent: true, mutate, readback,
  })).rejects.toThrow("结果仍未知");

  expect(readback).toHaveBeenCalledOnce();
  expect(mutate).not.toHaveBeenCalled();
  expect(JSON.parse(shared.values.get(key)!)).toEqual(pending);
});

it("keeps the same ID after a remote mutation error with unknown receipt and never repeats mutate", async () => {
  const { MobileRpcError: RpcError } = await import("@/gateway/rpc");
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const intent = JSON.stringify([path, "main"]);
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const operations = await import("./pending-workspace-operation");
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "worktree", pendingThreadCreationKey(profile, server, path),
  ]));
  const ids: string[] = [];
  const mutate = vi.fn(async (id: string) => {
    ids.push(id);
    throw new RpcError("remote rejected after reservation", -32021, "remote", "unknown");
  });
  const readback = vi.fn(async () => undefined);

  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent, newIntent: true, mutate, readback,
  })).rejects.toThrow("结果仍未知");
  const pending = JSON.parse(shared.values.get(key)!);
  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent, newIntent: true,
    mutate: vi.fn(async () => { throw new Error("must not redispatch"); }),
    readback: vi.fn(async (id: string) => { expect(id).toBe(pending.id); return undefined; }),
  })).rejects.toThrow("结果仍未知");

  expect(ids).toHaveLength(1);
  expect(ids[0]).toBe(pending.id);
  expect(JSON.parse(shared.values.get(key)!)).toEqual(pending);
  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent: JSON.stringify([path, "new-ref"]), newIntent: true,
    mutate: vi.fn(async () => "/workspace/new-ref"),
    readback: vi.fn(async () => undefined),
  })).rejects.toThrow("原始参数核对");
});

it("retains a dispatched intent when receipt readback has transport or authorization failure", async () => {
  const { MobileRpcError: RpcError } = await import("@/gateway/rpc");
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const intent = JSON.stringify([path, "main"]);
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const operations = await import("./pending-workspace-operation");
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "worktree", pendingThreadCreationKey(profile, server, path),
  ]));
  const mutate = vi.fn(async () => { throw new RpcError("remote rejection", -32021, "remote", "unknown"); });
  const authFailure = new RpcError("authorization expired", 401, "transport", "unknown");

  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent, newIntent: true, mutate,
    readback: vi.fn(async () => { throw authFailure; }),
  })).rejects.toBe(authFailure);
  const retained = JSON.parse(shared.values.get(key)!);
  expect(retained).toMatchObject({ intent, dispatched: true, id: expect.any(String) });
  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent: JSON.stringify([path, "other-ref"]), newIntent: true,
    mutate: vi.fn(async () => "/workspace/other-ref"), readback: vi.fn(async () => null),
  })).rejects.toThrow("原始参数核对");
  expect(JSON.parse(shared.values.get(key)!)).toEqual(retained);
});

it("clears an intent after a remote error only when receipt lookup is authoritative null", async () => {
  const { MobileRpcError: RpcError } = await import("@/gateway/rpc");
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const firstIntent = JSON.stringify([path, "main"]);
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const operations = await import("./pending-workspace-operation");
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "worktree", pendingThreadCreationKey(profile, server, path),
  ]));
  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent: firstIntent, newIntent: true,
    mutate: vi.fn(async () => { throw new RpcError("definitely rejected", -32021, "remote", "unknown"); }),
    readback: vi.fn(async () => null),
  })).rejects.toThrow("definitely rejected");
  expect(shared.values.has(key)).toBe(false);

  const ids: string[] = [];
  const result = await operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent: JSON.stringify([path, "feature"]), newIntent: true,
    mutate: vi.fn(async (id: string) => { ids.push(id); return "/workspace/feature"; }),
    readback: vi.fn(async () => null),
  });
  expect(result).toBe("/workspace/feature");
  expect(ids).toHaveLength(1);
  expect(JSON.parse(shared.values.get(key)!).id).toBe(ids[0]);
});

it("allows a consumed old git ref to start a fresh ID but rejects changing an unconfirmed intent", async () => {
  const profile: GatewayProfile = { ...fixtureProfile, authorizationGeneration: "same-family" };
  const server: KCoderServer = { ...fixtureServer };
  const path = "/workspace/review";
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  const operations = await import("./pending-workspace-operation");
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "worktree", pendingThreadCreationKey(profile, server, path),
  ]));
  shared.values.set(key, JSON.stringify({
    id: "consumed-main-ref", intent: JSON.stringify([path, "main"]), dispatched: true,
    completedAt: Date.now() - 60_000, result: "/workspace/main", consumed: true,
  }));
  const ids: string[] = [];
  await operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent: JSON.stringify([path, "feature"]), newIntent: true,
    mutate: vi.fn(async (id: string) => { ids.push(id); return "/workspace/feature"; }),
    readback: vi.fn(async () => null),
  });
  expect(ids).toHaveLength(1);
  expect(ids[0]).not.toBe("consumed-main-ref");

  const pending = { id: "unconfirmed-main-ref", intent: JSON.stringify([path, "main"]), dispatched: true };
  shared.values.set(key, JSON.stringify(pending));
  const mutate = vi.fn(async () => "/workspace/wrong-ref");
  await expect(operations.recoverableWorkspaceOperation({
    profile, server, path, kind: "worktree", intent: JSON.stringify([path, "feature"]), newIntent: true,
    mutate, readback: vi.fn(async () => null),
  })).rejects.toThrow("原始参数核对");
  expect(mutate).not.toHaveBeenCalled();
  expect(JSON.parse(shared.values.get(key)!)).toEqual(pending);
});

beforeEach(() => installBrowserProfileFixture([{ ...fixtureProfile, authorizationGeneration: "same-family" }]));
