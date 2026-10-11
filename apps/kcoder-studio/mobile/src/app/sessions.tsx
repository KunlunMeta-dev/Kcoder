import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Archive, ChevronLeft, ChevronRight, Clock3, MoreHorizontal, Search } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/ui";
import type { KCoderServer, ThreadSummary } from "@/gateway/types";
import { listWorkspaceThreadScopes, mapThreadListScopes, subscribeThreadMutations, ThreadListPager, type WorkspaceOption } from "@/runtime/task-runtime";
import { orderThreadScopeRows, threadListReadOwner, acknowledgeThreadMutationAtWorkspace, threadMutationMatchesRow, threadMutationWorkspaceServers, ThreadListProjection, threadListScopeKey, threadListNotice } from "@/runtime/thread-list-projection";
import type { WorkspaceDefaultReadConnection } from "@/runtime/task-runtime/workspaces";
import { mapThreadListDependencies } from "@/runtime/task-runtime/threadDirectory";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { timestampMs } from "@/protocol/normalizers";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { ThreadActionsSheet, type ThreadActionTarget } from "@/components/thread-actions-sheet";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

interface SessionRow { targetOwner?: string; owner?: string; serverId: string; serverLabel: string; workspacePath?: string; scope?: string; demoTitleKey?: "sessions.demo_design_mobile_client" | "sessions.demo_fix_mobile_sign_in"; thread: ThreadSummary }
interface ServerPagerState { targetOwner: string; owner: string; pager: ThreadListPager; scope: string; serverId: string; serverLabel: string; workspacePath?: string; nextCursor?: string }
type SessionListNotice =
  | { kind: "workspace-resolution"; serverLabel: string; detail: string }
  | { kind: "partial"; serverLabel: string; workspacePath?: string; issueCount: number }
  | { kind: "incomplete"; serverLabel: string; workspacePath?: string };
type SessionLoadError =
  | { kind: "raw"; message: string }
  | { kind: "workspace"; serverLabel: string; workspacePath?: string; message: string };

function relativeTime(value: string | number): string {
  const timestamp = timestampMs(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return t("home.relative_unknown");
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return t("home.just_now");
  if (minutes < 60) return t("home.minutes_ago", { p0: minutes });
  if (minutes < 1_440) return t("home.hours_ago", { p0: Math.floor(minutes / 60) });
  return t("home.days_ago", { p0: Math.floor(minutes / 1_440) });
}

function sessionStatus(status: ThreadSummary["status"]): string | null {
  if (status === "running") return t("task.running");
  if (status === "waiting_for_approval") return t("task.waiting_for_approval");
  if (status === "waiting_for_answer") return t("task.waiting_for_answer");
  if (status === "failed") return t("task.failed");
  return null;
}

function sessionTitle(row: SessionRow): string {
  return row.demoTitleKey ? t(row.demoTitleKey) : row.thread.title || t("task.untitled_task");
}

function formatLoadError(error: SessionLoadError): string {
  if (error.kind === "raw") return error.message;
  return t("sessions.workspace_load_error", {
    p0: error.serverLabel,
    p1: error.workspacePath ?? t("sessions.default_workspace"),
    p2: error.message,
  });
}

function formatListNotice(notice: SessionListNotice): string {
  if (notice.kind === "workspace-resolution") {
    return t("sessions.workspace_resolution_error", { p0: notice.serverLabel, p1: notice.detail });
  }
  const detail = notice.kind === "partial"
    ? t("sessions.partial_list_notice", { p0: notice.issueCount })
    : t("sessions.more_sessions_not_loaded");
  return t("sessions.scoped_notice", {
    p0: notice.serverLabel,
    p1: notice.workspacePath ?? t("sessions.default_workspace"),
    p2: detail,
  });
}

export default function SessionsRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { profileId, serverId: initialServerId } = useLocalSearchParams<{ profileId?: string; serverId?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, activeProfile, profiles, runtime, setActiveProfile, demo } = useApp();
  const goBack = () => backOrReplace(router, profileHomeHref(profileId ?? activeProfile?.id));
  const profileReady = hydrated && (!profileId || activeProfile?.id === profileId);
  const invalidProfile = hydrated && Boolean(profileId) && !profiles.some((profile) => profile.id === profileId);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [serverFilter, setServerFilter] = useState<string>(initialServerId || "all");
  const [loadErrorEntry, setLoadErrorEntry] = useState<{ owner: string; value: SessionLoadError[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRow, setSelectedRow] = useState<SessionRow | null>(null);
  const pagersRef = useRef(new Map<string, ServerPagerState>());
  const workspaceOptionsRef = useRef<Record<string, { owner: string; value: WorkspaceOption[] }>>({});
  const threadProjection = useRef(new ThreadListProjection());
  const [listNoticeEntry, setListNoticeEntry] = useState<{ owner: string; value: Record<string, SessionListNotice> } | null>(null);
  const refreshingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const profileOwner = JSON.stringify([profileId, activeProfile?.id, activeProfile?.baseUrl, activeProfile?.authorizationGeneration, activeProfile?.deviceId]);
  const filter = { archived: showArchived, query: searchQuery || undefined };
  const readOwner = JSON.stringify([profileOwner, demo, isFocused, profileReady, runtime.serversReady, runtime.reauthorizationRequired, serverFilter, filter,
    runtime.servers.map(server => activeProfile ? threadListReadOwner(activeProfile, server, filter) : server.id)]);
  const readOwnerRef = useRef(readOwner); readOwnerRef.current = readOwner;
  const projectionOwner = useRef(profileOwner);
  if (projectionOwner.current !== profileOwner) {
    projectionOwner.current = profileOwner;
    threadProjection.current = new ThreadListProjection();
    workspaceOptionsRef.current = {};
  }
  const loadErrors = loadErrorEntry?.owner === readOwner ? loadErrorEntry.value : [];
  const listNotices = listNoticeEntry?.owner === readOwner ? listNoticeEntry.value : {};
  const setLoadErrors = (update: SessionLoadError[] | ((previous: SessionLoadError[]) => SessionLoadError[])) => setLoadErrorEntry(previous => {
    if (readOwner !== readOwnerRef.current) return previous;
    const value = previous?.owner === readOwner ? previous.value : [];
    return { owner: readOwner, value: typeof update === "function" ? update(value) : update };
  });
  const setListNotices = (update: Record<string, SessionListNotice> | ((previous: Record<string, SessionListNotice>) => Record<string, SessionListNotice>)) => setListNoticeEntry(previous => {
    if (readOwner !== readOwnerRef.current) return previous;
    const value = previous?.owner === readOwner ? previous.value : {};
    return { owner: readOwner, value: typeof update === "function" ? update(value) : update };
  });

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
    workspaceOptionsRef.current = {};
    setServerFilter(initialServerId || "all");
  }, [initialServerId, profileOwner]);

  useEffect(() => {
    if (serverFilter !== "all" && !runtime.servers.some((server) => server.id === serverFilter)) setServerFilter("all");
  }, [runtime.servers, serverFilter]);

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!profileReady || (!runtime.serversReady || runtime.reauthorizationRequired) || !activeProfile || !isFocused) {
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
    const pagers = new Map<string, ServerPagerState>();
    pagersRef.current = pagers;
    if (demo) {
      const server = runtime.servers[0];
      setRows(server ? [
        { serverId: server.id, serverLabel: server.label, workspacePath: server.workspacePath, demoTitleKey: "sessions.demo_design_mobile_client", thread: { id: "demo-1", status: "idle", title: "", cwd: server.workspacePath, model: "MiniMax-M3", createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 60_000 } },
        { serverId: server.id, serverLabel: server.label, workspacePath: server.workspacePath, demoTitleKey: "sessions.demo_fix_mobile_sign_in", thread: { id: "demo-2", status: "idle", title: "", cwd: server.workspacePath, model: "MiniMax-M3", createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 7_200_000 } },
      ] : []);
      setLoading(false);
      setRefreshing(false);
      refreshingRef.current = false;
      return;
    }
    let cancelled = false;
    const resolverController = new AbortController();
    const targetServers = serverFilter === "all"
      ? runtime.servers
      : runtime.servers.filter((server) => server.id === serverFilter);
    const operationOwner = readOwner;
    const capturedOwners = targetServers.map(server => threadListReadOwner(activeProfile, server, filter));
    const mutationRevision = threadProjection.current.revision;
    const current = () => !cancelled && !resolverController.signal.aborted && operationOwner === readOwnerRef.current &&
      pagersRef.current === pagers && mutationRevision === threadProjection.current.revision &&
      targetServers.every((server, index) => capturedOwners[index] === threadListReadOwner(activeProfile, server, filter));
    const unclaimedDefaultReads = new Set<WorkspaceDefaultReadConnection>();
    const records = new Map<string, ServerPagerState>();
    const notices = new Map<string, SessionListNotice>();
    const errors = new Map<string, SessionLoadError>();
    const publish = (final = false) => {
      if (!current()) return;
      const replacements = [...records.values()].flatMap(state => (threadProjection.current.get(state.scope)?.threads ?? []).map(thread => ({
        targetOwner: state.targetOwner, owner: state.owner, serverId: state.serverId, serverLabel: state.serverLabel, workspacePath: state.workspacePath, scope: state.scope, thread,
      })));
      const keys = new Set(records.keys());
      setRows(previous => current() ? orderThreadScopeRows([
        ...(final ? [] : previous.filter(row => !keys.has(row.scope ?? ""))), ...replacements,
      ]) : previous);
      setListNotices(previous => current() ? Object.fromEntries(notices) : previous);
      setLoadErrors(previous => current() ? [...errors.values()] : previous);
    };
    const acceptPage = (state: ServerPagerState, page: Awaited<ReturnType<ThreadListPager["page"]>>) => {
      if (!current()) return;
      state.nextCursor = page.nextCursor;
      threadProjection.current.update(state.scope, page);
      const notice = threadListNotice(page);
      if (notice) notices.set(state.scope, page.completeness === "partial" ? { kind: "partial", serverLabel: state.serverLabel, workspacePath: state.workspacePath, issueCount: page.issueCount } : { kind: "incomplete", serverLabel: state.serverLabel, workspacePath: state.workspacePath }); else notices.delete(state.scope);
      errors.delete(state.scope);
      if (!state.nextCursor) { state.pager.close(); pagers.delete(state.scope); }
      publish();
    };
    const registerScope = (server: KCoderServer, workspaceServer: KCoderServer) => {
      const scope = threadListScopeKey(activeProfile, workspaceServer, filter);
      const existing = records.get(scope);
      if (existing) return existing;
      const state: ServerPagerState = { pager: new ThreadListPager(activeProfile, workspaceServer, filter, "foreground",
        { isCurrent: current, signal: resolverController.signal }), scope,
        targetOwner: threadListReadOwner(activeProfile, server, filter), owner: threadListReadOwner(activeProfile, workspaceServer, filter),
        serverId: server.id, serverLabel: server.label, workspacePath: workspaceServer.workspacePath };
      records.set(scope, state); pagers.set(scope, state);
      return state;
    };
    const readFirstPage = async (server: KCoderServer, workspaceServer: KCoderServer, defaultRead?: WorkspaceDefaultReadConnection) => {
      const state = registerScope(server, workspaceServer);
      const scope = state.scope;
      try {
        if (defaultRead) {
          const client = defaultRead.claim(activeProfile, workspaceServer, current);
          state.pager.close(); // This initial placeholder has not connected.
          state.pager = new ThreadListPager(activeProfile, workspaceServer, filter, "foreground",
            { isCurrent: current, signal: resolverController.signal, client, releaseClient: () => defaultRead.close() });
          unclaimedDefaultReads.delete(defaultRead);
        }
        const page = await state.pager.page(undefined, 50);
        acceptPage(state, page);
        return { scope, error: null as string | null };
      } catch (value) {
        if (current()) {
          state.pager.close(); pagers.delete(scope);
          errors.set(scope, { kind: "workspace", serverLabel: server.label, workspacePath: workspaceServer.workspacePath, message: value instanceof Error ? value.message : String(value) });
          publish();
        }
        return { scope, error: value instanceof Error ? value.message : String(value) };
      }
    };
    const earlyDefaultReads = new Map<string, ReturnType<typeof readFirstPage>>();
    void (async () => {
      try {
        await mapThreadListDependencies(
          targetServers,
          async server => {
            const cacheKey = threadListScopeKey(activeProfile, server);
            const entry = workspaceOptionsRef.current[cacheKey];
            const knownOptions = entry?.owner === threadListReadOwner(activeProfile, server) ? entry.value : [];
            const resolved = await listWorkspaceThreadScopes(activeProfile, server, knownOptions,
              { signal: resolverController.signal, priority: "background" },
              { isCurrent: current, onOwned: connection => { unclaimedDefaultReads.add(connection); },
                onReady: connection => {
                  if (!current()) return;
                  const scope = threadListScopeKey(activeProfile, server, filter);
                  // First page publishes while catalog is pending; its cursor
                  // retains the socket, never a scheduler worker slot.
                  earlyDefaultReads.set(scope, readFirstPage(server, server, connection));
                } });
            return { server, cacheKey, resolved };
          },
          ({ server, resolved }) => resolved.servers.map(workspaceServer => ({ server, workspaceServer,
            defaultRead: workspaceServer.workspacePath === server.workspacePath ? resolved.defaultRead : undefined })),
          ({ server, workspaceServer, defaultRead }) =>
            earlyDefaultReads.get(threadListScopeKey(activeProfile, workspaceServer, filter))
              ?? readFirstPage(server, workspaceServer, defaultRead),
          {
            isCurrent: current,
            readFirstInDiscovery: scope => Boolean(scope.defaultRead),
            onTargetDiscovered: ({ server, cacheKey, resolved }) => {
              if (!current()) return;
              workspaceOptionsRef.current[cacheKey] = { owner: threadListReadOwner(activeProfile, server), value: resolved.options };
              for (const workspaceServer of resolved.servers) registerScope(server, workspaceServer);
              if (resolved.error) notices.set(`workspace:${server.id}`, { kind: "workspace-resolution", serverLabel: server.label, detail: resolved.error });
            },
          },
        );
        if (!current()) return;
        threadProjection.current.retainScopes([...records.keys()]);
        publish(true);
      } finally {
        for (const connection of unclaimedDefaultReads) connection.close();
        unclaimedDefaultReads.clear();
        if (current()) {
          setLoading(previous => current() ? false : previous);
          setRefreshing(previous => current() ? false : previous);
          refreshingRef.current = false;
        }
      }
    })().catch(value => {
      if (current()) setLoadErrors(previous => current() ? [{ kind: "raw", message: value instanceof Error ? value.message : String(value) }] : previous);
    });
    return () => {
      cancelled = true;
      resolverController.abort();
      for (const connection of unclaimedDefaultReads) connection.close();
      unclaimedDefaultReads.clear();
      for (const state of pagers.values()) state.pager.close();
      if (pagersRef.current === pagers) pagersRef.current = new Map();
    };
  }, [readOwner, reloadRevision]);

  useEffect(() => {
    if (demo || !activeProfile) return;
    const profile = activeProfile;
    const mutationOwner = readOwner;
    return subscribeThreadMutations((event) => {
      if (mutationOwner !== readOwnerRef.current) return;
      const server = runtime.servers.find((candidate) => candidate.id === event.serverId);
      if (!server) return;
      const entry = workspaceOptionsRef.current[threadListScopeKey(profile, server)];
      const options = entry?.owner === threadListReadOwner(profile, server) ? entry.value : [];
      const filter = { archived: showArchived, query: searchQuery || undefined };
      const scopes = threadMutationWorkspaceServers(
        threadProjection.current,
        profile,
        server,
        options,
        filter,
        event,
      );
      if (scopes.length === 0) return;

      const scopeKeys = new Set(scopes.map((scope) =>
        acknowledgeThreadMutationAtWorkspace(
          threadProjection.current,
          profile,
          server,
          scope.workspacePath,
          event.cwd,
          filter,
          event.threadId,
          event.mutation,
        ),
      ));
      for (const state of pagersRef.current.values()) state.pager.close();
      pagersRef.current = new Map();
      loadingMoreRef.current = false;
      setLoadingMore(false);
      const revision = threadProjection.current.revision;
      setRows((current) => {
        if (mutationOwner !== readOwnerRef.current || revision !== threadProjection.current.revision) return current;
        return current.flatMap((row) => {
        if (row.serverId !== server.id || !scopeKeys.has(row.scope ?? "") || !threadMutationMatchesRow(row.thread, event.threadId, event.cwd, row.workspacePath))
          return [row];
        return event.mutation.kind === "rename"
          ? [{ ...row, thread: { ...row.thread, title: event.mutation.title } }]
          : [];
      });
      });
      setSelectedRow((current) => {
        if (mutationOwner !== readOwnerRef.current || revision !== threadProjection.current.revision) return current;
        if (!current || current.serverId !== server.id || !scopeKeys.has(current.scope ?? "") || !threadMutationMatchesRow(current.thread, event.threadId, event.cwd, current.workspacePath))
          return current;
        return event.mutation.kind === "rename"
          ? { ...current, thread: { ...current.thread, title: event.mutation.title } }
          : null;
      });
      setReloadRevision((value) => value + 1);
    });
  }, [readOwner, demo, runtime.servers, searchQuery, showArchived]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || loading || refreshing) return;
    const generationPagers = pagersRef.current;
    const operationOwner = readOwner;
    const mutationRevision = threadProjection.current.revision;
    const current = () => pagersRef.current === generationPagers && operationOwner === readOwnerRef.current && mutationRevision === threadProjection.current.revision &&
      Boolean(activeProfile && [...generationPagers.values()].every(state => runtime.servers.some(server =>
        server.id === state.serverId && state.targetOwner === threadListReadOwner(activeProfile, server, filter) && state.owner === threadListReadOwner(activeProfile, { ...server, workspacePath: state.workspacePath }, filter))));
    const targets = [...generationPagers.entries()].filter(([, state]) => (
      Boolean(state.nextCursor) && (serverFilter === "all" || state.serverId === serverFilter)
    ));
    if (targets.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      await mapThreadListScopes(targets, async ([scopeKey, state]) => {
        if (!current() || !state.nextCursor) return;
        try {
          const page = await state.pager.page(state.nextCursor, 50);
          if (!current()) return;
          state.nextCursor = page.nextCursor;
          const projected = threadProjection.current.update(state.scope, page);
          const replacement = projected.threads.map(thread => ({ targetOwner: state.targetOwner, owner: state.owner, serverId: state.serverId,
            serverLabel: state.serverLabel, workspacePath: state.workspacePath, scope: state.scope, thread }));
          setRows(previous => current() ? orderThreadScopeRows([...previous.filter(row => row.scope !== scopeKey), ...replacement]) : previous);
          setListNotices(previous => {
            if (!current()) return previous;
            const next = { ...previous }; const notice = threadListNotice(page);
            if (notice) next[scopeKey] = page.completeness === "partial" ? { kind: "partial", serverLabel: state.serverLabel, workspacePath: state.workspacePath, issueCount: page.issueCount } : { kind: "incomplete", serverLabel: state.serverLabel, workspacePath: state.workspacePath }; else delete next[scopeKey];
            return next;
          });
          if (!state.nextCursor) { state.pager.close(); generationPagers.delete(scopeKey); }
        } catch (value) {
          if (!current()) return;
          state.nextCursor = undefined; state.pager.close(); generationPagers.delete(scopeKey);
          const error: SessionLoadError = { kind: "workspace", serverLabel: state.serverLabel, workspacePath: state.workspacePath, message: value instanceof Error ? value.message : String(value) };
          setLoadErrors(previous => current() ? [...new Map([...previous, error].map(entry => [JSON.stringify(entry), entry])).values()] : previous);
        }
      });
    } finally {
      if (current()) {
        loadingMoreRef.current = false;
        setLoadingMore(previous => current() ? false : previous);
      }
    }
  }, [loading, refreshing, runtime.servers, serverFilter, readOwner, activeProfile, searchQuery, showArchived]);

  const ownsRow = (row: SessionRow) => Boolean(activeProfile && runtime.servers.some(server => {
    if (server.id !== row.serverId) return false;
    const scopedServer = { ...server, workspacePath: row.workspacePath };
    return row.targetOwner === threadListReadOwner(activeProfile, server, filter) &&
      row.owner === threadListReadOwner(activeProfile, scopedServer, filter) && row.scope === threadListScopeKey(activeProfile, scopedServer, filter);
  }));
  const filtered = useMemo(() => {
    const needle = searchQuery.toLocaleLowerCase(locale);
    return rows.filter((row) => (
      (demo || ownsRow(row)) &&
      (showArchived ? Boolean(row.thread.archivedAt) : !row.thread.archivedAt) &&
      (serverFilter === "all" || row.serverId === serverFilter) &&
      (!needle || [row.thread.title, row.thread.cwd, row.thread.model, row.serverLabel]
        .some((value) => value?.toLocaleLowerCase(locale).includes(needle)) ||
        Boolean(row.demoTitleKey && sessionTitle(row).toLocaleLowerCase(locale).includes(needle)))
    ));
  }, [rows, searchQuery, serverFilter, showArchived, demo, activeProfile, runtime.servers, readOwner, locale]);
  const hasMoreForSelection = [...pagersRef.current.values()].some((state) => (
    Boolean(state.nextCursor) && (serverFilter === "all" || state.serverId === serverFilter)
  ));
  const selectedTarget: ThreadActionTarget | null = selectedRow ? (() => {
    const server = runtime.servers.find((candidate) => candidate.id === selectedRow.serverId);
    return server && activeProfile && (demo || ownsRow(selectedRow)) ? { server: { ...server, workspacePath: selectedRow.workspacePath }, thread: { ...selectedRow.thread, title: sessionTitle(selectedRow) } } : null;
  })() : null;
  const changeSelectedThread = (thread: ThreadSummary, removed = false) => {
    if (!selectedRow || !activeProfile || !selectedTarget) return;
    const scope = selectedRow.scope ?? threadListScopeKey(activeProfile, selectedTarget.server, { archived: showArchived, query: searchQuery || undefined });
    if (removed) threadProjection.current.removeThread(scope, thread.id);
    else threadProjection.current.changeThread(scope, thread);
    setRows((current) => removed
      ? current.filter((candidate) => candidate.scope !== scope || candidate.thread.id !== thread.id)
      : current.map((candidate) => candidate.scope === scope && candidate.thread.id === thread.id ? { ...candidate, thread, demoTitleKey: undefined } : candidate));
    setSelectedRow(removed ? null : { ...selectedRow, thread, demoTitleKey: undefined });
    // Discard the pre-mutation cursor snapshot before accepting more pages.
    for (const state of pagersRef.current.values()) state.pager.close();
    pagersRef.current = new Map();
    setReloadRevision((value) => value + 1);
  };
  if (invalidProfile) {
    return <View style={[styles.root, { paddingTop: insets.top }]}><View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={goBack} style={styles.headerButton}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>{t("task.history")}</Text><View style={styles.headerButton} /></View><EmptyState icon={<Archive size={40} color={colors.textDim} />} title={t("sessions.gateway_missing_title")} body={t("sessions.gateway_missing_body")} /></View>;
  }
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={goBack} style={styles.headerButton}><ChevronLeft size={23} color={colors.text} /></Pressable><Text style={styles.headerTitle}>{t("task.history")}</Text><View style={styles.headerButton} /></View>
      <View style={styles.search}><Search size={18} color={colors.textDim} /><TextInput testID="session-search" value={query} onChangeText={setQuery} placeholder={t("sessions.search_placeholder")} placeholderTextColor={colors.textDim} style={styles.searchInput} />{query ? <Pressable accessibilityLabel={t("task.clear_search")} onPress={() => setQuery("")} style={styles.searchActionButton}><Text style={styles.searchAction}>{t("task.clear_search")}</Text></Pressable> : null}</View>
      {runtime.servers.length > 1 ? <ScrollView horizontal style={styles.hostFilterScroller} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hostFilters}><Pressable testID="sessions-host-all" accessibilityState={{ selected: serverFilter === "all" }} onPress={() => setServerFilter("all")} style={[styles.hostFilter, serverFilter === "all" && styles.filterSelected]}><Text style={[styles.filterText, serverFilter === "all" && styles.filterSelectedText]}>{t("sessions.all_servers")}</Text></Pressable>{runtime.servers.map((server) => <Pressable key={server.id} testID={`sessions-host-${server.id}`} accessibilityState={{ selected: serverFilter === server.id }} onPress={() => setServerFilter(server.id)} style={[styles.hostFilter, serverFilter === server.id && styles.filterSelected]}><Text numberOfLines={1} style={[styles.filterText, serverFilter === server.id && styles.filterSelectedText]}>{server.label}</Text></Pressable>)}</ScrollView> : null}
      <View style={styles.filters}><Pressable testID="sessions-active" accessibilityState={{ selected: !showArchived }} onPress={() => setShowArchived(false)} style={[styles.filter, !showArchived && styles.filterSelected]}><Text style={[styles.filterText, !showArchived && styles.filterSelectedText]}>{t("sessions.recent_tasks")}</Text></Pressable><Pressable testID="sessions-archived" accessibilityState={{ selected: showArchived }} onPress={() => setShowArchived(true)} style={[styles.filter, showArchived && styles.filterSelected]}><Text style={[styles.filterText, showArchived && styles.filterSelectedText]}>{t("sessions.archived")}</Text></Pressable></View>
      {loadErrors.length > 0 ? <Text style={styles.loadError}>{loadErrors.map(formatLoadError).join("\n")}</Text> : null}
      {Object.keys(listNotices).length > 0 ? <Text accessibilityRole="alert" style={styles.loadError}>{Object.values(listNotices).map(formatListNotice).join("\n")}</Text> : null}
      {!profileReady || (!runtime.serversReady || runtime.reauthorizationRequired) || query.trim() !== searchQuery || (loading && !refreshing && filtered.length === 0) ? <ActivityIndicator style={styles.loader} color={colors.textMuted} /> : <FlatList
        testID="sessions-list"
        data={filtered}
        keyExtractor={(row) => `${row.serverId}:${row.scope ?? "demo"}:${row.thread.id}`}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { refreshingRef.current = true; setRefreshing(true); setReloadRevision((value) => value + 1); }} tintColor={colors.textMuted} />}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.35}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={9}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        ListFooterComponent={loading || loadingMore ? <ActivityIndicator testID="sessions-page-loading" style={styles.moreLoader} color={colors.textMuted} /> : null}
        ListEmptyComponent={<View style={styles.emptyWrap}><EmptyState icon={showArchived ? <Archive size={40} color={colors.textDim} /> : <Clock3 size={40} color={colors.textDim} />} title={loadErrors.length > 0 || Object.keys(listNotices).length > 0 ? t("sessions.more_sessions_not_loaded") : hasMoreForSelection ? t("sessions.no_loaded_match_title") : query ? t("sessions.no_search_match_title") : showArchived ? t("sessions.no_archived_title") : t("sessions.no_tasks_title")} body={loadErrors.length > 0 || Object.keys(listNotices).length > 0 ? t("sessions.partial_list_notice", { p0: loadErrors.length + Object.keys(listNotices).length }) : hasMoreForSelection ? t("sessions.no_loaded_match_body") : query ? t("sessions.no_search_match_body") : showArchived ? t("sessions.no_archived_body") : t("sessions.no_tasks_body")} />{hasMoreForSelection ? <Pressable testID="sessions-load-more-empty" disabled={loading || refreshing || loadingMore} onPress={() => void loadMore()} style={styles.loadMoreButton}>{loadingMore ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.loadMoreText}>{t("sessions.continue_searching_older")}</Text>}</Pressable> : null}</View>}
        renderItem={({ item: row }) => { const status = sessionStatus(row.thread.status); const title = sessionTitle(row); return <Pressable testID={`session-${row.thread.id}`} onPress={() => { if (!profileReady || (!runtime.serversReady || runtime.reauthorizationRequired) || !activeProfile || readOwner !== readOwnerRef.current || (!demo && !ownsRow(row))) return; router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: row.serverId, threadId: row.thread.id, cwd: row.thread.cwd ?? row.workspacePath ?? "/", title } }); }} style={styles.row}><View style={styles.icon}>{row.thread.archivedAt ? <Archive size={18} color={colors.textMuted} /> : <Clock3 size={18} color={colors.textMuted} />}</View><View style={styles.copy}><View style={styles.titleRow}><Text style={styles.title} numberOfLines={1}>{title}</Text>{status ? <Text style={[styles.status, row.thread.status === "failed" && styles.failed]}>{status}</Text> : null}</View><Text style={styles.meta} numberOfLines={1}>{row.serverLabel} · {row.thread.model ?? "KCoder"} · {relativeTime(row.thread.updatedAt)}</Text><Text style={styles.cwd} numberOfLines={1}>{row.thread.cwd ?? row.workspacePath ?? "/"}</Text></View><Pressable testID={`session-actions-${row.thread.id}`} accessibilityLabel={t("sessions.task_actions", { p0: title })} onPress={(event) => { event.stopPropagation(); if (readOwner !== readOwnerRef.current || (!demo && !ownsRow(row))) return; setSelectedRow(row); }} style={styles.rowAction}><MoreHorizontal size={20} color={colors.textMuted} /></Pressable></Pressable>; }}
      />}
      {activeProfile ? <ThreadActionsSheet visible={Boolean(selectedTarget)} profile={activeProfile} target={selectedTarget} demo={demo} onClose={() => setSelectedRow(null)} onRenamed={(thread) => { if (demo) changeSelectedThread(thread); }} onRemoved={(_kind, thread) => { if (demo) changeSelectedThread(thread, true); }} /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({ root: { flex: 1, backgroundColor: colors.background }, header: { height: 60, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm }, headerButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center" }, headerTitle: { flex: 1, textAlign: "center", color: colors.text, fontSize: 16, fontWeight: "700" }, search: { height: 48, margin: spacing.lg, marginBottom: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.xs, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 12, backgroundColor: colors.surface }, searchInput: { flex: 1, color: colors.text, fontSize: 13 }, searchActionButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, searchAction: { color: colors.green, fontSize: 12, fontWeight: "600" }, hostFilterScroller: { flexGrow: 0, flexShrink: 0, maxHeight: 52 }, hostFilters: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }, hostFilter: { minWidth: 92, maxWidth: 180, height: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 10, backgroundColor: colors.surface }, filters: { alignSelf: "flex-start", flexDirection: "row", marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: 3, borderRadius: 10, backgroundColor: colors.surface }, filter: { minWidth: 88, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 8 }, filterSelected: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.borderAccent }, filterText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" }, filterSelectedText: { color: colors.text }, loadError: { color: colors.red, fontSize: 12, lineHeight: 18, marginHorizontal: spacing.lg, marginBottom: spacing.sm }, loader: { marginTop: spacing.xl }, moreLoader: { marginVertical: spacing.lg }, content: { flexGrow: 1, paddingHorizontal: spacing.lg }, emptyWrap: { flex: 1, alignItems: "center" }, loadMoreButton: { minWidth: 190, minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: -spacing.lg, paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 12, backgroundColor: colors.surface }, loadMoreText: { color: colors.text, fontSize: 13, fontWeight: "600" }, row: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md }, icon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }, copy: { flex: 1 }, titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm }, title: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" }, status: { color: colors.yellow, fontSize: 10, fontWeight: "700" }, failed: { color: colors.red }, meta: { color: colors.textMuted, fontSize: 11, marginTop: 5 }, cwd: { color: colors.textDim, fontSize: 10, marginTop: 4, fontFamily: "monospace" }, sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay }, modalKeyboard: { ...StyleSheet.absoluteFillObject }, actionSheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "84%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.borderAccent, backgroundColor: colors.surface }, actionHeader: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: spacing.md }, actionHeading: { flex: 1 }, actionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" }, actionSubtitle: { color: colors.textDim, fontSize: 10, marginTop: 4 }, actionClose: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, renameRow: { minHeight: 50, flexDirection: "row", gap: spacing.sm }, renameInput: { flex: 1, minHeight: 48, color: colors.text, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background }, renameSave: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surfaceRaised }, actionDisabled: { opacity: 0.4 }, actionRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background }, actionCopy: { flex: 1 }, actionRowTitle: { color: colors.text, fontSize: 13, fontWeight: "600" }, actionDanger: { color: colors.red, fontSize: 13, fontWeight: "700" }, actionRowBody: { color: colors.textDim, fontSize: 10, marginTop: 3 }, actionError: { color: colors.red, fontSize: 12, lineHeight: 18 } });
