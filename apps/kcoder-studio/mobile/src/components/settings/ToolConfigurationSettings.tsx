import { WebSearchDiagnostics } from './WebSearchDiagnostics';
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Check, RefreshCw } from "lucide-react-native";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { SettingsTargetChangedError, useSettingsTarget } from "@/components/settings/SettingsTargetContext";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { formatUsageMessage, parseToolProfileSettings, rpcDelivery, TOOL_PROFILES, type ToolProfile, type ToolProfileSettings } from "@/components/settings/settings-tools-usage-model";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

type TargetState = ReturnType<typeof useSettingsTarget>;

export function ToolConfigurationSettings() {
  const target = useSettingsTarget();
  return <ToolConfigurationSettingsForTarget key={target.targetIdentity ?? "no-selected-target"} target={target} />;
}

function ToolConfigurationSettingsForTarget({ target }: { target: TargetState }) {
  useLocale();
  const text = (key: string) => t(key);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [loaded, setLoaded] = useState<ToolProfileSettings | null>(null);
  const [choice, setChoice] = useState<ToolProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestGeneration = useRef(0);
  const supportsProfiles = target.capabilities.appServer?.experimental?.toolProfilesV1 === true;
  const selected = Boolean(target.profile && target.server && target.serverId && target.targetIdentity);
  const ready = selected && target.ready;

  useEffect(() => {
    const current = ++requestGeneration.current;
    setLoaded(null);
    setChoice(null);
    setSaved(false);
    setError(null);
    if (!ready || target.error || !supportsProfiles) {
      setLoading(false);
      return () => {
        if (requestGeneration.current === current) requestGeneration.current++;
      };
    }

    setLoading(true);
    void target.request<unknown>("settings/tools/read", {}).then(
      (value) => {
        if (requestGeneration.current !== current) return;
        const next = parseToolProfileSettings(value);
        setLoaded(next);
        setChoice(next.profile);
      },
      (failure: unknown) => {
        if (requestGeneration.current !== current) return;
        const reason = failure instanceof Error ? failure.message.trim() : "";
        setError(failure instanceof SettingsTargetChangedError
          ? text("settings_tools_usage.profile_target_changed")
          : reason || text("settings_tools_usage.profile_load_failed"));
      },
    ).finally(() => {
      if (requestGeneration.current === current) setLoading(false);
    });
    return () => {
      if (requestGeneration.current === current) requestGeneration.current++;
    };
  }, [ready, target.error, target.request, supportsProfiles, reload]);

  const retry = useCallback(() => {
    setError(null);
    setSaved(false);
    setReload((current) => current + 1);
  }, []);

  const save = async () => {
    if (!choice || !loaded || choice === loaded.profile || !ready || !supportsProfiles) return;
    const current = requestGeneration.current;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const value = await target.request<unknown>("settings/tools/save", { profile: choice });
      if (requestGeneration.current !== current) return;
      const next = parseToolProfileSettings(value);
      setLoaded(next);
      setChoice(next.profile);
      setSaved(true);
    } catch (failure) {
      if (requestGeneration.current !== current) return;
      const delivery = rpcDelivery(failure);
      if (delivery) {
        setLoaded(null);
        setChoice(null);
        setError(text(delivery === "unknown"
          ? "settings_tools_usage.profile_save_uncertain"
          : "settings_tools_usage.profile_target_changed"));
        return;
      }
      const reason = failure instanceof Error ? failure.message.trim() : "";
      setError(reason || text("settings_tools_usage.profile_save_failed"));
    } finally {
      if (requestGeneration.current === current) setSaving(false);
    }
  };

  const waitingForTarget = target.loading || (selected && !target.ready && !target.error);
  const unavailable = !selected && !target.loading;

  return (
    <>
      <SettingsGroup title={text("settings_tools_usage.target_label")} testID="tool-configuration-target">
        <View style={styles.targetRow}>
          <Text numberOfLines={1} style={styles.targetName}>
            {target.server?.label ?? text("settings_tools_usage.target_required")}
          </Text>
          {waitingForTarget ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        </View>
      </SettingsGroup>

      <SettingsGroup title={text("settings_tools_usage.tool_group")} testID="tool-configuration-settings">
        <View style={styles.groupIntro}>
          <Text style={styles.body}>{text("settings_tools_usage.tool_profile_help")}</Text>
          <Text style={styles.note}>{text("settings_tools_usage.applies_to_new_sessions")}</Text>
        </View>
        {unavailable ? <Text style={styles.noteBlock}>{text("settings_tools_usage.target_required")}</Text> : null}
        {waitingForTarget ? <StatusLine label={text("settings_tools_usage.target_loading")} loading styles={styles} colors={colors} /> : null}
        {target.error ? <ErrorNotice message={target.error} styles={styles} /> : null}
        {ready && !supportsProfiles ? <ErrorNotice message={text("settings_tools_usage.profile_unsupported")} styles={styles} /> : null}
        {ready && supportsProfiles && loading && !loaded ? <StatusLine label={text("settings_tools_usage.profile_loading")} loading styles={styles} colors={colors} /> : null}
        {ready && supportsProfiles && !loading && !loaded && error ? (
          <RetryNotice message={error} onRetry={retry} text={text("settings_tools_usage.retry")} styles={styles} colors={colors} />
        ) : null}
        {ready && supportsProfiles && loaded ? (
          <>
            {TOOL_PROFILES.map((profile) => {
              const active = choice === profile;
              const disabled = saving;
              return (
                <Pressable
                  key={profile}
                  testID={`tool-profile-option-${profile}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active, disabled }}
                  disabled={disabled}
                  onPress={() => {
                    setChoice(profile);
                    setSaved(false);
                    setError(null);
                  }}
                  style={({ pressed }) => [styles.profileOption, active && styles.profileOptionSelected, pressed && styles.pressed]}
                >
                  <View style={styles.profileCopy}>
                    <Text style={styles.profileTitle}>{text(`settings_tools_usage.profile_${profile}`)}</Text>
                    <Text style={styles.note}>{text(`settings_tools_usage.profile_${profile}_description`)}</Text>
                  </View>
                  {active ? <Check size={18} color={colors.blue} /> : null}
                </Pressable>
              );
            })}
            {loaded.cliOverride ? (
              <Text testID="tool-profile-cli-override" style={styles.noteBlock}>
                {formatUsageMessage(text("settings_tools_usage.profile_override"), {
                  profile: text(`settings_tools_usage.profile_${loaded.effectiveProfile}`),
                })}
              </Text>
            ) : null}
            {error ? <RetryNotice message={error} onRetry={() => void save()} text={text("settings_tools_usage.retry")} styles={styles} colors={colors} /> : null}
            {saved ? <Text testID="tool-profile-saved" accessibilityLiveRegion="polite" style={styles.success}>{text("settings_tools_usage.profile_saved")}</Text> : null}
            <Pressable
              testID="tool-profile-save"
              accessibilityRole="button"
              disabled={!choice || saving || choice === loaded.profile}
              onPress={() => void save()}
              style={({ pressed }) => [styles.saveButton, (!choice || saving || choice === loaded.profile) && styles.disabledButton, pressed && styles.pressed]}
            >
              {saving ? <ActivityIndicator size="small" color={colors.accentText} /> : null}
              <Text style={styles.saveButtonText}>{text(saving ? "settings_tools_usage.profile_saving" : "settings_tools_usage.profile_save")}</Text>
            </Pressable>
          </>
        ) : null}
      </SettingsGroup>
      {ready && target.capabilities.appServer?.experimental?.webSearchStatusV1 === true ? <WebSearchDiagnostics /> : null}
    </>
  );
}

function StatusLine({ label, loading, styles, colors }: { label: string; loading: boolean; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View testID="tool-profile-loading" accessibilityState={{ busy: loading }} style={styles.statusRow}>
      {loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <Text style={styles.note}>{label}</Text>
    </View>
  );
}

function ErrorNotice({ message, styles }: { message: string; styles: ReturnType<typeof makeStyles> }) {
  return <Text accessibilityRole="alert" testID="tool-profile-error" selectable style={styles.error}>{message}</Text>;
}

function RetryNotice({ message, onRetry, text, styles, colors }: { message: string; onRetry(): void; text: string; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View style={styles.retryRow}>
      <Text accessibilityRole="alert" testID="tool-profile-error" selectable style={styles.error}>{message}</Text>
      <Pressable testID="tool-profile-retry" accessibilityRole="button" accessibilityLabel={text} onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
        <RefreshCw size={16} color={colors.textMuted} />
        <Text style={styles.retryText}>{text}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  targetRow: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingHorizontal: spacing.lg },
  targetName: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "500" },
  groupIntro: { gap: spacing.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  note: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  noteBlock: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  statusRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  profileOption: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  profileOptionSelected: { backgroundColor: colors.settingsPageBackground },
  profileCopy: { flex: 1, minWidth: 0, gap: 2 },
  profileTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  retryRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  error: { color: colors.red, fontSize: 13, lineHeight: 19 },
  retryButton: { minHeight: 44, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.settingsPageBackground },
  retryText: { color: colors.text, fontSize: 14 },
  success: { color: colors.green, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  saveButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.blue },
  saveButtonText: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  disabledButton: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
