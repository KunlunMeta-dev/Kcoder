import type { WorkbenchPaneSessionOptions } from './pane/sessionTypes'
import { usePaneComposer } from './pane/usePaneComposer'
import { usePaneDiagnostics } from './pane/usePaneDiagnostics'
import { usePaneGoal } from './pane/usePaneGoal'
import { usePaneInteractions } from './pane/usePaneInteractions'
import { usePaneQueueControls } from './pane/usePaneQueueControls'
import { usePaneQueueDispatch } from './pane/usePaneQueueDispatch'
import { usePaneRestore } from './pane/usePaneRestore'
import { usePaneSend } from './pane/usePaneSend'
import { usePaneState } from './pane/usePaneState'
import { usePaneSubscription } from './pane/usePaneSubscription'
import { usePaneTranscript } from './pane/usePaneTranscript'
export {
  filterBufferedTranscriptActions,
  reconcileRuntimeConversationMessages,
  transcriptSettlesLatestSeededTurn,
} from './pane/paneMessageReducer'
export { requestUserInputAnswerScopeKey } from './pane/sessionIdentity'

export function useWorkbenchPaneSession(options: WorkbenchPaneSessionOptions) {
  const state = usePaneState(options)
  const restored = usePaneRestore(state)
  const subscribed = usePaneSubscription(restored)
  const transcript = usePaneTranscript(subscribed)
  const sending = usePaneSend(transcript)
  const interactions = usePaneInteractions(sending)
  const queueDispatch = usePaneQueueDispatch(interactions)
  const composer = usePaneComposer(queueDispatch)
  const queueControls = usePaneQueueControls(composer)
  const goals = usePaneGoal(queueControls)
  const diagnostics = usePaneDiagnostics(goals)
  const {
    currentRuntimeTask,
    getRuntimeSessionModes,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    input,
    error,
    setInput,
    answeredRequestUserInputIds,
    transcriptLoading,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    transcriptLoadingFullContent,
    transcriptFullContent,
    loadedTranscriptRanges,
    turnNavigation,
    subagentStatuses,
    taskPlan,
    goalDraftActive,
    goalDraftMode,
    steerSubagent,
    readSubagentArtifact,
    messages,
    paneStatus,
    goal,
    loadMoreTranscriptBefore,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    loadFullTranscript,
    retryFailedMessageInPane,
    sendRequestUserInputResponse,
    editLastUserMessageInPane,
    ignoreRequestUserInput,
    loadFullTranscriptForExport,
    send,
    addCodeComment,
    clearCodeComments,
    cancelQueuedMessage,
    resumeQueuedMessages,
    resumeQueuedMessagesWithInput,
    clearQueuedMessages,
    reorderQueuedMessages,
    editQueuedMessage,
    sendQueuedAsGuidance,
    interruptAndSendQueued,
    compactContext,
    setCurrentGoal,
    cancelGoalDraft,
    editCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    shortenCurrentWait,
    pauseCurrentResponse,
    clearCurrentGoal,
    cancelGuidanceMessage,
    goalContinuing,
    loadedSessionMode,
    loadedSessionTemplate,
  } = diagnostics
  return {
    getRuntimeSessionModes,
    workflowDefinitionId:
      loadedSessionMode?.taskId === currentRuntimeTask?.taskId
        ? loadedSessionMode?.workflowDefinitionId
        : undefined,
    sessionMode:
      loadedSessionMode?.taskId === currentRuntimeTask?.taskId
        ? loadedSessionMode?.mode
        : undefined,
    sessionTemplateBinding:
      loadedSessionTemplate?.taskId === currentRuntimeTask?.taskId
        ? (loadedSessionTemplate?.binding ?? null)
        : null,
    messages,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    input,
    setInput,
    error,
    status: paneStatus,
    sending: paneStatus.isSubmitting,
    waitingForAssistant: paneStatus.isWaitingForAssistantIndicator,
    answeredRequestUserInputIds,
    transcriptLoading,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    transcriptLoadingFullContent,
    transcriptFullContent,
    loadedTranscriptRanges,
    turnNavigation,
    subagentStatuses,
    steerSubagent,
    readSubagentArtifact,
    goal,
    goalContinuing,
    taskPlan,
    goalDraftActive,
    goalDraftMode,
    loadMoreTranscriptBefore,
    loadFullTranscript,
    loadFullTranscriptForExport,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    send,
    retryFailedMessage: retryFailedMessageInPane,
    editLastUserMessage: editLastUserMessageInPane,
    sendRequestUserInputResponse,
    ignoreRequestUserInput,
    addCodeComment,
    clearCodeComments,
    cancelQueuedMessage,
    resumeQueuedMessages,
    resumeQueuedMessagesWithInput,
    clearQueuedMessages,
    reorderQueuedMessages,
    sendQueuedAsGuidance,
    interruptAndSendQueued,
    editQueuedMessage,
    cancelGuidanceMessage,
    pauseCurrentResponse,
    shortenCurrentWait,
    compactContext,
    setCurrentGoal,
    cancelGoalDraft,
    editCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
  }
}
export type WorkbenchPaneSession = ReturnType<typeof useWorkbenchPaneSession>
