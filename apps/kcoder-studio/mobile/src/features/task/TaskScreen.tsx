import { ChangesPanel } from "@/components/changes-panel";
import { MobileDrawer } from "@/components/mobile-drawer";
import { EmptyState } from "@/components/ui";
import {
  BrowserPanel,
  FilesPanel,
  TerminalPanel,
} from "@/components/workspace-panels";
import { WorkspaceTabSwitcher } from "@/components/workspace-tab-switcher";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { removeWorkspaceState } from "@/storage/workspace-preferences";
import { colors } from "@/theme";
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
import { styles } from "./taskStyles";
import { useTaskScreen } from "./useTaskScreen";

export function TaskScreen() {
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
  } = model;
  if (routeError || !task) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        {routeError || loadError ? (
          <EmptyState
            icon={<Bot size={44} color={colors.red} />}
            title="无法打开任务"
            body={routeError ?? loadError ?? "未知错误"}
          />
        ) : (
          <ActivityIndicator color={colors.text} />
        )}
        <Pressable onPress={goBack} style={styles.backTextButton}>
          <Text style={styles.backText}>返回任务列表</Text>
        </Pressable>
      </View>
    );
  }
  if (!workspaceStateHydrated) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={styles.loadingWorkspaceLabel}>正在恢复工作区…</Text>
      </View>
    );
  }
  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <TaskHeader
        task={task}
        onBack={goBack}
        onMenu={() => setDrawerOpen(true)}
        onMore={() => setTaskMenuOpen(true)}
        onWorkspace={
          activePanelId === "agent" ? () => setTabSwitcherOpen(true) : undefined
        }
      />
      <WorkspaceTabSwitcher
        hideBar={activePanelId === "agent"}
        panels={panels}
        activePanelId={activePanelId}
        open={tabSwitcherOpen}
        onOpenChange={setTabSwitcherOpen}
        onSelect={selectPanel}
        onClose={closePanel}
        onAdd={() => setPanelMenuOpen(true)}
      />
      <RetainedPanel active={activePanelId === "agent"}>
        <AgentPanel
          task={task}
          profile={activeProfile ?? undefined}
          server={server}
          bottomInset={insets.bottom}
          demo={demo}
          initialDraft={workspaceState.composerDraft}
          initialQueuedMessages={workspaceState.queuedMessages}
          onDraftChange={persistComposerDraft}
          onQueuedMessagesChange={persistQueuedMessages}
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
          profileId={params.profileId}
          profile={activeProfile}
          servers={appRuntime.servers}
          threads={
            demo
              ? drawerThreads
              : Object.fromEntries(
                  appRuntime.servers.map((item) => [
                    item.id,
                    drawerProjection.current.get(
                      threadListScopeKey(activeProfile, item, {
                        archived: false,
                      }),
                    )?.threads ?? [],
                  ]),
                )
          }
          workspaceOptions={drawerWorkspaceOptions}
          workspaceErrors={drawerWorkspaceErrors}
          threadErrors={drawerThreadErrors}
          demo={demo}
          liveTask={task}
          liveTaskServerId={params.serverId}
          onThreadRenamed={(serverId, thread) => {
            const item = appRuntime.servers.find(
              (candidate) => candidate.id === serverId,
            );
            if (item)
              drawerProjection.current.changeThread(
                threadListScopeKey(activeProfile, item, { archived: false }),
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
            const item = appRuntime.servers.find(
              (candidate) => candidate.id === serverId,
            );
            if (item)
              drawerProjection.current.removeThread(
                threadListScopeKey(activeProfile, item, { archived: false }),
                threadId,
              );
            setDrawerReloadRevision((value) => value + 1);
            setDrawerThreads((current) => ({
              ...current,
              [serverId]: (current[serverId] ?? []).filter(
                (thread) => thread.id !== threadId,
              ),
            }));
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
          taskRuntimeRegistry.remove(
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
          if (!demo) {
            for (const message of workspaceState.queuedMessages ?? []) {
              for (const attachment of message.attachments)
                await task
                  .request("attachment/delete", { path: attachment.path })
                  .catch(() => {});
            }
          }
          await removeWorkspaceState(
            params.profileId,
            params.serverId,
            params.threadId,
          );
          taskRuntimeRegistry.remove(
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
