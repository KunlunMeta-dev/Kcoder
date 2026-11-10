import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
  requestUserInputPayloadKeys,
} from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

it.each([true, false])('settles refreshed aliases only after confirmed cancellation (%s)', async cancelled => {
  const payload = { kind: 'request_user_input', requestId: 41, itemId: 'live-item',
    questions: [{ id: 'choice', question: 'Continue?', options: [] }] }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [payload])
  let finish!: (value: boolean) => void
  let answered = new Set<string>()
  const context = {
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task', threadId: 'thread' },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(), editLastUserMessage: vi.fn(), setError: vi.fn(),
    cancelRuntimePaneTask: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })),
    requestUserInputAliasTrackerRef: { current: tracker },
    updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { answered = update(answered) },
    messagesRef: { current: [] }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
  }
  const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
  let pending!: Promise<unknown>
  act(() => { pending = hook.result.current.ignoreRequestUserInput(payload) })
  const restored = { ...payload, requestId: undefined, itemId: 'restored-item' }
  const other = { ...payload, requestId: 99, itemId: 'other-item',
    questions: [{ id: 'choice', question: 'Which other task?', options: [] }] }
  // Refresh discovers the same original question and an unrelated question
  // while the original cancellation receipt is still pending.
  observeRequestUserInputAliases(tracker, [restored, payload, other])
  expect(tracker.aliasesByKey.get('request:41')).toContain('item:restored-item')
  expect(answered.size).toBe(0)
  // Caller projections are mutable; the cancellation must retain its identity.
  payload.requestId = 99
  payload.itemId = 'other-item'
  await act(async () => { finish(cancelled); await pending })
  expect(requestUserInputPayloadKeys(restored).some(key => answered.has(key))).toBe(cancelled)
  expect(requestUserInputPayloadKeys(other).some(key => answered.has(key))).toBe(false)
  expect(context.cancelRuntimePaneTask).toHaveBeenCalledOnce()
  expect(context.sendRuntimePaneMessage).not.toHaveBeenCalled()
  hook.unmount()
})
