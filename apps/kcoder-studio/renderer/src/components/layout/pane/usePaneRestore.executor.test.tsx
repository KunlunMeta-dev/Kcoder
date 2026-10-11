import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { usePaneRestore } from './usePaneRestore'

test('a pending restore restarts on executor loader change and cannot commit the old reply', async () => {
  let oldReply!: (value: unknown) => void
  let newReply!: (value: unknown) => void
  const oldRead = vi.fn(
    () =>
      new Promise(resolve => {
        oldReply = resolve
      })
  )
  const newRead = vi.fn(
    () =>
      new Promise(resolve => {
        newReply = resolve
      })
  )
  const address = {
    deviceId: 'restore-executor',
    taskId: 'restore-executor-task',
    workspacePath: '/owned/restore',
  }
  const target = {
    key: 'restore-executor-target',
    identityKey: 'restore-executor-identity',
    address,
  }
  const ref = <T,>(current: T) => ({ current })
  const dispatchMessages = vi.fn()
  const setTranscriptLoading = vi.fn()
  const goal = vi.fn().mockResolvedValue({ accepted: false, goal: null })
  const refresh = vi.fn().mockResolvedValue(undefined)
  const context = {
    currentRuntimeTask: address,
    currentRuntimeTaskLoadTarget: target,
    runtimeTaskLoadTarget: target,
    lifecycleStore: new RuntimeTaskLifecycleStore('executor-restore'),
    subscribeRuntimeTaskStream: vi.fn(),
    getRuntimeGoal: goal,
    refreshWorkLists: refresh,
    messages: [],
    loadedTranscriptRanges: [],
    receiptTranscriptRevision: 0,
    dispatchMessages,
    setTranscriptLoading,
    setAnsweredRequestUserInputIds: vi.fn(),
    setTranscriptHasMoreBefore: vi.fn(),
    setTranscriptBeforeCursor: vi.fn(),
    setTranscriptLoadingMoreBefore: vi.fn(),
    setTranscriptLoadingFullContent: vi.fn(),
    setTranscriptFullContent: vi.fn(),
    setLoadedTranscriptRanges: vi.fn(),
    setTurnNavigation: vi.fn(),
    setSubagentStatuses: vi.fn(),
    setGoalContinuation: vi.fn(),
    setTaskPlan: vi.fn(),
    setPendingGoalState: vi.fn(),
    setReceiptTranscriptRevision: vi.fn(),
    setRetainedRuntimeTaskLoadTarget: vi.fn(),
    commitThreadGoal: vi.fn(),
    answeredRequestUserInputIdsRef: ref(new Set()),
    requestUserInputAliasTrackerRef: ref(createRequestUserInputAliasTracker()),
    transcriptPageGateRef: ref({ invalidate: vi.fn() }),
    loadedRuntimeTranscriptKeyRef: ref<string | null>(null),
    loadRuntimeTranscriptForPaneRef: ref(oldRead),
    subscribeRuntimeTaskStreamRef: ref(vi.fn()),
    getRuntimeGoalRef: ref(goal),
    refreshWorkListsRef: ref(refresh),
    goalRevisionRef: ref(0),
    currentRuntimeTaskRef: ref(address),
    runtimeTaskLoadTargetRef: ref(target),
    displayedTranscriptIdentityRef: ref<string | null>(null),
    loadedTranscriptRangesRef: ref([]),
    pendingMessageActionsRef: ref([]),
    rebuildingTranscriptRef: ref(false),
    transcriptGapGenerationRef: ref(0),
    forceAuthoritativeTranscriptRef: ref(false),
    rebuildingTranscriptIdentityRef: ref<string | null>(null),
    bufferedTranscriptActionsRef: ref([]),
    messageActionFrameRef: ref<number | null>(null),
    lastSubmittedRetryMessageRef: ref(null),
    retrySourceBySubtaskIdRef: ref(new Map()),
    accountScopeInvalidatedRef: ref(false),
    messagesRef: ref([]),
  }
  const hook = renderHook(
    ({ read }) =>
      usePaneRestore({ ...context, loadRuntimeTranscriptForPane: read } as unknown as Parameters<
        typeof usePaneRestore
      >[0]),
    { initialProps: { read: oldRead } }
  )
  await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(1))
  hook.rerender({ read: newRead })
  await waitFor(() => expect(newRead).toHaveBeenCalledTimes(1))
  const stale = { id: 'old-executor-message', role: 'user', content: 'OLD_EXECUTOR' }
  await act(async () => oldReply({ messages: [stale], running: false }))
  expect(dispatchMessages).not.toHaveBeenCalledWith({ type: 'reset', messages: [stale] })
  expect(setTranscriptLoading).toHaveBeenLastCalledWith(true)
  const fresh = { id: 'new-executor-message', role: 'user', content: 'NEW_EXECUTOR' }
  await act(async () => newReply({ messages: [fresh], running: false }))
  expect(dispatchMessages).toHaveBeenCalledWith({ type: 'reset', messages: [fresh] })
  expect(setTranscriptLoading).toHaveBeenLastCalledWith(false)
  expect(context.rebuildingTranscriptRef.current).toBe(false)
  // A token/client refresh after a completed load retains the visible snapshot.
  const laterRead = vi.fn()
  hook.rerender({ read: laterRead })
  expect(laterRead).not.toHaveBeenCalled()
})
