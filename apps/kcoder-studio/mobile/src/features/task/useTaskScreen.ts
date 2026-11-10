import { loadWorkspaceTaskHandoff, confirmWorkspaceTaskRoute } from "@/storage/pending-workspace-operation-v2";
import { useInterfaceVersion } from "@/storage/interface-version";
import type { TaskCreationClaim } from "@/runtime/task-runtime/types";
import type { ThreadPresenceObservation } from "@/runtime/task-runtime/thread-presence";
import { probeWorkspacePresence, type WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey } from "@/storage/session-transcript-scope";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { t } from "@/i18n";
import { workspaceFileLocationFromLink } from "@/components/workspace-file-links";
import { workspacePathName } from "@/components/workspace-path";
import { rememberWorkspaceFile } from "@/components/workspace-file-discovery";
import { stopDrawerSession } from "@/components/mobile-drawer-dismissal";
import type { ThreadSummary } from "@/gateway/types";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { createWorkspaceAbsenceHandoff } from "@/navigation/workspace-absence-handoff";
import { requestConfirmation } from "@/platform/confirmation";
import {
  ThreadListPager,
  listWorkspaceThreadScopes,
  mapThreadListScopes,
  subscribeThreadMutations,
  TaskRuntime,
  taskRuntimeRegistry,
  workspaceThreadScopeIdentity,
  type WorkspaceOption,
} from "@/runtime/task-runtime";
import {
  acknowledgeThreadMutationAtWorkspace,
  threadListNotice,
  projectWorkspaceThreadRows,
  threadMutationWorkspaceServers,
  ThreadListProjection,
  threadListScopeKey,
  threadListReadOwner,
} from "@/runtime/thread-list-projection";
import { useApp } from "@/state/AppContext";
import { shouldActivateRouteProfile } from "@/state/route-profile-activation";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { interactionServerIdentity } from "@/runtime/task-runtime/threadDirectory";
import { selectorForInteraction } from "@/runtime/task-runtime/interactions";
import {
  hasInteractionRouteParams,
  interactionMatchesInboxRow,
  matchesInteractionRouteLocator,
  parseInteractionRouteLocator,
} from "@/features/interaction-inbox/locator";
import {
  loadWorkspaceState as loadAuthorizedWorkspaceState,
  saveWorkspaceState as saveAuthorizedWorkspaceState,
  saveWorkspaceRecentFile as saveAuthorizedWorkspaceRecentFile,
  workspaceStateAuthorizationScope,
  type WorkspacePanelState,
  type WorkspaceTab,
  type WorkspaceViewState,
} from "@/storage/workspace-preferences";
import { useIsFocused } from "expo-router";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { taskOpenError } from "./taskLabels";
import { defaultWorkspacePanels, initialPanelId } from "./workspacePanels";

export function useTaskScreen() {
  const v3 = useInterfaceVersion() === "v3";
  const params = useLocalSearchParams<{
    profileId: string;
    serverId: string;
    threadId: string;
    cwd?: string;
    title?: string;
    creationRequestId?: string;
    kind?: string | string[];
    requestId?: string | string[];
    interactionId?: string | string[];
    turnId?: string | string[];
    appServerEpoch?: string | string[];
  }>();

  const router = useRouter();

  const isFocused = useIsFocused();

  const insets = useSafeAreaInsets();

  const {
    hydrated,
    activeProfile,
    profiles,
    runtime: appRuntime,
    refresh: refreshAppRuntime,
    setActiveProfile,
    markGatewayReauthorizationRequired,
    demo,
    runtimeActivationEpoch,
    isCurrentInteractionOwner,
  } = useApp();

  const goBack = () => { if (ownsWorkspace()) backOrReplace(router, profileHomeHref(params.profileId)); };

  const profileReady = activeProfile?.id === params.profileId;
  const interactionRouteRequested = hasInteractionRouteParams(params);
  const interactionRouteLocator = parseInteractionRouteLocator(params);

  const invalidProfile =
    hydrated && !profiles.some((profile) => profile.id === params.profileId);

  const server = profileReady
    ? appRuntime.servers.find((item) => item.id === params.serverId)
    : undefined;

  const workspaceProfileIdentity = activeProfile ? captureWorkspaceProfileIdentity(activeProfile) : undefined;
  const workspaceStorageScope = profileReady && activeProfile && server ? workspaceStateAuthorizationScope(activeProfile, server) : undefined;
  let recoveryScopeKey: string | null = null;
  try { if (activeProfile && server && params.cwd) recoveryScopeKey = sessionTranscriptScopeKey(
    captureSessionTranscriptScope(activeProfile, server, params.cwd, params.threadId)); }
  catch { /* An incomplete target stays on the existing read-only recovery path. */ }
  // A distinct object fences A → B → A, authorization changes, target changes, and demo transitions.
  const ownerKey = JSON.stringify([params.profileId, params.serverId, params.threadId, params.cwd ?? "", workspaceStorageScope,
    activeProfile ? profileAuthorizationScopeKey(activeProfile) : null, recoveryScopeKey,
    server?.observationTargetIdentity ?? null, runtimeActivationEpoch, appRuntime.serversReady,
    appRuntime.reauthorizationRequired, appRuntime.serversRevision, demo]);
  const ownerRef = useRef<{ key: string } | null>(null);
  if (ownerRef.current?.key !== ownerKey) ownerRef.current = { key: ownerKey };
  const owner = ownerRef.current;
  const absenceNavigationOwner = useRef<typeof owner | null>(null);
  const ownerMounted = useRef(true);
  const ownsWorkspace = () => ownerMounted.current && ownerRef.current === owner;
  useEffect(() => {
    ownerMounted.current = true;
    return () => { if (ownerRef.current === owner) ownerMounted.current = false; };
  }, [owner]);
  const workspaceReadinessRef = useRef<{
    owner: typeof owner;
    promise: Promise<WorkspaceViewState | null>;
    resolve: (state: WorkspaceViewState | null) => void;
  } | null>(null);
  if (workspaceReadinessRef.current?.owner !== owner) {
    workspaceReadinessRef.current?.resolve(null);
    let resolve!: (state: WorkspaceViewState | null) => void;
    const promise = new Promise<WorkspaceViewState | null>((done) => { resolve = done; });
    workspaceReadinessRef.current = { owner, promise, resolve };
  }
  const workspaceReadiness = workspaceReadinessRef.current;
  useEffect(() => () => {
    queueMicrotask(() => { if (!ownerMounted.current || ownerRef.current !== owner) workspaceReadiness.resolve(null); });
  }, [workspaceReadiness]);
  const guardSetter = <Value,>(setter: Dispatch<SetStateAction<Value>>) => (update: SetStateAction<Value>) => {
    if (!ownsWorkspace()) return;
    setter(current => {
      if (!ownsWorkspace()) return current;
      return typeof update === "function" ? (update as (current: Value) => Value)(current) : update;
    });
  };
  // Demo workspace state stays in this screen's React state and never reaches profile storage.
  const loadWorkspaceState = (profileId: string, serverId: string, threadId: string) =>
    demo
      ? Promise.resolve<WorkspaceViewState>({ activeTab: "agent" })
      : loadAuthorizedWorkspaceState(profileId, serverId, threadId, workspaceStorageScope);
  const saveWorkspaceState = (profileId: string, serverId: string, threadId: string, update: Partial<WorkspaceViewState>) => {
    if (demo) return Promise.resolve<WorkspaceViewState>({ activeTab: "agent", ...update });
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
    demo || (task.reconnectContext &&
      threadListReadOwner(task.reconnectContext.profile, task.reconnectContext.server) === threadListReadOwner(activeProfile, server) &&
      (!params.cwd || workspaceThreadScopeIdentity(task.getSnapshot().cwd) === workspaceThreadScopeIdentity(params.cwd)))
  ));
  const [interactionRouteRevision, setInteractionRouteRevision] = useState(0);
  useEffect(() => {
    if (!interactionRouteRequested || !task) return;
    let subscribed = true;
    const refresh = () => { if (subscribed) setInteractionRouteRevision((revision) => revision + 1); };
    const unsubscribeTask = task.subscribe(refresh);
    const unsubscribeRegistry = taskRuntimeRegistry.subscribe(refresh);
    refresh();
    return () => {
      subscribed = false;
      unsubscribeTask();
      unsubscribeRegistry();
    };
  }, [interactionRouteRequested, task, owner, isFocused]);
  useEffect(() => {
    if (!interactionRouteRequested) return;
    if (!isFocused) {
      task?.focusInteraction(null);
      return;
    }
    if (!task || !interactionRouteLocator) {
      if (task) {
        task.focusInteraction(null);
        task.patch({ interactionFocusStatus: "stale", interaction: null });
      }
      return;
    }
    const markStale = () => {
      if (task.getSnapshot().interactionFocusStatus === "stale" &&
          task.getSnapshot().interaction === null) return;
      task.focusInteraction(null);
      task.patch({ interactionFocusStatus: "stale", interaction: null });
    };
    const markReadOnly = () => {
      if (task.getSnapshot().interactionFocusStatus === "readOnly" &&
          task.getSnapshot().interaction === null) return;
      task.focusInteraction(null);
      task.patch({ interactionFocusStatus: "readOnly", interaction: null });
    };
    const currentContext = task.reconnectContext;
    const currentServer = appRuntime.servers.find((candidate) => candidate.id === params.serverId);
    const registered = taskRuntimeRegistry.entries().some((entry) =>
      entry.profileId === params.profileId && entry.serverId === params.serverId &&
      entry.threadId === params.threadId && entry.runtime === task,
    );
    if (!ownsWorkspace() || demo || !hydrated || !profileReady || !activeProfile ||
        activeProfile.id !== params.profileId || appRuntime.reauthorizationRequired ||
        !appRuntime.serversReady || !currentServer || !currentContext || !registered ||
        task.isDisposed() || currentContext.profile.id !== activeProfile.id ||
        profileAuthorizationScopeKey(currentContext.profile) !== profileAuthorizationScopeKey(activeProfile) ||
        currentContext.profile.accessToken !== activeProfile.accessToken ||
        currentContext.profile.refreshToken !== activeProfile.refreshToken ||
        interactionServerIdentity(currentContext.server) !== interactionServerIdentity(currentServer) ||
        interactionServerIdentity(currentServer) !== interactionServerIdentity(server!) ||
        currentContext.profileActivationEpoch !== runtimeActivationEpoch) {
      markReadOnly();
      return;
    }
    const authorizationScope = profileAuthorizationScopeKey(activeProfile);
    const row = taskRuntimeRegistry.interactionInboxRows(authorizationScope).find((candidate) =>
      candidate.profileId === params.profileId && candidate.serverId === params.serverId &&
      candidate.threadId === params.threadId && candidate.kind === interactionRouteLocator.kind &&
      candidate.requestId === interactionRouteLocator.requestId &&
      candidate.interactionId === interactionRouteLocator.interactionId &&
      candidate.turnId === interactionRouteLocator.turnId &&
      candidate.appServerEpoch === interactionRouteLocator.appServerEpoch,
    );
    if (!row || row.serverConfigIdentity !== interactionServerIdentity(currentServer)) {
      markStale();
      return;
    }
    const interaction = task.pendingInteractions.find((candidate) =>
      matchesInteractionRouteLocator(candidate, interactionRouteLocator, params.threadId),
    );
    if (!interaction || !interactionMatchesInboxRow(interaction, row) ||
        interaction.owner.profileId !== activeProfile.id ||
        interaction.owner.profileAuthorizationScopeKey !== authorizationScope ||
        interaction.owner.serverId !== currentServer.id ||
        interaction.owner.serverConfigIdentity !== interactionServerIdentity(currentServer) ||
        interaction.owner.runtimeInstanceNonce !== task.runtimeInstanceNonce ||
        interaction.owner.profileActivationEpoch !== runtimeActivationEpoch ||
        interaction.owner.originClientGeneration !== task.clientGeneration) {
      markReadOnly();
      return;
    }
    const selector = selectorForInteraction(interaction);
    if (!isCurrentInteractionOwner(interaction.owner)) {
      markReadOnly();
      return;
    }
    const actionable = row.liveActionable && !task.reconnecting && !task.disposed &&
      task.getSnapshot().connected && task.client?.isTransportOpen() === true &&
      task.isInteractionActionable(interaction);
    if (!actionable) {
      markReadOnly();
      return;
    }
    const snapshot = task.getSnapshot();
    if (snapshot.interaction && matchesInteractionRouteLocator(
      snapshot.interaction,
      interactionRouteLocator,
      params.threadId,
    ) && snapshot.interactionFocusStatus === undefined) return;
    task.focusInteraction(selector);
  }, [interactionRouteRequested, interactionRouteLocator?.kind, interactionRouteLocator?.requestId,
    interactionRouteLocator?.interactionId, interactionRouteLocator?.turnId,
    interactionRouteLocator?.appServerEpoch, interactionRouteRevision, task, owner,
    isFocused, demo, hydrated, profileReady, activeProfile, appRuntime.reauthorizationRequired,
    appRuntime.serversReady, appRuntime.servers, server, params.profileId, params.serverId,
    params.threadId, runtimeActivationEpoch, isCurrentInteractionOwner]);
  useEffect(() => {
    if (!interactionRouteRequested || !task) return;
    return () => { task.focusInteraction(null); };
  }, [interactionRouteRequested, task, owner]);
  const interactionRouteSourceAgentFocus = useMemo(() => {
    if (!interactionRouteRequested || !interactionRouteLocator || !isFocused || demo ||
        !hydrated || !profileReady || !activeProfile || activeProfile.id !== params.profileId ||
        appRuntime.reauthorizationRequired || !appRuntime.serversReady || !server) return null;
    const scope = profileAuthorizationScopeKey(activeProfile);
    const currentServer = appRuntime.servers.find((candidate) => candidate.id === params.serverId);
    if (!currentServer || interactionServerIdentity(currentServer) !== interactionServerIdentity(server)) return null;
    const authorizedProbe = {
      profileId: activeProfile.id,
      profileAuthorizationScopeKey: scope,
      serverId: currentServer.id,
      serverConfigIdentity: interactionServerIdentity(currentServer),
      threadId: params.threadId,
      turnId: null,
      appServerEpoch: null,
      runtimeInstanceNonce: task?.runtimeInstanceNonce ?? 0,
      profileActivationEpoch: runtimeActivationEpoch,
      originClientGeneration: task?.clientGeneration ?? 0,
      status: "unknown" as const,
    };
    if (!isCurrentInteractionOwner(authorizedProbe)) return null;
    const row = taskRuntimeRegistry.interactionInboxRows(scope).find((candidate) =>
      candidate.profileId === params.profileId && candidate.serverId === params.serverId &&
      candidate.threadId === params.threadId && candidate.kind === interactionRouteLocator.kind &&
      candidate.requestId === interactionRouteLocator.requestId &&
      candidate.interactionId === interactionRouteLocator.interactionId &&
      candidate.turnId === interactionRouteLocator.turnId &&
      candidate.appServerEpoch === interactionRouteLocator.appServerEpoch &&
      candidate.serverConfigIdentity === interactionServerIdentity(currentServer),
    );
    if (!row?.sourceAgent || row.sourceAgent.parentSessionId !== params.threadId) return null;
    return {
      kind: "question" as const,
      requestId: row.requestId,
      interactionId: row.interactionId,
      turnId: row.turnId,
      appServerEpoch: row.appServerEpoch,
      agentId: row.sourceAgent.agentId,
      parentSessionId: row.sourceAgent.parentSessionId,
      status: row.status,
      liveActionable: row.liveActionable,
    };
  }, [interactionRouteRequested, interactionRouteLocator?.kind, interactionRouteLocator?.requestId,
    interactionRouteLocator?.interactionId, interactionRouteLocator?.turnId,
    interactionRouteLocator?.appServerEpoch, interactionRouteRevision, isFocused, demo, hydrated,
    profileReady, activeProfile, params.profileId, params.serverId, params.threadId,
    appRuntime.reauthorizationRequired, appRuntime.serversReady, appRuntime.servers,
    server, runtimeActivationEpoch, task, isCurrentInteractionOwner]);
  useEffect(() => {
    const context = task?.reconnectContext;
    if (!task || task.isDisposed() || demo || !context || !activeProfile || !server ||
        profileAuthorizationScopeKey(context.profile) !== profileAuthorizationScopeKey(activeProfile) ||
        context.profile.accessToken !== activeProfile.accessToken ||
        context.profile.refreshToken !== activeProfile.refreshToken ||
        interactionServerIdentity(context.server) !== interactionServerIdentity(server)) return;
    if (task.client?.isTransportOpen() &&
        !task.client.matchesRetainedAttachmentOwner(activeProfile, server, task.getSnapshot().cwd)) return;
    const candidateOwner = {
      profileId: activeProfile.id,
      profileAuthorizationScopeKey: profileAuthorizationScopeKey(activeProfile),
      serverId: server.id,
      serverConfigIdentity: interactionServerIdentity(server),
      threadId: task.getSnapshot().threadId,
      turnId: null,
      appServerEpoch: null,
      runtimeInstanceNonce: task.runtimeInstanceNonce,
      profileActivationEpoch: runtimeActivationEpoch,
      originClientGeneration: task.clientGeneration,
      status: "unknown" as const,
    };
    if (!isCurrentInteractionOwner(candidateOwner)) return;
    task.reconnectContext = {
      ...context,
      profile: activeProfile,
      server,
      profileActivationEpoch: runtimeActivationEpoch,
      isCurrentInteractionOwner,
    };
  }, [task, demo, activeProfile, server, runtimeActivationEpoch, isCurrentInteractionOwner]);
  const [resumePendingEntry, setResumePendingEntry] = useState<{ owner: typeof owner; pending: boolean } | null>(null);
  const resumePending = resumePendingEntry?.owner === owner && resumePendingEntry.pending;
  const latestResumePending = useRef({ owner, pending: Boolean(resumePending) });
  latestResumePending.current = { owner, pending: Boolean(resumePending) };
  const recoveryAttempt = useRef<{ owner: typeof owner; controller: AbortController } | null>(null);
  const latestWorkspacePresence = useRef<{ owner: typeof owner; observation: WorkspacePresenceObservation | null }>({ owner, observation: null });
  const exitToConfirmedAbsence = useCallback(() => {
    const registered = taskRuntimeRegistry.get(params.profileId, params.serverId, params.threadId);
    if (!ownsWorkspace() || !isFocused || demo || !profileReady || appRuntime.reauthorizationRequired ||
        !activeProfile || activeProfile.id !== params.profileId || !server || server.id !== params.serverId ||
        !params.cwd || !workspaceStorageScope || (latestResumePending.current.owner === owner && latestResumePending.current.pending) || (task && !task.isDisposed()) ||
        (registered && !registered.isDisposed()) || absenceNavigationOwner.current === owner) return false;
    absenceNavigationOwner.current = owner;
    router.replace({ pathname: v3 ? "/new" : "/sessions", params: { profileId: params.profileId, serverId: params.serverId,
      cwd: params.cwd, notice: "confirmed-thread-absent" } } as never);
    return true;
  }, [owner, isFocused, demo, profileReady, appRuntime.reauthorizationRequired, activeProfile, server,
    params.profileId, params.serverId, params.threadId, params.cwd, workspaceStorageScope, task, router, resumePending, v3]);
  const exitToConfirmedWorkspaceAbsence = useCallback(() => {
    const registered = taskRuntimeRegistry.get(params.profileId, params.serverId, params.threadId);
    if (!ownsWorkspace() || !isFocused || demo || !profileReady || appRuntime.reauthorizationRequired ||
        !activeProfile || activeProfile.id !== params.profileId || !server || server.id !== params.serverId ||
        !params.cwd || !workspaceStorageScope || (latestResumePending.current.owner === owner && latestResumePending.current.pending) || (task && !task.isDisposed()) ||
        (registered && !registered.isDisposed()) || absenceNavigationOwner.current === owner) return false;
    const workspaceAbsenceHandoff = createWorkspaceAbsenceHandoff({ profile: activeProfile, server, cwd: params.cwd,
      threadId: params.threadId, observation: latestWorkspacePresence.current.owner === owner ? latestWorkspacePresence.current.observation : null,
      isCurrent: ownsWorkspace });
    absenceNavigationOwner.current = owner;
    router.replace({ pathname: v3 ? "/new" : "/h/[profileId]", params: { profileId: params.profileId, ...(v3 ? { serverId: params.serverId } : {}), notice: "confirmed-workspace-absent",
      ...(workspaceAbsenceHandoff ? { workspaceAbsenceHandoff } : {}) } } as never);
    return true;
  }, [owner, isFocused, demo, profileReady, appRuntime.reauthorizationRequired, activeProfile, server,
    params.profileId, params.serverId, params.threadId, params.cwd, workspaceStorageScope, task, router, resumePending, v3]);
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
  const [threadPresenceEntry, setThreadPresenceEntry] = useState<{ owner: typeof owner; observation: ThreadPresenceObservation } | null>(null);
  const threadPresence = threadPresenceEntry?.owner === owner ? threadPresenceEntry.observation : null;
  const [workspacePresenceEntry, setWorkspacePresenceEntry] = useState<{ owner: typeof owner; observation: WorkspacePresenceObservation } | null>(null);
  const workspacePresence = workspacePresenceEntry?.owner === owner ? workspacePresenceEntry.observation : null;
  latestWorkspacePresence.current = { owner, observation: workspacePresence };
  const [resumeRevision, setResumeRevision] = useState(0);
  const retryTaskRecovery = () => {
    if (!ownsWorkspace() || resumePending || appRuntime.reauthorizationRequired) return;
    setLoadError(null);
    guardSetter(setThreadPresenceEntry)(null);
    guardSetter(setWorkspacePresenceEntry)(null);
    if (server) {
      recoveryAttempt.current?.controller.abort();
      recoveryAttempt.current = null;
      latestResumePending.current = { owner, pending: true };
      guardSetter(setResumePendingEntry)({ owner, pending: true });
      setResumeRevision(revision => revision + 1);
    } else void refreshAppRuntime().catch(() => {});
  };

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
        workspaceReadiness.resolve(stored);
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
    [params.profileId, params.serverId, params.threadId, workspaceStorageScope, owner, workspaceStateHydrated, demo],
  );

  const persistWorkspaceRecentFile = useCallback(
    async (root: string, path: string): Promise<string[]> => {
      if (!ownsWorkspace() || !workspaceStateHydrated)
        throw new Error(t("task.workspace_not_restored_or_changed"));
      if (demo) {
        const recentFiles = rememberWorkspaceFile(root, workspaceState.recentFiles ?? [], path);
        setWorkspaceState((current) => ({
          ...current,
          recentFiles: rememberWorkspaceFile(root, current.recentFiles ?? [], path),
        }));
        return recentFiles;
      }
      if (!workspaceStorageScope)
        throw new Error(t("task.workspace_scope_not_confirmed"));
      const saved = await saveAuthorizedWorkspaceRecentFile(
        params.profileId,
        params.serverId,
        params.threadId,
        root,
        path,
        workspaceStorageScope,
        workspaceProfileIdentity,
      );
      if (!ownsWorkspace())
        throw new Error(t("task.workspace_not_restored_or_changed"));
      const recentFiles = saved.recentFiles ?? [];
      setWorkspaceState((current) => ({ ...current, recentFiles }));
      return recentFiles;
    },
    [params.profileId, params.serverId, params.threadId, workspaceStorageScope, workspaceProfileIdentity, owner, workspaceStateHydrated, demo, workspaceState.recentFiles],
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
  }, [params.profileId, params.serverId, params.threadId, workspaceStorageScope, owner, workspaceStateHydrated, demo]);

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
      const title = workspacePathName(path) || t("task.files");
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
      demo,
    ],
  );

  useEffect(() => {
    if (
      task ||
      !profileReady ||
      appRuntime.reauthorizationRequired ||
      !activeProfile ||
      !server
    )
      return;
    const capturedAuthorizationScope = profileAuthorizationScopeKey(activeProfile);
    guardSetter(setResumePendingEntry)({ owner, pending: true });
    let cancelled = false;
    let creationClaim: TaskCreationClaim | undefined;
    const recoveryController = new AbortController();
    const attempt = { owner, controller: recoveryController };
    recoveryAttempt.current = attempt;
    latestResumePending.current = { owner, pending: true };
    let workspaceRecoveryEligible = false;
    const load = async () => {
      try {
        const recoveryCwd = params.cwd;
        const linked = !demo && (params.creationRequestId || recoveryCwd) ? await loadWorkspaceTaskHandoff(activeProfile, server, params.creationRequestId ? { creationRequestId: params.creationRequestId } : { cwd: recoveryCwd!, threadId: params.threadId }) : null;
        if (cancelled || !ownsWorkspace()) return;
        if (linked && linked.value.threadId !== params.threadId)
          throw new Error(t("task.route_original_handoff_mismatch"));
        if (linked && params.cwd && workspaceThreadScopeIdentity(params.cwd) !==
            workspaceThreadScopeIdentity(linked.value.linked!.input.cwd))
          throw new Error(t("task.workspace_scope_not_confirmed"));
        if (linked || demo) {
          const preferences = await workspaceReadiness.promise;
          if (!preferences || cancelled || !ownsWorkspace()) return;
        }
        workspaceRecoveryEligible = !linked && !demo;
        const resumed = linked ? await (() => {
          creationClaim = TaskRuntime.claimCreation({ ...linked.value.linked!.input, profile: activeProfile, server, workspaceHandoff: linked.handle,
            profileActivationEpoch: runtimeActivationEpoch, isCurrentInteractionOwner,
            onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, capturedAuthorizationScope) }, taskRuntimeRegistry);
          return creationClaim.result;
        })() : demo ? TaskRuntime.demo(params.threadId) : await TaskRuntime.resume({
          profile: activeProfile, server, threadId: params.threadId, cwd: params.cwd, title: params.title,
          deferConfiguration: true, onSessionExpired: () => markGatewayReauthorizationRequired(activeProfile.id, capturedAuthorizationScope),
          profileActivationEpoch: runtimeActivationEpoch, isCurrentInteractionOwner,
          presenceOwnerToken: owner,
          signal: recoveryController.signal,
          isCurrentOwner: () => !cancelled && ownsWorkspace(),
          onThreadPresence: observation => {
            if (!cancelled && ownsWorkspace()) guardSetter(setThreadPresenceEntry)({ owner, observation });
          },
        });
        if (cancelled || !ownsWorkspace()) {
          if (!creationClaim) resumed.close();
          return;
        }
        if (!demo && !creationClaim && params.cwd &&
            workspaceThreadScopeIdentity(resumed.getSnapshot().cwd) !== workspaceThreadScopeIdentity(params.cwd)) {
          resumed.close();
          throw new Error(t("task.workspace_scope_not_confirmed"));
        }
        if (creationClaim) {
          if (!creationClaim.adopt(taskRuntimeRegistry, activeProfile.id, server.id))
            throw new Error(t("task.original_task_connection_released"));
        }
        else taskRuntimeRegistry.put(activeProfile.id, server.id, resumed);
        setTask(resumed);
      } catch (value) {
        if (!cancelled && ownsWorkspace()) {
          setLoadError(taskOpenError(value));
          // Successful resume proves the workspace already. This advisory request is failure-only.
          if (workspaceRecoveryEligible && params.cwd && !appRuntime.reauthorizationRequired) {
            void probeWorkspacePresence({ profile: activeProfile, server, cwd: params.cwd, threadId: params.threadId,
              isCurrentOwner: () => !cancelled && ownsWorkspace() && recoveryAttempt.current === attempt, signal: recoveryController.signal }).then(observation => {
              if (observation && !cancelled && ownsWorkspace()) guardSetter(setWorkspacePresenceEntry)({ owner, observation });
            }).catch(() => {});
          }
        }
      } finally {
        creationClaim?.release();
        if (!cancelled && ownsWorkspace() && recoveryAttempt.current === attempt) {
          latestResumePending.current = { owner, pending: false };
          guardSetter(setResumePendingEntry)({ owner, pending: false });
        }
      }
    };
    void load();
    return () => {
      cancelled = true; recoveryController.abort(); creationClaim?.release();
      if (recoveryAttempt.current === attempt) recoveryAttempt.current = null;
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
    appRuntime.reauthorizationRequired,
    runtimeActivationEpoch,
    isCurrentInteractionOwner,
    owner, resumeRevision,
  ]);

  useEffect(() => {
    if (!task || !taskScopeMatches || !workspaceStateHydrated || !ownsWorkspace() ||
        task.workspaceConfiguration === undefined) return;
    void task.restoreWorkspaceConfiguration(workspaceState.reasoningEffort, ownsWorkspace);
  }, [owner, task, taskScopeMatches, workspaceStateHydrated, workspaceState.reasoningEffort]);

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
      // Discovery can add scopes after the fast current-workspace job captured its pager list.
      // Wait for that owned job, then load the newly discovered scopes in a fresh pass.
      while (session.jobs.has(serverId)) {
        await session.jobs.get(serverId);
        if (!ownsWorkspace() || drawerSession.current !== session || session.controller.signal.aborted) return;
      }
      if (!ownsWorkspace() || drawerSession.current !== session || session.controller.signal.aborted) return;
      await loadDrawerServer(serverId);
    })().catch(error => {
      if (ownsWorkspace() && drawerSession.current === session && !session.controller.signal.aborted)
        setDrawerWorkspaceErrors(value => ({ ...value, [serverId]: error instanceof Error ? error.message : String(error) }));
    }).finally(() => session.jobs.delete(key));
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
    const targets = [server, ...appRuntime.servers.filter(item => item.id !== server.id)];
    void mapThreadListScopes(targets, item => loadDrawerProjects(item.id));
    return () => {
      stopDrawerSession(drawerSession, session);
    };
  }, [drawerOpen, activeProfile, profileReady, server, demo, drawerReloadRevision, loadDrawerServer, loadDrawerProjects, appRuntime.reauthorizationRequired]);

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
    exitToConfirmedAbsence,
    exitToConfirmedWorkspaceAbsence,
    ownsWorkspace,
    workspaceOwnerKey: owner.key,
    profileReady,
    server,
    task: taskScopeMatches ? task : null,
    loadError,
    resumePending, retryTaskRecovery, threadPresence, workspacePresence,
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
    interactionRouteSourceAgentFocus,
    selectPanel,
    persistWorkspaceState,
    persistWorkspaceRecentFile,
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
