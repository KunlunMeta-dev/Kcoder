import '@/i18n'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { usePaneInteractions } from '../layout/pane/usePaneInteractions'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import {
  applyRequestUserInputResponseToMessages,
  createRequestUserInputAliasTracker,
  insertUserMessageBeforeRequestUserInput,
  requestUserInputRelatedKeysForPayloads,
} from './requestUserInputMessages'

const payload: RequestUserInputPayload = {
  kind: 'request_user_input', requestId: 7, itemId: 'question',
  threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'choice', question: 'Continue?', options: [] }],
}
const message = (renderPayload: RequestUserInputPayload): WorkbenchMessage => ({
  id: 'original', role: 'assistant', content: '', status: 'done', createdAt: '2026-11-10',
  blocks: [{ id: 'question', type: 'tool', status: 'pending', toolName: 'AskUserQuestion', renderPayload }],
})
const reply = { id: 'reply', role: 'user', content: 'Answer', status: 'done',
  createdAt: '2026-11-10' } as WorkbenchMessage

for (const field of ['threadId', 'turnId', 'appServerEpoch'] as const) {
  test(`a stale ${field} cannot settle or hide a reused question ID`, () => {
    const messages = [message(payload)]
    const response = { ...payload, [field]: 'previous', answers: {} }
    expect.soft(applyRequestUserInputResponseToMessages(messages, response)).toBe(messages)
    expect.soft(insertUserMessageBeforeRequestUserInput(messages, reply, response))
      .toEqual([...messages, reply])
    const hidden = new Set(requestUserInputRelatedKeysForPayloads([payload], response))
    const submit = vi.fn()
    const view = render(<ToolBlocksDisplay blocks={messages[0].blocks!} isStreaming
      onRequestUserInputSubmit={submit} />)
    const draft = screen.getByTestId('request-user-input-custom-choice')
    fireEvent.change(draft, { target: { value: 'Keep the current answer' } })
    view.rerender(<ToolBlocksDisplay blocks={messages[0].blocks!} isStreaming
      hiddenRequestUserInputIds={hidden} onRequestUserInputSubmit={submit} />)
    expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
    expect(draft).toHaveValue('Keep the current answer')
    expect(submit).not.toHaveBeenCalled()
  })

  test.each(['bound', 'legacy'])(`ambiguous ${field} reuse keeps both questions pending (%s)`, mode => {
    const other = { ...payload, [field]: 'other' }
    const response = { requestId: 7, itemId: 'question', answers: {},
      ...(mode === 'bound' ? { ...payload } : {}) }
    const messages = [message(payload), { ...message(other), id: 'other' }]
    expect(requestUserInputRelatedKeysForPayloads([payload, other], response)).toEqual([])
    expect(applyRequestUserInputResponseToMessages(messages, response)).toBe(messages)
  })

  test.each(['matching', 'payload-omitted', 'response-omitted'])(`compatible ${field} still settles its original question (%s)`, mode => {
    const original = { ...payload }
    if (mode === 'payload-omitted') delete original[field]
    const response = { ...payload, answers: {} }
    if (mode === 'response-omitted') delete response[field]
    const messages = [message(original)]
    expect(applyRequestUserInputResponseToMessages(messages, response)[0].blocks![0].status).toBe('done')
    expect(insertUserMessageBeforeRequestUserInput(messages, reply, response)[0]).toBe(reply)
    expect(requestUserInputRelatedKeysForPayloads([original], response)).toEqual(['request:7', 'item:question'])
  })

  test(`restoration aliases cannot bypass the original ${field}`, () => {
    const aliases = new Map([['item:restored', new Set(['item:question'])]])
    expect(requestUserInputRelatedKeysForPayloads([payload], {
      ...payload, itemId: 'restored', [field]: 'previous', answers: {},
    }, aliases)).toEqual([])
  })

  test(`an in-flight answer cannot hide a refreshed ${field} in the same task pane`, async () => {
    let messages = [message(payload)]
    let answered = new Set<string>()
    let finish!: (sent: boolean) => void
    const tracker = createRequestUserInputAliasTracker()
    tracker.previousPayloads = [payload]
    const context = {
      currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task', threadId: 'thread' },
      projectChat: { setSelectedModelOption: vi.fn() },
      sendRuntimePaneMessage: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })),
      editLastUserMessage: vi.fn(), cancelRuntimePaneTask: vi.fn(), setError: vi.fn(),
      requestUserInputAliasTrackerRef: { current: tracker },
      updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { answered = update(answered) },
      messagesRef: { current: messages }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
      getRuntimeModelFields: vi.fn(),
      applyLocalRequestUserInputResponse: (response: Parameters<typeof applyRequestUserInputResponseToMessages>[1]) => {
        messages = applyRequestUserInputResponseToMessages(messages, response)
      },
    }
    const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
    let pending!: Promise<boolean>
    act(() => { pending = hook.result.current.sendRequestUserInputResponse({ ...payload, answers: {} }) })
    const current = { ...payload, [field]: 'replacement' }
    tracker.previousPayloads = [current]
    messages = [message(current)]
    const retained = messages
    await act(async () => { finish(true); await pending })
    expect(messages).toBe(retained)
    expect(answered.size).toBe(0)
    expect(context.sendRuntimePaneMessage).toHaveBeenCalledOnce()
    hook.unmount()
  })
}
