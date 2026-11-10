import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));

import {
  appPreferencesTestHelpers,
  DEFAULT_APP_PREFERENCES,
  getAppPreferencesStorageStatus,
  getAppPreferencesSnapshot,
  hydrateAppPreferences,
  normalizeAppPreferences,
  retryAppPreferencesSave,
  retryHydrateAppPreferences,
  subscribeAppPreferences,
  updateAppPreferences,
  updateAppPreferencesAndWait,
} from "./app-preferences";

beforeEach(() => {
  appPreferencesTestHelpers.reset();
  storage.getItem.mockReset();
  storage.setItem.mockReset();
  storage.setItem.mockResolvedValue(undefined);
});

describe("app preferences", () => {
  it("migrates old reading preferences and persists every new field without resetting peers", async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({ conversationLineSpacing: "relaxed", terminalScrollbackLines: 24000 }));
    await hydrateAppPreferences();
    expect(getAppPreferencesSnapshot()).toMatchObject({ conversationLineSpacing: "relaxed", conversationBlockSpacing: "normal", conversationLetterSpacing: "normal", conversationFontFamily: "noto-sans-sc" });
    const listener = vi.fn();
    subscribeAppPreferences(listener);
    await updateAppPreferencesAndWait({ conversationBlockSpacing: "relaxed" });
    await updateAppPreferencesAndWait({ conversationLetterSpacing: "compact" });
    await updateAppPreferencesAndWait({ conversationFontFamily: "system" });
    for (const conversationLineSpacing of ["compact", "snug", "normal", "relaxed", "airy"] as const) {
      await updateAppPreferencesAndWait({ conversationLineSpacing });
      expect(getAppPreferencesSnapshot().conversationLineSpacing).toBe(conversationLineSpacing);
    }
    expect(listener).toHaveBeenCalledTimes(8);
    expect(JSON.parse(storage.setItem.mock.lastCall![1])).toMatchObject({ conversationLineSpacing: "airy", conversationBlockSpacing: "relaxed", conversationLetterSpacing: "compact", conversationFontFamily: "system", terminalScrollbackLines: 24000 });
    expect(normalizeAppPreferences({ conversationLineSpacing: "invalid", conversationBlockSpacing: "invalid", conversationLetterSpacing: "invalid", conversationFontFamily: "invalid" })).toMatchObject({ conversationLineSpacing: "normal", conversationBlockSpacing: "normal", conversationLetterSpacing: "normal", conversationFontFamily: "noto-sans-sc" });
  });
  it("uses V3 when no choice is saved and restores explicit choices without changing peer preferences", async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({ theme: "dark", quickPhrases: [{ id: "keep", title: "Keep", content: "Keep draft" }] }));
    await hydrateAppPreferences();
    expect(getAppPreferencesSnapshot().interfaceVersion).toBe("v3");
    const listener = vi.fn();
    const unsubscribe = subscribeAppPreferences(listener);
    await updateAppPreferencesAndWait({ interfaceVersion: "classic" });
    expect(listener).toHaveBeenCalledTimes(1);
    const stored = storage.setItem.mock.lastCall![1];
    expect(JSON.parse(stored)).toMatchObject({ interfaceVersion: "classic", theme: "dark", quickPhrases: [{ id: "keep" }] });
    unsubscribe();
    appPreferencesTestHelpers.reset();
    storage.getItem.mockResolvedValue(stored);
    await hydrateAppPreferences();
    expect(getAppPreferencesSnapshot()).toMatchObject({ interfaceVersion: "classic", theme: "dark", quickPhrases: [{ id: "keep" }] });
    expect(normalizeAppPreferences({ interfaceVersion: "unsupported" }).interfaceVersion).toBe("v3");
    expect(normalizeAppPreferences({ interfaceVersion: "modern" }).interfaceVersion).toBe("modern");
    await updateAppPreferencesAndWait({ interfaceVersion: "modern" });
    expect(getAppPreferencesSnapshot().quickPhrases[0].content).toBe("Keep draft");
  });

  it("defaults language and theme to system while preserving scrollback", () => {
    expect(DEFAULT_APP_PREFERENCES).toEqual({
      interfaceVersion: "v3",
      language: "system",
      theme: "system",
      terminalScrollbackLines: 10_000,
      conversationFontScale: "normal",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases: [],
    });
    expect(normalizeAppPreferences({ terminalScrollbackLines: 32_000 })).toEqual({
      interfaceVersion: "v3",
      language: "system",
      theme: "system",
      terminalScrollbackLines: 32_000,
      conversationFontScale: "normal",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases: [],
    });
  });

  it("normalizes local conversation preferences and quick phrases", () => {
    expect(normalizeAppPreferences(null)).toEqual(DEFAULT_APP_PREFERENCES);
    expect(normalizeAppPreferences({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 500,
      conversationFontScale: "large",
      conversationLineSpacing: "compact",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
      quickPhrases: [
        { id: "one", title: "  Review  ", content: "  Check this change  " },
        { id: "one", title: "duplicate id", content: "Ignored" },
        { id: "empty", title: "", content: "Ignored" },
      ],
    })).toEqual({
      interfaceVersion: "v3",
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 1_000,
      conversationFontScale: "large",
      conversationLineSpacing: "compact",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
      quickPhrases: [{ id: "one", title: "Review", content: "  Check this change  " }],
    });
    expect(normalizeAppPreferences({
      language: "fr",
      theme: "system",
      terminalScrollbackLines: 50_000.4,
      conversationFontScale: "giant",
      conversationLineSpacing: "wide",
      thinkingCollapsedByDefault: "false",
      toolsCollapsedByDefault: true,
    })).toEqual({
      interfaceVersion: "v3",
      language: "system",
      theme: "system",
      terminalScrollbackLines: 50_000,
      conversationFontScale: "normal",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases: [],
    });
    expect(normalizeAppPreferences({ language: "en", theme: "dark", terminalScrollbackLines: 1_000_000 }).terminalScrollbackLines).toBe(100_000);
  });

  it("publishes language and theme changes without dropping scrollback", async () => {
    updateAppPreferences({ terminalScrollbackLines: 24_000 });
    const listener = vi.fn();
    const unsubscribe = subscribeAppPreferences(listener);

    updateAppPreferences({ language: "zh-CN", theme: "light" });
    expect(getAppPreferencesSnapshot()).toEqual({
      interfaceVersion: "v3",
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 24_000,
      conversationFontScale: "normal",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases: [],
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    updateAppPreferences({ language: "zh-CN" });
    expect(listener).toHaveBeenCalledTimes(1);
    await appPreferencesTestHelpers.waitForWrites();
  });

  it("hydrates persisted appearance preferences before returning the snapshot", async () => {
    const quickPhrase = { id: "custom", title: "Review", content: "Review this diff" };
    storage.getItem.mockResolvedValue(JSON.stringify({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 36_000,
      conversationFontScale: "small",
      conversationLineSpacing: "relaxed",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: true,
      quickPhrases: [quickPhrase],
    }));
    const listener = vi.fn();
    subscribeAppPreferences(listener);

    await expect(hydrateAppPreferences()).resolves.toEqual({
      interfaceVersion: "v3",
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 36_000,
      conversationFontScale: "small",
      conversationLineSpacing: "relaxed",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: true,
      quickPhrases: [quickPhrase],
    });
    expect(getAppPreferencesSnapshot()).toEqual({
      interfaceVersion: "v3",
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 36_000,
      conversationFontScale: "small",
      conversationLineSpacing: "relaxed",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: true,
      quickPhrases: [quickPhrase],
    });
    expect(getAppPreferencesStorageStatus().hydration).toBe("ready");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("用户修改不会被较晚返回的旧 hydration 覆盖", async () => {
    let resolveRead!: (value: string | null) => void;
    storage.getItem.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const hydration = hydrateAppPreferences();

    const quickPhrases = [{ id: "kept", title: "Keep", content: "Keep this phrase" }];
    updateAppPreferences({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 50_000,
      quickPhrases,
      conversationFontScale: "large",
    });
    resolveRead(JSON.stringify({ language: "en", theme: "dark", terminalScrollbackLines: 1_000 }));
    await hydration;
    await appPreferencesTestHelpers.waitForWrites();

    expect(getAppPreferencesSnapshot()).toEqual({
      interfaceVersion: "v3",
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 50_000,
      conversationFontScale: "large",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases,
    });
    expect(storage.setItem).toHaveBeenCalledWith(expect.any(String), JSON.stringify(getAppPreferencesSnapshot()));
  });

  it("serializes writes with the newest full preference snapshot", async () => {
    updateAppPreferences({ language: "en" });
    updateAppPreferences({
      conversationFontScale: "large",
      quickPhrases: [{ id: "one", title: "One", content: "First phrase" }],
    });

    await appPreferencesTestHelpers.waitForWrites();

    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.setItem.mock.calls[1][1])).toMatchObject({
      language: "en",
      conversationFontScale: "large",
      quickPhrases: [{ id: "one", title: "One", content: "First phrase" }],
      theme: "system",
      terminalScrollbackLines: 10_000,
    });
    expect(getAppPreferencesStorageStatus().writeError).toBe(false);
  });

  it("reports hydration and save failures and permits retries", async () => {
    storage.getItem.mockRejectedValueOnce(new Error("offline"));
    await hydrateAppPreferences();
    expect(getAppPreferencesStorageStatus().hydration).toBe("error");

    storage.getItem.mockResolvedValueOnce(JSON.stringify({ language: "en" }));
    await retryHydrateAppPreferences();
    expect(getAppPreferencesStorageStatus().hydration).toBe("ready");
    expect(getAppPreferencesSnapshot().language).toBe("en");

    storage.setItem.mockRejectedValueOnce(new Error("quota"));
    await expect(updateAppPreferencesAndWait({ conversationFontScale: "small" })).rejects.toThrow(
      "Could not save local app preferences",
    );
    expect(getAppPreferencesStorageStatus().writeError).toBe(true);

    storage.setItem.mockResolvedValue(undefined);
    await retryAppPreferencesSave();
    expect(getAppPreferencesStorageStatus().writeError).toBe(false);
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)?.[1] ?? "{}")).toMatchObject({
      language: "en",
      conversationFontScale: "small",
    });
  });
});
