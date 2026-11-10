import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { PaneComposer } from './PaneComposer'
import { createRequestUserInputAliasTracker, observeRequestUserInputAliases } from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'

vi.mock('@/features/experts/TaskAgentSummary', () => ({ TaskAgentSummary: () => null }))
vi.mock('@/features/experts/TaskExpertControl', () => ({ TaskExpertControl: () => null }))
vi.mock('@/components/chat/AsyncQuestionPanel', () => ({ AsyncQuestionPanel: () => null }))
vi.mock('../BufferedChatInput', () => ({ BufferedChatInput: () => null }))
vi.mock('../DeviceStatusPrompt', () => ({ DeviceStatusPrompt: () => null }))
vi.mock('@/features/workflows/WorkflowConversationCards', () => ({ WorkflowConversationCards: () => null }))

const live: RequestUserInputPayload = {
  requestId: 41, itemId: 'live-question',
  questions: [{ id: 'choice', question: 'Continue?', options: [] }],
}
const restored = { ...live, requestId: undefined, itemId: 'restored-question' }

function fixture() {
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored, live])
  return {
    currentRuntimeTask: { deviceId: 'device', taskId: 'original', threadId: 'thread', workspacePath: '/workspace' },
    paneSession: { requestUserInputAliasTrackerRef: { current: tracker }, sendRequestUserInputResponse: vi.fn(() => false) },
    pendingRequestUserInput: live,
    workflowRefs: [], devices: [],
    projectChatWithModelSelectorSignal: {},
  } as unknown as Parameters<typeof PaneComposer>[0]['model']
}

test('the composer retains the original form across registered history aliases', () => {
  const model = fixture()
  const view = render(<PaneComposer model={model} />)
  const draft = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Original draft' } })
  view.rerender(<PaneComposer model={{ ...model, pendingRequestUserInput: restored }} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect(draft).toHaveValue('Original draft')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(model.paneSession.sendRequestUserInputResponse).toHaveBeenCalledWith(
    expect.objectContaining({ itemId: restored.itemId, answers: { choice: { answers: ['Original draft'] } } }),
    expect.anything(),
  )
})

test.each(['deviceId', 'taskId', 'threadId', 'workspacePath'] as const)(
  'the composer resets legacy form drafts on a %s address change', field => {
    const model = fixture()
    const view = render(<PaneComposer model={model} />)
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), { target: { value: 'Original only' } })
    view.rerender(<PaneComposer model={{ ...model, currentRuntimeTask: { ...model.currentRuntimeTask!, [field]: 'replacement' } }} />)
    expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
  },
)
