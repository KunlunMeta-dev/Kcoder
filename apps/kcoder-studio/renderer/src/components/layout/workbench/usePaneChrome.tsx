import { useTaskBackgroundIssues } from '@/kcoder/backgroundIssues'
import { TaskChannelBindingControl } from '@/features/connectivity/TaskChannelBindingControl'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { useSubagentWorkspaceHost } from './useSubagentWorkspaceHost'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
} from '@/components/topnav/TitlebarActionsPortal'
import { cn } from '@/lib/utils'
import { ArrowLeftRight, ClipboardCheck, MessageCircle, MessageSquareWarning } from 'lucide-react'
import { useLayoutEffect } from 'react'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '../DesktopTopBar'
import { DesktopWindowControls } from '../DesktopWindowControls'
import { MacOSTitleBarDragRegion } from '../MacOSTitleBarDragRegion'
import { WorkspacePanelActions } from '../workspace-panels/WorkspacePanelActions'
import { RIGHT_PANEL_WIDTH_TRANSITION_CLASS } from './paneLayoutStyles'
import type { usePanePanelActions } from './usePanePanelActions'

export function usePaneChrome(context: ReturnType<typeof usePanePanelActions>, onOpenTaskReview: () => void) {
  const {
    workbenchVisible,
    sidebarCollapsed,
    workspaceSessionApi,
    onSidebarCollapsedChange,
    paneActive,
    experimentalFeaturesEnabled,
    background,
    forkCurrentRuntimeTask,
    services,
    t,
    tChat,
    currentRuntimeTask,
    currentProject,
    paneSession,
    boundCloudProject,
    boundCloudItem,
    setDeliveryDialogOpen,
    setTodoBindingPickerOpen,
    setDeliverAfterBinding,
    runtimeTaskTitle,
    activeDeliveryItem,
    workspaceTarget,
    environmentInfo,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    devices,
    rightPanelOpen,
    setRightPanelView,
    setRightPanelTabs,
    setSelectedAssistantPlan,
    setForkDialogOpen,
    setFeedbackDialogOpen,
    setHasPreviousTurnReview,
    isGateway,
    environmentInfoPanelElement,
    continueInIm,
    setReviewState,
    rightSplitResizing,
    environmentInfoDocked,
    environmentInfoOpen,
    setEnvironmentInfoOpen,
    paneTitleWidth,
    rightPanelTitlebarWidth,
    bottomPanelOpen,
    reviewRequestSequenceRef,
    previousTurnReviewRef,
    rightPanelSessionKey,
    previousRightPanelSessionKeyRef,
    openDefaultEnvironmentChangesReview,
    toggleRightPanel,
    toggleBottomPanel,
  } = context
  const renderWorkspacePanelActions = (
    mode:
      | 'all'
      | 'environment'
      | 'primary-target'
      | 'panel-toggles'
      | 'bottom-panel-toggle'
      | 'right-panel-toggle'
  ) => (
    <WorkspacePanelActions
      mode={mode}
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      workspaceSessionApi={workspaceSessionApi}
      environmentInfo={environmentInfo}
      environmentInfoPopoverContainer={environmentInfoPanelElement}
      environmentInfoVisible={Boolean(currentRuntimeTask)}
      environmentInfoDocked={environmentInfoDocked}
      environmentInfoOpen={environmentInfoOpen && paneActive && workbenchVisible}
      onEnvironmentInfoOpenChange={setEnvironmentInfoOpen}
      onRefreshEnvironmentInfo={refreshEnvironmentInfo}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
      onCommitAndPushEnvironmentChanges={commitAndPushEnvironmentChanges}
      onPushEnvironmentChanges={pushEnvironmentChanges}
      onListEnvironmentBranches={listEnvironmentBranches}
      onCheckoutEnvironmentBranch={checkoutEnvironmentBranch}
      onCreateEnvironmentBranch={createEnvironmentBranch}
      onOpenEnvironmentChangesReview={openDefaultEnvironmentChangesReview}
      onDeliver={
        experimentalFeaturesEnabled && currentRuntimeTask && services?.deliveryApi
          ? () => {
              if (activeDeliveryItem) {
                setDeliveryDialogOpen(true)
              } else {
                setDeliverAfterBinding(true)
                setTodoBindingPickerOpen(true)
              }
            }
          : undefined
      }
      todoLabel={
        boundCloudItem ? `${boundCloudItem.id} · ${boundCloudItem.title}` : boundCloudProject?.name
      }
      onManageTodo={
        experimentalFeaturesEnabled && currentRuntimeTask && services?.deliveryApi
          ? () => {
              setDeliverAfterBinding(false)
              setTodoBindingPickerOpen(true)
            }
          : undefined
      }
      rightPanelOpen={rightPanelOpen}
      bottomPanelOpen={bottomPanelOpen}
      onToggleRightPanel={toggleRightPanel}
      onToggleBottomPanel={toggleBottomPanel}
    />
  )

  const workspacePanelActions = renderWorkspacePanelActions('all')

  const mainHeaderProjectAction = renderWorkspacePanelActions('primary-target')

  const mainHeaderEnvironmentAction = renderWorkspacePanelActions('environment')

  const panelChromeActions = renderWorkspacePanelActions('panel-toggles')

  const paneTaskTitle =
    runtimeTaskTitle && !isGateway ? (
      <div
        data-testid="workbench-pane-task-title"
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-chrome flex h-11 min-w-0 truncate items-center pr-7 text-sm font-medium leading-normal text-text-primary',
          sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: paneTitleWidth }}
      >
        <span className="block w-full min-w-0 truncate">{runtimeTaskTitle}</span>
      </div>
    ) : undefined

  const showPageTopBar = !isGateway

  const subagentWorkspaceHost = useSubagentWorkspaceHost(
    services?.runtimeWorkApi,
    currentRuntimeTask,
    paneSession.subagentStatuses ?? [],
    runtimeTaskTitle ?? undefined
  )
  const hasSubagentStatuses = subagentWorkspaceHost.statuses.length > 0

  const canForkCurrentRuntimeTask = Boolean(
    experimentalFeaturesEnabled && currentRuntimeTask && forkCurrentRuntimeTask
  )

  const forkTaskButton = canForkCurrentRuntimeTask ? (
    <button
      type="button"
      data-testid="fork-runtime-task-button"
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
      aria-label={t('workbench.task_fork_button')}
      title={t('workbench.task_fork_button')}
      onClick={() => setForkDialogOpen(true)}
    >
      <ArrowLeftRight />
    </button>
  ) : undefined

  const canContinueInIm = experimentalFeaturesEnabled && Boolean(currentRuntimeTask)

  const continueInImButton = canContinueInIm ? (
    <button
      type="button"
      data-testid="continue-in-im-button"
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
      aria-label={t('workbench.continue_im_title')}
      title={t('workbench.continue_im_title')}
      onClick={continueInIm.openDialog}
    >
      <MessageCircle />
    </button>
  ) : undefined

  const backgroundIssues = useTaskBackgroundIssues(currentRuntimeTask ?? undefined)

  const feedbackButton =
    currentRuntimeTask && isGateway ? (
      <button
        type="button"
        data-testid="task-feedback-button"
        className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, 'relative')}
        aria-label={backgroundIssues.length ? `${t('workbench.feedback_button')} · ${t('workbench.feedback_pending_issues', { count: backgroundIssues.length })}` : t('workbench.feedback_button')}
        title={t('workbench.feedback_button')}
        onClick={() => setFeedbackDialogOpen(true)}
      >
        <MessageSquareWarning />
        {backgroundIssues.length > 0 && <span data-testid="task-feedback-issue-count" className="absolute -right-1 -top-1 rounded-full bg-muted px-1 text-xs" aria-label={t('workbench.feedback_pending_issues', { count: backgroundIssues.length })}>{backgroundIssues.length}</span>}
      </button>
    ) : undefined

  const taskReviewButton = currentRuntimeTask ? (
    <button
      type="button"
      data-testid="task-review-toolbar-button"
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
      aria-label={tChat('taskReview.title')}
      title={tChat('taskReview.title')}
      onClick={onOpenTaskReview}
    >
      <ClipboardCheck />
    </button>
  ) : undefined

  const channelBindingButton = currentRuntimeTask && paneActive && workbenchVisible ? (
    <TaskChannelBindingControl
      key={JSON.stringify([currentRuntimeTask.deviceId, currentRuntimeTask.workspacePath, currentRuntimeTask.taskId, runtimeThreadId(currentRuntimeTask)])}
      address={currentRuntimeTask}
      compact
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
    />
  ) : undefined

  const mainHeaderActions = (
    <>
      {forkTaskButton}
      {continueInImButton}
      {feedbackButton}
      {mainHeaderProjectAction}
      {taskReviewButton}
      {channelBindingButton}
      {mainHeaderEnvironmentAction}
    </>
  )

  const sidebarToggle = (
    <DesktopWindowControls
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={() => onSidebarCollapsedChange(!sidebarCollapsed)}
      className="gap-1"
    />
  )
  const topRightActions = (
    <>
      {sidebarToggle}
      {forkTaskButton}
      {continueInImButton}
      {taskReviewButton}
      {channelBindingButton}
      {workspacePanelActions}
    </>
  )

  const gatewayMainHeaderContent = isGateway ? (
    <div className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden">
      <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
      {runtimeTaskTitle ? (
        <div
          data-testid="workbench-pane-task-title"
          className={cn(
            'pointer-events-none relative z-0 flex h-full min-w-0 flex-1 items-center truncate pl-4 text-sm font-medium leading-normal text-text-primary',
            rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
          )}
        >
          <span className="block min-w-0 truncate">{runtimeTaskTitle}</span>
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <div
        data-testid="titlebar-main-actions"
        className="relative z-0 flex h-full shrink-0 items-center justify-end gap-1 pr-1"
      >
        {mainHeaderActions}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'shrink-0',
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: rightPanelTitlebarWidth }}
      />
      <div
        data-testid="titlebar-right-workspace-zone"
        className={cn(
          'pointer-events-none absolute right-0 top-0 z-chrome flex h-full min-w-0 items-center overflow-hidden',
          background.imagePath && background.inTopBar ? 'bg-transparent' : 'bg-background/95',
          rightPanelOpen ? 'border-l border-border/60' : undefined,
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: rightPanelTitlebarWidth }}
      >
        <div
          id={TITLEBAR_RIGHT_PANEL_PORTAL_ID}
          data-testid="titlebar-right-panel"
          className="pointer-events-none flex h-full min-w-0 flex-1 items-center"
        />
        <div
          id={TITLEBAR_ACTIONS_PORTAL_ID}
          data-testid="titlebar-actions"
          className="pointer-events-auto flex h-full min-w-[7.5rem] shrink-0 items-center justify-end gap-1 pr-2"
        >
          {sidebarToggle}
          {panelChromeActions}
        </div>
      </div>
    </div>
  ) : undefined

  useLayoutEffect(() => {
    if (previousRightPanelSessionKeyRef.current === rightPanelSessionKey) {
      return
    }

    previousRightPanelSessionKeyRef.current = rightPanelSessionKey
    reviewRequestSequenceRef.current += 1
    previousTurnReviewRef.current = null
    setHasPreviousTurnReview(false)
    setRightPanelView('launcher')
    setRightPanelTabs([])
    setSelectedAssistantPlan(null)
    setReviewState({
      loading: false,
      diff: '',
      error: undefined,
      reviewTitle: undefined,
      reviewMode: undefined,
      defaultFileTreeVisible: undefined,
      branchName: undefined,
      targetBranchName: undefined,
      reloadDiff: undefined,
    })
  }, [
    previousRightPanelSessionKeyRef,
    previousTurnReviewRef,
    reviewRequestSequenceRef,
    rightPanelSessionKey,
    setHasPreviousTurnReview,
    setReviewState,
    setRightPanelTabs,
    setRightPanelView,
    setSelectedAssistantPlan,
  ])
  return {
    ...context,
    renderWorkspacePanelActions,
    workspacePanelActions,
    mainHeaderProjectAction,
    mainHeaderEnvironmentAction,
    panelChromeActions,
    paneTaskTitle,
    showPageTopBar,
    hasSubagentStatuses,
    subagentWorkspaceHost,
    canForkCurrentRuntimeTask,
    forkTaskButton,
    canContinueInIm,
    continueInImButton,
    feedbackButton,
    mainHeaderActions,
    topRightActions,
    gatewayMainHeaderContent,
  }
}
