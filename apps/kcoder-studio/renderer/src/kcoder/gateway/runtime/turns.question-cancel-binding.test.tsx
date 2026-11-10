import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { usePaneInteractions } from '@/components/layout/pane/usePaneInteractions'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import type { GatewayRuntimeCore } from './core'
import { cancelTask } from './turns'

function fixture(nested = false) {
  const address = { deviceId: 'target', taskId: 'task', threadId: 'original-thread', workspacePath: '/original' }
  const task = { taskId: address.taskId, serverId: address.deviceId,
    threadId: address.threadId, workspacePath: address.workspacePath }
  const client = { request: vi.fn(async () => ({ interrupted: true })) }
  const runtime = {
    disposed: false, resolveTaskId: (id: string) => id,
    tasks: new Map([[task.taskId, task]]), threadByTask: new Map([[task.taskId, task.threadId]]),
    clientByTask: new Map([[task.taskId, client]]),
    activeTurnByTask: new Map([[task.taskId, { turnId: 'original-turn' }]]),
    appServerDisconnectedClients: new WeakSet(),
  }
  const tracker = createRequestUserInputAliasTracker()
  const payload = { requestId: 41, itemId: 'original-question' }
  tracker.previousPayloads = [payload]
  const context = {
    currentRuntimeTask: address, projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(), editLastUserMessage: vi.fn(),
    cancelRuntimePaneTask: vi.fn(async (value: typeof address) =>
      (await cancelTask.call(runtime as unknown as GatewayRuntimeCore, nested ? { address: value } : value)).accepted),
    setError: vi.fn(), requestUserInputAliasTrackerRef: { current: tracker },
    updateAnsweredRequestUserInputIds: vi.fn(), messagesRef: { current: [
      { id: 'original-message', role: 'assistant', status: 'streaming', turnId: 'original-turn' },
    ] },
    dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
  }
  const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
  return { address, task, client, runtime, context, payload, hook }
}

const changes = ['threadId', 'serverId', 'workspacePath', 'rpc-thread', 'missing-task', 'disconnected', 'disposed'] as const
it.each([false, true].flatMap(nested => changes.map(change => ({ nested, change }))))(
  'ignoring a retained question cannot interrupt a replacement task after $change changes (nested=$nested)', async ({ nested, change }) => {
    const f = fixture(nested)
    if (change === 'rpc-thread') f.runtime.threadByTask.set(f.task.taskId, 'replacement-thread')
    else if (change === 'missing-task') f.runtime.tasks.delete(f.task.taskId)
    else if (change === 'disconnected') f.runtime.appServerDisconnectedClients.add(f.client)
    else if (change === 'disposed') f.runtime.disposed = true
    else {
      f.task[change] = 'replacement'
      if (change === 'threadId') f.runtime.threadByTask.set(f.task.taskId, f.task.threadId)
    }
    f.runtime.activeTurnByTask.set(f.task.taskId, { turnId: 'replacement-turn' })
    await act(async () => { await f.hook.result.current.ignoreRequestUserInput(f.payload) })
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
    expect(f.context.dispatchMessages).not.toHaveBeenCalled()
    expect(f.runtime.activeTurnByTask.get(f.task.taskId)?.turnId).toBe('replacement-turn')
  }
)

it.each([false, true])('ignoring the original question still interrupts its exact active turn (nested=%s)', async nested => {
  const f = fixture(nested)
  // Equivalent workspace spelling must not invalidate the original address.
  f.task.workspacePath += '/'
  await act(async () => { await f.hook.result.current.ignoreRequestUserInput(f.payload) })
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('turn/interrupt', {
    threadId: 'original-thread', turnId: 'original-turn',
  })
  expect(f.context.updateAnsweredRequestUserInputIds).toHaveBeenCalledOnce()
  expect(f.context.dispatchMessages).toHaveBeenCalledExactlyOnceWith({
    type: 'assistant_cancelled', messageId: 'original-message', subtaskId: 'original-turn',
  })
})

it.each([false, true])('an old question cannot interrupt a newer turn in the same task (nested=%s)', async nested => {
  const f = fixture(nested)
  f.runtime.activeTurnByTask.set(f.task.taskId, { turnId: 'next-turn' })
  f.context.messagesRef.current.push({
    id: 'next-message', role: 'assistant', status: 'streaming', turnId: 'next-turn',
  })
  await act(async () => {
    await f.hook.result.current.ignoreRequestUserInput({
      ...f.payload, threadId: f.address.threadId, turnId: 'original-turn',
    })
  })
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
  expect(f.runtime.activeTurnByTask.get(f.task.taskId)?.turnId).toBe('next-turn')
})

it.each([false, true])('a question interrupt carries its original turn to the runtime (nested=%s)', async nested => {
  const f = fixture(nested)
  await act(async () => {
    await f.hook.result.current.ignoreRequestUserInput({
      ...f.payload, threadId: f.address.threadId, turnId: 'original-turn',
    })
  })
  expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledExactlyOnceWith({
    ...f.address, expectedTurnId: 'original-turn',
  })
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('turn/interrupt', {
    threadId: 'original-thread', turnId: 'original-turn',
  })
})

it.each([false, true])('question cancellation only settles messages from its original turn (nested=%s)', async nested => {
  const f = fixture(nested)
  f.context.messagesRef.current.push({
    id: 'other-message', role: 'assistant', status: 'streaming', turnId: 'other-turn',
  })
  await act(async () => {
    await f.hook.result.current.ignoreRequestUserInput({
      ...f.payload, threadId: f.address.threadId, turnId: 'original-turn',
    })
  })
  expect(f.context.dispatchMessages).toHaveBeenCalledExactlyOnceWith({
    type: 'assistant_cancelled', messageId: 'original-message', subtaskId: 'original-turn',
  })
})

it.each([false, true])('a retained question from another thread cannot stop the displayed task (nested=%s)', async nested => {
  const f = fixture(nested)
  await act(async () => {
    await f.hook.result.current.ignoreRequestUserInput({
      ...f.payload, threadId: 'previous-thread', turnId: 'original-turn',
    })
  })
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
})

it.each([null, '', ' ', 7])('an invalid explicit turn fence %s cannot become an unscoped stop', async expectedTurnId => {
  const f = fixture()
  await expect(cancelTask.call(f.runtime as unknown as GatewayRuntimeCore, {
    ...f.address, expectedTurnId,
  })).resolves.toMatchObject({ accepted: false, interrupted: false })
  expect(f.client.request).not.toHaveBeenCalled()
})

it('keeps the question turn across asynchronous local transport preparation', async () => {
  const f = fixture()
  let resolveDevice!: (value: string) => void
  const device = new Promise<string>(resolve => { resolveDevice = resolve })
  const api = createRuntimeWorkApiFromIpc(async <T,>(method: string, params?: Record<string, unknown>) => {
    expect(method).toBe('runtime.tasks.cancel')
    return await cancelTask.call(f.runtime as unknown as GatewayRuntimeCore, params!) as T
  }, () => device)
  f.context.cancelRuntimePaneTask.mockImplementation(async request => (await api.cancelRuntimeTask(request)).accepted)
  let pending!: Promise<unknown>
  act(() => {
    pending = f.hook.result.current.ignoreRequestUserInput({
      ...f.payload, threadId: f.address.threadId, turnId: 'original-turn',
    })
  })
  // The original turn ends while local device normalization is still awaited.
  f.runtime.activeTurnByTask.set(f.task.taskId, { turnId: 'next-turn' })
  await act(async () => { resolveDevice(f.address.deviceId); await pending })
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.context.dispatchMessages).not.toHaveBeenCalled()
  expect(f.context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
})
