import { notifyRuntimeWorkChanged } from '@/kcoder/runtimeWorkEvents'
import { isRuntimeGoalScopeRetired } from '@/kcoder/goalObservationCancellation'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { updateRuntimeGoalContinuation } from '@/lib/runtime-goal'
import { markRuntimeTaskPlanStale } from '@/stream/responseApiStream'
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
    setTaskPlanStale,
    setPendingGoalState,
    loadedRuntimeTranscriptKeyRef,
    setReceiptTranscriptRevision,
    loadRuntimeTranscriptForPaneRef,
    subscribeRuntimeTaskStreamRef,
    getRuntimeGoalRef,
    goalRevisionRef,
    commitThreadGoal,
    runtimeTaskLoadTargetRef,
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    rebuildingTranscriptRef,
    showLiveDuringTranscriptLoadRef,
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
    let goalRefreshSequence = 0
    const refreshGoal = () => {
      const goalCreationPending = getRuntimePaneGoalSeed(address)?.creationPending === true
      const requestedGoalRevision = goalRevisionRef.current
      const requestedGoalTargetIdentity = target.identityKey
      const requestedGoalReader = getRuntimeGoalRef.current
      const accountCurrent = captureAccountContextRevision()
      const requestSequence = ++goalRefreshSequence
      const isCurrentGoalRefresh = () =>
        active &&
        requestSequence === goalRefreshSequence &&
        getRuntimeGoalRef.current === requestedGoalReader &&
        accountCurrent(address.deviceId) &&
        runtimeTaskLoadTargetRef.current?.identityKey === requestedGoalTargetIdentity &&
        requestedGoalRevision === goalRevisionRef.current

      void requestedGoalReader(address)
        .then(response => {
          if (!isCurrentGoalRefresh()) return
          if (!response.accepted) {
            console.error('[KCoder Studio] Runtime goal refresh failed', {
              address: runtimeAddressDebug(address),
              error: new Error(response.error || 'Runtime goal read was not accepted'),
            })
            return
          }

          const loadedGoal = response.goal
          if (!loadedGoal && goalCreationPending) return
          commitThreadGoal(loadedGoal)
          lifecycleStore.goalStatusReceived(address, loadedGoal?.status ?? null)
          clearRuntimePaneGoalSeed(address)
          const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
          setPendingGoalState(current =>
            current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress) ? null : current
          )
        })
        .catch(error => {
          // Archiving, removing, or switching sessions releases the old task's gateway
          // client. The old turn no longer belongs to this pane, so a late goal-request
          // failure is expected cleanup and should not pollute the console.
          if (!isCurrentGoalRefresh() || isRuntimeGoalScopeRetired(error)) return
          console.error('[KCoder Studio] Runtime goal refresh failed', {
            address: runtimeAddressDebug(address),
            error,
          })
        })
    }
    // A hard refresh or navigation does not guarantee React effect cleanup first.
    // pagehide fires before transport closure and invalidates unfinished goal requests.
    window.addEventListener('pagehide', deactivate)
    const unsubscribe = subscribeRuntimeTaskStreamRef.current(address, {
      onStreamGap: () => {
        if (!active || runtimeTaskLoadTargetRef.current?.identityKey !== target.identityKey) return
        // Missing lifecycle events require one directory reconciliation, independent
        // of whether the separate Goal read succeeds or returns an active Goal.
        notifyRuntimeWorkChanged()
        markRuntimeTaskPlanStale(address)
        refreshGoal()
        setQueuedMessages(messages =>
          messages.map(message =>
            pendingAppliedGuidancesRef.current.has(message.id) &&
            message.status === 'sending' &&
            message.notice === '正在引导当前对话'
              ? { ...message, status: 'unknown', notice: undefined }
              : message
          )
        )
        transcriptGapGenerationRef.current += 1
        forceAuthoritativeTranscriptRef.current = true
        // Discard the incomplete event suffix and start a new authoritative read.
        // New events arriving during that read use the existing replay/filter gate.
        rebuildingTranscriptRef.current = true
        showLiveDuringTranscriptLoadRef.current = false
        rebuildingTranscriptIdentityRef.current = target.identityKey
        bufferedTranscriptActionsRef.current = []
        loadedRuntimeTranscriptKeyRef.current = null
        setReceiptTranscriptRevision(revision => revision + 1)
      },
      onMessageAction: action => {
        if (!active || runtimeTaskLoadTargetRef.current?.identityKey !== target.identityKey) return
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
            showLiveDuringTranscriptLoadRef.current = false
            bufferedTranscriptActionsRef.current = []
            loadedRuntimeTranscriptKeyRef.current = null
            setReceiptTranscriptRevision(revision => revision + 1)
          }
          if (showLiveDuringTranscriptLoadRef.current) dispatchMessages(action)
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
        refreshGoal()
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
        showLiveDuringTranscriptLoadRef.current = false
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
        notifyRuntimeWorkChanged()
      },
      onSubagentActivity: activity => {
        setSubagentStatuses(current => updateRuntimeSubagentStatuses(current, activity))
      },
      onRuntimeGoalUpdated: payload => {
        const loadedGoal = payload.goal ?? null
        commitThreadGoal(loadedGoal)
        lifecycleStore.goalStatusReceived(address, loadedGoal?.status ?? null)
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
        notifyRuntimeWorkChanged()
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
        setTaskPlanStale(false)
      },
      onGuidanceApplied: payload => {
        const pendingMessage = pendingAppliedGuidancesRef.current.get(payload.guidanceId)
        const pendingEntry = pendingMessage
          ? [payload.guidanceId, pendingMessage] as const
          : undefined
        if (!pendingEntry) return
        const [guidanceId, guidanceMessage] = pendingEntry
        pendingAppliedGuidancesRef.current.delete(guidanceId)
        if (interruptedGuidanceIdsRef.current.delete(guidanceId)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== guidanceId || message.notice !== '正在引导当前对话'))
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
    showLiveDuringTranscriptLoadRef,
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
    setTaskPlanStale,
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
