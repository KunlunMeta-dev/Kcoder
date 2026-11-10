import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { RequestUserInputResponse } from '@/types/api'
import {
  createRequestUserInputAliasTracker,
  observeRequestUserInputAliases,
} from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

function fixture() {
  const payload = { kind: 'request_user_input', requestId: 41, itemId: 'live-item',
    questions: [{ id: 'choice', question: 'Continue?', options: [] }] }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [payload])
  let finish!: (sent: boolean) => void
  let answered = new Set<string>()
  const context = {
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task', threadId: 'thread' },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })),
    editLastUserMessage: vi.fn(), cancelRuntimePaneTask: vi.fn(), setError: vi.fn(),
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
  }))
  expect(f.context.applyLocalRequestUserInputResponse).toHaveBeenCalledExactlyOnceWith(original)
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
