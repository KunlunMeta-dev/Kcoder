import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Bot, ChevronLeft, FileText, Folder, Globe2, History, Laptop, RefreshCw, Server, SquareTerminal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, StatusDot } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { HistoryRefreshModal, type HistoryRefreshTarget } from "@/components/history-refresh-modal";
import { listWorkspaceOptions, workspaceThreadScopeIdentity, type WorkspaceOption } from "@/runtime/task-runtime/workspaces";
import { threadListReadOwner } from "@/runtime/thread-list-projection";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";

export default function HostDetailsRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId, profileId } = useLocalSearchParams<{ serverId: string; profileId: string }>();
  const { activeProfile, runtime, refresh, demo } = useApp();
  const isFocused = useIsFocused();
  const server = profileId && activeProfile?.id === profileId ? runtime.servers.find((item) => item.id === serverId) : undefined;
  const serverIdentity = server ? JSON.stringify(server) : null;
  const serverRef = useRef(server);
  serverRef.current = server;
  const status = useMemo(() => runtime.statuses.find((item) => item.id === serverId), [runtime.statuses, serverId]);
  const statusCurrent = !runtime.statusRefreshing && !runtime.statusError && !runtime.reauthorizationRequired;
  const connectionStatus = runtime.reauthorizationRequired || runtime.statusError ? "unknown"
    : runtime.statusRefreshing ? "checking" : status?.status ?? "unknown";
  const connectionLabel = runtime.reauthorizationRequired ? t("settings.session_expired_reauth")
    : connectionStatus === "online" ? t("settings.status_online")
      : connectionStatus === "offline" ? t("settings.status_offline")
        : connectionStatus === "checking" ? t("settings.status_checking") : t("host_details.unknown");
  const capabilities = statusCurrent && status?.status === "online" ? status.capabilities?.experimental : undefined;
  const statusError = runtime.statusError || (statusCurrent ? status?.error : undefined);
  const refreshing = runtime.loading || runtime.statusRefreshing;
  const historyOwner = activeProfile && server && profileId === activeProfile.id
    ? JSON.stringify([profileAuthorizationScopeKey(activeProfile), threadListReadOwner(activeProfile, server, { archived: false }), profileId])
    : null;
  const historyAllowed = Boolean(isFocused && !demo && activeProfile && server && runtime.serversReady && !runtime.reauthorizationRequired && historyOwner);
  const historyOwnerRef = useRef(historyOwner);
  historyOwnerRef.current = historyOwner;
  const historyAllowedRef = useRef(historyAllowed);
  historyAllowedRef.current = historyAllowed;
  const [workspaceCatalog, setWorkspaceCatalog] = useState<{ owner: string | null; phase: "idle" | "loading" | "ready" | "error"; options: WorkspaceOption[]; error?: string }>({ owner: null, phase: "idle", options: [] });
  const [historyRefreshTarget, setHistoryRefreshTarget] = useState<HistoryRefreshTarget | null>(null);

  useEffect(() => {
    setHistoryRefreshTarget(null);
    const catalogServer = serverRef.current;
    if (!historyAllowed || !activeProfile || !catalogServer || !historyOwner) {
      setWorkspaceCatalog({ owner: null, phase: "idle", options: [] });
      return;
    }
    const controller = new AbortController();
    const owner = historyOwner;
    setWorkspaceCatalog({ owner, phase: "loading", options: [] });
    void listWorkspaceOptions(activeProfile, catalogServer, { signal: controller.signal }).then((options) => {
      if (controller.signal.aborted || historyOwnerRef.current !== owner || !historyAllowedRef.current) return;
      setWorkspaceCatalog({ owner, phase: "ready", options });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || historyOwnerRef.current !== owner || !historyAllowedRef.current) return;
      setWorkspaceCatalog({ owner, phase: "error", options: [], error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [activeProfile, historyAllowed, historyOwner, serverIdentity]);

  useEffect(() => {
    if (!historyAllowed) setHistoryRefreshTarget(null);
  }, [historyAllowed, historyOwner]);

  const knownWorkspacePaths = useMemo(() => {
    if (!server || !historyOwner || workspaceCatalog.owner !== historyOwner || workspaceCatalog.phase !== "ready") return [];
    const paths = new Map<string, string>();
    const add = (path: string | undefined) => {
      const exact = path?.trim();
      if (exact) {
        const identity = workspaceThreadScopeIdentity(exact);
        if (!paths.has(identity)) paths.set(identity, exact);
      }
    };
    add(server.workspacePath);
    for (const option of workspaceCatalog.options) add(option.path);
    return [...paths.values()];
  }, [historyOwner, server, workspaceCatalog]);
  const historyTargetVisible = Boolean(historyRefreshTarget && historyAllowed && activeProfile && server && historyOwner &&
    historyRefreshTarget.profile === activeProfile && historyRefreshTarget.server.id === server.id &&
    JSON.stringify(historyRefreshTarget.server) === JSON.stringify(server) && historyRefreshTarget.owner === historyOwner &&
    historyRefreshTarget.kind === "known-workspaces" && historyRefreshTarget.workspaces.length === knownWorkspacePaths.length &&
    historyRefreshTarget.workspaces.every((path, index) => workspaceThreadScopeIdentity(path) === workspaceThreadScopeIdentity(knownWorkspacePaths[index])));
  const visibleHistoryRefreshTarget = historyTargetVisible ? historyRefreshTarget : null;
  const historyTargetCurrent = () => Boolean(historyAllowedRef.current && historyOwnerRef.current && visibleHistoryRefreshTarget &&
    visibleHistoryRefreshTarget.owner === historyOwnerRef.current && visibleHistoryRefreshTarget.profile === activeProfile &&
    visibleHistoryRefreshTarget.server.id === server?.id && JSON.stringify(visibleHistoryRefreshTarget.server) === JSON.stringify(server));
  const catalogCurrent = workspaceCatalog.owner === historyOwner;
  const canRefreshKnownHistory = Boolean(historyAllowed && historyOwner && catalogCurrent && workspaceCatalog.phase === "ready" && knownWorkspacePaths.length > 0);
  const catalogUnavailable = workspaceCatalog.phase === "error"
    ? t("home.refresh_all_unavailable", { p0: workspaceCatalog.error ?? t("host_details.unknown") })
    : catalogCurrent && workspaceCatalog.phase === "ready" && knownWorkspacePaths.length === 0
      ? t("home.refresh_all_unavailable", { p0: t("host_details.no_known_workspaces") })
      : !catalogCurrent || workspaceCatalog.phase === "loading"
        ? t("home.refresh_all_waiting")
        : null;

  return (
    <View testID="host-details-route" style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={() => backOrReplace(router, profileHomeHref(activeProfile?.id))} style={styles.headerButton}>
          <ChevronLeft size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("host_details.title")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("host_details.refresh_status")} disabled={refreshing} onPress={() => void refresh()} style={styles.headerButton}>
          {refreshing ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={18} color={colors.textMuted} />}
        </Pressable>
      </View>
      {!server ? (
        <EmptyState icon={<Server size={44} color={colors.textDim} />} title={t("host_details.missing_title")} body={t("host_details.missing_body")} />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
          <View style={styles.hero}>
            <View style={styles.heroIcon}>{server.transport === "ssh" ? <Server size={24} color={colors.text} /> : <Laptop size={24} color={colors.text} />}</View>
            <View style={styles.heroCopy}>
              <View style={styles.titleRow}><Text style={styles.title}>{server.label}</Text><StatusDot status={connectionStatus} /></View>
              <Text style={styles.subtitle}>{server.transport === "ssh" ? t("host_details.ssh_app_server") : t("host_details.local_app_server")}</Text>
            </View>
          </View>
          <Text style={styles.section}>{t("host_details.connection")}</Text>
          <View style={styles.card}>
            <Detail label={t("host_details.status")} value={connectionLabel} />
            {statusCurrent && status?.latencyMs !== undefined ? <Detail label={t("host_details.latency")} value={`${status.latencyMs} ms`} /> : null}
            {status?.checkedAt ? <Detail label={t("host_details.checked_at")} value={new Date(status.checkedAt).toLocaleString(locale, { hour12: false })} /> : null}
            <Detail label={t("host_details.type")} value={server.transport === "ssh" ? t("settings.transport_ssh") : t("settings.transport_local")} />
            <Detail label={t("host_details.runtime")} value={server.runtime ?? "kcoder"} />
            {server.host ? <Detail label={t("host_details.address")} value={`${server.user ? `${server.user}@` : ""}${server.host}:${server.port ?? 22}`} /> : null}
          </View>
          {statusError ? <Text accessibilityRole="alert" selectable style={styles.statusError}>{statusError}</Text> : null}
          <Text style={styles.section}>{t("task.workspace")}</Text>
          <View style={styles.card}>
            <Detail icon={<Folder size={16} color={colors.textDim} />} label={t("host_details.default_directory")} value={server.workspacePath || t("host_details.default_directory_unset")} />
            <Detail icon={<SquareTerminal size={16} color={colors.textDim} />} label={t("host_details.launch_command")} value={server.command || "kcoder app-server"} last />
          </View>
          <Pressable
            testID="host-refresh-known-history"
            accessibilityRole="button"
            accessibilityLabel={t("home.refresh_all_known_history_scope", { p0: server.label })}
            disabled={!canRefreshKnownHistory}
            accessibilityState={{ disabled: !canRefreshKnownHistory }}
            onPress={() => {
              if (!canRefreshKnownHistory || !activeProfile || !historyOwner || !historyAllowedRef.current || historyOwnerRef.current !== historyOwner) return;
              setHistoryRefreshTarget({ kind: "known-workspaces", profile: activeProfile, server, workspaces: [...knownWorkspacePaths], owner: historyOwner });
            }}
            style={[styles.secondary, !canRefreshKnownHistory && styles.disabled]}
          >
            <RefreshCw size={17} color={canRefreshKnownHistory ? colors.textMuted : colors.textDim} />
            <Text style={styles.secondaryText}>{t("home.refresh_all_known_history", { p0: knownWorkspacePaths.length })}</Text>
          </Pressable>
          {catalogUnavailable ? <Text testID="host-refresh-known-history-state" accessibilityRole={workspaceCatalog.phase === "error" ? "alert" : undefined} style={styles.note}>{catalogUnavailable}</Text> : null}
          <Text style={styles.section}>{t("host_details.capabilities")}</Text>
          <View style={styles.capabilityGrid}>
            {/* Agent has no negotiated flag; other cards use the target's latest status handshake. */}
            <Capability testID="host-capability-agent" icon={<Bot size={18} color={colors.textMuted} />} label={t("task.agent")} />
            <Capability testID="host-capability-terminal" icon={<SquareTerminal size={18} color={colors.blue} />} label={t("task.terminal")} enabled={capabilities?.terminalSessions} />
            <Capability testID="host-capability-browser" icon={<Globe2 size={18} color={colors.blue} />} label={t("task.browser")} enabled={capabilities?.browserSessions} />
            <Capability testID="host-capability-files" icon={<FileText size={18} color={colors.textMuted} />} label={t("task.file")} enabled={capabilities?.workspaceFiles} />
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
      {visibleHistoryRefreshTarget ? <HistoryRefreshModal
        target={visibleHistoryRefreshTarget}
        isTargetCurrent={historyTargetCurrent}
        onClose={() => setHistoryRefreshTarget((current) => current === visibleHistoryRefreshTarget ? null : current)}
        onReady={() => { if (historyTargetCurrent()) void refresh(); }}
      /> : null}
    </View>
  );
}

function Detail({ icon, label, value, last = false }: { icon?: React.ReactNode; label: string; value: string; last?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.detail, !last && styles.divider]}>{icon}<Text style={styles.detailLabel}>{label}</Text><Text selectable numberOfLines={2} style={styles.detailValue}>{value}</Text></View>;
}

function Capability({ icon, label, enabled, testID }: { icon: React.ReactNode; label: string; enabled?: boolean; testID: string }) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  return <View testID={testID} style={styles.capability}>{icon}<Text style={styles.capabilityLabel}>{label}</Text><Text testID={`${testID}-status`} style={[styles.capabilityStatus, enabled === true ? styles.capabilityOn : styles.capabilityOff]}>{enabled === true ? t("host_details.available") : enabled === false ? t("host_details.unavailable") : t("host_details.unknown")}</Text></View>;
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
  capabilityGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, capability: { width: "48%", minHeight: 70, padding: spacing.md, gap: 5, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface }, capabilityLabel: { color: colors.text, fontSize: 12, fontWeight: "600" }, capabilityStatus: { fontSize: 9, fontWeight: "700" }, capabilityOn: { color: colors.green }, capabilityOff: { color: colors.textDim },
  primary: { minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.accent },
  primaryText: { color: colors.accentText, fontSize: 14, fontWeight: "700" },
  secondary: { minHeight: 48, flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg },
  disabled: { opacity: 0.45 },
  secondaryText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  note: { color: colors.textDim, fontSize: 11, lineHeight: 17, textAlign: "center", padding: spacing.md },
});
