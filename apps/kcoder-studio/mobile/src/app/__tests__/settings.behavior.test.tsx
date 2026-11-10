import React, { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  setters: [] as Array<((update: unknown) => void) | undefined>,
  refs: [] as Array<{ current: unknown } | undefined>,
  memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
  effects: [] as Array<{ cleanup?: () => void; deps?: unknown[] } | undefined>,
  pendingEffects: [] as Array<() => void>,
  stateCursor: 0,
  refCursor: 0,
  memoCursor: 0,
  effectCursor: 0,
  focused: true,
  window: { width: 390, height: 800, scale: 1, fontScale: 1 },
  storage: new Map<string, string>(),
  app: {} as any,
  mobileVersion: { value: "2.3.4", source: "nativeAppVersion" as const },
  route: (() => null) as () => ReactNode,
  router: {} as any,
  searchParams: {} as Record<string, string | string[] | undefined>,
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
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const index = fixture.effectCursor++;
      const previous = fixture.effects[index];
      const changed = !previous || deps === undefined || previous.deps === undefined ||
        deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps?.[i]));
      if (!changed) return;
      fixture.pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        fixture.effects[index] = { deps: deps?.slice(), cleanup: typeof cleanup === "function" ? cleanup : undefined };
      });
    },
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
vi.mock("expo-router", () => ({
  Redirect: "Redirect",
  useRouter: () => fixture.router,
  useLocalSearchParams: () => fixture.searchParams,
  useIsFocused: () => fixture.focused,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove: vi.fn() }) },
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Modal: "Modal",
  Platform: { OS: "web" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => fixture.window,
}));
vi.mock("lucide-react-native", () => Object.fromEntries([
  "BarChart3", "Bell", "Check", "ChevronLeft", "ChevronRight", "Cloud", "Globe", "HardDrive", "Info", "Keyboard", "Laptop", "MessageSquare", "Mic", "Monitor", "Moon", "Plus", "Puzzle", "RefreshCw", "Server", "ShieldCheck", "SlidersHorizontal", "Stethoscope", "Sun", "TerminalSquare", "TextQuote", "X",
].map((name) => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", StatusDot: "StatusDot" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/runtime/mobile-client-version", () => ({ getMobileClientVersion: () => fixture.mobileVersion }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/platform/confirmation", () => ({ requestConfirmation: vi.fn() }));
vi.mock("@/gateway/http", () => ({ listMobileDevices: vi.fn(async () => []), revokeMobileDevice: vi.fn(async () => {}) }));
vi.mock("@/navigation/back-or-replace", () => ({
  backOrReplace: (router: any, fallback: string) => router.canGoBack() ? router.back() : router.replace(fallback),
  profileHomeHref: () => "/home",
}));
vi.mock("@/components/settings/SettingsTargetContext", () => ({
  SettingsTargetProvider: ({ children }: { children: ReactNode }) =>
    React.createElement("View", { testID: "settings-target-provider" }, children),
  SettingsTargetSelector: () => React.createElement("View", { testID: "settings-target-selector" }),
  useSettingsTarget: () => ({ targetIdentity: "target-settings-fixture" }),
}));
vi.mock("@/components/settings/ModelServicesSettings", () => ({
  ModelServicesSettings: () => React.createElement("View", { testID: "settings-content-models_services" }),
}));
vi.mock("@/components/settings/ExecutionDefaultsSettings", () => ({
  default: () => React.createElement("View", { testID: "settings-content-execution_permissions" }),
}));
vi.mock("@/components/settings/CustomInstructionsSettings", () => ({
  default: () => React.createElement("View", { testID: "settings-content-custom_instructions" }),
}));
vi.mock("@/components/settings/ConversationPreferencesSettings", () => ({
  default: () => React.createElement("View", { testID: "settings-content-conversation_preferences" }),
}));
vi.mock("@/components/settings/QuickPhrasesSettings", () => ({
  default: () => React.createElement("View", { testID: "settings-content-quick_phrases" }),
}));
vi.mock("@/components/settings/ToolConfigurationSettings", () => ({
  ToolConfigurationSettings: () => React.createElement("View", { testID: "settings-content-tool_configuration" }),
}));
vi.mock("@/components/settings/UsageSettings", () => ({
  UsageSettings: () => React.createElement("View", { testID: "settings-content-usage" }),
}));
vi.mock("@/components/settings/ExtensionsSettings", () => ({
  default: () => React.createElement("View", { testID: "settings-content-plugins_skills" }),
}));
vi.mock("@/components/settings/StorageCacheSettings", () => ({
  default: () => React.createElement("View", { testID: "settings-content-storage_cache" }),
}));

import SettingsRoute from "../settings";
import SettingsSectionRoute from "../settings-section";
import SettingsConnectionsRoute from "../settings-connections";
import SettingsAppearanceRoute from "../settings-appearance";
import SettingsTerminalRoute from "../settings-terminal";
import SettingsDiagnosticsRoute from "../settings-diagnostics";
import SettingsAboutRoute from "../settings-about";
import { getSettingsHubSection, SETTINGS_SECTION_GROUPS } from "@/components/settings/settings-sections";
import { getLocale, setLocalePreference, t } from "@/i18n";
import { requestConfirmation } from "@/platform/confirmation";
import { revokeMobileDevice } from "@/gateway/http";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import {
  DEFAULT_APP_PREFERENCES,
  appPreferencesTestHelpers,
  getAppPreferencesSnapshot,
  hydrateAppPreferences,
  subscribeAppPreferences,
  updateAppPreferences,
} from "@/storage/app-preferences";
import { getThemeSnapshot, setThemePreference, themeTestHelpers } from "@/theme";

const storageKey = "kcoder-studio:mobile-app-preferences:v1";
let stopRootPreferenceSync: (() => void) | null = null;
const profile = {
  id: "settings-profile",
  label: "Gateway",
  baseUrl: "https://gateway.invalid",
  accessToken: "access-token-fixture",
  rpcToken: "rpc-token-fixture",
  expiresAt: Date.now() + 60_000,
  refreshToken: "refresh-token-fixture",
  authMode: "device" as const,
  deviceId: "device-current",
  authorizationGeneration: "generation-settings",
};
const otherProfile = {
  ...profile,
  id: "other-settings-profile",
  label: "Other Gateway",
  baseUrl: "https://other-gateway.invalid",
  authMode: "token" as const,
  deviceId: undefined,
  authorizationGeneration: "generation-other",
};

function resetHookHost(): void {
  for (const effect of fixture.effects) effect?.cleanup?.();
  fixture.states = [];
  fixture.setters = [];
  fixture.refs = [];
  fixture.memos = [];
  fixture.effects = [];
  fixture.pendingEffects = [];
  fixture.stateCursor = 0;
  fixture.refCursor = 0;
  fixture.memoCursor = 0;
  fixture.effectCursor = 0;
}

function renderRoute(route: () => ReactNode = SettingsRoute): Array<ReactElement<Record<string, any>>> {
  fixture.route = route;
  resetHookHost();
  const tree = resolveElements(route());
  flushEffects();
  return tree;
}

function rerenderRoute(): Array<ReactElement<Record<string, any>>> {
  fixture.stateCursor = 0;
  fixture.refCursor = 0;
  fixture.memoCursor = 0;
  fixture.effectCursor = 0;
  const tree = resolveElements(fixture.route());
  flushEffects();
  return tree;
}

function flushEffects(): void {
  for (const run of fixture.pendingEffects.splice(0)) run();
}

function resolveElements(node: unknown): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(resolveElements);
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  if (element.type === React.Fragment) return resolveElements(element.props.children);
  if (typeof element.type === "function") {
    return resolveElements((element.type as (props: Record<string, any>) => ReactNode)(element.props));
  }
  if (element.type === "Modal" && !element.props.visible) return [element];
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

function rowTextElements(tree: Array<ReactElement<Record<string, any>>>, testID: string) {
  const row = byTestId(tree, testID);
  return resolveElements(row?.props.children).filter((element) => element.type === "Text");
}

function styleRecord(style: unknown): Record<string, any> {
  return Object.assign({}, ...(Array.isArray(style) ? style : [style]));
}

const expectedSettingsGroups = [
  {
    id: "connection_runtime",
    rows: ["connections_devices", "models_services", "execution_permissions"],
  },
  {
    id: "conversation_personalization",
    rows: ["appearance", "conversation_preferences", "quick_phrases", "custom_instructions"],
  },
  {
    id: "tools_extensions",
    rows: ["tool_configuration", "plugins_skills"],
  },
  {
    id: "data_support",
    rows: ["migration_results", "usage", "storage_cache", "terminal", "connection_diagnostics", "about"],
  },
];

function settingsRowTestID(sectionId: string): string {
  switch (sectionId) {
    case "connections_devices": return "settings-manage-connections";
    case "appearance": return "settings-appearance";
    case "terminal": return "terminal-settings";
    case "connection_diagnostics": return "diagnostics-settings";
    case "about": return "settings-about";
    default: return `settings-section-${sectionId}`;
  }
}

const expectedSettingsRowOrder = expectedSettingsGroups.flatMap((group) => group.rows.map(settingsRowTestID));

function connectRootPreferenceSync(): () => void {
  return subscribeAppPreferences(() => {
    const preferences = getAppPreferencesSnapshot();
    setLocalePreference(preferences.language);
    setThemePreference(preferences.theme);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.storage.clear();
  fixture.app = {
    profiles: [profile],
    activeProfile: profile,
    runtime: { servers: [], statuses: [], loading: false, serversReady: true, error: null, reauthorizationRequired: false },
    setActiveProfile: vi.fn(async () => {}),
    removeGateway: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    demo: false,
    markGatewayReauthorizationRequired: vi.fn(),
  };
  fixture.router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true) };
  fixture.route = SettingsRoute;
  fixture.searchParams = {};
  fixture.focused = true;
  fixture.window = { width: 390, height: 800, scale: 1, fontScale: 1 };
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

describe("mobile settings routes and preferences", () => {
  it("renders all 15 settings entries in four ordered groups across locales, themes, and compact widths", async () => {
    const locales = ["zh-CN", "en"] as const;
    const themes = ["light", "dark"] as const;
    const widths = [320, 390] as const;
    const sectionById = new Map(SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections.map((section) => [section.id, section] as const)));

    expect(expectedSettingsRowOrder).toHaveLength(15);
    for (const locale of locales) {
      for (const theme of themes) {
        for (const width of widths) {
          updateAppPreferences({ language: locale, theme });
          fixture.window = { width, height: 800, scale: 1, fontScale: 1 };

          const tree = renderRoute();
          const screen = byTestId(tree, "settings-home");
          expect(screen).toBeDefined();
          expect(styleRecord(screen?.props.style).backgroundColor).toBe(getThemeSnapshot().colors.settingsPageBackground);
          const scrollView = tree.find((element) => element.type === "ScrollView");
          expect(scrollView).toBeDefined();
          expect(styleRecord(scrollView?.props.contentContainerStyle)).toMatchObject({ width: "100%", maxWidth: 720 });

          expect(tree
            .filter((element) => typeof element.props.testID === "string" && element.props.testID.startsWith("settings-group-"))
            .map((element) => element.props.testID))
            .toEqual(expectedSettingsGroups.map((group) => `settings-group-${group.id}`));
          expect(tree
            .filter((element) => expectedSettingsRowOrder.includes(element.props.testID))
            .map((element) => element.props.testID))
            .toEqual(expectedSettingsRowOrder);

          for (const group of expectedSettingsGroups) {
            const groupTree = resolveElements(byTestId(tree, `settings-group-${group.id}`)?.props.children);
            expect(groupTree
              .filter((element) => group.rows.map(settingsRowTestID).includes(element.props.testID))
              .map((element) => element.props.testID))
              .toEqual(group.rows.map(settingsRowTestID));
          }

          for (const section of SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections)) {
            const rowID = settingsRowTestID(section.id);
            const row = byTestId(tree, rowID);
            const texts = rowTextElements(tree, rowID);
            expect(allText(tree)).toContain(t(section.labelKey));
            expect(row).toBeDefined();
            expect(texts).toHaveLength(2);
            expect(textValue(texts[0].props.children)).toBe(t(section.labelKey));
            expect(texts[0].props.numberOfLines).toBeUndefined();
            expect(texts[1].props.numberOfLines).toBe(1);
            expect(styleRecord(texts[1].props.style).textAlign).toBe("right");
            expect(row?.props.accessibilityLabel).toContain(t(section.labelKey));
            expect(row?.props.accessibilityLabel).toContain(textValue(texts[1].props.children));
          }

          const value = (sectionId: string) => textValue(rowTextElements(tree, settingsRowTestID(sectionId))[1]?.props.children);
          expect(value("connections_devices")).toBe(t("settings_hub.status_gateway_connected"));
          expect(value("models_services")).toBe(t("settings_hub.status_target_scope"));
          expect(value("conversation_preferences")).toBe(t("settings_hub.status_device_scope"));
          expect(value("execution_permissions")).toBe(t("settings_hub.status_target_scope"));
          for (const sectionId of expectedSettingsGroups.flatMap((group) => group.rows)) {
            expect(value(sectionId).length).toBeGreaterThan(0);
            expect(value(sectionId).length).toBeLessThanOrEqual(20);
          }
          expect(value("appearance")).toBe(t(theme === "light" ? "settings.theme_light" : "settings.theme_dark"));
          expect(sectionById.get("connections_devices")?.scope).toBe("device");
          expect(sectionById.get("models_services")?.scope).toBe("runtime_target");
        }
      }
    }
    await appPreferencesTestHelpers.waitForWrites();
  });

  it("routes each overview entry to its own settings-section deep link", () => {
    setLocalePreference("zh-CN");
    const home = renderRoute();
    const overviewIds = [
      "models_services",
      "execution_permissions",
      "conversation_preferences",
      "quick_phrases",
      "custom_instructions",
      "tool_configuration",
      "plugins_skills",
      "migration_results",
      "usage",
      "storage_cache",
    ];
    expect(SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections).filter((section) => section.destination === "overview").map((section) => section.id))
      .toEqual(overviewIds);
    for (const sectionId of overviewIds) {
      expect(getSettingsHubSection(sectionId)?.destination).toBe("overview");
      byTestId(home, settingsRowTestID(sectionId))?.props.onPress();
      expect(fixture.router.push).toHaveBeenLastCalledWith(`/settings-section?section=${sectionId}`);
    }
  });

  it("redirects known non-overview deep links to their existing settings pages", () => {
    const directRoutes = {
      connections_devices: "/settings-connections",
      appearance: "/settings-appearance",
      terminal: "/settings-terminal",
      connection_diagnostics: "/settings-diagnostics",
      about: "/settings-about",
    } as const;

    for (const [sectionId, href] of Object.entries(directRoutes)) {
      expect(getSettingsHubSection(sectionId)?.destination).not.toBe("overview");
      fixture.searchParams = { section: sectionId };
      const tree = renderRoute(SettingsSectionRoute);
      const redirect = tree.find((element) => element.type === "Redirect");

      expect(redirect?.props.href).toBe(href);
      expect(byTestId(tree, "settings-section-screen")).toBeUndefined();
      expect(byTestId(tree, "settings-section-stage")).toBeUndefined();
    }
  });

  it("routes each implemented section to its component with target selection only for target-scoped settings", () => {
    setLocalePreference("en");
    const componentBySection = {
      models_services: "settings-content-models_services",
      execution_permissions: "settings-content-execution_permissions",
      conversation_preferences: "settings-content-conversation_preferences",
      quick_phrases: "settings-content-quick_phrases",
      custom_instructions: "settings-content-custom_instructions",
      tool_configuration: "settings-content-tool_configuration",
      plugins_skills: "settings-content-plugins_skills",
      usage: "settings-content-usage",
      storage_cache: "settings-content-storage_cache",
    } as const;
    const targetScopedSections = new Set([
      "models_services",
      "execution_permissions",
      "custom_instructions",
      "tool_configuration",
      "plugins_skills",
      "migration_results",
      "usage",
    ]);
    const preferencesBefore = getAppPreferencesSnapshot();

    for (const [sectionId, contentTestID] of Object.entries(componentBySection)) {
      const section = getSettingsHubSection(sectionId);
      expect(section).toBeDefined();
      fixture.searchParams = { section: sectionId };
      const tree = renderRoute(SettingsSectionRoute);
      expect(byTestId(tree, "settings-section-screen")).toBeDefined();
      expect(byTestId(tree, "settings-section-title")?.props.children).toBe(t(section!.labelKey));
      expect(byTestId(tree, "settings-section-description")).toBeDefined();
      expect(allText(tree)).toContain(t(section!.labelKey));
      expect(allText(tree)).toContain(t(section!.descriptionKey));
      expect(byTestId(tree, contentTestID)).toBeDefined();
      const isTargetScoped = targetScopedSections.has(sectionId);
      expect(section!.scope).toBe(isTargetScoped ? "runtime_target" : "device");
      expect(byTestId(tree, "settings-target-provider") !== undefined).toBe(isTargetScoped);
      expect(byTestId(tree, "settings-target-selector") !== undefined).toBe(isTargetScoped);
      if (isTargetScoped) {
        const selectorIndex = tree.findIndex((element) => element.props.testID === "settings-target-selector");
        const contentIndex = tree.findIndex((element) => element.props.testID === contentTestID);
        expect(selectorIndex).toBeGreaterThan(-1);
        expect(contentIndex).toBeGreaterThan(selectorIndex);
      }
    }

    expect(getAppPreferencesSnapshot()).toEqual(preferencesBefore);
    expect(fixture.storage.size).toBe(0);
    expect(fixture.app.setActiveProfile).not.toHaveBeenCalled();
    expect(fixture.app.removeGateway).not.toHaveBeenCalled();
    expect(fixture.app.refresh).not.toHaveBeenCalled();
  });

  it("shows the unavailable view for unregistered components without changing Gateway or device state", () => {
    setLocalePreference("en");
    fixture.searchParams = { section: "unknown-section" };
    fixture.app.activeProfile = profile;
    const preferencesBefore = getAppPreferencesSnapshot();

    const tree = renderRoute(SettingsSectionRoute);
    expect(allText(tree)).toContain(t("settings_hub.unavailable_description"));
    expect(byTestId(tree, "settings-target-provider")).toBeUndefined();
    expect(byTestId(tree, "settings-target-selector")).toBeUndefined();
    expect(getAppPreferencesSnapshot()).toEqual(preferencesBefore);
    expect(fixture.storage.size).toBe(0);
    expect(fixture.app.setActiveProfile).not.toHaveBeenCalled();
    expect(fixture.app.removeGateway).not.toHaveBeenCalled();
    expect(fixture.app.refresh).not.toHaveBeenCalled();
  });

  it("keeps the removed browser settings deep link unavailable", () => {
    setLocalePreference("en");
    fixture.searchParams = { section: "browser" };
    const tree = renderRoute(SettingsSectionRoute);
    expect(getSettingsHubSection("browser")).toBeUndefined();
    expect(allText(tree)).toContain(t("settings_hub.unavailable_description"));
    expect(byTestId(tree, "settings-target-provider")).toBeUndefined();
    expect(byTestId(tree, "settings-target-selector")).toBeUndefined();
  });

  it("shows an unavailable page for missing or unknown section params and returns safely to settings", () => {
    setLocalePreference("zh-CN");
    for (const searchParams of [
      { section: "unknown-section" },
      { section: ["unknown-section", "models_services"] },
      {},
    ]) {
      fixture.searchParams = searchParams;
      const tree = renderRoute(SettingsSectionRoute);
      expect(byTestId(tree, "settings-section-screen")).toBeDefined();
      expect(allText(tree)).toContain("此设置分区不可用。请返回设置并选择其他分区。");
      expect(byTestId(tree, "settings-section-scope")).toBeUndefined();
      expect(byTestId(tree, "settings-section-runtime-context")).toBeUndefined();
      expect(byTestId(tree, "settings-hub-open-connections")).toBeUndefined();
      expect(byTestId(tree, "settings-hub-open-workspace")).toBeUndefined();
    }
    expect(getSettingsHubSection("unknown-section")).toBeUndefined();
    fixture.router.canGoBack.mockReturnValue(false);
    byTestId(renderRoute(SettingsSectionRoute), "settings-detail-back")?.props.onPress();
    expect(fixture.router.replace).toHaveBeenCalledWith("/home");
  });

  it("hydrates persisted choices, applies appearance sheet selections immediately, and restores after reload", async () => {
    fixture.storage.set(storageKey, JSON.stringify({ language: "zh-CN", theme: "light", terminalScrollbackLines: 12_000 }));
    await hydrateAppPreferences();
    expect(getAppPreferencesSnapshot()).toEqual({
      ...DEFAULT_APP_PREFERENCES,
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 12_000,
    });
    expect(getLocale()).toBe("zh-CN");
    expect(getThemeSnapshot().mode).toBe("light");

    let tree = renderRoute();
    expect(byTestId(tree, "settings-home")).toBeDefined();
    expect(allText(tree)).toContain("设置");
    expect(allText(tree)).toContain("连接与设备");
    expect(allText(tree)).toContain("已连接");
    expect(allText(tree)).not.toContain("Gateway · 已连接到 Gateway");
    expect(allText(tree)).toContain("浅色");
    expect(allText(tree)).toContain("12,000 行");
    expect(allText(tree)).not.toContain("简体中文");
    expect(allText(tree)).not.toContain("常用设置");
    expect(allText(tree)).not.toContain("使用偏好");
    expect(byTestId(tree, "settings-group-preferences")).toBeUndefined();
    const connectRow = byTestId(tree, "settings-manage-connections");
    const connectRowStyles = connectRow?.props.style({ pressed: false });
    expect(connectRowStyles?.[0].minHeight).toBe(56);
    expect(byTestId(tree, "remove-profile-settings-profile")).toBeUndefined();
    expect(allText(tree)).not.toContain("等待系统推送通道");
    expect(allText(tree)).not.toContain("等待 app-server 语音流协议");

    byTestId(tree, "settings-appearance")?.props.onPress();
    expect(fixture.router.push).toHaveBeenCalledWith("/settings-appearance");
    tree = renderRoute(SettingsAppearanceRoute);
    expect(byTestId(tree, "settings-appearance-screen")).toBeDefined();
    expect(byTestId(tree, "settings-theme-row")).toBeDefined();
    expect(byTestId(tree, "settings-language-row")).toBeDefined();
    expect(allText(tree)).toContain("浅色");
    expect(allText(tree)).toContain("简体中文");
    const pageStyle = (tree[0].props.style as Array<Record<string, unknown>>)[0];
    expect(pageStyle.backgroundColor).toBe("#F4F4F5");

    byTestId(tree, "settings-theme-row")?.props.onPress();
    tree = rerenderRoute();
    expect(byTestId(tree, "settings-choice-sheet-theme")?.props.visible).toBe(true);
    expect(byTestId(tree, "settings-theme-choice-light")?.props.accessibilityState.checked).toBe(true);
    byTestId(tree, "settings-theme-choice-dark")?.props.onPress();
    expect(getAppPreferencesSnapshot().theme).toBe("dark");
    expect(getThemeSnapshot().mode).toBe("dark");
    tree = rerenderRoute();
    expect(byTestId(tree, "settings-choice-sheet-theme")?.props.visible).toBe(false);
    expect(allText(tree)).toContain("深色");

    byTestId(tree, "settings-language-row")?.props.onPress();
    tree = rerenderRoute();
    expect(byTestId(tree, "settings-choice-sheet-language")?.props.visible).toBe(true);
    expect(byTestId(tree, "settings-language-choice-zh-cn")?.props.accessibilityState.checked).toBe(true);
    byTestId(tree, "settings-language-choice-en")?.props.onPress();
    expect(getAppPreferencesSnapshot().language).toBe("en");
    expect(getLocale()).toBe("en");
    expect(t("common.settings")).toBe("Settings");

    tree = renderRoute();
    expect(allText(tree)).toContain("Dark");
    expect(allText(tree)).not.toContain("English");
    expect((tree[0].props.style as Array<Record<string, unknown>>)[0].backgroundColor).toBe(getThemeSnapshot().colors.settingsPageBackground);
    tree = renderRoute(SettingsAppearanceRoute);
    expect(allText(tree)).toContain("English");
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

  it("dismisses theme and language sheets without changing their saved values", () => {
    updateAppPreferences({ language: "zh-CN", theme: "light" });
    let tree = renderRoute(SettingsAppearanceRoute);
    byTestId(tree, "settings-theme-row")?.props.onPress();
    tree = rerenderRoute();
    expect(byTestId(tree, "settings-theme-choice-light")?.props.accessibilityState.checked).toBe(true);
    byTestId(tree, "settings-choice-cancel")?.props.onPress();
    expect(getAppPreferencesSnapshot()).toMatchObject({ language: "zh-CN", theme: "light" });

    tree = rerenderRoute();
    byTestId(tree, "settings-language-row")?.props.onPress();
    tree = rerenderRoute();
    byTestId(tree, "settings-choice-cancel")?.props.onPress();
    expect(getAppPreferencesSnapshot()).toMatchObject({ language: "zh-CN", theme: "light" });
  });

  it("keeps the choice sheet reachable on short windows and leaves detail titles scalable", () => {
    fixture.window = { width: 320, height: 240, scale: 1, fontScale: 2 };
    let tree = renderRoute(SettingsAppearanceRoute);
    byTestId(tree, "settings-theme-row")?.props.onPress();
    tree = rerenderRoute();
    const dialog = tree.find(element => element.props.role === "dialog");
    const dialogStyle = Object.assign({}, ...(Array.isArray(dialog?.props.style) ? dialog.props.style : [dialog?.props.style]));
    expect(dialogStyle.maxHeight).toBe(240);
    expect(tree.some(element => element.type === "ScrollView")).toBe(true);

    tree = renderRoute(SettingsTerminalRoute);
    const title = byTestId(tree, "settings-terminal-title");
    expect(title?.props.numberOfLines).toBeUndefined();
    const titleStyle = Object.assign({}, ...(Array.isArray(title?.props.style) ? title.props.style : [title?.props.style]));
    expect(titleStyle.flex).toBe(1);
    expect(titleStyle.minWidth).toBe(0);
  });

  it("exposes all appearance choices as checked radio controls and persists without overwriting terminal preference", async () => {
    updateAppPreferences({ terminalScrollbackLines: 25_000 });
    let tree = renderRoute(SettingsAppearanceRoute);
    byTestId(tree, "settings-theme-row")?.props.onPress();
    tree = rerenderRoute();
    for (const id of ["settings-theme-choice-light", "settings-theme-choice-dark", "settings-theme-choice-system"]) {
      expect(byTestId(tree, id)?.props.accessibilityRole).toBe("radio");
      expect(typeof byTestId(tree, id)?.props.accessibilityState.checked).toBe("boolean");
      expect(byTestId(tree, id)?.props["aria-checked"]).toBe(id === "settings-theme-choice-system");
    }
    byTestId(tree, "settings-theme-choice-system")?.props.onPress();
    tree = rerenderRoute();
    byTestId(tree, "settings-language-row")?.props.onPress();
    tree = rerenderRoute();
    for (const id of ["settings-language-choice-system", "settings-language-choice-en", "settings-language-choice-zh-cn"]) {
      expect(byTestId(tree, id)?.props.accessibilityRole).toBe("radio");
      expect(typeof byTestId(tree, id)?.props.accessibilityState.checked).toBe("boolean");
      expect(byTestId(tree, id)?.props["aria-checked"]).toBe(id === "settings-language-choice-system");
    }
    byTestId(tree, "settings-language-choice-system")?.props.onPress();
    await appPreferencesTestHelpers.waitForWrites();
    expect(fixture.storage.get(storageKey)).toBe(JSON.stringify({
      ...DEFAULT_APP_PREFERENCES,
      terminalScrollbackLines: 25_000,
    }));
  });

  it("defaults Appearance to V3 and keeps the switch reachable in every version", async () => {
    updateAppPreferences({ terminalScrollbackLines: 25_000, theme: "dark" });
    let tree = renderRoute(SettingsAppearanceRoute);
    expect(rowTextElements(tree, "settings-interface-row").map(element => textValue(element.props.children))).toContain(t("settings.interface_v3"));
    for (const version of ["classic", "v3", "modern"] as const) {
      byTestId(tree, "settings-interface-row")?.props.onPress();
      tree = rerenderRoute();
      expect(byTestId(tree, "settings-choice-sheet-interface")?.props.visible).toBe(true);
      expect(byTestId(tree, `settings-interface-choice-${version}`)?.props.accessibilityRole).toBe("radio");
      byTestId(tree, `settings-interface-choice-${version}`)?.props.onPress();
      tree = rerenderRoute();
      expect(byTestId(tree, "settings-choice-sheet-interface")?.props.visible).toBe(false);
      expect(getAppPreferencesSnapshot()).toMatchObject({ interfaceVersion: version, terminalScrollbackLines: 25_000, theme: "dark" });
      expect(byTestId(tree, "settings-interface-row")).toBeDefined();
    }
    await appPreferencesTestHelpers.waitForWrites();
    expect(JSON.parse(fixture.storage.get(storageKey)!)).toMatchObject({ interfaceVersion: "modern", terminalScrollbackLines: 25_000 });
  });

  it("keeps Gateway management on its own route with unchecked saved profiles and preserved actions", async () => {
    setLocalePreference("zh-CN");
    fixture.app.profiles = [profile, otherProfile];
    fixture.app.runtime = {
      servers: [{ id: "local-settings", label: "Local server", transport: "local", workspacePath: "/workspace" }],
      statuses: [{ id: "local-settings", status: "online" }],
      loading: false,
      serversReady: true,
      error: null,
      reauthorizationRequired: false,
    };
    let home = renderRoute();
    byTestId(home, "settings-manage-connections")?.props.onPress();
    expect(fixture.router.push).toHaveBeenCalledWith("/settings-connections");

    let tree = renderRoute(SettingsConnectionsRoute);
    expect(byTestId(tree, "settings-connections-screen")).toBeDefined();
    expect(byTestId(tree, "settings-host-local-settings")).toBeDefined();
    expect(byTestId(tree, "settings-gateway-settings-profile")).toBeDefined();
    const uncheckedGateway = byTestId(tree, "settings-gateway-other-settings-profile");
    expect(uncheckedGateway).toBeDefined();
    expect(resolveElements(uncheckedGateway).some(element => element.type === "StatusDot")).toBe(false);
    expect(allText(resolveElements(uncheckedGateway))).toContain("未检测");
    expect(allText(tree)).toContain("已连接到 Gateway");
    expect(byTestId(tree, "remove-profile-settings-profile")).toBeDefined();
    expect(byTestId(tree, "settings-add-gateway")).toBeDefined();
    expect(byTestId(tree, "settings-add-connection")).toBeDefined();
    byTestId(tree, "settings-add-gateway")?.props.onPress();
    expect(fixture.router.push).toHaveBeenCalledWith({ pathname: "/welcome", params: { connectMode: "direct" } });

    byTestId(tree, "settings-gateway-other-settings-profile")?.props.onPress();
    await vi.waitFor(() => expect(fixture.app.setActiveProfile).toHaveBeenCalledWith(otherProfile.id));
    expect(fixture.router.replace).toHaveBeenCalled();

    byTestId(tree, "remove-profile-settings-profile")?.props.onPress();
    expect(requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      title: "移除 Gateway？",
      message: expect.stringContaining(profile.baseUrl),
      confirmLabel: "移除",
      destructive: true,
      onConfirm: expect.any(Function),
    }));
    vi.mocked(requestConfirmation).mock.calls.at(-1)?.[0].onConfirm();
    await vi.waitFor(() => expect(fixture.app.removeGateway).toHaveBeenCalledWith(profile.id));
  });

  it("shows the Gateway error before loading and uses the same status on diagnostics", () => {
    setLocalePreference("zh-CN");
    fixture.app.runtime = { ...fixture.app.runtime, loading: false, serversReady: false, error: "Gateway request failed" };
    let tree = renderRoute();
    expect(allText(tree)).toContain("未连接");
    expect(allText(tree)).not.toContain("Gateway 未连接");
    expect(allText(tree)).not.toContain("Gateway · Gateway 未连接");
    expect(allText(tree)).not.toContain("正在检查连接");
    tree = renderRoute(SettingsDiagnosticsRoute);
    expect(allText(tree)).toContain("Gateway 连接存在问题");
    expect(byTestId(tree, "settings-diagnostics-error")).toBeDefined();
  });

  it("opens full-screen terminal, diagnostics, and about pages with a safe detail back action", () => {
    setLocalePreference("zh-CN");
    const home = renderRoute();
    byTestId(home, "terminal-settings")?.props.onPress();
    expect(fixture.router.push).toHaveBeenCalledWith("/settings-terminal");
    byTestId(home, "diagnostics-settings")?.props.onPress();
    expect(fixture.router.push).toHaveBeenCalledWith("/settings-diagnostics");
    byTestId(home, "settings-about")?.props.onPress();
    expect(fixture.router.push).toHaveBeenCalledWith("/settings-about");

    let tree = renderRoute(SettingsTerminalRoute);
    expect(byTestId(tree, "settings-terminal-screen")).toBeDefined();
    expect(allText(tree)).toContain("终端设置");
    expect(byTestId(tree, "terminal-scrollback-10000")?.props["aria-checked"]).toBe(true);
    expect(byTestId(tree, "terminal-scrollback-50000")?.props["aria-checked"]).toBe(false);
    byTestId(tree, "terminal-scrollback-50000")?.props.onPress();
    tree = rerenderRoute();
    expect(byTestId(tree, "terminal-scrollback-50000")?.props.accessibilityState.checked).toBe(true);
    expect(byTestId(tree, "terminal-scrollback-50000")?.props["aria-checked"]).toBe(true);
    fixture.router.canGoBack.mockReturnValue(false);
    byTestId(tree, "settings-detail-back")?.props.onPress();
    expect(fixture.router.replace).toHaveBeenCalledWith("/settings");

    tree = renderRoute(SettingsDiagnosticsRoute);
    expect(byTestId(tree, "settings-diagnostics-screen")).toBeDefined();
    expect(byTestId(tree, "settings-rerun-diagnostics")?.props.accessibilityLabel).toBe(t("settings.rerun_diagnostics"));
    tree = renderRoute(SettingsAboutRoute);
    expect(byTestId(tree, "settings-about-screen")).toBeDefined();
    expect(byTestId(tree, "settings-about-versions")).toBeDefined();
    expect(byTestId(tree, "settings-mobile-version")).toBeDefined();
    expect(byTestId(tree, "settings-gateway-version")).toBeDefined();
    expect(byTestId(tree, "settings-app-server-version")).toBeDefined();
    expect(byTestId(tree, "settings-rpc-protocol-version")).toBeDefined();
  });

  it("attributes About versions to the selected target and marks missing sources unavailable", () => {
    setLocalePreference("zh-CN");
    const checkedAt = 1_797_000_000_000;
    fixture.app.runtime = {
      ...fixture.app.runtime,
      servers: [{ id: "target-one", label: "构建主机", runtime: "kcoder", transport: "ssh" }],
      statuses: [{ id: "target-one", status: "online", checkedAt, appServerVersion: "1.7.0", protocolVersion: "2026-07-27" }],
      gatewayRuntimeVersion: "0.4.0",
      statusesUpdatedAt: checkedAt,
      statusError: null,
    };

    let tree = renderRoute(SettingsAboutRoute);
    expect(allText(tree)).toContain("2.3.4");
    expect(allText(tree)).toContain("0.4.0");
    expect(allText(tree)).toContain("1.7.0");
    expect(allText(tree)).toContain("2026-07-27");
    expect(rowTextElements(tree, "settings-mobile-version").map(element => textValue(element.props.children))).toContain("已安装的原生应用版本");
    expect(rowTextElements(tree, "settings-app-server-version").map(element => textValue(element.props.children)).join(" ")).toContain("目标：构建主机 · target-one");
    expect(rowTextElements(tree, "settings-rpc-protocol-version").map(element => textValue(element.props.children)).join(" ")).toContain("app-server initialize 返回的 protocolVersion");
    expect(allText(tree)).not.toContain("v0.1.0");

    fixture.app.runtime = {
      ...fixture.app.runtime,
      servers: [
        { id: "target-one", label: "构建主机", runtime: "kcoder", transport: "ssh" },
        { id: "target-two", label: "测试主机", runtime: "kcoder", transport: "ssh" },
      ],
      statuses: [{ id: "target-one", status: "online", checkedAt, appServerVersion: "1.7.0", protocolVersion: "2026-07-27" }],
      gatewayRuntimeVersion: null,
      statusesUpdatedAt: null,
    };
    tree = renderRoute(SettingsAboutRoute);
    expect(rowTextElements(tree, "settings-gateway-version").map(element => textValue(element.props.children))).toContain(t("settings.version_unavailable"));
    expect(rowTextElements(tree, "settings-app-server-version").map(element => textValue(element.props.children))).toContain(t("settings.version_unavailable"));
    expect(rowTextElements(tree, "settings-rpc-protocol-version").map(element => textValue(element.props.children))).toContain(t("settings.version_unavailable"));
    expect(allText(tree).join(" ")).toContain(t("settings.version_source_no_target"));
  });

  it("keeps Gateway reachability separate from stale target errors and exposes target diagnostics", () => {
    setLocalePreference("zh-CN");
    const checkedAt = 1_797_000_000_000;
    fixture.app.runtime = {
      ...fixture.app.runtime,
      loading: false,
      serversReady: true,
      error: null,
      statusRefreshing: false,
      statusError: "status endpoint timed out",
      statusesUpdatedAt: checkedAt - 10_000,
      servers: [{ id: "target-one", label: "构建主机", runtime: "kcoder", transport: "ssh" }],
      statuses: [{ id: "target-one", status: "offline", checkedAt, error: "ssh connection refused", appServerVersion: null, protocolVersion: null }],
    };

    const tree = renderRoute(SettingsDiagnosticsRoute);
    expect(allText(tree)).toContain(t("settings.diagnostics_good"));
    expect(byTestId(tree, "settings-diagnostics-status-error")).toBeDefined();
    expect(byTestId(tree, "settings-diagnostics-stale")).toBeDefined();
    expect(byTestId(tree, "settings-diagnostics-host-error-target-one")).toBeDefined();
    expect(allText(tree).join(" ")).toContain("ssh connection refused");
    expect(allText(tree)).toContain(t("settings.diagnostics_target_checked_at", {
      p0: new Date(checkedAt).toLocaleString("zh-CN", { hour12: false }),
    }));
    expect(allText(tree).join(" ")).toContain(t("settings.version_unavailable"));
  });

  it("records a successful current-device revoke if the connection screen loses focus while pending", async () => {
    setLocalePreference("zh-CN");
    let finishRevoke!: () => void;
    const pendingRevoke = new Promise<void>(resolve => { finishRevoke = resolve; });
    vi.mocked(revokeMobileDevice).mockReturnValue(pendingRevoke);

    let tree = renderRoute(SettingsConnectionsRoute);
    byTestId(tree, "mobile-devices-toggle")?.props.onPress();
    fixture.setters[1]?.([{ id: profile.deviceId, label: "This phone", lastUsedAt: Date.now() }]);
    fixture.setters[4]?.(profileAuthorizationScopeKey(profile));
    tree = rerenderRoute();
    byTestId(tree, `revoke-mobile-device-${profile.deviceId}`)?.props.onPress();
    const confirmation = vi.mocked(requestConfirmation).mock.calls.at(-1)?.[0];
    expect(confirmation).toMatchObject({ destructive: true, confirmLabel: "撤销" });
    confirmation?.onConfirm();
    expect(revokeMobileDevice).toHaveBeenCalledWith(profile, profile.deviceId);

    fixture.focused = false;
    rerenderRoute();
    expect(fixture.states[5]).toBeNull();
    fixture.focused = true;
    rerenderRoute();
    finishRevoke();
    await vi.waitFor(() => expect(fixture.app.markGatewayReauthorizationRequired).toHaveBeenCalledWith(profile.id, profileAuthorizationScopeKey(profile)));
  });

  it("ignores a non-current device revoke error after blur and same-profile return", async () => {
    let rejectRevoke!: (error: Error) => void;
    const pendingRevoke = new Promise<void>((_resolve, reject) => { rejectRevoke = reject; });
    vi.mocked(revokeMobileDevice).mockReturnValue(pendingRevoke);

    let tree = renderRoute(SettingsConnectionsRoute);
    byTestId(tree, "mobile-devices-toggle")?.props.onPress();
    fixture.setters[1]?.([{ id: "older-device", label: "Older phone", lastUsedAt: Date.now() }]);
    fixture.setters[4]?.(profileAuthorizationScopeKey(profile));
    tree = rerenderRoute();
    byTestId(tree, "revoke-mobile-device-older-device")?.props.onPress();
    vi.mocked(requestConfirmation).mock.calls.at(-1)?.[0].onConfirm();
    expect(fixture.states[5]).toBe("older-device");

    fixture.focused = false;
    rerenderRoute();
    expect(fixture.states[5]).toBeNull();
    fixture.focused = true;
    rerenderRoute();
    const revisionBeforeStaleResult = fixture.states[6];

    rejectRevoke(new Error("stale revoke failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fixture.states[3]).toBeNull();
    expect(fixture.states[5]).toBeNull();
    expect(fixture.states[6]).toBe(revisionBeforeStaleResult);
  });

  it("ignores a pending device revoke after the same device list is closed and reopened", async () => {
    let rejectRevoke!: (error: Error) => void;
    const pendingRevoke = new Promise<void>((_resolve, reject) => { rejectRevoke = reject; });
    vi.mocked(revokeMobileDevice).mockReturnValue(pendingRevoke);

    let tree = renderRoute(SettingsConnectionsRoute);
    byTestId(tree, "mobile-devices-toggle")?.props.onPress();
    fixture.setters[1]?.([{ id: "older-device", label: "Older phone", lastUsedAt: Date.now() }]);
    fixture.setters[4]?.(profileAuthorizationScopeKey(profile));
    tree = rerenderRoute();
    byTestId(tree, "revoke-mobile-device-older-device")?.props.onPress();
    vi.mocked(requestConfirmation).mock.calls.at(-1)?.[0].onConfirm();

    byTestId(tree, "mobile-devices-toggle")?.props.onPress();
    tree = rerenderRoute();
    byTestId(tree, "mobile-devices-toggle")?.props.onPress();
    tree = rerenderRoute();
    const revisionBeforeStaleResult = fixture.states[6];
    rejectRevoke(new Error("closed-list revoke failure"));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fixture.states[3]).toBeNull();
    expect(fixture.states[5]).toBeNull();
    expect(fixture.states[6]).toBe(revisionBeforeStaleResult);
  });
});
