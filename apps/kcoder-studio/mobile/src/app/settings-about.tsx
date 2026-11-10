import { useEffect, useState } from "react";
import { Info } from "lucide-react-native";
import AndroidAppUpdateSection from "@/features/updates/AndroidAppUpdateSection";
import { StyleSheet, Text, View } from "react-native";
import { SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { getMobileClientVersion, type MobileClientVersionSource } from "@/runtime/mobile-client-version";
import { loadSettingsServerChoice, resolveSettingsServerId, settingsTargetSelectionStorageKey } from "@/runtime/settings-target";
import { useApp } from "@/state/AppContext";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export default function SettingsAboutRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { activeProfile, demo, runtime } = useApp();
  const [savedTarget, setSavedTarget] = useState<{ scope: string; id: string | null } | null>(null);
  const selectionScope = activeProfile && !demo ? settingsTargetSelectionStorageKey(activeProfile) : null;
  const savedTargetId = savedTarget?.scope === selectionScope ? savedTarget.id : null;
  const selectedTargetId = demo ? null : resolveSettingsServerId(runtime.servers, savedTargetId);
  const selectedTarget = selectedTargetId
    ? runtime.servers.find(server => server.id === selectedTargetId)
    : undefined;
  const selectedStatus = selectedTargetId
    ? runtime.statuses.find(status => status.id === selectedTargetId)
    : undefined;
  const clientVersion = getMobileClientVersion();

  useEffect(() => {
    if (!activeProfile || demo || !selectionScope) {
      setSavedTarget(null);
      return;
    }
    let current = true;
    void loadSettingsServerChoice(activeProfile).then(id => {
      if (current) setSavedTarget({ scope: selectionScope, id });
    }).catch(() => {
      if (current) setSavedTarget({ scope: selectionScope, id: null });
    });
    return () => { current = false; };
  }, [activeProfile, demo, selectionScope]);

  const clientSource = clientVersion.source === "nativeAppVersion"
    ? t("settings.version_source_native")
    : clientVersion.source === "app.json"
      ? t("settings.version_source_expo")
      : t("settings.version_source_unavailable");
  const gatewaySource = runtime.gatewayRuntimeVersion
    ? t("settings.version_source_gateway")
    : t("settings.version_source_unavailable");
  const targetSource = selectedStatus?.appServerVersion
    ? t("settings.version_source_app_server")
    : t("settings.version_source_unavailable");
  const protocolSource = selectedStatus?.protocolVersion
    ? t("settings.version_source_protocol")
    : t("settings.version_source_unavailable");
  const targetAttribution = selectedTarget
    ? t("settings.version_selected_target", { p0: `${selectedTarget.label} · ${selectedTarget.id}` })
    : t("settings.version_source_no_target");
  const staleMarker = runtime.statusError && runtime.statusesUpdatedAt
    ? ` · ${t("settings.version_stale")}`
    : "";
  const checkedAt = (timestamp: number | null | undefined) => timestamp
    ? ` · ${t("settings.version_checked_at", { p0: new Date(timestamp).toLocaleString(locale, { hour12: false }) })}`
    : "";

  return (
    <SettingsPage title={t("settings.about")} testID="settings-about-screen" titleTestID="settings-about-title">
      <SettingsGroup testID="settings-about-details">
        <View style={styles.aboutCard}>
          <View style={styles.brandIcon}><Info size={26} color={colors.text} /></View>
          <Text style={styles.product}>{t("settings.product_name")}</Text>
        </View>
      </SettingsGroup>
      <AndroidAppUpdateSection />
      <SettingsGroup title={t("settings.version_sources")} testID="settings-about-versions">
        <VersionRow testID="settings-mobile-version" label={t("settings.version_mobile_client")}
          value={clientVersion.value} source={clientSource} />
        <VersionRow testID="settings-gateway-version" label={t("settings.version_gateway_runtime")}
          value={runtime.gatewayRuntimeVersion} source={`${gatewaySource}${checkedAt(runtime.statusesUpdatedAt)}${staleMarker}`} />
        <VersionRow testID="settings-app-server-version" label={t("settings.version_target_app_server")}
          value={selectedStatus?.appServerVersion ?? null}
          source={`${targetSource} · ${targetAttribution}${checkedAt(selectedStatus?.checkedAt)}${staleMarker}`} />
        <VersionRow testID="settings-rpc-protocol-version" label={t("settings.version_rpc_protocol")}
          value={selectedStatus?.protocolVersion ?? null}
          source={`${protocolSource} · ${targetAttribution}${checkedAt(selectedStatus?.checkedAt)}${staleMarker}`} last />
      </SettingsGroup>
      <Text style={styles.description}>{t("settings.about_description")}</Text>
    </SettingsPage>
  );
}

function VersionRow({ testID, label, value, source, last = false }: {
  testID: string;
  label: string;
  value: string | null | undefined;
  source: string;
  last?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID} style={[styles.versionRow, !last && styles.versionDivider]}>
      <Text style={styles.versionLabel}>{label}</Text>
      <Text selectable style={styles.version}>{value ?? t("settings.version_unavailable")}</Text>
      <Text style={styles.versionSource}>{source}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  aboutCard: { minHeight: 180, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  brandIcon: { width: 56, height: 56, alignItems: "center", justifyContent: "center", borderRadius: 28, backgroundColor: colors.surfaceHover },
  product: { color: colors.text, fontSize: 18, fontWeight: "600", textAlign: "center" },
  version: { color: colors.textDim, fontSize: 13, textAlign: "center" },
  versionRow: { minHeight: 68, justifyContent: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 3 },
  versionDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  versionLabel: { color: colors.text, fontSize: 14, fontWeight: "500" },
  versionSource: { color: colors.textDim, fontSize: 11, lineHeight: 16 },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.xs },
});
