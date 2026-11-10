import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View",
  Platform: { OS: "web" }, StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("lucide-react-native", () => ({ Check: "Check", TerminalSquare: "TerminalSquare" }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "SettingsGroup", SettingsPage: "SettingsPage", SettingsRow: "SettingsRow" }));
vi.mock("@/components/settings/settings-choice-sheet", () => ({ SettingsChoiceSheet: "SettingsChoiceSheet" }));
vi.mock("@/theme", () => ({
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  useTheme: () => ({ colors: { text: "text" } }),
  useThemedStyles: (factory: (colors: object) => unknown) => factory({ text: "text", textDim: "dim", textMuted: "muted" }),
}));

import SettingsAppearanceRoute from "@/app/settings-appearance";
import SettingsTerminalRoute from "@/app/settings-terminal";
import { initLocale } from "@/i18n";
import { appPreferencesTestHelpers, getAppPreferencesSnapshot, getAppPreferencesStorageStatus, hydrateAppPreferences, updateAppPreferences } from "@/storage/app-preferences";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appPreferencesTestHelpers.reset();
  storage.getItem.mockReset().mockResolvedValue(null);
  storage.setItem.mockReset().mockResolvedValue(undefined);
  initLocale("en");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const byId = (id: string) => renderer!.root.find(node => typeof node.type === "string" && node.props.testID === id);
const hasId = (id: string) => renderer!.root.findAll(node => typeof node.type === "string" && node.props.testID === id).length > 0;

test("appearance reports persistence failure and retries the current choices without reverting newer edits", async () => {
  storage.setItem.mockRejectedValue(new Error("local storage unavailable"));
  await act(async () => { renderer = create(<SettingsAppearanceRoute />); });
  await act(async () => {
    byId("settings-choice-sheet-theme").props.onSelect("light");
    await appPreferencesTestHelpers.waitForWrites();
  });
  expect(hasId("appearance-preferences-write-error")).toBe(true);
  expect(getAppPreferencesSnapshot().theme).toBe("light");
  await act(async () => {
    byId("settings-choice-sheet-theme").props.onSelect("dark");
    byId("settings-choice-sheet-language").props.onSelect("zh-CN");
    await appPreferencesTestHelpers.waitForWrites();
  });
  storage.setItem.mockResolvedValue(undefined);
  await act(async () => {
    byId("appearance-preferences-write-retry").props.onPress();
    await appPreferencesTestHelpers.waitForWrites();
  });
  expect(JSON.parse(storage.setItem.mock.lastCall![1])).toMatchObject({ theme: "dark", language: "zh-CN", terminalScrollbackLines: 10_000 });
  expect(hasId("appearance-preferences-write-error")).toBe(false);
});

test("terminal write retry is single flight and keeps a newer scrollback selection", async () => {
  storage.setItem.mockRejectedValue(new Error("storage unavailable"));
  await act(async () => { renderer = create(<SettingsTerminalRoute />); });
  await act(async () => {
    byId("terminal-scrollback-5000").props.onPress();
    await appPreferencesTestHelpers.waitForWrites();
  });
  let finish!: () => void;
  storage.setItem.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const callsBefore = storage.setItem.mock.calls.length;
  await act(async () => {
    const press = byId("terminal-preferences-write-retry").props.onPress;
    press(); press();
  });
  expect(storage.setItem).toHaveBeenCalledTimes(callsBefore + 1);
  expect(byId("terminal-preferences-write-retry").props.disabled).toBe(true);
  await act(async () => {
    byId("terminal-scrollback-50000").props.onPress();
    storage.setItem.mockResolvedValue(undefined);
    finish();
    await appPreferencesTestHelpers.waitForWrites();
  });
  expect(JSON.parse(storage.setItem.mock.lastCall![1]).terminalScrollbackLines).toBe(50_000);
  expect(getAppPreferencesSnapshot().terminalScrollbackLines).toBe(50_000);
  expect(hasId("terminal-preferences-write-error")).toBe(false);
});

test("hydration retry remains available and a late stored preference cannot overwrite a user edit", async () => {
  storage.getItem.mockRejectedValue(new Error("storage read unavailable"));
  await hydrateAppPreferences();
  await act(async () => { renderer = create(<SettingsAppearanceRoute />); });
  expect(hasId("appearance-preferences-hydrate-error")).toBe(true);
  let resolveRead!: (value: string | null) => void;
  storage.getItem.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
  await act(async () => { byId("appearance-preferences-hydrate-retry").props.onPress(); });
  await act(async () => {
    updateAppPreferences({ theme: "light" });
    resolveRead(JSON.stringify({ theme: "dark", terminalScrollbackLines: 1_000 }));
    await appPreferencesTestHelpers.waitForWrites();
  });
  expect(getAppPreferencesStorageStatus().hydration).toBe("ready");
  expect(getAppPreferencesSnapshot().theme).toBe("light");
  expect(hasId("appearance-preferences-hydrate-error")).toBe(false);
});
