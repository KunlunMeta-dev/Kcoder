import React, { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  setters: [] as Array<((update: unknown) => void) | undefined>,
  refs: [] as Array<{ current: unknown } | undefined>,
  memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
  stateCursor: 0,
  refCursor: 0,
  memoCursor: 0,
  storage: new Map<string, string>(),
  app: {} as any,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = fixture.stateCursor++;
      if (!(index in fixture.states))
        fixture.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      fixture.setters[index] ??= (update: unknown) => {
        fixture.states[index] = typeof update === "function"
          ? (update as (previous: unknown) => unknown)(fixture.states[index])
          : update;
      };
      return [fixture.states[index], fixture.setters[index]];
    },
    useRef: (initial: unknown) => {
      const index = fixture.refCursor++;
      return fixture.refs[index] ??= { current: initial };
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = fixture.memoCursor++;
      const previous = fixture.memos[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i])))
        return previous.value;
      const value = factory();
      fixture.memos[index] = { value, deps };
      return value;
    },
    useEffect: () => {},
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

// This direct-call hook host does not mount React. Language subscription and
// draft/connection preservation are covered by the real Mobile Web preference E2E.
vi.mock("@/i18n/use-locale", async () => {
  const { getLocale } = await import("@/i18n");
  return { useLocale: getLocale };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => fixture.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { fixture.storage.set(key, value); }),
  },
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove: vi.fn() }) },
  Modal: "Modal",
  Platform: { OS: "web" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => Object.fromEntries([
  "Bell", "ChevronLeft", "ChevronRight", "Cloud", "Keyboard", "Laptop", "Mic", "Monitor", "Moon", "Plus", "RefreshCw", "Server", "Stethoscope", "Sun", "TerminalSquare", "X",
].map((name) => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", StatusDot: "StatusDot" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/platform/confirmation", () => ({ requestConfirmation: vi.fn() }));
vi.mock("@/gateway/http", () => ({ listMobileDevices: vi.fn(async () => []), revokeMobileDevice: vi.fn(async () => {}) }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: vi.fn(), profileHomeHref: () => "/home" }));

import SettingsRoute from "../settings";
import { getLocale, setLocalePreference, t } from "@/i18n";
import {
  appPreferencesTestHelpers,
  getAppPreferencesSnapshot,
  hydrateAppPreferences,
  subscribeAppPreferences,
  updateAppPreferences,
} from "@/storage/app-preferences";
import { darkColors, getThemeSnapshot, setThemePreference, themeTestHelpers } from "@/theme";

const storageKey = "kcoder-studio:mobile-app-preferences:v1";
let stopRootPreferenceSync: (() => void) | null = null;
const profile = {
  id: "settings-profile",
  label: "Gateway",
  baseUrl: "https://gateway.invalid",
  expiresAt: Date.now() + 60_000,
  refreshToken: "refresh-token-fixture",
  authMode: "device" as const,
  deviceId: "device-current",
  authorizationGeneration: "generation-settings",
};

function resetHookHost(): void {
  fixture.states = [];
  fixture.setters = [];
  fixture.refs = [];
  fixture.memos = [];
  fixture.stateCursor = 0;
  fixture.refCursor = 0;
  fixture.memoCursor = 0;
}

function renderRoute(): Array<ReactElement<Record<string, any>>> {
  resetHookHost();
  return resolveElements(SettingsRoute());
}

function resolveElements(node: unknown): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(resolveElements);
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  if (typeof element.type === "function") {
    return resolveElements((element.type as (props: Record<string, any>) => ReactNode)(element.props));
  }
  return [element, ...resolveElements(element.props.children)];
}

function byTestId(tree: Array<ReactElement<Record<string, any>>>, testID: string) {
  return tree.find((element) => element.props.testID === testID);
}

function textValue(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textValue).join("");
  if (React.isValidElement(node)) return textValue((node as ReactElement<Record<string, any>>).props.children);
  return "";
}

function allText(tree: Array<ReactElement<Record<string, any>>>): string[] {
  return tree.filter((element) => element.type === "Text").map((element) => textValue(element.props.children));
}

function connectRootPreferenceSync(): () => void {
  return subscribeAppPreferences(() => {
    const preferences = getAppPreferencesSnapshot();
    setLocalePreference(preferences.language);
    setThemePreference(preferences.theme);
  });
}

beforeEach(() => {
  fixture.storage.clear();
  fixture.app = {
    profiles: [profile],
    activeProfile: profile,
    runtime: { servers: [], statuses: [], loading: false, error: null, reauthorizationRequired: false },
    setActiveProfile: vi.fn(async () => {}),
    removeGateway: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    demo: false,
    markGatewayReauthorizationRequired: vi.fn(),
  };
  appPreferencesTestHelpers.reset();
  themeTestHelpers.reset();
  setLocalePreference("system");
  stopRootPreferenceSync = connectRootPreferenceSync();
  resetHookHost();
});

afterEach(() => {
  stopRootPreferenceSync?.();
  stopRootPreferenceSync = null;
  resetHookHost();
});

describe("mobile settings appearance preferences", () => {
  it("hydrates persisted language and theme, applies changes immediately, and restores them after reload", async () => {
    fixture.storage.set(storageKey, JSON.stringify({ language: "zh-CN", theme: "light", terminalScrollbackLines: 12_000 }));

    await hydrateAppPreferences();
    expect(getAppPreferencesSnapshot()).toEqual({ language: "zh-CN", theme: "light", terminalScrollbackLines: 12_000 });
    expect(getLocale()).toBe("zh-CN");
    expect(getThemeSnapshot().mode).toBe("light");

    let tree = renderRoute();
    expect(byTestId(tree, "settings-language-zh-cn")?.props.accessibilityState.selected).toBe(true);
    expect(byTestId(tree, "settings-theme-light")?.props.accessibilityState.selected).toBe(true);
    expect(allText(tree)).toContain("设置");
    expect(allText(tree)).toContain("设备授权已保存，连接凭据会自动续期");

    const lightRootStyle = (tree[0].props.style as Array<Record<string, unknown>>)[0];
    expect(lightRootStyle.backgroundColor).not.toBe(darkColors.background);

    byTestId(tree, "settings-language-en")?.props.onPress();
    byTestId(tree, "settings-theme-dark")?.props.onPress();
    expect(getAppPreferencesSnapshot()).toMatchObject({ language: "en", theme: "dark" });
    expect(getLocale()).toBe("en");
    expect(getThemeSnapshot().mode).toBe("dark");
    expect(t("common.settings")).toBe("Settings");

    tree = renderRoute();
    expect(byTestId(tree, "settings-language-en")?.props.accessibilityState.selected).toBe(true);
    expect(byTestId(tree, "settings-theme-dark")?.props.accessibilityState.selected).toBe(true);
    expect((tree[0].props.style as Array<Record<string, unknown>>)[0].backgroundColor).toBe(darkColors.background);

    await appPreferencesTestHelpers.waitForWrites();
    appPreferencesTestHelpers.reset();
    themeTestHelpers.reset();
    setLocalePreference("system");
    stopRootPreferenceSync = connectRootPreferenceSync();
    await hydrateAppPreferences();
    expect(getAppPreferencesSnapshot()).toMatchObject({ language: "en", theme: "dark" });
    expect(getLocale()).toBe("en");
    expect(getThemeSnapshot().mode).toBe("dark");
  });

  it("keeps every language and theme choice enabled with explicit selected accessibility state", () => {
    const tree = renderRoute();
    const preferenceControls = [
      "settings-language-system", "settings-language-en", "settings-language-zh-cn",
      "settings-theme-light", "settings-theme-dark", "settings-theme-system",
    ];

    for (const testID of preferenceControls) {
      const control = byTestId(tree, testID);
      expect(control, testID).toBeDefined();
      expect(control?.props.accessibilityRole, testID).toBe("button");
      expect(control?.props.accessibilityState.disabled, testID).toBe(false);
      expect(control?.props.disabled, testID).not.toBe(true);
      expect(typeof control?.props.accessibilityState.selected, testID).toBe("boolean");
      expect(typeof control?.props.onPress, testID).toBe("function");
    }
  });

  it("writes language and theme through app preferences while retaining other settings", async () => {
    updateAppPreferences({ terminalScrollbackLines: 25_000 });
    const tree = renderRoute();
    byTestId(tree, "settings-language-system")?.props.onPress();
    byTestId(tree, "settings-theme-system")?.props.onPress();
    await appPreferencesTestHelpers.waitForWrites();

    expect(fixture.storage.get(storageKey)).toBe(JSON.stringify({ language: "system", theme: "system", terminalScrollbackLines: 25_000 }));
  });
});
