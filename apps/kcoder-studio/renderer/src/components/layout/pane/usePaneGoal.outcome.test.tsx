import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { usePaneComposer } from './usePaneComposer'
import { usePaneGoal } from './usePaneGoal'

function setup() {
  let draft = 'original objective'
  let error: string | null = null
  const goal = { objective: draft, status: 'active', mode: 'standard' }
  const context = {
    input: draft,
    goal,
    goalDraftActive: true,
    goalDraftMode: 'standard',
    codeCommentContexts: [],
    queuedMessages: [],
    paneStatus: { isBusy: false },
    currentRuntimeTask: { deviceId: 'goal-target', taskId: 'goal-task', threadId: 'goal-thread' },
    runtimeTaskLoadTargetRef: { current: { identityKey: 'original-owner' } },
    projectChat: {
      attachments: [],
      resetAttachments: vi.fn(),
      restoreInput: vi.fn((value: string) => { if (!draft.trim()) draft = value }),
    },
    setInput: vi.fn((value: string) => { draft = value; error = null }),
    scopedSetInput: vi.fn((value: string) => { draft = value }),
    setError: vi.fn((value: string | null) => { error = value }),
    canSendWithSelectedModel: () => true,
    getRuntimeModelFields: () => ({}),
    setRuntimeGoal: vi.fn(async () => ({ accepted: true, goal })),
    clearRuntimeGoal: vi.fn(async () => ({ accepted: true })),
    refreshWorkLists: vi.fn(async () => undefined),
    sendRuntimeMessage: vi.fn(async () => true),
    commitThreadGoal: vi.fn(),
    lifecycleStore: { goalStatusReceived: vi.fn() },
    setGoalDraftActive: vi.fn(),
    setCodeCommentContexts: vi.fn(),
    setPendingGoalState: vi.fn(),
    setGoalContinuation: vi.fn(),
    goalRevisionRef: { current: 0 },
  }
  const composer = renderHook(() => usePaneComposer(context as unknown as Parameters<typeof usePaneComposer>[0]))
  const controls = renderHook(() => usePaneGoal(context as unknown as Parameters<typeof usePaneGoal>[0]))
  return { context, composer, controls, draft: () => draft, error: () => error }
}
afterEach(() => vi.restoreAllMocks())

test('a rejected goal RPC restores the draft and exposes its local error without sending a turn', async () => {
  const f = setup()
  f.context.setRuntimeGoal.mockRejectedValue(new Error('goal transport lost'))
  await act(async () => { await f.composer.result.current.send() })
  expect(f.draft()).toBe('original objective')
  expect(f.error()).toBe('goal transport lost')
  expect(f.context.sendRuntimeMessage).not.toHaveBeenCalled()
  expect(f.context.commitThreadGoal).not.toHaveBeenCalled()
})

test('goal acceptance survives a failed send and restoring the draft does not clear its error', async () => {
  const f = setup()
  f.context.sendRuntimeMessage.mockResolvedValue(false)
  await act(async () => { await f.composer.result.current.send() })
  expect(f.context.commitThreadGoal).toHaveBeenCalledWith(f.context.goal)
  expect(f.draft()).toBe('original objective')
  expect(f.error()).toBeTruthy()
})

test('an explicit goal rejection preserves the draft and leaves no optimistic goal', async () => {
  const f = setup()
  f.context.setRuntimeGoal.mockResolvedValue({ accepted: false, error: 'goal refused' } as never)
  await act(async () => { await f.composer.result.current.send() })
  expect(f.draft()).toBe('original objective')
  expect(f.error()).toBe('goal refused')
  expect(f.context.commitThreadGoal).not.toHaveBeenCalled()
  expect(f.context.sendRuntimeMessage).not.toHaveBeenCalled()
})

test('a goal failure cannot overwrite text edited while its RPC is pending', async () => {
  const f = setup()
  let reject!: (error: Error) => void
  f.context.setRuntimeGoal.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const sending = f.composer.result.current.send()
  f.context.setInput('new draft')
  await act(async () => { reject(new Error('not saved')); await sending })
  expect(f.draft()).toBe('new draft')
  expect(f.error()).toBe('not saved')
})

test('a settled goal submission cannot send or update a different pane owner', async () => {
  const f = setup()
  let accept!: (response: { accepted: boolean; goal: typeof f.context.goal }) => void
  f.context.setRuntimeGoal.mockImplementation(() => new Promise(resolve => { accept = resolve }))
  const sending = f.composer.result.current.send()
  f.context.runtimeTaskLoadTargetRef.current = { identityKey: 'next-owner' }
  await act(async () => { accept({ accepted: true, goal: f.context.goal }); await sending })
  expect(f.context.commitThreadGoal).not.toHaveBeenCalled()
  expect(f.context.sendRuntimeMessage).not.toHaveBeenCalled()
  expect(f.error()).toBeNull()
  expect(f.draft()).toBe('original objective')
})

test('a refused pause exposes its error in the pane and returns false', async () => {
  const f = setup()
  f.context.setRuntimeGoal.mockResolvedValue({ accepted: false, goal: f.context.goal, error: 'pause refused' } as never)
  await expect(f.controls.result.current.pauseCurrentGoal()).resolves.toBe(false)
  expect(f.error()).toBe('pause refused')
})

test('accepted resume and clear are not undone by an index refresh failure', async () => {
  const f = setup()
  f.context.refreshWorkLists.mockRejectedValue(new Error('index unavailable'))
  await expect(f.controls.result.current.resumeCurrentGoal()).resolves.toBe(true)
  await expect(f.controls.result.current.clearCurrentGoal()).resolves.toBe(true)
  expect(f.context.commitThreadGoal.mock.calls).toEqual([[f.context.goal], [null]])
  expect(f.error()).toBeNull()
})

test('a goal status exception is local to its original owner', async () => {
  const f = setup()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let reject!: (error: Error) => void
  f.context.setRuntimeGoal.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const pause = f.controls.result.current.pauseCurrentGoal()
  f.context.runtimeTaskLoadTargetRef.current = { identityKey: 'next-owner' }
  reject(new Error('old owner failure'))
  await expect(pause).resolves.toBe(false)
  expect(f.error()).toBeNull()
})
