import { WorkspaceOperationBookkeeping } from "@/features/forms/WorkspaceOperationBookkeeping";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { ChangesPanel } from "@/components/changes-panel";
import { MobileDrawer } from "@/components/mobile-drawer";
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
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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

export function TaskScreen() {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const model = useTaskScreen();
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
  } = model;
  if (!routeError && workspaceStateError) {
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
  if (!workspaceStateHydrated) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={styles.loadingWorkspaceLabel}>
          {t("task.restoring_workspace")}
        </Text>
      </View>
    );
  }
  // Android adjustResize already resizes this root; KAV can retain the hide event's old frame.
  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={
        Platform.OS === "ios" ? "padding" : undefined
      }
      keyboardVerticalOffset={0}
    >
      <TaskHeader
        task={task}
        onBack={goBack}
        onMenu={openDrawer}
        onMore={() => setTaskMenuOpen(true)}
        onWorkspace={
          activePanelId === "agent" ? () => setTabSwitcherOpen(true) : undefined
        }
      />
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
      <RetainedPanel active={activePanelId === "agent"}>
        <AgentPanel
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
              task={task}
              demo={demo}
              initialDirectory={panel.directoryPath}
              initialDraft={panel.fileDraft}
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
          servers={appRuntime.servers}
          threads={drawerThreads}
          workspaceOptions={drawerWorkspaceOptions}
          workspaceErrors={drawerWorkspaceErrors}
          threadErrors={drawerThreadErrors}
          loading={drawerLoading}
          hasMore={drawerHasMore}
          onLoadServer={loadDrawerServer}
          onLoadProjects={loadDrawerProjects}
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
          // The runtime retained a cleanup ticket before remote deletion. Local
          // cleanup errors cannot turn a completed deletion into a UI failure.
          void removeWorkspaceState(params.profileId, params.serverId, params.threadId, workspaceStorageScope).catch(() => {});
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
    </KeyboardAvoidingView>
  );
}
