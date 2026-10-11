import { afterEach, expect, it, vi } from "vitest";
import {
  WORKSPACE_READ_V2,
  WORKSPACE_RECEIPTS_V2,
  WORKSPACE_SCOPE_V2,
  workspaceParamsDigestV2,
  type WorkspaceMutationMethodV2,
} from "@/protocol/workspace-operation-receipts-v2";

const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";

const shared = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  failProfileIndexRead: false,
  lockTails: new Map<string, Promise<void>>(),
  activeLocks: new Set<string>(),
  cleanupGate: null as null | { wait: Promise<void>; entered(snapshot: string[]): void; calls: number; skip: number },
  onRpcSent: null as null | (() => void),
  heldRpc: null as null | { method: string; params: Record<string, unknown>; fencedAtDispatch: boolean; reply(): void },
  rpcMethods: [] as string[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getAllKeys: async () => {
    const snapshot = [...shared.asyncValues.keys()];
    const gate = shared.cleanupGate;
    if (gate) {
      gate.calls += 1;
      if (gate.calls > gate.skip) {
        shared.cleanupGate = null;
        gate.entered(snapshot);
        await gate.wait;
      }
    }
    return snapshot;
  },
  getItem: async (key: string) => shared.asyncValues.get(key) ?? null,
  setItem: async (key: string, value: string) => { shared.asyncValues.set(key, value); },
  removeItem: async (key: string) => { shared.asyncValues.delete(key); },
  multiRemove: async (keys: string[]) => { for (const key of keys) shared.asyncValues.delete(key); },
} }));

vi.mock("./secure", () => ({
  getSecureValue: async (key: string) => {
    if (key === PROFILE_INDEX_KEY && shared.failProfileIndexRead) throw new Error("private review index read failure");
    return shared.secureValues.get(key) ?? null;
  },
  setSecureValue: async (key: string, value: string) => { shared.secureValues.set(key, value); },
  deleteSecureValue: async (key: string) => { shared.secureValues.delete(key); },
}));

import type { GatewayProfile } from "@/gateway/types";
import { profile as fixtureProfile, server as fixtureServer } from "@/runtime/task-runtime/fixture.test-support";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value?: T | PromiseLike<T>) => resolve(value as T | PromiseLike<T>),
    reject,
  };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("review synchronization gate timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function installSharedWebLocks(): void {
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { locks: { request: async <T>(
    name: string,
    _options: { mode: "exclusive" },
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = shared.lockTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => turn);
    shared.lockTails.set(name, tail);
    await previous.catch(() => {});
    shared.activeLocks.add(name);
    try {
      return await operation();
    } finally {
      shared.activeLocks.delete(name);
      release();
      if (shared.lockTails.get(name) === tail) shared.lockTails.delete(name);
    }
  } } });
}

function installScriptedWebSocket(): void {
  const scope = {
    version: 2 as const,
    rootId: "a".repeat(64),
    scopeId: "b".repeat(64),
    familyId: "c".repeat(64),
  };
  const readyMutation = (
    method: WorkspaceMutationMethodV2,
    params: Record<string, unknown>,
  ) => {
    let result: Record<string, unknown>;
    let workspacePath: string;
    if (method === "runtime.worktrees.prepareV2") {
      workspacePath = `${String(params.sourcePath)}/.worktrees/${String(params.worktreeId)}`;
      result = { success: true, path: workspacePath };
    } else if (method === "runtime.workspaces.prepareV2") {
      workspacePath = String(params.workspacePath);
      result = { mapping: { workspacePath } };
    } else {
      workspacePath = String(params.workspacePath);
      result = { workspacePath };
    }
    return {
      scope,
      receipt: {
        clientRequestId: String(params.clientRequestId),
        method,
        paramsDigest: workspaceParamsDigestV2(method, params),
        status: "ready",
        workspacePath,
      },
      result,
    };
  };
  class ScriptedWebSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    constructor(_url: string, _protocols?: string | string[] | null) {
      queueMicrotask(() => {
        this.readyState = ScriptedWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(raw: string): void {
      const frame = JSON.parse(raw) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (frame.method) shared.rpcMethods.push(frame.method);
      if (frame.method === "initialize" && frame.id !== undefined) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { protocolVersion: "2026-07-27", capabilities: { experimental: { [WORKSPACE_RECEIPTS_V2]: true } } },
        }) }));
      } else if (frame.method === WORKSPACE_SCOPE_V2 && frame.id !== undefined) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: scope }) }));
      } else if (frame.method === WORKSPACE_READ_V2 && frame.id !== undefined) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { scope, receipt: null } }) }));
      } else if (frame.method && ["runtime.workspaces.openV2", "runtime.workspaces.prepareV2", "runtime.worktrees.prepareV2"].includes(frame.method) && frame.id !== undefined) {
        const method = frame.method as WorkspaceMutationMethodV2;
        const params = frame.params ?? {};
        const reply = () => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: readyMutation(method, params) }) });
        if (method === "runtime.workspaces.openV2" && shared.onRpcSent) {
          shared.heldRpc = {
            method,
            params: { ...params },
            fencedAtDispatch: shared.activeLocks.has("kcoder-mobile:gateway-profile-index"),
            reply,
          };
          shared.onRpcSent();
          shared.onRpcSent = null;
        } else {
          queueMicrotask(reply);
        }
      }
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  vi.stubGlobal("WebSocket", ScriptedWebSocket);
}

function makeProfile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    ...fixtureProfile,
    id: "profile-fence-review",
    label: "Private review profile",
    baseUrl: "https://gateway.review.invalid/g/review",
    accessToken: "synthetic-access-a",
    rpcToken: "synthetic-rpc-a",
    refreshToken: "synthetic-refresh-a",
    expiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 60 * 60_000,
    authMode: "device",
    deviceId: "device-fence-a",
    authorizationGeneration: "generation-fence-a",
    ...overrides,
  };
}

const server = { ...fixtureServer, id: "server-fence-review", workspacePath: "/private/review-workspace" };

async function loadRealm() {
  vi.resetModules();
  const [fence, profileStore, contextLock, coordinator, removeProfile, workspace, newPreferences, operations, pendingOperations, workspaceRuntime] = await Promise.all([
    import("./workspace-profile-fence"),
    import("./profile-store"),
    import("./context-lock"),
    import("@/state/profile-coordinator"),
    import("@/state/remove-gateway-profile"),
    import("./workspace-preferences"),
    import("./new-workspace-preferences"),
    import("./pending-workspace-operation"),
    import("./pending-workspace-operation-v2"),
    import("@/runtime/task-runtime/workspaces"),
  ]);
  return { fence, profileStore, contextLock, coordinator, removeProfile, workspace, newPreferences, operations, pendingOperations, workspaceRuntime };
}

function removalEffects(realm: Awaited<ReturnType<typeof loadRealm>>) {
  return {
    setProfiles: () => {},
    setActiveId: () => {},
    removeProfileRuntimes: () => {},
    clearRuntime: () => {},
    markProfileStateRemoval: (id: string) => realm.workspace.markWorkspaceStateRemoval(id),
  };
}

async function coordinatorFor(realm: Awaited<ReturnType<typeof loadRealm>>) {
  const serialize = <T>(operation: () => Promise<T>) =>
    realm.contextLock.withLocalIdentityLock("gateway-profile-index", operation, false);
  const coordinator = new realm.coordinator.ProfileCoordinator({
    reload: realm.profileStore.loadProfiles,
    serialize,
  });
  coordinator.hydrate(await realm.profileStore.loadProfiles());
  return coordinator;
}

async function removeProfile(realm: Awaited<ReturnType<typeof loadRealm>>, profileId: string) {
  const coordinator = await coordinatorFor(realm);
  return realm.removeProfile.removeGatewayProfile(profileId, {
    coordinator,
    persist: realm.profileStore.persistProfiles,
    cleanupProfileState: realm.workspace.removeWorkspaceStatesForProfile,
    effects: removalEffects(realm),
  });
}

afterEach(() => {
  shared.cleanupGate = null;
  shared.asyncValues.clear();
  shared.secureValues.clear();
  shared.failProfileIndexRead = false;
  shared.lockTails.clear();
  shared.activeLocks.clear();
  shared.onRpcSent = null;
  shared.heldRpc = null;
  shared.rpcMethods = [];
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("uses the shared profile index as a fail-closed fence and ignores routine credential rotation", async () => {
  installSharedWebLocks();
  const realm = await loadRealm();
  const profile = makeProfile();

  const rejectedSnapshots: Array<() => Promise<void>> = [
    async () => { shared.secureValues.delete(PROFILE_INDEX_KEY); },
    async () => { await realm.profileStore.persistProfiles([], null); },
    async () => {
      const current = JSON.parse(shared.secureValues.get(PROFILE_INDEX_KEY)!) as { profiles: unknown[]; activeId: string | null };
      current.profiles.push(current.profiles[0]);
      shared.secureValues.set(PROFILE_INDEX_KEY, JSON.stringify(current));
    },
    async () => { shared.secureValues.set(PROFILE_INDEX_KEY, "{"); },
    async () => {
      const current = JSON.parse(shared.secureValues.get(PROFILE_INDEX_KEY)!) as { profiles: unknown[]; activeId: string | null };
      current.profiles.push({ id: "malformed-row", baseUrl: null });
      shared.secureValues.set(PROFILE_INDEX_KEY, JSON.stringify(current));
    },
    async () => { shared.failProfileIndexRead = true; },
  ];

  for (const corrupt of rejectedSnapshots) {
    shared.failProfileIndexRead = false;
    await realm.profileStore.persistProfiles([profile], profile.id);
    const identity = realm.fence.captureWorkspaceProfileIdentity(profile);
    await corrupt();
    const write = vi.fn(async () => {});
    await expect(realm.fence.withWorkspaceProfileWrite(identity, write))
      .rejects.toBeInstanceOf(realm.fence.WorkspaceProfileFenceError);
    expect(write).not.toHaveBeenCalled();
  }

  for (const replacement of [
    { baseUrl: "https://other-gateway.invalid/g/review" },
    { deviceId: "device-fence-b" },
    { authorizationGeneration: "generation-fence-b" },
  ]) {
    shared.failProfileIndexRead = false;
    await realm.profileStore.persistProfiles([profile], profile.id);
    const oldIdentity = realm.fence.captureWorkspaceProfileIdentity(profile);
    await realm.profileStore.persistProfiles([{ ...profile, ...replacement }], profile.id);
    const write = vi.fn(async () => {});
    await expect(realm.fence.withWorkspaceProfileWrite(oldIdentity, write))
      .rejects.toBeInstanceOf(realm.fence.WorkspaceProfileFenceError);
    expect(write).not.toHaveBeenCalled();
  }

  shared.failProfileIndexRead = false;
  await realm.profileStore.persistProfiles([profile], profile.id);
  const identityWithoutWebLocks = realm.fence.captureWorkspaceProfileIdentity(profile);
  vi.stubGlobal("navigator", {});
  const noLockWrite = vi.fn(async () => {});
  await expect(realm.fence.withWorkspaceProfileWrite(identityWithoutWebLocks, noLockWrite))
    .rejects.toBeInstanceOf(realm.fence.WorkspaceProfileFenceError);
  expect(noLockWrite).not.toHaveBeenCalled();
  installSharedWebLocks();

  await realm.profileStore.persistProfiles([profile], profile.id);
  const identity = realm.fence.captureWorkspaceProfileIdentity(profile);
  await realm.profileStore.persistProfiles([{
    ...profile,
    accessToken: "synthetic-access-rotated",
    rpcToken: "synthetic-rpc-rotated",
    refreshToken: "synthetic-refresh-rotated",
    expiresAt: Date.now() + 120_000,
    refreshExpiresAt: Date.now() + 2 * 60 * 60_000,
  }], profile.id);
  const write = vi.fn(async () => {});
  await expect(realm.fence.withWorkspaceProfileWrite(identity, write)).resolves.toBeUndefined();
  expect(write).toHaveBeenCalledOnce();
});

it("commits profile removal before cleanup and fences a stale second realm during the held cleanup snapshot", async () => {
  installSharedWebLocks();
  installScriptedWebSocket();
  const tabA = await loadRealm();
  const tabB = await loadRealm();
  const profile = makeProfile();
  await tabA.profileStore.persistProfiles([profile], profile.id);
  const profileB = (await tabB.profileStore.loadProfiles()).profiles[0]!;
  const identityB = tabB.fence.captureWorkspaceProfileIdentity(profileB);
  const authorizationScope = tabB.workspace.workspaceStateAuthorizationScope(profileB, server);
  const stateKey = tabB.workspace.workspaceStateStorageKey(profile.id, server.id, "thread-fence-review", authorizationScope);
  const preferenceScope = JSON.stringify([authorizationScope, profileB.deviceId]);
  const preferenceKey = tabB.newPreferences.newWorkspacePreferenceKey(profile.id, server.id, preferenceScope);

  await tabB.workspace.saveWorkspaceState(profile.id, server.id, "thread-fence-review", { composerDraft: "old-tab draft" }, authorizationScope, identityB);
  await tabB.newPreferences.saveNewWorkspacePreference(profile.id, server.id, preferenceScope, { cwd: "/private/review-workspace", isolation: "local" });
  const confirmed = await tabB.workspaceRuntime.openWorkspaceWithReceipt(
    profileB,
    server,
    "/private/review-workspace/initial",
    true,
  );
  await expect(tabB.pendingOperations.acknowledgeWorkspaceOperationV2(
    confirmed.receipt,
    { profile: profileB, server },
  )).resolves.toBe("consumed");
  const originalReceipt = shared.asyncValues.get(confirmed.receipt.key)!;
  const getAllKeysEntered = deferred<string[]>();
  const releaseSnapshot = deferred<void>();
  // Removal scans V1, linked task handoffs, and V2 rows before the final
  // workspace-state cleanup snapshot. Hold that fourth scan, after commit.
  shared.cleanupGate = { wait: releaseSnapshot.promise, entered: getAllKeysEntered.resolve, calls: 0, skip: 3 };

  let removal: Promise<unknown> | undefined;
  try {
    removal = removeProfile(tabA, profile.id);
    const snapshot = await within(getAllKeysEntered.promise, 1_500);
    expect(snapshot).toContain(stateKey);
    expect(snapshot).toContain(preferenceKey);
    expect((await tabA.profileStore.loadProfiles()).profiles.some((item) => item.id === profile.id)).toBe(false);
    const receiptAtCleanup = shared.asyncValues.get(confirmed.receipt.key);

    await expect(within(tabB.pendingOperations.acknowledgeWorkspaceOperationV2(
      confirmed.receipt,
      { profile: profileB, server },
    ), 750)).resolves.toBe("unverified");
    expect(shared.asyncValues.get(confirmed.receipt.key)).toBe(receiptAtCleanup);
    expect(originalReceipt).toContain('"consumed":true');

    const staleStateWrite = tabB.workspace.saveWorkspaceState(profile.id, server.id, "thread-fence-review", { composerDraft: "must not land" }, authorizationScope, identityB);
    await expect(within(staleStateWrite, 750)).rejects.toBeInstanceOf(tabB.fence.WorkspaceProfileFenceError);
    const stalePreferenceWrite = tabB.newPreferences.saveNewWorkspacePreference(profile.id, server.id, preferenceScope, { cwd: "/private/late-write", isolation: "worktree" });
    await expect(within(stalePreferenceWrite, 750)).rejects.toBeInstanceOf(tabB.fence.WorkspaceProfileFenceError);

    await expect(within(tabB.workspaceRuntime.openWorkspaceWithReceipt(
      profileB,
      server,
      "/private/review-workspace/late",
    ), 750)).rejects.toBeInstanceOf(tabB.fence.WorkspaceProfileFenceError);
    expect(shared.asyncValues.has(confirmed.receipt.key)).toBe(false);
    expect([...shared.asyncValues.keys()].filter((key) => !snapshot.includes(key))).toEqual([]);
  } finally {
    releaseSnapshot.resolve();
    await removal?.catch(() => {});
  }
  expect(shared.asyncValues.has(confirmed.receipt.key)).toBe(false);

  expect([...shared.asyncValues.keys()].some((key) => key.startsWith(tabB.pendingOperations.pendingWorkspaceOperationPrefixV2(profile.id)))).toBe(false);
  expect([...shared.asyncValues.keys()].some((key) => key.startsWith(`kcoder-studio:mobile-new-workspace:v1:${encodeURIComponent(profile.id)}:`))).toBe(false);
});

it("keeps a dispatched V2 receipt charged while unknown and permits removal only after exact ACK", async () => {
  installSharedWebLocks();
  installScriptedWebSocket();
  const tabA = await loadRealm();
  const tabB = await loadRealm();
  const profile = makeProfile();
  await tabA.profileStore.persistProfiles([profile], profile.id);
  const profileB = (await tabB.profileStore.loadProfiles()).profiles[0]!;
  const dispatched = deferred<void>();
  shared.onRpcSent = dispatched.resolve;

  let operation: Promise<{ path: string; receipt: import("@/storage/pending-workspace-operation").WorkspaceOperationReceiptHandle }> | undefined;
  let removal: Promise<unknown> | undefined;
  try {
    operation = tabB.workspaceRuntime.openWorkspaceWithReceipt(profileB, server, "/private/review-workspace/slow");
    await dispatched.promise;
    expect(shared.heldRpc?.method).toBe("runtime.workspaces.openV2");
    expect(shared.heldRpc?.fencedAtDispatch).toBe(true);
    removal = removeProfile(tabA, profile.id);
    await expect(removal).rejects.toThrow(/未确认/);
    expect(await tabA.profileStore.loadProfiles()).toMatchObject({ profiles: [expect.objectContaining({ id: profile.id })], activeId: profile.id });
    const heldId = shared.heldRpc?.params.clientRequestId;
    expect(shared.asyncValues.get("kcoder-studio:mobile-workspace-operation:v2-index")).toContain(String(heldId));

    shared.heldRpc?.reply();
    const completed = await operation;
    expect(completed?.path).toBe("/private/review-workspace/slow");
    await expect(tabB.pendingOperations.acknowledgeWorkspaceOperationV2(
      completed!.receipt,
      { profile: profileB, server },
    )).resolves.toBe("consumed");

    removal = removeProfile(tabA, profile.id);
    await expect(removal).resolves.toMatchObject({ removed: true });
    expect(await tabA.profileStore.loadProfiles()).toMatchObject({ profiles: [], activeId: null });
    expect(shared.rpcMethods.filter(method => method === "runtime.workspaces.openV2")).toHaveLength(1);
    expect([...shared.asyncValues.keys()].some((key) => key.startsWith(tabB.pendingOperations.pendingWorkspaceOperationPrefixV2(profile.id)))).toBe(false);
  } finally {
    shared.heldRpc?.reply();
    await operation?.catch(() => {});
    await removal?.catch(() => {});
  }
});
