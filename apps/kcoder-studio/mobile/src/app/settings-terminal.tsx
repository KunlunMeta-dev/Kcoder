import { useSyncExternalStore } from "react";
import { Check, TerminalSquare } from "lucide-react-native";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { LocalPreferenceStorageStatus } from "@/components/settings/LocalPreferenceStorageStatus";
import { t } from "@/i18n";
import { getAppPreferencesSnapshot, subscribeAppPreferences, updateAppPreferences } from "@/storage/app-preferences";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

const scrollbackOptions = [1_000, 5_000, 10_000, 50_000, 100_000] as const;

export default function SettingsTerminalRoute() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferencesSnapshot, getAppPreferencesSnapshot);

  return (
    <SettingsPage title={t("settings.terminal_settings")} testID="settings-terminal-screen" titleTestID="settings-terminal-title">
      <Text style={styles.description}>{t("settings.terminal_settings_description")}</Text>
      <SettingsGroup title={t("settings.scrollback_buffer")} testID="settings-scrollback-options">
        {scrollbackOptions.map((lines, index) => {
          const checked = preferences.terminalScrollbackLines === lines;
          return (
            <Pressable
              key={lines}
              testID={`terminal-scrollback-${lines}`}
              accessibilityRole="radio"
              accessibilityState={{ checked }}
              aria-checked={Platform.OS === "web" ? checked : undefined}
              onPress={() => updateAppPreferences({ terminalScrollbackLines: lines })}
              style={({ pressed }) => [styles.option, index < scrollbackOptions.length - 1 && styles.optionDivider, pressed && styles.pressed]}
            >
              <View style={styles.optionCopy}>
                <Text style={styles.optionTitle}>{lines.toLocaleString()}</Text>
                <Text style={styles.optionSubtitle}>{t("settings.scrollback_lines", { count: lines.toLocaleString() })}</Text>
              </View>
              {checked ? <Check size={20} color={colors.text} /> : <View style={styles.unchecked} />}
            </Pressable>
          );
        })}
      </SettingsGroup>
      <Text style={styles.footnote}>{t("settings.scrollback_footnote")}</Text>
      <LocalPreferenceStorageStatus testID="terminal-preferences" />
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  description: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: spacing.xs },
  option: { minHeight: 62, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingHorizontal: spacing.lg },
  optionCopy: { flex: 1, gap: 2 },
  optionTitle: { color: colors.text, fontSize: 16, fontWeight: "500" },
  optionSubtitle: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  optionDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  unchecked: { width: 20, height: 20 },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  pressed: { opacity: 0.72 },
});
