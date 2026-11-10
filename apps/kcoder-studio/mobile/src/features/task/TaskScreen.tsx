import { ConversationV3Background } from "@/features/interface/ConversationV3";
import { CachedSessionView } from "./CachedSessionView";
import { KeyboardSafeView } from "@/components/keyboard-safe-view";
import { useSessionTranscriptCache } from "./useSessionTranscriptCache";
import { WorkspaceOperationBookkeeping } from "@/features/forms/WorkspaceOperationBookkeeping";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { ChangesPanel } from "@/components/changes-panel";
import { MobileDrawer } from "@/components/mobile-drawer";
import { selectMobileConnectionStatusProps } from "@/components/connection-status-presentation";
import { EmptyState } from "@/components/ui";
import {
  BrowserPanel,
  FilesPanel,
  TerminalPanel,
} from "@/components/workspace-panels";
import { WorkspaceTabSwitcher } from "@/components/workspace-tab-switcher";
import {
  taskRuntimeRegistry,
  workspaceThreadScopeServers,
} from "@/runtime/task-runtime";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { removeWorkspaceState } from "@/storage/workspace-preferences";
import { workspaceAttachmentPathsForThreadDeletion } from "@/storage/workspace-attachment-paths";
import { Bot } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
} from "react-native";
import { AgentPanel } from "./TaskAgent";
import { TaskHeader } from "./TaskHeader";
import { TaskMenu } from "./TaskMenu";
import { PanelMenu, RetainedPanel } from "./TaskPanels";
import { useTaskAppearance } from "./taskStyles";
import { useTaskScreen } from "./useTaskScreen";
import { useInterfaceVersion } from "@/storage/interface-version";

export function TaskScreen() {
  useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { styles, colors } = useTaskAppearance();
  const model = useTaskScreen();
  const draftFlushRef = useRef<(() => Promise<void>) | null>(null);
  const [navigationError, setNavigationError] = useState<{ owner: string; text: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [subagentsOpenRequest, setSubagentsOpenRequest] = useState<{ owner: string; token: object } | undefined>();
  const [permissionOpenRequest, setPermissionOpenRequest] = useState<{ owner: string; token: object } | undefined>();
  const [expertOpenRequest, setExpertOpenRequest] = useState<{ owner: string; token: object } | undefined>();
  const [quickPhrasesOpenRequest, setQuickPhrasesOpenRequest] = useState<{ owner: string; token: object } | undefined>();
  const [planOpenRequest, setPlanOpenRequest] = useState<{ owner: string; token: object } | undefined>();
  useEffect(() => setPlanOpenRequest(undefined), [model.workspaceOwnerKey]);
  useEffect(() => setPermissionOpenRequest(undefined), [model.workspaceOwnerKey]);
  useEffect(() => setExpertOpenRequest(undefined), [model.workspaceOwnerKey]);
  useEffect(() => setQuickPhrasesOpenRequest(undefined), [model.workspaceOwnerKey]);
  useEffect(() => setSubagentsOpenRequest(undefined), [model.workspaceOwnerKey]);
  useEffect(() => setSearchOpen(false), [model.workspaceOwnerKey]);
  const {
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
    drawerLoading, drawerHasMore, loadDrawerServer, loadDrawerProjects,
    setDirtyFilePanelIds,
    savingFilePanelIds,
    reportFilePanelSavePending,
    fileOpenRequests,
    workspaceState,
    workspaceStorageScope,
    workspaceOwnerKey,
    workspaceStateHydrated,
    workspaceStateError,
    retryWorkspaceState,
    selectPanel,
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
    interactionRouteSourceAgentFocus,
  } = model;
  const navigate = async (destination: "projects" | "history" | "inbox" | "settings") => {
    if (!model.ownsWorkspace() || !isFocused || !profileReady || !activeProfile) return;
    try { await draftFlushRef.current?.(); }
    catch (error) {
      if (model.ownsWorkspace()) setNavigationError({ owner: model.workspaceOwnerKey, text: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!model.ownsWorkspace()) return;
    setNavigationError(null);
    if (destination === "settings") router.push("/settings");
    else if (destination === "history") router.push({ pathname: "/sessions", params: { profileId: activeProfile.id } });
    else router.push({ pathname: destination === "inbox" ? "/h/[profileId]/inbox" : "/h/[profileId]", params: { profileId: activeProfile.id } });
  };
  const navigation = { projects: () => navigate("projects"), history: () => navigate("history"),
    inbox: () => navigate("inbox"), settings: () => navigate("settings") };
  const drawerConnectionStatusProps = selectMobileConnectionStatusProps(appRuntime);
  const transcriptCache = useSessionTranscriptCache({ profile: activeProfile, server,
    serverId: params.serverId, threadId: params.threadId, cwd: params.cwd,
    enabled: profileReady && isFocused && !demo, presence: model.threadPresence,
    workspacePresence: model.workspacePresence,
    reauthorizationRequired: appRuntime.reauthorizationRequired, task });
  useEffect(() => {
    if (!task && transcriptCache.workspaceAbsenceConfirmed) model.exitToConfirmedWorkspaceAbsence();
  }, [model.workspaceOwnerKey, model.exitToConfirmedWorkspaceAbsence, task, transcriptCache.workspaceAbsenceConfirmed]);
  useEffect(() => {
    if (!task && transcriptCache.absenceConfirmed) model.exitToConfirmedAbsence();
  }, [model.workspaceOwnerKey, model.exitToConfirmedAbsence, task, transcriptCache.absenceConfirmed]);
  if (!task && transcriptCache.workspaceAbsenceConfirmed) return (
    <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
      <EmptyState icon={<Bot size={44} color={colors.red} />}
        title={t("task.confirmed_workspace_absent_title")} body={t("task.confirmed_workspace_absent_body")} />
      <Pressable onPress={model.exitToConfirmedWorkspaceAbsence} style={styles.backTextButton} accessibilityRole="button">
        <Text style={styles.backText}>{t("task.back_to_gateway")}</Text>
      </Pressable>
    </View>
  );
  if (!task && transcriptCache.absenceConfirmed) return (
    <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
      <EmptyState icon={<Bot size={44} color={colors.red} />}
        title={t("task.confirmed_absent_title")} body={t("task.confirmed_absent_body")} />
      <Pressable onPress={goBack} style={styles.backTextButton} accessibilityRole="button">
        <Text style={styles.backText}>{t("task.back_to_task_list")}</Text>
      </Pressable>
    </View>
  );
  if (!task && transcriptCache.cached) return <CachedSessionView cached={transcriptCache.cached}
    navigation={navigation}
    owner={transcriptCache.displayOwner} onBack={goBack} topInset={insets.top} bottomInset={insets.bottom}
    offline={!model.resumePending && Boolean(loadError || appRuntime.error)}
    failure={loadError ?? appRuntime.error} draftRecoveryError={workspaceStateError}
    onRetryDraftRecovery={retryWorkspaceState} composerDraft={workspaceStateHydrated ? workspaceState.composerDraft ?? "" : ""}
    showDisabledTaskActions onRetry={model.retryTaskRecovery}
    initialAnchor={transcriptCache.initialAnchor} onReadAnchor={transcriptCache.readAnchor} />;
  if (!task && !routeError && workspaceStateError) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <EmptyState
          icon={<Bot size={44} color={colors.red} />}
          title={t("task.unable_to_restore_local_workspace")}
          body={workspaceStateError}
        />
        <Pressable onPress={retryWorkspaceState} style={styles.backTextButton} accessibilityRole="button">
          <Text style={styles.backText}>{t("task.retry_workspace_recovery")}</Text>
        </Pressable>
        <Pressable onPress={goBack} style={styles.backTextButton}>
          <Text style={styles.backText}>{t("task.back_to_task_list")}</Text>
        </Pressable>
      </View>
    );
  }
  if (routeError || !task) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        {routeError || loadError ? (
          <EmptyState
            icon={<Bot size={44} color={colors.red} />}
            title={t("task.unable_to_open_task")}
            body={routeError ?? loadError ?? t("task.unknown_error")}
          />
        ) : (
          <View>
            <Text style={styles.loadingWorkspaceLabel}>
              {model.params.title || t("task.fallback_title")}
            </Text>
            <Text style={styles.loadingWorkspaceLabel}>
              {t("task.restoring_history")}
            </Text>
            <ActivityIndicator color={colors.text} />
          </View>
        )}
        <Pressable onPress={goBack} style={styles.backTextButton}>
          <Text style={styles.backText}>{t("task.back_to_task_list")}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <KeyboardSafeView
      style={[styles.root, { paddingTop: insets.top }]}
    >
      <ConversationV3Background />
      <TaskHeader
        navigation={navigation}
        onSearch={() => setSearchOpen(open => !open)}
        onWorkspace={workspaceStateHydrated && activePanelId === "agent" ? () => setTabSwitcherOpen(true) : undefined}
        task={task}
        onBack={goBack}
        onMenu={workspaceStateHydrated ? openDrawer : undefined}
        onMore={workspaceStateHydrated ? () => setTaskMenuOpen(true) : undefined}
        onNew={workspaceStateHydrated && activeProfile && server && !demo ? () => {
          if (!model.ownsWorkspace()) return;
          router.push({ pathname: "/new", params: { profileId: params.profileId, serverId: server.id, cwd: task.getSnapshot().cwd } });
        } : undefined}
      />
      {!workspaceStateHydrated ? (
        <View testID="task-workspace-recovery" accessibilityRole={workspaceStateError ? "alert" : undefined}>
          <Text style={styles.loadingWorkspaceLabel}>
            {workspaceStateError ?? t("task.restoring_workspace")}
          </Text>
          {workspaceStateError ? (
            <Pressable onPress={retryWorkspaceState} accessibilityRole="button" style={styles.backTextButton}>
              <Text style={styles.backText}>{t("task.retry_workspace_recovery")}</Text>
            </Pressable>
          ) : <ActivityIndicator size="small" color={colors.textMuted} />}
        </View>
      ) : null}
      {workspaceStateHydrated ? <>
      <WorkspaceOperationBookkeeping profile={activeProfile} server={server} expectedResult={params.cwd} enabled={profileReady && !appRuntime.loading && !demo} />
      <WorkspaceTabSwitcher
        hideBar={activePanelId === "agent"}
        panels={panels}
        activePanelId={activePanelId}
        open={tabSwitcherOpen}
        onOpenChange={setTabSwitcherOpen}
        onSelect={selectPanel}
        onClose={closePanel}
        savingPanelIds={savingFilePanelIds}
        onAdd={() => setPanelMenuOpen(true)}
      />
      {workspaceState.retainedOtherScopeState ? (
        <Text accessibilityRole="alert" style={styles.loadingWorkspaceLabel}>
          {t("task.retained_other_scope_draft")}
        </Text>
      ) : null}
      </> : null}
      <RetainedPanel key="agent-history" active={!workspaceStateHydrated || activePanelId === "agent"}>
        {navigationError?.owner === model.workspaceOwnerKey ? <Text accessibilityRole="alert" style={styles.attachmentError}>{navigationError.text}</Text> : null}
        <AgentPanel searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)}
          planOpenRequest={planOpenRequest?.owner === model.workspaceOwnerKey ? planOpenRequest.token : undefined}
          draftFlushRef={draftFlushRef}
          subagentsOpenRequest={subagentsOpenRequest?.owner === model.workspaceOwnerKey ? subagentsOpenRequest.token : undefined}
          permissionOpenRequest={permissionOpenRequest?.owner === model.workspaceOwnerKey ? permissionOpenRequest.token : undefined}
          expertOpenRequest={expertOpenRequest?.owner === model.workspaceOwnerKey ? expertOpenRequest.token : undefined}
          quickPhrasesOpenRequest={quickPhrasesOpenRequest?.owner === model.workspaceOwnerKey ? quickPhrasesOpenRequest.token : undefined}
          key={model.workspaceOwnerKey}
          displayOwner={transcriptCache.displayOwner}
          initialReadAnchor={transcriptCache.initialAnchor}
          onReadAnchor={transcriptCache.readAnchor}
          workspaceReady={workspaceStateHydrated}
          interactionRouteSourceAgentFocus={interactionRouteSourceAgentFocus}
          task={task}
          profile={activeProfile ?? undefined}
          server={server}
          bottomInset={insets.bottom}
          demo={demo}
          initialDraft={workspaceState.composerDraft}
          initialQueuedMessages={workspaceState.queuedMessages}
          initialFailedSubmissions={workspaceState.failedSubmissions}
          onDraftChange={persistComposerDraft}
          onQueuedMessagesChange={persistQueuedMessages}
          onQueueCommit={persistQueueCommit}
          onFailedSubmissionsChange={persistFailedSubmissions}
          onTurnPreferencesChange={persistTurnPreferences}
          onOpenFile={openWorkspaceFile}
          onOpenChanges={() => {
            const changesPanel = panelsRef.current.find(
              (panel) => panel.kind === "changes",
            );
            if (changesPanel) selectPanel(changesPanel);
          }}
        />
      </RetainedPanel>
      {workspaceStateHydrated ? <>
      {panels
        .filter(
          (panel) => panel.kind === "changes" && mountedPanelIds.has(panel.id),
        )
        .map((panel) => (
          <RetainedPanel
            key={panel.id}
            active={activePanelId === panel.id}
            bottomInset={insets.bottom}
          >
            <ChangesPanel
              task={task}
              demo={demo}
              onOpenFile={openWorkspaceFile}
            />
          </RetainedPanel>
        ))}
      {panels
        .filter(
          (panel) => panel.kind === "terminal" && mountedPanelIds.has(panel.id),
        )
        .map((panel) => (
          <RetainedPanel
            key={panel.id}
            active={activePanelId === panel.id}
            bottomInset={insets.bottom}
          >
            <TerminalPanel
              task={task}
              demo={demo}
              panelId={panel.id}
              initialSessionId={panel.terminalSessionId}
              onSessionIdChange={(terminalSessionId) =>
                updatePanel(panel.id, { terminalSessionId })
              }
              paneActive={isFocused && activePanelId === panel.id}
              onOpenFile={openWorkspaceFile}
            />
          </RetainedPanel>
        ))}
      {profileReady && activeProfile && server
        ? panels
            .filter(
              (panel) =>
                panel.kind === "browser" && mountedPanelIds.has(panel.id),
            )
            .map((panel) => (
              <RetainedPanel
                key={panel.id}
                active={activePanelId === panel.id}
                bottomInset={insets.bottom}
              >
                <BrowserPanel
                  profile={activeProfile}
                  server={server}
                  cwd={task.getSnapshot().cwd}
                  demo={demo}
                  active={isFocused && activePanelId === panel.id}
                  initialUrl={panel.browserUrl}
                  onUrlChange={(browserUrl) =>
                    updatePanel(panel.id, { browserUrl })
                  }
                />
              </RetainedPanel>
            ))
        : null}
      {panels
        .filter(
          (panel) => panel.kind === "files" && mountedPanelIds.has(panel.id),
        )
        .map((panel) => (
          <RetainedPanel
            key={panel.id}
            active={activePanelId === panel.id}
            bottomInset={insets.bottom}
          >
            <FilesPanel
              ownerKey={workspaceOwnerKey}
              task={task}
              demo={demo}
              initialDirectory={panel.directoryPath}
              initialDraft={panel.fileDraft}
              initialRecentFiles={workspaceState.recentFiles}
              openFileRequest={fileOpenRequests[panel.id]}
              onDirtyChange={(dirty) =>
                setDirtyFilePanelIds((current) => {
                  if (current.has(panel.id) === dirty) return current;
                  const next = new Set(current);
                  if (dirty) next.add(panel.id);
                  else next.delete(panel.id);
                  return next;
                })
              }
              onSavePendingChange={(pending) =>
                reportFilePanelSavePending(panel.id, pending)
              }
              onDirectoryChange={(directoryPath) =>
                updatePanel(panel.id, { directoryPath })
              }
              onDraftChange={(fileDraft) =>
                updatePanel(panel.id, { fileDraft })
              }
              onRecentFileOpened={(path, root) =>
                persistWorkspaceRecentFile(root, path)
              }
            />
          </RetainedPanel>
        ))}
      {activeProfile ? (
        <MobileDrawer
          visible={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onDismissStart={dismissDrawerWork}
          profileId={params.profileId}
          profile={activeProfile}
          {...drawerConnectionStatusProps}
          servers={appRuntime.servers}
          threads={drawerThreads}
          workspaceOptions={drawerWorkspaceOptions}
          workspaceErrors={drawerWorkspaceErrors}
          threadErrors={drawerThreadErrors}
          loading={drawerLoading}
          hasMore={drawerHasMore}
          onLoadServer={loadDrawerServer}
          onLoadProjects={loadDrawerProjects}
          workspaceHistoryOwner={workspaceOwnerKey}
          canRefreshWorkspaceHistory={(target) => Boolean(
            profileReady && isFocused && activeProfile?.id === params.profileId && model.ownsWorkspace() &&
            appRuntime.servers.some((candidate) => candidate.id === target.id && JSON.stringify(candidate) === JSON.stringify(target)),
          )}
          onWorkspaceHistoryReady={(serverId) => {
            if (model.ownsWorkspace()) void loadDrawerServer(serverId, false);
          }}
          demo={demo}
          liveTask={task}
          liveTaskServerId={params.serverId}
          onThreadRenamed={(serverId, thread) => {
            if (!model.ownsWorkspace()) return;
            if (!demo) return;
            const item = appRuntime.servers.find(
              (candidate) => candidate.id === serverId,
            );
            if (item)
              for (const workspaceServer of workspaceThreadScopeServers(
                item,
                drawerWorkspaceOptions[serverId] ?? [],
              ))
                drawerProjection.current.changeThread(
                  threadListScopeKey(activeProfile, workspaceServer, {
                    archived: false,
                  }),
                  thread,
                );
            setDrawerReloadRevision((value) => value + 1);
            setDrawerThreads((current) => ({
              ...current,
              [serverId]: (current[serverId] ?? []).map((candidate) =>
                candidate.id === thread.id ? thread : candidate,
              ),
            }));
          }}
          onThreadRemoved={(serverId, threadId) => {
            if (!model.ownsWorkspace()) return;
            if (demo) {
              const item = appRuntime.servers.find(
                (candidate) => candidate.id === serverId,
              );
              if (item)
                for (const workspaceServer of workspaceThreadScopeServers(
                  item,
                  drawerWorkspaceOptions[serverId] ?? [],
                ))
                  drawerProjection.current.removeThread(
                    threadListScopeKey(activeProfile, workspaceServer, {
                      archived: false,
                    }),
                    threadId,
                  );
              setDrawerReloadRevision((value) => value + 1);
              setDrawerThreads((current) => ({
                ...current,
                [serverId]: (current[serverId] ?? []).filter(
                  (thread) => thread.id !== threadId,
                ),
              }));
            }
            if (serverId === params.serverId && threadId === params.threadId)
              router.replace({
                pathname: "/h/[profileId]",
                params: { profileId: params.profileId },
              });
          }}
        />
      ) : null}
      <TaskMenu
        visible={taskMenuOpen}
        task={task}
        demo={demo}
        onClose={() => setTaskMenuOpen(false)}
        onPlan={v3 && workspaceStateHydrated ? () => {
          if (!model.ownsWorkspace()) return;
          selectPanel({ id: "agent", kind: "agent", title: task.getSnapshot().title });
          setPlanOpenRequest({ owner: model.workspaceOwnerKey, token: {} });
        } : undefined}
        onPermission={v3 && workspaceStateHydrated ? () => {
          if (!model.ownsWorkspace()) return;
          selectPanel({ id: "agent", kind: "agent", title: task.getSnapshot().title });
          setPermissionOpenRequest({ owner: model.workspaceOwnerKey, token: {} });
        } : undefined}
        onExpert={!demo && workspaceStateHydrated ? () => {
          if (!model.ownsWorkspace()) return;
          selectPanel({ id: "agent", kind: "agent", title: task.getSnapshot().title });
          setExpertOpenRequest({ owner: model.workspaceOwnerKey, token: {} });
        } : undefined}
        onSearch={() => { setTaskMenuOpen(false); selectPanel({ id: "agent", kind: "agent", title: task.getSnapshot().title }); setSearchOpen(true); }}
        onWorkspace={() => { setTaskMenuOpen(false); setTabSwitcherOpen(true); }}
        onQuickPhrases={() => {
          if (!model.ownsWorkspace() || !task.getSnapshot().connected || task.getSnapshot().configurationReady === false || task.getSnapshot().archivedAt) return;
          setTaskMenuOpen(false);
          selectPanel({ id: "agent", kind: "agent", title: task.getSnapshot().title });
          setQuickPhrasesOpenRequest({ owner: model.workspaceOwnerKey, token: {} });
        }}
        onSubagents={() => { setTaskMenuOpen(false); setSubagentsOpenRequest({ owner: model.workspaceOwnerKey, token: {} }); }}
        onArchived={() => {
          if (!model.ownsWorkspace()) return;
          if (taskRuntimeRegistry.get(params.profileId, params.serverId, params.threadId) === task) taskRuntimeRegistry.remove(
            params.profileId,
            params.serverId,
            params.threadId,
          );
          router.replace({
            pathname: "/h/[profileId]",
            params: { profileId: params.profileId },
          });
        }}
        onDeleted={async () => {
          if (!model.ownsWorkspace()) return;
          // Remote deletion is already confirmed. Keep this menu open and report
          // local persistence failure instead of implying the cleanup succeeded.
          try {
            await removeWorkspaceState(params.profileId, params.serverId, params.threadId, workspaceStorageScope);
          } catch {
            throw new Error(t("task.remote_delete_confirmed_local_cleanup_failed"));
          }
          if (taskRuntimeRegistry.get(params.profileId, params.serverId, params.threadId) === task) taskRuntimeRegistry.remove(
            params.profileId,
            params.serverId,
            params.threadId,
          );
          router.replace({
            pathname: "/h/[profileId]",
            params: { profileId: params.profileId },
          });
        }}
      />
      <PanelMenu
        visible={panelMenuOpen}
        canAdd={panels.length < 12}
        onClose={() => setPanelMenuOpen(false)}
        onAdd={addPanel}
      />
      </> : null}
    </KeyboardSafeView>
  );
}
