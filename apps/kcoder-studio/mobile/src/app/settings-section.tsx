import { Redirect, useLocalSearchParams, type Href } from "expo-router";
import type { ComponentType } from "react";
import { StyleSheet, Text } from "react-native";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { SettingsPage } from "@/components/settings/settings-layout";
import ConversationPreferencesSettings from "@/components/settings/ConversationPreferencesSettings";
import CustomInstructionsSettings from "@/components/settings/CustomInstructionsSettings";
import ExecutionDefaultsSettings from "@/components/settings/ExecutionDefaultsSettings";
import ExtensionsSettings from "@/components/settings/ExtensionsSettings";
import { ModelServicesSettings } from "@/components/settings/ModelServicesSettings";
import QuickPhrasesSettings from "@/components/settings/QuickPhrasesSettings";
import StorageCacheSettings from "@/components/settings/StorageCacheSettings";
import { ToolConfigurationSettings } from "@/components/settings/ToolConfigurationSettings";
import { UsageSettings } from "@/components/settings/UsageSettings";
import {MigrationResultsSettings} from "@/components/settings/MigrationResultsSettings";
import {
  SettingsTargetProvider,
  SettingsTargetSelector,
  useSettingsTarget,
} from "@/components/settings/SettingsTargetContext";
import {
  getSettingsHubSection,
  type SettingsHubDestination,
  type SettingsSectionId,
} from "@/components/settings/settings-sections";
import { profileHomeHref } from "@/navigation/back-or-replace";
import { useApp } from "@/state/AppContext";
import { spacing, useThemedStyles, type ThemeColors } from "@/theme";

const DIRECT_SETTINGS_ROUTES = {
  connections: "/settings-connections",
  appearance: "/settings-appearance",
  terminal: "/settings-terminal",
  diagnostics: "/settings-diagnostics",
  about: "/settings-about",
} as const satisfies Record<Exclude<SettingsHubDestination, "overview">, Href>;

const SECTION_COMPONENTS: Partial<Record<SettingsSectionId, ComponentType>> = {
  models_services: ModelServicesSettings,
  execution_permissions: ExecutionDefaultsSettings,
  conversation_preferences: ConversationPreferencesSettings,
  quick_phrases: QuickPhrasesSettings,
  custom_instructions: CustomInstructionsSettings,
  tool_configuration: ToolConfigurationSettings,
  plugins_skills: ExtensionsSettings,
  usage: UsageSettings,
  migration_results: MigrationResultsSettings,
  storage_cache: StorageCacheSettings,
};

function RuntimeTargetSectionContent({ Component }: { Component: ComponentType }) {
  const { targetIdentity } = useSettingsTarget();
  return (
    <>
      <SettingsTargetSelector />
      <Component key={targetIdentity ?? "no-selected-target"} />
    </>
  );
}

export default function SettingsSectionRoute() {
  const { section: sectionParam } = useLocalSearchParams<{ section?: string | string[] }>();
  const sectionId = Array.isArray(sectionParam) ? sectionParam[0] : sectionParam;
  const section = getSettingsHubSection(sectionId);
  const { activeProfile } = useApp();
  const styles = useThemedStyles(makeStyles);
  useLocale();

  if (section && section.destination !== "overview") {
    return <Redirect href={DIRECT_SETTINGS_ROUTES[section.destination]} />;
  }

  const Component = section ? SECTION_COMPONENTS[section.id] : undefined;
  if (!section || !Component) {
    return (
      <SettingsPage
        title={t("settings_hub.unavailable_title")}
        testID="settings-section-screen"
        titleTestID="settings-section-title"
        fallback={profileHomeHref(activeProfile?.id)}
      >
        <Text style={styles.description}>{t("settings_hub.unavailable_description")}</Text>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={t(section.labelKey)}
      testID="settings-section-screen"
      titleTestID="settings-section-title"
      fallback={profileHomeHref(activeProfile?.id)}
    >
      <Text testID="settings-section-description" style={styles.description}>
        {t(section.descriptionKey)}
      </Text>
      {section.scope === "runtime_target" ? (
        <SettingsTargetProvider>
          <RuntimeTargetSectionContent Component={Component} />
        </SettingsTargetProvider>
      ) : (
        <Component />
      )}
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.xs },
});
