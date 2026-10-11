import { describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getAllKeys: vi.fn(async () => [...storage.values.keys()]),
    getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const key of keys) storage.values.delete(key);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.values.set(key, value);
    }),
  },
}));

import type { GatewayProfile } from "@/gateway/types";
import { TaskRuntimeRegistry } from "@/runtime/task-runtime/registry";
import {
  collapsedServerSectionsTestHelpers,
} from "@/storage/collapsed-server-sections";
import {
  isProfileStateRemovalPending,
  profileStateRemovalTestHelpers,
} from "@/storage/profile-state-removal";
import {
  loadWorkspaceState,
  markWorkspaceStateRemoval,
  removeWorkspaceStatesForProfile,
  workspaceStateStorageKey,
  workspacePreferencesTestHelpers,
} from "@/storage/workspace-preferences";
import { newWorkspacePreferencesTestHelpers } from "@/storage/new-workspace-preferences";
import { applyProfileConnectionEffects } from "./profile-connection-effects";
import { ProfileCoordinator } from "./profile-coordinator";
import { removeGatewayProfile } from "./remove-gateway-profile";

function profile(
  id: string,
  baseUrl = "https://gateway.test",
): GatewayProfile {
  return {
    id,
    label: id,
    baseUrl,
    accessToken: `access-${id}`,
    rpcToken: `rpc-${id}`,
    expiresAt: Date.now() + 60_000,
  };
}

function makeRuntime(close = vi.fn()) {
  return {
    getSnapshot: () => ({ threadId: "thread-1", running: true, interaction: null }),
    isDisposed: () => false,
    hasLiveTerminalSessions: () => false,
    close,
  };
}

function resetStorage(): void {
  storage.values.clear();
  collapsedServerSectionsTestHelpers.reset();
  newWorkspacePreferencesTestHelpers.reset();
  workspacePreferencesTestHelpers.reset();
  profileStateRemovalTestHelpers.reset();
}

describe("removeGatewayProfile", () => {
  it("持久化失败时保留 profile、runtime 和旧 draft，不启动清理或 revoke", async () => {
    resetStorage();
    const oldProfile = profile("old");
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [oldProfile], activeId: oldProfile.id });
    const registry = new TaskRuntimeRegistry();
    const closeRuntime = vi.fn();
    const runtime = makeRuntime(closeRuntime);
    registry.put(oldProfile.id, "local", runtime as never);
    const draftKey = workspaceStateStorageKey(oldProfile.id, "local", "thread-1");
    storage.values.set(draftKey, JSON.stringify({ activeTab: "agent", composerDraft: "keep me" }));
    const effects = {
      setProfiles: vi.fn(),
      setActiveId: vi.fn(),
      removeProfileRuntimes: (id: string) => registry.removeProfile(id),
      clearRuntime: vi.fn(),
      markProfileStateRemoval: markWorkspaceStateRemoval,
    };
    const cleanup = vi.fn(removeWorkspaceStatesForProfile);
    const revokeSession = vi.fn(async () => {});
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const started = new Promise<void>((resolve) => { persistStarted = resolve; });

    const removal = removeGatewayProfile(oldProfile.id, {
      coordinator,
      persist: async () => {
        persistStarted();
        await blocked;
        throw new Error("secure store write failed");
      },
      cleanupProfileState: cleanup,
      revokeSession,
      effects,
    });
    await started;
    releasePersist();

    await expect(removal).rejects.toThrow("secure store write failed");
    expect(coordinator.getSnapshot()).toMatchObject({
      profiles: [{ id: oldProfile.id }],
      activeId: oldProfile.id,
    });
    expect(registry.get(oldProfile.id, "local", "thread-1")).toBe(runtime);
    expect(closeRuntime).not.toHaveBeenCalled();
    expect(storage.values.get(draftKey)).toContain("keep me");
    await expect(loadWorkspaceState(oldProfile.id, "local", "thread-1"))
      .resolves.toMatchObject({ composerDraft: "keep me" });
    expect(isProfileStateRemovalPending(oldProfile.id)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
    expect(effects.setProfiles).not.toHaveBeenCalled();
    expect(effects.clearRuntime).not.toHaveBeenCalled();
  });

  it("清理旧 profile state 期间后发连接以新 id 激活，旧清理与 revoke 不会覆盖它", async () => {
    resetStorage();
    const oldProfile = profile("old");
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [oldProfile], activeId: oldProfile.id });
    const registry = new TaskRuntimeRegistry();
    const oldRuntime = makeRuntime();
    registry.put(oldProfile.id, "local", oldRuntime as never);

    let uiProfiles = [oldProfile];
    let uiActiveId: string | null = oldProfile.id;
    let clearRuntimeCalls = 0;
    const effects = {
      setProfiles(profiles: GatewayProfile[]) { uiProfiles = profiles; },
      setActiveId(id: string | null) { uiActiveId = id; },
      removeProfileRuntimes: (id: string) => registry.removeProfile(id),
      clearRuntime() { clearRuntimeCalls += 1; },
      markProfileStateRemoval: markWorkspaceStateRemoval,
    };
    let finishCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupHold = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let releasePersist!: () => void;
    let persistStarted!: () => void;
    const persistHold = new Promise<void>((resolve) => { releasePersist = resolve; });
    const persistStartedPromise = new Promise<void>((resolve) => { persistStarted = resolve; });

    const removal = removeGatewayProfile(oldProfile.id, {
      coordinator,
      persist: async () => {
        persistStarted();
        await persistHold;
      },
      cleanupProfileState: async (id, generation) => {
        cleanupStarted();
        await cleanupHold;
        await removeWorkspaceStatesForProfile(id, generation);
      },
      revokeSession: async () => {
        throw new Error("remote revoke failed");
      },
      effects,
    });
    await persistStartedPromise;

    const fresh = profile("fresh", oldProfile.baseUrl);
    const connectionIntent = coordinator.beginConnection();
    const connection = coordinator.commitConnection(
      connectionIntent,
      fresh,
      async () => {},
      undefined,
      (commit) => {
        applyProfileConnectionEffects(
          commit,
          fresh,
          () => coordinator.isLatestConnectionIntent(connectionIntent),
          effects,
        );
      },
    );
    releasePersist();

    await cleanupStartedPromise;
    const connectionResult = await connection;
    expect(connectionResult).toMatchObject({ committed: true, activated: true });
    expect(uiProfiles.map((item) => item.id)).toEqual([fresh.id]);
    expect(uiActiveId).toBe(fresh.id);
    expect(registry.get(oldProfile.id, "local", "thread-1")).toBeUndefined();

    const freshRuntime = makeRuntime();
    registry.put(fresh.id, "local", freshRuntime as never);
    const freshDraftKey = workspaceStateStorageKey(fresh.id, "local", "thread-2");
    storage.values.set(freshDraftKey, JSON.stringify({ activeTab: "agent", composerDraft: "fresh" }));
    finishCleanup();
    await removal;

    expect(coordinator.getSnapshot()).toMatchObject({
      profiles: [{ id: fresh.id }],
      activeId: fresh.id,
    });
    expect(uiProfiles.map((item) => item.id)).toEqual([fresh.id]);
    expect(uiActiveId).toBe(fresh.id);
    expect(clearRuntimeCalls).toBe(2);
    expect(registry.get(fresh.id, "local", "thread-1")).toBe(freshRuntime);
    expect(storage.values.get(freshDraftKey)).toContain("fresh");
  });
});
