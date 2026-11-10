import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

const payload = { requestId: 41, itemId: 'question-41' }

function setup(cancel: () => Promise<boolean>) {
  let answered = new Set<string>()
  const context = {
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task-a', threadId: 'thread-a' },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(), editLastUserMessage: vi.fn(),
    cancelRuntimePaneTask: vi.fn(cancel), setError: vi.fn(),
    requestUserInputAliasTrackerRef: { current: createRequestUserInputAliasTracker() },
    updateAnsweredRequestUserInputIds: vi.fn((update: (value: Set<string>) => Set<string>) => {
      answered = update(answered)
    }),
    messagesRef: { current: [{ id: 'assistant-a', role: 'assistant', status: 'streaming', turnId: 'turn-a' }] },
    dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
  }
  const hook = renderHook(({ taskId }) => usePaneInteractions({
    ...context, currentRuntimeTask: { ...context.currentRuntimeTask, taskId },
  } as unknown as Parameters<typeof usePaneInteractions>[0]), { initialProps: { taskId: 'task-a' } })
  return { ...hook, context, answered: () => answered }
}

it.each([false, true])('rejects an old ignore callback before cancellation, revisited=%s', async revisit => {
  const f = setup(async () => true)
  const ignore = f.result.current.ignoreRequestUserInput
  f.rerender({ taskId: 'task-b' })
  if (revisit) f.rerender({ taskId: 'task-a' })
  await act(async () => { await ignore(payload) })
  expect(f.context.cancelRuntimePaneTask).not.toHaveBeenCalled()
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
})

it.each([false, true])('discards a delayed cancellation projection after switching tasks, revisited=%s', async revisit => {
  let resolve!: (cancelled: boolean) => void
  const f = setup(() => new Promise<boolean>(done => { resolve = done }))
  let pending!: Promise<unknown>
  act(() => { pending = f.result.current.ignoreRequestUserInput(payload) })
  f.rerender({ taskId: 'task-b' })
  if (revisit) f.rerender({ taskId: 'task-a' })
  await act(async () => { resolve(true); await pending })
  expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledOnce()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
  expect(f.answered().size).toBe(0)
})

it('keeps the question visible while cancellation confirmation is pending', async () => {
  let resolve!: (cancelled: boolean) => void
  const f = setup(() => new Promise<boolean>(done => { resolve = done }))
  let pending!: Promise<unknown>
  act(() => { pending = f.result.current.ignoreRequestUserInput(payload) })
  expect(f.answered().size).toBe(0)
  await act(async () => { resolve(true); await pending })
  expect([...f.answered()]).toEqual(['request:41', 'item:question-41'])
})

it('forwards one cancellation for repeated ignore activations while its receipt is pending', async () => {
  let resolve!: (cancelled: boolean) => void
  const f = setup(() => new Promise<boolean>(done => { resolve = done }))
  let pending!: Promise<unknown>
  act(() => { pending = f.result.current.ignoreRequestUserInput(payload) })
  await act(async () => { await f.result.current.ignoreRequestUserInput(payload) })
  expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledOnce()
  await act(async () => { resolve(true); await pending })
  expect(f.context.dispatchMessages).toHaveBeenCalledOnce()
})

it.each(['false', 'throw'] as const)('releases the cancellation guard after %s for an explicit retry', async failure => {
  const f = setup(async () => true)
  if (failure === 'throw') f.context.cancelRuntimePaneTask.mockRejectedValueOnce(new Error('receipt lost'))
  else f.context.cancelRuntimePaneTask.mockResolvedValueOnce(false)
  await act(async () => {
    try { await f.result.current.ignoreRequestUserInput(payload) } catch { /* Retry is explicit below. */ }
  })
  expect(f.answered().size).toBe(0)
  await act(async () => { await f.result.current.ignoreRequestUserInput(payload) })
  expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledTimes(2)
  expect(f.context.dispatchMessages).toHaveBeenCalledOnce()
})

it('rejects an ignore callback from a closed pane', async () => {
  const f = setup(async () => true)
  const ignore = f.result.current.ignoreRequestUserInput
  f.unmount()
  await ignore(payload)
  expect(f.context.cancelRuntimePaneTask).not.toHaveBeenCalled()
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
})

it('discards a cancellation receipt after closing the pane', async () => {
  let resolve!: (cancelled: boolean) => void
  const f = setup(() => new Promise<boolean>(done => { resolve = done }))
  let pending!: Promise<unknown>
  act(() => { pending = f.result.current.ignoreRequestUserInput(payload) })
  f.unmount()
  await act(async () => { resolve(true); await pending })
  expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledOnce()
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
})

it.each(['false', 'throw'] as const)('keeps a question visible when cancellation returns %s', async failure => {
  const f = setup(async () => {
    if (failure === 'throw') throw new Error('cancellation receipt unavailable')
    return false
  })
  await act(async () => {
    if (failure === 'throw')
      await expect(f.result.current.ignoreRequestUserInput(payload)).rejects.toThrow('receipt unavailable')
    else await f.result.current.ignoreRequestUserInput(payload)
  })
  expect(f.answered().size).toBe(0)
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
})

it('settles only the original question and message after confirmed cancellation', async () => {
  const f = setup(async () => true)
  await act(async () => { await f.result.current.ignoreRequestUserInput(payload) })
  expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledExactlyOnceWith(f.context.currentRuntimeTask)
  expect([...f.answered()]).toEqual(['request:41', 'item:question-41'])
  expect(f.context.dispatchMessages).toHaveBeenCalledExactlyOnceWith({
    type: 'assistant_cancelled', messageId: 'assistant-a', subtaskId: 'turn-a',
  })
})
