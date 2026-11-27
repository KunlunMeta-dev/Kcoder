import '@/i18n'
import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { usePaneInteractions } from '../layout/pane/usePaneInteractions'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  insertUserMessageBeforeRequestUserInput,
  isHiddenRequestUserInputBlock,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const current: RequestUserInputPayload = {
  kind: 'request_user_input', requestId: 7, itemId: 'question-7',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'current-server',
  questions: [{ id: 'choice', question: 'Continue?', options: [] }],
}
const response = { ...current, answers: { choice: { answers: ['Current answer'] } } }
const message = (id: string, payload: RequestUserInputPayload): WorkbenchMessage => ({
  id, role: 'assistant', content: '', status: 'done', createdAt: '2026-11-11',
  blocks: [{ id, type: 'tool', status: 'pending', toolName: 'AskUserQuestion', renderPayload: payload }],
})

for (const field of ['threadId', 'turnId', 'appServerEpoch'] as const) {
  for (const terminal of ['resolved', 'response', 'requestUserInputResponse', 'request_user_input_response'] as const) {
    test(`a historical ${terminal} with an old ${field} cannot block the current accepted answer`, () => {
      const historical = { ...current, [field]: 'old', [terminal]: terminal === 'resolved' ? true : {
        ...response, [field]: 'old',
      } }
      const messages = [message('historical', historical), message('current', current)]
      const next = applyRequestUserInputResponseToMessages(messages, response)
      expect.soft(requestUserInputRelatedKeysForPayloads([historical, current], response))
        .toEqual(['request:7', 'item:question-7'])
      expect.soft(next[0]).toBe(messages[0])
      expect.soft(next[1].blocks![0].status).toBe('done')
      const reply = { id: 'answer', role: 'user', content: 'Current answer', status: 'done',
        createdAt: '2026-11-11' } as WorkbenchMessage
      expect(insertUserMessageBeforeRequestUserInput(messages, reply, response))
        .toEqual([messages[0], reply, messages[1]])
    })
  }

  test(`a terminal history cannot disambiguate a legacy answer missing ${field}`, () => {
    const historical = { ...current, [field]: 'old', resolved: true }
    const legacy = { ...response }
    delete legacy[field]
    expect(requestUserInputRelatedKeysForPayloads([historical, current], legacy)).toEqual([])
    expect(requestUserInputRelatedKeysForPayloads([historical, current], {
      ...response, [field]: 'old',
    })).toEqual([])
  })

  test(`excluding terminal history with an old ${field} still requires an original card`, () => {
    const historical = { ...current, [field]: 'old', resolved: true }
    for (const payloads of [[historical], [historical, { ...current, requestId: 8, itemId: 'unrelated' }]]) {
      expect(requestUserInputRelatedKeysForPayloads(payloads, response)).toEqual([])
    }
  })
}

test('the task pane settles a confirmed answer after a server restart without resending it', async () => {
  const historical = { ...current, appServerEpoch: 'old-server', resolved: true }
  let messages = [message('historical', historical), message('current', current)]
  let answered = new Set<string>()
  const tracker = createRequestUserInputAliasTracker()
  tracker.previousPayloads = [historical, current]
  const context = {
    accountScopeInvalidatedRef: { current: false },
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task', threadId: 'thread' },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(async () => true),
    editLastUserMessage: vi.fn(), cancelRuntimePaneTask: vi.fn(), setError: vi.fn(),
    requestUserInputAliasTrackerRef: { current: tracker },
    updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { answered = update(answered) },
    messagesRef: { current: messages }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(),
    applyLocalRequestUserInputResponse: (answer: typeof response) => {
      messages = applyRequestUserInputResponseToMessages(messages, answer)
    },
  }
  const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
  await act(async () => {
    expect(await hook.result.current.sendRequestUserInputResponse(response)).toBe(true)
  })
  expect.soft(messages[0].blocks![0].renderPayload).toBe(historical)
  expect.soft(messages[1].blocks![0].status).toBe('done')
  expect.soft(isHiddenRequestUserInputBlock(messages[1].blocks![0], answered)).toBe(true)
  expect.soft(isHiddenRequestUserInputBlock(messages[0].blocks![0], answered)).toBe(false)
  expect(context.sendRuntimePaneMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestUserInputResponse: response,
  }), expect.anything())
  hook.unmount()
})
