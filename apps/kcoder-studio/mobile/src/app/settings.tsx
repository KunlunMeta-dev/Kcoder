import { useRouter } from "expo-router";
import {
  BarChart3,
  Cloud,
  HardDrive,
  Info,
  Keyboard,
  MessageSquare,
  Puzzle,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  Sun,
  TerminalSquare,
  TextQuote,
} from "lucide-react-native";
import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/components/settings/settings-layout";
import { getSettingsHubSection, SETTINGS_SECTION_GROUPS, type SettingsSectionId } from "@/components/settings/settings-sections";
import { getGatewayDisplayState } from "@/components/settings/gateway-display-state";
import { useApp } from "@/state/AppContext";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { getAppPreferencesSnapshot, subscribeAppPreferences } from "@/storage/app-preferences";
import { profileHomeHref } from "@/navigation/back-or-replace";
import { getMobileClientVersion } from "@/runtime/mobile-client-version";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

const sectionIcons = {
  connections_devices: Cloud,
  models_services: Server,
  execution_permissions: ShieldCheck,
  appearance: Sun,
  conversation_preferences: MessageSquare,
  quick_phrases: Keyboard,
  custom_instructions: TextQuote,
  tool_configuration: SlidersHorizontal,
  plugins_skills: Puzzle,
  usage: BarChart3,
  migration_results: HardDrive,
  storage_cache: HardDrive,
  terminal: TerminalSquare,
  connection_diagnostics: Stethoscope,
  about: Info,
} satisfies Record<SettingsSectionId, typeof Cloud>;

export default function SettingsRoute() {
  const router = useRouter();
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { activeProfile, runtime, demo } = useApp();
  const appPreferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferencesSnapshot, getAppPreferencesSnapshot);
  const gatewayState = getGatewayDisplayState(activeProfile, runtime);

  const gatewayStatus = !activeProfile
    ? t("settings_hub.status_gateway_disconnected")
    : (activeProfile.expiresAt <= Date.now() && !activeProfile.refreshToken) || runtime.reauthorizationRequired
      ? t("settings_hub.status_gateway_expired")
      : gatewayState === "connected"
        ? t("settings_hub.status_gateway_connected")
        : gatewayState === "checking"
          ? t("settings_hub.status_gateway_checking")
          : t("settings_hub.status_gateway_disconnected");
  const themeValue = appPreferences.theme === "light"
    ? t("settings.theme_light")
    : appPreferences.theme === "dark"
      ? t("settings.theme_dark")
      : t("settings.theme_system");
  // Unknown diagnostics remain an issue state; only a confirmed Gateway connection is healthy.
  const diagnosticsValue = gatewayState === "connected"
    ? t("settings.diagnostics_ok")
    : gatewayState === "checking"
      ? t("settings.gateway_checking")
      : t("settings.diagnostics_has_error");
  const mobileVersion = getMobileClientVersion().value ?? t("settings.version_unavailable");

  const statusFor = (section: (typeof SETTINGS_SECTION_GROUPS)[number]["sections"][number]) => {
    switch (section.status) {
      case "gateway": return gatewayStatus;
      case "appearance": return themeValue;
      case "terminal": return t("settings.scrollback_short", { count: appPreferences.terminalScrollbackLines.toLocaleString(locale) });
      case "diagnostics": return diagnosticsValue;
      case "version": return mobileVersion;
      case "target_scope": return t("settings_hub.status_target_scope");
      case "device_scope": return t("settings_hub.status_device_scope");
      case "in_session": return t("settings_hub.status_in_session");
    }
  };

  const openSection = (sectionId: SettingsSectionId) => {
    const section = getSettingsHubSection(sectionId);
    if (!section) return;
    switch (section.destination) {
      case "connections": router.push("/settings-connections"); return;
      case "appearance": router.push("/settings-appearance"); return;
      case "terminal": router.push("/settings-terminal"); return;
      case "diagnostics": router.push("/settings-diagnostics"); return;
      case "about": router.push("/settings-about"); return;
      case "overview": router.push(`/settings-section?section=${section.id}`); return;
    }
  };

  return (
    <SettingsPage
      title={t("common.settings")}
      testID="settings-home"
      titleTestID="settings-home-title"
      fallback={profileHomeHref(activeProfile?.id)}
    >
      {SETTINGS_SECTION_GROUPS.map((group) => (
        <SettingsGroup
          key={group.id}
          title={t(group.titleKey)}
          testID={`settings-group-${group.id}`}
        >
          {group.sections.map((section, index) => {
            const Icon = sectionIcons[section.id];
            const label = t(section.labelKey);
            const status = statusFor(section);
            return (
              <SettingsRow
                key={section.id}
                testID={section.id === "connections_devices" ? "settings-manage-connections"
                  : section.id === "appearance" ? "settings-appearance"
                    : section.id === "terminal" ? "terminal-settings"
                      : section.id === "connection_diagnostics" ? "diagnostics-settings"
                        : section.id === "about" ? "settings-about"
                          : `settings-section-${section.id}`}
                icon={<Icon size={20} color={colors.text} />}
                label={label}
                value={status}
                valueNumberOfLines={1}
                accessibilityLabel={`${label}, ${status}`}
                last={index === group.sections.length - 1}
                onPress={() => openSection(section.id)}
              />
            );
          })}
        </SettingsGroup>
      ))}

      {demo ? <View style={styles.footer}><Text style={styles.demo}>{t("settings.demo_note")}</Text></View> : null}
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  footer: { paddingTop: spacing.xs, alignItems: "center" },
  demo: { color: colors.yellow, fontSize: 12, lineHeight: 18, textAlign: "center" },
});
