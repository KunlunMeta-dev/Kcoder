import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { settingsModelsEn } from "@/i18n/locales/settings-models.en";
import { settingsModelsZhCN } from "@/i18n/locales/settings-models.zh-CN";
import { settingsDefaultsEn } from "@/i18n/locales/settings-defaults.en";
import { settingsDefaultsZhCN } from "@/i18n/locales/settings-defaults.zh-CN";
import { settingsPersonalizationEn } from "@/i18n/locales/settings-personalization.en";
import { settingsPersonalizationZhCN } from "@/i18n/locales/settings-personalization.zh-CN";
import { settingsToolsUsageEn } from "@/i18n/locales/settings-tools-usage.en";
import { settingsToolsUsageZhCN } from "@/i18n/locales/settings-tools-usage.zh-CN";
import { en as settingsExtensionsStorageEn } from "@/i18n/locales/settings-extensions-storage.en";
import { zhCN as settingsExtensionsStorageZhCN } from "@/i18n/locales/settings-extensions-storage.zh-CN";
import { SETTINGS_RUNTIME_EN } from "@/i18n/locales/settings-runtime.en";
import { SETTINGS_RUNTIME_ZH_CN } from "@/i18n/locales/settings-runtime.zh-CN";
import { getSettingsHubSection, SETTINGS_SECTION_GROUPS } from "@/components/settings/settings-sections";

const settingsLocaleModules = [
  [settingsModelsEn, settingsModelsZhCN],
  [settingsDefaultsEn, settingsDefaultsZhCN],
  [settingsPersonalizationEn, settingsPersonalizationZhCN],
  [settingsToolsUsageEn, settingsToolsUsageZhCN],
  [settingsExtensionsStorageEn, settingsExtensionsStorageZhCN],
  [SETTINGS_RUNTIME_EN, SETTINGS_RUNTIME_ZH_CN],
] as const;

const source = [
  "../settings.tsx",
  "../settings-section.tsx",
  "../settings-connections.tsx",
  "../settings-appearance.tsx",
  "../settings-terminal.tsx",
  "../settings-diagnostics.tsx",
  "../settings-about.tsx",
  "../../components/settings/settings-layout.tsx",
  "../../components/settings/settings-sections.ts",
  "../../components/settings/settings-choice-sheet.tsx",
  "../../components/settings/SettingsTargetContext.tsx",
  "../../components/settings/ModelServicesSettings.tsx",
  "../../components/settings/ExecutionDefaultsSettings.tsx",
  "../../components/settings/CustomInstructionsSettings.tsx",
  "../../components/settings/ConversationPreferencesSettings.tsx",
  "../../components/settings/QuickPhrasesSettings.tsx",
  "../../components/settings/ToolConfigurationSettings.tsx",
  "../../components/settings/UsageSettings.tsx",
  "../../components/settings/ExtensionsSettings.tsx",
  "../../components/settings/StorageCacheSettings.tsx",
].map((path) => readFileSync(new URL(path, import.meta.url).pathname, "utf8")).join("\n");

function extractTKeys(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("settings route i18n", () => {
  test("uses t() for user-facing strings", () => {
    expect(extractTKeys(source).length).toBeGreaterThan(0);
  });

  test("every t() key exists in the en locale", () => {
    for (const key of extractTKeys(source)) {
      expect(en[key], `key ${key}`).toBeDefined();
      expect(zhCN[key], `key ${key}`).toBeDefined();
    }
  });

  test("all settings domain locale keys are included in the composed locales", () => {
    for (const [domainEn, domainZhCN] of settingsLocaleModules) {
      for (const [key, value] of Object.entries(domainEn)) {
        expect(en[key], `en ${key}`).toBe(value);
      }
      for (const [key, value] of Object.entries(domainZhCN)) {
        expect(zhCN[key], `zh-CN ${key}`).toBe(value);
      }
    }
  });

  test("runtime-target editors are keyed to the selected target identity", () => {
    expect(source).toContain('key={targetIdentity ?? "no-selected-target"}');
  });

  test("registry labels and descriptions exist in both locales", () => {
    const keys = SETTINGS_SECTION_GROUPS.flatMap((group) => [
      group.titleKey,
      ...group.sections.flatMap((section) => [section.labelKey, section.descriptionKey]),
    ]);
    for (const key of keys) {
      expect(en[key]?.trim().length, `en ${key}`).toBeGreaterThan(0);
      expect(zhCN[key]?.trim().length, `zh-CN ${key}`).toBeGreaterThan(0);
    }
  });

  test("dynamic detail-page status and unavailable copy exists in both locales", () => {
    const keys = [
      "settings_hub.status_target_scope",
      "settings_hub.status_device_scope",
      "settings_hub.unavailable_description",
    ];
    for (const key of keys) {
      expect(en[key]?.trim().length, `en ${key}`).toBeGreaterThan(0);
      expect(zhCN[key]?.trim().length, `zh-CN ${key}`).toBeGreaterThan(0);
    }
  });

  test("settings keeps fifteen real preferences across four groups and has no browser destination", () => {
    const sections = SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections);
    expect(SETTINGS_SECTION_GROUPS).toHaveLength(4);
    expect(sections).toHaveLength(15);
    expect(getSettingsHubSection("browser")).toBeUndefined();
    expect(source).not.toContain("BrowserSettings");
  });
});
