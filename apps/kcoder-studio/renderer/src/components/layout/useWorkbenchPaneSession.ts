import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { isAbortError } from '@/lib/async-errors'
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import i18n from '@/i18n'
import { TranscriptPageGate } from './transcriptPageGate'
import { markRuntimeSubagentsSettled, mergeSubagentSteeringState } from './subagentSteerState'
import { subagentArtifactKindFromPath } from '@/lib/subagent-artifact'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  compareMessageStyles,
  summarizeRuntimePaneMemory,
  summarizeMessages,
  updateRuntimePaneDebugSnapshot,
} from '@/lib/debugPanel'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import {
  deriveRuntimePaneStatus,
  hasSettledAssistantMessage,
} from '@/features/workbench/runtimePaneStatus'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import { persistAttachmentReferences } from '@/lib/attachments'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  isRequestUserInputBlock,
  observeRequestUserInputAliases,
  requestUserInputPayloadKey,
  requestUserInputRelatedKeysForPayloads,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import { updateRuntimeGoalContinuation, visibleRuntimeGoal } from '@/lib/runtime-goal'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { appendConversationMentionContext } from '@/lib/conversation-mentions'
import { createRandomUuid } from '@/lib/random-id'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type {
  Attachment,
  ModelOptions,
  RequestUserInputResponse,
  RuntimeGoal,
  RuntimeExecutionModes,
  RuntimeGoalCreateInput,
  RuntimePlanEventPayload,
  RuntimeGoalContinuationPayload,
  RuntimeAdditionalContext,
  RuntimeRollbackRequest,
  RuntimeSubagentActivityPayload,
  RuntimeTaskAddress,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
} from '@/types/api'
import type {
  GuidanceWorkbenchMessage,
  RuntimePaneQueuedMessage,
  RuntimePaneTranscript,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import {
  cacheRuntimeAnsweredRequestUserInputIds,
  cacheRuntimeConversationMessages,
  cacheRuntimeConversationQueuedMessagesByKey,
  cacheRuntimeConversationQueuePausedByKey,
  getRuntimeAnsweredRequestUserInputIds,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuePausedByKey,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import { getCachedRuntimeTaskPlan } from '@/stream/responseApiStream'
import { getRuntimeMessageIndex, mergeRuntimeTranscriptMessages } from './runtimeTranscriptMessages'

interface WorkbenchPaneSessionOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
}

interface SendRequestUserInputResponseOptions {
  appendUserMessage?: boolean
  forceDefaultCollaborationMode?: boolean
}

interface RuntimePaneSendOptions extends RuntimeExecutionModes {
  onExecutionModeAccepted?: () => void
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
  additionalContext?: RuntimeAdditionalContext
  onRuntimeTaskCreated?: (address: RuntimeTaskAddress) => void
}

interface SendRuntimeMessageOptions {
  appendLocalMessage?: boolean
}

interface LoadedTranscriptRange {
  start: number
  end: number
}

interface RuntimeTaskLoadTarget {
  key: string
  identityKey: string
  address: RuntimeTaskAddress
}

interface PendingRuntimeGoalState {
  creationPending?: boolean
  goal: RuntimeGoal
  targetKey: string | null
  targetIdentityKey: string | null
}

interface GuidanceSplitBoundary {
  prefix: string
}

const runtimePaneGoalSeeds = new Map<string, PendingRuntimeGoalState>()
const RUNTIME_TRANSCRIPT_PAGE_SIZE = 50
const MAX_CACHED_RUNTIME_PANE_GOALS = 3
const noopSetInput = () => undefined

export function useWorkbenchPaneSession({ currentRuntimeTask }: WorkbenchPaneSessionOptions) {
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
  useEffect(() => listenAccountContextChanges(targetId => {
    const address = runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
    if (address?.deviceId !== targetId) return
    accountScopeInvalidatedRef.current = true
    runtimeTaskLoadTargetRef.current = null
    currentRuntimeTaskRef.current = null
    messagesRef.current = []
    pendingMessageActionsRef.current = []
    bufferedTranscriptActionsRef.current = []
    transcriptGapGenerationRef.current += 1
    if (messageActionFrameRef.current !== null) cancelAnimationFrame(messageActionFrameRef.current)
    messageActionFrameRef.current = null
    setRetainedRuntimeTaskLoadTarget(null)
    setMessages([])
  }), [])
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

  /* eslint-disable react-hooks/set-state-in-effect -- Runtime task changes reset pane transcript state before the async transcript load completes. */
  useEffect(() => {
    currentRuntimeTaskRef.current = currentRuntimeTask
  }, [currentRuntimeTask])

  useEffect(() => {
    if (currentRuntimeTaskLoadTarget) {
      setRetainedRuntimeTaskLoadTarget(current =>
        current?.key === currentRuntimeTaskLoadTarget.key ? current : currentRuntimeTaskLoadTarget
      )
    }
  }, [currentRuntimeTaskLoadTarget])

  useEffect(() => {
    const syncCachedPlan = () => {
      const cachedPlan = currentRuntimeTaskLoadTarget
        ? getCachedRuntimeTaskPlan(currentRuntimeTaskLoadTarget.address)
        : null
      if (import.meta.env.DEV) {
        console.warn('[KCoder Studio] Runtime task plan cache sync', {
          currentRuntimeTaskId: currentRuntimeTaskLoadTarget?.address ?? null,
          found: Boolean(cachedPlan),
          stepCount: cachedPlan?.plan.length ?? 0,
        })
      }
      setTaskPlan(cachedPlan?.plan.length ? cachedPlan : null)
    }

    syncCachedPlan()
    globalThis.addEventListener('wework-runtime-plan-updated', syncCachedPlan)
    return () => globalThis.removeEventListener('wework-runtime-plan-updated', syncCachedPlan)
  }, [currentRuntimeTaskLoadTarget])

  useEffect(() => {
    return () => {
      if (messageActionFrameRef.current !== null) {
        cancelAnimationFrame(messageActionFrameRef.current)
        messageActionFrameRef.current = null
      }
      pendingMessageActionsRef.current = []
    }
  }, [])

  useEffect(() => {
    runtimeTaskLoadTargetRef.current = runtimeTaskLoadTarget
  }, [runtimeTaskLoadTarget])

  useEffect(
    () => () => {
      const target = runtimeTaskLoadTargetRef.current
      const messages = messagesRef.current
      if (accountScopeInvalidatedRef.current || !target || messages.length === 0) return
      cacheRuntimeConversationMessages(target.address, messages)
    },
    []
  )

  useEffect(() => {
    messagesRef.current = messages
    const requestPayloads = messages.flatMap(message =>
      (message.blocks ?? []).filter(isRequestUserInputBlock).map(block => block.renderPayload)
    )
    observeRequestUserInputAliases(requestUserInputAliasTrackerRef.current, requestPayloads)
    const target = runtimeTaskLoadTargetRef.current
    if (!accountScopeInvalidatedRef.current && target && messages.length > 0) {
      cacheRuntimeConversationMessages(target.address, messages)
    }
  }, [messages])

  const requestUserInputAnswerScope = requestUserInputAnswerScopeKey(runtimeTaskLoadTarget)
  useEffect(() => {
    const target = runtimeTaskLoadTargetRef.current
    const cachedIds = target
      ? getRuntimeAnsweredRequestUserInputIds(target.address)
      : new Set<string>()
    answeredRequestUserInputIdsRef.current = cachedIds
    setAnsweredRequestUserInputIds(cachedIds)
    requestUserInputAliasTrackerRef.current = createRequestUserInputAliasTracker()
    lastSubmittedRetryMessageRef.current = null
    retrySourceBySubtaskIdRef.current.clear()
  }, [requestUserInputAnswerScope])

  useEffect(() => {
    loadedTranscriptRangesRef.current = loadedTranscriptRanges
  }, [loadedTranscriptRanges])

  useEffect(() => {
    loadRuntimeTranscriptForPaneRef.current = loadRuntimeTranscriptForPane
  }, [loadRuntimeTranscriptForPane])

  useEffect(() => {
    subscribeRuntimeTaskStreamRef.current = subscribeRuntimeTaskStream
  }, [subscribeRuntimeTaskStream])

  useEffect(() => {
    getRuntimeGoalRef.current = getRuntimeGoal
  }, [getRuntimeGoal])

  useEffect(() => {
    refreshWorkListsRef.current = refreshWorkLists
  }, [refreshWorkLists])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      commitThreadGoal(null)
      setGoalContinuation(null)
      return
    }

    const seededGoal = getRuntimePaneGoalSeed(runtimeTaskLoadTarget.address)
    if (seededGoal) {
      lifecycleStore.goalStatusReceived(runtimeTaskLoadTarget.address, seededGoal.goal.status)
      setPendingGoalState(current =>
        current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
          ? current
          : seededGoal
      )
    }

    let cancelled = false
    commitThreadGoal(null)
    setGoalContinuation(null)
    const requestedGoalRevision = goalRevisionRef.current
    void getRuntimeGoal(runtimeTaskLoadTarget.address)
      .then(response => {
        if (!cancelled && requestedGoalRevision === goalRevisionRef.current) {
          const loadedGoal = response.accepted ? response.goal : null
          commitThreadGoal(loadedGoal)
          lifecycleStore.goalStatusReceived(
            runtimeTaskLoadTarget.address,
            loadedGoal?.status ?? seededGoal?.goal.status ?? null
          )
          if (loadedGoal?.status === 'active') {
            void refreshWorkListsRef.current().catch(() => undefined)
          }
          // Keep a newly submitted goal visible until creation settles. Explicit
          // deletion and settled-turn refreshes clear the seed independently.
          if (loadedGoal) {
            clearRuntimePaneGoalSeed(runtimeTaskLoadTarget.address)
            setPendingGoalState(current =>
              current &&
              isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
                ? null
                : current
            )
          }
        }
      })
      .catch(error => {
        if (!cancelled && !isAbortError(error)) {
          commitThreadGoal(null)
          console.error('[KCoder Studio] Runtime goal load failed', {
            address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
            error,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [commitThreadGoal, getRuntimeGoal, lifecycleStore, runtimeTaskLoadTarget])

  useEffect(() => {
    const refreshAcceptedTurn = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; deviceId?: string }>).detail
      const target = runtimeTaskLoadTargetRef.current
      if (
        !target ||
        detail?.taskId !== target.address.taskId ||
        detail.deviceId !== target.address.deviceId
      )
        return
      loadedRuntimeTranscriptKeyRef.current = null
      setReceiptTranscriptRevision(revision => revision + 1)
    }
    window.addEventListener('kcoder:turn-receipt-reconciled', refreshAcceptedTurn)
    return () => window.removeEventListener('kcoder:turn-receipt-reconciled', refreshAcceptedTurn)
  }, [])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      setTranscriptLoading(false)
      setTranscriptLoadingMoreBefore(false)
      return
    }

    const { key: loadKey, address } = runtimeTaskLoadTarget
    if (loadedRuntimeTranscriptKeyRef.current === loadKey) {
      return
    }

    let cancelled = false
    const gapGeneration = transcriptGapGenerationRef.current
    const authoritativeReset = forceAuthoritativeTranscriptRef.current
    if (rebuildingTranscriptIdentityRef.current !== runtimeTaskLoadTarget.identityKey) {
      bufferedTranscriptActionsRef.current = []
    }
    const pageGate = transcriptPageGateRef.current
    pageGate.invalidate()
    rebuildingTranscriptRef.current = true
    rebuildingTranscriptIdentityRef.current = runtimeTaskLoadTarget.identityKey
    const cachedSeededMessages = getRuntimeConversationMessages(address)
    const seededMessages =
      displayedTranscriptIdentityRef.current === runtimeTaskLoadTarget.identityKey
        ? messagesRef.current.length > 0
          ? messagesRef.current
          : cachedSeededMessages
        : cachedSeededMessages
    displayedTranscriptIdentityRef.current = runtimeTaskLoadTarget.identityKey
    debugRuntimePaneMessageFlow('transcript-load-start', {
      address: runtimeAddressDebug(address),
      key: loadKey,
      seededCount: seededMessages.length,
      seededMessages: summarizeWorkbenchMessages(seededMessages),
    })
    dispatchMessages({ type: 'reset', messages: seededMessages })
    setTranscriptLoading(true)
    setTranscriptHasMoreBefore(false)
    setTranscriptBeforeCursor(null)
    setTranscriptLoadingMoreBefore(false)
    setTranscriptLoadingFullContent(false)
    setTranscriptFullContent(false)
    setLoadedTranscriptRanges([])
    setTurnNavigation([])
    setSubagentStatuses([])
    setTaskPlan(null)
    void Promise.resolve()
      .then(() =>
        loadRuntimeTranscriptForPaneRef.current(address, {
          limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
          ...(authoritativeReset ? { refresh: true } : {}),
        })
      )
      .then(transcript => {
        if (!cancelled && gapGeneration === transcriptGapGenerationRef.current) {
          const settlesActiveTurn = transcriptSettlesLatestSeededTurn(
            transcript.messages,
            seededMessages,
            transcript.running
          )
          const preserveActiveTurn =
            (lifecycleStore.getTask(address)?.derived.isRunning ?? false) && !settlesActiveTurn
          lifecycleStore.syncTranscript(address, transcript, {
            preserveActiveTurn,
            settlesActiveTurn,
          })
          const transcriptTaskRunning = lifecycleStore.getTask(address)?.derived.isRunning ?? false
          const nextMessages = authoritativeReset
            ? transcript.messages
            : reconcileRuntimeConversationMessages(
                transcript.messages,
                seededMessages,
                transcriptTaskRunning
              )
          forceAuthoritativeTranscriptRef.current = false
          loadedRuntimeTranscriptKeyRef.current = loadKey
          setTranscriptFullContent(transcript.fullContent === true)
          setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
          setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
          setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
          setTurnNavigation(transcript.turnNavigation ?? [])
          debugRuntimePaneMessageFlow('transcript-load-resolved', {
            address: runtimeAddressDebug(address),
            key: loadKey,
            transcriptCount: transcript.messages.length,
            seededCount: seededMessages.length,
            resetSource: transcript.messages.length > 0 ? 'transcript' : 'seed',
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          })
          dispatchMessages({
            type: 'reset',
            messages: nextMessages,
          })
          rebuildingTranscriptRef.current = false
          rebuildingTranscriptIdentityRef.current = null
          const bufferedActions = filterBufferedTranscriptActions(
            transcript.messages,
            bufferedTranscriptActionsRef.current
          )
          bufferedTranscriptActionsRef.current = []
          bufferedActions.forEach(dispatchMessages)
        }
      })
      .catch(error => {
        if (
          !cancelled &&
          gapGeneration === transcriptGapGenerationRef.current &&
          !isAbortError(error)
        ) {
          rebuildingTranscriptRef.current = false
          rebuildingTranscriptIdentityRef.current = null
          const bufferedActions = bufferedTranscriptActionsRef.current
          bufferedTranscriptActionsRef.current = []
          bufferedActions.forEach(dispatchMessages)
          loadedRuntimeTranscriptKeyRef.current = null
          setTranscriptFullContent(false)
          setTranscriptHasMoreBefore(false)
          setTranscriptBeforeCursor(null)
          setLoadedTranscriptRanges([])
          setTurnNavigation([])
          console.error('[KCoder Studio] Runtime pane transcript load failed', {
            key: loadKey,
            address,
            error,
          })
        }
      })
      .finally(() => {
        if (!cancelled && gapGeneration === transcriptGapGenerationRef.current) {
          setTranscriptLoading(false)
        }
      })

    return () => {
      cancelled = true
      pageGate.invalidate()
    }
  }, [dispatchMessages, lifecycleStore, runtimeTaskLoadTarget, receiptTranscriptRevision])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- Queued runtime messages are advanced when the active runtime response becomes idle. */
  useEffect(() => {
    const target = runtimeTaskLoadTargetRef.current
    if (!target) {
      return
    }

    const { address } = target
    let active = true
    const deactivate = () => {
      active = false
    }
    // A hard refresh or navigation does not guarantee React effect cleanup first.
    // pagehide fires before transport closure and invalidates unfinished goal requests.
    window.addEventListener('pagehide', deactivate)
    const unsubscribe = subscribeRuntimeTaskStreamRef.current(address, {
      onStreamGap: () => {
        if (runtimeTaskLoadTargetRef.current?.identityKey !== target.identityKey) return
        transcriptGapGenerationRef.current += 1
        forceAuthoritativeTranscriptRef.current = true
        // Discard the incomplete event suffix and start a new authoritative read.
        // New events arriving during that read use the existing replay/filter gate.
        rebuildingTranscriptRef.current = true
        rebuildingTranscriptIdentityRef.current = target.identityKey
        bufferedTranscriptActionsRef.current = []
        loadedRuntimeTranscriptKeyRef.current = null
        setReceiptTranscriptRevision(revision => revision + 1)
      },
      onMessageAction: action => {
        if (action.type === 'assistant_error' && action.subtaskId) {
          const retrySource = lastSubmittedRetryMessageRef.current
          if (retrySource) {
            retrySourceBySubtaskIdRef.current.set(action.subtaskId, retrySource)
          }
        }
        if (rebuildingTranscriptRef.current) {
          bufferedTranscriptActionsRef.current.push(action)
          if (bufferedTranscriptActionsRef.current.length > 512) {
            transcriptGapGenerationRef.current += 1
            forceAuthoritativeTranscriptRef.current = true
            bufferedTranscriptActionsRef.current = []
            loadedRuntimeTranscriptKeyRef.current = null
            setReceiptTranscriptRevision(revision => revision + 1)
          }
          return
        }
        dispatchMessages(action)
      },
      onAssistantStart: () => {
        setGoalContinuation(current =>
          updateRuntimeGoalContinuation(current, { type: 'assistant_started' })
        )
      },
      onAssistantSettled: () => {
        setSubagentStatuses(markRuntimeSubagentsSettled)
        const goalCreationPending = getRuntimePaneGoalSeed(address)?.creationPending === true
        const requestedGoalRevision = goalRevisionRef.current
        const requestedGoalTargetIdentity = target.identityKey
        const isCurrentGoalRefresh = () =>
          active &&
          runtimeTaskLoadTargetRef.current?.identityKey === requestedGoalTargetIdentity &&
          requestedGoalRevision === goalRevisionRef.current
        void getRuntimeGoalRef
          .current(address)
          .then(response => {
            if (!isCurrentGoalRefresh()) return
            const loadedGoal = response.accepted ? response.goal : null
            if (!loadedGoal && goalCreationPending) return
            commitThreadGoal(loadedGoal)
            const seededGoal = getRuntimePaneGoalSeed(address)
            lifecycleStore.goalStatusReceived(
              address,
              response.accepted ? (loadedGoal?.status ?? null) : (seededGoal?.goal.status ?? null)
            )
            if (loadedGoal?.status === 'active') {
              void refreshWorkListsRef.current().catch(() => undefined)
            }
            if (response.accepted) {
              clearRuntimePaneGoalSeed(address)
              const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
              setPendingGoalState(current =>
                current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress)
                  ? null
                  : current
              )
            }
          })
          .catch(error => {
            // Archiving, removing, or switching sessions releases the old task's gateway
            // client. The old turn no longer belongs to this pane, so a late goal-request
            // failure is expected cleanup and should not pollute the console.
            if (!isCurrentGoalRefresh()) return
            console.error('[KCoder Studio] Runtime goal refresh failed', {
              address: runtimeAddressDebug(address),
              error,
            })
          })
      },
      onRuntimeTransportReplaced: replacement => {
        const latestTarget = runtimeTaskLoadTargetRef.current
        if (
          !latestTarget ||
          latestTarget.identityKey !== target.identityKey ||
          rebuildingTranscriptRef.current ||
          !hasUnsettledRuntimePaneState(messagesRef.current)
        ) {
          return
        }

        const identityKey = target.identityKey
        const replacementGapGeneration = transcriptGapGenerationRef.current
        rebuildingTranscriptRef.current = true
        rebuildingTranscriptIdentityRef.current = identityKey
        bufferedTranscriptActionsRef.current = []
        console.warn('[KCoder Studio] Runtime transport replaced during an active response', {
          address: runtimeAddressDebug(address),
          previousRuntimeInstanceId: replacement.previousRuntimeInstanceId,
          runtimeInstanceId: replacement.runtimeInstanceId,
          currentMessageCount: messagesRef.current.length,
        })

        void loadRuntimeTranscriptForPaneRef
          .current(address, {
            limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
            refresh: true,
          })
          .then(transcript => {
            if (
              runtimeTaskLoadTargetRef.current?.identityKey !== identityKey ||
              replacementGapGeneration !== transcriptGapGenerationRef.current
            )
              return
            transcriptPageGateRef.current.invalidate()
            setTranscriptLoadingMoreBefore(false)
            setTranscriptLoadingFullContent(false)

            const nextMessages =
              transcript.messages.length > 0 ? transcript.messages : messagesRef.current
            loadedRuntimeTranscriptKeyRef.current = target.key
            setTranscriptFullContent(transcript.fullContent === true)
            setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
            setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
            setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
            setTurnNavigation(transcript.turnNavigation ?? [])
            dispatchMessages({ type: 'reset', messages: nextMessages })
            lifecycleStore.syncTranscript(address, transcript)
            const transcriptTaskRunning =
              lifecycleStore.getTask(address)?.derived.isRunning ?? false
            if (!transcriptTaskRunning) {
              if (hasUnsettledRuntimePaneState(nextMessages)) {
                dispatchMessages({ type: 'assistant_cancelled' })
              }
              setSubagentStatuses(markRuntimeSubagentsSettled)
            }
            console.info('[KCoder Studio] Runtime pane reconciled after transport replacement', {
              address: runtimeAddressDebug(address),
              running: transcriptTaskRunning,
              transcriptMessageCount: transcript.messages.length,
              restoredMessageCount: nextMessages.length,
            })
          })
          .catch(error => {
            if (
              runtimeTaskLoadTargetRef.current?.identityKey !== identityKey ||
              replacementGapGeneration !== transcriptGapGenerationRef.current
            )
              return
            console.error('[KCoder Studio] Runtime replacement transcript recovery failed', {
              address: runtimeAddressDebug(address),
              error,
            })
            if (hasUnsettledRuntimePaneState(messagesRef.current)) {
              dispatchMessages({ type: 'assistant_cancelled' })
            }
            setSubagentStatuses(markRuntimeSubagentsSettled)
            lifecycleStore.turnSettled(address)
          })
          .finally(() => {
            if (
              rebuildingTranscriptIdentityRef.current !== identityKey ||
              replacementGapGeneration !== transcriptGapGenerationRef.current
            )
              return
            rebuildingTranscriptRef.current = false
            rebuildingTranscriptIdentityRef.current = null
            const bufferedActions = bufferedTranscriptActionsRef.current
            bufferedTranscriptActionsRef.current = []
            bufferedActions.forEach(dispatchMessages)
          })
      },
      onRefreshWorkLists: () => {
        void refreshWorkListsRef.current().catch(() => undefined)
      },
      onSubagentActivity: activity => {
        setSubagentStatuses(current => updateRuntimeSubagentStatuses(current, activity))
      },
      onRuntimeGoalUpdated: payload => {
        const loadedGoal = payload.goal ?? null
        commitThreadGoal(loadedGoal)
        lifecycleStore.goalStatusReceived(address, loadedGoal?.status ?? null)
        void refreshWorkListsRef.current().catch(() => undefined)
        if (loadedGoal?.status !== 'active') {
          setGoalContinuation(current =>
            updateRuntimeGoalContinuation(current, { type: 'goal_inactive' })
          )
        }
        clearRuntimePaneGoalSeed(address)
        const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress) ? null : current
        )
      },
      onRuntimeGoalCleared: () => {
        commitThreadGoal(null)
        lifecycleStore.goalStatusReceived(address, null)
        void refreshWorkListsRef.current().catch(() => undefined)
        setGoalContinuation(null)
        clearRuntimePaneGoalSeed(address)
        const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress) ? null : current
        )
      },
      onRuntimeGoalContinuation: payload => {
        if (payload.reason) setError(payload.reason)
        else if (payload.status === 'started') setError(null)
        setGoalContinuation(current =>
          updateRuntimeGoalContinuation(current, { type: 'turn_lifecycle', payload })
        )
        void refreshWorkListsRef.current().catch(() => undefined)
      },
      onRuntimePlanUpdated: payload => {
        if (import.meta.env.DEV) {
          console.info('[KCoder Studio] Runtime task plan state updated', {
            taskId: payload.taskId ?? null,
            threadId: payload.threadId ?? null,
            stepCount: payload.plan.length,
          })
        }
        setTaskPlan(payload.plan.length > 0 ? payload : null)
      },
      onGuidanceApplied: payload => {
        const pendingEntry = [...pendingAppliedGuidancesRef.current.entries()].find(
          ([, message]) => !payload.message || message.content === payload.message
        )
        if (!pendingEntry) return
        const [guidanceId, guidanceMessage] = pendingEntry
        pendingAppliedGuidancesRef.current.delete(guidanceId)
        if (interruptedGuidanceIdsRef.current.delete(guidanceId)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== guidanceId))
          return
        }
        appendGuidanceLocalUserMessage(guidanceMessage.content, guidanceMessage.attachments, {
          id: guidanceMessage.id,
          createdAt: new Date(payload.appliedAtMs).toISOString(),
          runtimeGoalRequest: guidanceMessage.runtimeGoalRequest,
          runtimeGuidance: true,
        })
        setQueuedMessages(messages => messages.filter(message => message.id !== guidanceId))
      },
    })
    return () => {
      // On page unload or pane-subscription rebuild, invalidate unfinished asynchronous callbacks before disconnecting the underlying transport.
      deactivate()
      window.removeEventListener('pagehide', deactivate)
      unsubscribe()
    }
  }, [
    appendGuidanceLocalUserMessage,
    commitThreadGoal,
    dispatchMessages,
    lifecycleStore,
    runtimeTaskStreamTargetKey,
    setQueuedMessages,
  ])

  const loadMoreTranscriptBefore = useCallback(async () => {
    if (
      !runtimeTaskLoadTarget ||
      !transcriptBeforeCursor ||
      transcriptLoadingMoreBefore ||
      transcriptFullContent
    )
      return

    const { key: loadKey, address } = runtimeTaskLoadTarget
    const beforeCursor = transcriptBeforeCursor
    const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
    setTranscriptLoadingMoreBefore(true)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
        beforeCursor,
      })
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          transcript.historyReset === true
        )
      )
        return
      if (transcript.historyReset) {
        setTranscriptLoadingMoreBefore(false)
        setTranscriptLoadingFullContent(false)
      }
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        transcript.historyReset
      )
      const nextRanges = transcript.historyReset
        ? transcriptRangeFromPage(transcript)
        : mergeTranscriptRanges(
            loadedTranscriptRangesRef.current,
            transcriptRangeFromPage(transcript)
          )
      setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
      setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
      setLoadedTranscriptRanges(nextRanges)
      if (transcript.historyReset) setTranscriptFullContent(transcript.fullContent === true)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : transcript.historyReset
            ? []
            : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    } catch (error) {
      console.error('[KCoder Studio] Runtime pane older transcript load failed', {
        key: loadKey,
        address,
        beforeCursor,
        error,
      })
    } finally {
      if (
        transcriptPageGateRef.current.current(ticket, runtimeTaskLoadTargetRef.current?.identityKey)
      )
        setTranscriptLoadingMoreBefore(false)
    }
  }, [
    dispatchMessages,
    runtimeTaskLoadTarget,
    transcriptBeforeCursor,
    transcriptFullContent,
    transcriptLoadingMoreBefore,
  ])

  const loadTranscriptTurnNavigationItem = useCallback(
    async (item: RuntimeTurnNavigationItem) => {
      if (!runtimeTaskLoadTarget || !item.cursor) {
        return
      }
      if (transcriptFullContent) {
        return
      }
      if (messagesRef.current.some(message => message.id === item.id)) {
        return
      }

      const { address } = runtimeTaskLoadTarget
      const loadOptions = runtimeTurnNavigationLoadOptions(item, loadedTranscriptRangesRef.current)
      const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          transcript.historyReset === true
        )
      )
        return
      if (transcript.historyReset) {
        setTranscriptLoadingMoreBefore(false)
        setTranscriptLoadingFullContent(false)
      }
      const nextHasMoreBefore =
        loadOptions.beforeCursor === undefined && !transcript.historyReset
          ? transcriptHasMoreBefore
          : Boolean(transcript.hasMoreBefore)
      const nextBeforeCursor =
        loadOptions.beforeCursor === undefined && !transcript.historyReset
          ? transcriptBeforeCursor
          : (transcript.beforeCursor ?? null)
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        transcript.historyReset
      )
      const nextRanges = transcript.historyReset
        ? transcriptRangeFromPage(transcript)
        : mergeTranscriptRanges(
            loadedTranscriptRangesRef.current,
            transcriptRangeFromPage(transcript)
          )
      setTranscriptHasMoreBefore(nextHasMoreBefore)
      setTranscriptBeforeCursor(nextBeforeCursor)
      setLoadedTranscriptRanges(nextRanges)
      if (transcript.historyReset) setTranscriptFullContent(transcript.fullContent === true)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : transcript.historyReset
            ? []
            : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    },
    [
      dispatchMessages,
      runtimeTaskLoadTarget,
      transcriptBeforeCursor,
      transcriptFullContent,
      transcriptHasMoreBefore,
    ]
  )

  const loadTranscriptGap = useCallback(
    async (gap: LoadedTranscriptRange) => {
      if (!runtimeTaskLoadTarget || transcriptFullContent || gap.end <= gap.start) return

      const { address } = runtimeTaskLoadTarget
      const limit = Math.min(RUNTIME_TRANSCRIPT_PAGE_SIZE, gap.end - gap.start)
      const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
      const loadOptions = {
        limit,
        afterCursor: `offset:${gap.start}`,
      }
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          transcript.historyReset === true
        )
      )
        return
      if (transcript.historyReset) {
        setTranscriptLoadingMoreBefore(false)
        setTranscriptLoadingFullContent(false)
        setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
        setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
        setTranscriptFullContent(transcript.fullContent === true)
      }
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        transcript.historyReset
      )
      const nextRanges = transcript.historyReset
        ? transcriptRangeFromPage(transcript)
        : mergeTranscriptRanges(
            loadedTranscriptRangesRef.current,
            transcriptRangeFromPage(transcript)
          )
      setLoadedTranscriptRanges(nextRanges)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : transcript.historyReset
            ? []
            : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    },
    [dispatchMessages, runtimeTaskLoadTarget, transcriptFullContent]
  )

  const loadFullTranscript = useCallback(async () => {
    if (!runtimeTaskLoadTarget || transcriptLoadingFullContent || transcriptFullContent) return

    const { address } = runtimeTaskLoadTarget
    const ticket = transcriptPageGateRef.current.begin(runtimeTaskLoadTarget.identityKey)
    setTranscriptLoadingFullContent(true)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        includeFullContent: true,
        refresh: true,
      })
      if (
        !transcriptPageGateRef.current.accept(
          ticket,
          runtimeTaskLoadTargetRef.current?.identityKey,
          true
        )
      )
        return
      setTranscriptLoadingMoreBefore(false)
      setTranscriptLoadingFullContent(false)
      const nextMessages = mergeRuntimeTranscriptMessages(
        transcript.messages,
        messagesRef.current,
        true
      )
      setTranscriptFullContent(transcript.fullContent === true)
      setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
      setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
      setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
      setTurnNavigation(() =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : []
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    } catch (error) {
      console.error('[KCoder Studio] Runtime pane full transcript load failed', {
        address,
        error,
      })
      throw error
    } finally {
      if (
        transcriptPageGateRef.current.current(ticket, runtimeTaskLoadTargetRef.current?.identityKey)
      )
        setTranscriptLoadingFullContent(false)
    }
  }, [dispatchMessages, runtimeTaskLoadTarget, transcriptFullContent, transcriptLoadingFullContent])

  const canSendWithSelectedModel = useCallback(() => {
    if (!projectChat.isSelectedModelUnavailable?.()) return true
    setError(i18n.t('workbench.model_disabled_unavailable'))
    return false
  }, [projectChat, setError])

  const getRuntimeModelFields = useCallback(
    (modelOptionsOverride?: ModelOptions) => {
      const selectedModel =
        projectChat.getSelectedModel?.() ??
        projectChat.selectedModel ??
        resolveAutomaticModel(projectChat.models)
      const selectedModelOptions =
        projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
      return selectedModelExecutionFields(
        selectedModel,
        {
          ...selectedModelOptions,
          ...modelOptionsOverride,
        },
        projectChat.getModelSelectionMode?.()
      )
    },
    [projectChat]
  )

  const appendLocalUserMessage = useCallback(
    (content: string, attachments?: Attachment[], options?: CreateLocalUserMessageOptions) => {
      dispatchMessages({
        type: 'user_added',
        message: createLocalUserMessage(content, attachments, options),
      })
    },
    [dispatchMessages]
  )

  const applyLocalRequestUserInputResponse = useCallback(
    (response: RequestUserInputResponse) => {
      setMessages(currentMessages => {
        const nextMessages = applyRequestUserInputResponseToMessages(currentMessages, response)
        if (currentRuntimeTask) {
          debugRuntimePaneMessageFlow('request-user-input-response-applied', {
            address: runtimeAddressDebug(currentRuntimeTask),
            requestUserInputKey: requestUserInputResponseKey(response),
            previousCount: currentMessages.length,
            nextCount: nextMessages.length,
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          })
        }
        return nextMessages
      })
    },
    [currentRuntimeTask]
  )

  const sendRuntimeMessage = useCallback(
    async (
      message: RuntimePaneQueuedMessage,
      options: SendRuntimeMessageOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      if (!canSendWithSelectedModel()) return false
      lastSubmittedRetryMessageRef.current = createLocalUserMessage(
        message.content,
        message.attachments,
        {
          id: message.id,
          createdAt: message.createdAt,
          runtimeGoalRequest: message.runtimeGoalRequest,
          codeComments: message.codeComments,
        }
      )
      if (options.appendLocalMessage !== false) {
        appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
          id: message.id,
          createdAt: message.createdAt,
          runtimeGoalRequest: message.runtimeGoalRequest,
          codeComments: message.codeComments,
        })
      }
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const terminalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const additionalContext = { ...message.additionalContext, ...terminalContext }
      const sent = await sendRuntimePaneMessage({
        ...(message.turnMode ? { turnMode: message.turnMode } : {}),
        address: currentRuntimeTask,
        message: message.content,
        clientMessageId: message.id,
        ...(message.modelId
          ? {
              modelId: message.modelId,
              modelType: message.modelType,
            }
          : {}),
        ...(message.modelSelectionMode ? { modelSelectionMode: message.modelSelectionMode } : {}),
        ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
      })
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(terminalContext)
      }
      return sent
    },
    [appendLocalUserMessage, canSendWithSelectedModel, currentRuntimeTask, sendRuntimePaneMessage]
  )

  const interruptAndSendQueuedMessage = useCallback(
    async (message: RuntimePaneQueuedMessage): Promise<boolean> => {
      if (!currentRuntimeTask) return false
      if (interruptAndSendInFlightRef.current) return false
      interruptAndSendInFlightRef.current = true
      const interruptedGuidanceIds = new Set<string>()
      pendingAppliedGuidancesRef.current.forEach((_, id) => {
        interruptedGuidanceIdsRef.current.add(id)
        interruptedGuidanceIds.add(id)
      })
      setQueuedMessages(messages => [
        ...messages.filter(item => item.id !== message.id),
        { ...message, status: 'sending', notice: '正在打断并发送' },
      ])
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const terminalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const additionalContext = { ...message.additionalContext, ...terminalContext }
      appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
        id: message.id,
        createdAt: message.createdAt,
        runtimeGoalRequest: message.runtimeGoalRequest,
        codeComments: message.codeComments,
      })
      const sent = await interruptAndSendRuntimePaneMessage(
        {
          ...(message.turnMode ? { turnMode: message.turnMode } : {}),
          address: currentRuntimeTask,
          message: message.content,
          clientMessageId: message.id,
          ...(message.modelId ? { modelId: message.modelId, modelType: message.modelType } : {}),
          ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
        },
        { onError: setError }
      )
      interruptAndSendInFlightRef.current = false
      if (!sent) {
        interruptedGuidanceIds.forEach(id => {
          if (id !== message.id) interruptedGuidanceIdsRef.current.delete(id)
        })
        setQueuedMessages(messages =>
          messages
            .filter(item => item.id !== message.id)
            .map(item =>
              interruptedGuidanceIds.has(item.id) &&
              !pendingAppliedGuidancesRef.current.has(item.id)
                ? { ...item, status: 'queued', notice: undefined }
                : item
            )
        )
        setMessages(messages => messages.filter(item => item.id !== message.id))
        return false
      }

      markRuntimeTerminalAdditionalContextDelivered(terminalContext)
      setQueuedMessages(messages =>
        messages.filter(item => item.id !== message.id && !interruptedGuidanceIds.has(item.id))
      )
      return true
    },
    [
      appendLocalUserMessage,
      currentRuntimeTask,
      interruptAndSendRuntimePaneMessage,
      setQueuedMessages,
    ]
  )

  const retryFailedMessageInPane = useCallback(
    async (message: WorkbenchMessage, retryModelConfiguration: 'snapshot' | 'current' = 'snapshot'): Promise<boolean> => {
      if (!canSendWithSelectedModel()) return false
      if (retryInFlightRef.current) return false

      retryInFlightRef.current = true
      setError(null)
      try {
        const currentMessages = messagesRef.current
        const failedMessageIndex = currentMessages.findIndex(
          currentMessage => currentMessage.id === message.id
        )
        const associatedRetrySource = message.subtaskId
          ? retrySourceBySubtaskIdRef.current.get(message.subtaskId)
          : undefined
        const retrySource = associatedRetrySource ?? lastSubmittedRetryMessageRef.current
        const failedCreatedAt = Date.parse(message.createdAt)
        const retrySourceCreatedAt = retrySource ? Date.parse(retrySource.createdAt) : Number.NaN
        const retrySourcePredatesFailure =
          Number.isNaN(failedCreatedAt) ||
          Number.isNaN(retrySourceCreatedAt) ||
          retrySourceCreatedAt <= failedCreatedAt
        const retryUserMessageOverride =
          associatedRetrySource ??
          (failedMessageIndex >= 0 && retrySourcePredatesFailure ? retrySource : null)
        debugRuntimePaneMessageFlow('retry-failed-message', {
          address: currentRuntimeTask ? runtimeAddressDebug(currentRuntimeTask) : null,
          failedMessageId: message.id,
          failedMessageIndex,
          retrySource: textMetrics(retrySource?.content),
          associatedRetrySource: Boolean(associatedRetrySource),
          retrySourcePredatesFailure,
          usingRetrySourceOverride: Boolean(retryUserMessageOverride),
        })
        const sent = await retryRuntimeFailedMessage(
          message.id,
          currentMessages,
          retryUserMessageOverride ?? undefined,
          retryModelConfiguration,
          { onError: setError }
        )
        if (sent) {
          // Retain the original failure and partial output. Accepting a continuation
          // does not mean the user cancelled the failed attempt.
          const continued = /^(turn-\d+)(?:-retry-[0-9a-f-]+)?$/.test(
            message.turnId ?? message.subtaskId ?? ''
          )
          setMessages(messages =>
            continued
              ? messages.map(currentMessage =>
                  currentMessage.id === message.id
                    ? {
                        ...currentMessage,
                        continuationAccepted: true,
                        stoppedNotice: false,
                      }
                    : currentMessage
                )
              : messages.filter(currentMessage => currentMessage.id !== message.id)
          )
        }
        return sent
      } catch (error) {
        console.error('[KCoder Studio] Runtime failed message retry failed', {
          address: currentRuntimeTask ? runtimeAddressDebug(currentRuntimeTask) : null,
          messageId: message.id,
          error,
        })
        setError(error instanceof Error ? error.message : '重试失败')
        return false
      } finally {
        retryInFlightRef.current = false
      }
    },
    [canSendWithSelectedModel, currentRuntimeTask, retryRuntimeFailedMessage]
  )

  const sendRequestUserInputResponse = useCallback(
    async (
      response: RequestUserInputResponse,
      options: SendRequestUserInputResponseOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      const message = requestUserInputResponseText(response)
      const requestUserInputKeys = requestUserInputRelatedKeysForPayloads(
        requestUserInputAliasTrackerRef.current.previousPayloads,
        response,
        requestUserInputAliasTrackerRef.current.aliasesByKey
      )
      const runtimeModelOverride = options.forceDefaultCollaborationMode
        ? { collaborationMode: 'default' }
        : undefined
      if (options.forceDefaultCollaborationMode) {
        projectChat.setSelectedModelOption('collaborationMode', 'default')
      }
      const appendedUserMessage = options.appendUserMessage ? createLocalUserMessage(message) : null
      if (appendedUserMessage) {
        dispatchMessages({ type: 'user_added', message: appendedUserMessage })
      }
      if (requestUserInputKeys.length > 0) {
        updateAnsweredRequestUserInputIds(current => {
          if (requestUserInputKeys.every(key => current.has(key))) return current
          const next = new Set(current)
          for (const key of requestUserInputKeys) next.add(key)
          return next
        })
      }
      applyLocalRequestUserInputResponse(response)
      const runtimeModelFields = options.appendUserMessage
        ? getRuntimeModelFields(runtimeModelOverride)
        : {}
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const sent = await sendRuntimePaneMessage({
        address: currentRuntimeTask,
        message,
        ...(appendedUserMessage ? { clientMessageId: appendedUserMessage.id } : {}),
        ...runtimeModelFields,
        ...(options.appendUserMessage ? {} : { requestUserInputResponse: response }),
        ...(additionalContext ? { additionalContext } : {}),
      })
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(additionalContext)
      } else {
        if (requestUserInputKeys.length > 0) {
          updateAnsweredRequestUserInputIds(current => {
            if (requestUserInputKeys.every(key => !current.has(key))) return current
            const next = new Set(current)
            for (const key of requestUserInputKeys) next.delete(key)
            return next
          })
        }
      }
      return sent
    },
    [
      applyLocalRequestUserInputResponse,
      currentRuntimeTask,
      dispatchMessages,
      getRuntimeModelFields,
      projectChat,
      sendRuntimePaneMessage,
      updateAnsweredRequestUserInputIds,
    ]
  )

  const editLastUserMessageInPane = useCallback(
    async (message: WorkbenchMessage, content: string): Promise<boolean> => {
      const submittedContent = content.trim()
      if (!submittedContent) return false
      if (!currentRuntimeTask) return false
      if (paneStatus.isBusy) {
        setError('当前回复仍在进行中，完成后再编辑')
        return false
      }

      const currentMessages = messagesRef.current
      const messageIndex = currentMessages.findIndex(item => item.id === message.id)
      if (!isEditableLastUserMessage(currentMessages, messageIndex)) {
        setError('只能编辑最后一轮已完成的问题')
        return false
      }

      const previousMessages = currentMessages
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const editedMessage = createLocalUserMessage(submittedContent, messageAttachments, {
        runtimeGoalRequest: message.runtimeGoalRequest === true,
      })
      const nextMessages = [...currentMessages.slice(0, messageIndex), editedMessage]
      const request: RuntimeRollbackRequest = {
        address: currentRuntimeTask,
        message: submittedContent,
        messageId: message.id,
        ...getRuntimeModelFields(),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      }

      dispatchMessages({ type: 'reset', messages: nextMessages })
      try {
        const sent = await editLastUserMessage(request)
        if (sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          return true
        }
        dispatchMessages({ type: 'reset', messages: previousMessages })
        return false
      } catch (error) {
        dispatchMessages({ type: 'reset', messages: previousMessages })
        console.error('[KCoder Studio] Runtime last user message edit failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          messageId: message.id,
          error,
        })
        setError('编辑失败')
        return false
      }
    },
    [
      currentRuntimeTask,
      dispatchMessages,
      editLastUserMessage,
      getRuntimeModelFields,
      paneStatus.isBusy,
    ]
  )

  const ignoreRequestUserInput = useCallback(
    async (payload: RequestUserInputPayload) => {
      const cancellationTargets = messagesRef.current.filter(message =>
        message.role === 'assistant' && message.status === 'streaming')
      const requestUserInputKey = requestUserInputPayloadKey(payload)
      if (requestUserInputKey) {
        updateAnsweredRequestUserInputIds(current => {
          if (current.has(requestUserInputKey)) return current
          const next = new Set(current)
          next.add(requestUserInputKey)
          return next
        })
      }

      if (!currentRuntimeTask) {
        return
      }

      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      if (!cancelled) {
        if (requestUserInputKey) {
          updateAnsweredRequestUserInputIds(current => {
            if (!current.has(requestUserInputKey)) return current
            const next = new Set(current)
            next.delete(requestUserInputKey)
            return next
          })
        }
        return
      }

      for (const message of cancellationTargets) dispatchMessages({
        type: 'assistant_cancelled',
        messageId: message.id,
        subtaskId: message.attemptId ?? message.subtaskId ?? message.turnId,
      })
    },
    [
      cancelRuntimePaneTask,
      currentRuntimeTask,
      dispatchMessages,
      updateAnsweredRequestUserInputIds,
    ]
  )

  const sendQueuedMessage = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      if (queuedMessageSendInFlightIdsRef.current.has(queuedMessage.id)) return
      queuedMessageSendInFlightIdsRef.current.add(queuedMessage.id)
      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === queuedMessage.id ? { ...message, status: 'sending' } : message
        )
      )

      try {
        const sent = await sendRuntimeMessage(queuedMessage)
        setQueuedMessages(messages =>
          sent
            ? messages.filter(message => message.id !== queuedMessage.id)
            : messages.map(message =>
                message.id === queuedMessage.id
                  ? { ...message, status: 'failed', error: '发送失败' }
                  : message
              )
        )
      } catch (error) {
        console.error('[KCoder Studio] Queued runtime message send failed', {
          id: queuedMessage.id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === queuedMessage.id
              ? { ...message, status: 'failed', error: '发送失败' }
              : message
          )
        )
      } finally {
        queuedMessageSendInFlightIdsRef.current.delete(queuedMessage.id)
      }
    },
    [sendRuntimeMessage, setQueuedMessages]
  )

  useEffect(() => {
    if (queuedMessagesPaused) return
    if (!paneStatus.canSendQueuedMessage) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return

    // This advances the next queued message once the pane becomes idle.
    void sendQueuedMessage(queuedMessage)
  }, [paneStatus.canSendQueuedMessage, queuedMessages, queuedMessagesPaused, sendQueuedMessage])

  const loadFullTranscriptForExport = useCallback(async () => {
    if (!runtimeTaskLoadTarget) return messagesRef.current

    const transcript = await loadRuntimeTranscriptForPaneRef.current(
      runtimeTaskLoadTarget.address,
      {
        includeFullContent: true,
        refresh: true,
      }
    )
    if (transcript.fullContent !== true) {
      throw new Error('The complete task transcript is unavailable')
    }
    return transcript.messages.length > 0 ? transcript.messages : messagesRef.current
  }, [runtimeTaskLoadTarget])
  /* eslint-enable react-hooks/set-state-in-effect */

  const sendQueuedMessageAsGuidance = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      if (queuedMessage.turnMode && queuedMessage.turnMode !== 'standard' && paneStatus.isBusy) {
        setError(i18n.t('workbench.execution_mode_queue_only'))
        return
      }
      const id = queuedMessage.id
      if (!currentRuntimeTask) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', error: '当前回复缺少引导上下文' }
              : message
          )
        )
        return
      }

      if (queuedMessage.status === 'sending') return

      setError(null)
      if (!paneStatus.isBusy) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'sending', error: undefined, notice: undefined }
              : message
          )
        )
        try {
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages.filter(message => message.id !== id)
              : messages.map(message =>
                  message.id === id
                    ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                    : message
                )
          )
        } catch (error) {
          console.error('[KCoder Studio] Queued runtime message send failed', {
            id,
            error,
          })
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                : message
            )
          )
        }
        return
      }

      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === id
            ? {
                ...message,
                status: 'sending',
                error: undefined,
                notice: '正在引导当前对话',
              }
            : message
        )
      )

      pendingAppliedGuidancesRef.current.set(id, queuedMessage)

      try {
        const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
        const messageAttachments = queuedMessage.attachments ?? []
        const attachmentIds = remoteAttachmentIds(messageAttachments)
        const attachments = localRuntimeAttachments(messageAttachments)
        const result = await sendRuntimePaneGuidance({
          address: currentRuntimeTask,
          message: queuedMessage.content,
          clientGuidanceId: id,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(additionalContext ? { additionalContext } : {}),
        })
        if (!result.sent && result.code === 'no_active_turn') {
          pendingAppliedGuidancesRef.current.delete(id)
          if (interruptedGuidanceIdsRef.current.delete(id)) return
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages.filter(message => message.id !== id)
              : messages.map(message =>
                  message.id === id
                    ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                    : message
                )
          )
          return
        }
        if (result.sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
        }
        if (!result.sent) {
          pendingAppliedGuidancesRef.current.delete(id)
          if (interruptedGuidanceIdsRef.current.delete(id)) {
            setQueuedMessages(messages => messages.filter(message => message.id !== id))
            return
          }
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
                : message
            )
          )
        }
      } catch (error) {
        pendingAppliedGuidancesRef.current.delete(id)
        if (interruptedGuidanceIdsRef.current.delete(id)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== id))
          return
        }
        console.error('[KCoder Studio] Queued guidance send failed', {
          id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
              : message
          )
        )
      }
    },
    [
      currentRuntimeTask,
      paneStatus.isBusy,
      sendRuntimeMessage,
      sendRuntimePaneGuidance,
      setQueuedMessages,
    ]
  )

  const send: (inputOverride?: string, options?: RuntimePaneSendOptions) => Promise<void> =
    useCallback(
      async (inputOverride, options = {}) => {
        if (!canSendWithSelectedModel()) return
        const submittedInput = (inputOverride ?? input).trim()
        const currentAttachments = projectChat.attachments
        const hasCodeComments = codeCommentContexts.length > 0
        debugComposerEvent('pane-send-called', {
          hasSubmittedValue: inputOverride !== undefined,
          submittedValue: textMetrics(inputOverride),
          stateInput: textMetrics(input),
          submittedInput: textMetrics(submittedInput),
          attachmentsCount: currentAttachments.length,
          codeCommentsCount: codeCommentContexts.length,
          hasCodeComments,
          goalDraftActive,
          guideWhenBusy: options.guideWhenBusy === true,
          interruptWhenBusy: options.interruptWhenBusy === true,
          hasCurrentRuntimeTask: Boolean(currentRuntimeTask),
          paneBusy: paneStatus.isBusy,
        })

        if (goalDraftActive) {
          if (!submittedInput) {
            setError(i18n.t('workbench.goal_objective_required'))
            return
          }
          if (hasCodeComments) {
            setError(i18n.t('workbench.runtime_task_code_comments_not_supported'))
            return
          }

          // Errors belong to the previous action; a new goal submission starts fresh.
          setError(null)
          setInput('')
          if (currentRuntimeTask) {
            const response = await setRuntimeGoal({
              address: currentRuntimeTask,
              objective: submittedInput,
              mode: goalDraftMode,
              status: 'active',
            })
            if (!response.accepted) {
              setInput(submittedInput)
              setError(response.error || i18n.t('workbench.goal_set_failed'))
              return
            }
            commitThreadGoal(response.goal)
            lifecycleStore.goalStatusReceived(currentRuntimeTask, response.goal.status)
            setGoalDraftActive(false)
            const queuedMessage: RuntimePaneQueuedMessage = {
              turnMode: options.turnMode,
              id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
              content: submittedInput,
              status: 'queued',
              createdAt: new Date().toISOString(),
              attachments: persistAttachmentReferences(currentAttachments),
              runtimeGoalRequest: true,
              additionalContext: options.additionalContext,
              ...getRuntimeModelFields(),
            }

            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            if (paneStatus.isBusy) {
              setQueuedMessages(messages => [...messages, queuedMessage])
              options.onExecutionModeAccepted?.()
              if (options.guideWhenBusy) {
                await sendQueuedMessageAsGuidance(queuedMessage)
              }
              return
            }

            const sent = await sendRuntimeMessage(queuedMessage)
            if (sent) {
              options.onExecutionModeAccepted?.()
              setCodeCommentContexts([])
            } else {
              setError('目标已更新，但指令发送失败')
              setInput(submittedInput)
            }
            return
          }

          const draftGoal = createPendingRuntimeGoal(submittedInput, goalDraftMode)
          const initialGoal = runtimeGoalCreateInput(draftGoal)
          setPendingGoalState({ goal: draftGoal, targetKey: null, targetIdentityKey: null })
          setGoalDraftActive(false)
          const optimisticMessage = createLocalUserMessage(submittedInput, currentAttachments, {
            runtimeGoalRequest: true,
          })
          let seededGoalAddress: RuntimeTaskAddress | null = null
          const sent = await sendCurrentInput(submittedInput, {
            sessionMode: options.sessionMode,
            workflowDefinitionId: options.workflowDefinitionId,
            turnMode: options.turnMode,
            clientMessageId: optimisticMessage.id,
            initialGoal,
            additionalContext: options.additionalContext,
            onRuntimeTaskOptimisticOpen: (address, context) => {
              options.onRuntimeTaskCreated?.(address)
              setPendingGoalState(current =>
                current
                  ? {
                      ...current,
                      targetKey: runtimeTranscriptPaneKey(address),
                      targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                    }
                  : current
              )
              seedRuntimePaneGoal(address, draftGoal)
              seededGoalAddress = address
              const seededMessages = [optimisticMessage]
              debugRuntimePaneMessageFlow('seed-goal-first-open', {
                address: runtimeAddressDebug(address),
                previousAddress: context?.previousAddress
                  ? runtimeAddressDebug(context.previousAddress)
                  : null,
                previousCount: 0,
                seededCount: seededMessages.length,
                seededMessages: summarizeWorkbenchMessages(seededMessages),
              })
              cacheRuntimeConversationMessages(address, seededMessages)
            },
          })
          if (sent) {
            if (isRuntimeTaskAddress(sent)) confirmRuntimePaneGoalSeed(sent)
            options.onExecutionModeAccepted?.()
            if (!isRuntimeTaskAddress(sent)) {
              appendLocalUserMessage(submittedInput, currentAttachments, {
                runtimeGoalRequest: true,
              })
            } else {
              setPendingGoalState(current =>
                current
                  ? {
                      ...current,
                      targetKey: runtimeTranscriptPaneKey(sent),
                      targetIdentityKey: runtimeTranscriptPaneIdentityKey(sent),
                    }
                  : current
              )
            }
          } else {
            if (seededGoalAddress) {
              clearRuntimePaneGoalSeed(seededGoalAddress)
            }
            setGoalDraftActive(true)
            setPendingGoalState(null)
          }
          return
        }

        if (submittedInput === '/compact') {
          if (!currentRuntimeTask) {
            setError('当前对话还没有可压缩的运行时线程')
            return
          }
          if (paneStatus.isBusy) {
            setError('当前回复进行中，完成后再压缩上下文')
            return
          }
          if (currentAttachments.length > 0 || hasCodeComments) {
            setError('/compact cannot be sent with attachments or code comments')
            return
          }
          setInput('')
          await compactRuntimePaneTask(currentRuntimeTask, { onError: setError })
          return
        }

        const pendingInitialGoal =
          !currentRuntimeTask && pendingGoalState && isUnboundPendingGoalState(pendingGoalState)
            ? runtimeGoalCreateInput(pendingGoalState.goal)
            : null
        const effectiveSubmittedInput = submittedInput || pendingInitialGoal?.objective.trim() || ''
        if (!effectiveSubmittedInput && currentAttachments.length === 0 && !hasCodeComments) {
          void sendCurrentInput('', {
            codeCommentContexts,
            additionalContext: options.additionalContext,
          })
          return
        }

        let resolvedAdditionalContext: RuntimeAdditionalContext | undefined
        try {
          resolvedAdditionalContext = await appendConversationMentionContext(
            effectiveSubmittedInput,
            options.additionalContext,
            loadRuntimeTranscriptForPane
          )
        } catch (cause) {
          console.warn('[KCoder Studio composer] failed to load referenced conversation', cause)
          setError(i18n.t('workbench.mention_conversation_load_failed'))
          return
        }

        // Do not keep an earlier action error visible once the user sends a new message.
        setError(null)
        setInput('')
        const visibleSubmittedInput =
          effectiveSubmittedInput ||
          (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
        if (!currentRuntimeTask) {
          const optimisticMessage = createLocalUserMessage(
            visibleSubmittedInput,
            currentAttachments,
            {
              runtimeGoalRequest: Boolean(pendingInitialGoal),
              codeComments: codeCommentContexts,
            }
          )
          const sent = await sendCurrentInput(visibleSubmittedInput, {
            sessionMode: options.sessionMode,
            workflowDefinitionId: options.workflowDefinitionId,
            turnMode: options.turnMode,
            clientMessageId: optimisticMessage.id,
            codeCommentContexts,
            initialGoal: pendingInitialGoal,
            additionalContext: resolvedAdditionalContext,
            onError: setError,
            onRuntimeTaskOptimisticOpen: (address, context) => {
              options.onRuntimeTaskCreated?.(address)
              if (pendingInitialGoal) {
                setPendingGoalState(current =>
                  current
                    ? {
                        ...current,
                        targetKey: runtimeTranscriptPaneKey(address),
                        targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                      }
                    : current
                )
              }
              if (pendingInitialGoal && pendingGoalState) {
                seedRuntimePaneGoal(address, pendingGoalState.goal)
              }
              const seededMessages = [optimisticMessage]
              debugRuntimePaneMessageFlow('seed-optimistic-open', {
                address: runtimeAddressDebug(address),
                previousAddress: context?.previousAddress
                  ? runtimeAddressDebug(context.previousAddress)
                  : null,
                previousCount: 0,
                seededCount: seededMessages.length,
                seededMessages: summarizeWorkbenchMessages(seededMessages),
              })
              cacheRuntimeConversationMessages(address, seededMessages)
            },
          })
          if (sent) {
            if (isRuntimeTaskAddress(sent)) confirmRuntimePaneGoalSeed(sent)
            options.onExecutionModeAccepted?.()
            if (!isRuntimeTaskAddress(sent)) {
              appendLocalUserMessage(visibleSubmittedInput, currentAttachments, {
                runtimeGoalRequest: Boolean(pendingInitialGoal),
                codeComments: codeCommentContexts,
              })
            } else {
              if (pendingInitialGoal) {
                setPendingGoalState(current =>
                  current
                    ? {
                        ...current,
                        targetKey: runtimeTranscriptPaneKey(sent),
                        targetIdentityKey: runtimeTranscriptPaneIdentityKey(sent),
                      }
                    : current
                )
              }
            }
            if (isRuntimeTaskAddress(sent)) {
              dispatchMessages({ type: 'reset', messages: [] })
            }
            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            setCodeCommentContexts([])
          } else {
            // Restore the draft when send is blocked so the user can retry.
            // Use scoped setter so we do not clear the pane error reported via onError.
            scopedSetInput(visibleSubmittedInput)
          }
          return
        }

        if (hasCodeComments) {
          const queuedMessage: RuntimePaneQueuedMessage = {
            turnMode: options.turnMode,
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: appendCodeCommentContexts(visibleSubmittedInput, codeCommentContexts),
            displayContent: visibleSubmittedInput,
            codeComments: codeCommentContexts,
            status: 'queued',
            createdAt: new Date().toISOString(),
            attachments: persistAttachmentReferences(currentAttachments),
            additionalContext: resolvedAdditionalContext,
            ...getRuntimeModelFields(),
          }

          if (paneStatus.isBusy) {
            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            setCodeCommentContexts([])
            if (options.interruptWhenBusy) {
              const sent = await interruptAndSendQueuedMessage(queuedMessage)
              if (sent) options.onExecutionModeAccepted?.()
              if (!sent) {
                scopedSetInput(visibleSubmittedInput)
                currentAttachments.forEach(projectChat.addExistingAttachment)
                setCodeCommentContexts(codeCommentContexts)
              }
              return
            }
            setQueuedMessages(messages => [...messages, queuedMessage])
            options.onExecutionModeAccepted?.()
            return
          }

          const sent = await sendRuntimeMessage(queuedMessage)
          if (sent) {
            options.onExecutionModeAccepted?.()
            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            setCodeCommentContexts([])
          }
          return
        }

        const queuedMessage: RuntimePaneQueuedMessage = {
          turnMode: options.turnMode,
          id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
          content: submittedInput,
          status: 'queued',
          createdAt: new Date().toISOString(),
          attachments: persistAttachmentReferences(currentAttachments),
          additionalContext: resolvedAdditionalContext,
          ...getRuntimeModelFields(),
        }

        projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
        if (paneStatus.isBusy) {
          if (options.interruptWhenBusy) {
            const sent = await interruptAndSendQueuedMessage(queuedMessage)
            if (sent) options.onExecutionModeAccepted?.()
            if (!sent) {
              scopedSetInput(submittedInput)
              currentAttachments.forEach(projectChat.addExistingAttachment)
            }
            return
          }
          setQueuedMessages(messages => [...messages, queuedMessage])
          options.onExecutionModeAccepted?.()
          if (options.guideWhenBusy) {
            await sendQueuedMessageAsGuidance(queuedMessage)
          }
          return
        }

        const sent = await sendRuntimeMessage(queuedMessage)
        if (sent) {
          options.onExecutionModeAccepted?.()
          setCodeCommentContexts([])
        }
      },
      [
        appendLocalUserMessage,
        canSendWithSelectedModel,
        codeCommentContexts,
        commitThreadGoal,
        compactRuntimePaneTask,
        currentRuntimeTask,
        dispatchMessages,
        goalDraftActive,
        goalDraftMode,
        getRuntimeModelFields,
        input,
        interruptAndSendQueuedMessage,
        lifecycleStore,
        loadRuntimeTranscriptForPane,
        pendingGoalState,
        paneStatus.isBusy,
        projectChat,
        queuedMessages.length,
        sendCurrentInput,
        sendQueuedMessageAsGuidance,
        sendRuntimeMessage,
        scopedSetInput,
        setInput,
        setQueuedMessages,
        setRuntimeGoal,
      ]
    )

  const addCodeComment = useCallback((context: CodeCommentContext) => {
    setCodeCommentContexts(current => [...current.filter(item => item.id !== context.id), context])
  }, [])

  const clearCodeComments = useCallback(() => {
    setCodeCommentContexts([])
  }, [])

  const cancelQueuedMessage = useCallback(
    (id: string) => {
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [setQueuedMessages]
  )

  const resumeQueuedMessages = useCallback(() => {
    setQueuedMessagesPaused(false)
    const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
    const queuedMessage =
      interruptedGuidance ?? queuedMessages.find(message => message.status === 'queued')
    if (queuedMessage) void sendQueuedMessage(queuedMessage)
  }, [queuedMessages, sendQueuedMessage, setQueuedMessagesPaused])

  const resumeQueuedMessagesWithInput = useCallback(
    async (inputOverride?: string, options?: RuntimePaneSendOptions) => {
      const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
      if (!interruptedGuidance) {
        await send(inputOverride, options)
        setQueuedMessagesPaused(false)
        return
      }

      const submittedInput = (inputOverride ?? input).trim()
      const combinedMessage = {
        ...interruptedGuidance,
        content: [interruptedGuidance.content, submittedInput].filter(Boolean).join('\n\n'),
        notice: undefined,
      }
      setQueuedMessagesPaused(false)
      await sendQueuedMessage(combinedMessage)
    },
    [input, queuedMessages, send, sendQueuedMessage, setQueuedMessagesPaused]
  )

  const clearQueuedMessages = useCallback(() => {
    setQueuedMessages([])
    setQueuedMessagesPaused(false)
  }, [setQueuedMessages, setQueuedMessagesPaused])

  const reorderQueuedMessages = useCallback(
    (sourceId: string, targetId: string) => {
      setQueuedMessages(messages => {
        const sourceIndex = messages.findIndex(message => message.id === sourceId)
        const targetIndex = messages.findIndex(message => message.id === targetId)
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return messages

        const source = messages[sourceIndex]
        const target = messages[targetIndex]
        if (source.status !== 'queued' || target.status !== 'queued') return messages

        const reordered = [...messages]
        reordered.splice(sourceIndex, 1)
        const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
        reordered.splice(insertIndex, 0, source)
        return reordered
      })
    },
    [setQueuedMessages]
  )

  const editQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      setInput(queuedMessage.content)
      queuedMessage.attachments?.forEach(attachment => {
        projectChat.addExistingAttachment(attachment)
      })
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [projectChat, queuedMessages, setInput, setQueuedMessages]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      await sendQueuedMessageAsGuidance(queuedMessage)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const interruptAndSendQueued = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      const submittedInput = input.trim()
      const currentAttachments = projectChat.attachments
      const combinedMessage: RuntimePaneQueuedMessage = {
        ...queuedMessage,
        content: [queuedMessage.content, submittedInput].filter(Boolean).join('\n\n'),
        displayContent: [queuedMessage.displayContent ?? queuedMessage.content, submittedInput]
          .filter(Boolean)
          .join('\n\n'),
        attachments: [...(queuedMessage.attachments ?? []), ...currentAttachments],
        notice: undefined,
      }
      setInput('')
      projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
      const sent = await interruptAndSendQueuedMessage(combinedMessage)
      if (sent) return
      scopedSetInput(combinedMessage.displayContent ?? combinedMessage.content)
      combinedMessage.attachments?.forEach(projectChat.addExistingAttachment)
      if (combinedMessage.codeComments && combinedMessage.codeComments.length > 0) {
        setCodeCommentContexts(combinedMessage.codeComments)
      }
    },
    [input, interruptAndSendQueuedMessage, projectChat, queuedMessages, scopedSetInput, setInput]
  )

  const compactContext = useCallback(async () => {
    if (!currentRuntimeTask) {
      setError('当前对话还没有可压缩的运行时线程')
      return false
    }
    if (paneStatus.isBusy) {
      setError('当前回复进行中，完成后再压缩上下文')
      return false
    }
    return compactRuntimePaneTask(currentRuntimeTask, { onError: setError })
  }, [compactRuntimePaneTask, currentRuntimeTask, paneStatus.isBusy])

  const setCurrentGoal = useCallback(
    async (mode: RuntimeGoal['mode'] = 'standard') => {
      projectChat.setSelectedModelOption('collaborationMode', 'default')
      setGoalDraftMode(mode)
      setGoalDraftActive(true)
      return true
    },
    [projectChat]
  )

  const cancelGoalDraft = useCallback(() => {
    setGoalDraftActive(false)
    setGoalDraftMode('standard')
  }, [])

  const editCurrentGoal = useCallback(() => {
    if (!goal) return
    setInput(goal.objective)
    setGoalDraftMode(goal.mode)
    setGoalDraftActive(true)
  }, [goal, setInput])

  const updateCurrentGoalStatus = useCallback(
    async (status: RuntimeGoal['status']) => {
      if (!currentRuntimeTask) {
        if (!goal) return false
        setPendingGoalState(current =>
          current
            ? {
                ...current,
                goal: {
                  ...current.goal,
                  status,
                  updatedAt: Date.now(),
                },
              }
            : current
        )
        return true
      }

      try {
        const response = await setRuntimeGoal({
          address: currentRuntimeTask,
          status,
        })
        if (!response.accepted) return false

        commitThreadGoal(response.goal)
        lifecycleStore.goalStatusReceived(currentRuntimeTask, response.goal.status)
        if (response.goal.status === 'active') {
          await refreshWorkLists()
        }
        return true
      } catch (error) {
        console.error('[KCoder Studio] Runtime goal status update failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          status,
          error,
        })
        return false
      }
    },
    [commitThreadGoal, currentRuntimeTask, goal, lifecycleStore, refreshWorkLists, setRuntimeGoal]
  )

  const pauseCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('paused'),
    [updateCurrentGoalStatus]
  )

  const resumeCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('active'),
    [updateCurrentGoalStatus]
  )

  const shortenCurrentWait = useCallback(async () => {
    if (!currentRuntimeTask) return
    await shortenCurrentWaitAction()
  }, [currentRuntimeTask, shortenCurrentWaitAction])

  const pauseCurrentResponse = useCallback(async () => {
    if (!currentRuntimeTask) return
    // The terminal notification can enable the next turn before this ACK and
    // its directory refresh return. Only stop segments present at click time.
    const cancellationTargets = messagesRef.current.filter(
      message => message.role === 'assistant' && message.status === 'streaming'
    )

    if (goal?.status === 'active' || taskGoalStatus === 'active') {
      const paused = await updateCurrentGoalStatus('paused')
      if (!paused) return
    }

    const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
    if (!cancelled) return

    setQueuedMessagesPaused(queuedMessages.some(message => message.status === 'queued'))

    for (const message of cancellationTargets) dispatchMessages({
      type: 'assistant_cancelled',
      messageId: message.id,
      subtaskId: message.attemptId ?? message.subtaskId ?? message.turnId,
    })
  }, [
    cancelRuntimePaneTask,
    currentRuntimeTask,
    dispatchMessages,
    goal?.status,
    queuedMessages,
    setQueuedMessagesPaused,
    taskGoalStatus,
    updateCurrentGoalStatus,
  ])

  const clearCurrentGoal = useCallback(async () => {
    if (!goal) return false
    if (!currentRuntimeTask) {
      setPendingGoalState(null)
      return true
    }

    const targetIdentity = runtimeTaskLoadTargetRef.current?.identityKey
    goalRevisionRef.current += 1
    setError(null)
    try {
      const response = await clearRuntimeGoal(currentRuntimeTask)
      if (!response.accepted)
        throw new Error(response.error || i18n.t('workbench.goal_clear_failed'))

      clearRuntimePaneGoalSeed(currentRuntimeTask)
      if (runtimeTaskLoadTargetRef.current?.identityKey !== targetIdentity) return true
      setPendingGoalState(null)
      setGoalContinuation(null)
      commitThreadGoal(null)
      lifecycleStore.goalStatusReceived(currentRuntimeTask, null)
      await refreshWorkLists()
      return true
    } catch (error) {
      if (runtimeTaskLoadTargetRef.current?.identityKey === targetIdentity) {
        setError(error instanceof Error ? error.message : i18n.t('workbench.goal_clear_failed'))
      }
      console.error('[KCoder Studio] Runtime goal clear failed', {
        address: runtimeAddressDebug(currentRuntimeTask),
        error,
      })
      return false
    }
  }, [
    clearRuntimeGoal,
    commitThreadGoal,
    currentRuntimeTask,
    goal,
    lifecycleStore,
    refreshWorkLists,
  ])

  const cancelGuidanceMessage = useCallback(() => undefined, [])
  const goalContinuing = goal?.status === 'active' && goalContinuation?.status === 'started'

  useEffect(() => {
    updateRuntimePaneDebugSnapshot({
      currentRuntimeTask,
      status: paneStatus,
      messageSummary: summarizeMessages(messages),
      messageStyleComparison: compareMessageStyles(messages),
      memory: summarizeRuntimePaneMemory({
        messages,
        currentRuntimeTask,
        loadedRanges: loadedTranscriptRanges,
      }),
      queuedMessages,
      guidanceMessages,
      codeCommentContextCount: codeCommentContexts.length,
      inputLength: input.length,
      transcript: {
        loading: transcriptLoading,
        hasMoreBefore: transcriptHasMoreBefore,
        loadingMoreBefore: transcriptLoadingMoreBefore,
        turnNavigationCount: turnNavigation.length,
        loadedRanges: loadedTranscriptRanges,
      },
      subagentStatuses,
      goal,
      goalDraftActive,
    })
  }, [
    codeCommentContexts.length,
    currentRuntimeTask,
    goal,
    taskPlan,
    goalDraftActive,
    goalDraftMode,
    guidanceMessages,
    input.length,
    loadedTranscriptRanges,
    messages,
    paneStatus,
    queuedMessages,
    queuedMessagesPaused,
    subagentStatuses,
    transcriptHasMoreBefore,
    transcriptFullContent,
    transcriptLoading,
    transcriptLoadingFullContent,
    transcriptLoadingMoreBefore,
    turnNavigation.length,
  ])

  const [loadedSessionMode, setLoadedSessionMode] = useState<{
    taskId: string
    mode: import('@/types/api').RuntimeSessionMode
    workflowDefinitionId?: string | null
  } | null>(null)
  const [loadedSessionTemplate, setLoadedSessionTemplate] = useState<{
    taskId: string
    binding: { id: string; revisionSha256: string } | null
  } | null>(null)
  useEffect(() => {
    if (!currentRuntimeTask || !getRuntimeSessionModes || transcriptLoading) return
    let cancelled = false
    void getRuntimeSessionModes({ address: currentRuntimeTask })
      .then(result => {
        if (cancelled) return
        setLoadedSessionMode({ taskId: currentRuntimeTask.taskId, mode: result.sessionMode, workflowDefinitionId: result.workflowDefinitionId })
        // Read-only: a running session keeps its bound template, so Studio only shows it.
        setLoadedSessionTemplate({
          taskId: currentRuntimeTask.taskId,
          binding: result.settingsTemplate ?? null,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedSessionMode(null)
          setLoadedSessionTemplate(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentRuntimeTask, getRuntimeSessionModes, transcriptLoading])

  return {
    getRuntimeSessionModes,
    workflowDefinitionId: loadedSessionMode?.taskId === currentRuntimeTask?.taskId ? loadedSessionMode?.workflowDefinitionId : undefined,
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

function isInterruptedGuidance(message: RuntimePaneQueuedMessage): boolean {
  return message.status === 'sending' && message.notice === '正在引导当前对话'
}

function runtimeTaskLoadTargetFromAddress(address: RuntimeTaskAddress): RuntimeTaskLoadTarget {
  return {
    key: runtimeTranscriptPaneKey(address),
    identityKey: runtimeTranscriptPaneIdentityKey(address),
    address,
  }
}

const runtimeTranscriptPaneKey = runtimeConversationKey

function runtimeTranscriptPaneIdentityKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}

export function requestUserInputAnswerScopeKey(
  target: RuntimeTaskLoadTarget | null
): string | null {
  // After initial load, workspacePath and route deviceId may both be canonicalized; taskId is the stable identity.
  return target?.address.taskId ?? null
}

function isPendingGoalVisibleForRuntimeTarget(
  pendingGoalState: PendingRuntimeGoalState,
  address: RuntimeTaskAddress
): boolean {
  if (!pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey) return true
  return (
    pendingGoalState.targetKey === runtimeTranscriptPaneKey(address) ||
    pendingGoalState.targetIdentityKey === runtimeTranscriptPaneIdentityKey(address)
  )
}

function isUnboundPendingGoalState(pendingGoalState: PendingRuntimeGoalState): boolean {
  return !pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey
}

function pendingRuntimeGoalState(
  goal: RuntimeGoal,
  address: RuntimeTaskAddress
): PendingRuntimeGoalState {
  return {
    goal,
    targetKey: runtimeTranscriptPaneKey(address),
    targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
  }
}

function seedRuntimePaneGoal(address: RuntimeTaskAddress, goal: RuntimeGoal) {
  setLruMapValue(
    runtimePaneGoalSeeds,
    runtimeTranscriptPaneIdentityKey(address),
    { ...pendingRuntimeGoalState(goal, address), creationPending: true },
    MAX_CACHED_RUNTIME_PANE_GOALS
  )
}

function getRuntimePaneGoalSeed(address: RuntimeTaskAddress): PendingRuntimeGoalState | null {
  return getLruMapValue(runtimePaneGoalSeeds, runtimeTranscriptPaneIdentityKey(address)) ?? null
}

function confirmRuntimePaneGoalSeed(address: RuntimeTaskAddress) {
  const key = runtimeTranscriptPaneIdentityKey(address)
  const seed = runtimePaneGoalSeeds.get(key)
  if (seed) runtimePaneGoalSeeds.set(key, { ...seed, creationPending: false })
}

function clearRuntimePaneGoalSeed(address: RuntimeTaskAddress) {
  runtimePaneGoalSeeds.delete(runtimeTranscriptPaneIdentityKey(address))
}

function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
}

function summarizeWorkbenchMessages(messages: WorkbenchMessage[]): Record<string, unknown>[] {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    status: message.status,
    contentLength: message.content.length,
    subtaskId: message.subtaskId ?? null,
  }))
}

function debugRuntimePaneMessageFlow(event: string, details: Record<string, unknown>) {
  if (!isRuntimeDebugEnabled()) return
  console.debug('[KCoder Studio] Runtime pane message flow', {
    event,
    ...details,
  })
}

function isBatchableRuntimePaneMessageAction(action: RuntimePaneMessageAction): boolean {
  return action.type === 'assistant_chunk' || action.type === 'block_updated'
}

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}

interface CreateLocalUserMessageOptions {
  id?: string
  createdAt?: string
  runtimeGoalRequest?: boolean
  runtimeGuidance?: boolean
  codeComments?: CodeCommentContext[]
}

function createLocalUserMessage(
  content: string,
  attachments?: Attachment[],
  options: CreateLocalUserMessageOptions = {}
): WorkbenchMessage {
  return {
    id: options.id ?? `runtime-local-pane-${Date.now()}`,
    role: 'user',
    content,
    attachments: attachments ? persistAttachmentReferences(attachments) : undefined,
    status: 'done',
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeGoalRequest: options.runtimeGoalRequest ? true : undefined,
    runtimeGuidance: options.runtimeGuidance ? true : undefined,
    codeComments: options.codeComments?.length ? options.codeComments : undefined,
  }
}

function splitActiveAssistantForGuidance(
  messages: WorkbenchMessage[],
  guidanceMessage: WorkbenchMessage,
  splitBoundaries: Map<string, GuidanceSplitBoundary>
): WorkbenchMessage[] {
  const assistantIndex = findLastIndex(
    messages,
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  const messagesBeforeActiveAssistant =
    assistantIndex < 0 ? messages : messages.slice(0, assistantIndex)
  const interruptedAssistantIndex = findLastIndex(
    messagesBeforeActiveAssistant,
    message =>
      message.role === 'assistant' &&
      ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(
        String(message.runtimeStatus ?? '').toLowerCase()
      )
  )
  const normalizedMessages =
    interruptedAssistantIndex < 0
      ? messages
      : messages.map((message, index) =>
          index === interruptedAssistantIndex ? { ...message, stoppedNotice: false } : message
        )
  if (assistantIndex < 0) {
    return [...normalizedMessages, guidanceMessage]
  }

  const assistantMessage = normalizedMessages[assistantIndex]
  if (assistantMessage?.subtaskId) {
    splitBoundaries.set(assistantMessage.subtaskId, {
      prefix: assistantMessage.content,
    })
  }

  const frozenAssistantMessage: WorkbenchMessage = {
    ...assistantMessage,
    id: `${assistantMessage.id}-before-guidance-${guidanceMessage.id}`,
    subtaskId: undefined,
    status: 'done',
    runtimeStatus: 'done',
    streamTextOffset: undefined,
    completedAt: guidanceMessage.createdAt,
    runtimeGuidanceSplitBefore: true,
    blocks: freezeGuidanceAssistantBlocks(assistantMessage.blocks),
  }

  const continuationMessage = assistantMessage.subtaskId
    ? createGuidanceContinuationAssistantMessage(
        { ...assistantMessage, subtaskId: assistantMessage.subtaskId },
        guidanceMessage
      )
    : null

  return [
    ...normalizedMessages.slice(0, assistantIndex),
    frozenAssistantMessage,
    guidanceMessage,
    ...(continuationMessage ? [continuationMessage] : []),
    ...normalizedMessages.slice(assistantIndex + 1),
  ]
}

function createGuidanceContinuationAssistantMessage(
  assistantMessage: WorkbenchMessage & { subtaskId: string },
  guidanceMessage: WorkbenchMessage
): WorkbenchMessage {
  return {
    ...assistantMessage,
    id: `${assistantMessage.id}-after-guidance-${guidanceMessage.id}`,
    content: '',
    status: 'streaming',
    runtimeStatus: 'streaming',
    streamTextOffset: undefined,
    blocks: [
      {
        id: `${guidanceMessage.id}-guidance`,
        subtaskId: assistantMessage.subtaskId,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: guidanceMessage.content },
        status: 'done',
        createdAt: getMessageCreatedAtMs(guidanceMessage.createdAt),
      },
    ],
    runtimeGuidanceContinuation: true,
    contentTruncated: undefined,
    contentOriginalChars: undefined,
    completedAt: undefined,
    stoppedNotice: false,
  }
}

function transformRuntimePaneActionForGuidanceSplits(
  action: RuntimePaneMessageAction,
  splitBoundaries: Map<string, GuidanceSplitBoundary>
): RuntimePaneMessageAction {
  if (!('subtaskId' in action) || typeof action.subtaskId !== 'string') return action

  const boundary = splitBoundaries.get(action.subtaskId)
  if (!boundary) return action

  switch (action.type) {
    case 'assistant_chunk':
      return action
    case 'assistant_done': {
      splitBoundaries.delete(action.subtaskId)
      return {
        ...action,
        content:
          action.content === undefined
            ? undefined
            : trimGuidanceSplitPrefix(boundary.prefix, action.content),
      }
    }
    case 'assistant_error':
    case 'assistant_cancelled':
      splitBoundaries.delete(action.subtaskId)
      return action
    default:
      return action
  }
}

function trimGuidanceSplitPrefix(prefix: string, content: string, offset?: number): string {
  if (!prefix || !content) return content

  const prefixLength = textCodePointLength(prefix)
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    const contentLength = textCodePointLength(content)
    if (offset >= prefixLength) return content
    const coveredLength = prefixLength - offset
    if (coveredLength >= contentLength) return ''
    return sliceTextCodePoints(content, coveredLength)
  }

  if (content.startsWith(prefix)) {
    return content.slice(prefix.length)
  }
  return content
}

function freezeGuidanceAssistantBlocks(
  blocks: WorkbenchMessage['blocks']
): WorkbenchMessage['blocks'] {
  return blocks?.map(block => {
    if (block.status !== 'streaming' && block.status !== 'pending') return block
    return {
      ...block,
      status: block.type === 'tool' ? 'done' : 'done',
    }
  })
}

function textCodePointLength(value: string): number {
  return isAsciiText(value) ? value.length : Array.from(value).length
}

function sliceTextCodePoints(value: string, start: number): string {
  if (start <= 0) return value
  if (isAsciiText(value)) return value.slice(start)
  return Array.from(value).slice(start).join('')
}

function getMessageCreatedAtMs(createdAt: string): number {
  const timestamp = new Date(createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function isAsciiText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) return false
  }
  return true
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}

function isEditableLastUserMessage(messages: WorkbenchMessage[], targetIndex: number): boolean {
  if (targetIndex < 0 || targetIndex >= messages.length) return false

  const target = messages[targetIndex]
  if (target.role !== 'user') return false

  const followingMessages = messages.slice(targetIndex + 1)
  if (followingMessages.length === 0) return false
  if (followingMessages.some(message => message.role === 'user')) return false
  if (followingMessages.some(message => message.status === 'streaming')) return false

  return followingMessages.some(message => message.role === 'assistant')
}

export function reconcileRuntimeConversationMessages(
  transcriptMessages: WorkbenchMessage[],
  cachedMessages: WorkbenchMessage[],
  transcriptRunning: boolean
): WorkbenchMessage[] {
  if (transcriptMessages.length === 0) return cachedMessages
  if (!transcriptRunning && hasSettledAssistantMessage(transcriptMessages)) {
    return transcriptMessages
  }
  if (!hasUnsettledRuntimePaneState(cachedMessages)) return transcriptMessages
  if (!hasUnsettledRuntimePaneState(transcriptMessages)) return cachedMessages

  return runtimeMessageContentWeight(cachedMessages) >
    runtimeMessageContentWeight(transcriptMessages)
    ? cachedMessages
    : transcriptMessages
}

export function filterBufferedTranscriptActions(
  transcriptMessages: WorkbenchMessage[],
  bufferedActions: RuntimePaneMessageAction[]
): RuntimePaneMessageAction[] {
  const settledTurnIds = new Set(
    transcriptMessages.flatMap(message => {
      const turnId = message.turnId?.trim()
      return message.role === 'assistant' && message.status !== 'streaming' && turnId
        ? [turnId]
        : []
    })
  )
  if (settledTurnIds.size === 0) return bufferedActions

  return bufferedActions.filter(action => {
    if (!('subtaskId' in action) || !action.subtaskId || !settledTurnIds.has(action.subtaskId)) {
      return true
    }

    // The transcript already contains this turn's authoritative terminal state;
    // replaying text lifecycle would create a second assistant. Tool blocks may
    // still receive background terminal events after turn completion, so retain block events.
    return ![
      'assistant_started',
      'assistant_cached',
      'assistant_chunk',
      'assistant_done',
      'assistant_error',
      'assistant_cancelled',
    ].includes(action.type)
  })
}

function runtimeMessageContentWeight(messages: WorkbenchMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + message.content.length + JSON.stringify(message.blocks ?? []).length,
    0
  )
}

function getLruMapValue<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

function setLruMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  map.delete(key)
  map.set(key, value)

  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) return
    map.delete(oldestKey)
  }
}

function transcriptRangeFromPage(transcript: RuntimePaneTranscript): LoadedTranscriptRange[] {
  const indexedRange = transcriptRangeFromMessageIndexes(transcript.messages)
  const rangeStart =
    numericValue(transcript.rangeStart) ??
    cursorOffset(transcript.beforeCursor) ??
    indexedRange?.start ??
    (transcript.hasMoreBefore ? null : 0)
  const rangeEnd =
    numericValue(transcript.rangeEnd) ??
    cursorOffset(transcript.afterCursor) ??
    indexedRange?.end ??
    (rangeStart === null ? null : rangeStart + transcript.messages.length)

  if (rangeStart === null || rangeEnd === null || rangeEnd < rangeStart) return []
  return [{ start: rangeStart, end: rangeEnd }]
}

function transcriptRangeFromMessageIndexes(
  messages: WorkbenchMessage[]
): LoadedTranscriptRange | null {
  const indexes = messages
    .map(getRuntimeMessageIndex)
    .filter((index): index is number => index !== null)
  if (indexes.length === 0) return null
  return {
    start: Math.min(...indexes),
    end: Math.max(...indexes) + 1,
  }
}

function mergeTranscriptRanges(
  currentRanges: LoadedTranscriptRange[],
  incomingRanges: LoadedTranscriptRange[]
): LoadedTranscriptRange[] {
  const ranges = [...currentRanges, ...incomingRanges]
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start)

  const merged: LoadedTranscriptRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (!previous || range.start > previous.end) {
      merged.push({ ...range })
      continue
    }
    previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

function numericValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function cursorOffset(cursor: string | null | undefined): number | null {
  if (!cursor) return null
  const match = /^offset:(\d+)$/.exec(cursor.trim())
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

function runtimeTurnNavigationLoadOptions(
  item: RuntimeTurnNavigationItem,
  loadedRanges: LoadedTranscriptRange[]
) {
  const messageIndex = Number.isFinite(item.messageIndex) ? Math.max(0, item.messageIndex) : 0
  const sortedRanges = mergeTranscriptRanges(loadedRanges, [])
  const nextLoadedRange = sortedRanges.find(range => range.start > messageIndex)
  const pageEnd = Math.max(
    messageIndex + 1,
    Math.min(
      nextLoadedRange?.start ?? messageIndex + RUNTIME_TRANSCRIPT_PAGE_SIZE,
      messageIndex + RUNTIME_TRANSCRIPT_PAGE_SIZE
    )
  )

  return {
    limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
    beforeCursor: `offset:${pageEnd}`,
  }
}

function updateRuntimeSubagentStatuses(
  current: RuntimeSubagentStatus[],
  activity: RuntimeSubagentActivityPayload
): RuntimeSubagentStatus[] {
  const agentPath = activity.agentPath.trim()
  if (!agentPath) return current

  const agentId = runtimeSubagentId(activity)
  const status = normalizeRuntimeSubagentStatus(activity.status ?? activity.kind)
  const previousStatus = current.find(item => item.id === agentId)
  const nextStatus: RuntimeSubagentStatus = {
    id: agentId,
    agentId,
    agentPath,
    agentName:
      activity.agentName?.trim() || previousStatus?.agentName || runtimeSubagentName(agentId),
    status,
    kind: activity.kind,
    ...mergeSubagentSteeringState(previousStatus, activity),
    retainedRuns: activity.retainedRuns ?? previousStatus?.retainedRuns,
    retainedRunLimit: activity.retainedRunLimit ?? previousStatus?.retainedRunLimit,
    capacityWarning: activity.capacityWarning ?? previousStatus?.capacityWarning,
    updatedAtMs: activity.occurredAtMs ?? Date.now(),
  }

  const withoutCurrent = current.filter(item => item.id !== agentId)
  return [...withoutCurrent, nextStatus].sort((left, right) => {
    const leftTime = left.updatedAtMs ?? 0
    const rightTime = right.updatedAtMs ?? 0
    return rightTime - leftTime
  })
}

function hasUnsettledRuntimePaneState(messages: WorkbenchMessage[]): boolean {
  return messages.some(
    message =>
      message.status === 'streaming' ||
      message.status === 'pending' ||
      message.blocks?.some(block =>
        ['generating_arguments', 'pending', 'streaming'].includes(block.status)
      )
  )
}

export function transcriptSettlesLatestSeededTurn(
  transcriptMessages: WorkbenchMessage[],
  seededMessages: WorkbenchMessage[],
  transcriptRunning?: boolean
): boolean {
  if (transcriptRunning === true) return false
  const latestUserIndex = findLastIndex(seededMessages, message => message.role === 'user')
  const latestStreamingIndex = findLastIndex(
    seededMessages,
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  if (latestStreamingIndex > latestUserIndex) {
    const active = seededMessages[latestStreamingIndex]
    const activeTurnId = active.turnId?.trim() || active.subtaskId?.trim()
    if (activeTurnId)
      return transcriptMessages.some(
        message =>
          message.role === 'assistant' &&
          message.status !== 'streaming' &&
          message.turnId?.trim() === activeTurnId
      )
  }
  const latestSeededUser = latestUserIndex >= 0 ? seededMessages[latestUserIndex] : undefined
  if (!latestSeededUser) return hasSettledAssistantMessage(transcriptMessages)

  const latestMatchingUserIndex = findLastIndex(
    transcriptMessages,
    message => message.role === 'user' && message.id === latestSeededUser.id
  )
  if (latestMatchingUserIndex < 0) return false

  return transcriptMessages
    .slice(latestMatchingUserIndex + 1)
    .some(message => message.role === 'assistant' && message.status !== 'streaming')
}

function normalizeRuntimeSubagentStatus(
  value: string | undefined
): RuntimeSubagentStatus['status'] {
  const normalized = value?.replace(/_/g, '').toLowerCase()
  if (normalized === 'paused') return 'paused'
  if (normalized === 'done' || normalized === 'completed' || normalized === 'taskcomplete') {
    return 'done'
  }
  if (
    normalized === 'interrupted' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'halted' ||
    normalized === 'failed'
  ) {
    return 'interrupted'
  }
  return 'running'
}

function runtimeSubagentId(activity: RuntimeSubagentActivityPayload): string {
  const agentId = activity.agentId?.trim()
  if (agentId) return agentId

  const threadId = activity.agentThreadId?.trim()
  if (threadId) return threadId

  const agentPath = activity.agentPath.trim()
  if (agentPath.startsWith('thread:')) {
    return agentPath.slice('thread:'.length).trim() || agentPath
  }
  return agentPath
}

function runtimeSubagentName(agentId: string): string {
  const parts = agentId.split('/').filter(Boolean)
  const lastPart = parts[parts.length - 1] ?? agentId
  if (!lastPart || lastPart.startsWith('019') || lastPart.length > 16) {
    return `Agent ${shortRuntimeAgentId(agentId)}`
  }
  return lastPart
}

function shortRuntimeAgentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  return normalized.length > 8 ? normalized.slice(-8) : normalized || 'subagent'
}

function isRuntimeTaskAddress(value: unknown): value is RuntimeTaskAddress {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RuntimeTaskAddress>
  return typeof candidate.deviceId === 'string' && typeof candidate.taskId === 'number'
}

function createPendingRuntimeGoal(
  objective: string,
  mode: RuntimeGoal['mode'] = 'standard'
): RuntimeGoal {
  const now = Date.now()
  return {
    threadId: 'pending',
    objective,
    mode,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function runtimeGoalCreateInput(goal: RuntimeGoal): RuntimeGoalCreateInput {
  return {
    objective: goal.objective,
    mode: goal.mode,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  }
}

function requestUserInputResponseText(response: RequestUserInputResponse): string {
  const answers = Object.values(response.answers)
    .flatMap(answer => answer.answers)
    .map(answer => answer.trim())
    .filter(Boolean)
  return answers.length > 0 ? answers.join('\n') : '继续'
}
