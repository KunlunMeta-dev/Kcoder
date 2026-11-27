import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import type { Attachment, RuntimeRollbackRequest } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { usePaneInteractions } from './usePaneInteractions'

it('correlates the edited user message with its runtime receipt and keeps its attachments', async () => {
  const attachment: Attachment = {
    id: 23,
    filename: 'diagram.png',
    file_size: 128,
    mime_type: 'image/png',
    file_extension: '.png',
    status: 'ready',
    created_at: '2026-11-22T00:00:00.000Z',
  }
  const userMessage: WorkbenchMessage = {
    id: 'original-user-message',
    role: 'user',
    content: 'Original prompt',
    attachments: [attachment],
    status: 'done',
    createdAt: '2026-11-22T00:00:00.000Z',
  }
  const messages: WorkbenchMessage[] = [userMessage, {
    id: 'completed-assistant-message',
    role: 'assistant',
    content: 'Completed response',
    status: 'done',
    createdAt: '2026-11-22T00:00:01.000Z',
  }]
  const editLastUserMessage = vi.fn<(request: RuntimeRollbackRequest) => Promise<boolean>>(async () => true)
  const dispatchMessages = vi.fn()
  const context = {
    accountScopeInvalidatedRef: { current: false },
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task', threadId: 'thread' },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(),
    editLastUserMessage,
    cancelRuntimePaneTask: vi.fn(),
    setError: vi.fn(),
    requestUserInputAliasTrackerRef: { current: createRequestUserInputAliasTracker() },
    updateAnsweredRequestUserInputIds: vi.fn(),
    messagesRef: { current: messages },
    dispatchMessages,
    paneStatus: { isBusy: false },
    getRuntimeModelFields: vi.fn(() => ({})),
    applyLocalRequestUserInputResponse: vi.fn(),
  }
  const { result } = renderHook(() => usePaneInteractions(
    context as unknown as Parameters<typeof usePaneInteractions>[0]
  ))

  await act(async () => {
    await result.current.editLastUserMessageInPane(userMessage, 'Edited prompt')
  })

  const request = editLastUserMessage.mock.calls[0]?.[0]
  const optimisticMessage = dispatchMessages.mock.calls[0]?.[0].messages.at(-1)
  expect(request?.clientMessageId).toBeTruthy()
  expect(optimisticMessage.id).toBe(request?.clientMessageId)
  expect(optimisticMessage.attachments).toEqual([attachment])
})
