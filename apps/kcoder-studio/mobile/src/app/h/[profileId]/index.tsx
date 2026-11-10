import { useInterfaceVersion } from "@/storage/interface-version";
import { classicHomeStyles } from "@/features/interface/classic-styles";
import { v3HomeStyles } from "@/features/interface/v3-library-styles";
import { V3ConversationSelection, V3ConversationSelectionHeader, type V3ConversationTarget } from "@/features/interface/V3ConversationSelection";
import { v3ConversationSelectionStyles } from "@/features/interface/v3-conversation-selection-styles";
import { historyTime } from "@/components/history-presentation";
import { WorkspaceFolderBadge } from "@/components/workspace-folder-badge";
import { statusDotColor } from "@/components/status-dot-presentation";
import { rowActions } from "@/components/row-actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { ActivityIndicator, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronDown, ChevronRight, ChevronUp, Folder, Clock3, Inbox, Plus, Search, Server, Menu, MoreHorizontal, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, StatusDot } from "@/components/ui";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import { ThreadListPager, listWorkspaceThreadScopes, subscribeThreadMutations, type ThreadListPage, type WorkspaceOption } from "@/runtime/task-runtime";
import { acknowledgeThreadMutationAtWorkspace, acknowledgeWorkspaceThreadMutation, threadMutationWorkspaceServers, ThreadListProjection, threadListScopeKey, threadListNotice, threadListReadOwner, orderThreadScopeRows } from "@/runtime/thread-list-projection";
import { mapThreadListDependencies } from "@/runtime/task-runtime/threadDirectory";
import { workspaceThreadScopeIdentity, workspaceThreadScopeServers, type WorkspaceDefaultReadConnection } from "@/runtime/task-runtime/workspaces";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { timestampMs } from "@/protocol/normalizers";
import { MobileDrawer } from "@/components/mobile-drawer";
import { ThreadActionsSheet, type ThreadActionTarget } from "@/components/thread-actions-sheet";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { interactionServerIdentity } from "@/runtime/task-runtime/threadDirectory";
import { groupThreadsByProject, hiddenThreadCount, projectVisibleThreads, threadActivityPresentation, workspaceSectionCollapseKey, workspaceTargetPresentations, type ProjectWorkspaceThreadGroup, type ProjectThreadGroup } from "@/components/thread-list-presentation";
import { WorkspaceHistoryActionsSheet } from "@/components/workspace-history-actions-sheet";
import { connectionStatusLabel, selectMobileConnectionStatusProps } from "@/components/connection-status-presentation";
import { useCollapsedServerSections } from "@/storage/use-collapsed-server-sections";
import { setRuntimeProjectPinned } from "@/runtime/task-runtime/project-pins";
import { renameRuntimeProject } from "@/runtime/task-runtime/project-rename";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { HistoryRefreshModal, type HistoryRefreshTarget } from "@/components/history-refresh-modal";
import { t } from "@/i18n";
import { gatewayErrorMessage } from "@/components/gateway-error-presentation";
import { useLocale } from "@/i18n/use-locale";
import { claimWorkspaceAbsenceHandoff, forwardWorkspaceAbsenceHandoff, peekWorkspaceAbsenceHandoff, revokeWorkspaceAbsenceHandoff, workspaceAbsenceHandoffServerId, type WorkspaceAbsenceHandoffOwner } from "@/navigation/workspace-absence-handoff";

export { WorkspaceHistoryActionsSheet } from "@/components/workspace-history-actions-sheet";

interface OwnedValue<T> { owner: string; value: T }
interface WorkspaceMenuTarget { profile: GatewayProfile; server: KCoderServer; owner: string; workspace: string; workspaceIdentity: string; workspaceLabel: string; workspaceAccessibleName: string; targetLabel: string; groupIndex: number }
interface HomeThreadActionTarget extends ThreadActionTarget { profile: GatewayProfile; owner: string; interaction: object; isCurrent(): boolean }

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
  const interfaceVersion = useInterfaceVersion();
  const classic = interfaceVersion === "classic";
  const v3 = interfaceVersion === "v3";
  const styles = useThemedStyles(useCallback((colors: ThemeColors) => classic ? makeClassicStyles(colors) : v3 ? { ...makeStyles(colors), ...v3HomeStyles(colors) } : makeStyles(colors), [classic, v3]));
  const selectionStyles = useThemedStyles(v3ConversationSelectionStyles);
  const { profileId, notice, workspaceAbsenceHandoff } = useLocalSearchParams<{ profileId: string; notice?: string; workspaceAbsenceHandoff?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, activeProfile, profiles, runtime, demo, refresh, setActiveProfile,
    profileHydrationError, profileHydrationRetrying, retryStoredProfiles } = useApp();
  const profileSaved = profiles.some((item) => item.id === profileId);
  const invalidProfile = !profileSaved && (hydrated || Boolean(profileHydrationError));
  const recoveryProfileIdRef = useRef(profileId);
  const recoveryFocusedRef = useRef(isFocused);
  const recoveryRetryIntentRef = useRef(0);
  const recoveryRetryPendingRef = useRef(false);
  recoveryFocusedRef.current = isFocused;
  if (recoveryProfileIdRef.current !== profileId) {
    recoveryProfileIdRef.current = profileId;
    recoveryRetryIntentRef.current += 1;
    recoveryRetryPendingRef.current = false;
  }
  useEffect(() => () => {
    recoveryRetryIntentRef.current += 1;
    recoveryRetryPendingRef.current = false;
  }, [profileId, isFocused]);
  const retryProfileRecovery = async () => {
    if (!profileHydrationError || profileHydrationRetrying || recoveryRetryPendingRef.current || !isFocused) return;
    recoveryRetryPendingRef.current = true;
    const intent = ++recoveryRetryIntentRef.current;
    const ownerProfileId = profileId;
    try {
      await retryStoredProfiles();
      // Hydration republishes the saved profile registry; the current route ID
      // remains authoritative and its existing activation effect handles a match.
    } catch {
      // AppContext records the local hydration failure for the recovery UI.
    } finally {
      if (recoveryRetryIntentRef.current === intent && recoveryProfileIdRef.current === ownerProfileId && recoveryFocusedRef.current) {
        recoveryRetryPendingRef.current = false;
      }
    }
  };
  const [threads, setThreads] = useState<Record<string, ThreadSummary[]>>(demo ? DEMO_THREADS : {});
  const [workspaceOptionEntries, setWorkspaceOptionEntries] = useState<Record<string, OwnedValue<WorkspaceOption[]>>>({});
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadErrorEntries, setThreadErrorEntries] = useState<Record<string, OwnedValue<string>>>({});
  const [workspaceErrorEntries, setWorkspaceErrorEntries] = useState<Record<string, OwnedValue<string>>>({});
  const [inboxRevision, setInboxRevision] = useState(0);
  useEffect(() => taskRuntimeRegistry.subscribe(() => setInboxRevision(value => value + 1)), []);
  const pendingCount = useMemo(() => activeProfile ? taskRuntimeRegistry.interactionInboxRows(profileAuthorizationScopeKey(activeProfile)).filter(row => row.liveActionable && runtime.servers.some(server => server.id === row.serverId && interactionServerIdentity(server) === row.serverConfigIdentity)).length : 0, [activeProfile, runtime.servers, inboxRevision]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyRefreshTarget, setHistoryRefreshTarget] = useState<HistoryRefreshTarget | null>(null);
  const [workspaceMenuTarget, setWorkspaceMenuTarget] = useState<WorkspaceMenuTarget | null>(null);
  const [threadActionTarget, setThreadActionTarget] = useState<HomeThreadActionTarget | null>(null);
  const [threadReloadRevision, setThreadReloadRevision] = useState(0);
  const threadLoadGeneration = useRef(0);
  const projectPinRevisions = useRef<Record<string, number>>({});
  const threadLoadAbort = useRef<AbortController | null>(null);
  const [pagination, setPagination] = useState<{ owner: string; servers: Record<string, { hasMore: boolean; completeWorkspaces: string[] }> }>({ owner: "", servers: {} });
  const profileReadOwner = JSON.stringify([profileId, activeProfile?.id, activeProfile?.baseUrl, activeProfile?.authorizationGeneration, activeProfile?.deviceId]);
  const readOwner = JSON.stringify([profileReadOwner, demo, isFocused, runtime.servers.map(server => [activeProfile ? threadListScopeKey(activeProfile, server) : server.id, server.workspacePath === undefined ? ["undefined"] : ["path", server.workspacePath]])]);
  const readOwnerRef = useRef(readOwner);
  readOwnerRef.current = readOwner;
  const historyNavigationAllowed = !invalidProfile && hydrated && activeProfile?.id === profileId && isFocused && runtime.serversReady && !runtime.reauthorizationRequired;
  const historyNavigationOwner = JSON.stringify([readOwner, historyNavigationAllowed]);
  const historyNavigationOwnerRef = useRef(historyNavigationOwner); historyNavigationOwnerRef.current = historyNavigationOwner;
  const handoffServers = runtime.servers.filter(server => server.id === workspaceAbsenceHandoffServerId(workspaceAbsenceHandoff));
  const handoffServer = handoffServers.length === 1 ? handoffServers[0] : undefined;
  const handoffOwnerKey = JSON.stringify([workspaceAbsenceHandoff, profileReadOwner, demo, isFocused, runtime.reauthorizationRequired,
    activeProfile && handoffServer ? threadListReadOwner(activeProfile, handoffServer) : null, handoffServer?.observationTargetIdentity]);
  const handoffMounted = useRef(true);
  const handoffOwnerRef = useRef<{ key: string; token?: string; owner: WorkspaceAbsenceHandoffOwner } | null>(null);
  if (handoffOwnerRef.current?.key !== handoffOwnerKey) {
    const owner: WorkspaceAbsenceHandoffOwner = { isCurrent: () => handoffMounted.current && handoffOwnerRef.current?.owner === owner };
    handoffOwnerRef.current = { key: handoffOwnerKey, token: workspaceAbsenceHandoff, owner };
  }
  const handoffOwner = handoffOwnerRef.current.owner;
  useEffect(() => { handoffMounted.current = true; return () => { handoffMounted.current = false; }; }, []);
  useEffect(() => {
    if (demo || invalidProfile || (hydrated && activeProfile?.id !== profileId)) revokeWorkspaceAbsenceHandoff(workspaceAbsenceHandoff);
    else if (historyNavigationAllowed && activeProfile && handoffServer)
      claimWorkspaceAbsenceHandoff(workspaceAbsenceHandoff, "home", handoffOwner, activeProfile, handoffServer);
  }, [handoffOwner, historyNavigationAllowed, activeProfile, handoffServer, demo, invalidProfile, hydrated, profileId, workspaceAbsenceHandoff]);
  const absenceHandoff = historyNavigationAllowed && !demo && activeProfile && handoffServer
    ? peekWorkspaceAbsenceHandoff(workspaceAbsenceHandoff, "home", handoffOwner, activeProfile, handoffServer) : null;
  const openNewWorkspace = (selectedServerId?: string, explicitCwd?: string) => {
    if (!activeProfile || !handoffOwner.isCurrent()) return;
    const canForward = !explicitCwd && absenceHandoff && handoffServer && historyNavigationAllowed && handoffOwner.isCurrent() &&
      (!selectedServerId || selectedServerId === handoffServer.id);
    const token = canForward ? forwardWorkspaceAbsenceHandoff(workspaceAbsenceHandoff, handoffOwner, activeProfile, handoffServer) : undefined;
    if (!token) revokeWorkspaceAbsenceHandoff(workspaceAbsenceHandoff, handoffOwner);
    router.push({ pathname: "/new", params: { profileId: activeProfile.id,
      ...(selectedServerId || token ? { serverId: selectedServerId ?? handoffServer!.id } : {}),
      ...(explicitCwd ? { cwd: explicitCwd } : {}), ...(token ? { workspaceAbsenceHandoff: token } : {}) } });
  };
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
    setHistoryRefreshTarget((target) => target && historyNavigationAllowed && target.profile === activeProfile && target.owner === readOwner &&
      runtime.servers.some((server) => JSON.stringify(server) === JSON.stringify(target.server)) ? target : null);
    setWorkspaceMenuTarget((target) => target && historyNavigationAllowed && target.profile === activeProfile && target.owner === readOwner &&
      runtime.servers.some((server) => JSON.stringify(server) === JSON.stringify(target.server)) ? target : null);
  }, [activeProfile, historyNavigationAllowed, readOwner, runtime.servers]);

  useEffect(() => {
    if (shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) {
      void setActiveProfile(profileId);
    }
  }, [activeProfile?.id, hydrated, isFocused, profileId, profiles, setActiveProfile]);

  const connectionStatusProps = selectMobileConnectionStatusProps(runtime);
  const pinStatusRef = useRef(connectionStatusProps.serverStatuses);
  pinStatusRef.current = connectionStatusProps.serverStatuses;

  const loadAllThreads = async () => {
    const generation = ++threadLoadGeneration.current;
    threadLoadAbort.current?.abort();
    threadLoadAbort.current = null;
    if (demo || !activeProfile || !historyNavigationAllowed || runtime.servers.length === 0) {
      setLoadingThreads(false);
      return;
    }
    const controller = new AbortController();
    threadLoadAbort.current = controller;
    const unclaimedDefaultReads = new Set<WorkspaceDefaultReadConnection>();
    const operationOwner = readOwner;
    const mutationRevision = threadProjection.current.revision;
    const pinRevisions = { ...projectPinRevisions.current };
    const profile = activeProfile;
    const servers = [...runtime.servers];
    const targetOwner = () => JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId, servers.map(server => [threadListScopeKey(profile, server), server.workspacePath === undefined ? ["undefined"] : ["path", server.workspacePath]])]);
    const originalTargetOwner = targetOwner();
    const isCurrent = () => historyNavigationOwner === historyNavigationOwnerRef.current && originalTargetOwner === targetOwner() && !controller.signal.aborted && operationOwner === readOwnerRef.current && generation === threadLoadGeneration.current && mutationRevision === threadProjection.current.revision;
    const scopeRecordsFor = ({ server, resolved }: { server: (typeof servers)[number]; cacheKey: string; resolved: Awaited<ReturnType<typeof listWorkspaceThreadScopes>> }) =>
      resolved.servers.map((workspaceServer) => ({
        server,
        workspaceServer,
        scope: threadListScopeKey(profile, workspaceServer, { archived: false }),
        defaultRead: workspaceServer.workspacePath === server.workspacePath ? resolved.defaultRead : undefined,
      }));
    type ScopeRecord = ReturnType<typeof scopeRecordsFor>[number];
    const records = new Map<string, ScopeRecord[]>();
    type ScopePageResult = ScopeRecord & { page?: ThreadListPage; error: string | null };
    const activePagers = new Set<ThreadListPager>();
    const scopesWithNextPage = new Set<string>();
    const completeScopes = new Set<string>();
    setPagination({ owner: operationOwner, servers: {} });
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
      setPagination(previous => isCurrent() ? {
        owner: operationOwner,
        servers: { ...(previous.owner === operationOwner ? previous.servers : {}), [server.id]: {
          hasMore: scopes.some(scope => scopesWithNextPage.has(scope.scope)),
          completeWorkspaces: scopes.filter(scope => scope.workspaceServer.workspacePath !== undefined && completeScopes.has(scope.scope))
            .map(scope => workspaceThreadScopeIdentity(scope.workspaceServer.workspacePath)),
        } },
      } : previous);
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
      const notice = page.completeness === "partial" ? threadListNotice(page) : null;
      if (notice) notices.set(scope.scope, notice); else notices.delete(scope.scope);
      publishServer(scope.server);
    };
    const readScope = async (scope: ScopeRecord): Promise<ScopePageResult> => {
      if (!isCurrent()) return { ...scope, error: "会话列表读取已取消" };
      let pager: ThreadListPager | undefined;
      try {
        if (scope.defaultRead) {
          const client = scope.defaultRead.claim(profile, scope.workspaceServer, isCurrent);
          pager = new ThreadListPager(profile, scope.workspaceServer, { archived: false }, "foreground",
            { isCurrent, signal: controller.signal, client, releaseClient: () => scope.defaultRead!.close() });
          unclaimedDefaultReads.delete(scope.defaultRead);
        } else {
          pager = new ThreadListPager(profile, scope.workspaceServer, { archived: false }, "foreground",
            { isCurrent, signal: controller.signal });
        }
        activePagers.add(pager);
        const page = await pager.page(undefined, 100);
        if (!isCurrent()) return { ...scope, error: "会话列表读取已取消" };
        if (page.nextCursor) scopesWithNextPage.add(scope.scope); else scopesWithNextPage.delete(scope.scope);
        if (!page.nextCursor && page.completeness === "complete") completeScopes.add(scope.scope);
        publishPage(scope, page);
        return { ...scope, page, error: null };
      } catch (value) {
        const error = value instanceof Error ? value.message : String(value);
        if (isCurrent()) { scopesWithNextPage.delete(scope.scope); notices.set(scope.scope, error); publishServer(scope.server); }
        return { ...scope, error };
      } finally {
        // Home keeps only a preview. Connection-local cursors belong to a fresh
        // scan in Sessions, never to a replacement connection on this screen.
        pager?.close();
        if (pager) activePagers.delete(pager);
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
            onOwned: connection => { unclaimedDefaultReads.add(connection); },
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
            const pinMetadataCurrent = () => (pinRevisions[cacheKey] ?? 0) === (projectPinRevisions.current[cacheKey] ?? 0);
            if (pinMetadataCurrent()) workspaceOptionsRef.current[cacheKey] = { owner, value: resolved.options };
            setWorkspaceOptionEntries(current => isCurrent() && pinMetadataCurrent() ? { ...current, [server.id]: { owner, value: resolved.options } } : current);
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
      for (const connection of unclaimedDefaultReads) connection.close();
      for (const pager of activePagers) pager.close();
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
    setPagination({ owner: "", servers: {} });
  }, [profileReadOwner, demo]);

  useEffect(() => {
    if (!runtime.loading && runtime.servers.length > 0 && isFocused && historyNavigationAllowed) void loadAllThreads();
    else if (!runtime.loading) {
      setLoadingThreads(false);
      if (runtime.servers.length === 0) { setThreads(demo ? DEMO_THREADS : {}); setThreadErrorEntries({}); setWorkspaceErrorEntries({}); setWorkspaceOptionEntries({}); rowOwners.current = {}; scopeNotices.current = {}; workspaceOptionsRef.current = {}; threadProjection.current.retainScopes([]); }
    }
    return () => { threadLoadGeneration.current += 1; threadLoadAbort.current?.abort(); threadLoadAbort.current = null; };
  }, [profileReadOwner, isFocused, historyNavigationAllowed, runtime.loading, JSON.stringify(runtime.servers), runtime.serversRevision, threadReloadRevision]);

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
    if (!historyNavigationAllowed || historyNavigationOwner !== historyNavigationOwnerRef.current) return;
    await refresh();
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
    const recoveryFailed = Boolean(profileHydrationError);
    const recoveryInProgress = profileHydrationRetrying && !recoveryFailed;
    return <View style={[styles.root, styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <EmptyState
        icon={<Server size={42} color={colors.textDim} />}
        title={recoveryFailed ? t("home.gateway_recovery_failed_title") : recoveryInProgress ? t("welcome.loading_local_connection_config") : t("home.missing_gateway_title")}
        body={recoveryFailed ? t("home.gateway_recovery_failed_body") : recoveryInProgress ? "" : t("home.missing_gateway_body")}
      />
      {profileHydrationError ? <Text testID="missing-profile-hydration-error" accessibilityRole="alert" style={styles.recoveryError}>{profileHydrationError}</Text> : null}
      {recoveryInProgress ? <ActivityIndicator testID="missing-profile-hydration-spinner" color={colors.text} /> : null}
      {profileHydrationError || profileHydrationRetrying ? <Pressable
        testID="retry-profile-hydration"
        accessibilityRole="button"
        accessibilityState={{ disabled: profileHydrationRetrying }}
        disabled={profileHydrationRetrying}
        onPress={() => void retryProfileRecovery()}
        style={({ pressed }) => [styles.recoveryButton, pressed && !profileHydrationRetrying && styles.recoveryPressed]}
      ><Text style={styles.recoveryButtonText}>{profileHydrationRetrying ? t("task.recovering") : t("home.retry_gateway_recovery")}</Text></Pressable> : null}
      <View style={styles.recoveryActions}>
        <Pressable
          testID="missing-profile-pair-gateway"
          accessibilityRole="button"
          onPress={() => router.push({ pathname: "/welcome", params: { connectMode: "pairing" } })}
          style={({ pressed }) => [styles.recoveryButton, pressed && styles.recoveryPressed]}
        ><Text style={styles.recoveryButtonText}>{t("home.pair_gateway")}</Text></Pressable>
        <Pressable
          testID="missing-profile-manual-connection"
          accessibilityRole="button"
          onPress={() => router.push({ pathname: "/welcome", params: { connectMode: "direct" } })}
          style={({ pressed }) => [styles.recoveryButton, pressed && styles.recoveryPressed]}
        ><Text style={styles.recoveryButtonText}>{t("home.manual_gateway")}</Text></Pressable>
      </View>
      <Pressable
        testID="missing-profile-settings"
        accessibilityRole="button"
        onPress={() => router.push("/settings-connections")}
        style={({ pressed }) => [styles.recoveryButton, pressed && styles.recoveryPressed]}
      ><Text style={styles.recoveryButtonText}>{t("home.open_settings")}</Text></Pressable>
    </View>;
  }
  if (!hydrated || !activeProfile || activeProfile.id !== profileId) return <View style={[styles.root, styles.center]}><ActivityIndicator color={colors.text} /></View>;
  const scopedThreads = demo ? threads : Object.fromEntries(runtime.servers.map(server => [server.id,
    rowOwners.current[server.id] === threadListReadOwner(activeProfile, server, { archived: false }) ? threads[server.id] ?? [] : []]));
  const visibleThreadActionTarget = threadActionTarget && historyNavigationAllowed &&
    threadActionTarget.profile === activeProfile && threadActionTarget.owner === readOwner && threadActionTarget.isCurrent()
    ? threadActionTarget : null;
  const onThreadRenamed = (serverId: string, thread: ThreadSummary) => {
    if (!demo) return;
    const server = runtime.servers.find((item) => item.id === serverId);
    if (server) acknowledgeWorkspaceThreadMutation(threadProjection.current, activeProfile, server,
      workspaceOptions[serverId] ?? [], { kind: "rename", thread });
    setThreads((current) => ({ ...current, [serverId]: (current[serverId] ?? []).map((candidate) => candidate.id === thread.id ? thread : candidate) }));
    setThreadReloadRevision((value) => value + 1);
  };
  const onThreadRemoved = (serverId: string, threadId: string) => {
    if (!demo) return;
    const server = runtime.servers.find((item) => item.id === serverId);
    if (server) acknowledgeWorkspaceThreadMutation(threadProjection.current, activeProfile, server,
      workspaceOptions[serverId] ?? [], { kind: "remove", threadId });
    setThreads((current) => ({ ...current, [serverId]: (current[serverId] ?? []).filter((thread) => thread.id !== threadId) }));
    setThreadReloadRevision((value) => value + 1);
  };
  const menuServer = workspaceMenuTarget && !demo && historyNavigationAllowed &&
    workspaceMenuTarget.profile === activeProfile && workspaceMenuTarget.owner === readOwner
    ? runtime.servers.find((server) => JSON.stringify(server) === JSON.stringify(workspaceMenuTarget.server))
    : undefined;
  const menuServerProjects = menuServer
    ? groupThreadsByProject(activeProfile, menuServer, scopedThreads[menuServer.id] ?? [], workspaceOptions[menuServer.id] ?? [])
    : [];
  const menuProject = menuServerProjects.find(project => project.workspaces.some(group => group.identity === workspaceMenuTarget?.workspaceIdentity));
  const menuServerWorkspaces = menuServerProjects.flatMap((project) => project.workspaces);
  const visibleWorkspaceMenuGroup = workspaceMenuTarget
    ? menuServerWorkspaces.find((group) => group.identity === workspaceMenuTarget.workspaceIdentity)
    : undefined;
  const visibleWorkspaceMenuTarget = menuServer && visibleWorkspaceMenuGroup?.path ? menuServer : undefined;
  const refreshTargetServer = historyRefreshTarget
    ? runtime.servers.find((server) => JSON.stringify(server) === JSON.stringify(historyRefreshTarget.server))
    : undefined;
  const refreshTargetPaths = refreshTargetServer
    ? groupThreadsByProject(activeProfile, refreshTargetServer, scopedThreads[refreshTargetServer.id] ?? [], workspaceOptions[refreshTargetServer.id] ?? [])
      .flatMap((project) => project.workspaces.flatMap((group) => group.path ? [group.path] : []))
    : [];
  const historyRefreshTargetVisible = Boolean(historyRefreshTarget && isFocused && historyNavigationAllowed &&
    historyRefreshTarget.profile === activeProfile && historyRefreshTarget.owner === readOwner &&
    profileId === activeProfile.id && refreshTargetServer &&
    serverOwners[refreshTargetServer.id] === threadListReadOwner(activeProfile, refreshTargetServer, { archived: false }) &&
    historyRefreshTarget.kind === "workspace" &&
    refreshTargetPaths.some((path) => workspaceThreadScopeIdentity(path) === workspaceThreadScopeIdentity(historyRefreshTarget.workspace)));
  const visibleHistoryRefreshTarget = historyRefreshTargetVisible ? historyRefreshTarget : null;
  const targetPresentations = workspaceTargetPresentations(runtime.servers);
  const hasPinnedProjects = runtime.servers.some(server => groupThreadsByProject(activeProfile, server, scopedThreads[server.id] ?? [], workspaceOptions[server.id] ?? []).some(project => project.pinned));
  const canUseTarget = (server: KCoderServer) => historyNavigationAllowed && historyNavigationOwner === historyNavigationOwnerRef.current &&
    readOwner === readOwnerRef.current && runtime.servers.some(candidate => JSON.stringify(candidate) === JSON.stringify(server)) &&
    serverOwners[server.id] === threadListReadOwner(activeProfile, server, { archived: false });
  const selectionTargets: V3ConversationTarget[] = v3 ? runtime.servers.map(server => ({ server,
    projects: groupThreadsByProject(activeProfile, server, scopedThreads[server.id] ?? [], workspaceOptions[server.id] ?? []),
    enabled: canUseTarget(server), status: connectionStatusProps.serverStatuses[server.id] ?? "unknown",
    hasMore: pagination.owner === readOwner && Boolean(pagination.servers[server.id]?.hasMore),
  })) : [];
  const toggleProjectPin = async (server: KCoderServer, project: ProjectThreadGroup) => {
    const interactionOwner = handoffOwner;
    const isCurrent = () => interactionOwner.isCurrent() && readOwner === readOwnerRef.current && historyNavigationOwner === historyNavigationOwnerRef.current && canUseTarget(server);
    const canStart = () => pinStatusRef.current[server.id] === "online";
    if (demo || !canUseTarget(server) || !isCurrent() || !canStart() || project.pinSupported === false || (project.rootProject && project.pinSupported !== true)) return;
    const confirmation = await setRuntimeProjectPinned(activeProfile, server, { projectKey: project.projectKey, rootProject: project.rootProject }, project.pinned !== true, isCurrent, canStart);
    if (!isCurrent()) return;
    const cacheKey = threadListScopeKey(activeProfile, server);
    // Preserve unrelated directories while publishing only the confirmed project's sidebar state.
    const knownOptions = workspaceOptionsRef.current[cacheKey]?.value ?? workspaceOptions[server.id] ?? [];
    const options = knownOptions.map(option => option.projectKey === project.projectKey && (option.rootProject === true) === project.rootProject
      ? { ...option, projectPinned: confirmation.pinned, projectPinnedOrder: confirmation.pinnedOrder }
      : option);
    for (const confirmed of confirmation.workspaces.filter(option => option.projectKey === project.projectKey && (option.rootProject === true) === project.rootProject)) {
      if (!options.some(option => workspaceThreadScopeIdentity(option.path) === workspaceThreadScopeIdentity(confirmed.path))) options.push(confirmed);
    }
    const updated = { owner: serverOwners[server.id], value: options };
    projectPinRevisions.current[cacheKey] = (projectPinRevisions.current[cacheKey] ?? 0) + 1;
    workspaceOptionsRef.current = { ...workspaceOptionsRef.current, [cacheKey]: updated };
    setWorkspaceOptionEntries(current => isCurrent() ? { ...current, [server.id]: updated } : current);
  };
  const openSelectionProjectActions = (server: KCoderServer, group: ProjectWorkspaceThreadGroup, name: string) => {
    if (demo || !group.path || !canUseTarget(server)) return;
    const workspaces = selectionTargets.find(target => target.server === server)?.projects.flatMap(project => project.workspaces) ?? [];
    const groupIndex = workspaces.findIndex(workspace => workspace.identity === group.identity);
    if (groupIndex < 0) return;
    const target = targetPresentations.get(server.id)!;
    setWorkspaceMenuTarget({ profile: activeProfile, server, owner: readOwner, workspace: group.path, workspaceIdentity: group.identity,
      workspaceLabel: group.label, workspaceAccessibleName: `${name} · ${group.path} · ${target.accessible}`,
      targetLabel: target.display, groupIndex });
  };

  return (
    <View testID={`home-interface-${interfaceVersion}`} style={[styles.root, v3 && selectionStyles.root, { paddingTop: insets.top }, v3 && { paddingBottom: insets.bottom }]}>
      {v3 ? <V3ConversationSelectionHeader pendingCount={pendingCount}
        onSearch={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } })}
        onInbox={() => router.push({ pathname: "/h/[profileId]/inbox", params: { profileId: activeProfile.id } })}
        onSettings={() => router.push("/settings")} /> : <>
      {classic ? <>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("task.task_navigation")} onPress={() => setDrawerOpen(true)} style={styles.iconButton}><Menu size={20} color={colors.textMuted} /></Pressable>
        <View style={styles.headerTitle}><Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">{t("home.conversations")}</Text></View>
        <Pressable testID="interaction-inbox" accessibilityRole="button" accessibilityLabel={t("inbox.title")} onPress={() => router.push({ pathname: "/h/[profileId]/inbox", params: { profileId: activeProfile.id } })} style={styles.iconButton}><Inbox size={18} color={colors.textMuted} /></Pressable>
        <Pressable testID="sessions" accessibilityRole="button" accessibilityLabel={t("home.search_history")} onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } })} style={styles.iconButton}><Clock3 size={18} color={colors.textMuted} /></Pressable>
        <Pressable testID="new-workspace" accessibilityRole="button" accessibilityLabel={t("task.new_task")} onPress={() => openNewWorkspace()} style={styles.iconButton}><Plus size={18} color={colors.textMuted} /></Pressable>
      </View>
      </> : <>
      <View style={styles.header}>
        <Pressable testID="interaction-inbox" accessibilityRole="button" accessibilityLabel={t("inbox.title")}
          onPress={() => router.push({ pathname: "/h/[profileId]/inbox", params: { profileId: activeProfile.id } })}
          style={styles.inboxButton}><Inbox size={17} color={colors.blue} /><Text style={styles.inboxLabel}>{t("v2.pending")}</Text>{pendingCount > 0 ? <View style={styles.inboxBadge}><Text style={[styles.inboxCount, v3 && { color: "#FFFFFF" }]}>{pendingCount}</Text></View> : null}</Pressable>
        <View style={{ flex: 1 }} />
        <Pressable testID="home-search" accessibilityRole="button" accessibilityLabel={t("home.search_history")} onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } })} style={styles.iconButton}><Search size={20} color={colors.textMuted} /></Pressable>
        <Pressable testID="home-settings" accessibilityRole="button" accessibilityLabel={t("common.settings")} onPress={() => router.push("/settings")} style={styles.iconButton}><Settings size={20} color={colors.textMuted} /></Pressable>
        <Pressable testID="sessions" accessibilityRole="button" accessibilityLabel={t("v2.history")} onPress={() => router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } })} style={styles.iconButton}><Clock3 size={20} color={colors.textMuted} /></Pressable>
      </View>
      </>}
      </>}
      <ScrollView
        style={v3 ? selectionStyles.scroll : undefined}
        refreshControl={<RefreshControl refreshing={runtime.loading || loadingThreads} onRefresh={() => void reload()} tintColor={colors.text} />}
        contentContainerStyle={v3 ? selectionStyles.scrollContent : [styles.content, { paddingBottom: insets.bottom + 76 }]}
      >
        {notice === "confirmed-workspace-absent" ? <View style={styles.errorBanner}><Text accessibilityRole="alert" testID="home-confirmed-workspace-absence-notice" style={styles.errorText}>{t("task.confirmed_workspace_absent_body")}</Text></View> : null}
        {runtime.error || runtime.reauthorizationRequired ? <View testID="gateway-connection-error" style={styles.errorBanner}>
          {runtime.error ? <Text style={styles.errorText}>{gatewayErrorMessage(runtime.error)}</Text> : null}
          <Pressable testID={runtime.reauthorizationRequired ? "reauthorize-active-profile" : "retry-gateway"} onPress={() => runtime.reauthorizationRequired ? router.push({ pathname: "/welcome", params: { gateway: activeProfile.baseUrl, reauth: activeProfile.id } }) : void refresh()}><Text style={styles.retry}>{runtime.reauthorizationRequired ? t("home.reauthorize") : t("home.retry")}</Text></Pressable>
        </View> : null}
        {runtime.statusError && runtime.statusError !== runtime.error && !runtime.reauthorizationRequired ? <Text accessibilityRole="alert" testID="server-status-error" style={styles.errorText}>{t("home.status_error", { p0: gatewayErrorMessage(runtime.statusError) })}{runtime.statusesUpdatedAt ? ` ${t("home.last_checked_at", { p0: new Date(runtime.statusesUpdatedAt).toLocaleTimeString(locale) })}` : ""}</Text> : null}
        {runtime.loading && runtime.servers.length === 0 ? <ActivityIndicator style={styles.loader} color={colors.text} /> : null}
        {runtime.servers.length === 0 && !runtime.loading ? <EmptyState icon={<Server size={42} color={colors.textDim} />} title={t("home.no_servers")} body={t("home.no_servers_body")} /> : null}
        {v3 ? <V3ConversationSelection key={profileReadOwner} targets={selectionTargets}
          collapsed={new Set([...collapsedServerIds].filter(key => key.startsWith("v3-project:")).map(key => key.slice("v3-project:".length)))}
          collapseReady={collapsedHydrated} onToggle={projectKey => toggleServerCollapsed(`v3-project:${projectKey}`)}
          onNew={(server, cwd) => { if (canUseTarget(server)) openNewWorkspace(server.id, cwd); }}
          onAddProject={() => { if (historyNavigationAllowed && historyNavigationOwner === historyNavigationOwnerRef.current) router.push({ pathname: "/open-project", params: { profileId: activeProfile.id } }); }}
          onThread={(server, group, thread) => {
            if (!canUseTarget(server)) return;
            const cwd = thread.cwd?.trim() || group.path;
            router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id,
              threadId: thread.id, ...(cwd ? { cwd } : {}), title: thread.title || t("task.untitled_task") } });
          }}
          onThreadActions={(server, group, thread) => {
            if (!canUseTarget(server) || !handoffOwner.isCurrent()) return;
            const cwd = thread.cwd?.trim() || group.path;
            setThreadActionTarget({ profile: activeProfile, owner: readOwner, interaction: {}, isCurrent: handoffOwner.isCurrent,
              server: { ...server, workspacePath: cwd }, thread: { ...thread, cwd } });
          }}
          onProjectActions={openSelectionProjectActions}
          onProjectPinToggle={toggleProjectPin}
          onViewAll={server => { if (canUseTarget(server)) router.push({ pathname: "/sessions", params: { profileId: activeProfile.id, serverId: server.id } }); }} /> : ([true, false] as const).map((pinnedSection) => {
          const hasProjects = runtime.servers.some(server => groupThreadsByProject(activeProfile, server, scopedThreads[server.id] ?? [], workspaceOptions[server.id] ?? []).some(project => Boolean(project.pinned) === pinnedSection));
          if (!hasProjects && (pinnedSection || !runtime.servers.some(server => pagination.owner === readOwner && pagination.servers[server.id]?.hasMore))) return null;
          return <View key={String(pinnedSection)} testID={pinnedSection ? "home-pinned-projects" : "home-projects"} style={styles.projectSection}>
            <Pressable accessibilityRole="button" accessibilityLabel={pinnedSection || !hasPinnedProjects ? t("task.task_navigation") : undefined} onPress={() => setDrawerOpen(true)}><Text accessibilityRole="header" style={styles.sectionTitle}>{t(pinnedSection ? "home.pinned" : "home.projects")}</Text></Pressable>
        {runtime.servers.map((server) => {
          const serverThreads = scopedThreads[server.id] ?? [];
          const serverPagination = pagination.owner === readOwner ? pagination.servers[server.id] : undefined;
          const workspaceProjects = groupThreadsByProject(activeProfile, server, serverThreads, workspaceOptions[server.id] ?? []);
          const workspaceActionsEnabled = historyNavigationAllowed && historyNavigationOwner === historyNavigationOwnerRef.current &&
            readOwner === readOwnerRef.current && serverOwners[server.id] === threadListReadOwner(activeProfile, server, { archived: false });
          const targetPresentation = targetPresentations.get(server.id)!;
          const targetAccessibleDescriptor = targetPresentation.accessible;
          const targetDisplayDescriptor = targetPresentation.display;
          const status = connectionStatusProps.serverStatuses[server.id] ?? "unknown";
          let workspaceIndex = 0;
          const renderedProjects = workspaceProjects.map((project, projectIndex) => ({
            project,
            projectIndex,
            rows: project.workspaces.map((group) => ({ group, groupIndex: workspaceIndex++ })),
          })).filter(({ project }) => Boolean(project.pinned) === pinnedSection)
            .sort((left, right) => pinnedSection ? (left.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER) - (right.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER) : 0);
          const showPagination = Boolean(serverPagination?.hasMore && (workspaceProjects.some(project => !project.pinned) ? !pinnedSection : workspaceProjects.length > 0 ? pinnedSection : !pinnedSection));
          if (!renderedProjects.length && !showPagination) return null;
          return (
            <View key={server.id} style={styles.serverSection}>
              {renderedProjects.map(({ project, rows, projectIndex }) => <View key={project.key} testID={`home-project-group-${server.id}-${projectIndex}`} style={styles.listGroup}>
                {rows.length > 1 ? <View testID={`home-project-${server.id}-${projectIndex}`} style={styles.projectTitleRow}>
                  <Folder size={15} color={colors.textDim} />
                  <Text accessibilityRole="header" style={styles.projectTitle} numberOfLines={1}>{project.name}</Text>
                </View> : null}
                {rows.map(({ group, groupIndex }) => {
                const displayName = rows.length === 1 ? project.name : group.label;
                const sectionKey = workspaceSectionCollapseKey(server.id, group.path);
                const collapsed = collapsedServerIds.has(sectionKey);
                const threadsExpanded = expandedServerIds.has(sectionKey);
                const hiddenThreads = hiddenThreadCount(group.threads, threadsExpanded);
                const workspaceAccessibleName = `${displayName} · ${group.path ?? t("home.choose_directory_for_new")} · ${targetAccessibleDescriptor} · ${connectionStatusLabel(status)}`;
                const workspaceCanAct = workspaceActionsEnabled && Boolean(group.path);
                const openWorkspaceActions = () => {
                  if (demo) return;
                        const workspacePath = group.path;
                        if (!workspacePath || !workspaceCanAct || historyNavigationOwner !== historyNavigationOwnerRef.current ||
                          readOwner !== readOwnerRef.current || serverOwners[server.id] !== threadListReadOwner(activeProfile, server, { archived: false })) return;
                        setWorkspaceMenuTarget((current) => current?.server.id === server.id && current.workspaceIdentity === group.identity && current.owner === readOwner
                          ? null
                          : { profile: activeProfile, server, owner: readOwner, workspace: workspacePath, workspaceIdentity: group.identity, workspaceLabel: group.label, workspaceAccessibleName, targetLabel: targetDisplayDescriptor, groupIndex });
                };
                return <View key={group.identity} testID={`home-workspace-row-${server.id}-${groupIndex}`} style={styles.listGroup}>
                  <View style={styles.workspaceRow}>
                  <Pressable
                    testID={groupIndex === 0 ? `toggle-server-${server.id}` : `toggle-workspace-${server.id}-${groupIndex}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${t(collapsed ? "task.expand" : "task.collapse")} ${workspaceAccessibleName}`}
                    aria-expanded={!collapsed}
                    accessibilityState={{ expanded: !collapsed, disabled: !collapsedHydrated }}
                    disabled={!collapsedHydrated}
                    {...rowActions(t("task.task_actions"), openWorkspaceActions)}
                    onPress={() => toggleServerCollapsed(sectionKey)}
                    style={({ pressed }) => [styles.workspaceToggle, pressed && styles.workspaceRowPressed]}
                  >
                    {classic ? <WorkspaceFolderBadge profile={activeProfile} server={server} testID={`home-target-badge-${server.id}-${groupIndex}`} /> : null}
                    <View style={classic ? { flexShrink: 1, minWidth: 0 } : styles.workspaceIdentity}>
                    <View style={styles.workspaceTitle}>
                      <Text testID={`home-workspace-name-${server.id}-${groupIndex}`} style={styles.workspaceName} numberOfLines={1} ellipsizeMode="tail">{displayName}</Text>
                      <View testID={`home-workspace-chevron-${server.id}-${groupIndex}`}  accessible={false} style={[styles.rowChevron, { pointerEvents: "none" }]}>
                        {collapsed ? <ChevronRight size={13} color={classic ? statusDotColor(status, colors) : colors.textDim} /> : classic ? <ChevronDown size={13} color={statusDotColor(status, colors)} /> : <ChevronUp size={13} color={colors.textDim} />}
                      </View>
                    </View>
                    <View testID={`home-target-status-${server.id}-${groupIndex}`} accessibilityLabel={`${targetDisplayDescriptor} · ${connectionStatusLabel(status)}`} style={[styles.workspaceTarget, classic && { display: "none" }]}><Server size={13} color={colors.textDim} /><Text numberOfLines={1} style={styles.workspaceTargetLabel}>{server.label}</Text><StatusDot status={status} decorative /></View>
                    </View>
                  </Pressable>
                  <View style={styles.workspaceRowActions}>
                    {classic ? <Pressable testID={`workspace-actions-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={`${displayName} ${t("task.task_actions")}`} onPress={openWorkspaceActions} disabled={!workspaceCanAct} style={styles.iconButton}><MoreHorizontal size={20} color={colors.textMuted} /></Pressable> : null}

                    <Pressable
                      testID={`new-workspace-${server.id}-${groupIndex}`}
                      accessibilityRole="button"
                      accessibilityLabel={`${t("home.create_workspace_for", { p0: displayName, p1: group.path ?? t("home.choose_directory_for_new"), p2: server.id })} · ${connectionStatusLabel(status)}`}
                      disabled={!workspaceCanAct}
                      accessibilityState={{ disabled: !workspaceCanAct }}
                      onPress={() => {
                        const currentServer = runtime.servers.find((candidate) => candidate.id === server.id && JSON.stringify(candidate) === JSON.stringify(server));
                        if (!group.path || !workspaceCanAct || !currentServer || historyNavigationOwner !== historyNavigationOwnerRef.current ||
                          readOwner !== readOwnerRef.current || serverOwners[server.id] !== threadListReadOwner(activeProfile, currentServer, { archived: false })) return;
                        openNewWorkspace(currentServer.id, group.path);
                      }}
                      hitSlop={{ top: 2, bottom: 2 }}
                      style={[styles.sectionAction, !workspaceCanAct && styles.sectionActionDisabled]}
                    ><Plus size={17} color={colors.textMuted} /></Pressable>
                  </View>
                  </View>
                  {!collapsed && projectVisibleThreads(group.threads, threadsExpanded).map((thread) => {
                    const activity = threadActivityPresentation(thread);
                    return <View key={thread.id} style={styles.threadRow}>
                    <Pressable testID={`thread-${thread.id}`} accessibilityRole="button" {...rowActions(t("task.task_actions"), () => {
                      if (!historyNavigationAllowed || !workspaceActionsEnabled || readOwner !== readOwnerRef.current || !handoffOwner.isCurrent()) return;
                      const cwd = thread.cwd?.trim() || group.path;
                      setThreadActionTarget({ profile: activeProfile, owner: readOwner, interaction: {}, isCurrent: handoffOwner.isCurrent,
                        server: { ...server, workspacePath: cwd }, thread: { ...thread, cwd } });
                    })} onPress={() => router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: { profileId: activeProfile.id, serverId: server.id, threadId: thread.id, ...((thread.cwd?.trim() || group.path) ? { cwd: thread.cwd?.trim() || group.path } : {}), title: thread.title || t("task.untitled_task") } })} style={({ pressed }) => [styles.thread, pressed && styles.threadPressed]}>
                      <View style={styles.threadCopy}>
                        <View style={styles.threadMainRow}>
                          <Text style={styles.threadTitle} numberOfLines={1} ellipsizeMode="tail">{thread.title || t("task.untitled_task")}</Text>
                          <View style={styles.threadMetaRow}>
                            <Text style={styles.threadMeta}>{v3 ? historyTime(thread.updatedAt, locale) : relativeTime(thread.updatedAt)}</Text>
                            {activity.label ? <Text style={[styles.state, activity.tone === "running" && styles.stateRunning, activity.tone === "failed" && styles.failed, activity.tone === "unknown" && styles.stateUnknown]}>{activity.label}</Text> : null}
                          </View>
                        </View>
                        {activity.recentErrorLabel ? <Text testID={`thread-recent-error-${thread.id}`} style={styles.recentErrorLabel}>{activity.recentErrorLabel}</Text> : null}
                      </View>
                    </Pressable>

                    </View>;
                  })}
                  {!collapsed && group.threads.length > 8 ? <Pressable testID={`toggle-more-threads-${server.id}-${groupIndex}`} accessibilityRole="button" accessibilityLabel={threadsExpanded ? t("task.collapse_sessions") : t(serverPagination?.hasMore ? "home.show_loaded_sessions" : "task.show_more_sessions", { p0: hiddenThreads })} aria-expanded={threadsExpanded} accessibilityState={{ expanded: threadsExpanded }} onPress={() => toggleServerThreadsExpanded(sectionKey)} style={({ pressed }) => [styles.moreThreads, pressed && styles.threadPressed]}>{threadsExpanded ? <ChevronUp size={14} color={colors.textDim} /> : <ChevronDown size={14} color={colors.textDim} />}<Text style={styles.moreThreadsText}>{threadsExpanded ? t("task.collapse") : t(serverPagination?.hasMore ? "home.show_loaded_sessions" : "task.show_more", { p0: hiddenThreads })}</Text></Pressable> : null}
                </View>;
              })}
              </View>)}
              {showPagination ? <View>
                <Text testID={`home-threads-incomplete-${server.id}`} style={styles.serverDescription}>{t("home.sessions_preview")}</Text>
                <Pressable testID={`view-all-home-threads-${server.id}`} accessibilityRole="button"
                  accessibilityLabel={t("home.view_all_sessions_for", { p0: server.label })}
                  disabled={!historyNavigationAllowed}
                  accessibilityState={{ disabled: !historyNavigationAllowed }}
                  onPress={() => {
                    if (!historyNavigationAllowed || historyNavigationOwner !== historyNavigationOwnerRef.current ||
                      readOwner !== readOwnerRef.current || serverOwners[server.id] !== threadListReadOwner(activeProfile, server, { archived: false })) return;
                    router.push({ pathname: "/sessions", params: { profileId: activeProfile.id, serverId: server.id } });
                  }}
                  style={styles.moreThreads}>
                  <Text style={styles.moreThreadsText}>{t("home.view_all_sessions")}</Text>
                </Pressable>
              </View> : null}
            </View>
          );
        })}
          </View>;
        })}
      </ScrollView>
      {!classic && !v3 ? <Pressable testID="new-workspace" accessibilityRole="button" accessibilityLabel={t("task.new_task")} onPress={() => openNewWorkspace()} style={[styles.floatingNew, { bottom: Math.max(insets.bottom, spacing.lg) + spacing.md }]}><Plus size={28} color={colors.actionPrimaryText} /></Pressable> : null}
      <MobileDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profileId={activeProfile.id}
        profile={activeProfile}
        gatewayStatus={connectionStatusProps.gatewayStatus}
        servers={runtime.servers}
        serverStatuses={connectionStatusProps.serverStatuses}
        threads={scopedThreads}
        workspaceOptions={workspaceOptions}
        workspaceErrors={workspaceErrors}
        threadErrors={threadErrors}
        workspaceHistoryOwner={readOwner}
        canRefreshWorkspaceHistory={(server) => {
          const currentServer = runtime.servers.find((candidate) => candidate.id === server.id && JSON.stringify(candidate) === JSON.stringify(server));
          return Boolean(currentServer && historyNavigationAllowed && historyNavigationOwner === historyNavigationOwnerRef.current &&
            readOwner === readOwnerRef.current && serverOwners[server.id] === threadListReadOwner(activeProfile, currentServer, { archived: false }));
        }}
        onWorkspaceHistoryReady={() => { void reload(); }}
        demo={demo}
        onThreadRenamed={onThreadRenamed}
        onThreadRemoved={onThreadRemoved}
      />
      <ThreadActionsSheet visible={Boolean(visibleThreadActionTarget)} profile={activeProfile}
        target={visibleThreadActionTarget} demo={demo} onClose={() => setThreadActionTarget((current) => current?.interaction === visibleThreadActionTarget?.interaction ? null : current)}
        onRenamed={(thread) => {
          if (!visibleThreadActionTarget?.isCurrent() || visibleThreadActionTarget.owner !== readOwnerRef.current) return;
          onThreadRenamed(visibleThreadActionTarget.server.id, thread);
          setThreadActionTarget((current) => current?.interaction === visibleThreadActionTarget.interaction ? { ...current, thread } : current);
        }}
        onRemoved={(_kind, thread) => {
          if (!visibleThreadActionTarget?.isCurrent() || visibleThreadActionTarget.owner !== readOwnerRef.current) return;
          onThreadRemoved(visibleThreadActionTarget.server.id, thread.id);
          setThreadActionTarget((current) => current?.interaction === visibleThreadActionTarget.interaction ? null : current);
        }}
      />
      {visibleWorkspaceMenuTarget ? <WorkspaceHistoryActionsSheet
        key={`${workspaceMenuTarget!.owner}:${workspaceMenuTarget!.workspaceIdentity}`}
        server={visibleWorkspaceMenuTarget}
        workspace={visibleWorkspaceMenuGroup!}
        workspaceLabel={workspaceMenuTarget!.workspaceLabel}
        workspaceAccessibleName={workspaceMenuTarget!.workspaceAccessibleName}
        targetLabel={workspaceMenuTarget!.targetLabel}
        workspaceIndex={workspaceMenuTarget!.groupIndex}
        projectRename={menuProject && !menuProject.rootProject && (workspaceOptions[visibleWorkspaceMenuTarget.id] ?? []).some(option => option.projectKey === menuProject.projectKey && option.rootProject !== true) ? {
          name: menuProject.name,
          enabled: connectionStatusProps.serverStatuses[visibleWorkspaceMenuTarget.id] === "online",
          onSave: async (name) => {
            const target = workspaceMenuTarget!;
            const project = menuProject;
            const interactionOwner = handoffOwner;
            const isCurrent = () => interactionOwner.isCurrent() && target.owner === readOwnerRef.current && historyNavigationOwner === historyNavigationOwnerRef.current;
            const canStart = () => pinStatusRef.current[target.server.id] === "online";
            if (!isCurrent() || !canStart()) return;
            const confirmation = await renameRuntimeProject(activeProfile, visibleWorkspaceMenuTarget, { projectKey: project.projectKey, rootProject: project.rootProject, workspacePath: target.workspace }, name, isCurrent, canStart);
            if (!isCurrent()) return;
            const cacheKey = threadListScopeKey(activeProfile, visibleWorkspaceMenuTarget);
            const knownOptions = workspaceOptionsRef.current[cacheKey]?.value ?? workspaceOptions[target.server.id] ?? [];
            const options = knownOptions.map(option => option.projectKey === project.projectKey && option.rootProject !== true
              ? { ...option, projectName: confirmation.name }
              : option);
            const updated = { owner: serverOwners[visibleWorkspaceMenuTarget.id], value: options };
            projectPinRevisions.current[cacheKey] = (projectPinRevisions.current[cacheKey] ?? 0) + 1;
            workspaceOptionsRef.current = { ...workspaceOptionsRef.current, [cacheKey]: updated };
            setWorkspaceOptionEntries(current => isCurrent() ? { ...current, [visibleWorkspaceMenuTarget.id]: updated } : current);
            setWorkspaceMenuTarget(current => current === target ? null : current);
          },
        } : undefined}
        projectPin={menuProject ? {
          name: menuProject.name,
          pinned: menuProject.pinned === true,
          enabled: connectionStatusProps.serverStatuses[visibleWorkspaceMenuTarget.id] === "online" && menuProject.pinSupported !== false && (!menuProject.rootProject || menuProject.pinSupported === true),
          unsupported: menuProject.pinSupported === false || (menuProject.rootProject && menuProject.pinSupported !== true),
          onToggle: async () => {
            const target = workspaceMenuTarget!;
            await toggleProjectPin(visibleWorkspaceMenuTarget, menuProject);
            setWorkspaceMenuTarget(current => current === target ? null : current);
          },
        } : undefined}
        onClose={() => setWorkspaceMenuTarget((current) => current === workspaceMenuTarget ? null : current)}
        onSelect={(workspace) => {
          const currentServer = runtime.servers.find((server) => JSON.stringify(server) === JSON.stringify(visibleWorkspaceMenuTarget));
          if (!currentServer || workspaceMenuTarget?.profile !== activeProfile || workspaceMenuTarget.owner !== readOwner ||
            !historyNavigationAllowed || historyNavigationOwner !== historyNavigationOwnerRef.current || readOwner !== readOwnerRef.current ||
            serverOwners[currentServer.id] !== threadListReadOwner(activeProfile, currentServer, { archived: false }) ||
            workspaceMenuTarget.workspace !== workspace || visibleWorkspaceMenuGroup?.path !== workspace ||
            visibleWorkspaceMenuGroup.identity !== workspaceMenuTarget.workspaceIdentity) return;
          setWorkspaceMenuTarget(null);
          setHistoryRefreshTarget({ kind: "workspace", profile: activeProfile, server: currentServer, workspace, owner: readOwner });
        }}
      /> : null}
      {visibleHistoryRefreshTarget ? <HistoryRefreshModal
        target={visibleHistoryRefreshTarget}
        isTargetCurrent={() => historyRefreshTargetVisible && visibleHistoryRefreshTarget.owner === readOwnerRef.current && historyNavigationOwner === historyNavigationOwnerRef.current}
        onClose={() => setHistoryRefreshTarget((current) => current === visibleHistoryRefreshTarget ? null : current)}
        onReady={() => { void reload(); }}
      /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.pageCanvas },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  header: { height: 64, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  headerTitle: { flex: 1, minWidth: 0, paddingLeft: spacing.sm },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.xl },
  errorBanner: { flexDirection: "row", justifyContent: "space-between", padding: spacing.md, backgroundColor: colors.surfaceRaised, borderRadius: radius.md },
  errorText: { color: colors.red, fontSize: 13, flex: 1 },
  retry: { color: colors.text, fontSize: 13, fontWeight: "700", marginLeft: spacing.sm },
  loader: { paddingVertical: spacing.xxl },
  serverSection: { gap: spacing.xl },
  projectSection: { gap: spacing.xl },
  sectionTitle: { color: colors.text, fontSize: 19, fontWeight: "700", paddingHorizontal: spacing.xs, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  listGroup: { gap: 0 },
  serverDescription: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  threadErrorIndicator: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  sectionAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  sectionActionDisabled: { opacity: 0.45 },
  workspaceRow: { minHeight: 64, flexDirection: "row", alignItems: "flex-start", gap: spacing.xs, paddingHorizontal: spacing.xs, marginBottom: spacing.sm },
  workspaceToggle: { flex: 1, minWidth: 0, minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  workspaceRowActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  workspaceRowPressed: { backgroundColor: colors.surfaceHover },
  workspaceTitle: { flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  workspaceIdentity: { flex: 1, minWidth: 0, gap: spacing.sm },
  workspaceTarget: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  workspaceTargetLabel: { flexShrink: 1, color: colors.textDim, fontSize: 13 },
  inboxButton: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: colors.actionTint },
  inboxLabel: { color: colors.blue, fontSize: 13, fontWeight: "600" },
  inboxBadge: { minWidth: 24, height: 22, paddingHorizontal: spacing.xs, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.actionPrimary },
  inboxCount: { color: colors.actionPrimaryText, fontSize: 12, fontWeight: "700" },
  floatingNew: { position: "absolute", right: spacing.xl, width: 60, height: 60, borderRadius: 30, backgroundColor: colors.actionPrimary, borderWidth: 2, borderColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center", ...(Platform.OS === "web" ? { boxShadow: `0px 4px 12px ${colors.actionPrimary}3d` } : { shadowColor: colors.actionPrimary, shadowOpacity: 0.24, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 5 }) },
  workspaceName: { flexShrink: 1, minWidth: 0, color: colors.text, fontSize: 16, fontWeight: "700" },
  rowChevron: { flexShrink: 0 },
  projectTitleRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  projectTitle: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "700" },
  threadRow: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, marginHorizontal: spacing.xs },
  thread: { flex: 1, minWidth: 0, minHeight: 48, paddingLeft: spacing.xs, paddingRight: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  threadPressed: { backgroundColor: colors.surfaceHover },
  threadCopy: { flex: 1, minWidth: 0, justifyContent: "center", gap: 2 },
  threadMainRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  threadTitle: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 14, fontWeight: "500" },
  threadMetaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  threadMeta: { color: colors.textDim, fontSize: 11 },
  recentErrorLabel: { color: colors.textDim, fontSize: 10 },
  state: { color: colors.yellow, fontSize: 10, fontWeight: "700", marginLeft: 4 },
  stateRunning: { color: colors.green },
  stateUnknown: { color: colors.blue },
  failed: { color: colors.red },
  moreThreads: { minHeight: 40, marginLeft: spacing.xl, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  moreThreadsText: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
  inlineError: { color: colors.red, fontSize: 12, padding: spacing.md },
  recoveryButton: { minHeight: 44, minWidth: 120, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  recoveryButtonText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  recoveryActions: { width: "100%", flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm },
  recoveryPressed: { backgroundColor: colors.surfaceHover },
  recoveryError: { maxWidth: 440, color: colors.red, fontSize: 13, lineHeight: 19, textAlign: "center" },
  hostDock: { minHeight: 58, flexDirection: "row", alignItems: "center", paddingTop: spacing.sm, paddingHorizontal: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceSidebar },
  hostDockCopy: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  hostDockIdentity: { flex: 1, minWidth: 0 },
  hostDockTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  hostDockMeta: { color: colors.textDim, fontSize: 10, marginTop: 2 },
});

const makeClassicStyles = (colors: ThemeColors) => ({ ...makeStyles(colors), ...classicHomeStyles(colors) });
