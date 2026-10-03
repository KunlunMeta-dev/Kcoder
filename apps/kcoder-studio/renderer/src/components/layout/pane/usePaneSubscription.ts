import { updateRuntimeGoalContinuation } from '@/lib/runtime-goal'
import { useEffect } from 'react'
import { markRuntimeSubagentsSettled } from '../subagentSteerState'
import { clearRuntimePaneGoalSeed, getRuntimePaneGoalSeed } from './goalSeeds'
import { runtimeAddressDebug } from './paneDiagnostics'
import { RUNTIME_TRANSCRIPT_PAGE_SIZE } from './paneMessageReducer'
import { isPendingGoalVisibleForRuntimeTarget } from './sessionIdentity'
import { hasUnsettledRuntimePaneState, updateRuntimeSubagentStatuses } from './subagentState'
import { transcriptRangeFromPage } from './transcriptRanges'
import type { usePaneRestore } from './usePaneRestore'

export function usePaneSubscription(context: ReturnType<typeof usePaneRestore>) {
  const {
    lifecycleStore,
    setQueuedMessages,
    setError,
    transcriptPageGateRef,
    setTranscriptHasMoreBefore,
    setTranscriptBeforeCursor,
    setTranscriptLoadingMoreBefore,
    setTranscriptLoadingFullContent,
    setTranscriptFullContent,
    setLoadedTranscriptRanges,
    setTurnNavigation,
    setSubagentStatuses,
    setGoalContinuation,
    setTaskPlan,
    setPendingGoalState,
    loadedRuntimeTranscriptKeyRef,
    setReceiptTranscriptRevision,
    loadRuntimeTranscriptForPaneRef,
    subscribeRuntimeTaskStreamRef,
    getRuntimeGoalRef,
    goalRevisionRef,
    commitThreadGoal,
    refreshWorkListsRef,
    runtimeTaskLoadTargetRef,
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    rebuildingTranscriptRef,
    transcriptGapGenerationRef,
    forceAuthoritativeTranscriptRef,
    rebuildingTranscriptIdentityRef,
    bufferedTranscriptActionsRef,
    lastSubmittedRetryMessageRef,
    retrySourceBySubtaskIdRef,
    runtimeTaskStreamTargetKey,
    messagesRef,
    dispatchMessages,
    appendGuidanceLocalUserMessage,
  } = context
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
    bufferedTranscriptActionsRef,
    commitThreadGoal,
    dispatchMessages,
    forceAuthoritativeTranscriptRef,
    getRuntimeGoalRef,
    goalRevisionRef,
    interruptedGuidanceIdsRef,
    lastSubmittedRetryMessageRef,
    lifecycleStore,
    loadRuntimeTranscriptForPaneRef,
    loadedRuntimeTranscriptKeyRef,
    messagesRef,
    pendingAppliedGuidancesRef,
    rebuildingTranscriptIdentityRef,
    rebuildingTranscriptRef,
    refreshWorkListsRef,
    retrySourceBySubtaskIdRef,
    runtimeTaskLoadTargetRef,
    runtimeTaskStreamTargetKey,
    setError,
    setGoalContinuation,
    setLoadedTranscriptRanges,
    setPendingGoalState,
    setQueuedMessages,
    setReceiptTranscriptRevision,
    setSubagentStatuses,
    setTaskPlan,
    setTranscriptBeforeCursor,
    setTranscriptFullContent,
    setTranscriptHasMoreBefore,
    setTranscriptLoadingFullContent,
    setTranscriptLoadingMoreBefore,
    setTurnNavigation,
    subscribeRuntimeTaskStreamRef,
    transcriptGapGenerationRef,
    transcriptPageGateRef,
  ])
  return context
}
