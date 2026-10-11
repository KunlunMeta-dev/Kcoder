import i18n from '@/i18n'
import type { RuntimeGoal } from '@/types/api'
import { useCallback } from 'react'
import { clearRuntimePaneGoalSeed } from './goalSeeds'
import { runtimeAddressDebug } from './paneDiagnostics'
import type { usePaneQueueControls } from './usePaneQueueControls'

export function usePaneGoal(context: ReturnType<typeof usePaneQueueControls>) {
  const {
    currentRuntimeTask,
    projectChat,
    setRuntimeGoal,
    clearRuntimeGoal,
    compactRuntimePaneTask,
    cancelRuntimePaneTask,
    shortenCurrentWaitAction,
    refreshWorkLists,
    lifecycleStore,
    queuedMessages,
    setQueuedMessagesPaused,
    setError,
    setInput,
    goalContinuation,
    setGoalContinuation,
    setPendingGoalState,
    setGoalDraftActive,
    setGoalDraftMode,
    goalRevisionRef,
    commitThreadGoal,
    runtimeTaskLoadTargetRef,
    messagesRef,
    dispatchMessages,
    taskGoalStatus,
    paneStatus,
    goal,
  } = context
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
  }, [compactRuntimePaneTask, currentRuntimeTask, paneStatus.isBusy, setError])

  const setCurrentGoal = useCallback(
    async (mode: RuntimeGoal['mode'] = 'standard') => {
      projectChat.setSelectedModelOption('collaborationMode', 'default')
      setGoalDraftMode(mode)
      setGoalDraftActive(true)
      return true
    },
    [projectChat, setGoalDraftActive, setGoalDraftMode]
  )

  const cancelGoalDraft = useCallback(() => {
    setGoalDraftActive(false)
    setGoalDraftMode('standard')
  }, [setGoalDraftActive, setGoalDraftMode])

  const editCurrentGoal = useCallback(() => {
    if (!goal) return
    setInput(goal.objective)
    setGoalDraftMode(goal.mode)
    setGoalDraftActive(true)
  }, [goal, setGoalDraftActive, setGoalDraftMode, setInput])

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
    [
      commitThreadGoal,
      currentRuntimeTask,
      goal,
      lifecycleStore,
      refreshWorkLists,
      setPendingGoalState,
      setRuntimeGoal,
    ]
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

    for (const message of cancellationTargets)
      dispatchMessages({
        type: 'assistant_cancelled',
        messageId: message.id,
        subtaskId: message.attemptId ?? message.subtaskId ?? message.turnId,
      })
  }, [
    cancelRuntimePaneTask,
    currentRuntimeTask,
    dispatchMessages,
    goal?.status,
    messagesRef,
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
    goalRevisionRef,
    lifecycleStore,
    refreshWorkLists,
    runtimeTaskLoadTargetRef,
    setError,
    setGoalContinuation,
    setPendingGoalState,
  ])

  const cancelGuidanceMessage = useCallback(() => undefined, [])

  const goalContinuing = goal?.status === 'active' && goalContinuation?.status === 'started'
  return {
    ...context,
    compactContext,
    setCurrentGoal,
    cancelGoalDraft,
    editCurrentGoal,
    updateCurrentGoalStatus,
    pauseCurrentGoal,
    resumeCurrentGoal,
    shortenCurrentWait,
    pauseCurrentResponse,
    clearCurrentGoal,
    cancelGuidanceMessage,
    goalContinuing,
  }
}
