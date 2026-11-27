import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { usePaneRestore } from './usePaneRestore'

test.each([false, true])('restore follows its executor but not presentation enrichment (Goal pending: %s)', async goalPending => {
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
  const address: RuntimeTaskAddress = {
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
  let finishGoal!: (value: { accepted: boolean; goal: null }) => void
  const goalResult = goalPending
    ? new Promise(resolve => { finishGoal = resolve })
    : Promise.resolve({ accepted: false, goal: null })
  const goal = vi.fn(() => goalResult)
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
    setHistoryReadOnly: vi.fn(),
    setTranscriptError: vi.fn(),
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
    setTaskPlanStale: vi.fn(),
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
    showLiveDuringTranscriptLoadRef: ref(false),
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
  expect(dispatchMessages).not.toHaveBeenCalledWith([{ type: 'reset', messages: [stale] }])
  expect(setTranscriptLoading).toHaveBeenLastCalledWith(true)
  const fresh = { id: 'new-executor-message', role: 'user', content: 'NEW_EXECUTOR' }
  await act(async () => newReply({ messages: [fresh], running: false }))
  // The loaded transcript commits together with buffered live actions.
  expect(dispatchMessages).toHaveBeenCalledWith([{ type: 'reset', messages: [fresh] }])
  expect(setTranscriptLoading).toHaveBeenLastCalledWith(false)
  expect(context.rebuildingTranscriptRef.current).toBe(false)
  // A token/client refresh after a completed load retains the visible snapshot.
  const laterRead = vi.fn()
  hook.rerender({ read: laterRead })
  expect(laterRead).not.toHaveBeenCalled()
  const goalCommits = context.commitThreadGoal.mock.calls.length
  const enriched = { ...address, runtimeHandle: { memoryTaskSnapshot: { sequence: 2 }, agentDefinition: { agentId: 'display' } } }
  context.currentRuntimeTask = enriched
  context.runtimeTaskLoadTarget = { ...target, address: enriched }
  hook.rerender({ read: laterRead })
  expect(goal).toHaveBeenCalledTimes(1)
  expect(context.commitThreadGoal).toHaveBeenCalledTimes(goalCommits)
  if (goalPending) {
    await act(async () => finishGoal({ accepted: true, goal: null }))
    expect(context.commitThreadGoal).toHaveBeenCalledTimes(goalCommits + 1)
  }
  let finishRetired!: (value: unknown) => void
  const replacement = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRetired = resolve }))
    .mockResolvedValue({ accepted: true, goal: null })
  context.getRuntimeGoal = replacement
  await act(async () => hook.rerender({ read: laterRead }))
  expect(replacement).toHaveBeenCalledTimes(1)
  for (const narrowing of [
    { threadId: 'replacement-thread' },
    { workspacePath: '/replacement-workspace' },
    { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'native-thread' } },
    { deviceId: 'replacement-target' },
    { taskId: 'replacement-task' },
  ] satisfies Partial<RuntimeTaskAddress>[]) {
    replacement.mockClear()
    const narrowed = { ...enriched, ...narrowing }
    context.runtimeTaskLoadTarget = { ...target, address: narrowed }
    await act(async () => hook.rerender({ read: laterRead }))
    expect(replacement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(narrowing))
  }
  const currentGoalCommits = context.commitThreadGoal.mock.calls.length
  await act(async () => finishRetired({ accepted: true, goal: { id: 'retired-goal', status: 'complete' } }))
  expect(context.commitThreadGoal).toHaveBeenCalledTimes(currentGoalCommits)
})

test.each<{
  name: string
  displayed: boolean
  failedRead?: boolean
  liveDuringLoad?: boolean
  snapshotRunning?: boolean
  newerTurn?: boolean
  settledDuringLoad?: boolean
  goalActive?: boolean
}>([
  { name: 'the conversation already on screen keeps its side panels', displayed: true },
  { name: 'switching to another conversation clears them', displayed: false },
  { name: 'a failed original history read remains visible and cannot commit empty success', displayed: false, failedRead: true },
  { name: 'a live stream arriving during history loading remains the replay owner', displayed: true, liveDuringLoad: true },
  { name: 'a terminal snapshot replaces the observed live stream without replay', displayed: true, liveDuringLoad: true, snapshotRunning: false },
  { name: 'a delayed old terminal snapshot cannot settle a newer live turn', displayed: true, liveDuringLoad: true, snapshotRunning: false, newerTurn: true },
  { name: 'a stale running snapshot cannot replay an already settled live turn', displayed: true, liveDuringLoad: true, settledDuringLoad: true },
  { name: 'a settled turn is not replayed while its Goal keeps the task running', displayed: true, liveDuringLoad: true, settledDuringLoad: true, goalActive: true },
])('a transcript reload: $name', async ({ displayed, failedRead, liveDuringLoad, snapshotRunning = true, newerTurn = false, settledDuringLoad = false, goalActive = false }) => {
  const address = { deviceId: 'restore-panels', taskId: 'restore-panels-task', workspacePath: '/owned/panels' }
  const target = { key: 'restore-panels-target', identityKey: 'restore-panels-identity', address }
  const ref = <T,>(current: T) => ({ current })
  let finishRead!: (value: unknown) => void
  const read = liveDuringLoad ? vi.fn(() => new Promise(resolve => { finishRead = resolve }))
    : failedRead ? vi.fn().mockRejectedValue(new Error('Original history read denied')) : vi.fn().mockResolvedValue({ messages: [], running: false })
  const setTranscriptError = vi.fn()
  const goal = vi.fn().mockResolvedValue({ accepted: false, goal: null })
  const refresh = vi.fn().mockResolvedValue(undefined)
  const setTaskPlan = vi.fn()
  const setTurnNavigation = vi.fn()
  const setSubagentStatuses = vi.fn()
  const dispatchMessages = vi.fn((actions: RuntimePaneMessageAction | RuntimePaneMessageAction[]) => {
    for (const action of Array.isArray(actions) ? actions : [actions])
      context.messagesRef.current = reduceWorkbenchMessages(context.messagesRef.current, action)
  })
  const context = {
    currentRuntimeTask: address, currentRuntimeTaskLoadTarget: target, runtimeTaskLoadTarget: target,
    lifecycleStore: new RuntimeTaskLifecycleStore('panels-restore'), subscribeRuntimeTaskStream: vi.fn(),
    getRuntimeGoal: goal, refreshWorkLists: refresh, messages: [], loadedTranscriptRanges: [],
    receiptTranscriptRevision: 0, dispatchMessages, setTranscriptLoading: vi.fn(),
    setHistoryReadOnly: vi.fn(), setTranscriptError,
    setAnsweredRequestUserInputIds: vi.fn(), setTranscriptHasMoreBefore: vi.fn(),
    setTranscriptBeforeCursor: vi.fn(), setTranscriptLoadingMoreBefore: vi.fn(),
    setTranscriptLoadingFullContent: vi.fn(), setTranscriptFullContent: vi.fn(),
    setLoadedTranscriptRanges: vi.fn(), setTurnNavigation, setSubagentStatuses,
    setGoalContinuation: vi.fn(), setTaskPlan, setPendingGoalState: vi.fn(),
    setTaskPlanStale: vi.fn(),
    setReceiptTranscriptRevision: vi.fn(), setRetainedRuntimeTaskLoadTarget: vi.fn(),
    commitThreadGoal: vi.fn(), answeredRequestUserInputIdsRef: ref(new Set()),
    requestUserInputAliasTrackerRef: ref(createRequestUserInputAliasTracker()),
    transcriptPageGateRef: ref({ invalidate: vi.fn() }), loadedRuntimeTranscriptKeyRef: ref<string | null>(null),
    loadRuntimeTranscriptForPaneRef: ref(read), subscribeRuntimeTaskStreamRef: ref(vi.fn()),
    getRuntimeGoalRef: ref(goal), refreshWorkListsRef: ref(refresh), goalRevisionRef: ref(0),
    currentRuntimeTaskRef: ref(address), runtimeTaskLoadTargetRef: ref(target),
    displayedTranscriptIdentityRef: ref<string | null>(displayed ? target.identityKey : 'another-identity'),
    loadedTranscriptRangesRef: ref([]), pendingMessageActionsRef: ref([]), rebuildingTranscriptRef: ref(false),
    showLiveDuringTranscriptLoadRef: ref(false), transcriptGapGenerationRef: ref(0),
    forceAuthoritativeTranscriptRef: ref(false), rebuildingTranscriptIdentityRef: ref<string | null>(null),
    bufferedTranscriptActionsRef: ref<RuntimePaneMessageAction[]>([]), messageActionFrameRef: ref<number | null>(null),
    lastSubmittedRetryMessageRef: ref(null), retrySourceBySubtaskIdRef: ref(new Map()),
    accountScopeInvalidatedRef: ref(false), messagesRef: ref<WorkbenchMessage[]>([]),
    loadRuntimeTranscriptForPane: read,
  }
  const user: WorkbenchMessage = { id: 'owned-user', role: 'user', status: 'done', content: 'owned question', createdAt: '2026-11-24T00:00:00Z', turnId: 'turn-1' }
  const persisted: WorkbenchMessage = { ...user, id: 'persisted-assistant-uuid', role: 'assistant', subtaskId: 'native-thread:history:1', content: 'owned reply' }
  if (liveDuringLoad) context.messagesRef.current = newerTurn ? [user, persisted] : [user]
  const hook = renderHook(() => usePaneRestore(context as unknown as Parameters<typeof usePaneRestore>[0]))
  if (liveDuringLoad) {
    try {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      const turnId = newerTurn ? 'turn-2' : 'turn-1'
      context.lifecycleStore.turnStarted(address, turnId)
      const actions: RuntimePaneMessageAction[] = [
        ...(newerTurn ? [{ type: 'user_added' as const, message: { ...user, id: 'new-user', turnId } }] : []),
        { type: 'assistant_started', taskId: address.taskId, subtaskId: turnId, turnId },
        { type: 'assistant_chunk', subtaskId: turnId, content: 'owned reply', offset: 0 },
      ]
      if (settledDuringLoad) {
        if (goalActive) context.lifecycleStore.goalStatusReceived(address, 'active')
        context.lifecycleStore.turnSettled(address, turnId)
        actions.push({ type: 'assistant_done', subtaskId: turnId, turnId, content: 'owned reply' })
      }
      context.bufferedTranscriptActionsRef.current = actions
      act(() => dispatchMessages(actions))
      await act(async () => finishRead({ messages: [user, persisted], running: snapshotRunning }))
      if (newerTurn) expect(context.lifecycleStore.getTask(address)?.derived.isRunning).toBe(true)
      const assistantCount = newerTurn ? 2 : 1
      expect(context.messagesRef.current.filter(message => message.role === 'assistant')).toHaveLength(assistantCount)
      expect(context.messagesRef.current.at(-1)?.id).toBe(snapshotRunning && !settledDuringLoad || newerTurn ? `assistant-${turnId}` : persisted.id)
      expect(context.messagesRef.current.at(-1)?.content).toBe('owned reply')
      act(() => dispatchMessages({ type: 'assistant_done', subtaskId: turnId, turnId, content: 'owned reply' }))
      expect(context.messagesRef.current.filter(message => message.role === 'assistant')).toHaveLength(assistantCount)
      expect(context.messagesRef.current.at(-1)).toMatchObject({ content: 'owned reply', status: 'done' })
    } finally { hook.unmount() }
    return
  }
  if (failedRead) {
    await waitFor(() => expect(setTranscriptError).toHaveBeenCalledWith(expect.any(String)))
    expect(setTranscriptError.mock.calls.at(-1)?.[0]).toMatch(/历史|history/)
    expect(context.loadedRuntimeTranscriptKeyRef.current).toBe(null)
    expect(read).toHaveBeenCalledTimes(1)
    expect(dispatchMessages).not.toHaveBeenCalledWith([{ type: 'reset', messages: [] }])
    context.runtimeTaskLoadTargetRef.current = { ...target, key: 'another-owner' }
    act(() => hook.result.current.retryRuntimeTranscript())
    expect(context.setReceiptTranscriptRevision).not.toHaveBeenCalled()
    context.runtimeTaskLoadTargetRef.current = target
    act(() => hook.result.current.retryRuntimeTranscript())
    expect(context.setReceiptTranscriptRevision).toHaveBeenCalledTimes(1)
    expect(context.forceAuthoritativeTranscriptRef.current).toBe(true)
    read.mockResolvedValue({ messages: [], running: false })
    context.receiptTranscriptRevision = 1
    hook.rerender()
    await waitFor(() => expect(setTranscriptError).toHaveBeenLastCalledWith(null))
    expect(read).toHaveBeenLastCalledWith(address, { limit: 50, refresh: true })
    expect(read).toHaveBeenCalledTimes(2)
    return
  }
  await waitFor(() => expect(dispatchMessages).toHaveBeenCalledWith([{ type: 'reset', messages: [] }]))
  const cleared = (fn: ReturnType<typeof vi.fn>, empty: unknown) =>
    fn.mock.calls.some(call => JSON.stringify(call[0]) === JSON.stringify(empty))
  // The plan cache sync on mount sets the (empty) cached plan once; only a
  // conversation switch adds the transcript-load clear.
  const planClears = setTaskPlan.mock.calls.filter(call => call[0] === null).length
  expect(planClears).toBe(displayed ? 1 : 2)
  expect(cleared(setSubagentStatuses, [])).toBe(!displayed)
})
