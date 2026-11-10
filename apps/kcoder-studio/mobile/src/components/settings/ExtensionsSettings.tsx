import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { requestConfirmation } from "@/platform/confirmation";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { useSettingsTarget } from "@/components/settings/SettingsTargetContext";
import {
  readTargetPluginList,
  readTargetSkillList,
  setTargetPluginEnabled,
  setTargetSkillEnabled,
  type TargetPluginDiagnostic,
  type TargetPluginSummary,
  type TargetSkillSummary,
} from "@/storage/target-extensions";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export default function ExtensionsSettings() {
  useLocale();
  const target = useSettingsTarget();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [plugins, setPlugins] = useState<TargetPluginSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<TargetPluginDiagnostic[]>([]);
  const [skills, setSkills] = useState<TargetSkillSummary[]>([]);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const generation = useRef(0);
  const targetIdentityRef = useRef(target.targetIdentity);
  const busyOwnerRef = useRef<string | null>(null);
  targetIdentityRef.current = target.targetIdentity;
  busyOwnerRef.current = busyOwner;

  const skillActivationSupported =
    target.capabilities.appServer?.experimental?.skillActivationV1 === true;

  const refresh = useCallback(async () => {
    const identity = target.targetIdentity;
    if (!identity || !target.ready) return;
    const ticket = ++generation.current;
    const isCurrent = () =>
      generation.current === ticket && targetIdentityRef.current === identity;
    setLoading(true);
    setPluginError(null);
    setSkillError(null);
    setLoadMessage(null);

    const pluginRead = readTargetPluginList(target.request);
    const skillRead = skillActivationSupported
      ? readTargetSkillList(target.request)
      : Promise.resolve(null);
    const [pluginResult, skillResult] = await Promise.allSettled([pluginRead, skillRead]);
    if (!isCurrent()) return;

    if (pluginResult.status === "fulfilled") {
      setPlugins(pluginResult.value.plugins);
      setDiagnostics(pluginResult.value.diagnostics);
    } else {
      setPlugins([]);
      setDiagnostics([]);
      setPluginError(errorText(pluginResult.reason));
    }
    if (skillResult.status === "fulfilled") {
      setSkills(skillResult.value?.items ?? []);
    } else {
      setSkills([]);
      setSkillError(errorText(skillResult.reason));
    }
    setLoading(false);
  }, [skillActivationSupported, target.ready, target.request, target.targetIdentity]);

  useEffect(() => {
    generation.current += 1;
    setPlugins([]);
    setDiagnostics([]);
    setSkills([]);
    setPluginError(null);
    setSkillError(null);
    setLoadMessage(null);
    setLoading(false);
    setBusyOwner(null);
    busyOwnerRef.current = null;
    if (target.ready) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh, target.targetIdentity, target.ready]);

  const isOwnerCurrent = (identity: string) => identity === targetIdentityRef.current;

  const changePlugin = (plugin: TargetPluginSummary) => {
    const identity = target.targetIdentity;
    if (!identity || !target.ready || busyOwnerRef.current) return;
    const enabled = !plugin.enabled;
    const request = target.request;
    requestConfirmation({
      title: t(enabled ? "extensions.plugin_enable_confirm_title" : "extensions.plugin_disable_confirm_title"),
      message: t("extensions.plugin_confirm_body", { name: plugin.name }),
      confirmLabel: t(enabled ? "extensions.confirm_enable" : "extensions.confirm_disable"),
      cancelLabel: t("extensions.cancel"),
      onConfirm: () => {
        if (!isOwnerCurrent(identity) || busyOwnerRef.current) return;
        busyOwnerRef.current = identity;
        setBusyOwner(identity);
        setPluginError(null);
        setLoadMessage(null);
        void setTargetPluginEnabled(request, plugin.id, enabled).then((receipt) => {
          if (!isOwnerCurrent(identity)) return;
          if (receipt) {
            setPlugins((current) => current.map((item) => item.id === plugin.id ? receipt : item));
          } else {
            setPlugins((current) => current.map((item) => item.id === plugin.id ? { ...item, enabled } : item));
          }
          setLoadMessage(t("extensions.applies_to_new_conversations"));
          void refresh();
        }).catch((error: unknown) => {
          if (isOwnerCurrent(identity)) setPluginError(errorText(error));
        }).finally(() => {
          if (busyOwnerRef.current === identity) {
            busyOwnerRef.current = null;
            setBusyOwner(null);
          }
        });
      },
    });
  };

  const changeSkill = (skill: TargetSkillSummary) => {
    const identity = target.targetIdentity;
    if (!identity || !target.ready || !skillActivationSupported || busyOwnerRef.current) return;
    const enabled = !skill.enabled;
    const request = target.request;
    requestConfirmation({
      title: t("extensions.skill_confirm_title"),
      message: t("extensions.skill_confirm_body", { name: skill.name }),
      confirmLabel: t(enabled ? "extensions.confirm_enable" : "extensions.confirm_disable"),
      cancelLabel: t("extensions.cancel"),
      onConfirm: () => {
        if (!isOwnerCurrent(identity) || busyOwnerRef.current) return;
        busyOwnerRef.current = identity;
        setBusyOwner(identity);
        setSkillError(null);
        setLoadMessage(null);
        void setTargetSkillEnabled(request, skill.name, enabled).then(() => {
          if (!isOwnerCurrent(identity)) return;
          setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item));
          setLoadMessage(t("extensions.applies_to_new_conversations"));
          void refresh();
        }).catch((error: unknown) => {
          if (isOwnerCurrent(identity)) setSkillError(errorText(error));
        }).finally(() => {
          if (busyOwnerRef.current === identity) {
            busyOwnerRef.current = null;
            setBusyOwner(null);
          }
        });
      },
    });
  };

  const currentBusy = busyOwner === target.targetIdentity;
  return (
    <View style={styles.content}>
      {!target.server ? (
        <SettingsGroup title={t("extensions.target_title")} testID="settings-extensions-target">
          <Text accessibilityRole="alert" style={styles.note}>
            {target.error ?? t("extensions.no_target")}
          </Text>
        </SettingsGroup>
      ) : (
        <SettingsGroup title={t("extensions.target_title")} testID="settings-extensions-target">
          <Text testID="settings-extensions-target-label" style={styles.targetName}>{target.server.label}</Text>
          <Text style={styles.note}>
            {target.workspacePath
              ? t("extensions.workspace", { path: target.workspacePath })
              : t("extensions.no_workspace")}
          </Text>
          {target.error ? <Text accessibilityRole="alert" style={styles.error}>{target.error}</Text> : null}
          {!target.ready && target.loading ? <Text accessibilityLiveRegion="polite" style={styles.note}>{t("extensions.connecting")}</Text> : null}
          {!target.ready && !target.loading && !target.error ? <Text style={styles.note}>{t("extensions.waiting_for_target")}</Text> : null}
        </SettingsGroup>
      )}

      <SettingsGroup title={t("extensions.plugins_title")} testID="settings-extensions-plugins">
        {loading ? <Text accessibilityLiveRegion="polite" style={styles.note}>{t("extensions.loading")}</Text> : null}
        {pluginError ? <Text accessibilityRole="alert" style={styles.error}>{t("extensions.plugin_error", { reason: pluginError })}</Text> : null}
        {!loading && !pluginError && plugins.length === 0 ? <Text style={styles.note}>{t("extensions.empty_plugins")}</Text> : null}
        {plugins.map((plugin) => (
          <ExtensionRow
            key={plugin.id}
            testID={`settings-plugin-toggle-${safeTestId(plugin.id)}`}
            name={plugin.name}
            detail={[plugin.id, plugin.version].filter(Boolean).join(" · ")}
            enabled={plugin.enabled}
            enabledLabel={t(plugin.enabled ? "extensions.plugin_enabled" : "extensions.plugin_disabled")}
            toggleLabel={t("extensions.toggle_plugin", { name: plugin.name })}
            disabled={!target.ready || loading || currentBusy}
            onToggle={() => changePlugin(plugin)}
          />
        ))}
        {diagnostics.length > 0 ? (
          <View testID="settings-extensions-diagnostics" style={styles.diagnostics}>
            <Text style={styles.diagnosticsTitle}>{t("extensions.diagnostics_title", { count: diagnostics.length })}</Text>
            {diagnostics.map((diagnostic, index) => (
              <Text key={`${diagnostic.code}-${index}`} style={styles.diagnosticText}>
                {diagnostic.code}: {diagnostic.message}
              </Text>
            ))}
          </View>
        ) : null}
        <Pressable
          testID="settings-extensions-refresh"
          accessibilityRole="button"
          accessibilityState={{ disabled: !target.ready || loading || currentBusy }}
          disabled={!target.ready || loading || currentBusy}
          onPress={() => void refresh()}
          style={({ pressed }) => [styles.action, pressed && styles.pressed, (!target.ready || loading || currentBusy) && styles.disabled]}
        >
          <RefreshCw size={17} color={colors.text} />
          <Text style={styles.actionText}>{t("extensions.refresh")}</Text>
        </Pressable>
      </SettingsGroup>

      <SettingsGroup title={t("extensions.skills_title")} testID="settings-extensions-skills">
        {!skillActivationSupported ? (
          <Text testID="settings-extensions-skills-unsupported" style={styles.note}>
            {t("extensions.skill_activation_unsupported")}
          </Text>
        ) : null}
        {skillError ? <Text accessibilityRole="alert" style={styles.error}>{t("extensions.skill_error", { reason: skillError })}</Text> : null}
        {skillActivationSupported && loading ? <Text accessibilityLiveRegion="polite" style={styles.note}>{t("extensions.loading")}</Text> : null}
        {skillActivationSupported && !loading && !skillError && skills.length === 0 ? <Text style={styles.note}>{t("extensions.empty_skills")}</Text> : null}
        {skills.map((skill) => (
          <ExtensionRow
            key={skill.name}
            testID={`settings-skill-toggle-${safeTestId(skill.name)}`}
            name={skill.name}
            detail={skill.description}
            enabled={skill.enabled}
            enabledLabel={t(skill.enabled ? "extensions.skill_enabled" : "extensions.skill_disabled")}
            toggleLabel={t("extensions.toggle_skill", { name: skill.name })}
            disabled={!target.ready || loading || currentBusy || !skillActivationSupported}
            onToggle={() => changeSkill(skill)}
          />
        ))}
        {skillActivationSupported ? <Text style={styles.note}>{t("extensions.applies_to_new_conversations")}</Text> : null}
        {loadMessage ? <Text testID="settings-extensions-status" accessibilityLiveRegion="polite" style={styles.status}>{loadMessage}</Text> : null}
      </SettingsGroup>
    </View>
  );
}

function ExtensionRow({
  testID,
  name,
  detail,
  enabled,
  enabledLabel,
  toggleLabel,
  disabled,
  onToggle,
}: {
  testID: string;
  name: string;
  detail: string;
  enabled: boolean;
  enabledLabel: string;
  toggleLabel: string;
  disabled: boolean;
  onToggle(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle}>{name}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      <Pressable
        testID={testID}
        accessibilityRole="switch"
        accessibilityLabel={toggleLabel}
        accessibilityState={{ checked: enabled, disabled }}
        disabled={disabled}
        onPress={onToggle}
        style={({ pressed }) => [styles.toggle, enabled && styles.toggleEnabled, pressed && styles.pressed, disabled && styles.disabled]}
      >
        <View style={[styles.toggleKnob, enabled && { backgroundColor: colors.accentText }]} />
        <Text style={[styles.toggleText, enabled && styles.toggleTextEnabled]}>{enabledLabel}</Text>
      </Pressable>
    </View>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  targetName: { color: colors.text, fontSize: 14, fontWeight: "600", lineHeight: 20, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  error: { color: colors.red, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  status: { color: colors.green, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  action: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  actionText: { color: colors.text, fontSize: 14, fontWeight: "500", lineHeight: 20 },
  row: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  rowDetail: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  toggle: { minHeight: 36, minWidth: 94, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 18 },
  toggleEnabled: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleKnob: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textMuted },
  toggleText: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  toggleTextEnabled: { color: colors.accentText },
  diagnostics: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  diagnosticsTitle: { color: colors.text, fontSize: 12, fontWeight: "600" },
  diagnosticText: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.5 },
});
