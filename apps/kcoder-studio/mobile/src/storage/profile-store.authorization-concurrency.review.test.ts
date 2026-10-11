import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import {
  WORKSPACE_READ_V2,
  WORKSPACE_SCOPE_V2,
  workspaceParamsDigestV2,
  type WorkspaceMutationMethodV2,
} from "@/protocol/workspace-operation-receipts-v2";

const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const LEGACY_WEB_PROFILE_KEY = "kcoder-studio-mobile:gateway-profiles:v1";
const PROFILE_INDEX_LOCK = "kcoder-mobile:gateway-profile-index";
const workspaceScopeV2 = {
  version: 2 as const,
  rootId: "a".repeat(64),
  scopeId: "b".repeat(64),
  familyId: "c".repeat(64),
};

function readyWorkspaceMutationV2(
  method: WorkspaceMutationMethodV2,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const workspacePath = method === "runtime.worktrees.prepareV2"
    ? String(result.path)
    : String(result.workspacePath);
  return {
    scope: workspaceScopeV2,
    receipt: {
      clientRequestId: String(params.clientRequestId),
      method,
      paramsDigest: workspaceParamsDigestV2(method, params),
      status: "ready",
      workspacePath,
    },
    result,
  };
}

// Storage and RPC transport are controlled test boundaries; profile persistence,
// authorization fencing, migration, coordinator, and workspace operation code stay real.

const shared = vi.hoisted(() => ({
  platformOS: "android" as "android" | "web",
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  connector: null as null | (() => Promise<unknown>),
  onConnectorStart: null as null | (() => void),
  rpcHandler: null as null | ((method: string, params: unknown) => Promise<unknown>),
  requestMethods: [] as string[],
  closeCount: 0,
  secureReadGates: [] as Array<{ key: string; entered(): void; wait: Promise<void>; release(): void; claimed: boolean }>,
  lockTails: new Map<string, Promise<void>>(),
  lockStats: new Map<string, { requests: number; queued: number; active: number }>(),
  lockWaiters: new Map<string, () => void>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getAllKeys: async () => [...shared.asyncValues.keys()],
  getItem: async (key: string) => shared.asyncValues.get(key) ?? null,
  setItem: async (key: string, value: string) => { shared.asyncValues.set(key, value); },
  removeItem: async (key: string) => { shared.asyncValues.delete(key); },
  multiRemove: async (keys: string[]) => { for (const key of keys) shared.asyncValues.delete(key); },
} }));

vi.mock("./secure", () => ({
  getSecureValue: async (key: string) => {
    // localStorage.getItem is synchronous: preserve the value observed at the
    // read boundary even when the test pauses the caller before its await resumes.
    const snapshot = shared.secureValues.get(key) ?? null;
    const gate = shared.secureReadGates.find(candidate => candidate.key === key && !candidate.claimed);
    if (gate) {
      gate.claimed = true;
      gate.entered();
      await gate.wait;
    }
    return snapshot;
  },
  setSecureValue: async (key: string, value: string) => { shared.secureValues.set(key, value); },
  deleteSecureValue: async (key: string) => { shared.secureValues.delete(key); },
}));

vi.mock("react-native", () => ({ Platform: { get OS() { return shared.platformOS; } } }));
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: async (profile: GatewayProfile) => profile }));
vi.mock("@/runtime/task-runtime/connectionFactory", () => ({
  taskClientConnector: async () => {
    shared.onConnectorStart?.();
    if (!shared.connector) throw new Error("review connector was not configured");
    return shared.connector();
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("authorization review synchronization gate timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makeProfile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    id: "profile-native-fence-review",
    label: "Private authorization review",
    baseUrl: "https://gateway.review.invalid/g/route-a",
    accessToken: "review-access-a",
    rpcToken: "review-rpc-a",
    refreshToken: "review-refresh-a",
    expiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 60 * 60_000,
    authorizationGeneration: "generation-a",
    authMode: "device",
    deviceId: "device-a",
    ...overrides,
  };
}

const server: KCoderServer = {
  id: "server-review",
  label: "Private review server",
  description: "Authorization ownership fixture",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/private/review-workspace",
  command: "kcoder",
};

function makeClient() {
  return {
    supportsExperimental: (_name: string) => true,
    request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
      shared.requestMethods.push(method);
      if (!shared.rpcHandler) throw new Error("review RPC handler was not configured");
      return await shared.rpcHandler(method, params) as T;
    },
    close: () => { shared.closeCount += 1; },
  };
}

async function loadRealm() {
  vi.resetModules();
  const [profileStore, contextLock, coordinator, removeProfile, workspacePreferences, workspaceRuntime, fence, pendingOperations] = await Promise.all([
    import("./profile-store"),
    import("./context-lock"),
    import("@/state/profile-coordinator"),
    import("@/state/remove-gateway-profile"),
    import("./workspace-preferences"),
    import("@/runtime/task-runtime/workspaces"),
    import("./workspace-profile-fence"),
    import("./pending-workspace-operation-v2"),
  ]);
  return { profileStore, contextLock, coordinator, removeProfile, workspacePreferences, workspaceRuntime, fence, pendingOperations };
}

function coordinatorFor(realm: Awaited<ReturnType<typeof loadRealm>>) {
  const coordinator = new realm.coordinator.ProfileCoordinator({
    reload: realm.profileStore.loadProfiles,
    serialize: <T>(operation: () => Promise<T>) => realm.contextLock.withLocalIdentityLock("gateway-profile-index", operation, false),
  });
  return realm.profileStore.loadProfiles().then((snapshot) => {
    coordinator.hydrate(snapshot);
    return coordinator;
  });
}

async function persistNativeSnapshot(
  realm: Awaited<ReturnType<typeof loadRealm>>,
  profiles: GatewayProfile[],
  activeId: string | null,
): Promise<void> {
  await realm.contextLock.withLocalIdentityLock(
    "gateway-profile-index",
    () => realm.profileStore.persistProfiles(profiles, activeId),
    false,
  );
}

function profileSummary(snapshot: { profiles: GatewayProfile[]; activeId: string | null }) {
  return {
    activeId: snapshot.activeId,
    profiles: snapshot.profiles.map(({ id, baseUrl, deviceId, authorizationGeneration }) => ({ id, baseUrl, deviceId, authorizationGeneration }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function installSharedWebLocks(): void {
  // This API scheduler serializes actual product lock callbacks across two
  // module realms. It is contract evidence, not a Chromium/WebLocks run.
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { locks: { request: async <T>(
    name: string,
    _options: { mode: "exclusive" },
    operation: () => Promise<T>,
  ): Promise<T> => {
    const stats = shared.lockStats.get(name) ?? { requests: 0, queued: 0, active: 0 };
    stats.requests += 1;
    shared.lockStats.set(name, stats);
    shared.lockWaiters.get(`${name}:${stats.requests}`)?.();

    const previous = shared.lockTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => {}).then(() => turn);
    shared.lockTails.set(name, current);
    stats.queued += 1;
    await previous.catch(() => {});
    stats.queued -= 1;
    stats.active += 1;
    try {
      return await operation();
    } finally {
      stats.active -= 1;
      release();
      if (shared.lockTails.get(name) === current) shared.lockTails.delete(name);
    }
  } } });
}

function observeLockRequest(name: string, requestNumber: number) {
  const stats = shared.lockStats.get(name);
  if ((stats?.requests ?? 0) >= requestNumber) return { promise: Promise.resolve(), cancel: () => {} };
  const gate = deferred<void>();
  const key = `${name}:${requestNumber}`;
  const notify = () => gate.resolve(undefined);
  shared.lockWaiters.set(key, notify);
  return {
    promise: gate.promise,
    cancel: () => { if (shared.lockWaiters.get(key) === notify) shared.lockWaiters.delete(key); },
  };
}

function gateNextSecureRead(key: string) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const gate = {
    key,
    entered: () => entered.resolve(undefined),
    wait: release.promise,
    release: () => release.resolve(undefined),
    claimed: false,
  };
  shared.secureReadGates.push(gate);
  return { entered: entered.promise, release: () => release.resolve(undefined) };
}

function installWorkspaceRemovalEffects(realm: Awaited<ReturnType<typeof loadRealm>>) {
  return {
    setProfiles: () => {},
    setActiveId: () => {},
    removeProfileRuntimes: () => {},
    clearRuntime: () => {},
    markProfileStateRemoval: (id: string) => realm.workspacePreferences.markWorkspaceStateRemoval(id),
  };
}

afterEach(() => {
  for (const gate of shared.secureReadGates) gate.release();
  shared.secureReadGates = [];
  shared.asyncValues.clear();
  shared.secureValues.clear();
  shared.connector = null;
  shared.onConnectorStart = null;
  shared.rpcHandler = null;
  shared.requestMethods = [];
  shared.closeCount = 0;
  shared.lockTails.clear();
  shared.lockStats.clear();
  shared.lockWaiters.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const immutableScopeReplacements: Array<{ name: string; patch: Partial<GatewayProfile> }> = [
  { name: "route", patch: { baseUrl: "https://gateway.review.invalid/g/route-b" } },
  { name: "device", patch: { deviceId: "device-b" } },
  { name: "authorization generation", patch: { authorizationGeneration: "generation-b" } },
];

it.each(immutableScopeReplacements)("Native fences stale open and worktree sends after same-ID $name replacement", async ({ patch }) => {
  shared.platformOS = "android";
  const realm = await loadRealm();
  const original = makeProfile();
  await persistNativeSnapshot(realm, [original], original.id);

  const connectorStarted = deferred<void>();
  const connectorRelease = deferred<void>();
  shared.rpcHandler = async (method) => {
    if (method === "runtime.workspaces.open") return { workspacePath: "/private/review-workspace/open" };
    if (method === "runtime.worktrees.prepare") return { success: true, path: "/private/review-workspace/worktree" };
    throw new Error("unexpected RPC in stale-scope review fixture");
  };
  shared.onConnectorStart = () => connectorStarted.resolve(undefined);
  shared.connector = async () => {
    await connectorRelease.promise;
    return makeClient();
  };

  let opening: Promise<unknown> | undefined;
  try {
    opening = realm.workspaceRuntime.openWorkspaceWithReceipt(original, server, "/private/review-workspace/open");
    await within(connectorStarted.promise);
    const replacement = { ...original, ...patch, id: original.id };
    await persistNativeSnapshot(realm, [replacement], replacement.id);
    connectorRelease.resolve(undefined);
    await expect(opening).rejects.toBeInstanceOf(realm.fence.WorkspaceProfileFenceError);

    shared.onConnectorStart = null;
    shared.connector = async () => makeClient();
    await expect(realm.workspaceRuntime.prepareManagedWorktreeWithReceipt(
      original,
      server,
      "/private/review-workspace/source",
    )).rejects.toBeInstanceOf(realm.fence.WorkspaceProfileFenceError);
    expect(shared.requestMethods).toEqual([]);
    expect(shared.closeCount).toBe(2);
  } finally {
    connectorRelease.resolve(undefined);
    await opening?.catch(() => {});
  }
});

it("Native profile fence permits a held open after same-generation credential rotation", async () => {
  shared.platformOS = "android";
  const realm = await loadRealm();
  const original = makeProfile();
  await persistNativeSnapshot(realm, [original], original.id);

  const connectorStarted = deferred<void>();
  const connectorRelease = deferred<void>();
  shared.onConnectorStart = () => connectorStarted.resolve(undefined);
  shared.connector = async () => {
    await connectorRelease.promise;
    return makeClient();
  };
  shared.rpcHandler = async (method, rawParams) => {
    if (method === WORKSPACE_SCOPE_V2) return workspaceScopeV2;
    if (method === WORKSPACE_READ_V2) return { scope: workspaceScopeV2, receipt: null };
    if (method === "runtime.workspaces.openV2") {
      return readyWorkspaceMutationV2(method, rawParams as Record<string, unknown>, {
        workspacePath: "/private/review-workspace/open",
      });
    }
    throw new Error(`unexpected review RPC: ${method}`);
  };

  let opening: Promise<{ path: string }> | undefined;
  try {
    opening = realm.workspaceRuntime.openWorkspaceWithReceipt(original, server, "/private/review-workspace/open");
    await within(connectorStarted.promise);
    await persistNativeSnapshot(realm, [{
      ...original,
      accessToken: "review-access-rotated",
      rpcToken: "review-rpc-rotated",
      refreshToken: "review-refresh-rotated",
      expiresAt: Date.now() + 120_000,
      refreshExpiresAt: Date.now() + 2 * 60 * 60_000,
    }], original.id);
    connectorRelease.resolve(undefined);
    await expect(opening).resolves.toMatchObject({ path: "/private/review-workspace/open" });
    expect(shared.requestMethods).toEqual([
      WORKSPACE_SCOPE_V2,
      "runtime.workspaces.openV2",
      WORKSPACE_SCOPE_V2,
    ]);
  } finally {
    connectorRelease.resolve(undefined);
    await opening?.catch(() => {});
  }
});

it("Native removal preserves an unresolved V2 operation until its exact receipt is consumed", async () => {
  shared.platformOS = "android";
  const realm = await loadRealm();
  const profile = makeProfile();
  await persistNativeSnapshot(realm, [profile], profile.id);
  const response = deferred<unknown>();
  const requestSent = deferred<void>();
  let heldParams: Record<string, unknown> | undefined;
  shared.connector = async () => makeClient();
  shared.rpcHandler = async (method, rawParams) => {
    if (method === WORKSPACE_SCOPE_V2) return workspaceScopeV2;
    if (method === WORKSPACE_READ_V2) return { scope: workspaceScopeV2, receipt: null };
    if (method === "runtime.workspaces.openV2") {
      heldParams = rawParams as Record<string, unknown>;
      requestSent.resolve(undefined);
      return response.promise;
    }
    if (method === "runtime.worktrees.prepareV2") {
      const params = rawParams as Record<string, unknown>;
      const path = `/private/review-workspace/source/.worktrees/${String(params.worktreeId)}`;
      return readyWorkspaceMutationV2(method, params, { success: true, path });
    }
    throw new Error(`unexpected review RPC before held response release: ${method}`);
  };

  const coordinator = await coordinatorFor(realm);
  let operation: Promise<{ path: string; receipt: import("@/storage/pending-workspace-operation").WorkspaceOperationReceiptHandle }> | undefined;
  let removal: Promise<unknown> | undefined;
  try {
    operation = realm.workspaceRuntime.prepareManagedWorktreeWithReceipt(profile, server, "/private/review-workspace/source");
    await within(requestSent.promise);
    expect(shared.requestMethods).toEqual([
      WORKSPACE_SCOPE_V2,
      "runtime.workspaces.openV2",
    ]);

    removal = realm.removeProfile.removeGatewayProfile(profile.id, {
      coordinator,
      persist: realm.profileStore.persistProfiles,
      cleanupProfileState: realm.workspacePreferences.removeWorkspaceStatesForProfile,
      revokeSession: async () => {},
      effects: installWorkspaceRemovalEffects(realm),
    });
    await expect(removal).rejects.toThrow(/未确认/);
    expect(profileSummary(await realm.profileStore.loadProfiles())).toMatchObject({
      activeId: profile.id,
      profiles: [{ id: profile.id }],
    });
    expect(shared.asyncValues.get("kcoder-studio:mobile-workspace-operation:v2-index")).toContain(profile.id);

    response.resolve(readyWorkspaceMutationV2(
      "runtime.workspaces.openV2",
      heldParams!,
      { workspacePath: "/private/review-workspace/source" },
    ));
    const completed = await operation;
    expect(completed?.path).toMatch(/^\/private\/review-workspace\/source\/\.worktrees\//);
    await expect(realm.pendingOperations.acknowledgeWorkspaceOperationV2(
      completed!.receipt,
      { profile, server },
    )).resolves.toBe("consumed");

    removal = realm.removeProfile.removeGatewayProfile(profile.id, {
      coordinator,
      persist: realm.profileStore.persistProfiles,
      cleanupProfileState: realm.workspacePreferences.removeWorkspaceStatesForProfile,
      revokeSession: async () => {},
      effects: installWorkspaceRemovalEffects(realm),
    });
    await expect(removal).resolves.toMatchObject({ removed: true });
    expect(profileSummary(await realm.profileStore.loadProfiles())).toEqual({ activeId: null, profiles: [] });
    expect(shared.requestMethods).toEqual([
      WORKSPACE_SCOPE_V2,
      "runtime.workspaces.openV2",
      WORKSPACE_SCOPE_V2,
      "runtime.worktrees.prepareV2",
      WORKSPACE_SCOPE_V2,
      WORKSPACE_SCOPE_V2,
    ]);
    expect([...shared.asyncValues.keys()].some((key) => key.startsWith(`kcoder-studio:mobile-workspace-operation:v2:${encodeURIComponent(profile.id)}:`))).toBe(false);
  } finally {
    if (heldParams) response.resolve(readyWorkspaceMutationV2(
      "runtime.workspaces.openV2",
      heldParams,
      { workspacePath: "/private/review-workspace/source" },
    ));
    await operation?.catch(() => {});
    await removal?.catch(() => {});
  }
});

it("Web migration holds the shared profile lock and merges the queued connection against its committed winner", async () => {
  shared.platformOS = "web";
  installSharedWebLocks();
  const migrationRealm = await loadRealm();
  const connectionRealm = await loadRealm();
  const legacy = makeProfile({ id: "legacy-profile", baseUrl: "https://gateway.review.invalid/g/legacy" });
  const connection = makeProfile({ id: "new-profile", baseUrl: "https://gateway.review.invalid/g/new" });
  shared.secureValues.set(LEGACY_WEB_PROFILE_KEY, JSON.stringify({ profiles: [legacy], activeId: legacy.id }));
  const coordinator = await coordinatorFor(connectionRealm);
  const gate = gateNextSecureRead(PROFILE_INDEX_KEY);

  let migration: Promise<{ profiles: GatewayProfile[]; activeId: string | null } | null> | undefined;
  let commit: Promise<unknown> | undefined;
  try {
    const migrationRun = migrationRealm.profileStore.migrateLegacyWebProfiles();
    migration = migrationRun;
    await within(gate.entered);
    const migrationOwnsLock = (shared.lockStats.get(PROFILE_INDEX_LOCK)?.active ?? 0) > 0;
    const nextRequest = (shared.lockStats.get(PROFILE_INDEX_LOCK)?.requests ?? 0) + 1;
    const queued = observeLockRequest(PROFILE_INDEX_LOCK, nextRequest);
    const intent = coordinator.beginConnection();
    const connectionCommit = coordinator.commitConnection(intent, connection, connectionRealm.profileStore.persistProfiles);
    commit = connectionCommit;
    expect(shared.secureValues.has(PROFILE_INDEX_KEY)).toBe(false);

    if (migrationOwnsLock) await within(queued.promise);
    else await within(connectionCommit);
    queued.cancel();
    // With a correct migration lock, the connection is queued and migration
    // commits first. Without it, the connection commits while migration still
    // holds its captured empty read; releasing that stale read must not overwrite it.
    gate.release();
    const migrated = await within(migrationRun);
    await within(connectionCommit);
    const finalSnapshot = await connectionRealm.profileStore.loadProfiles();
    expect(migrated && profileSummary(migrated)).toEqual({ activeId: legacy.id, profiles: profileSummary({ profiles: [legacy], activeId: legacy.id }).profiles });
    expect(profileSummary(finalSnapshot)).toEqual({
      activeId: connection.id,
      profiles: profileSummary({ profiles: [legacy, connection], activeId: connection.id }).profiles,
    });
  } finally {
    gate.release();
    await Promise.allSettled([migration, commit].filter((item): item is Promise<unknown> => Boolean(item)));
  }
});

it("Web migration returns the new-profile winner when a connection commits first", async () => {
  shared.platformOS = "web";
  installSharedWebLocks();
  const migrationRealm = await loadRealm();
  const connectionRealm = await loadRealm();
  const legacy = makeProfile({ id: "legacy-profile", baseUrl: "https://gateway.review.invalid/g/legacy" });
  const connection = makeProfile({ id: "new-profile", baseUrl: "https://gateway.review.invalid/g/new" });
  shared.secureValues.set(LEGACY_WEB_PROFILE_KEY, JSON.stringify({ profiles: [legacy], activeId: legacy.id }));
  const coordinator = await coordinatorFor(connectionRealm);
  const connectionReadGate = gateNextSecureRead(PROFILE_INDEX_KEY);

  let migration: Promise<{ profiles: GatewayProfile[]; activeId: string | null } | null> | undefined;
  let commit: Promise<unknown> | undefined;
  try {
    const intent = coordinator.beginConnection();
    const connectionCommit = coordinator.commitConnection(intent, connection, connectionRealm.profileStore.persistProfiles);
    commit = connectionCommit;
    await within(connectionReadGate.entered);
    const migrationReadGate = gateNextSecureRead(LEGACY_WEB_PROFILE_KEY);
    const nextRequest = (shared.lockStats.get(PROFILE_INDEX_LOCK)?.requests ?? 0) + 1;
    const queued = observeLockRequest(PROFILE_INDEX_LOCK, nextRequest);
    const migrationRun = migrationRealm.profileStore.migrateLegacyWebProfiles();
    migration = migrationRun;

    const migrationStart = await Promise.race([
      queued.promise.then(() => "queued" as const),
      migrationReadGate.entered.then(() => "stale-read-started" as const),
    ]);
    queued.cancel();
    // A lock-capable migration queues before reading. An unprotected migration
    // captures the old empty value; both branches then let the connection commit
    // first so the final return/index assertions expose stale migration writes.
    connectionReadGate.release();
    await within(connectionCommit);
    if (migrationStart === "stale-read-started") migrationReadGate.release();
    const winnerBeforeMigrationReturns = await connectionRealm.profileStore.loadProfiles();
    const migrationWinner = await within(migrationRun);
    migrationReadGate.release();
    expect(migrationWinner).not.toBeNull();
    expect(profileSummary(migrationWinner!)).toEqual(profileSummary(winnerBeforeMigrationReturns));
    expect(profileSummary(migrationWinner!)).toEqual(profileSummary({ profiles: [connection], activeId: connection.id }));
    expect(profileSummary(await migrationRealm.profileStore.loadProfiles())).toEqual(profileSummary(winnerBeforeMigrationReturns));
  } finally {
    connectionReadGate.release();
    for (const gate of shared.secureReadGates) gate.release();
    await Promise.allSettled([migration, commit].filter((item): item is Promise<unknown> => Boolean(item)));
  }
});

it("Web migration preserves legacy bytes without Web Locks and migrates after locks become available", async () => {
  shared.platformOS = "web";
  const realm = await loadRealm();
  const legacy = makeProfile({ id: "legacy-profile", baseUrl: "https://gateway.review.invalid/g/legacy" });
  const legacyBytes = JSON.stringify({ profiles: [legacy], activeId: legacy.id });
  shared.secureValues.set(LEGACY_WEB_PROFILE_KEY, legacyBytes);
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", {});

  await expect(realm.profileStore.migrateLegacyWebProfiles()).rejects.toThrow(/Web Locks/);
  expect(shared.secureValues.get(LEGACY_WEB_PROFILE_KEY)).toBe(legacyBytes);
  expect(shared.secureValues.has(PROFILE_INDEX_KEY)).toBe(false);

  installSharedWebLocks();
  const migrated = await realm.profileStore.migrateLegacyWebProfiles();
  expect(migrated && profileSummary(migrated)).toEqual(profileSummary({ profiles: [legacy], activeId: legacy.id }));
  expect(shared.secureValues.has(LEGACY_WEB_PROFILE_KEY)).toBe(false);
  expect(profileSummary(await realm.profileStore.loadProfiles())).toEqual(profileSummary({ profiles: [legacy], activeId: legacy.id }));
});
