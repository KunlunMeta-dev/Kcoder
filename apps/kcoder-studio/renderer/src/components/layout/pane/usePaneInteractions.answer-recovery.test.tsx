import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { RequestUserInputResponse, RuntimeTaskAddress } from '@/types/api'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
} from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

function fixture(binding: Partial<RequestUserInputPayload> = {}) {
  const payload = { kind: 'request_user_input', requestId: 41, itemId: 'live-item',
    questions: [{ id: 'choice', question: 'Continue?', options: [] }], ...binding }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [payload])
  let finish!: (sent: boolean) => void
  const receipt = new Promise<boolean>(resolve => { finish = resolve })
  let answered = new Set<string>()
  const context = {
    currentRuntimeTask: { deviceId: 'target', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
      runtimeHandle: { threadId: 'thread', memoryTaskSnapshot: { sequence: 1 } } } as RuntimeTaskAddress,
    accountScopeInvalidatedRef: { current: false },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn<(request: unknown, options: { onError(message: string): void }) => Promise<boolean>>(() => receipt),
    editLastUserMessage: vi.fn(),
    cancelRuntimePaneTask: vi.fn<(request: unknown, options: { onError(message: string): void }) => Promise<boolean>>(() => receipt), setError: vi.fn(),
    requestUserInputAliasTrackerRef: { current: tracker },
    updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { answered = update(answered) },
    messagesRef: { current: [] }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
  }
  const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
  return { ...hook, context, tracker, payload, answered: () => answered,
    finish: (sent: boolean) => finish(sent) }
}

it('settles only the dispatched answer when the caller edits its response before acceptance', async () => {
  const f = fixture()
  const response: RequestUserInputResponse = {
    requestId: 41, itemId: 'live-item', answers: { choice: { answers: ['Original answer'] } },
    sourceAgent: { parentSessionId: 'parent', agentId: 'child',
      backgroundRun: { parentSessionId: 'parent', agentId: 'child', runId: 'run-original' } },
  }
  const original = structuredClone(response)
  let pending!: Promise<boolean>
  act(() => { pending = f.result.current.sendRequestUserInputResponse(response) })
  response.requestId = 99
  response.itemId = 'another-item'
  response.answers.choice.answers[0] = 'Later draft'
  response.sourceAgent!.backgroundRun!.runId = 'another-run'
  await act(async () => { f.finish(true); await pending })
  expect(f.context.sendRuntimePaneMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: 'Original answer', requestUserInputResponse: original,
  }), { onError: expect.any(Function) })
  expect(f.context.applyLocalRequestUserInputResponse).toHaveBeenCalledExactlyOnceWith(original)
})

for (const operation of ['answer', 'ignore', 'child-ignore'] as const) {
  it.each([true, false])(`${operation}: same-task enrichment retains the original receipt owner (%s)`, async accepted => {
    const f = fixture({ threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
      ...(operation === 'child-ignore' ? { sourceAgent: { parentSessionId: 'thread', agentId: 'child' } } : {}) })
    const originalAddress = f.context.currentRuntimeTask
    const response = { ...f.payload, answers: { choice: { answers: ['Original answer'] } } }
    const native = operation === 'ignore' ? f.context.cancelRuntimePaneTask : f.context.sendRuntimePaneMessage
    let pending!: Promise<unknown>
    try {
      act(() => { pending = operation === 'answer' ? f.result.current.sendRequestUserInputResponse(response)
        : f.result.current.ignoreRequestUserInput(f.payload) })
      f.context.currentRuntimeTask = { ...originalAddress,
        runtimeHandle: { threadId: 'thread', memoryTaskSnapshot: { sequence: 2 }, expertBinding: { revision: 2 } } }
      f.rerender()
      if (!accepted) native.mock.calls[0]![1].onError('Original receipt was not accepted')
      await act(async () => { f.finish(accepted); await pending })
      expect(native).toHaveBeenCalledOnce()
      expect(native.mock.calls[0]![0]).toMatchObject(operation === 'ignore'
        ? { runtimeHandle: originalAddress.runtimeHandle }
        : { address: originalAddress })
      expect(f.answered().size > 0).toBe(accepted)
      expect(f.context.applyLocalRequestUserInputResponse).toHaveBeenCalledTimes(accepted && operation !== 'ignore' ? 1 : 0)
      expect(f.context.setError).toHaveBeenCalledTimes(accepted ? 0 : 1)
    } finally { f.finish(false); f.unmount() }
  })

  it(`${operation}: invalidated account rejects old callbacks and late receipts`, async () => {
    const f = fixture({ threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
      ...(operation === 'child-ignore' ? { sourceAgent: { parentSessionId: 'thread', agentId: 'child' } } : {}) })
    const response = { ...f.payload, answers: { choice: { answers: ['Original answer'] } } }
    const invoke = () => operation === 'answer' ? f.result.current.sendRequestUserInputResponse(response)
      : f.result.current.ignoreRequestUserInput(f.payload)
    let pending!: Promise<unknown>
    try {
      act(() => { pending = invoke() })
      f.context.accountScopeInvalidatedRef.current = true
      const native = operation === 'ignore' ? f.context.cancelRuntimePaneTask : f.context.sendRuntimePaneMessage
      native.mock.calls[0]![1].onError('Old account failure')
      await act(async () => { f.finish(true); await pending; await invoke() })
      expect(native).toHaveBeenCalledOnce()
      expect(f.context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
      expect(f.answered().size).toBe(0)
      expect(f.context.setError).not.toHaveBeenCalled()
    } finally { f.finish(false); f.unmount() }
  })
}

it('same-task metadata cannot reopen the pending ignore cancellation gate', async () => {
  const f = fixture()
  let pending!: Promise<unknown>
  try {
    act(() => { pending = f.result.current.ignoreRequestUserInput(f.payload) })
    f.context.currentRuntimeTask = { ...f.context.currentRuntimeTask, runtimeHandle: { threadId: 'thread', memoryTaskSnapshot: { sequence: 2 } } }
    f.rerender()
    act(() => { void f.result.current.ignoreRequestUserInput(f.payload) })
    expect(f.context.cancelRuntimePaneTask).toHaveBeenCalledOnce()
    await act(async () => { f.finish(true); await pending })
  } finally { f.finish(false); f.unmount() }
})

it.each([
  { deviceId: 'other-target' }, { taskId: 'other-task' }, { workspacePath: '/other' }, { threadId: 'other-thread' },
  { threadId: undefined, runtimeHandle: { threadId: 'other-thread' } },
  { expectedSessionAddress: { targetId: 'native', workspaceId: 'workspace', threadId: 'thread' } },
])('an actual original-task constraint still retires a pending answer: %j', async constraint => {
  const f = fixture()
  let pending!: Promise<unknown>
  try {
    act(() => { pending = f.result.current.sendRequestUserInputResponse({ requestId: 41, itemId: 'live-item', answers: {} }) })
    f.context.currentRuntimeTask = { ...f.context.currentRuntimeTask, ...constraint }
    f.rerender()
    await act(async () => { f.finish(true); await pending })
    expect(f.context.sendRuntimePaneMessage).toHaveBeenCalledOnce()
    expect(f.context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
    expect(f.answered().size).toBe(0)
  } finally { f.finish(false); f.unmount() }
})

it.each([true, false])('reconciles aliases discovered during an answer wait only on acceptance (%s)', async sent => {
  const f = fixture()
  let pending!: Promise<boolean>
  act(() => { pending = f.result.current.sendRequestUserInputResponse({
    requestId: 41, itemId: 'live-item', answers: { choice: { answers: ['Original answer'] } },
  }) })
  // A refresh restores the historical card while its live answer is in flight.
  observeRequestUserInputAliases(f.tracker, [
    { ...f.payload, requestId: undefined, itemId: 'restored-item' }, f.payload,
  ])
  expect(f.tracker.aliasesByKey.get('request:41')).toContain('item:restored-item')
  await act(async () => { f.finish(sent); await pending })
  expect([...f.answered()]).toEqual(sent
    ? ['request:41', 'item:live-item', 'item:restored-item'] : [])
  expect(f.context.sendRuntimePaneMessage).toHaveBeenCalledOnce()
  expect(f.context.cancelRuntimePaneTask).not.toHaveBeenCalled()
})
