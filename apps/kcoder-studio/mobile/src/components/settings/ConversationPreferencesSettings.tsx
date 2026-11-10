import { useConversationFontStatus } from "@/features/conversation/conversation-fonts";
import { conversationLineSpacings, conversationSpacings, conversationFontFamilies } from "../../../../shared/conversationReading";
import { useState, useSyncExternalStore } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { SettingsChoiceSheet } from "@/components/settings/settings-choice-sheet";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-layout";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  getAppPreferencesSnapshot,
  getAppPreferencesStorageStatus,
  retryAppPreferencesSave,
  retryHydrateAppPreferences,
  subscribeAppPreferences,
  subscribeAppPreferencesStorageStatus,
  updateAppPreferencesAndWait,
  type ConversationFontScale,
  type ConversationLineSpacing,
} from "@/storage/app-preferences";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

type ChoiceSheet = "font-scale" | "line-spacing" | "block-spacing" | "letter-spacing" | "font-family" | null;

const fontScaleOptions = ["small", "normal", "large"] as const satisfies readonly ConversationFontScale[];
const lineSpacingOptions = conversationLineSpacings satisfies readonly ConversationLineSpacing[];

export function ConversationPreferencesSettings() {
  useLocale();
  const fontStatus = useConversationFontStatus();
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const storageStatus = useSyncExternalStore(
    subscribeAppPreferencesStorageStatus,
    getAppPreferencesStorageStatus,
    getAppPreferencesStorageStatus,
  );
  const styles = useThemedStyles(makeStyles);
  const [openSheet, setOpenSheet] = useState<ChoiceSheet>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const save = async (patch: Parameters<typeof updateAppPreferencesAndWait>[0]) => {
    setSaving(true);
    setSaveError(false);
    try {
      await updateAppPreferencesAndWait(patch);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: "thinkingCollapsedByDefault" | "toolsCollapsedByDefault") => {
    void save({ [key]: !preferences[key] });
  };

  return (
    <View testID="conversation-preferences-settings" style={styles.root}>
      <SettingsGroup title={t("settings_personalization.reading_title")} testID="conversation-reading-preferences">
        <SettingsRow
          testID="conversation-font-scale-row"
          label={t("settings_personalization.font_scale_label")}
          note={t("settings_personalization.font_scale_note")}
          value={t(`settings_personalization.font_scale_${preferences.conversationFontScale}`)}
          onPress={() => setOpenSheet("font-scale")}
        />
        <SettingsRow
          testID="conversation-line-spacing-row"
          label={t("settings_personalization.line_spacing_label")}
          note={t("settings_personalization.line_spacing_note")}
          value={t(`settings_personalization.line_spacing_${preferences.conversationLineSpacing}`)}
          onPress={() => setOpenSheet("line-spacing")}
        />
        <SettingsRow
          testID="conversation-block-spacing-row"
          label={t("settings_personalization.block_spacing_label")}
          note={t("settings_personalization.block_spacing_note")}
          value={t(`settings_personalization.block_spacing_${preferences.conversationBlockSpacing}`)}
          onPress={() => setOpenSheet("block-spacing")}

        />
        <SettingsRow
          testID="conversation-letter-spacing-row"
          label={t("settings_personalization.letter_spacing_label")}
          note={t("settings_personalization.letter_spacing_note")}
          value={t(`settings_personalization.letter_spacing_${preferences.conversationLetterSpacing}`)}
          onPress={() => setOpenSheet("letter-spacing")}

        />
        <SettingsRow
          testID="conversation-font-family-row"
          label={t("settings_personalization.font_family_label")}
          note={t("settings_personalization.font_family_note")}
          value={t(`settings_personalization.font_family_${preferences.conversationFontFamily.replaceAll("-", "_")}`)}
          onPress={() => setOpenSheet("font-family")}
          last
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings_personalization.disclosure_title")} testID="conversation-disclosure-preferences">
        <PreferenceSwitchRow
          testID="conversation-thinking-default-collapsed"
          label={t("settings_personalization.thinking_collapsed_label")}
          note={t("settings_personalization.thinking_collapsed_note")}
          value={preferences.thinkingCollapsedByDefault}
          disabled={saving}
          onPress={() => toggle("thinkingCollapsedByDefault")}
          last={false}
        />
        <PreferenceSwitchRow
          testID="conversation-tools-default-collapsed"
          label={t("settings_personalization.tools_collapsed_label")}
          note={t("settings_personalization.tools_collapsed_note")}
          value={preferences.toolsCollapsedByDefault}
          disabled={saving}
          onPress={() => toggle("toolsCollapsedByDefault")}
          last
        />
      </SettingsGroup>

      {preferences.conversationFontFamily === "noto-sans-sc" && fontStatus === "error" ? (
        <Text testID="conversation-font-fallback" accessibilityRole="alert" style={styles.muted}>{t("settings_personalization.font_load_failed")}</Text>
      ) : null}
      {storageStatus.hydration === "error" ? (
        <StorageStatusAction
          testID="conversation-preferences-hydration-error"
          message={t("settings_personalization.load_error")}
          actionLabel={t("settings_personalization.retry")}
          onPress={() => void retryHydrateAppPreferences()}
        />
      ) : null}
      {saveError || storageStatus.writeError ? (
        <StorageStatusAction
          testID="conversation-preferences-save-error"
          message={t("settings_personalization.save_error")}
          actionLabel={t("settings_personalization.retry")}
          onPress={() => void retryAppPreferencesSave().catch(() => setSaveError(true))}
        />
      ) : null}

      <SettingsChoiceSheet
        visible={openSheet === "font-scale"}
        testID="conversation-font-scale-sheet"
        title={t("settings_personalization.font_scale_label")}
        options={fontScaleOptions.map((value) => ({
          value,
          label: t(`settings_personalization.font_scale_${value}`),
          testID: `conversation-font-scale-choice-${value}`,
        }))}
        selected={preferences.conversationFontScale}
        onSelect={(value) => void save({ conversationFontScale: value })}
        onClose={() => setOpenSheet(null)}
      />
      <SettingsChoiceSheet
        visible={openSheet === "line-spacing"}
        testID="conversation-line-spacing-sheet"
        title={t("settings_personalization.line_spacing_label")}
        options={lineSpacingOptions.map((value) => ({
          value,
          label: t(`settings_personalization.line_spacing_${value}`),
          testID: `conversation-line-spacing-choice-${value}`,
        }))}
        selected={preferences.conversationLineSpacing}
        onSelect={(value) => void save({ conversationLineSpacing: value })}
        onClose={() => setOpenSheet(null)}
      />
      <SettingsChoiceSheet
        visible={openSheet === "block-spacing"}
        testID="conversation-block-spacing-sheet"
        title={t("settings_personalization.block_spacing_label")}
        options={conversationSpacings.map((value) => ({
          value,
          label: t(`settings_personalization.block_spacing_${value}`),
          testID: `conversation-block-spacing-choice-${value}`,
        }))}
        selected={preferences.conversationBlockSpacing}
        onSelect={(value) => void save({ conversationBlockSpacing: value })}
        onClose={() => setOpenSheet(null)}
      />
      <SettingsChoiceSheet
        visible={openSheet === "letter-spacing"}
        testID="conversation-letter-spacing-sheet"
        title={t("settings_personalization.letter_spacing_label")}
        options={conversationSpacings.map((value) => ({
          value,
          label: t(`settings_personalization.letter_spacing_${value}`),
          testID: `conversation-letter-spacing-choice-${value}`,
        }))}
        selected={preferences.conversationLetterSpacing}
        onSelect={(value) => void save({ conversationLetterSpacing: value })}
        onClose={() => setOpenSheet(null)}
      />
      <SettingsChoiceSheet
        visible={openSheet === "font-family"}
        testID="conversation-font-family-sheet"
        title={t("settings_personalization.font_family_label")}
        options={conversationFontFamilies.map((value) => ({
          value,
          label: t(`settings_personalization.font_family_${value.replaceAll("-", "_")}`),
          testID: `conversation-font-family-choice-${value}`,
        }))}
        selected={preferences.conversationFontFamily}
        onSelect={(value) => void save({ conversationFontFamily: value })}
        onClose={() => setOpenSheet(null)}
      />
      {saving ? <Text testID="conversation-preferences-saving" style={styles.muted}>{t("settings_personalization.saving")}</Text> : null}
    </View>
  );
}

function PreferenceSwitchRow({
  testID,
  label,
  note,
  value,
  disabled,
  onPress,
  last,
}: {
  testID: string;
  label: string;
  note: string;
  value: boolean;
  disabled: boolean;
  onPress(): void;
  last: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={Platform.OS === "web" ? value : undefined}
      aria-disabled={Platform.OS === "web" ? disabled : undefined}
      disabled={disabled}
      onPress={(event) => {
        if (Platform.OS === "web") {
          const target = event.target as unknown as {
            closest?: (selector: string) => unknown;
          } | null;
          if (target?.closest?.('input[role="switch"]')) return;
        }
        onPress();
      }}
      style={({ pressed }) => [styles.switchRow, pressed && styles.pressed]}
    >
      <View style={styles.copy}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.note}>{note}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onPress}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor={colors.background}
      />
      {!last ? <View style={[styles.divider, { pointerEvents: "none" }]} /> : null}
    </Pressable>
  );
}

function StorageStatusAction({
  testID,
  message,
  actionLabel,
  onPress,
}: {
  testID: string;
  message: string;
  actionLabel: string;
  onPress(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID} accessibilityRole="alert" style={styles.errorRow}>
      <Text style={styles.errorText}>{message}</Text>
      <Pressable accessibilityRole="button" onPress={onPress} style={styles.retryButton}>
        <Text style={styles.retryText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { gap: spacing.md },
  switchRow: { position: "relative", minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  label: { color: colors.text, fontSize: 16, fontWeight: "500" },
  note: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  divider: { position: "absolute", left: spacing.lg, right: spacing.lg, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  errorRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: 12, backgroundColor: colors.settingsGroupBackground },
  errorText: { flex: 1, color: colors.red, fontSize: 13 },
  retryButton: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  retryText: { color: colors.accentBright, fontSize: 14, fontWeight: "600" },
  muted: { color: colors.textDim, fontSize: 12 },
  pressed: { opacity: 0.72 },
});

export default ConversationPreferencesSettings;
