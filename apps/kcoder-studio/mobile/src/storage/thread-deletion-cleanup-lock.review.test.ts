import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  setItemGate: undefined as undefined | { entered: () => void; promise: Promise<void> },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      const gate = storage.setItemGate;
      if (gate) { gate.entered(); await gate.promise; }
      storage.values.set(key, value);
    },
    multiRemove: async (keys: string[]) => { keys.forEach((key) => storage.values.delete(key)); },
    removeItem: async (key: string) => { storage.values.delete(key); },
  },
}));

import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { workspaceStateAuthorizationScope } from "./workspace-preferences";
import {
  confirmThreadDeletionCleanup,
  installThreadDeletionCleanupAuthorityResolver,
  prepareThreadDeletionCleanup,
  retryThreadDeletionCleanup,
  threadDeletionCleanupKey,
} from "./thread-deletion-cleanup";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const readTickets = (profileId = profile.id) => JSON.parse(storage.values.get(threadDeletionCleanupKey(profileId)) ?? "[]") as Array<Record<string, unknown>>;
const cleanupConnectors = (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ request: vi.fn(request), close: vi.fn() })) as never);
};
const boundedRace = async <T>(promise: Promise<T>, milliseconds = 100): Promise<{ kind: "resolved"; value: T } | { kind: "timeout" }> =>
  Promise.race([
    promise.then((value) => ({ kind: "resolved" as const, value })),
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), milliseconds)),
  ]);

beforeEach(() => { storage.values.clear(); storage.setItemGate = undefined; });
let uninstallAuthority: (() => void) | undefined;
afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  uninstallAuthority?.();
  uninstallAuthority = undefined;
});

beforeEach(() => {
  uninstallAuthority = installThreadDeletionCleanupAuthorityResolver((profileId, serverId) =>
    profileId === profile.id && serverId === server.id ? workspaceStateAuthorizationScope(profile, server) : null);
});

it("new delete ticket commits while an older cleanup RPC is deferred, and both tickets merge safely", async () => {
  const oldTicket = await prepareThreadDeletionCleanup(profile, server, "old-thread", "/workspace", []);
  await confirmThreadDeletionCleanup(profile.id, oldTicket);

  const entered = deferred();
  const release = deferred();
  const request = vi.fn(async (method: string) => {
    if (method === "runtime.worktrees.conversations.remove") {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  });
  cleanupConnectors(request);

  const cleanup = retryThreadDeletionCleanup(profile, [server]);
  await entered.promise;
  let newDeleteId: string | undefined;
  const nextDelete = prepareThreadDeletionCleanup(profile, server, "new-thread", "/workspace", [])
    .then((id) => { newDeleteId = id; return id; });

  // A timer race distinguishes a storage lock held across the network await
  // from a merely unfinished chain of microtasks. The old RPC stays deferred.
  const whileRpcHeld = await boundedRace(nextDelete);
  const ticketsWhileHeld = readTickets();
  const bothPresentWhileHeld = ticketsWhileHeld.some((ticket) => ticket.threadId === "old-thread")
    && ticketsWhileHeld.some((ticket) => ticket.threadId === "new-thread");

  release.resolve();
  await cleanup;
  const resolvedId = await nextDelete;

  expect(whileRpcHeld.kind).toBe("resolved");
  expect(bothPresentWhileHeld).toBe(true);
  expect(newDeleteId).toBe(resolvedId);
  expect(readTickets().map((ticket) => ticket.threadId)).toEqual(["new-thread"]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("same-ticket paths added during a claimed cleanup survive late per-path ACK merge", async () => {
  const id = await prepareThreadDeletionCleanup(profile, server, "same-thread", undefined, ["/staged/a"]);
  await confirmThreadDeletionCleanup(profile.id, id);
  const entered = deferred();
  const release = deferred<{ cleared: string[]; pending: string[] }>();
  cleanupConnectors(async (method) => {
    if (method === "gateway/attachments/discardRetained") {
      entered.resolve();
      return release.promise;
    }
    return undefined;
  });

  const cleanup = retryThreadDeletionCleanup(profile, [server]);
  await entered.promise;
  const sameId = await prepareThreadDeletionCleanup(profile, server, "same-thread", undefined, ["/staged/b"]);
  expect(sameId).toBe(id);
  const inFlight = readTickets()[0];
  expect(inFlight.attachments).toEqual(["/staged/a", "/staged/b"]);
  expect(inFlight.claim).toBeDefined();

  release.resolve({ cleared: ["/staged/a"], pending: [] });
  await cleanup;
  const remaining = readTickets()[0];
  expect(remaining.confirmed).toBe(true);
  expect(remaining.attachments).toEqual(["/staged/b"]);
  expect(remaining.claim).toBeUndefined();
});

it("one live storage claim prevents a second retry worker, and late positive read does not erase confirmation", async () => {
  const id = await prepareThreadDeletionCleanup(profile, server, "confirm-race", undefined, []);
  const entered = deferred();
  const release = deferred();
  const request = vi.fn(async (method: string) => {
    if (method === "thread/read") {
      entered.resolve();
      await release.promise;
      return { thread: { id: "confirm-race" } };
    }
    return undefined;
  });
  cleanupConnectors(request);

  const first = retryThreadDeletionCleanup(profile, [server]);
  await entered.promise;
  await retryThreadDeletionCleanup(profile, [server]);
  await confirmThreadDeletionCleanup(profile.id, id);
  expect(readTickets()[0].confirmed).toBe(true);
  release.resolve();
  await first;

  const current = readTickets()[0];
  expect(current.id).toBe(id);
  expect(current.confirmed).toBe(true);
  expect(current.claim).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it("a failed first ticket backs off so a later ticket can be retried", async () => {
  await confirmThreadDeletionCleanup(profile.id, await prepareThreadDeletionCleanup(profile, server, "first", "/workspace/first", []));
  await confirmThreadDeletionCleanup(profile.id, await prepareThreadDeletionCleanup(profile, server, "second", "/workspace/second", []));
  const attempts: string[] = [];
  cleanupConnectors(async (method, params) => {
    if (method === "runtime.worktrees.conversations.remove") {
      attempts.push(String(params?.taskId));
      if (params?.taskId === "first") throw new Error("temporary registry failure");
    }
    return undefined;
  });

  await retryThreadDeletionCleanup(profile, [server]);
  expect(readTickets().find((ticket) => ticket.threadId === "first")?.failures).toBe(1);
  await retryThreadDeletionCleanup(profile, [server]);

  expect(attempts).toEqual(["first", "second"]);
  expect(readTickets().map((ticket) => ticket.threadId)).toEqual(["first"]);
});

it("immutable current-profile replacement cancels old-scope attachment cleanup", async () => {
  const id = await prepareThreadDeletionCleanup(profile, server, "scope-replaced", "/workspace", ["/staged/a"]);
  await confirmThreadDeletionCleanup(profile.id, id);
  let currentProfile = profile;
  let currentServer = server;
  uninstallAuthority = installThreadDeletionCleanupAuthorityResolver((profileId, serverId) => {
    if (profileId !== currentProfile.id || serverId !== currentServer.id) return null;
    return workspaceStateAuthorizationScope(currentProfile, currentServer);
  });

  const entered = deferred();
  const release = deferred<{ cleared: string[]; pending: string[] }>();
  const request = vi.fn(async (method: string) => {
    if (method === "gateway/attachments/discardRetained") {
      entered.resolve();
      return release.promise;
    }
    return undefined;
  });
  cleanupConnectors(request);

  const cleanup = retryThreadDeletionCleanup(profile, [server]);
  await entered.promise;
  // Replace the authoritative profile value as AppContext does; the operation
  // still holds its original `profile` argument and must re-resolve identity.
  currentProfile = { ...profile, authorizationGeneration: "replacement-generation" };
  release.resolve({ cleared: ["/staged/a"], pending: [] });
  await cleanup;

  const remaining = readTickets()[0];
  expect(remaining.threadId).toBe("scope-replaced");
  expect(remaining.confirmed).toBe(true);
  expect(remaining.attachments, "old-scope ACK cannot retire cleanup refs after identity replacement").toEqual(["/staged/a"]);
  expect(remaining.claim).toBeUndefined();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["gateway/attachments/discardRetained"]);
});

it("missing authority resolver fails closed without opening a connector", async () => {
  await confirmThreadDeletionCleanup(profile.id, await prepareThreadDeletionCleanup(profile, server, "no-authority", undefined, []));
  uninstallAuthority?.();
  uninstallAuthority = undefined;
  const connector = vi.fn();
  taskRuntimeTestHelpers.setConnector(connector as never);

  await retryThreadDeletionCleanup(profile, [server]);

  expect(connector).not.toHaveBeenCalled();
});

it("resolver unmount while the durable claim write is deferred cannot start network work", async () => {
  await confirmThreadDeletionCleanup(profile.id, await prepareThreadDeletionCleanup(profile, server, "authority-unmount", undefined, []));
  const entered = deferred();
  const release = deferred();
  storage.setItemGate = { entered: () => entered.resolve(), promise: release.promise };
  const connector = vi.fn();
  taskRuntimeTestHelpers.setConnector(connector as never);

  const retry = retryThreadDeletionCleanup(profile, [server]);
  await entered.promise;
  uninstallAuthority?.();
  uninstallAuthority = undefined;
  release.resolve();
  await retry;

  expect(connector).not.toHaveBeenCalled();
  expect(readTickets()[0].claim).toBeUndefined();
});
