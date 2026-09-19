import { useMemo } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Bot, ChevronLeft, FileText, Folder, Globe2, History, Laptop, RefreshCw, Server, SquareTerminal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, StatusDot } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";

export default function HostDetailsRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { activeProfile, runtime, refresh } = useApp();
  const server = runtime.servers.find((item) => item.id === serverId);
  const status = useMemo(() => runtime.statuses.find((item) => item.id === serverId), [runtime.statuses, serverId]);

  return (
    <View testID="host-details-route" style={[styles.root, { paddingTop: insets.top }]}> 
      <View style={styles.header}><Pressable accessibilityLabel="返回" onPress={() => backOrReplace(router, profileHomeHref(activeProfile?.id))} style={styles.headerButton}><ChevronLeft size={22} color={colors.textMuted} /></Pressable><Text style={styles.headerTitle}>Host 详情</Text><Pressable accessibilityLabel="刷新 Host 状态" disabled={runtime.loading} onPress={() => void refresh()} style={styles.headerButton}>{runtime.loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={18} color={colors.textMuted} />}</Pressable></View>
      {!server ? <EmptyState icon={<Server size={44} color={colors.textDim} />} title="Host 已不存在" body="Gateway 返回的服务器列表中找不到这个 Host。" /> : <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
        <View style={styles.hero}><View style={styles.heroIcon}>{server.transport === "ssh" ? <Server size={24} color={colors.text} /> : <Laptop size={24} color={colors.text} />}</View><View style={styles.heroCopy}><View style={styles.titleRow}><Text style={styles.title}>{server.label}</Text><StatusDot status={status?.status ?? "checking"} /></View><Text style={styles.subtitle}>{server.transport === "ssh" ? "SSH KCoder app-server" : "本机 KCoder app-server"}</Text></View></View>
        <Text style={styles.section}>连接</Text>
        <View style={styles.card}>
          <Detail label="状态" value={status?.status === "online" ? "已连接" : status?.status === "offline" ? "不可用" : "检查中"} />
          {status?.latencyMs !== undefined ? <Detail label="延迟" value={`${status.latencyMs} ms`} /> : null}
          {status?.checkedAt ? <Detail label="检查时间" value={new Date(status.checkedAt).toLocaleString("zh-CN", { hour12: false })} /> : null}
          <Detail label="类型" value={server.transport === "ssh" ? "SSH" : "Local"} />
          <Detail label="Runtime" value={server.runtime ?? "kcoder"} />
          {server.host ? <Detail label="地址" value={`${server.user ? `${server.user}@` : ""}${server.host}:${server.port ?? 22}`} /> : null}
        </View>
        {status?.error ? <Text accessibilityRole="alert" selectable style={styles.statusError}>{status.error}</Text> : null}
        <Text style={styles.section}>工作区</Text>
        <View style={styles.card}><Detail icon={<Folder size={16} color={colors.textDim} />} label="默认目录" value={server.workspacePath || "/"} /><Detail icon={<SquareTerminal size={16} color={colors.textDim} />} label="启动命令" value={server.command || "kcoder app-server"} last /></View>
        <Text style={styles.section}>能力</Text>
        <View style={styles.capabilityGrid}>
          <Capability icon={<Bot size={18} color={colors.accentBright} />} label="智能体" enabled />
          <Capability icon={<SquareTerminal size={18} color={colors.blue} />} label="终端" enabled={server.capabilities?.terminalSessions !== false} />
          <Capability icon={<Globe2 size={18} color={colors.blue} />} label="浏览器" enabled={server.capabilities?.browserSessions !== false} />
          <Capability icon={<FileText size={18} color={colors.textMuted} />} label="文件" enabled={server.capabilities?.workspaceFiles !== false} />
        </View>
        {server.description ? <Text style={styles.description}>{server.description}</Text> : null}
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile?.id, serverId: server.id } })} style={styles.primary}><Text style={styles.primaryText}>在此 Host 新建会话</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile?.id, serverId: server.id } } as never)} style={styles.secondary}><History size={17} color={colors.textMuted} /><Text style={styles.secondaryText}>查看此 Host 的任务历史</Text></Pressable>
        {server.transport === "ssh" ? <Pressable accessibilityRole="button" onPress={() => router.replace({ pathname: "/server-editor", params: { serverId: server.id } } as never)} style={styles.secondary}><Text style={styles.secondaryText}>编辑 SSH 配置</Text></Pressable> : <Text style={styles.note}>Local Host 随 Gateway 进程启动，由 Gateway 启动参数管理；手机端只显示状态，不会打开空白 SSH 表单。</Text>}
      </ScrollView>}
    </View>
  );
}

function Detail({ icon, label, value, last = false }: { icon?: React.ReactNode; label: string; value: string; last?: boolean }) {
  return <View style={[styles.detail, !last && styles.divider]}>{icon}<Text style={styles.detailLabel}>{label}</Text><Text selectable numberOfLines={2} style={styles.detailValue}>{value}</Text></View>;
}

function Capability({ icon, label, enabled }: { icon: React.ReactNode; label: string; enabled: boolean }) {
  return <View style={[styles.capability, !enabled && styles.capabilityDisabled]}>{icon}<Text style={styles.capabilityLabel}>{label}</Text><Text style={[styles.capabilityStatus, enabled ? styles.capabilityOn : styles.capabilityOff]}>{enabled ? "可用" : "未提供"}</Text></View>;
}

const styles = StyleSheet.create({
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
  statusError: { color: colors.red, fontSize: 11, lineHeight: 17, padding: spacing.md, borderRadius: radius.lg, backgroundColor: "rgba(198,79,67,0.12)" },
  capabilityGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, capability: { width: "48%", minHeight: 70, padding: spacing.md, gap: 5, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface }, capabilityDisabled: { opacity: 0.5 }, capabilityLabel: { color: colors.text, fontSize: 12, fontWeight: "600" }, capabilityStatus: { fontSize: 9, fontWeight: "700" }, capabilityOn: { color: colors.green }, capabilityOff: { color: colors.textDim },
  primary: { minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.accent },
  primaryText: { color: colors.accentText, fontSize: 14, fontWeight: "700" },
  secondary: { minHeight: 48, flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg },
  secondaryText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  note: { color: colors.textDim, fontSize: 11, lineHeight: 17, textAlign: "center", padding: spacing.md },
});
