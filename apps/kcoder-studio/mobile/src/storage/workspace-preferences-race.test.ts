import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
  multiRemove: vi.fn<(keys: string[]) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
    setItem: storage.setItem,
    removeItem: vi.fn(async (key: string) => { storage.values.delete(key); }),
    getAllKeys: vi.fn(async () => [...storage.values.keys()]),
    multiRemove: storage.multiRemove,
  },
}));

import { loadWorkspaceState, removeWorkspaceState, saveWorkspaceRecentFile, saveWorkspaceState, workspaceStateStorageKey } from "./workspace-preferences";
import { profile } from "@/runtime/task-runtime/fixture.test-support";
import { captureWorkspaceProfileIdentity } from "./workspace-profile-fence";
import historicalWorkspace from "./migrations/fixtures/workspace-v2.json";

describe("workspace preferences 删除屏障", () => {
  beforeEach(() => {
    storage.values.clear();
    storage.setItem.mockReset();
    storage.multiRemove.mockReset();
    storage.setItem.mockImplementation(async (key, value) => { storage.values.set(key, value); });
    storage.multiRemove.mockImplementation(async (keys) => { for (const key of keys) storage.values.delete(key); });
  });

  it.each(["v2", "v3"])("preserves corrupt %s drafts and refuses a later overwrite", async version => {
    const profileId = `migration-corrupt-${version}`;
    installBrowserProfileFixture([{ ...profile, id: profileId }]);
    const identity = captureWorkspaceProfileIdentity({ ...profile, id: profileId });
    const currentKey = workspaceStateStorageKey(profileId, "local", "corrupt");
    const storedKey = currentKey.replace("state:v3:", `state:${version}:`);
    const bytes = '{"composerDraft":"retained but interrupted';
    storage.values.set(storedKey, bytes);
    await expect(loadWorkspaceState(profileId, "local", "corrupt")).rejects.toThrow("workspace_state_corrupt");
    await expect(saveWorkspaceState(profileId, "local", "corrupt", { composerDraft: "replacement" }, undefined, identity)).rejects.toThrow("workspace_state_corrupt");
    expect(storage.values.get(storedKey)).toBe(bytes);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("retries a failed v2 publication without losing historical composer or file drafts", async () => {
    const profileId = "migration-v2-retry";
    installBrowserProfileFixture([{ ...profile, id: profileId }]);
    const key = workspaceStateStorageKey(profileId, "local", "historical");
    const legacyKey = key.replace("state:v3:", "state:v2:");
    const bytes = JSON.stringify(historicalWorkspace);
    storage.values.set(legacyKey, bytes);
    storage.setItem.mockRejectedValueOnce(new Error("fixture write failure"));
    await expect(loadWorkspaceState(profileId, "local", "historical")).rejects.toThrow("fixture write failure");
    expect(storage.values.get(legacyKey)).toBe(bytes);
    expect(storage.values.has(key)).toBe(false);
    const migrated = await loadWorkspaceState(profileId, "local", "historical");
    expect(migrated.composerDraft).toBe(historicalWorkspace.composerDraft);
    expect(migrated.panels?.find(panel => panel.id === "files-1")?.fileDraft?.content).toBe("Unsaved file changes");
    expect(storage.values.has(legacyKey)).toBe(false);
    const persisted = storage.values.get(key);
    await loadWorkspaceState(profileId, "local", "historical");
    expect(storage.values.get(key)).toBe(persisted);
  });

  it("删除会等待既有写入并阻止卸载定时器再次写回", async () => {
    let releaseWrite: (() => void) | undefined;
    storage.setItem.mockImplementationOnce((key, value) => new Promise<void>((resolve) => {
      releaseWrite = () => { storage.values.set(key, value); resolve(); };
    }));
    const profileId = `profile-race-${Date.now()}`;
    installBrowserProfileFixture([{ ...profile, id: profileId }]);
    const identity = captureWorkspaceProfileIdentity({ ...profile, id: profileId });
    const key = workspaceStateStorageKey(profileId, "local", "thread-race");
    const write = saveWorkspaceState(profileId, "local", "thread-race", { composerDraft: "未保存" }, undefined, identity);
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf("function"));

    const removal = removeWorkspaceState(profileId, "local", "thread-race");
    await Promise.resolve();
    expect(storage.multiRemove).not.toHaveBeenCalled();
    releaseWrite?.();
    await Promise.all([write, removal]);
    expect(storage.values.has(key)).toBe(false);

    await saveWorkspaceState(profileId, "local", "thread-race", { composerDraft: "迟到的卸载写入" }, undefined, identity);
    expect(storage.values.has(key)).toBe(false);
    expect(storage.setItem.mock.calls.map(([writeKey]) => writeKey)).toEqual([
      key,
      `${key}:removed:v1`,
    ]);
  });

  it("serializes retained file-panel opens by merging against the latest stored recent list", async () => {
    const profileId = `profile-recent-race-${Date.now()}`;
    installBrowserProfileFixture([{ ...profile, id: profileId }]);
    const identity = captureWorkspaceProfileIdentity({ ...profile, id: profileId });
    const firstPath = "/workspace/src/from-first-panel.ts";
    const secondPath = "/workspace/docs/from-second-panel.md";

    const firstPanelWrite = saveWorkspaceRecentFile(
      profileId, "local", "thread-recent", "/workspace", firstPath, undefined, identity,
    );
    const secondPanelWrite = saveWorkspaceRecentFile(
      profileId, "local", "thread-recent", "/workspace", secondPath, undefined, identity,
    );

    await expect(Promise.all([firstPanelWrite, secondPanelWrite])).resolves.toMatchObject([
      { recentFiles: [firstPath] },
      { recentFiles: [secondPath, firstPath] },
    ]);
    await expect(loadWorkspaceState(profileId, "local", "thread-recent")).resolves.toMatchObject({
      recentFiles: [secondPath, firstPath],
    });
  });

  it.each([
    { root: "C:\\workspace", path: "C:\\workspace\\src\\recent.ts" },
    { root: "\\\\server\\share\\workspace", path: "\\\\server\\share\\workspace\\docs\\recent.md" },
  ])("persists and restores Windows recent files under $root", async ({ root, path }) => {
    const profileId = `profile-windows-recent-${Date.now()}`;
    installBrowserProfileFixture([{ ...profile, id: profileId }]);
    const identity = captureWorkspaceProfileIdentity({ ...profile, id: profileId });
    const directoryPath = `${root}\\src`;
    const panelDirectoryPath = `${root}\\docs`;

    await saveWorkspaceRecentFile(
      profileId, "local", "thread-windows-recent", root, path, undefined, identity,
    );
    await saveWorkspaceState(profileId, "local", "thread-windows-recent", {
      directoryPath,
      panels: [
        { id: "agent", kind: "agent", title: "智能体" },
        { id: "files-1", kind: "files", title: "Files", directoryPath: panelDirectoryPath },
      ],
    }, undefined, identity);
    await expect(loadWorkspaceState(profileId, "local", "thread-windows-recent")).resolves.toMatchObject({
      recentFiles: [path],
      directoryPath,
      panels: expect.arrayContaining([
        expect.objectContaining({ id: "files-1", directoryPath: panelDirectoryPath }),
      ]),
    });
  });
});

beforeEach(() => installBrowserProfileFixture([]));
