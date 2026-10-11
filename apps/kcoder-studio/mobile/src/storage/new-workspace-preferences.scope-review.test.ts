import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
const secureValues = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getAllKeys: vi.fn(async () => [...storage.values.keys()]),
    getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const key of keys) storage.values.delete(key);
    }),
    removeItem: vi.fn(async (key: string) => { storage.values.delete(key); }),
    setItem: storage.setItem,
  },
}));
// This suite checks same-realm Native persistence and profile-removal ordering.
// Web profile-index metadata and cross-tab Web Locks are covered separately.
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return { ...actual, Platform: { ...actual.Platform, OS: "android" } };
});
vi.mock("./secure", () => ({
  getSecureValue: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setSecureValue: vi.fn(async (key: string, value: string) => { secureValues.set(key, value); }),
  deleteSecureValue: vi.fn(async (key: string) => { secureValues.delete(key); }),
}));

import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { PROFILE_INDEX_KEY } from "./profile-store";
import { collapsedServerSectionsTestHelpers } from "./collapsed-server-sections";
import {
  loadNewWorkspacePreference,
  newWorkspacePreferenceKey,
  newWorkspacePreferencePrefix,
  newWorkspacePreferencesTestHelpers,
  saveNewWorkspacePreference,
} from "./new-workspace-preferences";
import { profileStateRemovalTestHelpers } from "./profile-state-removal";
import { WorkspaceProfileFenceError } from "./workspace-profile-fence";
import {
  removeWorkspaceStatesForProfile,
  workspacePreferencesTestHelpers,
  workspaceStateAuthorizationScope,
} from "./workspace-preferences";

function profile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    id: "profile-1",
    label: "Gateway",
    baseUrl: "https://gateway.example.test",
    accessToken: "access-a",
    expiresAt: 10_000,
    rpcToken: "rpc-a",
    authorizationGeneration: "generation-a",
    authMode: "device",
    deviceId: "device-a",
    ...overrides,
  };
}

function server(overrides: Partial<KCoderServer> = {}): KCoderServer {
  return {
    id: "server-1",
    label: "Server",
    description: "Local test server",
    runtime: "kcoder",
    transport: "ssh",
    workspacePath: "/srv/project-root",
    host: "server.example.test",
    user: "kcoder",
    port: 22,
    command: "kcoder app-server",
    profile: "mobile",
    settingsFile: "/home/kcoder/.kcoder/settings.json",
    accountIdentity: { principalId: "principal-a", username: "operator", role: "member" },
    ...overrides,
  };
}

function preferenceScope(gateway: GatewayProfile, target: KCoderServer): string {
  return JSON.stringify([workspaceStateAuthorizationScope(gateway, target), gateway.deviceId]);
}

function seedProfileMetadata(currentProfile: GatewayProfile): void {
  const metadata = Object.fromEntries(Object.entries(currentProfile).filter(([key]) =>
    !["accessToken", "rpcToken", "refreshToken", "pendingRotationId"].includes(key),
  ));
  secureValues.set(PROFILE_INDEX_KEY, JSON.stringify({ profiles: [metadata], activeId: currentProfile.id }));
}

const scopeDimensions: Array<{ dimension: string; gateway: GatewayProfile; target: KCoderServer }> = [
  { dimension: "base URL", gateway: profile({ baseUrl: "https://other-gateway.example.test" }), target: server() },
  { dimension: "authorization generation", gateway: profile({ authorizationGeneration: "generation-b" }), target: server() },
  { dimension: "device ID", gateway: profile({ deviceId: "device-b" }), target: server() },
  { dimension: "principal", gateway: profile(), target: server({ accountIdentity: { principalId: "principal-b", username: "operator", role: "member" } }) },
  { dimension: "role", gateway: profile(), target: server({ accountIdentity: { principalId: "principal-a", username: "operator", role: "admin" } }) },
  { dimension: "workspace root", gateway: profile(), target: server({ workspacePath: "/srv/other-root" }) },
  { dimension: "host", gateway: profile(), target: server({ host: "other-server.example.test" }) },
  { dimension: "user", gateway: profile(), target: server({ user: "another-user" }) },
  { dimension: "port", gateway: profile(), target: server({ port: 2222 }) },
  { dimension: "command", gateway: profile(), target: server({ command: "kcoder --alternate" }) },
  { dimension: "server profile", gateway: profile(), target: server({ profile: "another-settings-profile" }) },
  { dimension: "settings file", gateway: profile(), target: server({ settingsFile: "/etc/kcoder/other.json" }) },
];

beforeEach(() => {
  storage.values.clear();
  secureValues.clear();
  storage.setItem.mockReset();
  storage.setItem.mockImplementation(async (key, value) => {
    storage.values.set(key, value);
  });
  collapsedServerSectionsTestHelpers.reset();
  newWorkspacePreferencesTestHelpers.reset();
  workspacePreferencesTestHelpers.reset();
  profileStateRemovalTestHelpers.reset();
});

describe("new workspace preference authorization scopes", () => {
  it.each(scopeDimensions)("isolates the stored preference when $dimension changes", async ({ gateway: changedProfile, target: changedServer }) => {
    const profileA = profile();
    const target = server();
    const scopeA = preferenceScope(profileA, target);
    seedProfileMetadata(profileA);
    await saveNewWorkspacePreference(profileA.id, target.id, scopeA, {
      cwd: "/srv/private-a",
      isolation: "worktree",
    });
    const keyA = newWorkspacePreferenceKey(profileA.id, target.id, scopeA);
    const changedScope = preferenceScope(changedProfile, changedServer);
    expect(changedScope).not.toBe(scopeA);
    expect(newWorkspacePreferenceKey(profileA.id, target.id, changedScope)).not.toBe(keyA);
    seedProfileMetadata(changedProfile);
    await expect(loadNewWorkspacePreference(profileA.id, target.id, changedScope)).resolves.toBeNull();
  });

  it("stores separate values for the same profile and server IDs across scopes", async () => {
    const profileA = profile();
    const target = server();
    const scopeA = preferenceScope(profileA, target);
    const profileB = { ...profileA, deviceId: "device-b" };
    const scopeB = preferenceScope(profileB, target);
    seedProfileMetadata(profileA);
    await saveNewWorkspacePreference(profileA.id, target.id, scopeA, {
      cwd: "/srv/private-a",
      isolation: "worktree",
    });
    seedProfileMetadata(profileB);
    expect(await loadNewWorkspacePreference(profileA.id, target.id, scopeB)).toBeNull();
    await saveNewWorkspacePreference(profileA.id, target.id, scopeB, {
      cwd: "/srv/private-b",
      isolation: "local",
    });
    seedProfileMetadata(profileA);
    expect(await loadNewWorkspacePreference(profileA.id, target.id, scopeA)).toEqual({
      cwd: "/srv/private-a",
      isolation: "worktree",
    });
    seedProfileMetadata(profileB);
    expect(await loadNewWorkspacePreference(profileA.id, target.id, scopeB)).toEqual({
      cwd: "/srv/private-b",
      isolation: "local",
    });
  });

  it("keeps a scoped preference through short-token rotation in the same authorization generation", async () => {
    const profileA = profile();
    const rotatedProfileA = profile({
      accessToken: "access-b",
      rpcToken: "rpc-b",
      expiresAt: 20_000,
    });
    const target = server();
    const originalScope = preferenceScope(profileA, target);
    const rotatedScope = preferenceScope(rotatedProfileA, target);

    expect(rotatedScope).toBe(originalScope);
    expect(newWorkspacePreferenceKey(profileA.id, target.id, rotatedScope))
      .toBe(newWorkspacePreferenceKey(profileA.id, target.id, originalScope));

    seedProfileMetadata(profileA);
    await saveNewWorkspacePreference(profileA.id, target.id, originalScope, {
      cwd: "/srv/project-root/recent",
      isolation: "local",
    });
    seedProfileMetadata(rotatedProfileA);
    await expect(loadNewWorkspacePreference(profileA.id, target.id, rotatedScope))
      .resolves.toEqual({ cwd: "/srv/project-root/recent", isolation: "local" });
  });

  it("retains the legacy key without falling back to or overwriting it", async () => {
    const profileA = profile();
    const target = server();
    const legacyKey = `${newWorkspacePreferencePrefix(profileA.id)}${encodeURIComponent(target.id)}`;
    const legacyValue = JSON.stringify({ cwd: "/srv/unknown-owner", isolation: "worktree" });
    storage.values.set(legacyKey, legacyValue);
    const scope = preferenceScope(profileA, target);

    seedProfileMetadata(profileA);
    expect(await loadNewWorkspacePreference(profileA.id, target.id, scope)).toBeNull();
    await saveNewWorkspacePreference(profileA.id, target.id, scope, {
      cwd: "/srv/current-owner",
      isolation: "local",
    });

    expect(storage.values.get(legacyKey)).toBe(legacyValue);
    expect(await loadNewWorkspacePreference(profileA.id, target.id, scope)).toEqual({
      cwd: "/srv/current-owner",
      isolation: "local",
    });
  });

  it("waits for every scoped write during profile removal and blocks later writes", async () => {
    const profileA = profile();
    const target = server();
    const scopeA = preferenceScope(profileA, target);
    const targetB = server({ workspacePath: "/srv/other-root" });
    const targetLate = server({ host: "late-server.example.test" });
    const scopeB = preferenceScope(profileA, targetB);
    const scopeLate = preferenceScope(profileA, targetLate);
    const keyA = newWorkspacePreferenceKey(profileA.id, target.id, scopeA);
    const keyB = newWorkspacePreferenceKey(profileA.id, targetB.id, scopeB);
    const keyLate = newWorkspacePreferenceKey(profileA.id, targetLate.id, scopeLate);
    const finishWrite = new Map<string, () => void>();
    let holdWrites = true;
    storage.values.set(
      `${newWorkspacePreferencePrefix(profileA.id)}${encodeURIComponent(target.id)}`,
      JSON.stringify({ cwd: "/legacy", isolation: "local" }),
    );
    storage.setItem.mockImplementation((key, value) => {
      if (!holdWrites) {
        storage.values.set(key, value);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let finished = false;
        finishWrite.set(key, () => {
          if (finished) return;
          finished = true;
          storage.values.set(key, value);
          resolve();
        });
      });
    });

    seedProfileMetadata(profileA);
    const writeA = saveNewWorkspacePreference(profileA.id, target.id, scopeA, {
      cwd: "/srv/scope-a",
      isolation: "local",
    });
    let removalFinished = false;
    let writeB: Promise<void> | undefined;
    let lateWrite: Promise<void> | undefined;
    let removal: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(finishWrite.size).toBe(1));
      expect(finishWrite.has(keyA)).toBe(true);
      writeB = saveNewWorkspacePreference(profileA.id, targetB.id, scopeB, {
        cwd: "/srv/scope-b",
        isolation: "worktree",
      });
      const writeBSettled = writeB.then(() => "settled" as const, () => "settled" as const);
      const secondWriteStatus = await Promise.race([
        writeBSettled,
        new Promise<"queued">((resolve) => setTimeout(() => resolve("queued"), 30)),
      ]);
      expect(secondWriteStatus).toBe("queued");
      expect(finishWrite.size).toBe(1);
      expect(storage.setItem).toHaveBeenCalledTimes(1);

      removal = removeWorkspaceStatesForProfile(profileA.id).then(() => {
        removalFinished = true;
      });
      const removalSettled = removal.then(() => "finished" as const, () => "rejected" as const);
      lateWrite = saveNewWorkspacePreference(profileA.id, targetLate.id, scopeLate, {
        cwd: "/srv/late",
        isolation: "local",
      });
      await lateWrite;
      expect(storage.setItem).toHaveBeenCalledTimes(1);
      const statusWhileFirstWriteIsHeld = await Promise.race([
        removalSettled,
        new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 30)),
      ]);
      expect(statusWhileFirstWriteIsHeld).toBe("still-pending");
      expect(removalFinished).toBe(false);

      finishWrite.get(keyA)?.();
      await writeA;
      await expect(writeB).rejects.toBeInstanceOf(WorkspaceProfileFenceError);
      await removal;
      expect(removalFinished).toBe(true);
      expect(finishWrite.has(keyB)).toBe(false);
      expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(storage.values.has(keyA)).toBe(false);
      expect(storage.values.has(keyB)).toBe(false);
      expect(storage.values.has(keyLate)).toBe(false);
      expect(storage.values.has(`${newWorkspacePreferencePrefix(profileA.id)}${encodeURIComponent(target.id)}`)).toBe(false);
    } finally {
      holdWrites = false;
      for (const release of finishWrite.values()) release();
      await Promise.allSettled([writeA, ...(writeB ? [writeB] : []), ...(lateWrite ? [lateWrite] : []), ...(removal ? [removal] : [])]);
      profileStateRemovalTestHelpers.reset();
    }
  });

  it("serializes same-key writes and makes profile removal wait for the newest queued write", async () => {
    const profileA = profile();
    const target = server();
    const scope = preferenceScope(profileA, target);
    const key = newWorkspacePreferenceKey(profileA.id, target.id, scope);
    const requests: Array<{ key: string; value: string; resolve: () => void; reject: () => void }> = [];
    let holdWrites = true;
    storage.setItem.mockImplementation((requestKey, value) => {
      if (!holdWrites) {
        storage.values.set(requestKey, value);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        let finished = false;
        requests.push({
          key: requestKey,
          value,
          resolve: () => {
            if (finished) return;
            finished = true;
            storage.values.set(requestKey, value);
            resolve();
          },
          reject: () => {
            if (finished) return;
            finished = true;
            reject(new Error("older scoped preference write failed"));
          },
        });
      });
    });

    seedProfileMetadata(profileA);
    const olderWrite = saveNewWorkspacePreference(profileA.id, target.id, scope, {
      cwd: "/srv/older-selection",
      isolation: "local",
    });
    const olderOutcome = olderWrite.then(() => "saved" as const, () => "failed" as const);
    let newestWrite: Promise<void> | undefined;
    let lateWrite: Promise<void> | undefined;
    let removal: Promise<void> | undefined;
    let removalFinished = false;
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      newestWrite = saveNewWorkspacePreference(profileA.id, target.id, scope, {
        cwd: "/srv/newest-selection",
        isolation: "worktree",
      });
      const newestSettled = newestWrite.then(() => "settled" as const, () => "settled" as const);
      const queuedStatus = await Promise.race([
        newestSettled,
        new Promise<"queued">((resolve) => setTimeout(() => resolve("queued"), 30)),
      ]);
      expect(queuedStatus).toBe("queued");
      expect(requests).toHaveLength(1);

      requests[0].reject();
      await expect(olderOutcome).resolves.toBe("failed");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests.map(({ key: requestKey, value }) => ({ key: requestKey, preference: JSON.parse(value) }))).toEqual([
        { key, preference: { cwd: "/srv/older-selection", isolation: "local" } },
        { key, preference: { cwd: "/srv/newest-selection", isolation: "worktree" } },
      ]);

      removal = removeWorkspaceStatesForProfile(profileA.id).then(() => {
        removalFinished = true;
      });
      const removalSettled = removal.then(() => "finished" as const, () => "rejected" as const);
      lateWrite = saveNewWorkspacePreference(profileA.id, target.id, scope, {
        cwd: "/srv/after-removal-started",
        isolation: "local",
      });
      await lateWrite;
      expect(storage.setItem).toHaveBeenCalledTimes(2);

      const statusWhileNewestWriteIsHeld = await Promise.race([
        removalSettled,
        new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 30)),
      ]);
      expect(statusWhileNewestWriteIsHeld).toBe("still-pending");
      expect(removalFinished).toBe(false);

      requests[1].resolve();
      expect(storage.values.get(key)).toBe(JSON.stringify({ cwd: "/srv/newest-selection", isolation: "worktree" }));
      await Promise.all([newestWrite, removal]);
      expect(removalFinished).toBe(true);
      expect(storage.values.has(key)).toBe(false);
    } finally {
      holdWrites = false;
      requests.forEach((request) => request.resolve());
      await Promise.allSettled([olderWrite, ...(newestWrite ? [newestWrite] : []), ...(lateWrite ? [lateWrite] : []), ...(removal ? [removal] : [])]);
      profileStateRemovalTestHelpers.reset();
    }
  });
});
