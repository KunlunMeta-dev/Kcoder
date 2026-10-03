import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Archive, ChevronLeft, ChevronRight, Clock3, MoreHorizontal, Search } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/ui";
import type { ThreadSummary } from "@/gateway/types";
import { ThreadListPager } from "@/runtime/task-runtime";
import { ThreadListProjection, threadListScopeKey, threadListNotice } from "@/runtime/thread-list-projection";
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";
import { timestampMs } from "@/protocol/normalizers";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { ThreadActionsSheet, type ThreadActionTarget } from "@/components/thread-actions-sheet";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";

interface SessionRow { serverId: string; serverLabel: string; workspacePath?: string; scope?: string; thread: ThreadSummary }
interface ServerPagerState { pager: ThreadListPager; scope: string; nextCursor?: string }

function relativeTime(value: string | number): string {
  const timestamp = timestampMs(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知时间";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1_440)} 天前`;
}

function sessionStatus(status: ThreadSummary["status"]): string | null {
  if (status === "running") return "运行中";
  if (status === "waiting_for_approval") return "待批准";
  if (status === "waiting_for_answer") return "待回答";
  if (status === "failed") return "失败";
  return null;
}

export default function SessionsRoute() {
  const { profileId, serverId: initialServerId } = useLocalSearchParams<{ profileId?: string; serverId?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, demo } = useApp();
  const goBack = () => backOrReplace(router, profileHomeHref(profileId ?? activeProfile?.id));
  const profileReady = hydrated && (!profileId || activeProfile?.id === profileId);
  const invalidProfile = hydrated && Boolean(profileId) && !profiles.some((profile) => profile.id === profileId);
  const serverSignature = JSON.stringify(runtime.servers);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [serverFilter, setServerFilter] = useState<string>(initialServerId || "all");
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRow, setSelectedRow] = useState<SessionRow | null>(null);
  const pagersRef = useRef(new Map<string, ServerPagerState>());
  const threadProjection = useRef(new ThreadListProjection());
  const [listNotices, setListNotices] = useState<Record<string, string>>({});
  const refreshingRef = useRef(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    if (shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) {
      void setActiveProfile(profileId!);
    }
  }, [activeProfile?.id, hydrated, isFocused, profileId, profiles, setActiveProfile]);

  useEffect(() => {
    setRows([]);
    setLoadErrors([]);
    setLoading(true);
    setRefreshing(false);
    refreshingRef.current = false;
    setServerFilter(initialServerId || "all");
  }, [initialServerId, profileId]);

  useEffect(() => {
    if (serverFilter !== "all" && !runtime.servers.some((server) => server.id === serverFilter)) setServerFilter("all");
  }, [runtime.servers, serverFilter]);

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!profileReady || runtime.loading || !activeProfile) {
      setRefreshing(false);
      refreshingRef.current = false;
      return;
    }
    const preserveRows = refreshingRef.current;
    setLoadErrors([]);
    setListNotices({});
    if (!preserveRows) setLoading(true);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    for (const state of pagersRef.current.values()) state.pager.close();
    pagersRef.current = new Map();
    if (demo) {
      const server = runtime.servers[0];
      setRows(server ? [
        { serverId: server.id, serverLabel: server.label, workspacePath: server.workspacePath, thread: { id: "demo-1", status: "idle", title: "设计 React Native 客户端", cwd: server.workspacePath, model: "MiniMax-M3", createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 60_000 } },
        { serverId: server.id, serverLabel: server.label, workspacePath: server.workspacePath, thread: { id: "demo-2", status: "idle", title: "修复移动端登录", cwd: server.workspacePath, model: "MiniMax-M3", createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 7_200_000 } },
      ] : []);
      setLoading(false);
      setRefreshing(false);
      refreshingRef.current = false;
      return;
    }
    let cancelled = false;
    const targetServers = serverFilter === "all"
      ? runtime.servers
      : runtime.servers.filter((server) => server.id === serverFilter);
    const pagers = new Map<string, ServerPagerState>();
    const filter = { archived: showArchived, query: searchQuery || undefined };
    threadProjection.current.retainScopes(targetServers.map((server) => threadListScopeKey(activeProfile, server, filter)));
    setRows(targetServers.flatMap((server) => {
      const scope = threadListScopeKey(activeProfile, server, filter);
      return (threadProjection.current.get(scope)?.threads ?? []).map((thread) => ({ serverId: server.id, serverLabel: server.label, workspacePath: server.workspacePath, scope, thread }));
    }));
    for (const server of targetServers) pagers.set(server.id, { pager: new ThreadListPager(activeProfile, server, filter), scope: threadListScopeKey(activeProfile, server, filter) });
    pagersRef.current = pagers;
    const mutationRevision = threadProjection.current.revision;
    const current = () => !cancelled && pagersRef.current === pagers && mutationRevision === threadProjection.current.revision;
    void Promise.all(targetServers.map(async (server) => {
      const state = pagers.get(server.id)!;
      try {
        const page = await state.pager.page(undefined, 50);
        state.nextCursor = page.nextCursor;
        if (!state.nextCursor) {
          state.pager.close();
          pagers.delete(server.id);
        }
        return { server, scope: state.scope, page, error: null };
      } catch (value) {
        state.pager.close();
        pagers.delete(server.id);
        return { server, scope: state.scope, page: undefined, error: `${server.label}：${value instanceof Error ? value.message : String(value)}` };
      }
    })).then((groups) => {
      if (!current()) return;
      setRows(groups.flatMap(({ server, scope, page }) => {
        const projected = page ? threadProjection.current.update(scope, page) : threadProjection.current.get(scope);
        return (projected?.threads ?? []).map((thread) => ({ serverId: server.id, serverLabel: server.label, workspacePath: server.workspacePath, scope, thread }));
      }).sort((a, b) => timestampMs(b.thread.updatedAt) - timestampMs(a.thread.updatedAt)));
      setListNotices(Object.fromEntries(groups.flatMap(({ server, page }) => {
        const notice = threadListNotice(page);
        return notice ? [[server.id, `${server.label}：${notice}`]] : [];
      })));
      setLoadErrors(groups.flatMap((group) => group.error ? [group.error] : []));
    }).finally(() => { if (current()) { setLoading(false); setRefreshing(false); refreshingRef.current = false; } });
    return () => {
      cancelled = true;
      for (const state of pagers.values()) state.pager.close();
      if (pagersRef.current === pagers) pagersRef.current = new Map();
    };
  }, [activeProfile?.id, activeProfile?.baseUrl, demo, profileReady, reloadRevision, runtime.loading, searchQuery, serverFilter, serverSignature, showArchived]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || loading || refreshing) return;
    const generationPagers = pagersRef.current;
    const mutationRevision = threadProjection.current.revision;
    const current = () => pagersRef.current === generationPagers && mutationRevision === threadProjection.current.revision;
    const targets = [...generationPagers.entries()].filter(([id, state]) => (
      Boolean(state.nextCursor) && (serverFilter === "all" || id === serverFilter)
    ));
    if (targets.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const serverById = new Map(runtime.servers.map((server) => [server.id, server]));
    try {
      const groups = await Promise.all(targets.map(async ([serverId, state]) => {
        const server = serverById.get(serverId);
        if (!server || !state.nextCursor) return { serverId, page: undefined, error: null };
        try {
          const page = await state.pager.page(state.nextCursor, 50);
          if (!current()) return { serverId, page: undefined, error: null };
          state.nextCursor = page.nextCursor;
          if (!state.nextCursor) {
            state.pager.close();
            generationPagers.delete(serverId);
          }
          return { serverId, page, error: null };
        } catch (value) {
          if (!current()) return { serverId, page: undefined, error: null };
          state.nextCursor = undefined;
          state.pager.close();
          generationPagers.delete(serverId);
          return { serverId, page: undefined, error: `${server.label}：${value instanceof Error ? value.message : String(value)}` };
        }
      }));
      if (!current()) return;
      const replacements = new Map<string, SessionRow[]>();
      for (const { serverId, page } of groups) {
        const server = serverById.get(serverId);
        const state = targets.find(([id]) => id === serverId)?.[1];
        if (!page || !server || !state) continue;
        const projected = threadProjection.current.update(state.scope, page);
        replacements.set(serverId, projected.threads.map((thread) => ({ serverId, serverLabel: server.label, workspacePath: server.workspacePath, scope: state.scope, thread })));
      }
      setRows((current) => {
        return [...current.filter((row) => !replacements.has(row.serverId)), ...[...replacements.values()].flat()].sort((a, b) => timestampMs(b.thread.updatedAt) - timestampMs(a.thread.updatedAt));
      });
      setListNotices((current) => {
        const next = { ...current };
        for (const { serverId, page } of groups) {
          if (!page) continue;
          const notice = threadListNotice(page);
          if (notice) next[serverId] = `${serverById.get(serverId)?.label ?? serverId}：${notice}`;
          else delete next[serverId];
        }
        return next;
      });
      const errors = groups.flatMap((group) => group.error ? [group.error] : []);
      if (errors.length > 0) setLoadErrors((current) => [...new Set([...current, ...errors])]);
    } finally {
      if (current()) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [loading, refreshing, runtime.servers, serverFilter]);

  const filtered = useMemo(() => {
    const needle = searchQuery.toLocaleLowerCase();
    return rows.filter((row) => (
      (demo || Boolean(activeProfile && runtime.servers.some((server) => server.id === row.serverId && row.scope === threadListScopeKey(activeProfile, server, { archived: showArchived, query: searchQuery || undefined })))) &&
      (showArchived ? Boolean(row.thread.archivedAt) : !row.thread.archivedAt) &&
      (serverFilter === "all" || row.serverId === serverFilter) &&
      (!needle || [row.thread.title, row.thread.cwd, row.thread.model, row.serverLabel]
        .some((value) => value?.toLocaleLowerCase().includes(needle)))
    ));
  }, [rows, searchQuery, serverFilter, showArchived, demo, activeProfile, runtime.servers]);
  const hasMoreForSelection = [...pagersRef.current.entries()].some(([id, state]) => (
    Boolean(state.nextCursor) && (serverFilter === "all" || id === serverFilter)
  ));
  const selectedTarget: ThreadActionTarget | null = selectedRow ? (() => {
    const server = runtime.servers.find((candidate) => candidate.id === selectedRow.serverId);
    return server ? { server, thread: selectedRow.thread } : null;
  })() : null;
  const changeSelectedThread = (thread: ThreadSummary, removed = false) => {
    if (!selectedRow || !activeProfile || !selectedTarget) return;
    const scope = threadListScopeKey(activeProfile, selectedTarget.server, { archived: showArchived, query: searchQuery || undefined });
    if (removed) threadProjection.current.removeThread(scope, thread.id);
    else threadProjection.current.changeThread(scope, thread);
    setRows((current) => removed
      ? current.filter((candidate) => candidate.serverId !== selectedRow.serverId || candidate.thread.id !== thread.id)
      : current.map((candidate) => candidate.serverId === selectedRow.serverId && candidate.thread.id === thread.id ? { ...candidate, thread } : candidate));
    setSelectedRow(removed ? null : { ...selectedRow, thread });
    // Discard the pre-mutation cursor snapshot before accepting more pages.
    for (const state of pagersRef.current.values()) state.pager.close();
    pagersRef.current = new Map();
    setReloadRevision((value) => value + 1);
  };
  if (invalidProfile) {
    return <View style={[styles.root, { paddingTop: insets.top }]}><View style={styles.header}><Pressable accessibilityLabel="返回" onPress={goBack} style={styles.headerButton}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>历史</Text><View style={styles.headerButton} /></View><EmptyState icon={<Archive size={40} color={colors.textDim} />} title="Gateway 已不存在" body="这个历史链接指向已移除的 Gateway，请返回并选择其他连接。" /></View>;
  }
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}><Pressable accessibilityLabel="返回" onPress={goBack} style={styles.headerButton}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>历史</Text><View style={styles.headerButton} /></View>
      <View style={styles.search}><Search size={18} color={colors.textDim} /><TextInput testID="session-search" value={query} onChangeText={setQuery} placeholder="搜索会话" placeholderTextColor={colors.textDim} style={styles.searchInput} />{query ? <Pressable accessibilityLabel="清除搜索" onPress={() => setQuery("")} style={styles.searchActionButton}><Text style={styles.searchAction}>清除</Text></Pressable> : null}</View>
      {runtime.servers.length > 1 ? <ScrollView horizontal style={styles.hostFilterScroller} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hostFilters}><Pressable testID="sessions-host-all" accessibilityState={{ selected: serverFilter === "all" }} onPress={() => setServerFilter("all")} style={[styles.hostFilter, serverFilter === "all" && styles.filterSelected]}><Text style={[styles.filterText, serverFilter === "all" && styles.filterSelectedText]}>全部服务器</Text></Pressable>{runtime.servers.map((server) => <Pressable key={server.id} testID={`sessions-host-${server.id}`} accessibilityState={{ selected: serverFilter === server.id }} onPress={() => setServerFilter(server.id)} style={[styles.hostFilter, serverFilter === server.id && styles.filterSelected]}><Text numberOfLines={1} style={[styles.filterText, serverFilter === server.id && styles.filterSelectedText]}>{server.label}</Text></Pressable>)}</ScrollView> : null}
      <View style={styles.filters}><Pressable testID="sessions-active" accessibilityState={{ selected: !showArchived }} onPress={() => setShowArchived(false)} style={[styles.filter, !showArchived && styles.filterSelected]}><Text style={[styles.filterText, !showArchived && styles.filterSelectedText]}>最近任务</Text></Pressable><Pressable testID="sessions-archived" accessibilityState={{ selected: showArchived }} onPress={() => setShowArchived(true)} style={[styles.filter, showArchived && styles.filterSelected]}><Text style={[styles.filterText, showArchived && styles.filterSelectedText]}>已归档</Text></Pressable></View>
      {loadErrors.length > 0 ? <Text style={styles.loadError}>{loadErrors.join("\n")}</Text> : null}
      {Object.keys(listNotices).length > 0 ? <Text accessibilityRole="alert" style={styles.loadError}>{Object.values(listNotices).join("\n")}</Text> : null}
      {!profileReady || runtime.loading || query.trim() !== searchQuery || (loading && !refreshing) ? <ActivityIndicator style={styles.loader} color={colors.textMuted} /> : <FlatList
        testID="sessions-list"
        data={filtered}
        keyExtractor={(row) => `${row.serverId}:${row.thread.id}`}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { refreshingRef.current = true; setRefreshing(true); setReloadRevision((value) => value + 1); }} tintColor={colors.textMuted} />}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.35}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={9}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.moreLoader} color={colors.textMuted} /> : null}
        ListEmptyComponent={<View style={styles.emptyWrap}><EmptyState icon={showArchived ? <Archive size={40} color={colors.textDim} /> : <Clock3 size={40} color={colors.textDim} />} title={hasMoreForSelection ? "已加载范围内没有匹配" : query ? "没有匹配的任务" : showArchived ? "没有已归档任务" : "暂无任务"} body={hasMoreForSelection ? "更早的任务尚未加载，可继续查找。" : query ? "可按标题、目录、服务器或模型搜索。" : showArchived ? "归档后的任务会显示在这里。" : "选择项目并发送第一条消息后，任务会显示在这里。"} />{hasMoreForSelection ? <Pressable testID="sessions-load-more-empty" disabled={loadingMore} onPress={() => void loadMore()} style={styles.loadMoreButton}>{loadingMore ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.loadMoreText}>继续查找更早任务</Text>}</Pressable> : null}</View>}
        renderItem={({ item: row }) => { const status = sessionStatus(row.thread.status); return <Pressable testID={`session-${row.thread.id}`} onPress={() => { if (!profileReady || runtime.loading || !activeProfile) return; router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: row.serverId, threadId: row.thread.id, cwd: row.thread.cwd ?? row.workspacePath ?? "/", title: row.thread.title || "未命名任务" } }); }} style={styles.row}><View style={styles.icon}>{row.thread.archivedAt ? <Archive size={18} color={colors.textMuted} /> : <Clock3 size={18} color={colors.textMuted} />}</View><View style={styles.copy}><View style={styles.titleRow}><Text style={styles.title} numberOfLines={1}>{row.thread.title || "未命名任务"}</Text>{status ? <Text style={[styles.status, row.thread.status === "failed" && styles.failed]}>{status}</Text> : null}</View><Text style={styles.meta} numberOfLines={1}>{row.serverLabel} · {row.thread.model ?? "KCoder"} · {relativeTime(row.thread.updatedAt)}</Text><Text style={styles.cwd} numberOfLines={1}>{row.thread.cwd ?? row.workspacePath ?? "/"}</Text></View><Pressable testID={`session-actions-${row.thread.id}`} accessibilityLabel={`任务操作 ${row.thread.title || "未命名任务"}`} onPress={(event) => { event.stopPropagation(); setSelectedRow(row); }} style={styles.rowAction}><MoreHorizontal size={20} color={colors.textMuted} /></Pressable></Pressable>; }}
      />}
      {activeProfile ? <ThreadActionsSheet visible={Boolean(selectedTarget)} profile={activeProfile} target={selectedTarget} demo={demo} onClose={() => setSelectedRow(null)} onRenamed={(thread) => changeSelectedThread(thread)} onRemoved={(_kind, thread) => changeSelectedThread(thread, true)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.background }, header: { height: 60, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm }, headerButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center" }, headerTitle: { flex: 1, textAlign: "center", color: colors.text, fontSize: 16, fontWeight: "700" }, search: { height: 48, margin: spacing.lg, marginBottom: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.xs, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface }, searchInput: { flex: 1, color: colors.text, fontSize: 13 }, searchActionButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, searchAction: { color: colors.green, fontSize: 12, fontWeight: "600" }, hostFilterScroller: { flexGrow: 0, flexShrink: 0, maxHeight: 52 }, hostFilters: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }, hostFilter: { minWidth: 92, maxWidth: 180, height: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface }, filters: { alignSelf: "flex-start", flexDirection: "row", marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: 3, borderRadius: 10, backgroundColor: colors.surface }, filter: { minWidth: 88, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 8 }, filterSelected: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border }, filterText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" }, filterSelectedText: { color: colors.text }, loadError: { color: colors.red, fontSize: 12, lineHeight: 18, marginHorizontal: spacing.lg, marginBottom: spacing.sm }, loader: { marginTop: spacing.xl }, moreLoader: { marginVertical: spacing.lg }, content: { flexGrow: 1, paddingHorizontal: spacing.lg }, emptyWrap: { flex: 1, alignItems: "center" }, loadMoreButton: { minWidth: 190, minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: -spacing.lg, paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface }, loadMoreText: { color: colors.text, fontSize: 13, fontWeight: "600" }, row: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md }, icon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }, copy: { flex: 1 }, titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm }, title: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" }, status: { color: colors.yellow, fontSize: 10, fontWeight: "700" }, failed: { color: colors.red }, meta: { color: colors.textMuted, fontSize: 11, marginTop: 5 }, cwd: { color: colors.textDim, fontSize: 10, marginTop: 4, fontFamily: "monospace" }, sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay }, modalKeyboard: { ...StyleSheet.absoluteFillObject }, actionSheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "84%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.borderAccent, backgroundColor: colors.surface }, actionHeader: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: spacing.md }, actionHeading: { flex: 1 }, actionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" }, actionSubtitle: { color: colors.textDim, fontSize: 10, marginTop: 4 }, actionClose: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, renameRow: { minHeight: 50, flexDirection: "row", gap: spacing.sm }, renameInput: { flex: 1, minHeight: 48, color: colors.text, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background }, renameSave: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surfaceRaised }, actionDisabled: { opacity: 0.4 }, actionRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.background }, actionCopy: { flex: 1 }, actionRowTitle: { color: colors.text, fontSize: 13, fontWeight: "600" }, actionDanger: { color: colors.red, fontSize: 13, fontWeight: "700" }, actionRowBody: { color: colors.textDim, fontSize: 10, marginTop: 3 }, actionError: { color: colors.red, fontSize: 12, lineHeight: 18 } });
