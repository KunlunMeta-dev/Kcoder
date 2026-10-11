import {
  createRequestUserInputAliasTracker,
  isRequestUserInputBlock,
  observeRequestUserInputAliases,
} from '@/components/chat/requestUserInputMessages'
import {
  cacheRuntimeConversationMessages,
  getRuntimeAnsweredRequestUserInputIds,
  getRuntimeConversationMessages,
} from '@/features/workbench/runtimeConversationCache'
import { isAbortError } from '@/lib/async-errors'
import { getCachedRuntimeTaskPlan } from '@/stream/responseApiStream'
import { useEffect } from 'react'
import { clearRuntimePaneGoalSeed, getRuntimePaneGoalSeed } from './goalSeeds'
import {
  debugRuntimePaneMessageFlow,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
} from './paneDiagnostics'
import {
  filterBufferedTranscriptActions,
  reconcileRuntimeConversationMessages,
  RUNTIME_TRANSCRIPT_PAGE_SIZE,
  transcriptSettlesLatestSeededTurn,
} from './paneMessageReducer'
import {
  isPendingGoalVisibleForRuntimeTarget,
  requestUserInputAnswerScopeKey,
} from './sessionIdentity'
import { transcriptRangeFromPage } from './transcriptRanges'
import type { usePaneState } from './usePaneState'

export function usePaneRestore(context: ReturnType<typeof usePaneState>) {
  const {
    currentRuntimeTask,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    getRuntimeGoal,
    refreshWorkLists,
    lifecycleStore,
    setAnsweredRequestUserInputIds,
    answeredRequestUserInputIdsRef,
    requestUserInputAliasTrackerRef,
    setTranscriptLoading,
    transcriptPageGateRef,
    setTranscriptHasMoreBefore,
    setTranscriptBeforeCursor,
    setTranscriptLoadingMoreBefore,
    setTranscriptLoadingFullContent,
    setTranscriptFullContent,
    loadedTranscriptRanges,
    setLoadedTranscriptRanges,
    setTurnNavigation,
    setSubagentStatuses,
    setGoalContinuation,
    setTaskPlan,
    setPendingGoalState,
    loadedRuntimeTranscriptKeyRef,
    receiptTranscriptRevision,
    setReceiptTranscriptRevision,
    loadRuntimeTranscriptForPaneRef,
    subscribeRuntimeTaskStreamRef,
    getRuntimeGoalRef,
    goalRevisionRef,
    commitThreadGoal,
    refreshWorkListsRef,
    currentRuntimeTaskRef,
    runtimeTaskLoadTargetRef,
    displayedTranscriptIdentityRef,
    loadedTranscriptRangesRef,
    pendingMessageActionsRef,
    rebuildingTranscriptRef,
    transcriptGapGenerationRef,
    forceAuthoritativeTranscriptRef,
    rebuildingTranscriptIdentityRef,
    bufferedTranscriptActionsRef,
    messageActionFrameRef,
    lastSubmittedRetryMessageRef,
    retrySourceBySubtaskIdRef,
    currentRuntimeTaskLoadTarget,
    setRetainedRuntimeTaskLoadTarget,
    runtimeTaskLoadTarget,
    messages,
    accountScopeInvalidatedRef,
    messagesRef,
    dispatchMessages,
  } = context
  useEffect(() => {
    currentRuntimeTaskRef.current = currentRuntimeTask
  }, [currentRuntimeTask, currentRuntimeTaskRef])

  useEffect(() => {
    if (currentRuntimeTaskLoadTarget) {
      setRetainedRuntimeTaskLoadTarget(current =>
        current?.key === currentRuntimeTaskLoadTarget.key ? current : currentRuntimeTaskLoadTarget
      )
    }
  }, [currentRuntimeTaskLoadTarget, setRetainedRuntimeTaskLoadTarget])

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
  }, [currentRuntimeTaskLoadTarget, setTaskPlan])

  useEffect(() => {
    return () => {
      if (messageActionFrameRef.current !== null) {
        cancelAnimationFrame(messageActionFrameRef.current)
        messageActionFrameRef.current = null
      }
      pendingMessageActionsRef.current = []
    }
  }, [messageActionFrameRef, pendingMessageActionsRef])

  useEffect(() => {
    runtimeTaskLoadTargetRef.current = runtimeTaskLoadTarget
  }, [runtimeTaskLoadTarget, runtimeTaskLoadTargetRef])

  useEffect(
    () => () => {
      const target = runtimeTaskLoadTargetRef.current
      const messages = messagesRef.current
      if (accountScopeInvalidatedRef.current || !target || messages.length === 0) return
      cacheRuntimeConversationMessages(target.address, messages)
    },
    [accountScopeInvalidatedRef, messagesRef, runtimeTaskLoadTargetRef]
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
  }, [
    accountScopeInvalidatedRef,
    messages,
    messagesRef,
    requestUserInputAliasTrackerRef,
    runtimeTaskLoadTargetRef,
  ])

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
  }, [
    answeredRequestUserInputIdsRef,
    lastSubmittedRetryMessageRef,
    requestUserInputAliasTrackerRef,
    requestUserInputAnswerScope,
    retrySourceBySubtaskIdRef,
    runtimeTaskLoadTargetRef,
    setAnsweredRequestUserInputIds,
  ])

  useEffect(() => {
    loadedTranscriptRangesRef.current = loadedTranscriptRanges
  }, [loadedTranscriptRanges, loadedTranscriptRangesRef])

  useEffect(() => {
    loadRuntimeTranscriptForPaneRef.current = loadRuntimeTranscriptForPane
  }, [loadRuntimeTranscriptForPane, loadRuntimeTranscriptForPaneRef])

  useEffect(() => {
    subscribeRuntimeTaskStreamRef.current = subscribeRuntimeTaskStream
  }, [subscribeRuntimeTaskStream, subscribeRuntimeTaskStreamRef])

  useEffect(() => {
    getRuntimeGoalRef.current = getRuntimeGoal
  }, [getRuntimeGoal, getRuntimeGoalRef])

  useEffect(() => {
    refreshWorkListsRef.current = refreshWorkLists
  }, [refreshWorkLists, refreshWorkListsRef])

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
  }, [
    commitThreadGoal,
    getRuntimeGoal,
    goalRevisionRef,
    lifecycleStore,
    refreshWorkListsRef,
    runtimeTaskLoadTarget,
    setGoalContinuation,
    setPendingGoalState,
  ])

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
  }, [loadedRuntimeTranscriptKeyRef, runtimeTaskLoadTargetRef, setReceiptTranscriptRevision])

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
  }, [
    dispatchMessages,
    lifecycleStore,
    runtimeTaskLoadTarget,
    receiptTranscriptRevision,
    loadRuntimeTranscriptForPane,
    loadedRuntimeTranscriptKeyRef,
    transcriptGapGenerationRef,
    forceAuthoritativeTranscriptRef,
    rebuildingTranscriptIdentityRef,
    transcriptPageGateRef,
    rebuildingTranscriptRef,
    displayedTranscriptIdentityRef,
    messagesRef,
    setTranscriptLoading,
    setTranscriptHasMoreBefore,
    setTranscriptBeforeCursor,
    setTranscriptLoadingMoreBefore,
    setTranscriptLoadingFullContent,
    setTranscriptFullContent,
    setLoadedTranscriptRanges,
    setTurnNavigation,
    setSubagentStatuses,
    setTaskPlan,
    bufferedTranscriptActionsRef,
    loadRuntimeTranscriptForPaneRef,
  ])
  return { ...context, requestUserInputAnswerScope }
}
