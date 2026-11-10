import { TaskConnectionNotice } from '@/components/chat/composer/TaskConnectionNotice'
import { TaskAgentSummary } from '@/features/experts/TaskAgentSummary'
import { taskAgentBinding } from '@/features/experts/taskAgentBinding'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskExpertControl } from '@/features/experts/TaskExpertControl'
import { composerInputHistoryScope } from '@/components/chat/composer/composerInputHistory'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { AsyncQuestionPanel } from '@/components/chat/AsyncQuestionPanel'
import {
  isImplementationPlanConfirmationResponse,
  isImplementationPlanRequestUserInput,
} from '@/components/chat/requestUserInputMessages'
import { WorkflowConversationCards } from '@/features/workflows/WorkflowConversationCards'
import { workflowReferenceKey } from '@/features/workflows/workflowReferences'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { cn } from '@/lib/utils'
import { BufferedChatInput } from '../BufferedChatInput'
import { ConversationDeviceOfflineBanner } from '../ConversationDeviceOfflineBanner'
import { DeviceStatusPrompt } from '../DeviceStatusPrompt'
import { requestOpenCloudDeviceSettings } from '../workbenchShellEvents'
import {
  ComposerStatusItem,
  ComposerStatusRegion,
} from '@/components/chat/composer/ComposerStatusRegion'
import { GitBranch } from 'lucide-react'
import {
  DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS,
  DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
} from './paneLayoutStyles'
import type { usePaneChrome } from './usePaneChrome'

export function PaneComposer({ model }: { model: ReturnType<typeof usePaneChrome> }) {
  const { t: expertT } = useTranslation('experts')
  const {
    workflowComposerIntent,
    paneActive,
    paneKey,
    workspaceFileApi,
    upgradingDevices,
    upgradeDevice,
    services,
    openStandaloneWorkspace,
    t,
    currentRuntimeTask,
    runtimeWork,
    paneSession,
    workflowComposerInput,
    workflowScope,
    workflowRefs,
    setWorkflowView,
    activeWorkflowKey,
    workflowHasDirtyEditor,
    submitPaneInput,
    visibleCloudMentionCandidates,
    cloudProjectMentionCandidates,
    handleSelectCloudProject,
    paneProjectWork,
    devices,
    conversationSelectionInsertion,
    workbenchContentWidth,
    closeRightPanel,
    chatContentResizing,
    activeDeviceId,
    settingsTemplateBadge,
    settingsTemplatePicker,
    effectiveWorkspaceTarget,
    composerWorkspaceTarget,
    pendingRequestUserInput,
    paneQueuedMessages,
    paneGuidanceMessages,
    paneIsBusy,
    hasMainBackground,
    activeDevice,
    composerSupportsGoal,
    showConversationDeviceBanner,
    noStandaloneCompatibleDevice,
    composerDisabled,
    inlineComposerDisabledReason,
    projectChatWithModelSelectorSignal,
    openLocalSkillFile,
    pauseCurrentResponse,
    shortenCurrentWait,
    shortenWaitAvailable,
    compactCurrentContext,
    setCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
  } = model
  const channelReadOnly =
    taskAgentBinding(currentRuntimeTask)?.source === 'channel' ||
    !!currentRuntimeTask?.runtimeHandle?.channelTaskSource
  const composerStatusOwnerKey = JSON.stringify([
    currentRuntimeTask?.deviceId ?? effectiveWorkspaceTarget?.deviceId ?? activeDeviceId ?? '',
    currentRuntimeTask?.taskId ?? projectChatWithModelSelectorSignal.scopeKey ?? null,
    currentRuntimeTask?.threadId ?? null,
  ])
  return (
    <>
      <div
        className={cn(
          DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS,
          hasMainBackground ? 'from-transparent via-transparent' : 'from-background via-background'
        )}
        data-testid="desktop-floating-composer-backdrop"
      />
      <div
        className={cn(
          DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
          chatContentResizing && 'transition-none'
        )}
        data-testid="desktop-floating-composer-layer"
      >
        <div className="pointer-events-auto" data-testid="desktop-floating-composer-card">
          {showConversationDeviceBanner ? (
            <ConversationDeviceOfflineBanner
              device={activeDevice}
              deviceId={activeDeviceId}
              className="mb-2"
            />
          ) : (
            <DeviceStatusPrompt
              devices={devices}
              upgradingDevices={upgradingDevices}
              onUpgradeDevice={upgradeDevice}
              onOpenCloudDeviceSettings={requestOpenCloudDeviceSettings}
              activeDeviceId={activeDeviceId}
              requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
              hideAvailableUpdates
              className="mb-2"
            />
          )}
          {currentRuntimeTask && (
            <>
              <TaskConnectionNotice address={currentRuntimeTask} />
              <TaskAgentSummary address={currentRuntimeTask} showExpertName={false} />
            </>
          )}
          <ComposerStatusRegion ownerKey={composerStatusOwnerKey}>
            {paneActive &&
              workbenchContentWidth > 0 &&
              currentRuntimeTask?.deviceId &&
              workflowRefs.length > 0 && (
                <ComposerStatusItem
                  id="workflows"
                  title={t('workflowCanvas.heading')}
                  summary={workflowRefs.length === 1 ? workflowRefs[0].title : undefined}
                  count={workflowRefs.length}
                  icon={GitBranch}
                  order={60}
                >
                  <WorkflowConversationCards
                    key={workflowScope}
                    conversationId={workflowScope}
                    serverId={currentRuntimeTask.deviceId}
                    references={workflowRefs}
                    disabled={paneIsBusy || workflowHasDirtyEditor}
                    onOpen={reference => {
                      if (
                        !workflowHasDirtyEditor ||
                        workflowReferenceKey(reference) === activeWorkflowKey
                      ) {
                        closeRightPanel()
                        setWorkflowView({
                          scope: workflowScope,
                          reference,
                          canvas: true,
                        })
                      }
                    }}
                    newConversation={paneSession.sessionMode === 'workflow_draft'}
                    onUse={async (text, reference) => {
                      if (paneSession.sessionMode !== 'workflow_draft') {
                        paneSession.setInput(
                          workflowComposerInput.current.trim()
                            ? `${workflowComposerInput.current}\n\n${text}`
                            : text
                        )
                        return
                      }
                      if (!composerWorkspaceTarget || !reference.version)
                        throw new Error(t('workflowCanvas.workspaceRequired'))
                      const valid = captureAccountContextRevision()
                      const target = composerWorkspaceTarget
                      await openStandaloneWorkspace(target.deviceId, target.path)
                      if (valid(target.deviceId))
                        workflowComposerIntent.onChange({
                          active: false,
                          run: {
                            id: reference.id,
                            version: reference.version,
                            deviceId: target.deviceId,
                            workspacePath: target.path,
                          },
                        })
                    }}
                  />
                </ComposerStatusItem>
              )}
            {paneActive && currentRuntimeTask ? (
              <AsyncQuestionPanel
                key={JSON.stringify([
                  currentRuntimeTask.deviceId,
                  currentRuntimeTask.taskId,
                  currentRuntimeTask.threadId ?? null,
                ])}
                address={currentRuntimeTask}
                pendingCreation={findRuntimeTask(runtimeWork, currentRuntimeTask)?.status === 'creating'}
              />
            ) : null}
            {!pendingRequestUserInput && (
              <BufferedChatInput
                historyMessages={paneSession.messages}
                inputHistoryScope={composerInputHistoryScope(
                  currentRuntimeTask,
                  projectChatWithModelSelectorSignal.scopeKey
                )}
                insertion={conversationSelectionInsertion}
                insertionScopeKey={JSON.stringify([
                  paneKey,
                  projectChatWithModelSelectorSignal.scopeKey,
                ])}
                value={paneSession.input}
                onChange={paneSession.setInput}
                onSubmit={submitPaneInput}
                disabled={composerDisabled || channelReadOnly}
                submitDisabled={paneSession.status.isSubmitting}
                error={paneSession.error}
                disabledReason={
                  channelReadOnly ? expertT('task.channelReadOnly') : inlineComposerDisabledReason
                }
                placeholder={
                  taskAgentBinding(currentRuntimeTask)
                    ? expertT('conversation.placeholder')
                    : t('workbench.follow_up_placeholder', '要求后续变更')
                }
                variant="desktop"
                toolbarLeadingContext={
                  !workflowComposerIntent?.active && (currentRuntimeTask || paneActive) ? (
                    <TaskExpertControl
                      address={currentRuntimeTask}
                      deviceId={activeDeviceId}
                      workspacePath={effectiveWorkspaceTarget?.path}
                    />
                  ) : undefined
                }
                projectChat={projectChatWithModelSelectorSignal}
                projectWork={paneProjectWork}
                showProjectWorkBar={false}
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
            )}
          </ComposerStatusRegion>
          {pendingRequestUserInput ? (
            <RequestUserInputCard
              key={JSON.stringify([composerStatusOwnerKey, currentRuntimeTask?.workspacePath])}
              aliasesByKey={paneSession.requestUserInputAliasTrackerRef.current.aliasesByKey}
              payload={pendingRequestUserInput}
              onSubmit={response => {
                const isImplementationPlanRequest =
                  isImplementationPlanRequestUserInput(pendingRequestUserInput)
                const shouldImplementPlan =
                  isImplementationPlanRequest && isImplementationPlanConfirmationResponse(response)
                return paneSession.sendRequestUserInputResponse(response, {
                  appendUserMessage: isImplementationPlanRequest,
                  forceDefaultCollaborationMode: shouldImplementPlan,
                })
              }}
              onIgnore={() => paneSession.ignoreRequestUserInput(pendingRequestUserInput)}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}
