import '@/i18n'
import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { createRequestUserInputAliasTracker, isHiddenRequestUserInputBlock } from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

test.each(['threadId', 'turnId', 'appServerEpoch'] as const)(
  'a settled card cannot hide a reused request from another %s', async field => {
    const original: RequestUserInputPayload = { kind: 'request_user_input', requestId: 7, itemId: 'question-7',
      threadId: 'thread', turnId: 'turn', appServerEpoch: 'server',
      questions: [{ id: 'choice', question: 'Continue?', options: [] }] }
    const tracker = createRequestUserInputAliasTracker()
    tracker.previousPayloads = [original]
    let hidden = new Set<string>()
    const context = {
      accountScopeInvalidatedRef: { current: false },
      currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task', threadId: 'thread' },
      projectChat: { setSelectedModelOption: vi.fn() }, sendRuntimePaneMessage: vi.fn(async () => true),
      editLastUserMessage: vi.fn(), cancelRuntimePaneTask: vi.fn(async () => true), setError: vi.fn(),
      requestUserInputAliasTrackerRef: { current: tracker },
      updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { hidden = update(hidden) },
      messagesRef: { current: [] }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
      getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
    }
    const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
    const block = (renderPayload: RequestUserInputPayload) => ({ id: 'block', type: 'tool' as const,
      toolName: 'AskUserQuestion', status: 'pending' as const, renderPayload })
    for (const operation of ['answer', 'ignore']) {
      hidden = new Set()
      await act(async () => {
        if (operation === 'answer') await hook.result.current.sendRequestUserInputResponse({ ...original, answers: {} })
        else await hook.result.current.ignoreRequestUserInput(original)
      })
      expect(isHiddenRequestUserInputBlock(block(original), hidden)).toBe(true)
      expect.soft(isHiddenRequestUserInputBlock(block({ ...original, [field]: 'replacement' }), hidden)).toBe(false)
    }
    hook.unmount()
  },
)
