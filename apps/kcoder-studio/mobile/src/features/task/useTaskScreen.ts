import { workspaceFileLocationFromLink } from "@/components/workspace-file-links";
import type { ThreadSummary } from "@/gateway/types";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { requestConfirmation } from "@/platform/confirmation";
import {
  listThreads,
  listWorkspaceOptions,
  TaskRuntime,
  taskRuntimeRegistry,
  type WorkspaceOption,
} from "@/runtime/task-runtime";
import {
  threadListNotice,
  ThreadListProjection,
  threadListScopeKey,
} from "@/runtime/thread-list-projection";
import { useApp } from "@/state/AppContext";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import {
  loadWorkspaceState,
  saveWorkspaceState,
  type WorkspacePanelState,
  type WorkspaceTab,
  type WorkspaceViewState,
} from "@/storage/workspace-preferences";
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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

  const goBack = () => backOrReplace(router, profileHomeHref(params.profileId));

  const profileReady = activeProfile?.id === params.profileId;

  const invalidProfile =
    hydrated && !profiles.some((profile) => profile.id === params.profileId);

  const server = profileReady
    ? appRuntime.servers.find((item) => item.id === params.serverId)
    : undefined;

  const [task, setTask] = useState<TaskRuntime | null>(
    () =>
      taskRuntimeRegistry.get(
        params.profileId,
        params.serverId,
        params.threadId,
      ) ?? null,
  );

  const [loadError, setLoadError] = useState<string | null>(null);

  const [panels, setPanels] = useState<WorkspacePanelState[]>(() =>
    defaultWorkspacePanels(),
  );

  const panelsRef = useRef(panels);

  panelsRef.current = panels;

  const [activePanelId, setActivePanelId] = useState("agent");

  const [mountedPanelIds, setMountedPanelIds] = useState<Set<string>>(
    () => new Set(["agent"]),
  );

  const [panelMenuOpen, setPanelMenuOpen] = useState(false);

  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);

  const [taskMenuOpen, setTaskMenuOpen] = useState(false);

  const [drawerThreads, setDrawerThreads] = useState<
    Record<string, ThreadSummary[]>
  >({});

  const drawerProjection = useRef(new ThreadListProjection());

  const [drawerReloadRevision, setDrawerReloadRevision] = useState(0);

  const [drawerThreadErrors, setDrawerThreadErrors] = useState<
    Record<string, string>
  >({});

  const [drawerWorkspaceOptions, setDrawerWorkspaceOptions] = useState<
    Record<string, WorkspaceOption[]>
  >({});

  const [drawerWorkspaceErrors, setDrawerWorkspaceErrors] = useState<
    Record<string, string>
  >({});

  const [dirtyFilePanelIds, setDirtyFilePanelIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [fileOpenRequests, setFileOpenRequests] = useState<
    Record<
      string,
      { path: string; revision: number; line?: number; column?: number }
    >
  >({});

  const fileOpenRevision = useRef(0);

  const fileDirty = dirtyFilePanelIds.size > 0;

  const [workspaceState, setWorkspaceState] = useState<WorkspaceViewState>({
    activeTab: "agent",
  });

  const [workspaceStateHydrated, setWorkspaceStateHydrated] = useState(false);

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
    setWorkspaceStateHydrated(false);
    void loadWorkspaceState(params.profileId, params.serverId, params.threadId)
      .then((stored) => {
        if (cancelled) return;
        const restoredPanels = defaultWorkspacePanels(stored);
        const restoredPanelId = initialPanelId(stored, restoredPanels);
        setWorkspaceState(stored);
        panelsRef.current = restoredPanels;
        setPanels(restoredPanels);
        setActivePanelId(restoredPanelId);
        setMountedPanelIds((current) => new Set([...current, restoredPanelId]));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setWorkspaceStateHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [params.profileId, params.serverId, params.threadId]);

  const selectPanel = (panel: WorkspacePanelState) => {
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
      setWorkspaceState((current) => ({ ...current, ...update }));
      void saveWorkspaceState(
        params.profileId,
        params.serverId,
        params.threadId,
        update,
      ).catch(() => {});
    },
    [params.profileId, params.serverId, params.threadId],
  );

  const persistComposerDraft = useCallback(
    (composerDraft: string | undefined) =>
      persistWorkspaceState({ composerDraft }),
    [persistWorkspaceState],
  );

  const persistQueuedMessages = useCallback(
    (queuedMessages: WorkspaceViewState["queuedMessages"]) =>
      persistWorkspaceState({ queuedMessages }),
    [persistWorkspaceState],
  );

  const persistTurnPreferences = useCallback(
    (model: string, reasoningEffort?: string) =>
      persistWorkspaceState({ model, reasoningEffort }),
    [persistWorkspaceState],
  );

  const updatePanel = useCallback(
    (panelId: string, update: Partial<WorkspacePanelState>) => {
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
    [params.profileId, params.serverId, params.threadId],
  );

  const addPanel = (kind: Exclude<WorkspaceTab, "agent">) => {
    if (panels.length >= 12) return;
    const count = panels.filter((panel) => panel.kind === kind).length + 1;
    const id = `${kind}-${Date.now().toString(36)}`;
    const label =
      kind === "changes"
        ? "变更"
        : kind === "terminal"
          ? "终端"
          : kind === "browser"
            ? "浏览器"
            : "文件";
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
    if (panelId === "agent" || panelId === "changes") return;
    const closingPanel = panels.find((panel) => panel.id === panelId);
    const close = () => {
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
        title: "关闭未保存的文件？",
        message: "这个文件标签中还有未保存的编辑。",
        confirmLabel: "放弃并关闭",
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
        title: "关闭终端？",
        message: "关闭会立即终止这个终端中正在运行的进程。",
        confirmLabel: "关闭终端",
        destructive: true,
        onConfirm: close,
      });
      return;
    }
    close();
  };

  const openWorkspaceFile = useCallback(
    (rawLink: string): boolean => {
      if (!task) return false;
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
            "无法打开文件",
            "所有文件标签都有未保存内容，且工作区已达到 12 个标签上限。请先保存或关闭一个标签。",
          );
          return true;
        }
        panel = {
          id: `files-${Date.now().toString(36)}`,
          kind: "files",
          title: "文件",
        };
        next = [...next, panel];
      }
      const title = path.split("/").at(-1) || "文件";
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
    ],
  );

  useEffect(() => {
    if (
      task ||
      !workspaceStateHydrated ||
      !profileReady ||
      !activeProfile ||
      !server
    )
      return;
    let cancelled = false;
    const load = async () => {
      try {
        const resumed = demo
          ? TaskRuntime.demo(params.threadId)
          : await TaskRuntime.resume({
              profile: activeProfile,
              server,
              threadId: params.threadId,
              cwd: params.cwd,
              title: params.title,
              reasoningEffort: workspaceState.reasoningEffort,
              onSessionExpired: () =>
                markGatewayReauthorizationRequired(activeProfile.id),
            });
        if (cancelled) {
          resumed.close();
          return;
        }
        taskRuntimeRegistry.put(activeProfile.id, server.id, resumed);
        setTask(resumed);
      } catch (value) {
        if (!cancelled) setLoadError(taskOpenError(value));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    activeProfile,
    demo,
    markGatewayReauthorizationRequired,
    params.cwd,
    params.threadId,
    params.title,
    profileReady,
    server,
    task,
    workspaceState.reasoningEffort,
    workspaceStateHydrated,
  ]);

  useEffect(() => {
    if (!profileReady || !activeProfile || !server) return;
    if (demo) {
      setDrawerThreads({
        [server.id]: task
          ? [
              {
                id: task.getSnapshot().threadId,
                title: task.getSnapshot().title,
                status: "idle",
                cwd: task.getSnapshot().cwd,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ]
          : [],
      });
      setDrawerWorkspaceOptions({
        [server.id]: [
          {
            path: task?.getSnapshot().cwd ?? server.workspacePath ?? "/",
            label: "KCoder",
            kind: "workspace",
          },
        ],
      });
      setDrawerWorkspaceErrors({});
      return;
    }
    let cancelled = false;
    drawerProjection.current.retainScopes(
      appRuntime.servers.map((item) =>
        threadListScopeKey(activeProfile, item, { archived: false }),
      ),
    );
    const mutationRevision = drawerProjection.current.revision;
    setDrawerThreads(
      Object.fromEntries(
        appRuntime.servers.map((item) => [
          item.id,
          drawerProjection.current.get(
            threadListScopeKey(activeProfile, item, { archived: false }),
          )?.threads ?? [],
        ]),
      ),
    );
    setDrawerThreadErrors({});
    void Promise.all(
      appRuntime.servers.map(async (item) => {
        const [threadResult, workspaceResult] = await Promise.allSettled([
          listThreads(activeProfile, item, 100, { archived: false }),
          listWorkspaceOptions(activeProfile, item),
        ]);
        return [
          item.id,
          threadResult.status === "fulfilled" ? threadResult.value : undefined,
          workspaceResult.status === "fulfilled"
            ? workspaceResult.value
            : ([] as WorkspaceOption[]),
          workspaceResult.status === "rejected"
            ? workspaceResult.reason instanceof Error
              ? workspaceResult.reason.message
              : String(workspaceResult.reason)
            : null,
          threadResult.status === "rejected"
            ? threadResult.reason instanceof Error
              ? threadResult.reason.message
              : String(threadResult.reason)
            : threadListNotice(threadResult.value),
        ] as const;
      }),
    )
      .then((groups) => {
        if (cancelled || mutationRevision !== drawerProjection.current.revision)
          return;
        setDrawerThreads(
          Object.fromEntries(
            groups.map(([id, page]) => {
              const item = appRuntime.servers.find(
                (candidate) => candidate.id === id,
              )!;
              const scope = threadListScopeKey(activeProfile, item, {
                archived: false,
              });
              return [
                id,
                (page
                  ? drawerProjection.current.update(scope, page)
                  : drawerProjection.current.get(scope)
                )?.threads ?? [],
              ];
            }),
          ),
        );
        setDrawerThreadErrors(
          Object.fromEntries(
            groups.flatMap(([id, , , , error]) => (error ? [[id, error]] : [])),
          ),
        );
        setDrawerWorkspaceOptions(
          Object.fromEntries(groups.map(([id, , options]) => [id, options])),
        );
        setDrawerWorkspaceErrors(
          Object.fromEntries(
            groups.flatMap(([id, , , error]) => (error ? [[id, error]] : [])),
          ),
        );
      })
      .catch(() => {
        if (
          !cancelled &&
          mutationRevision === drawerProjection.current.revision
        ) {
          setDrawerThreadErrors(
            Object.fromEntries(
              appRuntime.servers.map((item) => [
                item.id,
                "会话列表加载失败，已保留此前会话，请重试。",
              ]),
            ),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProfile,
    appRuntime.servers,
    demo,
    profileReady,
    server,
    task,
    drawerReloadRevision,
  ]);

  useEffect(
    () => () => {
      if (task?.getSnapshot().archivedAt) {
        taskRuntimeRegistry.remove(
          params.profileId,
          params.serverId,
          params.threadId,
        );
      }
    },
    [params.profileId, params.serverId, params.threadId, task],
  );

  const routeError = invalidProfile
    ? "这个任务链接指向已移除的 Gateway。"
    : profileReady && !appRuntime.loading && !server
      ? "这个任务链接指向不存在或已移除的 KCoder 服务器。"
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
    profileReady,
    server,
    task,
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
    taskMenuOpen,
    setTaskMenuOpen,
    drawerThreads,
    setDrawerThreads,
    drawerProjection,
    setDrawerReloadRevision,
    drawerThreadErrors,
    drawerWorkspaceOptions,
    drawerWorkspaceErrors,
    setDirtyFilePanelIds,
    fileOpenRequests,
    workspaceState,
    workspaceStateHydrated,
    selectPanel,
    persistComposerDraft,
    persistQueuedMessages,
    persistTurnPreferences,
    updatePanel,
    addPanel,
    closePanel,
    openWorkspaceFile,
    routeError,
  };
}
