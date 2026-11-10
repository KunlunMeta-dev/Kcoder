import { useState, useSyncExternalStore } from "react";
import { SettingsChoiceSheet, type SettingsChoiceOption } from "@/components/settings/settings-choice-sheet";
import { LocalPreferenceStorageStatus } from "@/components/settings/LocalPreferenceStorageStatus";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/components/settings/settings-layout";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { getAppPreferencesSnapshot, subscribeAppPreferences, updateAppPreferences, type AppLanguagePreference, type AppThemePreference } from "@/storage/app-preferences";
import { useThemedStyles, type ThemeColors } from "@/theme";
import { StyleSheet, Text, View } from "react-native";

type ChoiceKind = "theme" | "language" | "interface" | null;

const themeOptions: readonly SettingsChoiceOption<AppThemePreference>[] = [
  { value: "light", label: "", testID: "settings-theme-choice-light" },
  { value: "dark", label: "", testID: "settings-theme-choice-dark" },
  { value: "system", label: "", testID: "settings-theme-choice-system" },
];

const languageOptions: readonly SettingsChoiceOption<AppLanguagePreference>[] = [
  { value: "system", label: "", testID: "settings-language-choice-system" },
  { value: "en", label: "", testID: "settings-language-choice-en" },
  { value: "zh-CN", label: "", testID: "settings-language-choice-zh-cn" },
];

export default function SettingsAppearanceRoute() {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferencesSnapshot, getAppPreferencesSnapshot);
  const [choice, setChoice] = useState<ChoiceKind>(null);
  const themeValue = preferences.theme === "light" ? t("settings.theme_light") : preferences.theme === "dark" ? t("settings.theme_dark") : t("settings.theme_system");
  const languageValue = preferences.language === "en" ? t("settings.language_english") : preferences.language === "zh-CN" ? t("settings.language_simplified_chinese") : t("settings.language_system");

  return (
    <>
      <SettingsPage title={t("settings.appearance_title")} testID="settings-appearance-screen" titleTestID="settings-appearance-title">
        <SettingsGroup testID="settings-appearance-options">
          <SettingsRow
            testID="settings-interface-row"
            label={t("settings.interface_version")}
            value={t(preferences.interfaceVersion === "classic" ? "settings.interface_classic" : preferences.interfaceVersion === "v3" ? "settings.interface_v3" : "settings.interface_modern")}
            onPress={() => setChoice("interface")}
          />
          <SettingsRow
            testID="settings-theme-row"
            label={t("settings.theme")}
            value={themeValue}
            onPress={() => setChoice("theme")}
          />
          <SettingsRow
            testID="settings-language-row"
            label={t("settings.language")}
            value={languageValue}
            last
            onPress={() => setChoice("language")}
          />
        </SettingsGroup>
        <View style={styles.preferenceFootnote}>
          <Text style={styles.footnote}>{t("settings.appearance_device_note")}</Text>
        </View>
        <LocalPreferenceStorageStatus testID="appearance-preferences" />
      </SettingsPage>

      <SettingsChoiceSheet
        visible={choice === "interface"}
        testID="settings-choice-sheet-interface"
        title={t("settings.interface_version")}
        options={[
          { value: "v3" as const, label: t("settings.interface_v3"), testID: "settings-interface-choice-v3" },
          { value: "modern" as const, label: t("settings.interface_modern"), testID: "settings-interface-choice-modern" },
          { value: "classic" as const, label: t("settings.interface_classic"), testID: "settings-interface-choice-classic" },
        ]}
        selected={preferences.interfaceVersion}
        onSelect={interfaceVersion => updateAppPreferences({ interfaceVersion })}
        onClose={() => setChoice(null)}
      />
      <SettingsChoiceSheet
        visible={choice === "theme"}
        testID="settings-choice-sheet-theme"
        title={t("settings.choose_theme")}
        options={themeOptions.map(option => ({ ...option, label: option.value === "light" ? t("settings.theme_light") : option.value === "dark" ? t("settings.theme_dark") : t("settings.theme_system") }))}
        selected={preferences.theme}
        onSelect={(theme) => updateAppPreferences({ theme })}
        onClose={() => setChoice(null)}
      />
      <SettingsChoiceSheet
        visible={choice === "language"}
        testID="settings-choice-sheet-language"
        title={t("settings.choose_language")}
        options={languageOptions.map(option => ({ ...option, label: option.value === "system" ? t("settings.language_system") : option.value === "en" ? t("settings.language_english") : t("settings.language_simplified_chinese") }))}
        selected={preferences.language}
        onSelect={(language) => updateAppPreferences({ language })}
        onClose={() => setChoice(null)}
      />
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  preferenceFootnote: { paddingHorizontal: 4 },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
});
