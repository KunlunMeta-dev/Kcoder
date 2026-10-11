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
  subscribeAppPreferences,
  updateAppPreferences,
} from "./app-preferences";

beforeEach(() => {
  appPreferencesTestHelpers.reset();
  storage.getItem.mockReset();
  storage.setItem.mockReset();
  storage.setItem.mockResolvedValue(undefined);
});

describe("app preferences", () => {
  it("defaults language and theme to system while preserving scrollback", () => {
    expect(DEFAULT_APP_PREFERENCES).toEqual({
      language: "system",
      theme: "system",
      terminalScrollbackLines: 10_000,
    });
    expect(normalizeAppPreferences({ terminalScrollbackLines: 32_000 })).toEqual({
      language: "system",
      theme: "system",
      terminalScrollbackLines: 32_000,
    });
  });

  it("normalizes language, theme, and terminal scrollback", () => {
    expect(normalizeAppPreferences(null)).toEqual(DEFAULT_APP_PREFERENCES);
    expect(normalizeAppPreferences({ language: "zh-CN", theme: "light", terminalScrollbackLines: 500 })).toEqual({ language: "zh-CN", theme: "light", terminalScrollbackLines: 1_000 });
    expect(normalizeAppPreferences({ language: "fr", theme: "system", terminalScrollbackLines: 50_000.4 })).toEqual({ language: "system", theme: "system", terminalScrollbackLines: 50_000 });
    expect(normalizeAppPreferences({ language: "en", theme: "dark", terminalScrollbackLines: 1_000_000 })).toEqual({ language: "en", theme: "dark", terminalScrollbackLines: 100_000 });
  });

  it("publishes language and theme changes without dropping scrollback", async () => {
    updateAppPreferences({ terminalScrollbackLines: 24_000 });
    const listener = vi.fn();
    const unsubscribe = subscribeAppPreferences(listener);

    updateAppPreferences({ language: "zh-CN", theme: "light" });
    expect(getAppPreferencesSnapshot()).toEqual({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 24_000,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    updateAppPreferences({ language: "zh-CN" });
    expect(listener).toHaveBeenCalledTimes(1);
    await appPreferencesTestHelpers.waitForWrites();
  });

  it("hydrates persisted appearance preferences before returning the snapshot", async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 36_000,
    }));
    const listener = vi.fn();
    subscribeAppPreferences(listener);

    await expect(hydrateAppPreferences()).resolves.toEqual({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 36_000,
    });
    expect(getAppPreferencesSnapshot()).toEqual({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 36_000,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("用户修改不会被较晚返回的旧 hydration 覆盖", async () => {
    let resolveRead!: (value: string | null) => void;
    storage.getItem.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const hydration = hydrateAppPreferences();

    updateAppPreferences({ language: "zh-CN", theme: "light", terminalScrollbackLines: 50_000 });
    resolveRead(JSON.stringify({ language: "en", theme: "dark", terminalScrollbackLines: 1_000 }));
    await hydration;
    await appPreferencesTestHelpers.waitForWrites();

    expect(getAppPreferencesSnapshot()).toEqual({ language: "zh-CN", theme: "light", terminalScrollbackLines: 50_000 });
    expect(storage.setItem).toHaveBeenCalledWith(expect.any(String), JSON.stringify({ language: "zh-CN", theme: "light", terminalScrollbackLines: 50_000 }));
  });
});
