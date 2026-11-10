import { useInterfaceVersion } from "@/storage/interface-version";
import { classicHistoryStyles } from "@/features/interface/classic-styles";
import { v3HistoryStyles } from "@/features/interface/v3-library-styles";
import { v3HistoryMonth, v3HistoryTime } from "@/features/interface/v3-history-presentation";
import { rowActions } from "@/components/row-actions";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { ActivityIndicator, FlatList, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { Archive, ChevronLeft, Clock3, CornerUpLeft, Filter, Search, Server } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, StatusDot } from "@/components/ui";
import { threadActivityPresentation } from "@/components/thread-list-presentation";
import type { KCoderServer, ThreadSummary } from "@/gateway/types";
import { listWorkspaceThreadScopes, mapThreadListScopes, subscribeThreadMutations, ThreadListPager, type WorkspaceOption } from "@/runtime/task-runtime";
import { orderThreadScopeRows, threadListReadOwner, acknowledgeThreadMutationAtWorkspace, threadMutationMatchesRow, threadMutationWorkspaceServers, ThreadListProjection, threadListScopeKey, threadListNotice } from "@/runtime/thread-list-projection";
import { workspaceThreadScopeIdentity, type WorkspaceDefaultReadConnection } from "@/runtime/task-runtime/workspaces";
import { mapThreadListDependencies } from "@/runtime/task-runtime/threadDirectory";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { historyDateGroup, historyProjectKey, historyTime } from "@/components/history-presentation";
import { isRegisteredHistoryWorkspace } from "../../../shared/workspaceHistory";
import { timestampMs } from "@/protocol/normalizers";
import { SessionFiltersPage, type SessionFilterProject } from "@/components/session-filters";
import { ThreadActionsSheet, type ThreadActionTarget } from "@/components/thread-actions-sheet";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { selectMobileConnectionStatusProps, type ConnectionStatus } from "@/components/connection-status-presentation";

interface SessionRow { targetOwner?: string; owner?: string; serverId: string; serverLabel: string; workspacePath?: string; scope?: string; demoTitleKey?: "sessions.demo_design_mobile_client" | "sessions.demo_fix_mobile_sign_in"; thread: ThreadSummary }
const MAX_SESSION_CURSOR_KEEPERS = 4;
interface ServerPagerState { targetOwner: string; owner: string; pager?: ThreadListPager; phase: "reading" | "live" | "queued" | "done" | "failed"; scope: string; serverId: string; serverLabel: string; workspacePath?: string; nextCursor?: string }
type SessionListNotice =
  | { kind: "workspace-resolution"; serverLabel: string; attemptedDirectories: string[] }
  | { kind: "partial"; serverLabel: string; workspacePath?: string; issueCount: number }
  | { kind: "incomplete"; serverLabel: string; workspacePath?: string };
type SessionLoadError =
  | { kind: "unscoped" }
  | { kind: "workspace"; serverLabel: string; workspacePath?: string };
function connectionStatusLabel(status: ConnectionStatus): string {
  if (status === "online") return t("settings.status_online");
  if (status === "offline") return t("settings.status_offline");
  if (status === "checking") return t("settings.status_checking");
  return t("task.unknown");
}

function sessionTitle(row: SessionRow): string {
  return row.demoTitleKey ? t(row.demoTitleKey) : row.thread.title || t("task.untitled_task");
}

function safeWorkspaceIdentity(path: string | undefined): string | null {
  if (!path) return null;
  try { return workspaceThreadScopeIdentity(path); }
  catch { return ""; }
}

export default function SessionsRoute() {
  const locale = useLocale();
  const { colors } = useTheme();
  const interfaceVersion = useInterfaceVersion();
  const classic = interfaceVersion === "classic";
  const v3 = interfaceVersion === "v3";
  const v3Styles = useThemedStyles(v3HistoryStyles);
  const styles = useThemedStyles(useCallback((colors: ThemeColors) => classic ? makeClassicStyles(colors) : v3 ? { ...makeStyles(colors), ...v3HistoryStyles(colors) } : makeStyles(colors), [classic, v3]));
  const [openedSessionKey, setOpenedSessionKey] = useState<string | null>(null);
  const { profileId, serverId: initialServerId, cwd: initialWorkspacePath, notice: routeNotice } =
    useLocalSearchParams<{ profileId?: string; serverId?: string; cwd?: string; notice?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hydrated, profileHydrationError, profileHydrationRetrying, retryStoredProfiles, activeProfile, profiles, runtime, setActiveProfile, refresh, demo } = useApp();
  const connectionStatusProps = selectMobileConnectionStatusProps(runtime);
  const gatewayStatus = connectionStatusProps.gatewayStatus;
  const targetStatusFor = (serverId: string): ConnectionStatus =>
    connectionStatusProps.serverStatuses[serverId] ?? "unknown";
  const goBack = () => backOrReplace(router, activeProfile ? profileHomeHref(activeProfile.id) : "/settings-connections");
  const profileReady = hydrated && (!profileId || activeProfile?.id === profileId);
  const routeProfile = profileId ? profiles.find((profile) => profile.id === profileId) : undefined;
  const routeProfileExists = Boolean(routeProfile);
  const profileSwitchOwnerSource = JSON.stringify([
    profileId ?? null,
    routeProfile ? profileAuthorizationScopeKey(routeProfile) : null,
    activeProfile ? profileAuthorizationScopeKey(activeProfile) : null,
    isFocused,
    hydrated,
  ]);
  const profileSwitchOwnerRevision = useRef({ source: profileSwitchOwnerSource, revision: 0 });
  if (profileSwitchOwnerRevision.current.source !== profileSwitchOwnerSource) {
    profileSwitchOwnerRevision.current = {
      source: profileSwitchOwnerSource,
      revision: profileSwitchOwnerRevision.current.revision + 1,
    };
  }
  const profileSwitchOwner = JSON.stringify([profileSwitchOwnerSource, profileSwitchOwnerRevision.current.revision]);
  const profileSwitchOwnerRef = useRef(profileSwitchOwner);
  profileSwitchOwnerRef.current = profileSwitchOwner;
  const profileSwitchAttempt = useRef(0);
  const [profileSwitchErrorEntry, setProfileSwitchErrorEntry] = useState<{ owner: string } | null>(null);
  const profileSwitchFailed = profileSwitchErrorEntry?.owner === profileSwitchOwner;
  const requestRouteProfileSwitch = useCallback(() => {
    if (!profileId) return;
    const owner = profileSwitchOwner;
    const attempt = ++profileSwitchAttempt.current;
    const current = () => profileSwitchAttempt.current === attempt && profileSwitchOwnerRef.current === owner;
    setProfileSwitchErrorEntry(null);
    if (!current()) return;
    let activation: Promise<void>;
    try {
      activation = setActiveProfile(profileId);
    } catch {
      if (current()) setProfileSwitchErrorEntry({ owner });
      return;
    }
    void Promise.resolve(activation).then(
      () => {
        if (current())
          setProfileSwitchErrorEntry(current => current?.owner === owner ? null : current);
      },
      () => {
        if (current())
          setProfileSwitchErrorEntry({ owner });
      },
    );
  }, [profileId, profileSwitchOwner, setActiveProfile]);
  const openConnections = () => router.push("/settings-connections");
  const openPairing = () => router.push({ pathname: "/welcome", params: { connectMode: "pairing" } });
  const openManualConnection = () => router.push({ pathname: "/welcome", params: { connectMode: "direct" } });
  const invalidProfile = hydrated && !profileHydrationError && !profileHydrationRetrying && Boolean(profileId) && !routeProfileExists;
  const openReauthorization = () => {
    if (!profileReady || !activeProfile || !runtime.reauthorizationRequired) return;
    router.push({ pathname: "/welcome", params: { gateway: activeProfile.baseUrl, reauth: activeProfile.id } });
  };
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [serverFilter, setServerFilter] = useState<string>(initialServerId || "all");
  const [routeWorkspaceFilter, setRouteWorkspaceFilter] = useState(() => safeWorkspaceIdentity(initialWorkspacePath));
  const [filterPageOwner, setFilterPageOwner] = useState<{ identity: string; token: object } | null>(null);
  const filterDialogRef = useRef(filterPageOwner); filterDialogRef.current = filterPageOwner;
  const searchInputRef = useRef<TextInputInstance>(null);
  const confirmedAbsenceNotice = routeNotice === "confirmed-thread-absent";
  const [loadErrorEntry, setLoadErrorEntry] = useState<{ owner: string; value: SessionLoadError[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRow, setSelectedRow] = useState<SessionRow | null>(null);
  const pagersRef = useRef(new Map<string, ServerPagerState>());
  const nextBatchRef = useRef<{ owner: string; run: () => Promise<void> } | null>(null);
  const workspaceOptionsRef = useRef<Record<string, { owner: string; value: WorkspaceOption[]; complete: boolean }>>({});
  const threadProjection = useRef(new ThreadListProjection());
  const [listNoticeEntry, setListNoticeEntry] = useState<{ owner: string; value: Record<string, SessionListNotice> } | null>(null);
  const refreshingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const profileOwner = JSON.stringify([profileId, activeProfile?.id, activeProfile?.baseUrl, activeProfile?.authorizationGeneration, activeProfile?.deviceId]);
  const filter = { archived: showArchived, query: searchQuery || undefined };
  const readOwner = JSON.stringify([profileOwner, demo, isFocused, profileReady, runtime.serversReady, runtime.reauthorizationRequired, serverFilter, routeWorkspaceFilter, filter,
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
  // A normal next-page cursor is handled by pagination, not a load failure.
  const incompleteSources = loadErrors.length + Object.values(listNotices)
    .filter(notice => notice.kind !== "incomplete").length;
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
    if (profileHydrationError || profileHydrationRetrying || !routeProfileExists || profileReady || !shouldActivateRouteProfile({ focused: isFocused, hydrated, routeProfileId: profileId, activeProfileId: activeProfile?.id, profileIds: profiles.map((profile) => profile.id) })) return;
    requestRouteProfileSwitch();
    return () => {
      profileSwitchAttempt.current += 1;
    };
  }, [activeProfile?.id, hydrated, isFocused, profileHydrationError, profileHydrationRetrying, profileId, profileReady, profileSwitchOwner, profiles, requestRouteProfileSwitch, routeProfileExists]);

  useEffect(() => {
    setRows([]);
    setLoadErrors([]);
    setLoading(true);
    setRefreshing(false);
    refreshingRef.current = false;
    workspaceOptionsRef.current = {};
    setServerFilter(initialServerId || "all");
    setRouteWorkspaceFilter(safeWorkspaceIdentity(initialWorkspacePath));
    setFilterPageOwner(null);
  }, [initialServerId, initialWorkspacePath, profileOwner]);

  useEffect(() => {
    if (serverFilter !== "all" && !runtime.servers.some((server) => server.id === serverFilter)) setServerFilter("all");
  }, [runtime.servers, serverFilter]);

  useEffect(() => {
    if (v3) return;
    const timer = setTimeout(() => setSearchQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query, v3]);

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
    for (const state of pagersRef.current.values()) state.pager?.close();
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
    // Queued scopes retain rows, but no connection-local cursor or transport.
    const records = pagers;
    let initialComplete = false;
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
    const closePager = (state: ServerPagerState) => {
      state.pager?.close();
      state.pager = undefined;
      state.nextCursor = undefined;
    };
    const openPager = (state: ServerPagerState) => new ThreadListPager(activeProfile,
      { ...targetServers.find(server => server.id === state.serverId)!, workspacePath: state.workspacePath }, filter, "foreground",
      { isCurrent: current, signal: resolverController.signal });
    const acceptPage = (state: ServerPagerState, page: Awaited<ReturnType<ThreadListPager["page"]>>) => {
      if (!current()) return;
      threadProjection.current.update(state.scope, page);
      const notice = threadListNotice(page);
      if (notice) notices.set(state.scope, page.completeness === "partial" ? { kind: "partial", serverLabel: state.serverLabel, workspacePath: state.workspacePath, issueCount: page.issueCount } : { kind: "incomplete", serverLabel: state.serverLabel, workspacePath: state.workspacePath }); else notices.delete(state.scope);
      errors.delete(state.scope);
      if (!page.nextCursor) {
        closePager(state);
        state.phase = "done";
      } else if (state.phase === "live" || [...records.values()].filter(record => record.phase === "live").length < MAX_SESSION_CURSOR_KEEPERS) {
        state.nextCursor = page.nextCursor;
        state.phase = "live";
      } else {
        closePager(state);
        state.phase = "queued";
      }
      publish();
    };
    const failPage = (state: ServerPagerState) => {
      closePager(state);
      if (!current()) return;
      state.phase = "failed";
      errors.set(state.scope, { kind: "workspace", serverLabel: state.serverLabel, workspacePath: state.workspacePath });
      publish();
    };
    const registerScope = (server: KCoderServer, workspaceServer: KCoderServer) => {
      const scope = threadListScopeKey(activeProfile, workspaceServer, filter);
      const existing = records.get(scope);
      if (existing) return existing;
      const state: ServerPagerState = { phase: "reading", scope,
        targetOwner: threadListReadOwner(activeProfile, server, filter), owner: threadListReadOwner(activeProfile, workspaceServer, filter),
        serverId: server.id, serverLabel: server.label, workspacePath: workspaceServer.workspacePath };
      records.set(scope, state);
      return state;
    };
    const readFirstPage = async (server: KCoderServer, workspaceServer: KCoderServer, defaultRead?: WorkspaceDefaultReadConnection) => {
      const state = registerScope(server, workspaceServer);
      const scope = state.scope;
      try {
        if (!current()) return { scope, error: null };
        if (defaultRead) {
          const client = defaultRead.claim(activeProfile, workspaceServer, current);
          state.pager = new ThreadListPager(activeProfile, workspaceServer, filter, "foreground",
            { isCurrent: current, signal: resolverController.signal, client, releaseClient: () => defaultRead.close() });
          unclaimedDefaultReads.delete(defaultRead);
        } else state.pager = openPager(state);
        const page = await state.pager.page(undefined, 50);
        acceptPage(state, page);
        return { scope, error: null as string | null };
      } catch {
        failPage(state);
        return { scope, error: true };
      }
    };
    nextBatchRef.current = { owner: operationOwner, run: async () => {
      if (!current() || !initialComplete || loadingMoreRef.current) return;
      const live = [...records.values()].filter(state => state.phase === "live");
      // Finish the current keepers before activating another bounded group.
      // Each queued scope replays its first page once on a fresh connection.
      const targets = live.length ? live : [...records.values()].filter(state => state.phase === "queued")
        .sort((left, right) => left.scope.localeCompare(right.scope)).slice(0, MAX_SESSION_CURSOR_KEEPERS);
      if (!targets.length) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
      try {
        await mapThreadListScopes(targets, async state => {
          if (!current()) return;
          try {
            if (state.phase === "queued") {
              state.phase = "reading";
              state.pager = openPager(state);
              acceptPage(state, await state.pager.page(undefined, 50));
            }
            if (!current() || state.phase !== "live" || !state.nextCursor || !state.pager) return;
            acceptPage(state, await state.pager.page(state.nextCursor, 50));
          } catch { failPage(state); }
        });
      } finally {
        if (current()) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    } };
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
                  // First page publishes while catalog is pending. Only bounded
                  // cursor keepers retain the shared read connection.
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
              workspaceOptionsRef.current[cacheKey] = { owner: threadListReadOwner(activeProfile, server), value: resolved.options, complete: !resolved.error };
              for (const workspaceServer of resolved.servers) registerScope(server, workspaceServer);
              if (resolved.error) notices.set(`workspace:${server.id}`, {
                kind: "workspace-resolution",
                serverLabel: server.label,
                attemptedDirectories: resolved.servers.map(workspaceServer =>
                  workspaceServer.workspacePath ?? t("sessions.default_workspace")),
              });
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
          initialComplete = true;
          setLoading(previous => current() ? false : previous);
          setRefreshing(previous => current() ? false : previous);
          refreshingRef.current = false;
        }
      }
    })().catch(() => {
      if (current()) setLoadErrors(previous => current() ? [{ kind: "unscoped" }] : previous);
    });
    return () => {
      cancelled = true;
      resolverController.abort();
      for (const connection of unclaimedDefaultReads) connection.close();
      unclaimedDefaultReads.clear();
      for (const state of pagers.values()) state.pager?.close();
      if (pagersRef.current === pagers) { pagersRef.current = new Map(); nextBatchRef.current = null; }
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
      for (const state of pagersRef.current.values()) state.pager?.close();
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
    if (loadingMoreRef.current || loading || refreshing || readOwner !== readOwnerRef.current) return;
    const batch = nextBatchRef.current;
    if (batch?.owner === readOwner) await batch.run();
  }, [loading, refreshing, readOwner]);

  const reloadSessions = useCallback(() => {
    if (readOwner !== readOwnerRef.current || !profileReady || !activeProfile || !isFocused ||
      !runtime.serversReady || runtime.reauthorizationRequired || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setReloadRevision(value => value + 1);
  }, [readOwner, profileReady, activeProfile, isFocused, runtime.serversReady, runtime.reauthorizationRequired]);

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
      (routeWorkspaceFilter === null || (routeWorkspaceFilter !== "" &&
        safeWorkspaceIdentity(row.thread.cwd?.trim() || row.workspacePath) === routeWorkspaceFilter)) &&
      (!needle || [row.thread.title, row.thread.cwd, row.thread.model, row.serverLabel]
        .some((value) => value?.toLocaleLowerCase(locale).includes(needle)) ||
        Boolean(row.demoTitleKey && sessionTitle(row).toLocaleLowerCase(locale).includes(needle)))
    )).sort((left, right) => timestampMs(right.thread.updatedAt) - timestampMs(left.thread.updatedAt));
  }, [rows, searchQuery, serverFilter, routeWorkspaceFilter, showArchived, demo, activeProfile, runtime.servers, readOwner, locale]);
  const filterProjects = new Map<string, SessionFilterProject>();
  const completeProjectServers = new Set<string>();
  for (const server of runtime.servers) {
    const entry = activeProfile ? workspaceOptionsRef.current[threadListScopeKey(activeProfile, server)] : undefined;
    const options = entry && activeProfile && entry.owner === threadListReadOwner(activeProfile, server) ? entry.value : [];
    if (entry && activeProfile && entry.owner === threadListReadOwner(activeProfile, server) && entry.complete) completeProjectServers.add(server.id);
    for (const option of [...options, ...(server.workspacePath ? [{ path: server.workspacePath, label: server.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? server.workspacePath }] : [])]) {
      const path = safeWorkspaceIdentity(option.path);
      if (!path) continue;
      const key = historyProjectKey(server.id, path);
      if (!filterProjects.has(key)) filterProjects.set(key, { key, serverId: server.id, serverLabel: server.label, label: option.label, path: option.path, count: 0 });
    }
  }
  const ownedRows = rows.filter(row => demo || ownsRow(row));
  const registeredProjects = [...filterProjects.values()];
  for (const row of ownedRows) {
    const path = row.thread.cwd?.trim() || row.workspacePath;
    const identity = safeWorkspaceIdentity(path);
    if (!path || !identity) continue;
    const key = historyProjectKey(row.serverId, identity);
    const project = filterProjects.get(key) ?? { key, serverId: row.serverId, serverLabel: row.serverLabel,
      label: t(completeProjectServers.has(row.serverId) ? "sessions.unassigned_project" : "sessions.project_unknown"), path, count: 0 };
    project.count++; filterProjects.set(key, project);
  }
  const selectedProjectKey = [...filterProjects.values()].find(project => project.serverId === serverFilter && safeWorkspaceIdentity(project.path) === routeWorkspaceFilter)?.key ?? null;
  const hasMoreForSelection = [...pagersRef.current.values()].some((state) => (
    (state.phase === "live" || state.phase === "queued") && (serverFilter === "all" || state.serverId === serverFilter)
  ));
  const selectedTarget: ThreadActionTarget | null = selectedRow ? (() => {
    const server = runtime.servers.find((candidate) => candidate.id === selectedRow.serverId);
    return server && activeProfile && (demo || ownsRow(selectedRow)) ? { server: { ...server, workspacePath: selectedRow.workspacePath }, thread: { ...selectedRow.thread, title: sessionTitle(selectedRow) } } : null;
  })() : null;
  const renderRecoveryState = (options: {
    testID: string;
    title: string;
    body: string;
    actions?: ReactNode;
    loading?: boolean;
    error?: string | null;
    contentTestID?: string;
  }) => (
    <View testID={options.testID} style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable testID="sessions-recovery-back" accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={goBack} style={styles.headerButton}>
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("v2.history")}</Text>
        <View style={styles.headerButton} />
      </View>
      <View style={styles.accessPage}>
        {options.loading ? <ActivityIndicator testID="sessions-state-spinner" color={colors.textMuted} /> : null}
        {options.contentTestID ? (
          <View testID={options.contentTestID}>
            <EmptyState icon={<Server size={40} color={colors.textDim} />} title={options.title} body={options.body} />
          </View>
        ) : <EmptyState icon={<Server size={40} color={colors.textDim} />} title={options.title} body={options.body} />}
        {options.error ? <Text testID={`${options.testID}-detail`} accessibilityRole="alert" style={styles.accessError}>{options.error}</Text> : null}
        {options.actions ? <View style={styles.accessActions}>{options.actions}</View> : null}
      </View>
    </View>
  );
  const profileContextUnavailable = !profileReady || !activeProfile;
  const profileHydrationPending = profileContextUnavailable && (!hydrated || profileHydrationRetrying);
  const profileHydrationFailed = profileContextUnavailable && Boolean(profileHydrationError);
  const noSavedProfile = !profileId && hydrated && !profileHydrationRetrying && !profileHydrationError && !activeProfile && profiles.length === 0;
  const noActiveSavedProfile = !profileId && hydrated && !profileHydrationRetrying && !profileHydrationError && !activeProfile && profiles.length > 0;
  const routeProfileSwitching = Boolean(profileId && routeProfileExists && activeProfile?.id !== profileId);
  const serverInventoryFailed = profileReady && Boolean(activeProfile) && !runtime.serversReady && !runtime.reauthorizationRequired && Boolean(runtime.error);
  const serverInventoryPending = profileReady && Boolean(activeProfile) && !runtime.serversReady && !runtime.reauthorizationRequired && !runtime.error;
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
    for (const state of pagersRef.current.values()) state.pager?.close();
    pagersRef.current = new Map();
    setReloadRevision((value) => value + 1);
  };
  if (profileHydrationPending) {
    return renderRecoveryState({
      testID: "sessions-profile-hydration-loading",
      title: t("task.recovering"),
      body: t("welcome.loading_local_connection_config"),
      loading: true,
    });
  }
  if (profileHydrationFailed) {
    return renderRecoveryState({
      testID: "sessions-profile-recovery-error",
      title: t("home.gateway_recovery_failed_title"),
      body: t("home.gateway_recovery_failed_body"),
      error: profileHydrationError,
      actions: <>
        <Button testID="sessions-retry-profile-recovery" variant="primary" loading={profileHydrationRetrying} onPress={() => { void retryStoredProfiles(); }}>
          {t("home.retry_gateway_recovery")}
        </Button>
        <Button testID="sessions-pair-gateway" variant="secondary" onPress={openPairing}>{t("home.pair_gateway")}</Button>
        <Button testID="sessions-manual-gateway" variant="secondary" onPress={openManualConnection}>{t("home.manual_gateway")}</Button>
        <Button testID="sessions-open-connections" variant="ghost" onPress={openConnections}>{t("settings.manage_connections")}</Button>
      </>,
    });
  }
  if (noSavedProfile || invalidProfile) {
    return renderRecoveryState({
      testID: "sessions-no-active-profile",
      contentTestID: noSavedProfile ? "sessions-no-saved-profile" : undefined,
      title: t("home.missing_gateway_title"),
      body: t("home.missing_gateway_body"),
      actions: <>
        <Button testID="sessions-pair-gateway" variant="primary" onPress={openPairing}>{t("home.pair_gateway")}</Button>
        <Button testID="sessions-manual-gateway" variant="secondary" onPress={openManualConnection}>{t("home.manual_gateway")}</Button>
        <Button testID="sessions-open-connections" variant="ghost" onPress={openConnections}>{t("settings.manage_connections")}</Button>
      </>,
    });
  }
  if (noActiveSavedProfile) {
    return renderRecoveryState({
      testID: "sessions-no-active-profile",
      title: t("sessions.no_active_gateway_title"),
      body: t("sessions.no_active_gateway_body"),
      actions: <Button testID="sessions-open-connections" variant="primary" onPress={openConnections}>{t("settings.manage_connections")}</Button>,
    });
  }
  if (routeProfileSwitching && profileSwitchFailed) {
    return renderRecoveryState({
      testID: "sessions-profile-switch-error",
      title: t("sessions.profile_switch_failed_title"),
      body: t("sessions.profile_switch_failed_body"),
      actions: <>
        <Button testID="sessions-retry-profile-switch" variant="primary" onPress={requestRouteProfileSwitch}>{t("sessions.retry_profile_switch")}</Button>
        <Button testID="sessions-open-connections" variant="ghost" onPress={openConnections}>{t("settings.manage_connections")}</Button>
      </>,
    });
  }
  if (routeProfileSwitching) {
    return renderRecoveryState({
      testID: "sessions-profile-switching",
      title: t("sessions.loading_profile_switch_title"),
      body: t("sessions.loading_profile_switch_body"),
      loading: true,
      actions: <Button testID="sessions-open-connections" variant="ghost" onPress={openConnections}>{t("settings.manage_connections")}</Button>,
    });
  }
  if (serverInventoryFailed) {
    return renderRecoveryState({
      testID: "sessions-server-inventory-error",
      title: t("sessions.server_inventory_failed_title"),
      body: t("sessions.server_inventory_failed_body"),
      error: runtime.error,
      actions: <>
        <Button testID="sessions-retry-server-inventory" variant="primary" loading={runtime.loading} onPress={() => { void refresh(); }}>
          {t("sessions.retry_server_inventory")}
        </Button>
        <Button testID="sessions-open-connections" variant="ghost" onPress={openConnections}>{t("settings.manage_connections")}</Button>
      </>,
    });
  }
  if (serverInventoryPending) {
    return renderRecoveryState({
      testID: "sessions-server-inventory-loading",
      title: t("task.recovering"),
      body: t("sessions.loading_server_inventory_body"),
      loading: true,
      actions: <>
        <Button testID="sessions-retry-server-inventory" variant="secondary" loading={runtime.loading} onPress={() => { void refresh(); }}>
          {t("sessions.retry_server_inventory")}
        </Button>
        <Button testID="sessions-open-connections" variant="ghost" onPress={openConnections}>{t("settings.manage_connections")}</Button>
      </>,
    });
  }
  return (
    <View testID={`history-interface-${interfaceVersion}`} style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={goBack} style={styles.headerButton}>{v3 ? <CornerUpLeft size={21} color={colors.textMuted} /> : <ChevronLeft size={23} color={colors.textMuted} />}</Pressable>
        <Text style={styles.headerTitle}>{t("v2.history")}</Text>
        {!v3 ? <Pressable accessibilityRole="button" accessibilityLabel={t("v2.search_history")} onPress={() => searchInputRef.current?.focus()} style={styles.headerButton}><Search size={20} color={colors.textMuted} /></Pressable> : null}
        <Pressable testID="sessions-open-filters" accessibilityRole="button" accessibilityLabel={t("v2.filter")}
          onPress={() => setFilterPageOwner({ identity: profileOwner, token: {} })} style={styles.headerButton}><Filter size={20} color={serverFilter !== "all" || routeWorkspaceFilter !== null || showArchived ? colors.blue : colors.textMuted} /></Pressable>
      </View>
      <View style={styles.search}><Search size={18} color={colors.textDim} style={v3 ? v3Styles.searchIcon : undefined} /><TextInput ref={searchInputRef} testID="session-search" value={query} onChangeText={setQuery} placeholder={t("v2.search_history")} placeholderTextColor={colors.textDim} style={styles.searchInput}
        returnKeyType="search" onSubmitEditing={v3 ? () => { setSearchQuery(query.trim()); Keyboard.dismiss(); } : undefined} />
        {v3 ? <Pressable testID="sessions-search-submit" accessibilityRole="button" hitSlop={6} onPress={() => { setSearchQuery(query.trim()); Keyboard.dismiss(); }} style={styles.searchActionButton}><Text style={styles.searchAction}>{t("v3.search")}</Text></Pressable>
          : query ? <Pressable accessibilityRole="button" accessibilityLabel={t("task.clear_search")} onPress={() => setQuery("")} style={styles.searchActionButton}><Text style={styles.searchAction}>{t("task.clear_search")}</Text></Pressable> : null}</View>
      {classic ? <>
        {runtime.servers.length > 1 ? <ScrollView horizontal style={styles.hostFilterScroller} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hostFilters}>
          {[{ id: "all", label: t("sessions.all_servers") }, ...runtime.servers].map(server => <Pressable key={server.id}
            testID={`sessions-host-${server.id}`} accessibilityRole="button" accessibilityState={{ selected: serverFilter === server.id }}
            onPress={() => { setServerFilter(server.id); setRouteWorkspaceFilter(null); }}
            style={[styles.hostFilter, serverFilter === server.id && styles.filterSelected]}>
            <Text numberOfLines={1} style={[styles.filterText, serverFilter === server.id && styles.filterSelectedText]}>{server.label}</Text>
          </Pressable>)}
        </ScrollView> : null}
        <View style={styles.filters}>{[false, true].map(archived => <Pressable key={String(archived)}
          testID={archived ? "sessions-archived" : "sessions-active"} accessibilityRole="button" accessibilityState={{ selected: showArchived === archived }}
          onPress={() => setShowArchived(archived)} style={[styles.filter, showArchived === archived && styles.filterSelected]}>
          <Text style={[styles.filterText, showArchived === archived && styles.filterSelectedText]}>{t(archived ? "sessions.archived" : "sessions.recent_tasks")}</Text>
        </Pressable>)}</View>
      </> : null}
      {incompleteSources > 0 ? <View>
        <Text testID="sessions-incomplete-notice" accessibilityRole="alert" style={styles.loadError}>
          {t("sessions.partial_list_notice", { p0: incompleteSources })}
        </Text>
        <Pressable testID="sessions-retry-load" accessibilityRole="button"
          accessibilityLabel={t("sessions.reload_sessions")}
          disabled={loading || loadingMore || refreshing || !profileReady || !runtime.serversReady || runtime.reauthorizationRequired}
          onPress={reloadSessions} style={styles.reloadButton}>
          <Text style={styles.loadMoreText}>{t("sessions.reload_sessions")}</Text>
        </Pressable>
      </View> : null}
      {confirmedAbsenceNotice ? <Text accessibilityRole="alert" testID="sessions-confirmed-absence-notice" style={styles.loadError}>{t("task.confirmed_absent_body")}</Text> : null}
      {runtime.reauthorizationRequired && profileReady && activeProfile ? (
        <View style={styles.reauthorizationNotice}>
          <Text accessibilityRole="alert" testID="sessions-reauthorization-error" style={styles.reauthorizationText}>
            {t("settings.session_expired_reauth")}
          </Text>
          <Pressable
            testID="sessions-reauthorize-active-profile"
            accessibilityRole="button"
            accessibilityLabel={t("home.reauthorize")}
            onPress={openReauthorization}
            style={styles.reauthorizationButton}
          >
            <Text style={styles.reauthorizationButtonText}>{t("home.reauthorize")}</Text>
          </Pressable>
        </View>
      ) : !profileReady || (!runtime.serversReady || runtime.reauthorizationRequired) || (!v3 && query.trim() !== searchQuery) || (loading && !refreshing && filtered.length === 0) ? <ActivityIndicator style={styles.loader} color={colors.textMuted} /> : <FlatList
        testID="sessions-list"
        data={filtered}
        keyExtractor={(row) => `${row.serverId}:${row.scope ?? "demo"}:${row.thread.id}`}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reloadSessions} tintColor={colors.textMuted} />}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.35}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={9}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        ListFooterComponent={loading || loadingMore ? <ActivityIndicator testID="sessions-page-loading" style={styles.moreLoader} color={colors.textMuted} /> : hasMoreForSelection && filtered.length > 0 ? <Pressable testID="sessions-load-more" accessibilityRole="button" disabled={refreshing} onPress={() => void loadMore()} style={styles.reloadButton}><Text style={styles.loadMoreText}>{t("sessions.continue_searching_older")}</Text></Pressable> : undefined}
        ListEmptyComponent={<View testID="sessions-empty-state" style={styles.emptyWrap}><EmptyState icon={showArchived ? <Archive size={40} color={colors.textDim} /> : <Clock3 size={40} color={colors.textDim} />} title={loadErrors.length > 0 || Object.keys(listNotices).length > 0 ? t("v2.no_loaded_conversations") : hasMoreForSelection ? t("sessions.no_loaded_match_title") : query ? t("sessions.no_search_match_title") : showArchived ? t("sessions.no_archived_title") : t("sessions.no_tasks_title")} body={loadErrors.length > 0 || Object.keys(listNotices).length > 0 ? "" : hasMoreForSelection ? t("sessions.no_loaded_match_body") : query ? t("sessions.no_search_match_body") : showArchived ? t("sessions.no_archived_body") : t("sessions.no_tasks_body")} />{hasMoreForSelection ? <Pressable testID="sessions-load-more-empty" disabled={loading || refreshing || loadingMore} onPress={() => void loadMore()} style={styles.loadMoreButton}>{loadingMore ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.loadMoreText}>{t("sessions.continue_searching_older")}</Text>}</Pressable> : null}</View>}
        renderItem={({ item: row, index }) => {
          const activity = threadActivityPresentation(row.thread);
          const targetStatus = targetStatusFor(row.serverId);
          const title = sessionTitle(row);
          const details = [title, row.serverLabel, row.thread.model, row.thread.cwd ?? row.workspacePath,
            connectionStatusLabel(targetStatus), activity.label].filter(Boolean).join(" · ");
          const group = historyDateGroup(row.thread.updatedAt);
          const month = v3HistoryMonth(row.thread.updatedAt, locale);
          const startsGroup = index === 0 || (v3 ? v3HistoryMonth(filtered[index - 1].thread.updatedAt, locale)?.key !== month?.key : historyDateGroup(filtered[index - 1].thread.updatedAt) !== group);
          const selected = v3 && openedSessionKey === JSON.stringify([profileOwner, row.serverId, row.thread.id]);
          const projectLabel = filterProjects.get(historyProjectKey(row.serverId, safeWorkspaceIdentity(row.thread.cwd?.trim() || row.workspacePath) ?? ""))?.label;
          const assigned = isRegisteredHistoryWorkspace(row.thread.cwd?.trim() || row.workspacePath || "",
            registeredProjects.filter(project => project.serverId === row.serverId).map(project => project.path), workspaceThreadScopeIdentity);
          return <View>
            {!classic && startsGroup ? <Text testID={v3 ? `sessions-month-${month?.key ?? "unknown"}` : `sessions-group-${group}`} accessibilityRole="header" style={styles.dateGroup}>{v3 ? month?.label ?? t("v2.unknown_date") : t(`v2.${group}`)}</Text> : null}
            <View testID={`session-row-${row.thread.id}`} style={styles.row}>
            <Pressable
              testID={`session-${row.thread.id}`}
              {...rowActions(t("task.task_actions"), () => {
                if (readOwner !== readOwnerRef.current || (!demo && !ownsRow(row))) return;
                setSelectedRow(row);
              })}
              accessibilityRole="button"
              accessibilityLabel={details}
              onPress={() => {
                if (!profileReady || (!runtime.serversReady || runtime.reauthorizationRequired) || !activeProfile ||
                  readOwner !== readOwnerRef.current || (!demo && !ownsRow(row))) return;
                if (v3) setOpenedSessionKey(JSON.stringify([profileOwner, row.serverId, row.thread.id]));
                router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: {
                  profileId: activeProfile.id, serverId: row.serverId, threadId: row.thread.id,
                  cwd: row.thread.cwd ?? row.workspacePath ?? "/", title,
                } });
              }}
              style={({ pressed }) => [styles.rowMain, (pressed || selected) && styles.rowPressed]}
            >
              <View style={[styles.copy, classic && assigned && { flexDirection: "row" }]}>
                <View style={styles.titleRow}>
                  {v3 && targetStatus !== "online" ? <View testID={`session-connection-${row.thread.id}`} accessibilityLabel={connectionStatusLabel(targetStatus)}><StatusDot status={targetStatus} decorative /></View> : null}
                  <Text testID={`session-title-${row.thread.id}`} style={[styles.title, selected && v3Styles.selectedTitle]} numberOfLines={1} ellipsizeMode="tail">{title}</Text>
                  {!classic ? <Text style={styles.rowTime}>{v3 ? v3HistoryTime(row.thread.updatedAt, locale) : historyTime(row.thread.updatedAt, locale)}</Text> : <View testID={`session-connection-${row.thread.id}`} accessibilityLabel={connectionStatusLabel(targetStatus)}><StatusDot status={targetStatus} decorative /></View>}
                </View>
                <View style={[styles.rowDetail, classic && assigned && { display: "none" }]}><Text numberOfLines={1} style={styles.rowScope}>{[row.serverLabel, projectLabel].filter(Boolean).join(" · ")}</Text>{!v3 ? <View testID={classic ? undefined : `session-connection-${row.thread.id}`} accessibilityLabel={connectionStatusLabel(targetStatus)}>{targetStatus !== "online" ? <StatusDot status={targetStatus} decorative /> : null}</View> : null}</View>
                {!classic && activity.label ? <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.status, activity.tone === "running" && styles.statusRunning,
                  activity.tone === "failed" && styles.failed, activity.tone === "unknown" && styles.statusUnknown]}>{activity.label}</Text> : null}
              </View>
            </Pressable>

          </View></View>;
        }}
      />}
      <SessionFiltersPage visible={filterPageOwner?.identity === profileOwner && isFocused} owner={profileOwner}
        value={{ serverId: serverFilter, workspaceKey: selectedProjectKey, archived: showArchived }}
        servers={runtime.servers.map(server => ({ id: server.id, label: server.label, count: ownedRows.filter(row => row.serverId === server.id).length }))}
        projects={[...filterProjects.values()]} onClose={() => setFilterPageOwner(null)}
        onApply={value => {
          if (!filterPageOwner || filterDialogRef.current !== filterPageOwner || filterPageOwner.identity !== profileOwner || !isFocused || readOwner !== readOwnerRef.current) return;
          const project = value.workspaceKey ? filterProjects.get(value.workspaceKey) : undefined;
          if (value.workspaceKey && (!project || project.serverId !== value.serverId)) return;
          if (value.serverId !== "all" && !runtime.servers.some(server => server.id === value.serverId)) return;
          setServerFilter(value.serverId); setRouteWorkspaceFilter(project ? safeWorkspaceIdentity(project.path) : null);
          setShowArchived(value.archived); setFilterPageOwner(null);
        }} />
      {activeProfile ? <ThreadActionsSheet visible={Boolean(selectedTarget)} profile={activeProfile} target={selectedTarget} demo={demo} onClose={() => setSelectedRow(null)} onRenamed={(thread) => { if (demo) changeSelectedThread(thread); }} onRemoved={(_kind, thread) => { if (demo) changeSelectedThread(thread, true); }} /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({ root: { flex: 1, backgroundColor: colors.pageCanvas },
  dateGroup: { color: colors.textDim, fontSize: 13, fontWeight: "600", paddingTop: spacing.xl, paddingBottom: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowTime: { color: colors.textDim, fontSize: 12, flexShrink: 0 },
  rowDetail: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  rowScope: { flex: 1, color: colors.textMuted, fontSize: 13 },
  header: { height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm },
  headerButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: colors.text, fontSize: 19, fontWeight: "700" },
  gatewayStatus: { width: 74, height: 44, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 },
  search: { height: 48, margin: spacing.lg, marginBottom: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.xs, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: 12, backgroundColor: colors.surface },
  searchInput: { flex: 1, color: colors.text, fontSize: 14 },
  searchActionButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  searchAction: { color: colors.green, fontSize: 12, fontWeight: "600" },
  hostFilterScroller: { flexGrow: 0, flexShrink: 0, maxHeight: 52 },
  hostFilters: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  hostFilter: { minWidth: 92, maxWidth: 180, height: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 10, backgroundColor: colors.surface },
  filters: { alignSelf: "flex-start", flexDirection: "row", marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: 3, borderRadius: 10, backgroundColor: colors.surface },
  filter: { minWidth: 88, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  filterSelected: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.borderAccent },
  filterText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  filterSelectedText: { color: colors.text },
  loadError: { color: colors.red, fontSize: 12, lineHeight: 18, marginHorizontal: spacing.lg, marginBottom: spacing.sm },
  loader: { marginTop: spacing.xl },
  moreLoader: { marginVertical: spacing.lg },
  content: { flexGrow: 1, paddingHorizontal: spacing.lg },
  emptyWrap: { flex: 1, alignItems: "center" },
  loadMoreButton: { minWidth: 190, minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: -spacing.lg, paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 12, backgroundColor: colors.surface },
  reloadButton: { minHeight: 44, alignItems: "center", justifyContent: "center", marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 12, backgroundColor: colors.surface },
  loadMoreText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowMain: { flex: 1, minWidth: 0, minHeight: 72, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  rowPressed: { backgroundColor: colors.surfaceHover },
  rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  copy: { flex: 1, minWidth: 0, gap: spacing.xs, paddingVertical: spacing.md },
  titleRow: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  title: { minWidth: 0, flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  rowConnection: { width: 13, height: 13, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  status: { flexShrink: 1, maxWidth: "36%", color: colors.yellow, fontSize: 10, fontWeight: "700" },
  statusRunning: { color: colors.green },
  statusUnknown: { color: colors.blue },
  failed: { color: colors.red },
  connectionStatusText: { color: colors.textDim, fontSize: 9 },
  accessPage: { flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  accessActions: { width: "100%", maxWidth: 440, alignSelf: "center", gap: spacing.sm },
  accessError: { width: "100%", maxWidth: 440, alignSelf: "center", color: colors.red, fontSize: 12, lineHeight: 18, textAlign: "center" },
  reauthorizationNotice: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  reauthorizationText: { color: colors.red, fontSize: 13, lineHeight: 18, textAlign: "center" },
  reauthorizationButton: { minHeight: 44, minWidth: 150, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface },
  reauthorizationButtonText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  sheetOverlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  modalKeyboard: { ...StyleSheet.absoluteFill },
  actionSheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "84%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.borderAccent, backgroundColor: colors.surface },
  actionHeader: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: spacing.md },
  actionHeading: { flex: 1 },
  actionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  actionSubtitle: { color: colors.textDim, fontSize: 10, marginTop: 4 },
  actionClose: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  renameRow: { minHeight: 50, flexDirection: "row", gap: spacing.sm },
  renameInput: { flex: 1, minHeight: 48, color: colors.text, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background },
  renameSave: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  actionDisabled: { opacity: 0.4 },
  actionRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background },
  actionCopy: { flex: 1 },
  actionRowTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  actionDanger: { color: colors.red, fontSize: 13, fontWeight: "700" },
  actionRowBody: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  actionError: { color: colors.red, fontSize: 12, lineHeight: 18 } });

const makeClassicStyles = (colors: ThemeColors) => ({ ...makeStyles(colors), ...classicHistoryStyles(colors) });
