import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn<() => Promise<string | null>>(),
  setItem: vi.fn<() => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));

import {
  appPreferencesTestHelpers,
  DEFAULT_APP_PREFERENCES,
  getAppPreferencesSnapshot,
  hydrateAppPreferences,
  normalizeAppPreferences,
  updateAppPreferences,
} from "./app-preferences";

beforeEach(() => {
  appPreferencesTestHelpers.reset();
  storage.getItem.mockReset();
  storage.setItem.mockReset();
  storage.setItem.mockResolvedValue(undefined);
});

describe("app preferences", () => {
  it("规范化终端回滚行数并设置安全上下限", () => {
    expect(normalizeAppPreferences(null)).toEqual(DEFAULT_APP_PREFERENCES);
    expect(normalizeAppPreferences({ terminalScrollbackLines: 500 })).toEqual({ terminalScrollbackLines: 1_000 });
    expect(normalizeAppPreferences({ terminalScrollbackLines: 50_000.4 })).toEqual({ terminalScrollbackLines: 50_000 });
    expect(normalizeAppPreferences({ terminalScrollbackLines: 1_000_000 })).toEqual({ terminalScrollbackLines: 100_000 });
  });

  it("用户修改不会被较晚返回的旧 hydration 覆盖", async () => {
    let resolveRead!: (value: string | null) => void;
    storage.getItem.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const hydration = hydrateAppPreferences();

    updateAppPreferences({ terminalScrollbackLines: 50_000 });
    resolveRead(JSON.stringify({ terminalScrollbackLines: 1_000 }));
    await hydration;
    await appPreferencesTestHelpers.waitForWrites();

    expect(getAppPreferencesSnapshot()).toEqual({ terminalScrollbackLines: 50_000 });
    expect(storage.setItem).toHaveBeenCalledWith(expect.any(String), JSON.stringify({ terminalScrollbackLines: 50_000 }));
  });
});
