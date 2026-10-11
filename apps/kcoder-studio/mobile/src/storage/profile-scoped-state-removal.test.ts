// Native storage scheduling contract; cross-tab Web authority is tested separately.
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

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
    setItem: storage.setItem,
  },
}));

vi.mock("./secure", () => ({
  getSecureValue: async (key: string) => storage.secureValues.get(key) ?? null,
  setSecureValue: async (key: string, value: string) => { storage.secureValues.set(key, value); },
  deleteSecureValue: async (key: string) => { storage.secureValues.delete(key); },
}));
import { persistProfiles } from "./profile-store";
import { captureWorkspaceProfileIdentity } from "./workspace-profile-fence";
import { profile as fixtureProfile, server as fixtureServer } from "@/runtime/task-runtime/fixture.test-support";
import {
  collapsedServerSectionsKey,
  collapsedServerSectionsTestHelpers,
  saveCollapsedServerIds,
} from "./collapsed-server-sections";
import {
  newWorkspacePreferenceKey,
  newWorkspacePreferencesTestHelpers,
  saveNewWorkspacePreference,
} from "./new-workspace-preferences";
import {
  loadWorkspaceState,
  removeWorkspaceStatesForProfile,
  saveWorkspaceState,
  workspaceStateStorageKey,
  workspaceStateAuthorizationScope,
  workspaceTabStorageKey,
  workspacePreferencesTestHelpers,
} from "./workspace-preferences";
import { profileStateRemovalTestHelpers } from "./profile-state-removal";

const targetProfile = "gateway-a";
const otherProfile = "gateway-b";
const capturedProfile = { ...fixtureProfile, id: targetProfile };
const authorization = captureWorkspaceProfileIdentity(capturedProfile);
const authorizationScope = workspaceStateAuthorizationScope(capturedProfile, fixtureServer);
const preferenceScope = JSON.stringify([authorizationScope, capturedProfile.deviceId ?? null]);

function legacyWorkspaceStateKey(profileId: string): string {
  return `kcoder-studio:mobile-workspace-state:v2:${encodeURIComponent(profileId)}:local:thread-legacy`;
}

describe("profile-scoped AsyncStorage cleanup", () => {
  beforeEach(async () => {
    storage.values.clear();
    storage.secureValues.clear();
    await persistProfiles([capturedProfile], capturedProfile.id);
    storage.setItem.mockReset();
    collapsedServerSectionsTestHelpers.reset();
    newWorkspacePreferencesTestHelpers.reset();
    workspacePreferencesTestHelpers.reset();
    profileStateRemovalTestHelpers.reset();
    storage.setItem.mockImplementation(async (key, value) => {
      storage.values.set(key, value);
    });
  });

  it("deletes all UI state for only the removed profile and keeps global preferences", async () => {
    const removedKeys = [
      workspaceStateStorageKey(targetProfile, "local", "thread-v3"),
      legacyWorkspaceStateKey(targetProfile),
      workspaceTabStorageKey(targetProfile, "local", "thread-v1"),
      collapsedServerSectionsKey(targetProfile),
      newWorkspacePreferenceKey(targetProfile, "local", preferenceScope),
    ];
    const retainedKeys = [
      workspaceStateStorageKey(otherProfile, "local", "thread-v3"),
      collapsedServerSectionsKey(otherProfile),
      newWorkspacePreferenceKey(otherProfile, "local", preferenceScope),
      "kcoder-studio:mobile-app-preferences:v1",
    ];
    for (const key of [...removedKeys, ...retainedKeys])
      storage.values.set(key, "state");

    await removeWorkspaceStatesForProfile(targetProfile);

    expect([...storage.values.keys()].sort()).toEqual(retainedKeys.sort());
  });

  it("an empty profile id cannot remove any profile or global state", async () => {
    const keys = [
      workspaceStateStorageKey(targetProfile, "local", "thread-v3"),
      collapsedServerSectionsKey(targetProfile),
      newWorkspacePreferenceKey(targetProfile, "local", preferenceScope),
      "kcoder-studio:mobile-app-preferences:v1",
    ];
    for (const key of keys) storage.values.set(key, "state");

    await removeWorkspaceStatesForProfile("");

    expect([...storage.values.keys()].sort()).toEqual(keys.sort());
  });

  it.each(["workspace state", "collapsed sections", "new workspace preferences"])(
    "waits for an in-flight %s save before deleting the profile",
    async (store) => {
      let finishWrite: (() => void) | undefined;
      const key = store === "workspace state"
        ? workspaceStateStorageKey(targetProfile, "local", "thread-1", authorizationScope)
        : store === "collapsed sections"
          ? collapsedServerSectionsKey(targetProfile)
          : newWorkspacePreferenceKey(targetProfile, "local", preferenceScope);
      storage.setItem.mockImplementationOnce((writeKey, value) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            storage.values.set(writeKey, value);
            resolve();
          };
        }),
      );
      const write = store === "workspace state"
        ? saveWorkspaceState(targetProfile, "local", "thread-1", { composerDraft: "in flight" }, authorizationScope, authorization)
        : store === "collapsed sections"
          ? saveCollapsedServerIds(targetProfile, new Set(["local"]))
          : saveNewWorkspacePreference(targetProfile, "local", preferenceScope, { cwd: "/workspace", isolation: "local" });
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));

      const removal = removeWorkspaceStatesForProfile(targetProfile);
      let removalFinished = false;
      void removal.then(() => { removalFinished = true; });
      await Promise.resolve();
      expect(removalFinished).toBe(false);
      finishWrite?.();
      await Promise.all([write, removal]);

      expect(storage.values.has(key)).toBe(false);
    },
  );

  it("blocks late workspace and preference saves after removal begins", async () => {
    const retainedKey = collapsedServerSectionsKey(otherProfile);
    storage.values.set(retainedKey, '["remote"]');
    const removal = removeWorkspaceStatesForProfile(targetProfile);

    await Promise.all([
      saveWorkspaceState(targetProfile, "local", "late-thread", { composerDraft: "late" }, authorizationScope, authorization),
      saveCollapsedServerIds(targetProfile, new Set(["local"])),
      saveNewWorkspacePreference(targetProfile, "local", preferenceScope, {
        cwd: "/late-workspace",
        isolation: "local",
      }),
    ]);
    await removal;

    expect([...storage.values.keys()]).toEqual([retainedKey]);
  });

  it("waits for a legacy migration already writing before deleting that profile", async () => {
    const legacyKey = legacyWorkspaceStateKey(targetProfile);
    const currentKey = workspaceStateStorageKey(targetProfile, "local", "thread-legacy");
    storage.values.set(legacyKey, JSON.stringify({ activeTab: "files", composerDraft: "legacy" }));
    let finishWrite: (() => void) | undefined;
    storage.setItem.mockImplementationOnce((key, value) => new Promise<void>((resolve) => {
      finishWrite = () => {
        storage.values.set(key, value);
        resolve();
      };
    }));

    const load = loadWorkspaceState(targetProfile, "local", "thread-legacy");
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
    const removal = removeWorkspaceStatesForProfile(targetProfile);
    let removalFinished = false;
    void removal.then(() => { removalFinished = true; });
    await Promise.resolve();
    expect(removalFinished).toBe(false);

    finishWrite?.();
    await Promise.all([load, removal]);

    expect(storage.values.has(currentKey)).toBe(false);
    expect(storage.values.has(legacyKey)).toBe(false);
  });
});
