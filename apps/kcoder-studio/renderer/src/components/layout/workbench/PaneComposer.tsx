import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import {
  isImplementationPlanConfirmationResponse,
  isImplementationPlanRequestUserInput,
  requestUserInputPayloadKey,
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
  DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS,
  DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
} from './paneLayoutStyles'
import type { usePaneChrome } from './usePaneChrome'

export function PaneComposer({ model }: { model: ReturnType<typeof usePaneChrome> }) {
  const {
    workflowComposerIntent,
    paneActive,
    workspaceFileApi,
    upgradingDevices,
    upgradeDevice,
    services,
    openStandaloneWorkspace,
    t,
    currentRuntimeTask,
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
          {paneActive &&
            workbenchContentWidth > 0 &&
            currentRuntimeTask?.deviceId &&
            workflowRefs.length > 0 && (
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
            )}
          {pendingRequestUserInput ? (
            <RequestUserInputCard
              key={requestUserInputPayloadKey(pendingRequestUserInput) ?? 'implementation-plan'}
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
          ) : (
            <BufferedChatInput
              insertion={conversationSelectionInsertion}
              value={paneSession.input}
              onChange={paneSession.setInput}
              onSubmit={submitPaneInput}
              disabled={composerDisabled}
              submitDisabled={paneSession.status.isSubmitting}
              error={paneSession.error}
              disabledReason={inlineComposerDisabledReason}
              placeholder={t('workbench.follow_up_placeholder', '要求后续变更')}
              variant="desktop"
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
        </div>
      </div>
    </>
  )
}
