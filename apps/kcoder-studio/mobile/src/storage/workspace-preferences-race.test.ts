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

import { removeWorkspaceState, saveWorkspaceState, workspaceStateStorageKey } from "./workspace-preferences";

describe("workspace preferences 删除屏障", () => {
  beforeEach(() => {
    storage.values.clear();
    storage.setItem.mockReset();
    storage.multiRemove.mockReset();
    storage.setItem.mockImplementation(async (key, value) => { storage.values.set(key, value); });
    storage.multiRemove.mockImplementation(async (keys) => { for (const key of keys) storage.values.delete(key); });
  });

  it("删除会等待既有写入并阻止卸载定时器再次写回", async () => {
    let releaseWrite: (() => void) | undefined;
    storage.setItem.mockImplementationOnce((key, value) => new Promise<void>((resolve) => {
      releaseWrite = () => { storage.values.set(key, value); resolve(); };
    }));
    const profileId = `profile-race-${Date.now()}`;
    const key = workspaceStateStorageKey(profileId, "local", "thread-race");
    const write = saveWorkspaceState(profileId, "local", "thread-race", { composerDraft: "未保存" });
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf("function"));

    const removal = removeWorkspaceState(profileId, "local", "thread-race");
    await Promise.resolve();
    expect(storage.multiRemove).not.toHaveBeenCalled();
    releaseWrite?.();
    await Promise.all([write, removal]);
    expect(storage.values.has(key)).toBe(false);

    await saveWorkspaceState(profileId, "local", "thread-race", { composerDraft: "迟到的卸载写入" });
    expect(storage.values.has(key)).toBe(false);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
