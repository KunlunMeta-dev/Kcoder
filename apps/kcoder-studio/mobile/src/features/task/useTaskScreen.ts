import { loadWorkspaceTaskHandoff, confirmWorkspaceTaskRoute } from "@/storage/pending-workspace-operation-v2";
import type { TaskCreationClaim } from "@/runtime/task-runtime/types";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { t } from "@/i18n";
import { workspaceFileLocationFromLink } from "@/components/workspace-file-links";
import { stopDrawerSession } from "@/components/mobile-drawer-dismissal";
import type { ThreadSummary } from "@/gateway/types";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { requestConfirmation } from "@/platform/confirmation";
import {
  ThreadListPager,
  listWorkspaceThreadScopes,
  mapThreadListScopes,
  subscribeThreadMutations,
  TaskRuntime,
  taskRuntimeRegistry,
  type WorkspaceOption,
} from "@/runtime/task-runtime";
import {
  acknowledgeThreadMutationAtWorkspace,
  threadListNotice,
  projectWorkspaceThreadRows,
  threadMutationWorkspaceServers,
  ThreadListProjection,
  threadListScopeKey,
} from "@/runtime/thread-list-projection";
import { useApp } from "@/state/AppContext";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import {
  loadWorkspaceState as loadAuthorizedWorkspaceState,
  saveWorkspaceState as saveAuthorizedWorkspaceState,
  workspaceStateAuthorizationScope,
  type WorkspacePanelState,
  type WorkspaceTab,
  type WorkspaceViewState,
} from "@/storage/workspace-preferences";
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { taskOpenError } from "./taskLabels";
import { defaultWorkspacePanels, initialPanelId } from "./workspacePanels";

export function useTaskScreen() {
  const params = useLocalSearchParams<{
    profileId: string;
    serverId: string;
    threadId: string;
    cwd?: string;
    title?: string;
    creationRequestId?: string;
  }>();

  const router = useRouter();

  const isFocused = useIsFocused();

  const insets = useSafeAreaInsets();

  const {
    hydrated,
    activeProfile,
    profiles,
    runtime: appRuntime,
    setActiveProfile,
    markGatewayReauthorizationRequired,
    demo,
  } = useApp();

  const goBack = () => { if (ownsWorkspace()) backOrReplace(router, profileHomeHref(params.profileId)); };

  const profileReady = activeProfile?.id === params.profileId;

  const invalidProfile =
    hydrated && !profiles.some((profile) => profile.id === params.profileId);

  const server = profileReady
    ? appRuntime.servers.find((item) => item.id === params.serverId)
    : undefined;

  const workspaceProfileIdentity = activeProfile ? captureWorkspaceProfileIdentity(activeProfile) : undefined;
  const workspaceStorageScope = profileReady && activeProfile && server ? workspaceStateAuthorizationScope(activeProfile, server) : undefined;
  // A distinct object also fences A → B → A, even when the persisted key is the same.
  const ownerKey = JSON.stringify([params.profileId, params.serverId, params.threadId, params.cwd ?? "", workspaceStorageScope]);
  const ownerRef = useRef<{ key: string } | null>(null);
  if (ownerRef.current?.key !== ownerKey) ownerRef.current = { key: ownerKey };
  const owner = ownerRef.current;
  const ownerMounted = useRef(true);
  const ownsWorkspace = () => ownerMounted.current && ownerRef.current === owner;
  useEffect(() => {
    ownerMounted.current = true;
    return () => { if (ownerRef.current === owner) ownerMounted.current = false; };
  }, [owner]);
  const guardSetter = <Value,>(setter: Dispatch<SetStateAction<Value>>) => (update: SetStateAction<Value>) => {
    if (!ownsWorkspace()) return;
    setter(current => {
      if (!ownsWorkspace()) return current;
      return typeof update === "function" ? (update as (current: Value) => Value)(current) : update;
    });
  };
  const loadWorkspaceState = (profileId: string, serverId: string, threadId: string) => loadAuthorizedWorkspaceState(profileId, serverId, threadId, workspaceStorageScope);
  const saveWorkspaceState = (profileId: string, serverId: string, threadId: string, update: Partial<WorkspaceViewState>) => {
    if (!workspaceStorageScope && !demo)
      return Promise.reject(new Error(t("task.workspace_scope_not_confirmed")));
    return saveAuthorizedWorkspaceState(profileId, serverId, threadId, update, workspaceStorageScope, workspaceProfileIdentity);
  };

  const [task, setTaskRaw] = useState<TaskRuntime | null>(
    () =>
      taskRuntimeRegistry.get(
        params.profileId,
        params.serverId,
        params.threadId,
      ) ?? null,
  );
  const setTask = guardSetter(setTaskRaw);

  const taskScopeMatches = Boolean(task && task.getSnapshot().threadId === params.threadId && profileReady && activeProfile && server && (
    demo || (task.reconnectContext && task.reconnectContext.profile.deviceId === activeProfile.deviceId && threadListScopeKey(task.reconnectContext.profile, task.reconnectContext.server) === threadListScopeKey(activeProfile, server))
  ));
  useEffect(() => {
    if (!ownsWorkspace() || !task || !profileReady || !server || taskScopeMatches) return;
    if (taskRuntimeRegistry.get(params.profileId, params.serverId, params.threadId) === task)
      taskRuntimeRegistry.remove(params.profileId, params.serverId, params.threadId);
    setTask(null);
  }, [task, profileReady, server, taskScopeMatches, params.profileId, params.serverId, params.threadId]);

  // A real focused task-route commit, rather than router.replace, acknowledges delivery.
  useEffect(() => {
    if (!isFocused || !ownsWorkspace() || demo || !task || !taskScopeMatches || !activeProfile || !server) return;
    let cancelled = false, checking = false, rerun = false;
    const confirm = async () => {
      if (checking) { rerun = true; return; }
      if (cancelled || !ownsWorkspace() || task.isDisposed()) return;
      checking = true;
      try {
        const found = await loadWorkspaceTaskHandoff(activeProfile, server, params.creationRequestId ? { creationRequestId: params.creationRequestId } : { cwd: task.getSnapshot().cwd, threadId: params.threadId });
        if (!found || cancelled || !ownsWorkspace() || task.isDisposed() || found.value.threadId !== params.threadId || task.getSnapshot().threadId !== params.threadId) return;
        const linkedTurn = found.value.linked!.turn;
        // The durable receipt cannot outlive its recovery locator before the same
        // Runtime has applied the exact original acceptance result.
        if (["sent", "unknown"].includes(linkedTurn.phase) || task.getSnapshot().sendAcceptanceUnknown) {
          if (!linkedTurn.params || linkedTurn.params.threadId !== params.threadId || linkedTurn.params.clientMessageId !== linkedTurn.clientMessageId)
            throw new Error(t("task.original_first_send_identity_unconfirmed"));
          if (task.uncertainSend && (task.uncertainSend.threadId !== linkedTurn.params.threadId || task.uncertainSend.clientMessageId !== linkedTurn.clientMessageId))
            throw new Error(t("task.current_send_does_not_match_original_handoff"));
          task.uncertainSend = linkedTurn.params;
          task.patch({ sendAcceptanceUnknown: true });
          await task.reconcileSendAcceptance();
        }
        await confirmWorkspaceTaskRoute(activeProfile, server, found.handle, params.threadId, () => !cancelled && ownsWorkspace() && isFocused && !task.isDisposed() && task.getSnapshot().threadId === params.threadId && !task.getSnapshot().sendAcceptanceUnknown);
      } catch {
        if (!cancelled && ownsWorkspace())
          task.patch({ error: t("task.original_handoff_send_unconfirmed") });
      }
      finally { checking = false; if (rerun) { rerun = false; if (!cancelled) void confirm(); } }
    };
    void confirm();
    let wasUnknown = task.getSnapshot().sendAcceptanceUnknown;
    const unsubscribe = task.subscribe(() => { const unknown = task.getSnapshot().sendAcceptanceUnknown; if (wasUnknown && !unknown) void confirm(); wasUnknown = unknown; });
    return () => { cancelled = true; unsubscribe(); };
  }, [owner, isFocused, demo, task, taskScopeMatches, activeProfile, server, params.threadId, params.creationRequestId]);

  const [loadErrorEntry, setLoadErrorRaw] = useState<{ owner: typeof owner; error: string | null } | null>(null);
  const loadError = loadErrorEntry?.owner === owner ? loadErrorEntry.error : null;
  const setLoadError = (error: string | null) => guardSetter(setLoadErrorRaw)({ owner, error });

  const [panels, setPanelsRaw] = useState<WorkspacePanelState[]>(() =>
    defaultWorkspacePanels(),
  );
  const setPanels = guardSetter(setPanelsRaw);

  const panelsRef = useRef(panels);

  panelsRef.current = panels;

  const [activePanelId, setActivePanelIdRaw] = useState("agent");
  const setActivePanelId = guardSetter(setActivePanelIdRaw);

  const [mountedPanelIds, setMountedPanelIdsRaw] = useState<Set<string>>(
    () => new Set(["agent"]),
  );
  const setMountedPanelIds = guardSetter(setMountedPanelIdsRaw);

  const [panelMenuOpen, setPanelMenuOpenRaw] = useState(false);
  const setPanelMenuOpen = guardSetter(setPanelMenuOpenRaw);

  const [tabSwitcherOpen, setTabSwitcherOpenRaw] = useState(false);
  const setTabSwitcherOpen = guardSetter(setTabSwitcherOpenRaw);

  const drawerOwner = useRef(owner);
  const drawerOwnerMatches = drawerOwner.current === owner;
  const [drawerOpenState, setDrawerOpenRaw] = useState(false);
  const drawerOpen = drawerOwnerMatches && drawerOpenState;
  const setDrawerOpen = guardSetter(setDrawerOpenRaw);
  const drawerClosing = useRef(false);

  const [taskMenuOpen, setTaskMenuOpenRaw] = useState(false);
  const setTaskMenuOpen = guardSetter(setTaskMenuOpenRaw);

  const [drawerThreadsState, setDrawerThreadsRaw] = useState<
    Record<string, ThreadSummary[]>
  >({});
  const drawerThreads: Record<string, ThreadSummary[]> = drawerOwnerMatches ? drawerThreadsState : {};
  const setDrawerThreads = guardSetter(setDrawerThreadsRaw);

  const drawerProjection = useRef(new ThreadListProjection());
  const drawerWorkspaceOptionsRef = useRef<Record<string, WorkspaceOption[]>>(
    {},
  );

  const [drawerReloadRevision, setDrawerReloadRevisionRaw] = useState(0);
  const setDrawerReloadRevision = guardSetter(setDrawerReloadRevisionRaw);
  const [drawerLoadingState, setDrawerLoadingRaw] = useState<Record<string, boolean>>({});
  const drawerLoading: Record<string, boolean> = drawerOwnerMatches ? drawerLoadingState : {};
  const setDrawerLoading = guardSetter(setDrawerLoadingRaw);
  const [drawerHasMoreState, setDrawerHasMoreRaw] = useState<Record<string, boolean>>({});
  const drawerHasMore: Record<string, boolean> = drawerOwnerMatches ? drawerHasMoreState : {};
  const setDrawerHasMore = guardSetter(setDrawerHasMoreRaw);
  const drawerSession = useRef<{
    controller: AbortController;
    owner: typeof owner;
    pagers: Map<string, { pager: ThreadListPager; serverId: string; cursor?: string; loaded?: boolean }>;
    jobs: Map<string, Promise<void>>;
    profile: NonNullable<typeof activeProfile>;
  } | null>(null);

  const dismissDrawerWork = useCallback(() => {
    if (!ownsWorkspace()) return;
    drawerClosing.current = true;
    stopDrawerSession(drawerSession);
  }, [owner]);

  const openDrawer = useCallback(() => {
    if (!ownsWorkspace() || !drawerOwnerMatches || drawerOpen) return;
    drawerClosing.current = false;
    setDrawerOpen(true);
  }, [drawerOpen, owner, drawerOwnerMatches]);


  const [drawerThreadErrorsState, setDrawerThreadErrorsRaw] = useState<
    Record<string, string>
  >({});
  const drawerThreadErrors: Record<string, string> = drawerOwnerMatches ? drawerThreadErrorsState : {};
  const setDrawerThreadErrors = guardSetter(setDrawerThreadErrorsRaw);

  const [drawerWorkspaceOptionsState, setDrawerWorkspaceOptionsRaw] = useState<
    Record<string, WorkspaceOption[]>
  >({});
  const drawerWorkspaceOptions: Record<string, WorkspaceOption[]> = drawerOwnerMatches ? drawerWorkspaceOptionsState : {};
  const setDrawerWorkspaceOptions = guardSetter(setDrawerWorkspaceOptionsRaw);

  const [drawerWorkspaceErrorsState, setDrawerWorkspaceErrorsRaw] = useState<
    Record<string, string>
  >({});
  const drawerWorkspaceErrors: Record<string, string> = drawerOwnerMatches ? drawerWorkspaceErrorsState : {};
  const setDrawerWorkspaceErrors = guardSetter(setDrawerWorkspaceErrorsRaw);

  const [dirtyFilePanelIds, setDirtyFilePanelIdsRaw] = useState<Set<string>>(
    () => new Set(),
  );
  const setDirtyFilePanelIds = guardSetter(setDirtyFilePanelIdsRaw);
  const [savingFilePanelIds, setSavingFilePanelIdsRaw] = useState<Set<string>>(
    () => new Set(),
  );
  const setSavingFilePanelIds = guardSetter(setSavingFilePanelIdsRaw);
  const savingFilePanelIdsRef = useRef(savingFilePanelIds);

  const reportFilePanelSavePending = useCallback(
    (panelId: string, pending: boolean) => {
      if (!ownsWorkspace()) return;
      const next = new Set(savingFilePanelIdsRef.current);
      if (pending) next.add(panelId);
      else next.delete(panelId);
      savingFilePanelIdsRef.current = next;
      setSavingFilePanelIds(next);
    },
    [owner],
  );

  const [fileOpenRequests, setFileOpenRequestsRaw] = useState<
    Record<
      string,
      { path: string; revision: number; line?: number; column?: number }
    >
  >({});
  const setFileOpenRequests = guardSetter(setFileOpenRequestsRaw);

  const fileOpenRevision = useRef(0);

  const fileDirty = dirtyFilePanelIds.size > 0;

  const [workspaceEntry, setWorkspaceEntry] = useState<{
    owner: typeof owner;
    state: WorkspaceViewState;
    hydrated: boolean;
    error: string | null;
  }>(() => ({ owner, state: { activeTab: "agent" }, hydrated: false, error: null }));
  const workspaceState: WorkspaceViewState = workspaceEntry.owner === owner ? workspaceEntry.state : { activeTab: "agent" as const };
  const workspaceStateHydrated = workspaceEntry.owner === owner && workspaceEntry.hydrated;
  const workspaceStateError = workspaceEntry.owner === owner ? workspaceEntry.error : null;
  const [workspaceRetryRevision, setWorkspaceRetryRevisionRaw] = useState(0);
  const setWorkspaceRetryRevision = guardSetter(setWorkspaceRetryRevisionRaw);
  const setWorkspaceState = (update: SetStateAction<WorkspaceViewState>) => {
    if (!ownsWorkspace()) return;
    setWorkspaceEntry(current => {
      if (!ownsWorkspace()) return current;
      const entry = current.owner === owner ? current : { owner, state: { activeTab: "agent" as const }, hydrated: false, error: null };
      return { ...entry, state: typeof update === "function" ? update(entry.state) : update };
    });
  };
  const retryWorkspaceState = () => {
    if (!ownsWorkspace()) return;
    setWorkspaceRetryRevision(current => current + 1);
  };

  useEffect(() => {
    if (Platform.OS !== "web" || !fileDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", beforeUnload);
    return () => globalThis.removeEventListener("beforeunload", beforeUnload);
  }, [fileDirty]);

  useEffect(() => {
    if (isFocused && task?.isDisposed()) setTask(null);
  }, [isFocused, task]);

  useEffect(() => {
    if (
      shouldActivateRouteProfile({
        focused: isFocused,
        hydrated,
        routeProfileId: params.profileId,
        activeProfileId: activeProfile?.id,
        profileIds: profiles.map((profile) => profile.id),
      })
    ) {
      void setActiveProfile(params.profileId);
    }
  }, [
    activeProfile?.id,
    hydrated,
    isFocused,
    params.profileId,
    profiles,
    setActiveProfile,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!ownsWorkspace()) return;
    if (!drawerOwnerMatches) {
      // Published props are already fenced during render. Retire the old scope's
      // resources before admitting any work for the new drawer.
      stopDrawerSession(drawerSession);
      drawerProjection.current = new ThreadListProjection();
      drawerWorkspaceOptionsRef.current = {};
      drawerClosing.current = false;
      setDrawerOpen(false);
      setDrawerThreads({});
      setDrawerWorkspaceOptions({});
      setDrawerThreadErrors({});
      setDrawerWorkspaceErrors({});
      setDrawerLoading({});
      setDrawerHasMore({});
      drawerOwner.current = owner;
    }
    setWorkspaceEntry(current => ownsWorkspace() ? { owner, state: { activeTab: "agent" }, hydrated: false, error: null } : current);
    setLoadError(null);
    if (!workspaceStorageScope && !demo) return;
    void loadWorkspaceState(params.profileId, params.serverId, params.threadId)
      .then((stored) => {
        if (cancelled || !ownsWorkspace()) return;
        const restoredPanels = defaultWorkspacePanels(stored);
        const restoredPanelId = initialPanelId(stored, restoredPanels);
        setWorkspaceEntry(current => cancelled || !ownsWorkspace() ? current : { owner, state: stored, hydrated: true, error: null });
        panelsRef.current = restoredPanels;
        setPanels(restoredPanels);
        setActivePanelId(restoredPanelId);
        setMountedPanelIds(new Set(["agent", restoredPanelId]));
        setDirtyFilePanelIds(new Set());
        savingFilePanelIdsRef.current = new Set();
        setSavingFilePanelIds(new Set());
        setFileOpenRequests({});
      })
      .catch((error: unknown) => {
        if (cancelled || !ownsWorkspace()) return;
        setWorkspaceEntry(current => cancelled || !ownsWorkspace() ? current : {
          owner, state: { activeTab: "agent" }, hydrated: false,
          error: t("task.local_workspace_restore_failed", {
            p0: error instanceof Error ? error.message : String(error),
          }),
        });
      });
    return () => { cancelled = true; };
  }, [params.profileId, params.serverId, params.threadId, workspaceStorageScope, owner, workspaceRetryRevision]);

  const selectPanel = (panel: WorkspacePanelState) => {
    if (!ownsWorkspace() || !workspaceStateHydrated) return;
    Keyboard.dismiss();
    setMountedPanelIds((current) => new Set([...current, panel.id]));
    setActivePanelId(panel.id);
    setWorkspaceState((current) => ({
      ...current,
      activeTab: panel.kind,
      activePanelId: panel.id,
      panels,
    }));
    void saveWorkspaceState(
      params.profileId,
      params.serverId,
      params.threadId,
      { activeTab: panel.kind, activePanelId: panel.id, panels },
    ).catch(() => {});
  };

  const persistWorkspaceState = useCallback(
    (update: Partial<WorkspaceViewState>) => {
      if (!ownsWorkspace() || !workspaceStateHydrated)
        return Promise.reject(
          new Error(t("task.workspace_not_restored_or_changed")),
        );
      setWorkspaceState((current) => ({ ...current, ...update }));
      return saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        update,
      ).then(() => undefined);
    },
    [params.profileId, params.serverId, params.threadId, workspaceStorageScope, owner, workspaceStateHydrated],
  );

  const persistComposerDraft = useCallback(
    (composerDraft: string | undefined) =>
      persistWorkspaceState({ composerDraft }),
    [persistWorkspaceState],
  );

  const persistQueueCommit = useCallback(async (value: Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">) => {
    if (!ownsWorkspace() || !workspaceStateHydrated)
      throw new Error(t("task.workspace_not_restored_or_changed"));
    await saveWorkspaceState(params.profileId, params.serverId, params.threadId, value);
    setWorkspaceState((current) => ({ ...current, ...value }));
  }, [params.profileId, params.serverId, params.threadId, workspaceStorageScope, owner, workspaceStateHydrated]);

  const persistQueuedMessages = useCallback(
    (queuedMessages: WorkspaceViewState["queuedMessages"]) =>
      persistWorkspaceState({ queuedMessages }),
    [persistWorkspaceState],
  );

  const persistFailedSubmissions = useCallback(
    (failedSubmissions: WorkspaceViewState["failedSubmissions"]) =>
      persistWorkspaceState({ failedSubmissions }),
    [persistWorkspaceState],
  );

  const persistTurnPreferences = useCallback(
    (model: string, reasoningEffort?: string) =>
      persistWorkspaceState({ model, reasoningEffort }),
    [persistWorkspaceState],
  );

  const updatePanel = useCallback(
    (panelId: string, update: Partial<WorkspacePanelState>) => {
      if (!ownsWorkspace() || !workspaceStateHydrated) return;
      let changed = false;
      const next = panelsRef.current.map((panel) => {
        if (panel.id !== panelId) return panel;
        if (
          Object.entries(update).every(([key, value]) =>
            Object.is(panel[key as keyof WorkspacePanelState], value),
          )
        )
          return panel;
        changed = true;
        return { ...panel, ...update, id: panel.id, kind: panel.kind };
      });
      if (!changed) return;
      panelsRef.current = next;
      setPanels(next);
      setWorkspaceState((state) => ({ ...state, panels: next }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        { panels: next },
      ).catch(() => {});
    },
    [params.profileId, params.serverId, params.threadId, workspaceStorageScope, owner, workspaceStateHydrated],
  );

  const addPanel = (kind: Exclude<WorkspaceTab, "agent">) => {
    if (!ownsWorkspace() || !workspaceStateHydrated) return;
    if (panels.length >= 12) return;
    const count = panels.filter((panel) => panel.kind === kind).length + 1;
    const id = `${kind}-${Date.now().toString(36)}`;
    const label =
      kind === "changes"
        ? t("task.changes")
        : kind === "terminal"
          ? t("task.terminal")
          : kind === "browser"
            ? t("task.browser")
            : t("task.files");
    const nextPanel: WorkspacePanelState = {
      id,
      kind,
      title: `${label} ${count}`,
    };
    const next = [...panels, nextPanel];
    panelsRef.current = next;
    setPanels(next);
    setPanelMenuOpen(false);
    setMountedPanelIds((current) => new Set([...current, id]));
    setActivePanelId(id);
    setWorkspaceState((current) => ({
      ...current,
      activeTab: kind,
      activePanelId: id,
      panels: next,
    }));
    void saveWorkspaceState(
      params.profileId,
      params.serverId,
      params.threadId,
      { activeTab: kind, activePanelId: id, panels: next },
    ).catch(() => {});
  };

  const closePanel = (panelId: string) => {
    if (!ownsWorkspace() || !workspaceStateHydrated) return;
    if (panelId === "agent" || panelId === "changes") return;
    if (savingFilePanelIdsRef.current.has(panelId)) return;
    const closingPanel = panels.find((panel) => panel.id === panelId);
    const close = () => {
      if (!ownsWorkspace() || !workspaceStateHydrated) return;
      const index = panels.findIndex((panel) => panel.id === panelId);
      const next = panels.filter((panel) => panel.id !== panelId);
      const fallback =
        activePanelId === panelId
          ? (next[Math.max(0, Math.min(index - 1, next.length - 1))] ?? next[0])
          : next.find((panel) => panel.id === activePanelId);
      panelsRef.current = next;
      setPanels(next);
      setMountedPanelIds((current) => {
        const updated = new Set(current);
        updated.delete(panelId);
        return updated;
      });
      setDirtyFilePanelIds((current) => {
        const updated = new Set(current);
        updated.delete(panelId);
        return updated;
      });
      reportFilePanelSavePending(panelId, false);
      if (closingPanel?.kind === "terminal")
        task?.closeTerminalSession(panelId);
      if (fallback) setActivePanelId(fallback.id);
      setWorkspaceState((current) => ({
        ...current,
        activeTab: fallback?.kind ?? "agent",
        activePanelId: fallback?.id ?? "agent",
        panels: next,
      }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        {
          activeTab: fallback?.kind ?? "agent",
          activePanelId: fallback?.id ?? "agent",
          panels: next,
        },
      ).catch(() => {});
    };
    if (dirtyFilePanelIds.has(panelId)) {
      requestConfirmation({
        title: t("task.close_an_unsaved_file"),
        message: t("task.this_file_tab_has_unsaved_edits"),
        confirmLabel: t("task.discard_and_close"),
        destructive: true,
        onConfirm: close,
      });
      return;
    }
    if (
      closingPanel?.kind === "terminal" &&
      task?.isLiveTerminalSession(panelId)
    ) {
      requestConfirmation({
        title: t("task.close_terminal"),
        message: t(
          "task.closing_will_immediately_terminate_processes_running_in_this",
        ),
        confirmLabel: t("task.close_terminal_action"),
        destructive: true,
        onConfirm: close,
      });
      return;
    }
    close();
  };

  const openWorkspaceFile = useCallback(
    (rawLink: string): boolean => {
      if (!ownsWorkspace() || !workspaceStateHydrated || !taskScopeMatches || !task) return false;
      const location = workspaceFileLocationFromLink(
        rawLink,
        task.getSnapshot().cwd,
      );
      if (!location) return false;
      const { path } = location;
      let next = panelsRef.current;
      let panel = next.find(
        (candidate) =>
          candidate.kind === "files" && !dirtyFilePanelIds.has(candidate.id),
      );
      if (!panel) {
        if (next.length >= 12) {
          Alert.alert(
            t("task.unable_to_open_file"),
            t("task.all_file_tabs_have_unsaved_edits_and_the"),
          );
          return true;
        }
        panel = {
          id: `files-${Date.now().toString(36)}`,
          kind: "files",
          title: t("task.files"),
        };
        next = [...next, panel];
      }
      const title = path.split("/").at(-1) || t("task.files");
      next = next.map((candidate) =>
        candidate.id === panel!.id ? { ...candidate, title } : candidate,
      );
      panel = next.find((candidate) => candidate.id === panel!.id)!;
      panelsRef.current = next;
      setPanels(next);
      setMountedPanelIds((current) => new Set([...current, panel!.id]));
      setActivePanelId(panel.id);
      setFileOpenRequests((current) => ({
        ...current,
        [panel!.id]: { ...location, revision: ++fileOpenRevision.current },
      }));
      const update = {
        activeTab: "files" as const,
        activePanelId: panel.id,
        panels: next,
      };
      setWorkspaceState((current) => ({ ...current, ...update }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        update,
      ).catch(() => {});
      Keyboard.dismiss();
      return true;
    },
    [
      dirtyFilePanelIds,
      params.profileId,
      params.serverId,
      params.threadId,
      task,
      taskScopeMatches,
      workspaceStorageScope,
      owner,
      workspaceStateHydrated,
    ],
  );

  useEffect(() => {
    if (
      task ||
      !workspaceStateHydrated ||
      !profileReady ||
      appRuntime.reauthorizationRequired ||
      !activeProfile ||
      !server
    )
      return;
    const capturedAuthorizationScope = profileAuthorizationScopeKey(activeProfile);
    let cancelled = false;
    let creationClaim: TaskCreationClaim | undefined;
    const load = async () => {
      try {
        const recoveryCwd = params.cwd;
        const linked = !demo && (params.creationRequestId || recoveryCwd) ? await loadWorkspaceTaskHandoff(activeProfile, server, params.creationRequestId ? { creationRequestId: params.creationRequestId } : { cwd: recoveryCwd!, threadId: params.threadId }) : null;
        if (cancelled || !ownsWorkspace()) return;
        if (linked && linked.value.threadId !== params.threadId)
          throw new Error(t("task.route_original_handoff_mismatch"));
        const resumed = linked ? await (() => {
          creationClaim = TaskRuntime.claimCreation({ ...linked.value.linked!.input, profile: activeProfile, server, workspaceHandoff: linked.handle, onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, capturedAuthorizationScope) }, taskRuntimeRegistry);
          return creationClaim.result;
        })() : demo ? TaskRuntime.demo(params.threadId) : await TaskRuntime.resume({
          profile: activeProfile, server, threadId: params.threadId, cwd: params.cwd, title: params.title,
          reasoningEffort: workspaceState.reasoningEffort, onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, capturedAuthorizationScope),
        });
        if (cancelled || !ownsWorkspace()) {
          if (!creationClaim) resumed.close();
          return;
        }
        if (creationClaim) {
          if (!creationClaim.adopt(taskRuntimeRegistry, activeProfile.id, server.id))
            throw new Error(t("task.original_task_connection_released"));
        }
        else taskRuntimeRegistry.put(activeProfile.id, server.id, resumed);
        setTask(resumed);
      } catch (value) {
        if (!cancelled && ownsWorkspace()) setLoadError(taskOpenError(value));
      } finally { creationClaim?.release(); }
    };
    void load();
    return () => {
      cancelled = true; creationClaim?.release();
    };
  }, [
    activeProfile,
    demo,
    markGatewayReauthorizationRequired,
    params.cwd,
    params.threadId,
    params.creationRequestId,
    params.title,
    profileReady,
    server,
    task,
    workspaceState.reasoningEffort,
    workspaceStateHydrated,
    appRuntime.reauthorizationRequired,
    owner,
  ]);

  const loadDrawerServer = useCallback((serverId: string, more = false): Promise<void> => {
    const session = drawerSession.current;
    const item = appRuntime.servers.find((value) => value.id === serverId);
    if (!ownsWorkspace() || drawerClosing.current || !session || session.owner !== owner || !item || session.controller.signal.aborted) return Promise.resolve();
    const previous = session.jobs.get(serverId);
    if (previous) return previous;
    const revision = drawerProjection.current.revision;
    const current = () => ownsWorkspace() && drawerSession.current === session && !session.controller.signal.aborted && revision === drawerProjection.current.revision;
    const job = (async () => {
      setDrawerLoading((value) => ({ ...value, [serverId]: true }));
      try {
        if (!more) {
          const initialServer = serverId === params.serverId && params.cwd ? { ...item, workspacePath: params.cwd } : item;
          const scope = threadListScopeKey(session.profile, initialServer, { archived: false });
          if (!session.pagers.has(scope)) session.pagers.set(scope, {
            pager: new ThreadListPager(session.profile, initialServer, { archived: false }, "background"), serverId,
          });
        }
        const entries = [...session.pagers.entries()].filter(([, value]) => value.serverId === serverId);
        for (const [scope, state] of entries) {
          if (!current()) return;
          if ((more && !state.cursor) || (!more && state.loaded)) continue;
          const page = await state.pager.page(more ? state.cursor : undefined, 50);
          if (!current()) return;
          state.cursor = page.nextCursor;
          state.loaded = true;
          if (!state.cursor) state.pager.close();
          drawerProjection.current.update(scope, page);
          const notice = threadListNotice(page);
          if (notice) setDrawerThreadErrors((value) => ({ ...value, [serverId]: notice }));
        }
        if (!current()) return;
        setDrawerThreads((value) => ({ ...value, [serverId]: entries.flatMap(([scope]) => drawerProjection.current.get(scope)?.threads ?? []) }));
        setDrawerHasMore((value) => ({ ...value, [serverId]: entries.some(([, state]) => Boolean(state.cursor)) }));
      } catch (error) {
        if (current()) setDrawerThreadErrors((value) => ({ ...value, [serverId]: error instanceof Error ? error.message : String(error) }));
      } finally {
        session.jobs.delete(serverId);
        if (drawerSession.current === session) setDrawerLoading((value) => ({ ...value, [serverId]: false }));
      }
    })();
    session.jobs.set(serverId, job);
    return job;
  }, [appRuntime.servers, params.serverId, params.cwd, owner]);

  const loadDrawerProjects = useCallback(async (serverId: string) => {
    const session = drawerSession.current;
    const item = appRuntime.servers.find((value) => value.id === serverId);
    if (!ownsWorkspace() || drawerClosing.current || !session || session.owner !== owner || !item || session.controller.signal.aborted) return;
    const key = `projects:${serverId}`;
    if (session.jobs.has(key)) return session.jobs.get(key);
    const job = (async () => {
      const cacheKey = threadListScopeKey(session.profile, item);
      const resolved = await listWorkspaceThreadScopes(session.profile, item, drawerWorkspaceOptionsRef.current[cacheKey] ?? [], {
        signal: session.controller.signal, priority: "background",
      });
      if (!ownsWorkspace() || drawerSession.current !== session || session.controller.signal.aborted) return;
      drawerWorkspaceOptionsRef.current[cacheKey] = resolved.options;
      setDrawerWorkspaceOptions((value) => ({ ...value, [serverId]: resolved.options }));
      setDrawerWorkspaceErrors((value) => ({ ...value, [serverId]: resolved.error ?? "" }));
      for (const workspaceServer of resolved.servers) {
        const scope = threadListScopeKey(session.profile, workspaceServer, { archived: false });
        if (!session.pagers.has(scope)) session.pagers.set(scope, { pager: new ThreadListPager(session.profile, workspaceServer, { archived: false }, "background"), serverId });
      }
      await loadDrawerServer(serverId);
    })().finally(() => session.jobs.delete(key));
    session.jobs.set(key, job);
    return job;
  }, [appRuntime.servers, loadDrawerServer, owner]);

  useEffect(() => {
    if (drawerClosing.current || !drawerOpen || !profileReady || !activeProfile || !server || appRuntime.reauthorizationRequired) return;
    if (demo) {
      setDrawerThreads({ [server.id]: task ? [{ id: task.getSnapshot().threadId, title: task.getSnapshot().title, status: "idle", cwd: task.getSnapshot().cwd, createdAt: Date.now(), updatedAt: Date.now() }] : [] });
      return;
    }
    const session = { owner, controller: new AbortController(), pagers: new Map(), jobs: new Map(), profile: activeProfile };
    drawerSession.current = session;
    setDrawerThreadErrors({});
    void loadDrawerServer(server.id);
    return () => {
      stopDrawerSession(drawerSession, session);
    };
  }, [drawerOpen, activeProfile, profileReady, server, demo, drawerReloadRevision, loadDrawerServer, appRuntime.reauthorizationRequired]);

  useEffect(() => {
    if (demo || !activeProfile) return;
    const profile = activeProfile;
    return subscribeThreadMutations((event) => {
      if (!ownsWorkspace()) return;
      const item = appRuntime.servers.find((candidate) => candidate.id === event.serverId);
      if (!item) return;
      const options = drawerWorkspaceOptionsRef.current[threadListScopeKey(profile, item)] ?? drawerWorkspaceOptions[item.id] ?? [];
      const filter = { archived: false };
      const scopes = threadMutationWorkspaceServers(
        drawerProjection.current,
        profile,
        item,
        options,
        filter,
        event,
      );
      if (scopes.length === 0) return;
      for (const scope of scopes)
        acknowledgeThreadMutationAtWorkspace(
          drawerProjection.current,
          profile,
          item,
          scope.workspacePath,
          event.cwd,
          filter,
          event.threadId,
          event.mutation,
        );
      setDrawerThreads((current) => ({
        ...current,
        [item.id]: projectWorkspaceThreadRows(
          drawerProjection.current,
          profile,
          item,
          options,
          filter,
          scopes,
        ),
      }));
      setDrawerReloadRevision((value) => value + 1);
    });
  }, [activeProfile?.id, activeProfile?.baseUrl, appRuntime.servers, demo, drawerWorkspaceOptions, owner]);

  useEffect(
    () => () => {
      if (task?.getSnapshot().archivedAt && taskRuntimeRegistry.get(params.profileId, params.serverId, params.threadId) === task) {
        taskRuntimeRegistry.remove(
          params.profileId,
          params.serverId,
          params.threadId,
        );
      }
    },
    [params.profileId, params.serverId, params.threadId, task],
  );

  const routeError = appRuntime.reauthorizationRequired && profileReady
    ? t("task.gateway_session_reauthorization_needed")
    : invalidProfile
    ? t("task.this_task_link_points_to_a_removed_gateway")
    : profileReady && !appRuntime.loading && !server
      ? t("task.this_task_link_points_to_a_missing_or")
      : null;
  return {
    params,
    router,
    isFocused,
    insets,
    activeProfile,
    appRuntime,
    demo,
    goBack,
    ownsWorkspace,
    profileReady,
    server,
    task: taskScopeMatches ? task : null,
    loadError,
    panels,
    panelsRef,
    activePanelId,
    mountedPanelIds,
    panelMenuOpen,
    setPanelMenuOpen,
    tabSwitcherOpen,
    setTabSwitcherOpen,
    drawerOpen,
    setDrawerOpen,
    openDrawer,
    dismissDrawerWork,
    taskMenuOpen,
    setTaskMenuOpen,
    drawerThreads,
    setDrawerThreads,
    drawerProjection,
    setDrawerReloadRevision,
    drawerThreadErrors,
    drawerWorkspaceOptions,
    drawerWorkspaceErrors,
    drawerLoading,
    drawerHasMore,
    loadDrawerServer,
    loadDrawerProjects,
    setDirtyFilePanelIds,
    savingFilePanelIds,
    reportFilePanelSavePending,
    fileOpenRequests,
    workspaceState,
    workspaceStorageScope,
    workspaceStateHydrated,
    workspaceStateError,
    retryWorkspaceState,
    selectPanel,
    persistComposerDraft,
    persistQueuedMessages,
    persistQueueCommit,
    persistFailedSubmissions,
    persistTurnPreferences,
    updatePanel,
    addPanel,
    closePanel,
    openWorkspaceFile,
    routeError,
  };
}
