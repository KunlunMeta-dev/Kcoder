import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import {
  cacheRuntimeAnsweredRequestUserInputIds,
  cacheRuntimeConversationQueuedMessagesByKey,
  cacheRuntimeConversationQueuePausedByKey,
  getRuntimeAnsweredRequestUserInputIds,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuePausedByKey,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { deriveRuntimePaneStatus } from '@/features/workbench/runtimePaneStatus'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import i18n from '@/i18n'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { createRandomUuid } from '@/lib/random-id'
import { visibleRuntimeGoal } from '@/lib/runtime-goal'
import { subagentArtifactKindFromPath } from '@/lib/subagent-artifact'
import type {
  Attachment,
  RuntimeGoal,
  RuntimeGoalContinuationPayload,
  RuntimePlanEventPayload,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
} from '@/types/api'
import type {
  GuidanceWorkbenchMessage,
  RuntimePaneQueuedMessage,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { TranscriptPageGate } from '../transcriptPageGate'
import {
  debugRuntimePaneMessageFlow,
  isBatchableRuntimePaneMessageAction,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
} from './paneDiagnostics'
import {
  createLocalUserMessage,
  splitActiveAssistantForGuidance,
  transformRuntimePaneActionForGuidanceSplits,
  type CreateLocalUserMessageOptions,
} from './paneMessageReducer'
import {
  isPendingGoalVisibleForRuntimeTarget,
  isUnboundPendingGoalState,
  noopSetInput,
  runtimeTaskLoadTargetFromAddress,
} from './sessionIdentity'
import {
  type GuidanceSplitBoundary,
  type LoadedTranscriptRange,
  type PendingRuntimeGoalState,
  type RuntimeTaskLoadTarget,
  type WorkbenchPaneSessionOptions,
} from './sessionTypes'

export function usePaneState(options: WorkbenchPaneSessionOptions) {
  const { currentRuntimeTask } = options
  const {
    projectChat,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    getRuntimeGoal,
    getRuntimeSessionModes,
    setRuntimeGoal,
    clearRuntimeGoal,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    steerRuntimePaneSubagent,
    readRuntimePaneSubagentArtifact,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    shortenCurrentWait: shortenCurrentWaitAction,
    sendCurrentInput,
    retryFailedMessage: retryRuntimeFailedMessage,
    refreshWorkLists,
  } = useWorkbenchPaneContext()

  const lifecycleStore = useRuntimeTaskLifecycleStore()

  const queuedMessageScopeKey = currentRuntimeTask
    ? runtimeConversationKey(currentRuntimeTask)
    : null

  const [queuedMessages, setQueuedMessagesState] = useState<RuntimePaneQueuedMessage[]>(() =>
    queuedMessageScopeKey ? getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey) : []
  )

  const [queuedMessagesPaused, setQueuedMessagesPausedState] = useState(() =>
    queuedMessageScopeKey ? getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey) : false
  )

  const setQueuedMessages = useCallback(
    (update: SetStateAction<RuntimePaneQueuedMessage[]>) => {
      if (!queuedMessageScopeKey) return
      const previous = getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey)
      const next = typeof update === 'function' ? update(previous) : update
      if (next === previous) return
      cacheRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey, next)
      setQueuedMessagesState(next)
    },
    [queuedMessageScopeKey]
  )

  const setQueuedMessagesPaused = useCallback(
    (update: SetStateAction<boolean>) => {
      if (!queuedMessageScopeKey) return
      const previous = getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey)
      const next = typeof update === 'function' ? update(previous) : update
      if (next === previous) return
      cacheRuntimeConversationQueuePausedByKey(queuedMessageScopeKey, next)
      setQueuedMessagesPausedState(next)
    },
    [queuedMessageScopeKey]
  )

  const [guidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])

  const [codeCommentContexts, setCodeCommentContexts] = useState<CodeCommentContext[]>([])

  const input = projectChat.input ?? ''

  const scopedSetInput = projectChat.setInput ?? noopSetInput

  const [error, setError] = useState<string | null>(null)

  const setInput = useCallback(
    (value: string) => {
      scopedSetInput(value)
      setError(null)
    },
    [scopedSetInput]
  )

  const [answeredRequestUserInputIds, setAnsweredRequestUserInputIds] = useState<
    ReadonlySet<string>
  >(() =>
    currentRuntimeTask ? getRuntimeAnsweredRequestUserInputIds(currentRuntimeTask) : new Set()
  )

  const answeredRequestUserInputIdsRef = useRef(answeredRequestUserInputIds)

  const requestUserInputAliasTrackerRef = useRef(createRequestUserInputAliasTracker())

  const [transcriptLoading, setTranscriptLoading] = useState(() => Boolean(currentRuntimeTask))

  const transcriptPageGateRef = useRef(new TranscriptPageGate())

  const [transcriptHasMoreBefore, setTranscriptHasMoreBefore] = useState(false)

  const [transcriptBeforeCursor, setTranscriptBeforeCursor] = useState<string | null>(null)

  const [transcriptLoadingMoreBefore, setTranscriptLoadingMoreBefore] = useState(false)

  const [transcriptLoadingFullContent, setTranscriptLoadingFullContent] = useState(false)

  const [transcriptFullContent, setTranscriptFullContent] = useState(false)

  const [loadedTranscriptRanges, setLoadedTranscriptRanges] = useState<LoadedTranscriptRange[]>([])

  const [turnNavigation, setTurnNavigation] = useState<RuntimeTurnNavigationItem[]>([])

  const [subagentStatuses, setSubagentStatuses] = useState<RuntimeSubagentStatus[]>([])

  const [threadGoal, setThreadGoal] = useState<RuntimeGoal | null>(null)

  const [goalContinuation, setGoalContinuation] = useState<RuntimeGoalContinuationPayload | null>(
    null
  )

  const [taskPlan, setTaskPlan] = useState<RuntimePlanEventPayload | null>(null)

  const [pendingGoalState, setPendingGoalState] = useState<PendingRuntimeGoalState | null>(null)

  const [goalDraftActive, setGoalDraftActive] = useState(false)

  const [goalDraftMode, setGoalDraftMode] = useState<RuntimeGoal['mode']>('standard')

  const loadedRuntimeTranscriptKeyRef = useRef<string | null>(null)

  const [receiptTranscriptRevision, setReceiptTranscriptRevision] = useState(0)

  const loadRuntimeTranscriptForPaneRef = useRef(loadRuntimeTranscriptForPane)

  const subscribeRuntimeTaskStreamRef = useRef(subscribeRuntimeTaskStream)

  const getRuntimeGoalRef = useRef(getRuntimeGoal)

  const goalRevisionRef = useRef(0)

  const commitThreadGoal = useCallback((nextGoal: RuntimeGoal | null) => {
    goalRevisionRef.current += 1
    setThreadGoal(nextGoal)
  }, [])

  const steerSubagent = useCallback(
    async (agentId: string, message: string): Promise<boolean> => {
      if (!currentRuntimeTask) {
        setError(i18n.t('common:workbench.subagent_steer_missing_task'))
        return false
      }
      try {
        const response = await steerRuntimePaneSubagent({
          address: currentRuntimeTask,
          agentId,
          message,
          clientMessageId: createRandomUuid(),
        })
        if (!response.accepted || !response.queued) {
          throw new Error(response.reasonCode || i18n.t('common:workbench.subagent_steer_rejected'))
        }
        return true
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : i18n.t('common:workbench.subagent_steer_rejected')
        )
        return false
      }
    },
    [currentRuntimeTask, steerRuntimePaneSubagent]
  )

  const readSubagentArtifact = useCallback(
    async (path: string) => {
      const kind = subagentArtifactKindFromPath(path)
      if (!kind || !currentRuntimeTask) return null
      try {
        return await readRuntimePaneSubagentArtifact({
          address: currentRuntimeTask,
          path,
          kind,
        })
      } catch {
        return null
      }
    },
    [currentRuntimeTask, readRuntimePaneSubagentArtifact]
  )

  const refreshWorkListsRef = useRef(refreshWorkLists)

  const currentRuntimeTaskRef = useRef(currentRuntimeTask)

  const runtimeTaskLoadTargetRef = useRef<RuntimeTaskLoadTarget | null>(null)

  const displayedTranscriptIdentityRef = useRef<string | null>(null)

  const loadedTranscriptRangesRef = useRef<LoadedTranscriptRange[]>([])

  const guidanceSplitBoundariesRef = useRef(new Map<string, GuidanceSplitBoundary>())

  const pendingAppliedGuidancesRef = useRef(new Map<string, RuntimePaneQueuedMessage>())

  const interruptedGuidanceIdsRef = useRef(new Set<string>())

  const interruptAndSendInFlightRef = useRef(false)

  const queuedMessageSendInFlightIdsRef = useRef(new Set<string>())

  const pendingMessageActionsRef = useRef<RuntimePaneMessageAction[]>([])

  const rebuildingTranscriptRef = useRef(false)

  const transcriptGapGenerationRef = useRef(0)

  const forceAuthoritativeTranscriptRef = useRef(false)

  const rebuildingTranscriptIdentityRef = useRef<string | null>(null)

  const bufferedTranscriptActionsRef = useRef<RuntimePaneMessageAction[]>([])

  const messageActionFrameRef = useRef<number | null>(null)

  const retryInFlightRef = useRef(false)

  const lastSubmittedRetryMessageRef = useRef<WorkbenchMessage | null>(null)

  const retrySourceBySubtaskIdRef = useRef(new Map<string, WorkbenchMessage>())

  const currentRuntimeTaskLoadTarget = useMemo(
    () => (currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null),
    [currentRuntimeTask]
  )

  const [retainedRuntimeTaskLoadTarget, setRetainedRuntimeTaskLoadTarget] =
    useState<RuntimeTaskLoadTarget | null>(() =>
      currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null
    )

  const runtimeTaskLoadTarget = retainedRuntimeTaskLoadTarget

  const runtimeTaskStreamTargetKey = runtimeTaskLoadTarget?.identityKey ?? null

  const updateAnsweredRequestUserInputIds = useCallback(
    (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
      // Route canonicalization may immediately unmount the current pane. Write the cache synchronously instead of relying on a deferred state updater.
      const next = update(answeredRequestUserInputIdsRef.current)
      answeredRequestUserInputIdsRef.current = next
      const address = runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
      if (address) cacheRuntimeAnsweredRequestUserInputIds(address, next)
      setAnsweredRequestUserInputIds(next)
    },
    []
  )

  const [messages, setMessages] = useState<WorkbenchMessage[]>(() =>
    currentRuntimeTask ? getRuntimeConversationMessages(currentRuntimeTask) : []
  )

  const accountScopeInvalidatedRef = useRef(false)

  const messagesRef = useRef<WorkbenchMessage[]>(messages)

  const applyMessageActions = useCallback((actions: RuntimePaneMessageAction[]) => {
    if (accountScopeInvalidatedRef.current || actions.length === 0) return
    setMessages(currentMessages => {
      let nextMessages = currentMessages
      for (const action of actions) {
        const actionForReduction = transformRuntimePaneActionForGuidanceSplits(
          action,
          guidanceSplitBoundariesRef.current
        )
        nextMessages = reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(
          nextMessages,
          actionForReduction
        )
      }
      const activeRuntimeTask =
        runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
      if (activeRuntimeTask) {
        debugRuntimePaneMessageFlow('message-action', {
          address: runtimeAddressDebug(activeRuntimeTask),
          actionType: actions.length === 1 ? actions[0].type : 'batched',
          actionCount: actions.length,
          previousCount: currentMessages.length,
          nextCount: nextMessages.length,
          nextMessages: summarizeWorkbenchMessages(nextMessages),
        })
      }
      return nextMessages
    })
  }, [])

  const flushPendingMessageActions = useCallback(() => {
    if (messageActionFrameRef.current !== null) {
      cancelAnimationFrame(messageActionFrameRef.current)
      messageActionFrameRef.current = null
    }
    const pendingActions = pendingMessageActionsRef.current
    if (pendingActions.length === 0) return
    pendingMessageActionsRef.current = []
    applyMessageActions(pendingActions)
  }, [applyMessageActions])

  const dispatchMessages = useCallback(
    (action: RuntimePaneMessageAction) => {
      if (!isBatchableRuntimePaneMessageAction(action)) {
        flushPendingMessageActions()
        applyMessageActions([action])
        return
      }

      pendingMessageActionsRef.current.push(action)
      if (messageActionFrameRef.current !== null) return
      messageActionFrameRef.current = requestAnimationFrame(() => {
        messageActionFrameRef.current = null
        const pendingActions = pendingMessageActionsRef.current
        if (pendingActions.length === 0) return
        pendingMessageActionsRef.current = []
        applyMessageActions(pendingActions)
      })
    },
    [applyMessageActions, flushPendingMessageActions]
  )

  useEffect(
    () =>
      listenAccountContextChanges(targetId => {
        const address = runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
        if (address?.deviceId !== targetId) return
        accountScopeInvalidatedRef.current = true
        runtimeTaskLoadTargetRef.current = null
        currentRuntimeTaskRef.current = null
        messagesRef.current = []
        pendingMessageActionsRef.current = []
        bufferedTranscriptActionsRef.current = []
        transcriptGapGenerationRef.current += 1
        if (messageActionFrameRef.current !== null)
          cancelAnimationFrame(messageActionFrameRef.current)
        messageActionFrameRef.current = null
        setRetainedRuntimeTaskLoadTarget(null)
        setMessages([])
      }),
    []
  )

  const appendGuidanceLocalUserMessage = useCallback(
    (content: string, attachments?: Attachment[], options?: CreateLocalUserMessageOptions) => {
      const guidanceMessage = createLocalUserMessage(content, attachments, options)
      setMessages(currentMessages => {
        const nextMessages = splitActiveAssistantForGuidance(
          currentMessages,
          guidanceMessage,
          guidanceSplitBoundariesRef.current
        )
        const activeRuntimeTask = currentRuntimeTaskRef.current
        if (activeRuntimeTask) {
          debugRuntimePaneMessageFlow('guidance-message-inserted', {
            address: runtimeAddressDebug(activeRuntimeTask),
            previousCount: currentMessages.length,
            nextCount: nextMessages.length,
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          })
        }
        return nextMessages
      })
    },
    []
  )

  const lifecycleAddress = runtimeTaskLoadTarget?.address ?? currentRuntimeTask

  const taskLifecycle = useRuntimeTaskLifecycle(lifecycleAddress)

  const taskGoalStatus = taskLifecycle?.goalStatus ?? null

  const paneStatus = useMemo(
    () =>
      deriveRuntimePaneStatus({
        messages,
        currentRuntimeTask,
        lifecycle: taskLifecycle,
      }),
    [currentRuntimeTask, messages, taskLifecycle]
  )

  const goal = useMemo(() => {
    let resolvedGoal: RuntimeGoal | null
    if (!currentRuntimeTaskLoadTarget) {
      if (pendingGoalState && isUnboundPendingGoalState(pendingGoalState)) {
        resolvedGoal = visibleRuntimeGoal(pendingGoalState.goal)
      } else {
        resolvedGoal = null
      }
    } else {
      const visibleThreadGoal = visibleRuntimeGoal(threadGoal)
      if (visibleThreadGoal) {
        resolvedGoal = visibleThreadGoal
      } else if (
        pendingGoalState &&
        isPendingGoalVisibleForRuntimeTarget(pendingGoalState, currentRuntimeTaskLoadTarget.address)
      ) {
        resolvedGoal = visibleRuntimeGoal(pendingGoalState.goal)
      } else {
        resolvedGoal = null
      }
    }

    return resolvedGoal
  }, [currentRuntimeTaskLoadTarget, pendingGoalState, threadGoal])
  return {
    currentRuntimeTask,
    projectChat,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    getRuntimeGoal,
    getRuntimeSessionModes,
    setRuntimeGoal,
    clearRuntimeGoal,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    steerRuntimePaneSubagent,
    readRuntimePaneSubagentArtifact,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    shortenCurrentWaitAction,
    sendCurrentInput,
    retryRuntimeFailedMessage,
    refreshWorkLists,
    lifecycleStore,
    queuedMessageScopeKey,
    queuedMessages,
    setQueuedMessagesState,
    queuedMessagesPaused,
    setQueuedMessagesPausedState,
    setQueuedMessages,
    setQueuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    setCodeCommentContexts,
    input,
    scopedSetInput,
    error,
    setError,
    setInput,
    answeredRequestUserInputIds,
    setAnsweredRequestUserInputIds,
    answeredRequestUserInputIdsRef,
    requestUserInputAliasTrackerRef,
    transcriptLoading,
    setTranscriptLoading,
    transcriptPageGateRef,
    transcriptHasMoreBefore,
    setTranscriptHasMoreBefore,
    transcriptBeforeCursor,
    setTranscriptBeforeCursor,
    transcriptLoadingMoreBefore,
    setTranscriptLoadingMoreBefore,
    transcriptLoadingFullContent,
    setTranscriptLoadingFullContent,
    transcriptFullContent,
    setTranscriptFullContent,
    loadedTranscriptRanges,
    setLoadedTranscriptRanges,
    turnNavigation,
    setTurnNavigation,
    subagentStatuses,
    setSubagentStatuses,
    threadGoal,
    setThreadGoal,
    goalContinuation,
    setGoalContinuation,
    taskPlan,
    setTaskPlan,
    pendingGoalState,
    setPendingGoalState,
    goalDraftActive,
    setGoalDraftActive,
    goalDraftMode,
    setGoalDraftMode,
    loadedRuntimeTranscriptKeyRef,
    receiptTranscriptRevision,
    setReceiptTranscriptRevision,
    loadRuntimeTranscriptForPaneRef,
    subscribeRuntimeTaskStreamRef,
    getRuntimeGoalRef,
    goalRevisionRef,
    commitThreadGoal,
    steerSubagent,
    readSubagentArtifact,
    refreshWorkListsRef,
    currentRuntimeTaskRef,
    runtimeTaskLoadTargetRef,
    displayedTranscriptIdentityRef,
    loadedTranscriptRangesRef,
    guidanceSplitBoundariesRef,
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    interruptAndSendInFlightRef,
    queuedMessageSendInFlightIdsRef,
    pendingMessageActionsRef,
    rebuildingTranscriptRef,
    transcriptGapGenerationRef,
    forceAuthoritativeTranscriptRef,
    rebuildingTranscriptIdentityRef,
    bufferedTranscriptActionsRef,
    messageActionFrameRef,
    retryInFlightRef,
    lastSubmittedRetryMessageRef,
    retrySourceBySubtaskIdRef,
    currentRuntimeTaskLoadTarget,
    retainedRuntimeTaskLoadTarget,
    setRetainedRuntimeTaskLoadTarget,
    runtimeTaskLoadTarget,
    runtimeTaskStreamTargetKey,
    updateAnsweredRequestUserInputIds,
    messages,
    setMessages,
    accountScopeInvalidatedRef,
    messagesRef,
    applyMessageActions,
    flushPendingMessageActions,
    dispatchMessages,
    appendGuidanceLocalUserMessage,
    lifecycleAddress,
    taskLifecycle,
    taskGoalStatus,
    paneStatus,
    goal,
  }
}
