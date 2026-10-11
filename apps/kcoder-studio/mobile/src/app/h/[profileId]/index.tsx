import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronDown, ChevronRight, ChevronUp, GitBranch, History, Laptop, Menu, Plus, Server, Settings, SquareTerminal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, StatusDot } from "@/components/ui";
import type { ThreadSummary } from "@/gateway/types";
import { listThreads, listWorkspaceThreadScopes, subscribeThreadMutations, type ThreadListPage, type WorkspaceOption } from "@/runtime/task-runtime";
import { acknowledgeThreadMutationAtWorkspace, acknowledgeWorkspaceThreadMutation, threadMutationWorkspaceServers, ThreadListProjection, threadListScopeKey, threadListNotice, threadListReadOwner, orderThreadScopeRows } from "@/runtime/thread-list-projection";
import { mapThreadListDependencies } from "@/runtime/task-runtime/threadDirectory";
import { workspaceThreadScopeServers, type WorkspaceDefaultReadConnection } from "@/runtime/task-runtime/workspaces";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { timestampMs } from "@/protocol/normalizers";
import { MobileDrawer } from "@/components/mobile-drawer";
import { groupThreadsByWorkspace, hiddenThreadCount, projectVisibleThreads } from "@/components/thread-list-presentation";
import { useCollapsedServerSections } from "@/storage/use-collapsed-server-sections";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { HistoryRefreshModal, type HistoryRefreshTarget } from "@/components/history-refresh-modal";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

interface OwnedValue<T> { owner: string; value: T }

const DEMO_THREADS: Record<string, ThreadSummary[]> = {
  local: [
    { id: "demo-1", status: "idle", title: "设计 React Native 客户端", cwd: "/data/projects/kcoder", model: "MiniMax-M3", createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 58_000).toISOString() },
    { id: "demo-2", status: "waiting_for_approval", title: "修复移动端登录", cwd: "/data/projects/kcoder", model: "MiniMax-M3", createdAt: new Date(Date.now() - 86_400_000).toISOString(), updatedAt: new Date(Date.now() - 7_200_000).toISOString() },
  ],
};

function relativeTime(value: string | number): string {
  const timestamp = timestampMs(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return t("home.relative_unknown");
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return t("home.just_now");
  if (seconds < 3600) return t("home.minutes_ago", { p0: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("home.hours_ago", { p0: Math.floor(seconds / 3600) });
  return t("home.days_ago", { p0: Math.floor(seconds / 86_400) });
}

export default function HostHomeRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, activeProfile, profiles, runtime, demo, refresh, setActiveProfile } = useApp();
  const invalidProfile = hydrated && !profiles.some((item) => item.id === profileId);
  const [threads, setThreads] = useState<Record<string, ThreadSummary[]>>(demo ? DEMO_THREADS : {});
  const [workspaceOptionEntries, setWorkspaceOptionEntries] = useState<Record<string, OwnedValue<WorkspaceOption[]>>>({});
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadErrorEntries, setThreadErrorEntries] = useState<Record<string, OwnedValue<string>>>({});
  const [workspaceErrorEntries, setWorkspaceErrorEntries] = useState<Record<string, OwnedValue<string>>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyRefreshTarget, setHistoryRefreshTarget] = useState<HistoryRefreshTarget | null>(null);
  const [threadReloadRevision, setThreadReloadRevision] = useState(0);
  const threadLoadGeneration = useRef(0);
  const threadLoadAbort = useRef<AbortController | null>(null);
  const profileReadOwner = JSON.stringify([profileId, activeProfile?.id, activeProfile?.baseUrl, activeProfile?.authorizationGeneration, activeProfile?.deviceId]);
  const readOwner = JSON.stringify([profileReadOwner, demo, isFocused, runtime.servers.map(server => [activeProfile ? threadListScopeKey(activeProfile, server) : server.id, server.workspacePath === undefined ? ["undefined"] : ["path", server.workspacePath]])]);
  const readOwnerRef = useRef(readOwner);
  readOwnerRef.current = readOwner;
  const threadProjection = useRef(new ThreadListProjection());
  const projectionProfileOwner = useRef(profileReadOwner);
  const rowOwners = useRef<Record<string, string>>({});
  const workspaceOptionsRef = useRef<Record<string, OwnedValue<WorkspaceOption[]>>>({});
  // Per mounted profile/target, bounded by its discovered scopes. A new refresh
  // replaces only the notice for the scope that actually returned a result.
  const scopeNotices = useRef<Record<string, OwnedValue<Record<string, string>>>>({});
  if (projectionProfileOwner.current !== profileReadOwner) {
    projectionProfileOwner.current = profileReadOwner;
    threadProjection.current = new ThreadListProjection();
    workspaceOptionsRef.current = {};
    scopeNotices.current = {};
  }
  const serverOwners = Object.fromEntries(runtime.servers.map(server => [server.id,
    activeProfile && activeProfile.id === profileId ? threadListReadOwner(activeProfile, server, { archived: false }) : ""]));
  const ownedValues = <T,>(entries: Record<string, OwnedValue<T>>): Record<string, T> => Object.fromEntries(
    Object.entries(entries).filter(([id, entry]) => entry.owner === serverOwners[id]).map(([id, entry]) => [id, entry.value]),
  );
  // Synchronous render fences cover options and errors consumed by both the
  // workspace groups and Drawer, including the render before effects clean up.
  const workspaceOptions = useMemo(() => ownedValues(workspaceOptionEntries), [workspaceOptionEntries, readOwner]);
  const workspaceErrors = useMemo(() => ownedValues(workspaceErrorEntries), [workspaceErrorEntries, readOwner]);
  const threadErrors = useMemo(() => ownedValues(threadErrorEntries), [threadErrorEntries, readOwner]);
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
    const generation = ++threadLoadGeneration.current;
    threadLoadAbort.current?.abort();
    threadLoadAbort.current = null;
    if (demo || !activeProfile || runtime.servers.length === 0) {
      setLoadingThreads(false);
      return;
    }
    const controller = new AbortController();
    threadLoadAbort.current = controller;
    const ownedDefaultReads: WorkspaceDefaultReadConnection[] = [];
    const operationOwner = readOwner;
    const mutationRevision = threadProjection.current.revision;
    const profile = activeProfile;
    const servers = [...runtime.servers];
    const targetOwner = () => JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId, servers.map(server => [threadListScopeKey(profile, server), server.workspacePath === undefined ? ["undefined"] : ["path", server.workspacePath]])]);
    const originalTargetOwner = targetOwner();
    const isCurrent = () => originalTargetOwner === targetOwner() && !controller.signal.aborted && operationOwner === readOwnerRef.current && generation === threadLoadGeneration.current && mutationRevision === threadProjection.current.revision;
    const scopeRecordsFor = ({ server, resolved }: { server: (typeof servers)[number]; cacheKey: string; resolved: Awaited<ReturnType<typeof listWorkspaceThreadScopes>> }) =>
      resolved.servers.map((workspaceServer) => ({
        server,
        workspaceServer,
        scope: threadListScopeKey(profile, workspaceServer, { archived: false }),
        defaultRead: workspaceServer.workspacePath === server.workspacePath ? resolved.defaultRead : undefined,
      }));
    type ScopeRecord = ReturnType<typeof scopeRecordsFor>[number];
    const records = new Map<string, ScopeRecord[]>();
    const oldOptions = new Map(servers.map(server => {
      const entry = workspaceOptionsRef.current[threadListScopeKey(profile, server)];
      return [server.id, entry?.owner === threadListReadOwner(profile, server, { archived: false }) ? entry.value : []] as const;
    }));
    const notices = new Map<string, string>();
    for (const server of servers) {
      const owner = threadListReadOwner(profile, server, { archived: false });
      const entry = scopeNotices.current[server.id];
      const previous = entry?.owner === owner ? entry.value : {};
      for (const workspaceServer of workspaceThreadScopeServers(server, oldOptions.get(server.id) ?? [])) {
        const scope = threadListScopeKey(profile, workspaceServer, { archived: false });
        const snapshot = threadProjection.current.get(scope);
        const notice = previous[scope] ?? (snapshot ? threadListNotice(snapshot) : null);
        if (notice) notices.set(scope, notice);
      }
    }
    const publishServer = (server: (typeof servers)[number], final = false) => {
      if (!isCurrent()) return;
      const scopes = records.get(server.id) ?? [];
      const candidates = final ? scopes.map(scope => scope.workspaceServer)
        : [...workspaceThreadScopeServers(server, oldOptions.get(server.id) ?? []), ...scopes.map(scope => scope.workspaceServer)];
      const byScope = new Map(candidates.map(workspaceServer => [threadListScopeKey(profile, workspaceServer, { archived: false }), workspaceServer]));
      const rows = [...byScope].flatMap(([scope, workspaceServer]) => (threadProjection.current.get(scope)?.threads ?? []).map(thread => ({ serverId: server.id, workspacePath: workspaceServer.workspacePath, scope, thread })));
      const projected = orderThreadScopeRows(rows).map(row => row.thread);
      setThreads(current => {
        if (!isCurrent()) return current;
        rowOwners.current[server.id] = threadListReadOwner(profile, server, { archived: false });
        return { ...current, [server.id]: projected };
      });
      setThreadErrorEntries(current => {
        if (!isCurrent()) return current;
        const next = { ...current };
        const owner = threadListReadOwner(profile, server, { archived: false });
        const retained = Object.fromEntries([...byScope.keys()].filter(scope => notices.has(scope)).map(scope => [scope, notices.get(scope)!]));
        scopeNotices.current[server.id] = { owner, value: retained };
        const messages = [...byScope].flatMap(([scope, workspaceServer]) => notices.has(scope) ? [`${workspaceServer.workspacePath ?? server.label}：${notices.get(scope)}`] : []);
        if (messages.length) next[server.id] = { owner, value: messages.join("\n") }; else delete next[server.id];
        return next;
      });
    };
    const publishPage = (scope: ScopeRecord, page: ThreadListPage) => {
      if (!isCurrent()) return;
      threadProjection.current.update(scope.scope, page);
      const notice = threadListNotice(page);
      if (notice) notices.set(scope.scope, notice); else notices.delete(scope.scope);
      publishServer(scope.server);
    };
    const readScope = async (scope: ScopeRecord) => {
      try {
        const options = { isCurrent, signal: controller.signal, onPage: (page: ThreadListPage) => publishPage(scope, page) };
        const page = scope.defaultRead
          ? await scope.defaultRead.read(profile, scope.workspaceServer, isCurrent, client => listThreads(profile, scope.workspaceServer, 100, { archived: false }, { ...options, client }))
          : await listThreads(profile, scope.workspaceServer, 100, { archived: false }, options);
        return { ...scope, page, error: null as string | null };
      } catch (value) {
        const error = value instanceof Error ? value.message : String(value);
        if (isCurrent()) { notices.set(scope.scope, error); publishServer(scope.server); }
        return { ...scope, page: undefined as ThreadListPage | undefined, error };
      }
    };
    const earlyDefaultReads = new Map<string, ReturnType<typeof readScope>>();
    setLoadingThreads(true);
    try {
      await mapThreadListDependencies(
        servers,
        async (server) => {
          const cacheKey = threadListScopeKey(profile, server);
          const resolved = await listWorkspaceThreadScopes(profile, server, oldOptions.get(server.id) ?? [], { signal: controller.signal }, {
            isCurrent,
            onOwned: connection => { ownedDefaultReads.push(connection); },
            onReady: connection => {
              if (!isCurrent()) return;
              const scope: ScopeRecord = { server, workspaceServer: server,
                scope: threadListScopeKey(profile, server, { archived: false }), defaultRead: connection };
              // Register before any page callback, even while catalog is held.
              records.set(server.id, [scope]);
              earlyDefaultReads.set(scope.scope, readScope(scope));
            },
          });
          return { server, cacheKey, resolved };
        },
        scopeRecordsFor,
        scope => earlyDefaultReads.get(scope.scope) ?? readScope(scope),
        {
          isCurrent,
          readFirstInDiscovery: scope => Boolean(scope.defaultRead),
          onTargetDiscovered: resolution => {
            if (!isCurrent()) return;
            const { server, cacheKey, resolved } = resolution;
            records.set(server.id, scopeRecordsFor(resolution));
            const owner = threadListReadOwner(profile, server, { archived: false });
            workspaceOptionsRef.current[cacheKey] = { owner, value: resolved.options };
            setWorkspaceOptionEntries(current => isCurrent() ? { ...current, [server.id]: { owner, value: resolved.options } } : current);
            setWorkspaceErrorEntries(current => {
              if (!isCurrent()) return current;
              const next = { ...current }; if (resolved.error) next[server.id] = { owner, value: resolved.error }; else delete next[server.id]; return next;
            });
          },
          onReadSettled: result => {
            if (!isCurrent()) return;
            if (result.error) notices.set(result.scope, result.error);
            publishServer(result.server);
          },
        },
      );
      if (!isCurrent()) return;
      threadProjection.current.retainScopes([...records.values()].flat().map(scope => scope.scope));
      for (const server of servers) publishServer(server, true);
      const retainedTargets = new Set(servers.map(server => server.id));
      for (const id of Object.keys(scopeNotices.current)) if (!retainedTargets.has(id)) delete scopeNotices.current[id];

    } catch (value) {
      if (isCurrent()) setThreadErrorEntries(current => isCurrent() ? { ...current, ...Object.fromEntries(servers.map(server => [server.id,
        { owner: threadListReadOwner(profile, server, { archived: false }), value: value instanceof Error ? value.message : String(value) }])) } : current);
    } finally {
      for (const connection of ownedDefaultReads) connection.close();
      if (threadLoadAbort.current === controller) threadLoadAbort.current = null;
      if (generation === threadLoadGeneration.current && operationOwner === readOwnerRef.current) setLoadingThreads(current => generation === threadLoadGeneration.current && operationOwner === readOwnerRef.current ? false : current);
    }
  };

  useEffect(() => {
    threadLoadGeneration.current += 1;
    setThreads(demo ? DEMO_THREADS : {});
    setWorkspaceOptionEntries({});
    workspaceOptionsRef.current = {};
    rowOwners.current = {};
    scopeNotices.current = {};
    setThreadErrorEntries({});
    setWorkspaceErrorEntries({});
    setLoadingThreads(false);
  }, [profileReadOwner, demo]);

  useEffect(() => {
    if (!runtime.loading && runtime.servers.length > 0 && isFocused) void loadAllThreads();
    else if (!runtime.loading) {
      setLoadingThreads(false);
      if (runtime.servers.length === 0) { setThreads(demo ? DEMO_THREADS : {}); setThreadErrorEntries({}); setWorkspaceErrorEntries({}); setWorkspaceOptionEntries({}); rowOwners.current = {}; scopeNotices.current = {}; workspaceOptionsRef.current = {}; threadProjection.current.retainScopes([]); }
    }
    return () => { threadLoadGeneration.current += 1; threadLoadAbort.current?.abort(); threadLoadAbort.current = null; };
  }, [profileReadOwner, isFocused, runtime.loading, JSON.stringify(runtime.servers), threadReloadRevision]);

  useEffect(() => {
    if (demo || !activeProfile) return;
    const profile = activeProfile;
    const mutationOwner = readOwner;
    return subscribeThreadMutations((event) => {
      if (mutationOwner !== readOwnerRef.current) return;
      const server = runtime.servers.find((candidate) => candidate.id === event.serverId);
      if (!server) return;
      const entry = workspaceOptionsRef.current[threadListScopeKey(profile, server)];
      const options = entry?.owner === threadListReadOwner(profile, server, { archived: false }) ? entry.value : workspaceOptions[server.id] ?? [];
      const scopes = threadMutationWorkspaceServers(
        threadProjection.current,
        profile,
        server,
        options,
        { archived: false },
        event,
      );
      if (scopes.length === 0) return;
      for (const scope of scopes)
        acknowledgeThreadMutationAtWorkspace(
          threadProjection.current,
          profile,
          server,
          scope.workspacePath,
          event.cwd,
          { archived: false },
          event.threadId,
          event.mutation,
        );
      const revision = threadProjection.current.revision;
      setThreads(current => {
        if (mutationOwner !== readOwnerRef.current || revision !== threadProjection.current.revision) return current;
        rowOwners.current[server.id] = threadListReadOwner(profile, server, { archived: false });
        const candidates = [...workspaceThreadScopeServers(server, options), ...scopes];
        const byScope = new Map(candidates.map(workspaceServer => [threadListScopeKey(profile, workspaceServer, { archived: false }), workspaceServer]));
        const rows = [...byScope].flatMap(([scope, workspaceServer]) => (threadProjection.current.get(scope)?.threads ?? [])
          .map(thread => ({ serverId: server.id, workspacePath: workspaceServer.workspacePath, scope, thread })));
        return { ...current, [server.id]: orderThreadScopeRows(rows).map(row => row.thread) };
      });
      setThreadReloadRevision((value) => value + 1);
    });
  }, [readOwner, demo, runtime.servers, workspaceOptions]);

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
    return <View style={[styles.root, styles.center, { paddingTop: insets.top }]}><EmptyState icon={<Server size={42} color={colors.textDim} />} title={t("home.deleted_gateway_title")} body={t("home.deleted_gateway_body")} /><Pressable onPress={() => router.replace("/settings")} style={styles.recoveryButton}><Text style={styles.recoveryButtonText}>{t("home.open_settings")}</Text></Pressable></View>;
  }
  if (!hydrated || !activeProfile || activeProfile.id !== profileId) return <View style={[styles.root, styles.center]}><ActivityIndicator color={colors.text} /></View>;
  const scopedThreads = demo ? threads : Object.fromEntries(runtime.servers.map(server => [server.id,
    rowOwners.current[server.id] === threadListReadOwner(activeProfile, server, { archived: false }) ? threads[server.id] ?? [] : []]));

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityLabel={t("task.task_navigation")} onPress={() => setDrawerOpen(true)} style={styles.iconButton}><Menu size={20} color={colors.textMuted} /></Pressable>
        <View style={styles.headerTitle}><Text style={styles.title}>{t("home.conversations")}</Text></View>
        <Pressable testID="sessions" accessibilityLabel={t("home.search_history")} onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } })} style={styles.iconButton}><History size={18} color={colors.textMuted} /></Pressable>
      </View>
      <ScrollView
        refreshControl={<RefreshControl refreshing={runtime.loading || loadingThreads} onRefresh={() => void reload()} tintColor={colors.text} />}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 76 }]}
      >
        {runtime.error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{runtime.error}</Text><Pressable testID={runtime.reauthorizationRequired ? "reauthorize-active-profile" : "retry-gateway"} onPress={() => runtime.reauthorizationRequired ? router.push({ pathname: "/welcome", params: { gateway: activeProfile.baseUrl, reauth: activeProfile.id } }) : void refresh()}><Text style={styles.retry}>{runtime.reauthorizationRequired ? t("home.reauthorize") : t("home.retry")}</Text></Pressable></View> : null}
        {runtime.statusRefreshing ? <Text testID="server-status-refreshing" style={styles.errorText}>{t("home.status_refreshing")}</Text> : null}
        {runtime.statusError && !runtime.reauthorizationRequired ? <Text accessibilityRole="alert" testID="server-status-error" style={styles.errorText}>{t("home.status_error", { p0: runtime.statusError })}{runtime.statusesUpdatedAt ? ` ${t("home.last_checked_at", { p0: new Date(runtime.statusesUpdatedAt).toLocaleTimeString(locale) })}` : ""}</Text> : null}
        {runtime.loading && runtime.servers.length === 0 ? <ActivityIndicator style={styles.loader} color={colors.text} /> : null}
        {runtime.servers.length === 0 && !runtime.loading ? <EmptyState icon={<Server size={42} color={colors.textDim} />} title={t("home.no_servers")} body={t("home.no_servers_body")} /> : null}
        {runtime.servers.map((server) => {
          const status = statusById.get(server.id)?.status ?? "checking";
          const serverThreads = scopedThreads[server.id] ?? [];
          const workspaceGroups = groupThreadsByWorkspace(serverThreads, workspaceOptions[server.id] ?? [], server.workspacePath);
          return (
            <View key={server.id} style={styles.serverSection}>
              <View style={styles.serverHeader}>
                <View style={styles.serverIcon}>{server.transport === "ssh" ? <Server size={15} color={colors.text} /> : <Laptop size={15} color={colors.text} />}</View>
                <View style={styles.serverCopy}><View style={styles.serverTitleRow}><Text style={styles.serverTitle}>{server.label}</Text><StatusDot status={status} /></View></View>
                <Pressable testID={`new-workspace-${server.id}`} accessibilityLabel={t("task.new_task_on", { p0: server.label })} onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile.id, serverId: server.id } })} style={styles.sectionAction}><Plus size={17} color={colors.textMuted} /></Pressable>
              </View>
              {threadErrors[server.id] ? <Text accessibilityRole="alert" style={styles.inlineError}>{threadErrors[server.id]}</Text> : null}
              {workspaceErrors[server.id] ? <Text accessibilityRole="alert" style={styles.inlineError}>{t("home.workspace_list_error", { p0: workspaceErrors[server.id] })}</Text> : null}
              {workspaceGroups.map((group, groupIndex) => {
                const sectionKey = `${server.id}\0${group.path}`;
                const collapsed = collapsedServerIds.has(sectionKey);
                const threadsExpanded = expandedServerIds.has(sectionKey);
                const hiddenThreads = hiddenThreadCount(group.threads, threadsExpanded);
                return <View key={sectionKey}>
                  <Pressable
                    testID={groupIndex === 0 ? `toggle-server-${server.id}` : `toggle-workspace-${server.id}-${groupIndex}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${t(collapsed ? "task.expand" : "task.collapse")} ${group.label}`}
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
                  {!demo ? <Pressable testID={`refresh-history-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={t("home.refresh_history_for", { p0: server.label, p1: group.path })} onPress={() => setHistoryRefreshTarget({ profile: activeProfile, server, workspace: group.path })} style={styles.historyRefreshAction}><Text style={styles.retry}>{t("home.refresh_history_index")}</Text></Pressable> : null}
                  {!collapsed && group.threads.length === 0 && !loadingThreads ? <Pressable onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile.id, serverId: server.id, cwd: group.path } })} style={styles.emptyThread}><Plus size={14} color={colors.textMuted} /><Text style={styles.emptyThreadText}>{t("task.new_task_in_this_project")}</Text></Pressable> : null}
                  {!collapsed && projectVisibleThreads(group.threads, threadsExpanded).map((thread) => (
                    <Pressable testID={`thread-${thread.id}`} key={thread.id} onPress={() => router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id, threadId: thread.id, cwd: thread.cwd?.trim() || group.path, title: thread.title || t("task.untitled_task") } })} style={({ pressed }) => [styles.thread, pressed && styles.threadPressed]}>
                      <GitBranch size={14} color={colors.textDim} />
                      <View style={styles.threadCopy}><Text style={styles.threadTitle} numberOfLines={1}>{thread.title || t("task.untitled_task")}</Text><View style={styles.threadMetaRow}><Text style={styles.threadMeta}>{relativeTime(thread.updatedAt)}</Text>{thread.status !== "idle" ? <Text style={[styles.state, thread.status === "failed" && styles.failed]}>{thread.status === "running" ? t("task.running") : thread.status === "waiting_for_approval" ? t("task.waiting_for_approval") : thread.status === "waiting_for_answer" ? t("task.waiting_for_answer") : t("task.failed")}</Text> : null}</View></View>
                      <ChevronRight size={16} color={colors.textDim} />
                    </Pressable>
                  ))}
                  {!collapsed && group.threads.length > 8 ? <Pressable testID={`toggle-more-threads-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={threadsExpanded ? t("task.collapse_sessions") : t("task.show_more_sessions", { p0: hiddenThreads })} aria-expanded={threadsExpanded} accessibilityState={{ expanded: threadsExpanded }} onPress={() => toggleServerThreadsExpanded(sectionKey)} style={({ pressed }) => [styles.moreThreads, pressed && styles.threadPressed]}>{threadsExpanded ? <ChevronUp size={14} color={colors.textDim} /> : <ChevronDown size={14} color={colors.textDim} />}<Text style={styles.moreThreadsText}>{threadsExpanded ? t("task.collapse") : t("task.show_more", { p0: hiddenThreads })}</Text></Pressable> : null}
                </View>;
              })}
            </View>
          );
        })}
      </ScrollView>
      <View style={[styles.hostDock, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <View style={styles.hostDockCopy}><StatusDot status={runtime.error ? "offline" : runtime.loading ? "checking" : "online"} /><View><Text style={styles.hostDockTitle}>{activeProfile.label}</Text><Text style={styles.hostDockMeta}>{activeProfile.baseUrl.replace(/^https?:\/\//, "")}</Text></View></View>
        <Pressable testID="new-workspace" accessibilityLabel={t("task.new_task")} onPress={() => router.push({ pathname: "/new", params: { profileId: activeProfile.id } })} style={styles.iconButton}><Plus size={21} color={colors.textMuted} /></Pressable>
        <Pressable accessibilityLabel={t("common.settings")} onPress={() => router.push("/settings")} style={styles.iconButton}><Settings size={20} color={colors.textMuted} /></Pressable>
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
          if (!demo) return;
          const server = runtime.servers.find((item) => item.id === serverId);
          if (server) acknowledgeWorkspaceThreadMutation(
            threadProjection.current,
            activeProfile,
            server,
            workspaceOptions[serverId] ?? [],
            { kind: "rename", thread },
          );
          setThreads((current) => ({ ...current, [serverId]: (current[serverId] ?? []).map((candidate) => candidate.id === thread.id ? thread : candidate) }));
          setThreadReloadRevision((value) => value + 1);
        }}
        onThreadRemoved={(serverId, threadId) => {
          if (!demo) return;
          const server = runtime.servers.find((item) => item.id === serverId);
          if (server) acknowledgeWorkspaceThreadMutation(
            threadProjection.current,
            activeProfile,
            server,
            workspaceOptions[serverId] ?? [],
            { kind: "remove", threadId },
          );
          setThreads((current) => ({ ...current, [serverId]: (current[serverId] ?? []).filter((thread) => thread.id !== threadId) }));
          setThreadReloadRevision((value) => value + 1);
        }}
      />
      {historyRefreshTarget && isFocused && historyRefreshTarget.profile === activeProfile && profileId === activeProfile.id ? <HistoryRefreshModal target={historyRefreshTarget} onClose={() => setHistoryRefreshTarget(null)} onReady={() => { void reload(); }} /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  header: { height: 56, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  headerTitle: { flex: 1, paddingLeft: spacing.sm },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  content: { paddingHorizontal: spacing.md, paddingVertical: spacing.lg, gap: spacing.xl },
  errorBanner: { flexDirection: "row", justifyContent: "space-between", padding: spacing.md, backgroundColor: colors.surfaceRaised, borderRadius: radius.md },
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
