import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { subscribeRuntimeWorkChanged } from '@/kcoder/runtimeWorkEvents'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { usePaneSubscription } from './usePaneSubscription'
import type { usePaneRestore } from './usePaneRestore'

const address: RuntimeTaskAddress = { deviceId: 'goal-owned-target', taskId: 'goal-owned-task', runtimeHandle: { threadId: 'goal-owned-thread' } }
function fixture(refreshOn: 'settled' | 'stream-gap' = 'settled',
  lifecycleStore: Pick<RuntimeTaskLifecycleStore, 'goalStatusReceived'> = { goalStatusReceived: vi.fn() }) {
  let fail!: (error: Error) => void
  let resolve!: (value: { accepted: boolean; goal: RuntimeGoal | null }) => void
  const pending = new Promise<{ accepted: boolean; goal: RuntimeGoal | null }>((onResolve, reject) => { resolve = onResolve; fail = reject })
  const reader = vi.fn(() => pending)
  const goalReader = { current: reader }
  const goalRevision = { current: 0 }
  const commit = vi.fn(() => { goalRevision.current += 1 }), report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let settled!: () => void, streamGap!: () => void
  const context = {
    runtimeTaskLoadTargetRef: { current: { identityKey: 'goal-owned-target:goal-owned-task', key: 'goal-owned-target:goal-owned-task', address } },
    subscribeRuntimeTaskStreamRef: { current: vi.fn((_address: unknown, handlers: { onAssistantSettled: () => void; onStreamGap: () => void }) => { settled = handlers.onAssistantSettled; streamGap = handlers.onStreamGap; return vi.fn() }) },
    getRuntimeGoalRef: goalReader, goalRevisionRef: goalRevision,
    setSubagentStatuses: vi.fn(), commitThreadGoal: commit, setGoalContinuation: vi.fn(),
    lifecycleStore,
    refreshWorkListsRef: { current: vi.fn().mockResolvedValue(undefined) },
    setPendingGoalState: vi.fn(),
    setQueuedMessages: vi.fn(),
    transcriptGapGenerationRef: { current: 0 },
    forceAuthoritativeTranscriptRef: { current: false },
    rebuildingTranscriptRef: { current: false },
    showLiveDuringTranscriptLoadRef: { current: false },
    rebuildingTranscriptIdentityRef: { current: null },
    bufferedTranscriptActionsRef: { current: [] },
    loadedRuntimeTranscriptKeyRef: { current: null },
    setReceiptTranscriptRevision: vi.fn(),
  } as unknown as ReturnType<typeof usePaneRestore>
  const hook = renderHook(() => usePaneSubscription(context))
  if (refreshOn === 'settled') act(() => settled())
  if (refreshOn === 'settled') expect(reader).toHaveBeenCalledExactlyOnceWith(address)
  return { ...hook, resolve, fail, settled, streamGap, commit, report, goalReader, goalRevision, context }
}
afterEach(() => vi.restoreAllMocks())

test('same task identity cannot keep a retired goal reader alive after its executor is replaced', async () => {
  const f = fixture()
  f.goalReader.current = vi.fn(async () => ({ accepted: false, goal: null }))
  await act(async () => { f.fail(new Error('original runtime scope retired')); await Promise.resolve() })
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  f.unmount()
})

test('same task reopened after account invalidation cannot report its original pending Goal read', async () => {
  const f = fixture()
  act(() => notifyAccountContextChange(address.deviceId))
  // The original target/revision remains identical, reproducing an ABA reopen.
  expect(f.context.runtimeTaskLoadTargetRef.current?.identityKey).toBe('goal-owned-target:goal-owned-task')
  await act(async () => { f.fail(new Error('original account scope retired')); await Promise.resolve() })
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  f.unmount()
})

test('a genuine Goal read failure for the current owner remains visible', async () => {
  const f = fixture(), error = new Error('current owner storage failure')
  await act(async () => { f.fail(error); await Promise.resolve() })
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.report).toHaveBeenCalledWith('[KCoder Studio] Runtime goal refresh failed', expect.objectContaining({ error }))
  f.unmount()
})

test('a stream gap rereads the authoritative Goal and accepts an explicit clear', async () => {
  const f = fixture('stream-gap')
  f.goalReader.current = vi.fn(async () => ({ accepted: true, goal: null }))

  act(() => f.streamGap())
  await act(async () => { await Promise.resolve() })

  expect(f.goalReader.current).toHaveBeenCalledExactlyOnceWith(address)
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(null)
  f.unmount()
})

test('a stream gap applies a completed Goal returned by the authoritative read', async () => {
  const f = fixture('stream-gap')
  const completedGoal = { status: 'complete' } as RuntimeGoal
  f.goalReader.current = vi.fn(async () => ({ accepted: true, goal: completedGoal }))

  act(() => f.streamGap())
  await act(async () => { await Promise.resolve() })

  expect(f.commit).toHaveBeenCalledExactlyOnceWith(completedGoal)
  expect(f.context.lifecycleStore.goalStatusReceived).toHaveBeenCalledExactlyOnceWith(address, 'complete')
  f.unmount()
})

test('an unaccepted stream-gap Goal read preserves the current goal and reports failure', async () => {
  const f = fixture('stream-gap')
  f.goalReader.current = vi.fn(async () => ({ accepted: false, goal: null, error: 'target is unavailable' }))

  act(() => f.streamGap())
  await act(async () => { await Promise.resolve() })

  expect(f.commit).not.toHaveBeenCalled()
  expect(f.context.lifecycleStore.goalStatusReceived).not.toHaveBeenCalled()
  expect(f.report).toHaveBeenCalledWith('[KCoder Studio] Runtime goal refresh failed', expect.objectContaining({
    error: new Error('target is unavailable'),
  }))
  f.unmount()
})

test('a delayed stream-gap Goal read cannot clear a different pane target', async () => {
  const f = fixture('stream-gap')
  const reader = vi.fn(() => new Promise<{ accepted: boolean; goal: RuntimeGoal | null }>(resolve => {
    f.resolve = resolve
  }))
  f.goalReader.current = reader

  act(() => f.streamGap())
  expect(reader).toHaveBeenCalledExactlyOnceWith(address)
  f.context.runtimeTaskLoadTargetRef.current = {
    identityKey: 'other-target:other-task',
    key: 'other-target:other-task',
    address: { deviceId: 'other-target', taskId: 'other-task', runtimeHandle: { threadId: 'other-thread' } },
  }
  await act(async () => {
    f.resolve({ accepted: true, goal: null })
    await Promise.resolve()
  })

  expect(f.commit).not.toHaveBeenCalled()
  f.unmount()
})

test('the latest Goal read wins when stream-gap and turn-settled refreshes overlap', async () => {
  const f = fixture('stream-gap')
  const staleGoal = { status: 'active' } as RuntimeGoal
  const latestGoal = { status: 'complete' } as RuntimeGoal
  let resolveStale!: (value: { accepted: boolean; goal: RuntimeGoal | null }) => void
  let resolveLatest!: (value: { accepted: boolean; goal: RuntimeGoal | null }) => void
  const reader = vi.fn()
    .mockImplementationOnce(() => new Promise<{ accepted: boolean; goal: RuntimeGoal | null }>(resolve => { resolveStale = resolve }))
    .mockImplementationOnce(() => new Promise<{ accepted: boolean; goal: RuntimeGoal | null }>(resolve => { resolveLatest = resolve }))
  f.goalReader.current = reader

  act(() => f.streamGap())
  act(() => f.settled())
  await act(async () => {
    resolveStale({ accepted: true, goal: staleGoal })
    await Promise.resolve()
  })
  expect(f.commit).not.toHaveBeenCalled()

  await act(async () => {
    resolveLatest({ accepted: true, goal: latestGoal })
    await Promise.resolve()
  })
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(latestGoal)
  f.unmount()
})


test('stream list invalidations use the shared scheduler instead of a full device refresh', () => {
  const f = fixture('stream-gap')
  const invalidated = vi.fn()
  const stop = subscribeRuntimeWorkChanged(invalidated)
  try {
    const handlers = vi.mocked(f.context.subscribeRuntimeTaskStreamRef.current).mock.calls[0]![1]
    act(() => { for (let i = 0; i < 100; i++) handlers.onRefreshWorkLists?.() })
    expect(invalidated).toHaveBeenCalledTimes(100)
    expect(f.context.refreshWorkListsRef.current).not.toHaveBeenCalled()
  } finally { stop(); f.unmount() }
})

test('Goal usage updates reach the pane without republishing unchanged global lifecycle or directory state', () => {
  const lifecycle = new RuntimeTaskLifecycleStore('pane-goal-status-publication')
  const f = fixture('stream-gap', lifecycle)
  const invalidated = vi.fn(), published = vi.fn()
  const stop = subscribeRuntimeWorkChanged(invalidated)
  const handlers = vi.mocked(f.context.subscribeRuntimeTaskStreamRef.current).mock.calls[0]![1]
  act(() => handlers.onRuntimeGoalUpdated?.({ goal: { status: 'active', tokensUsed: 0 } as RuntimeGoal }))
  const snapshot = lifecycle.getSnapshot()
  const stopLifecycle = lifecycle.subscribe(published)
  const reads = vi.spyOn(Storage.prototype, 'getItem')
  try {
    act(() => {
      for (let i = 1; i <= 100; i++)
        handlers.onRuntimeGoalUpdated?.({ goal: { status: 'active', tokensUsed: i } as RuntimeGoal })
    })
    expect(f.commit).toHaveBeenCalledTimes(101)
    expect(f.commit).toHaveBeenLastCalledWith({ status: 'active', tokensUsed: 100 })
    expect(lifecycle.getSnapshot()).toBe(snapshot)
    expect(published).not.toHaveBeenCalled()
    expect(reads).not.toHaveBeenCalled()
    act(() => handlers.onRuntimeGoalUpdated?.({ goal: { status: 'paused' } as RuntimeGoal }))
    expect(lifecycle.getTask(address)?.goalStatus).toBe('paused')
    act(() => handlers.onRuntimeGoalUpdated?.({ goal: { status: 'complete' } as RuntimeGoal }))
    expect(lifecycle.getTask(address)?.goalStatus).toBe('complete')
    act(() => handlers.onRuntimeGoalCleared?.({ goal: null }))
    expect(lifecycle.getTask(address)?.goalStatus).toBeNull()
    expect(published).toHaveBeenCalledTimes(3)
    expect(f.commit).toHaveBeenCalledTimes(104)
    expect(invalidated).not.toHaveBeenCalled()
  } finally { reads.mockRestore(); stopLifecycle(); stop(); f.unmount() }
})

test.each(['active', 'complete', null])('a stream gap reconciles the directory once even when its Goal read returns %s', async status => {
  const f = fixture('stream-gap')
  f.goalReader.current = vi.fn(async () => ({ accepted: true, goal: status ? { status } as RuntimeGoal : null }))
  const invalidated = vi.fn()
  const stop = subscribeRuntimeWorkChanged(invalidated)
  try {
    await act(async () => { f.streamGap(); await Promise.resolve() })
    expect(invalidated).toHaveBeenCalledOnce()
    expect(f.goalReader.current).toHaveBeenCalledExactlyOnceWith(address)
    expect(f.commit).toHaveBeenCalledOnce()
  } finally { stop(); f.unmount() }
})
