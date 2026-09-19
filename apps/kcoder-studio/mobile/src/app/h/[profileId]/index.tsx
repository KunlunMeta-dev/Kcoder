import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronDown, ChevronRight, ChevronUp, GitBranch, History, Laptop, Menu, Plus, Server, Settings, SquareTerminal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, StatusDot } from "@/components/ui";
import type { ThreadSummary } from "@/gateway/types";
import { listThreads, listWorkspaceOptions, type ThreadListPage, type WorkspaceOption } from "@/runtime/task-runtime";
import { ThreadListProjection, threadListScopeKey, threadListNotice } from "@/runtime/thread-list-projection";
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";
import { timestampMs } from "@/protocol/normalizers";
import { MobileDrawer } from "@/components/mobile-drawer";
import { groupThreadsByWorkspace, hiddenThreadCount, projectVisibleThreads } from "@/components/thread-list-presentation";
import { useCollapsedServerSections } from "@/storage/use-collapsed-server-sections";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { HistoryRefreshModal, type HistoryRefreshTarget } from "@/components/history-refresh-modal";

const DEMO_THREADS: Record<string, ThreadSummary[]> = {
  local: [
    { id: "demo-1", status: "idle", title: "设计 React Native 客户端", cwd: "/data/projects/kcoder", model: "MiniMax-M3", createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 58_000).toISOString() },
    { id: "demo-2", status: "waiting_for_approval", title: "修复移动端登录", cwd: "/data/projects/kcoder", model: "MiniMax-M3", createdAt: new Date(Date.now() - 86_400_000).toISOString(), updatedAt: new Date(Date.now() - 7_200_000).toISOString() },
  ],
};

function relativeTime(value: string | number): string {
  const timestamp = timestampMs(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知时间";
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86_400)} 天`;
}

export default function HostHomeRoute() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, activeProfile, profiles, runtime, demo, refresh, setActiveProfile } = useApp();
  const invalidProfile = hydrated && !profiles.some((item) => item.id === profileId);
  const [threads, setThreads] = useState<Record<string, ThreadSummary[]>>(demo ? DEMO_THREADS : {});
  const [workspaceOptions, setWorkspaceOptions] = useState<Record<string, WorkspaceOption[]>>({});
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});
  const [workspaceErrors, setWorkspaceErrors] = useState<Record<string, string>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyRefreshTarget, setHistoryRefreshTarget] = useState<HistoryRefreshTarget | null>(null);
  const [threadReloadRevision, setThreadReloadRevision] = useState(0);
  const threadLoadGeneration = useRef(0);
  const threadProjection = useRef(new ThreadListProjection());
  const { serverIds: collapsedServerIds, hydrated: collapsedHydrated, toggle: toggleServerCollapsed } = useCollapsedServerSections(profileId);
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(new Set());

  useEffect(() => { setHistoryRefreshTarget(null); }, [activeProfile, profileId, isFocused]);
  useEffect(() => {
    setHistoryRefreshTarget((target) => target && runtime.servers.some((server) => JSON.stringify(server) === JSON.stringify(target.server)) ? target : null);
  }, [runtime.servers]);

  useEffect(() => {
    if (shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) {
      void setActiveProfile(profileId);
    }
  }, [activeProfile?.id, hydrated, isFocused, profileId, profiles, setActiveProfile]);

  const statusById = useMemo(
    () => new Map(runtime.statuses.map((status) => [status.id, status])),
    [runtime.statuses],
  );

  const loadAllThreads = async () => {
    if (demo || !activeProfile || runtime.servers.length === 0) return;
    const generation = ++threadLoadGeneration.current;
    const mutationRevision = threadProjection.current.revision;
    const profile = activeProfile;
    const servers = [...runtime.servers];
    threadProjection.current.retainScopes(servers.map((server) => threadListScopeKey(profile, server, { archived: false })));
    setThreads(Object.fromEntries(servers.map((server) => [server.id, threadProjection.current.get(threadListScopeKey(profile, server, { archived: false }))?.threads ?? []])));
    setLoadingThreads(true);
    const results = await Promise.all(
      servers.map(async (server) => {
        try {
          const [values, workspaceResult] = await Promise.all([
            listThreads(profile, server, 100, { archived: false }),
            listWorkspaceOptions(profile, server).then(
              (options) => ({ options, error: null as string | null }),
              (value) => ({ options: [] as WorkspaceOption[], error: value instanceof Error ? value.message : String(value) }),
            ),
          ]);
          return [server.id, values, workspaceResult.options, null, workspaceResult.error] as const;
        } catch (error) {
          return [
            server.id,
            undefined as ThreadListPage | undefined,
            [] as WorkspaceOption[],
            error instanceof Error ? error.message : String(error),
            null,
          ] as const;
        }
      }),
    );
    if (generation !== threadLoadGeneration.current || mutationRevision !== threadProjection.current.revision) return;
    setThreads(Object.fromEntries(results.map(([id, page]) => {
      const server = servers.find((item) => item.id === id)!;
      const scope = threadListScopeKey(profile, server, { archived: false });
      const projected = page ? threadProjection.current.update(scope, page) : threadProjection.current.get(scope);
      return [id, projected?.threads ?? []];
    })));
    setWorkspaceOptions(Object.fromEntries(results.map(([id, , options]) => [id, options])));
    setThreadErrors(Object.fromEntries(results.flatMap(([id, page, , error]) => {
      const notice = error ?? threadListNotice(page);
      return notice ? [[id, notice]] : [];
    })));
    setWorkspaceErrors(Object.fromEntries(results.flatMap(([id, , , , error]) => (error ? [[id, error]] : []))));
    setLoadingThreads(false);
  };

  useEffect(() => {
    threadLoadGeneration.current += 1;
    setThreads(demo ? DEMO_THREADS : {});
    setWorkspaceOptions({});
    setThreadErrors({});
    setWorkspaceErrors({});
    setLoadingThreads(false);
  }, [activeProfile?.id, activeProfile?.baseUrl, demo]);

  useEffect(() => {
    if (!runtime.loading && runtime.servers.length > 0) void loadAllThreads();
    else if (!runtime.loading) setLoadingThreads(false);
    return () => { threadLoadGeneration.current += 1; };
  }, [activeProfile?.id, activeProfile?.baseUrl, runtime.loading, JSON.stringify(runtime.servers), threadReloadRevision]);

  const reload = async () => {
    await refresh();
    setThreadReloadRevision((value) => value + 1);
  };

  const toggleServerThreadsExpanded = (serverId: string) => {
    setExpandedServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  if (invalidProfile) {
    return <View style={[styles.root, styles.center, { paddingTop: insets.top }]}><EmptyState icon={<Server size={42} color={colors.textDim} />} title="Gateway 已不存在" body="这个主页链接指向已移除的 Gateway，请到设置中选择其他连接。" /><Pressable onPress={() => router.replace("/settings")} style={styles.recoveryButton}><Text style={styles.recoveryButtonText}>打开设置</Text></Pressable></View>;
  }
  if (!hydrated || !activeProfile || activeProfile.id !== profileId) return <View style={[styles.root, styles.center]}><ActivityIndicator color={colors.text} /></View>;
  const scopedThreads = demo ? threads : Object.fromEntries(runtime.servers.map((server) => [server.id, threadProjection.current.get(threadListScopeKey(activeProfile, server, { archived: false }))?.threads ?? []]));

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="打开导航" onPress={() => setDrawerOpen(true)} style={styles.iconButton}><Menu size={20} color={colors.textMuted} /></Pressable>
        <View style={styles.headerTitle}><Text style={styles.title}>会话</Text></View>
        <Pressable testID="sessions" accessibilityLabel="搜索历史会话" onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } })} style={styles.iconButton}><History size={18} color={colors.textMuted} /></Pressable>
      </View>
      <ScrollView
        refreshControl={<RefreshControl refreshing={runtime.loading || loadingThreads} onRefresh={() => void reload()} tintColor={colors.text} />}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 76 }]}
      >
        {runtime.error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{runtime.error}</Text><Pressable testID={runtime.reauthorizationRequired ? "reauthorize-active-profile" : "retry-gateway"} onPress={() => runtime.reauthorizationRequired ? router.push({ pathname: "/welcome", params: { gateway: activeProfile.baseUrl, reauth: activeProfile.id } }) : void refresh()}><Text style={styles.retry}>{runtime.reauthorizationRequired ? "重新授权" : "重试"}</Text></Pressable></View> : null}
        {runtime.loading && runtime.servers.length === 0 ? <ActivityIndicator style={styles.loader} color={colors.text} /> : null}
        {runtime.servers.length === 0 && !runtime.loading ? <EmptyState icon={<Server size={42} color={colors.textDim} />} title="没有可用服务器" body="请检查 Gateway 设置，或在桌面端添加本地/SSH KCoder 服务器。" /> : null}
        {runtime.servers.map((server) => {
          const status = statusById.get(server.id)?.status ?? "checking";
          const serverThreads = scopedThreads[server.id] ?? [];
          const workspaceGroups = groupThreadsByWorkspace(serverThreads, workspaceOptions[server.id] ?? [], server.workspacePath);
          return (
            <View key={server.id} style={styles.serverSection}>
              <View style={styles.serverHeader}>
                <View style={styles.serverIcon}>{server.transport === "ssh" ? <Server size={15} color={colors.text} /> : <Laptop size={15} color={colors.text} />}</View>
                <View style={styles.serverCopy}><View style={styles.serverTitleRow}><Text style={styles.serverTitle}>{server.label}</Text><StatusDot status={status} /></View></View>
                <Pressable testID={`new-workspace-${server.id}`} accessibilityLabel={`在 ${server.label} 新建任务`} onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile.id, serverId: server.id } })} style={styles.sectionAction}><Plus size={17} color={colors.textMuted} /></Pressable>
              </View>
              {threadErrors[server.id] ? <Text accessibilityRole="alert" style={styles.inlineError}>{threadErrors[server.id]}</Text> : null}
              {workspaceErrors[server.id] ? <Text accessibilityRole="alert" style={styles.inlineError}>项目列表加载失败，当前按任务目录显示：{workspaceErrors[server.id]}</Text> : null}
              {workspaceGroups.map((group, groupIndex) => {
                const sectionKey = `${server.id}\0${group.path}`;
                const collapsed = collapsedServerIds.has(sectionKey);
                const threadsExpanded = expandedServerIds.has(sectionKey);
                const hiddenThreads = hiddenThreadCount(group.threads, threadsExpanded);
                return <View key={sectionKey}>
                  <Pressable
                    testID={groupIndex === 0 ? `toggle-server-${server.id}` : `toggle-workspace-${server.id}-${groupIndex}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${collapsed ? "展开" : "折叠"} ${group.label} 的会话`}
                    aria-expanded={!collapsed}
                    accessibilityState={{ expanded: !collapsed, disabled: !collapsedHydrated }}
                    disabled={!collapsedHydrated}
                    onPress={() => toggleServerCollapsed(sectionKey)}
                    style={({ pressed }) => [styles.workspaceRow, pressed && styles.workspaceRowPressed]}
                  >
                    <SquareTerminal size={14} color={colors.textDim} />
                    <View style={styles.workspaceCopy}><Text style={styles.workspaceName}>{group.label}</Text><Text style={styles.serverDescription} numberOfLines={1}>{group.path}</Text></View>
                    <Text style={styles.transport}>{group.kind === "worktree" ? "WORKTREE" : server.transport === "ssh" ? "SSH" : "LOCAL"}</Text>
                    {collapsed ? <ChevronRight size={15} color={colors.textDim} /> : <ChevronDown size={15} color={colors.textDim} />}
                  </Pressable>
                  {!demo ? <Pressable testID={`refresh-history-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={`刷新 ${server.label} ${group.path} 的历史索引`} onPress={() => setHistoryRefreshTarget({ profile: activeProfile, server, workspace: group.path })} style={styles.historyRefreshAction}><Text style={styles.retry}>刷新历史索引</Text></Pressable> : null}
                  {!collapsed && group.threads.length === 0 && !loadingThreads ? <Pressable onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile.id, serverId: server.id, cwd: group.path } })} style={styles.emptyThread}><Plus size={14} color={colors.textMuted} /><Text style={styles.emptyThreadText}>在此项目新建任务</Text></Pressable> : null}
                  {!collapsed && projectVisibleThreads(group.threads, threadsExpanded).map((thread) => (
                    <Pressable testID={`thread-${thread.id}`} key={thread.id} onPress={() => router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id, threadId: thread.id, cwd: thread.cwd?.trim() || group.path, title: thread.title || "未命名任务" } })} style={({ pressed }) => [styles.thread, pressed && styles.threadPressed]}>
                      <GitBranch size={14} color={colors.textDim} />
                      <View style={styles.threadCopy}><Text style={styles.threadTitle} numberOfLines={1}>{thread.title || "未命名任务"}</Text><View style={styles.threadMetaRow}><Text style={styles.threadMeta}>{relativeTime(thread.updatedAt)}</Text>{thread.status !== "idle" ? <Text style={[styles.state, thread.status === "failed" && styles.failed]}>{thread.status === "running" ? "运行中" : thread.status === "waiting_for_approval" ? "待批准" : thread.status === "waiting_for_answer" ? "待回答" : "失败"}</Text> : null}</View></View>
                      <ChevronRight size={16} color={colors.textDim} />
                    </Pressable>
                  ))}
                  {!collapsed && group.threads.length > 8 ? <Pressable testID={`toggle-more-threads-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={threadsExpanded ? "收起会话" : `显示其余 ${hiddenThreads} 条会话`} aria-expanded={threadsExpanded} accessibilityState={{ expanded: threadsExpanded }} onPress={() => toggleServerThreadsExpanded(sectionKey)} style={({ pressed }) => [styles.moreThreads, pressed && styles.threadPressed]}>{threadsExpanded ? <ChevronUp size={14} color={colors.textDim} /> : <ChevronDown size={14} color={colors.textDim} />}<Text style={styles.moreThreadsText}>{threadsExpanded ? "收起" : `显示其余 ${hiddenThreads} 条`}</Text></Pressable> : null}
                </View>;
              })}
            </View>
          );
        })}
      </ScrollView>
      <View style={[styles.hostDock, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <View style={styles.hostDockCopy}><StatusDot status={runtime.error ? "offline" : runtime.loading ? "checking" : "online"} /><View><Text style={styles.hostDockTitle}>{activeProfile.label}</Text><Text style={styles.hostDockMeta}>{activeProfile.baseUrl.replace(/^https?:\/\//, "")}</Text></View></View>
        <Pressable testID="new-workspace" accessibilityLabel="新建任务" onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile.id } })} style={styles.iconButton}><Plus size={21} color={colors.textMuted} /></Pressable>
        <Pressable accessibilityLabel="设置" onPress={() => router.push("/settings")} style={styles.iconButton}><Settings size={20} color={colors.textMuted} /></Pressable>
      </View>
      <MobileDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profileId={activeProfile.id}
        profile={activeProfile}
        servers={runtime.servers}
        threads={scopedThreads}
        workspaceOptions={workspaceOptions}
        workspaceErrors={workspaceErrors}
        threadErrors={threadErrors}
        demo={demo}
        onThreadRenamed={(serverId, thread) => {
          const server = runtime.servers.find((item) => item.id === serverId);
          if (server) threadProjection.current.changeThread(threadListScopeKey(activeProfile, server, { archived: false }), thread);
          setThreads((current) => ({ ...current, [serverId]: (current[serverId] ?? []).map((candidate) => candidate.id === thread.id ? thread : candidate) }));
          setThreadReloadRevision((value) => value + 1);
        }}
        onThreadRemoved={(serverId, threadId) => {
          const server = runtime.servers.find((item) => item.id === serverId);
          if (server) threadProjection.current.removeThread(threadListScopeKey(activeProfile, server, { archived: false }), threadId);
          setThreads((current) => ({ ...current, [serverId]: (current[serverId] ?? []).filter((thread) => thread.id !== threadId) }));
          setThreadReloadRevision((value) => value + 1);
        }}
      />
      {historyRefreshTarget && isFocused && historyRefreshTarget.profile === activeProfile && profileId === activeProfile.id ? <HistoryRefreshModal target={historyRefreshTarget} onClose={() => setHistoryRefreshTarget(null)} onReady={() => { void reload(); }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  header: { height: 56, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  headerTitle: { flex: 1, paddingLeft: spacing.sm },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  content: { paddingHorizontal: spacing.md, paddingVertical: spacing.lg, gap: spacing.xl },
  errorBanner: { flexDirection: "row", justifyContent: "space-between", padding: spacing.md, backgroundColor: "rgba(251,113,133,0.12)", borderRadius: radius.md },
  errorText: { color: colors.red, fontSize: 13, flex: 1 },
  retry: { color: colors.text, fontSize: 13, fontWeight: "700", marginLeft: spacing.sm },
  loader: { paddingVertical: spacing.xxl },
  serverSection: { overflow: "hidden" },
  serverHeader: { height: 40, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.xs, gap: spacing.sm },
  serverIcon: { width: 20, height: 20, borderRadius: radius.sm, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" },
  serverCopy: { flex: 1 },
  serverTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  serverTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  serverDescription: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  transport: { color: colors.textDim, fontSize: 10, fontWeight: "700" },
  threadErrorIndicator: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  sectionAction: { width: 44, height: 40, alignItems: "center", justifyContent: "center", marginRight: -spacing.sm },
  historyRefreshAction: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center", paddingHorizontal: spacing.md },
  workspaceRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  workspaceRowPressed: { backgroundColor: colors.surfaceHover },
  workspaceCopy: { flex: 1 },
  workspaceName: { color: colors.textMuted, fontSize: 13, fontWeight: "500" },
  thread: { minHeight: 48, paddingLeft: spacing.xl + spacing.sm, paddingRight: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  threadPressed: { backgroundColor: colors.surfaceHover },
  threadCopy: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  threadTitle: { flex: 1, color: colors.textMuted, fontSize: 13, fontWeight: "500" },
  threadMetaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  threadMeta: { color: colors.textDim, fontSize: 11 },
  state: { color: colors.yellow, fontSize: 10, fontWeight: "700", marginLeft: 4 },
  failed: { color: colors.red },
  emptyThread: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.xl + spacing.sm },
  emptyThreadText: { color: colors.textMuted, fontSize: 13 },
  moreThreads: { minHeight: 40, marginLeft: spacing.xl, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  moreThreadsText: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
  inlineError: { color: colors.red, fontSize: 12, padding: spacing.md },
  recoveryButton: { minHeight: 44, minWidth: 120, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  recoveryButtonText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  hostDock: { minHeight: 58, flexDirection: "row", alignItems: "center", paddingTop: spacing.sm, paddingHorizontal: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceSidebar },
  hostDockCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  hostDockTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  hostDockMeta: { color: colors.textDim, fontSize: 10, marginTop: 2 },
});
