import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { RuntimeTaskAddress } from '@/types/api'
import { usePaneSubscription } from './usePaneSubscription'
import type { usePaneRestore } from './usePaneRestore'

const address: RuntimeTaskAddress = { deviceId: 'goal-owned-target', taskId: 'goal-owned-task', runtimeHandle: { threadId: 'goal-owned-thread' } }
function fixture() {
  let fail!: (error: Error) => void
  const pending = new Promise<{ accepted: boolean; goal: null }>((_resolve, reject) => { fail = reject })
  const reader = vi.fn(() => pending)
  const goalReader = { current: reader }
  const commit = vi.fn(), report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let settled!: () => void
  const context = {
    runtimeTaskLoadTargetRef: { current: { identityKey: 'goal-owned-target:goal-owned-task', key: 'goal-owned-target:goal-owned-task', address } },
    subscribeRuntimeTaskStreamRef: { current: vi.fn((_address: unknown, handlers: { onAssistantSettled: () => void }) => { settled = handlers.onAssistantSettled; return vi.fn() }) },
    getRuntimeGoalRef: goalReader, goalRevisionRef: { current: 0 },
    setSubagentStatuses: vi.fn(), commitThreadGoal: commit,
    lifecycleStore: { goalStatusReceived: vi.fn() },
    refreshWorkListsRef: { current: vi.fn().mockResolvedValue(undefined) },
    setPendingGoalState: vi.fn(),
  } as unknown as ReturnType<typeof usePaneRestore>
  const hook = renderHook(() => usePaneSubscription(context))
  act(() => settled())
  expect(reader).toHaveBeenCalledExactlyOnceWith(address)
  return { ...hook, fail, commit, report, goalReader, context }
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
