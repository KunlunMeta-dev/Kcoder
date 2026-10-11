import { useMemo } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Bot, ChevronLeft, FileText, Folder, Globe2, History, Laptop, RefreshCw, Server, SquareTerminal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, StatusDot } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

export default function HostDetailsRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { activeProfile, runtime, refresh } = useApp();
  const server = runtime.servers.find((item) => item.id === serverId);
  const status = useMemo(() => runtime.statuses.find((item) => item.id === serverId), [runtime.statuses, serverId]);

  return (
    <View testID="host-details-route" style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={() => backOrReplace(router, profileHomeHref(activeProfile?.id))} style={styles.headerButton}>
          <ChevronLeft size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("host_details.title")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("host_details.refresh_status")} disabled={runtime.loading} onPress={() => void refresh()} style={styles.headerButton}>
          {runtime.loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={18} color={colors.textMuted} />}
        </Pressable>
      </View>
      {!server ? (
        <EmptyState icon={<Server size={44} color={colors.textDim} />} title={t("host_details.missing_title")} body={t("host_details.missing_body")} />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
          <View style={styles.hero}>
            <View style={styles.heroIcon}>{server.transport === "ssh" ? <Server size={24} color={colors.text} /> : <Laptop size={24} color={colors.text} />}</View>
            <View style={styles.heroCopy}>
              <View style={styles.titleRow}><Text style={styles.title}>{server.label}</Text><StatusDot status={status?.status ?? "checking"} /></View>
              <Text style={styles.subtitle}>{server.transport === "ssh" ? t("host_details.ssh_app_server") : t("host_details.local_app_server")}</Text>
            </View>
          </View>
          <Text style={styles.section}>{t("host_details.connection")}</Text>
          <View style={styles.card}>
            <Detail label={t("host_details.status")} value={status?.status === "online" ? t("settings.status_online") : status?.status === "offline" ? t("settings.status_offline") : t("settings.status_checking")} />
            {status?.latencyMs !== undefined ? <Detail label={t("host_details.latency")} value={`${status.latencyMs} ms`} /> : null}
            {status?.checkedAt ? <Detail label={t("host_details.checked_at")} value={new Date(status.checkedAt).toLocaleString(locale, { hour12: false })} /> : null}
            <Detail label={t("host_details.type")} value={server.transport === "ssh" ? t("settings.transport_ssh") : t("settings.transport_local")} />
            <Detail label={t("host_details.runtime")} value={server.runtime ?? "kcoder"} />
            {server.host ? <Detail label={t("host_details.address")} value={`${server.user ? `${server.user}@` : ""}${server.host}:${server.port ?? 22}`} /> : null}
          </View>
          {status?.error ? <Text accessibilityRole="alert" selectable style={styles.statusError}>{status.error}</Text> : null}
          <Text style={styles.section}>{t("task.workspace")}</Text>
          <View style={styles.card}>
            <Detail icon={<Folder size={16} color={colors.textDim} />} label={t("host_details.default_directory")} value={server.workspacePath || "/"} />
            <Detail icon={<SquareTerminal size={16} color={colors.textDim} />} label={t("host_details.launch_command")} value={server.command || "kcoder app-server"} last />
          </View>
          <Text style={styles.section}>{t("host_details.capabilities")}</Text>
          <View style={styles.capabilityGrid}>
            <Capability icon={<Bot size={18} color={colors.accentBright} />} label={t("task.agent")} enabled />
            <Capability icon={<SquareTerminal size={18} color={colors.blue} />} label={t("task.terminal")} enabled={server.capabilities?.terminalSessions !== false} />
            <Capability icon={<Globe2 size={18} color={colors.blue} />} label={t("task.browser")} enabled={server.capabilities?.browserSessions !== false} />
            <Capability icon={<FileText size={18} color={colors.textMuted} />} label={t("task.file")} enabled={server.capabilities?.workspaceFiles !== false} />
          </View>
          {server.description ? <Text style={styles.description}>{server.description}</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile?.id, serverId: server.id } })} style={styles.primary}>
            <Text style={styles.primaryText}>{t("host_details.new_session")}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile?.id, serverId: server.id } } as never)} style={styles.secondary}>
            <History size={17} color={colors.textMuted} /><Text style={styles.secondaryText}>{t("host_details.view_history")}</Text>
          </Pressable>
          {server.transport === "ssh" ? (
            <Pressable accessibilityRole="button" onPress={() => router.replace({ pathname: "/server-editor", params: { serverId: server.id } } as never)} style={styles.secondary}>
              <Text style={styles.secondaryText}>{t("host_details.edit_ssh_config")}</Text>
            </Pressable>
          ) : <Text style={styles.note}>{t("host_details.local_host_note")}</Text>}
        </ScrollView>
      )}
    </View>
  );
}

function Detail({ icon, label, value, last = false }: { icon?: React.ReactNode; label: string; value: string; last?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.detail, !last && styles.divider]}>{icon}<Text style={styles.detailLabel}>{label}</Text><Text selectable numberOfLines={2} style={styles.detailValue}>{value}</Text></View>;
}

function Capability({ icon, label, enabled }: { icon: React.ReactNode; label: string; enabled: boolean }) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.capability, !enabled && styles.capabilityDisabled]}>{icon}<Text style={styles.capabilityLabel}>{label}</Text><Text style={[styles.capabilityStatus, enabled ? styles.capabilityOn : styles.capabilityOff]}>{enabled ? t("host_details.available") : t("host_details.unavailable")}</Text></View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { height: 56, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", padding: spacing.lg, gap: spacing.md },
  hero: { minHeight: 80, flexDirection: "row", alignItems: "center", gap: spacing.md },
  heroIcon: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  heroCopy: { flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 5 },
  section: { color: colors.textMuted, fontSize: 11, fontWeight: "600", marginTop: spacing.md },
  card: { borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface, overflow: "hidden" },
  detail: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  detailLabel: { width: 78, color: colors.textMuted, fontSize: 12 },
  detailValue: { flex: 1, color: colors.text, fontFamily: "monospace", fontSize: 11, textAlign: "right" },
  description: { color: colors.textMuted, fontSize: 12, lineHeight: 18, paddingVertical: spacing.sm },
  statusError: { color: colors.red, fontSize: 11, lineHeight: 17, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  capabilityGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, capability: { width: "48%", minHeight: 70, padding: spacing.md, gap: 5, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface }, capabilityDisabled: { opacity: 0.5 }, capabilityLabel: { color: colors.text, fontSize: 12, fontWeight: "600" }, capabilityStatus: { fontSize: 9, fontWeight: "700" }, capabilityOn: { color: colors.green }, capabilityOff: { color: colors.textDim },
  primary: { minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.accent },
  primaryText: { color: colors.accentText, fontSize: 14, fontWeight: "700" },
  secondary: { minHeight: 48, flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg },
  secondaryText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  note: { color: colors.textDim, fontSize: 11, lineHeight: 17, textAlign: "center", padding: spacing.md },
});
