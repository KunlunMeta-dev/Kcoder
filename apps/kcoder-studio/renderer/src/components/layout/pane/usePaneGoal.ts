import i18n from '@/i18n'
import type { RuntimeGoal } from '@/types/api'
import { useCallback, useSyncExternalStore } from 'react'
import { taskCompactionStatus } from '@/kcoder/taskCompactionStatus'
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
  const activeCompaction = useSyncExternalStore(
    taskCompactionStatus.subscribe,
    () => currentRuntimeTask ? taskCompactionStatus.read(currentRuntimeTask) : null,
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

      const targetIdentity = runtimeTaskLoadTargetRef.current?.identityKey
      setError(null)
      try {
        const response = await setRuntimeGoal({
          address: currentRuntimeTask,
          status,
        })
        if (runtimeTaskLoadTargetRef.current?.identityKey !== targetIdentity) return response.accepted
        if (!response.accepted) {
          setError(response.error || i18n.t('workbench.goal_set_failed'))
          return false
        }

        commitThreadGoal(response.goal)
        lifecycleStore.goalStatusReceived(currentRuntimeTask, response.goal.status)
        if (response.goal.status === 'active') {
          void refreshWorkLists().catch(() => undefined)
        }
        return true
      } catch (error) {
        if (runtimeTaskLoadTargetRef.current?.identityKey === targetIdentity)
          setError(error instanceof Error ? error.message : i18n.t('workbench.goal_set_failed'))
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
      setError,
      runtimeTaskLoadTargetRef,
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
    await shortenCurrentWaitAction({ onError: setError })
  }, [currentRuntimeTask, setError, shortenCurrentWaitAction])

  const pauseCurrentResponse = useCallback(async () => {
    if (!currentRuntimeTask) return
    // Use the operation captured by this control even if its terminal
    // notification arrives before the click. A stale compaction cannot
    // fall through to the interrupt path of a later turn.
    const compaction = activeCompaction ?? taskCompactionStatus.read(currentRuntimeTask)
    if (compaction) {
      try {
        await compaction.requestCancellation()
      } catch {
        setError(i18n.t('workbench.runtime_compaction_cancel_failed'))
      }
      return
    }
    // The terminal notification can enable the next turn before this ACK and
    // its directory refresh return. Only stop segments present at click time.
    const cancellationTargets = messagesRef.current.filter(
      message => message.role === 'assistant' && message.status === 'streaming'
    )

    const expectedTurnId = cancellationTargets.at(-1)?.turnId ?? undefined

    if (goal?.status === 'active' || taskGoalStatus === 'active') {
      const paused = await updateCurrentGoalStatus('paused')
      if (!paused) return
    }

    const cancelled = await cancelRuntimePaneTask(
      { ...currentRuntimeTask, ...(expectedTurnId ? { expectedTurnId } : {}) },
      { onError: setError }
    )
    if (!cancelled) return

    setQueuedMessagesPaused(queuedMessages.some(message => message.status === 'queued'))

    for (const message of cancellationTargets)
      dispatchMessages({
        type: 'assistant_cancelled',
        messageId: message.id,
        subtaskId: message.attemptId ?? message.subtaskId ?? message.turnId,
      })
  }, [
    activeCompaction,
    cancelRuntimePaneTask,
    currentRuntimeTask,
    dispatchMessages,
    goal?.status,
    messagesRef,
    queuedMessages,
    setError,
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
      void refreshWorkLists().catch(() => undefined)
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
    compactionActive: activeCompaction !== null,
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
