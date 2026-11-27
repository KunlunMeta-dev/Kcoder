import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { projectChatControls } from '@/components/chat/composer/ChatInput.test-support'
import { PaneComposer } from './PaneComposer'

vi.mock('@/features/experts/TaskAgentSummary', () => ({ TaskAgentSummary: () => null }))
vi.mock('@/features/experts/TaskExpertControl', () => ({ TaskExpertControl: () => null }))
vi.mock('@/components/chat/AsyncQuestionPanel', () => ({ AsyncQuestionPanel: () => null }))
vi.mock('../DeviceStatusPrompt', () => ({ DeviceStatusPrompt: () => null }))
vi.mock('@/features/workflows/WorkflowConversationCards', () => ({
  WorkflowConversationCards: () => null,
}))

test('keeps the real queue controls and composer lifetime while a blocking model question is shown', () => {
  const cancelQueuedMessage = vi.fn()
  const model = {
    currentRuntimeTask: {
      deviceId: 'device',
      taskId: 'task',
      threadId: 'thread',
      workspacePath: '/workspace',
    },
    paneKey: 'pane',
    paneActive: true,
    workflowRefs: [],
    devices: [],
    t: (_key: string, fallback: string) => fallback,
    projectChatWithModelSelectorSignal: { ...projectChatControls(), scopeKey: 'task' },
    paneQueuedMessages: [
      {
        id: 'queued-turn',
        content: 'Run after this turn',
        status: 'queued',
        createdAt: '2026-11-15T00:00:00Z',
      },
    ],
    paneSession: {
      requestUserInputAliasTrackerRef: { current: createRequestUserInputAliasTracker() },
      messages: [],
      input: 'Unsent draft',
      status: { isSubmitting: false },
      sessionMode: 'chat',
      setInput: vi.fn(),
      cancelQueuedMessage,
      sendRequestUserInputResponse: vi.fn(() => true),
    },
  } as unknown as Parameters<typeof PaneComposer>[0]['model']
  const view = render(<PaneComposer model={model} />)
  const editor = screen.getByTestId('chat-message-input')
  expect(editor).toBeVisible()
  expect(screen.getByTestId('conversation-queue-row-queued-turn')).toBeVisible()

  const pendingRequestUserInput = {
    requestId: 41,
    itemId: 'question',
    questions: [{ id: 'choice', question: 'Continue?', options: [] }],
  }
  view.rerender(<PaneComposer model={{ ...model, pendingRequestUserInput }} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /待回答问题/ }))
  expect(screen.getByTestId('request-user-input-custom-choice')).toBeVisible()
  expect(screen.getByTestId('conversation-queue-row-queued-turn')).toBeVisible()
  expect(screen.getByTestId('chat-message-input')).toBe(editor)
  expect(editor).toBeVisible()
  fireEvent.click(screen.getByTestId('queue-cancel-button-queued-turn'))
  expect(cancelQueuedMessage).toHaveBeenCalledWith('queued-turn', 'cancel')

  fireEvent.click(screen.getByTestId('composer-status-trigger-queue'))
  expect(screen.getByTestId('composer-status-trigger-queue')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  view.rerender(<PaneComposer model={model} />)
  expect(screen.getByTestId('chat-message-input')).toBe(editor)
  expect(editor).toBeVisible()
  expect(editor).toHaveTextContent('Unsent draft')
  expect(screen.getByTestId('composer-status-trigger-queue')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})
