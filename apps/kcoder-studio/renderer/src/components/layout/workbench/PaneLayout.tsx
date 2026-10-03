import { PANE_RESIZE_HANDLE } from '../useHorizontalPaneResize'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { WorkspaceMarkdownImageLoaderContext } from '@/components/chat/workspaceMarkdownImageLoaderContext'
import { WorkbenchMainHeaderPortal } from '@/components/topnav/TitlebarActionsPortal'
import { WorkflowConversationCanvas } from '@/features/workflows/WorkflowConversationCanvas'
import { WorkflowExecutionCanvas } from '@/features/workflows/WorkflowExecutionCanvas'
import { runtimeProjectLabel } from '@/kcoder/gatewayServerLabel'
import { cn } from '@/lib/utils'
import { memo } from 'react'
import { BufferedChatInput } from '../BufferedChatInput'
import { DesktopEmptyTaskLauncher } from '../DesktopEmptyTaskLauncher'
import { DesktopTopBar } from '../DesktopTopBar'
import { DeviceStatusPrompt } from '../DeviceStatusPrompt'
import { SubagentStatusIndicator } from '../SubagentStatusIndicator'
import { requestOpenCloudDeviceSettings } from '../workbenchShellEvents'
import { RightWorkspacePanel } from '../workspace-panels/RightWorkspacePanel'
import { MemoizedBottomWorkspacePanel } from './PaneBottomPanel'
import { PaneComposer } from './PaneComposer'
import {
  DESKTOP_MESSAGE_LIST_CLASS,
  DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS,
  DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
  RIGHT_PANEL_HANDLE_TRANSITION_CLASS,
  RIGHT_PANEL_SHELL_TRANSITION_CLASS,
  RIGHT_PANEL_WIDTH_TRANSITION_CLASS,
} from './paneLayoutStyles'
import { PaneOverlays } from './PaneOverlays'
import { type DesktopWorkbenchPaneProps } from './types'
import { usePaneChrome } from './usePaneChrome'
import { usePaneCloudBindings } from './usePaneCloudBindings'
import { usePaneIdentity } from './usePaneIdentity'
import { usePanePanelActions } from './usePanePanelActions'
import { usePaneWorkspacePanels } from './usePaneWorkspacePanels'
import { usePaneWorkspaceResources } from './usePaneWorkspaceResources'

export const DesktopWorkbenchPane = memo(function DesktopWorkbenchPane(
  props: DesktopWorkbenchPaneProps
) {
  const identity = usePaneIdentity(props)
  const cloudBindings = usePaneCloudBindings(identity)
  const workspacePanels = usePaneWorkspacePanels(cloudBindings)
  const workspaceResources = usePaneWorkspaceResources(workspacePanels)
  const panelActions = usePanePanelActions(workspaceResources)
  const chrome = usePaneChrome(panelActions)
  const model = chrome
  const {
    workflowComposerIntent,
    workbenchVisible,
    sidebarCollapsed,
    sidebarResizing,
    workspaceSessionApi,
    paneActive,
    background,
    workspaceFileApi,
    upgradingDevices,
    upgradeDevice,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    services,
    t,
    currentRuntimeTask,
    currentProject,
    turnNavigationPortalTarget,
    setTurnNavigationPortalTarget,
    environmentInfoTransitionEnabled,
    paneSession,
    workflowScope,
    activeWorkflow,
    activeWorkflowKey,
    onWorkflowDirtyChange,
    runtimeTaskTitle,
    submitPaneInput,
    visibleCloudMentionCandidates,
    cloudProjectMentionCandidates,
    handleSelectCloudProject,
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    loadEnvironmentDiff,
    isBootstrapping,
    devices,
    runtimeTaskWorkspacePath,
    loadWorkspaceMarkdownImage,
    rightPanelOpen,
    rightPanelView,
    setEmbeddedBrowserUrl,
    embeddedBrowserOpenRequest,
    temporaryChatInitialInputsRef,
    bottomPanelOpenByKey,
    openFileRequest,
    setHasPreviousTurnReview,
    isTauri,
    workbenchMainRef,
    workbenchScrollRef,
    workbenchContentWidth,
    setEnvironmentInfoPanelRef,
    reviewState,
    rightSplitChatWidth,
    rightSplitResizing,
    handleRightSplitResizeStart,
    workflowNarrow,
    workflowPaneExists,
    workflowCanvasVisible,
    workflowSplit,
    workflowNarrowShown,
    closeWorkflowCanvas,
    chatColumnWidth,
    environmentInfoDocked,
    environmentInfoOpen,
    rightPanelShellWidth,
    chatContentResizing,
    embeddedBrowserLabel,
    activeDeviceId,
    settingsTemplateBadge,
    settingsTemplatePicker,
    canOpenRuntimeBrowser,
    effectiveWorkspaceTarget,
    fileWorkspaceTargets,
    composerWorkspaceTarget,
    fileWorkspaceTarget,
    canBrowseFiles,
    effectiveRightPanelTabs,
    shouldRenderRightPanel,
    preferLocalWorkspaceTerminal,
    bottomPanelWorkspaceKey,
    bottomPanelContextsToRender,
    previousTurnReviewRef,
    paneMessages,
    pendingRequestUserInput,
    rightPanelPlanContent,
    paneQueuedMessages,
    paneGuidanceMessages,
    paneIsBusy,
    setModelSelectorOpenSignal,
    pendingModelRetryRef,
    setProjectMenuOpenSignal,
    setProjectMenuAnchorElement,
    hasConversation,
    hasMainBackground,
    canEditLastUserMessage,
    composerSupportsGoal,
    noStandaloneCompatibleDevice,
    composerDisabled,
    inlineComposerDisabledReason,
    projectChatWithModelSelectorSignal,
    emptyProjectWork,
    selectTaskSuggestion,
    selectRightPanelTab,
    addSelectionToConversation,
    askSelectionInSidebar,
    openAssistantPlan,
    closeRightPanelTab,
    openReviewFromDiffLoader,
    selectReviewView,
    selectFilesView,
    selectFileWorkspaceTarget,
    selectBrowserView,
    selectTerminalView,
    selectChatView,
    selectPlanView,
    openWorkspaceFileFromMessage,
    openLocalSkillFile,
    refreshReview,
    reviewViewOptions,
    fileChangesDiffPreviewDisabledSubtaskId,
    pauseCurrentResponse,
    shortenCurrentWait,
    shortenWaitAvailable,
    compactCurrentContext,
    setCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
    closeBottomPanelContext,
    handleTerminalTabsEmpty,
    paneTaskTitle,
    topBarLeftContent,
    showPageTopBar,
    hasSubagentStatuses,
    topRightActions,
    tauriMainHeaderContent,
  } = model
  return (
    <main
      ref={workbenchMainRef}
      className={cn(
        'absolute inset-x-0 bottom-0 flex min-w-0 flex-1 flex-col overflow-hidden',
        hasMainBackground ? 'bg-background/20' : 'bg-background',
        'transition-[margin] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        sidebarResizing && 'transition-none',
        'top-0',
        !isTauri && 'mt-1.5 rounded-xl border border-border/60 shadow-[0_3px_16px_rgba(0,0,0,0.04)]'
      )}
    >
      {/* Portals escape the hidden cached pane, so only the visible active pane may own the header. */}
      {tauriMainHeaderContent && paneActive && workbenchVisible ? (
        <WorkbenchMainHeaderPortal>{tauriMainHeaderContent}</WorkbenchMainHeaderPortal>
      ) : null}
      <>
        {!isTauri && (
          <div
            data-testid="workspace-panel-floating-actions"
            className="pointer-events-auto absolute right-8 top-1.5 z-popover flex shrink-0 items-center gap-1"
          >
            {topRightActions}
          </div>
        )}
        {showPageTopBar && (
          <DesktopTopBar
            testId="workbench-topbar"
            className={cn(
              'absolute left-0 top-0 z-chrome h-11 overflow-visible border-b border-border/50 pr-7',
              background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95',
              isTauri && sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
              rightSplitResizing || workflowSplit.resizing
                ? 'transition-none'
                : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
            )}
            style={{ width: chatColumnWidth }}
            left={topBarLeftContent}
            leftClassName={cn('min-w-0 gap-2', isTauri ? 'contents' : 'max-w-[calc(100%-12rem)]')}
          />
        )}
        {paneTaskTitle}
      </>
      <div className="relative flex min-h-0 flex-1 overflow-visible">
        <div
          ref={setTurnNavigationPortalTarget}
          data-testid="message-turn-navigation-overlay"
          className={cn(
            'pointer-events-none absolute bottom-0 left-0 z-popover',
            showPageTopBar ? 'top-11' : 'top-0'
          )}
          style={{ width: chatColumnWidth }}
        />
        <div
          ref={workbenchScrollRef}
          data-testid="desktop-workbench-content"
          inert={workflowNarrowShown || undefined}
          aria-hidden={workflowNarrowShown || undefined}
          className={cn(
            'relative grid h-full min-w-0 flex-none grid-cols-[minmax(0,1fr)_auto]',
            hasConversation ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden',
            rightSplitResizing || workflowSplit.resizing
              ? 'transition-none'
              : RIGHT_PANEL_WIDTH_TRANSITION_CLASS,
            showPageTopBar && 'pt-11'
          )}
          style={{ width: chatColumnWidth }}
        >
          {isBootstrapping ? (
            <div className="flex min-w-0 flex-1" data-testid="desktop-workbench-loading" />
          ) : hasConversation ? (
            <div className="relative min-h-0 min-w-0 flex-1">
              <WorkspaceMarkdownImageLoaderContext.Provider value={loadWorkspaceMarkdownImage}>
                <ScrollableMessageArea
                  messages={paneMessages}
                  loading={paneSession.transcriptLoading}
                  isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
                  hasMoreBefore={paneSession.transcriptHasMoreBefore}
                  loadingMoreBefore={paneSession.transcriptLoadingMoreBefore}
                  turnNavigation={paneSession.turnNavigation}
                  loadedTranscriptRanges={paneSession.loadedTranscriptRanges}
                  onLoadMoreBefore={paneSession.loadMoreTranscriptBefore}
                  onLoadFullTranscript={paneSession.loadFullTranscript}
                  loadingFullTranscript={paneSession.transcriptLoadingFullContent}
                  onLoadTurnNavigationItem={paneSession.loadTranscriptTurnNavigationItem}
                  onLoadTranscriptGap={paneSession.loadTranscriptGap}
                  toolsCatalogTaskId={currentRuntimeTask?.taskId}
                  toolsCatalogServerId={currentRuntimeTask?.deviceId}
                  conversationKey={
                    currentRuntimeTask
                      ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
                      : null
                  }
                  className="h-full"
                  scrollTestId="desktop-chat-scroll"
                  externalScrollRef={workbenchScrollRef}
                  turnNavigationPortalTarget={turnNavigationPortalTarget}
                  scrollerClassName="overflow-visible scrollbar-none"
                  messageListClassName={cn(
                    DESKTOP_MESSAGE_LIST_CLASS,
                    chatContentResizing && 'transition-none'
                  )}
                  stickyFooterClassName={cn(
                    DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
                    hasMainBackground
                      ? 'from-transparent via-transparent'
                      : 'from-background via-background',
                    chatContentResizing && 'transition-none'
                  )}
                  stickyFooter={<PaneComposer model={model} />}
                  scrollButtonClassName={DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS}
                  devices={devices}
                  onRetryFailedMessage={message => {
                    void paneSession.retryFailedMessage(message)
                  }}
                  onSwitchModelForFailedMessage={message => {
                    pendingModelRetryRef.current = message
                    setModelSelectorOpenSignal(signal => signal + 1)
                  }}
                  onLoadFileChangesDiff={(subtaskId, fileChanges) =>
                    loadTurnFileChangesDiff(
                      subtaskId,
                      paneMessages,
                      fileChanges,
                      currentRuntimeTask
                    )
                  }
                  onRevertFileChanges={(subtaskId, fileChanges) =>
                    revertTurnFileChanges(subtaskId, paneMessages, fileChanges, currentRuntimeTask)
                  }
                  onOpenFileChangesReview={({
                    subtaskId,
                    loadDiff,
                    reviewTitle,
                    defaultFileTreeVisible,
                    focusFilePath,
                  }) => {
                    previousTurnReviewRef.current = {
                      loadDiff,
                      defaultFileTreeVisible,
                      sourceSubtaskId: subtaskId,
                    }
                    setHasPreviousTurnReview(true)
                    void openReviewFromDiffLoader(loadDiff, {
                      reviewTitle,
                      reviewMode: 'previous-turn',
                      defaultFileTreeVisible,
                      focusFilePath,
                      sourceSubtaskId: subtaskId,
                    })
                  }}
                  fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
                  onOpenWorkspaceFile={openWorkspaceFileFromMessage}
                  onOpenLocalSkillFile={openLocalSkillFile}
                  onRequestUserInputSubmit={paneSession.sendRequestUserInputResponse}
                  onRequestUserInputIgnore={paneSession.ignoreRequestUserInput}
                  onOpenAssistantPlan={openAssistantPlan}
                  onEditLastUserMessage={paneSession.editLastUserMessage}
                  canEditLastUserMessage={canEditLastUserMessage}
                  onForkMessage={message => {
                    const workspacePath =
                      currentRuntimeTask?.workspacePath || runtimeTaskWorkspacePath
                    if (!currentRuntimeTask || !message.turnId || !workspacePath) return
                    return forkCurrentRuntimeTask(
                      {
                        deviceId: currentRuntimeTask.deviceId,
                        workspacePath,
                      },
                      { lastTurnId: message.turnId }
                    )
                  }}
                  hideRequestUserInputBlocks={Boolean(pendingRequestUserInput)}
                  hiddenRequestUserInputIds={paneSession.answeredRequestUserInputIds}
                  onAddSelectionToConversation={addSelectionToConversation}
                  onAskSelectionInSidebar={askSelectionInSidebar}
                />
              </WorkspaceMarkdownImageLoaderContext.Provider>
            </div>
          ) : (
            <DesktopEmptyTaskLauncher
              projectName={currentProject ? runtimeProjectLabel(currentProject, t) : undefined}
              onOpenProjectSelector={anchorElement => {
                setProjectMenuAnchorElement(anchorElement)
                setProjectMenuOpenSignal(signal => signal + 1)
              }}
              onSelectSuggestion={selectTaskSuggestion}
              composer={
                <>
                  <DeviceStatusPrompt
                    devices={devices}
                    upgradingDevices={upgradingDevices}
                    onUpgradeDevice={upgradeDevice}
                    onOpenCloudDeviceSettings={requestOpenCloudDeviceSettings}
                    activeDeviceId={activeDeviceId}
                    requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                    hideAvailableUpdates
                    className="mb-3"
                  />
                  <BufferedChatInput
                    value={paneSession.input}
                    onChange={paneSession.setInput}
                    onSubmit={submitPaneInput}
                    disabled={composerDisabled}
                    submitDisabled={paneSession.status.isSubmitting}
                    error={paneSession.error}
                    disabledReason={inlineComposerDisabledReason}
                    placeholder={t('workbench.input_placeholder', '随心输入')}
                    variant="desktop"
                    projectChat={projectChatWithModelSelectorSignal}
                    projectWork={emptyProjectWork}
                    queuedMessages={paneQueuedMessages}
                    guidanceMessages={paneGuidanceMessages}
                    codeComments={paneSession.codeCommentContexts}
                    cloudMentionCandidates={visibleCloudMentionCandidates}
                    cloudProjectCandidates={cloudProjectMentionCandidates}
                    cloudSpaceEnabled={Boolean(services?.deliveryApi)}
                    onSelectCloudProject={handleSelectCloudProject}
                    isStreaming={paneIsBusy}
                    onPause={pauseCurrentResponse}
                    onShortenWait={shortenCurrentWait}
                    shortenWaitAvailable={shortenWaitAvailable}
                    onCompactContext={compactCurrentContext}
                    goal={paneSession.goal}
                    sessionMode={paneSession.sessionMode}
                    workflowIntent={workflowComposerIntent}
                    workflowNavigationActive={paneActive}
                    settingsTemplatePicker={settingsTemplatePicker}
                    settingsTemplateBadge={settingsTemplateBadge}
                    onInspectExecutionModes={() =>
                      paneSession.getRuntimeSessionModes({
                        ...(currentRuntimeTask ? { address: currentRuntimeTask } : {}),
                        deviceId: effectiveWorkspaceTarget?.deviceId,
                        workspacePath: effectiveWorkspaceTarget?.path,
                      })
                    }
                    goalContinuing={paneSession.goalContinuing}
                    taskPlan={paneSession.taskPlan}
                    goalDraftActive={paneSession.goalDraftActive}
                    goalDraftMode={paneSession.goalDraftMode}
                    onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                    onCancelGoalDraft={paneSession.cancelGoalDraft}
                    onEditGoal={paneSession.editCurrentGoal}
                    onPauseGoal={pauseCurrentGoal}
                    onResumeGoal={resumeCurrentGoal}
                    onClearGoal={clearCurrentGoal}
                    onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                    onReorderQueuedMessages={paneSession.reorderQueuedMessages}
                    queuePaused={paneSession.queuedMessagesPaused}
                    onResumeQueue={paneSession.resumeQueuedMessages}
                    onResumeQueueWithInput={paneSession.resumeQueuedMessagesWithInput}
                    onClearQueue={paneSession.clearQueuedMessages}
                    onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                    onInterruptAndSendQueuedMessage={paneSession.interruptAndSendQueued}
                    onEditQueuedMessage={paneSession.editQueuedMessage}
                    onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                    onClearCodeComments={paneSession.clearCodeComments}
                    onOpenSkillFile={openLocalSkillFile}
                    workspaceTarget={composerWorkspaceTarget}
                    workspaceFileApi={workspaceFileApi}
                  />
                </>
              }
            />
          )}
          <aside
            data-testid="environment-info-panel-container"
            className={cn(
              'sticky top-0 z-popover flex h-full w-0 shrink-0 self-start flex-col overflow-hidden has-[[data-environment-info-popover]]:w-[320px] has-[[data-environment-info-popover]]:overflow-visible',
              hasSubagentStatuses && 'overflow-visible',
              environmentInfoTransitionEnabled
                ? 'transition-[width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'
                : 'transition-none'
            )}
          >
            <div ref={setEnvironmentInfoPanelRef} className="shrink-0" />
            {hasSubagentStatuses && (
              <div
                data-testid="workbench-subagent-status-row"
                className={
                  environmentInfoDocked && environmentInfoOpen
                    ? 'ml-2 mt-3 w-[300px]'
                    : 'absolute right-3 top-3 w-max'
                }
              >
                <SubagentStatusIndicator
                  statuses={paneSession.subagentStatuses}
                  onSteer={paneSession.steerSubagent}
                />
              </div>
            )}
          </aside>
        </div>
        {workflowCanvasVisible && !workflowNarrow && (
          <div
            {...workflowSplit.handleProps}
            data-testid="workflow-canvas-resize"
            aria-label={t('workflowCanvas.resizeCanvas')}
            className={`${PANE_RESIZE_HANDLE} absolute inset-y-0 -translate-x-1/2`}
            style={{ left: workflowSplit.width }}
          />
        )}
        {workflowPaneExists && activeWorkflow && currentRuntimeTask?.deviceId && (
          <div
            key={`${workflowScope}:${activeWorkflowKey}`}
            data-testid="workflow-pane"
            className={cn(
              'min-h-0 min-w-0 bg-background',
              !workflowCanvasVisible
                ? 'hidden'
                : workflowNarrow
                  ? workflowNarrowShown
                    ? 'absolute inset-0 z-popover flex'
                    : 'hidden'
                  : 'flex flex-1'
            )}
          >
            {activeWorkflow.version || activeWorkflow.runId ? (
              <WorkflowExecutionCanvas
                serverId={currentRuntimeTask.deviceId}
                threadId={currentRuntimeTask.taskId}
                reference={activeWorkflow}
                active={
                  paneActive &&
                  workbenchContentWidth > 0 &&
                  workflowCanvasVisible &&
                  (!workflowNarrow || workflowNarrowShown)
                }
                onClose={closeWorkflowCanvas}
              />
            ) : (
              <WorkflowConversationCanvas
                serverId={currentRuntimeTask.deviceId}
                definitionId={activeWorkflow.id}
                active={
                  paneActive &&
                  workbenchContentWidth > 0 &&
                  workflowCanvasVisible &&
                  (!workflowNarrow || workflowNarrowShown)
                }
                onClose={closeWorkflowCanvas}
                onDirtyChange={onWorkflowDirtyChange}
              />
            )}
          </div>
        )}
        {rightPanelOpen && (
          <div
            data-testid="right-workspace-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resize_right_workspace_panel')}
            aria-controls="right-workspace-panel-shell"
            className={cn(
              'absolute bottom-[-6px] top-0 z-critical w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 after:ease-out hover:after:bg-primary/40',
              rightSplitResizing || workflowSplit.resizing
                ? 'transition-none'
                : RIGHT_PANEL_HANDLE_TRANSITION_CLASS
            )}
            style={{ left: rightSplitChatWidth }}
            onPointerDown={handleRightSplitResizeStart}
          />
        )}
        <div
          id="right-workspace-panel-shell"
          data-testid="right-workspace-panel-shell"
          className={cn(
            'relative z-popover min-w-0 shrink-0 overflow-hidden',
            hasMainBackground ? 'bg-background/20' : 'bg-background',
            rightSplitResizing || workflowSplit.resizing
              ? 'transition-none'
              : RIGHT_PANEL_SHELL_TRANSITION_CLASS,
            rightPanelOpen
              ? 'pointer-events-auto border-l border-border/60 opacity-100'
              : 'pointer-events-none opacity-0'
          )}
          style={{ width: rightPanelShellWidth }}
          aria-hidden={!rightPanelOpen}
        >
          {shouldRenderRightPanel && (
            <RightWorkspacePanel
              showWorkbenchBackground={hasMainBackground}
              visible={paneActive && workbenchVisible && rightPanelOpen}
              activeView={rightPanelView}
              openTabs={effectiveRightPanelTabs}
              currentProject={workspaceProject}
              canOpenBrowser={canOpenRuntimeBrowser}
              canBrowseFiles={canBrowseFiles}
              currentRuntimeTask={currentRuntimeTask}
              devices={devices}
              workspaceTarget={effectiveWorkspaceTarget}
              fileWorkspaceTarget={fileWorkspaceTarget}
              fileWorkspaceTargets={fileWorkspaceTargets}
              preferLocalTerminal={preferLocalWorkspaceTerminal}
              terminalContextTitle={runtimeTaskTitle}
              workspaceSessionApi={workspaceSessionApi}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={openFileRequest}
              workspaceTargetError={openFileRequest?.target ? null : workspaceTargetError}
              review={reviewState}
              planContent={rightPanelPlanContent}
              embeddedBrowserLabel={embeddedBrowserLabel}
              embeddedBrowserOpenRequest={embeddedBrowserOpenRequest}
              onEmbeddedBrowserUrlChange={setEmbeddedBrowserUrl}
              codeCommentCount={paneSession.codeCommentContexts.length}
              reviewViewOptions={reviewViewOptions}
              canOpenReview={Boolean(loadEnvironmentDiff && workspaceTarget)}
              onAddCodeComment={paneSession.addCodeComment}
              onSelectFileWorkspaceTarget={selectFileWorkspaceTarget}
              onSelectReview={selectReviewView}
              onSelectTerminal={selectTerminalView}
              onSelectBrowser={selectBrowserView}
              onSelectFiles={selectFilesView}
              onSelectChat={selectChatView}
              onSelectPlan={selectPlanView}
              onSelectTab={selectRightPanelTab}
              onCloseTab={closeRightPanelTab}
              onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
              getChatInitialInput={tab => temporaryChatInitialInputsRef.current.get(tab)}
            />
          )}
        </div>
      </div>
      {bottomPanelContextsToRender.map(context => {
        const active = context.key === bottomPanelWorkspaceKey
        return (
          <MemoizedBottomWorkspacePanel
            key={context.key}
            panelKey={context.key}
            open={active && (bottomPanelOpenByKey[context.key] ?? false)}
            active={active}
            context={context}
            workspaceSessionApi={workspaceSessionApi}
            showWorkbenchBackground={hasMainBackground}
            onRequestClose={closeBottomPanelContext}
            onTerminalTabsEmpty={handleTerminalTabsEmpty}
          />
        )
      })}
      <PaneOverlays model={model} />
    </main>
  )
})
