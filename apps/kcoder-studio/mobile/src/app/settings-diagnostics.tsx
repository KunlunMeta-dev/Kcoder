import { RefreshCw } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { getGatewayDisplayState } from "@/components/settings/gateway-display-state";
import { StatusDot } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export default function SettingsDiagnosticsRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { activeProfile, runtime, refresh } = useApp();
  const state = getGatewayDisplayState(activeProfile, runtime);
  const stateLabel = state === "connected" ? t("settings.diagnostics_good") : state === "checking" ? t("settings.diagnostics_checking") : t("settings.diagnostics_bad");
  const refreshing = runtime.loading || runtime.statusRefreshing;
  const staleSnapshot = Boolean(runtime.statusError && runtime.statusesUpdatedAt);

  return (
    <SettingsPage title={t("settings.connection_diagnostics")} testID="settings-diagnostics-screen" titleTestID="settings-diagnostics-title">
      <SettingsGroup testID="settings-diagnostics-summary">
        <View style={styles.summary}>
          <View style={[styles.stateIndicator, state === "connected" ? styles.stateGood : state === "checking" ? styles.stateChecking : styles.stateBad]} />
          <View style={styles.summaryCopy}>
            <Text style={styles.summaryTitle}>{activeProfile ? stateLabel : t("settings.no_gateways")}</Text>
            <Text selectable numberOfLines={2} style={styles.endpoint}>{activeProfile?.baseUrl ?? t("settings.no_gateways")}</Text>
          </View>
          <Pressable
            testID="settings-rerun-diagnostics"
            accessibilityRole="button"
            accessibilityLabel={t("settings.rerun_diagnostics")}
            disabled={refreshing || !activeProfile}
            onPress={() => void refresh()}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
          >
            {refreshing ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={18} color={colors.textMuted} />}
          </Pressable>
        </View>
      </SettingsGroup>
      {runtime.error ? <Text testID="settings-diagnostics-error" accessibilityRole="alert" selectable style={styles.error}>{t("settings.diagnostics_gateway_error", { p0: runtime.error })}</Text> : null}
      {runtime.statusError ? <Text testID="settings-diagnostics-status-error" accessibilityRole="alert" selectable style={styles.error}>{t("settings.diagnostics_status_error", { p0: runtime.statusError })}</Text> : null}
      {staleSnapshot ? <Text testID="settings-diagnostics-stale" style={styles.stale}>{t("settings.diagnostics_snapshot_stale")}</Text> : null}
      <SettingsGroup title={t("settings.hosts")} testID="settings-diagnostics-hosts">
        {runtime.servers.map((server, index) => {
          const item = runtime.statuses.find(status => status.id === server.id);
          const status = item?.status ?? (runtime.statusRefreshing ? "checking" : "unknown");
          return (
            <View key={server.id} testID={`settings-diagnostics-host-${server.id}`} style={[styles.hostRow, index > 0 && styles.divider]}>
              <View style={styles.hostTopRow}>
                <StatusDot status={status} />
                <View style={styles.hostCopy}>
                  <Text style={styles.hostTitle}>{server.label}</Text>
                  <Text style={styles.hostMeta}>{server.transport === "ssh" ? t("settings.ssh_app_server") : t("settings.local_app_server")}{item?.latencyMs !== undefined ? ` · ${item.latencyMs} ms` : ""}</Text>
                </View>
                <Text style={styles.statusLabel}>{status === "online" ? t("settings.status_online") : status === "offline" ? t("settings.status_offline") : status === "checking" ? t("settings.status_checking") : t("task.unknown")}</Text>
              </View>
              <Text style={styles.hostMeta}>{t("settings.diagnostics_target_versions", {
                p0: item?.appServerVersion ?? t("settings.version_unavailable"),
                p1: item?.protocolVersion ?? t("settings.version_unavailable"),
              })}</Text>
              {item?.checkedAt ? <Text style={styles.hostMeta}>{t("settings.diagnostics_target_checked_at", {
                p0: new Date(item.checkedAt).toLocaleString(locale, { hour12: false }),
              })}</Text> : null}
              {item?.error ? <Text testID={`settings-diagnostics-host-error-${server.id}`} accessibilityRole="alert" selectable style={styles.error}>{t("settings.diagnostics_target_error", { p0: item.error })}</Text> : null}
            </View>
          );
        })}
        {runtime.servers.length === 0 ? <Text style={styles.empty}>{t("settings.no_hosts_returned")}</Text> : null}
      </SettingsGroup>
      {runtime.reauthorizationRequired ? <Text style={styles.error}>{t("settings.session_expired")}</Text> : null}
      <Text style={styles.footnote}>{t("settings.diagnostics_footnote")}</Text>
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  summary: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  stateIndicator: { width: 10, height: 10, borderRadius: radius.pill },
  stateGood: { backgroundColor: colors.green },
  stateBad: { backgroundColor: colors.red },
  stateChecking: { backgroundColor: colors.yellow },
  summaryCopy: { flex: 1, minWidth: 0, gap: 4 },
  summaryTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  endpoint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  refreshButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  hostRow: { minHeight: 62, gap: 4, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  hostTopRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.md },
  hostCopy: { flex: 1, minWidth: 0 },
  hostTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  hostMeta: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 2 },
  statusLabel: { color: colors.textMuted, fontSize: 13, flexShrink: 1, textAlign: "right" },
  stale: { color: colors.yellow, fontSize: 12, lineHeight: 18, marginHorizontal: spacing.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, marginHorizontal: spacing.sm },
  empty: { color: colors.textMuted, fontSize: 14, textAlign: "center", padding: spacing.xl },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  pressed: { opacity: 0.72 },
});
