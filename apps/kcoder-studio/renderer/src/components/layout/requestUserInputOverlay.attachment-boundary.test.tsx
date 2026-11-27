import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { PaneComposer } from './workbench/PaneComposer'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

vi.mock('@/features/experts/TaskAgentSummary', () => ({ TaskAgentSummary: () => null }))
vi.mock('@/features/experts/TaskExpertControl', () => ({ TaskExpertControl: () => null }))
vi.mock('./BufferedChatInput', () => ({
  BufferedChatInput: () => <textarea aria-label="Ordinary conversation" />,
}))
vi.mock('./DeviceStatusPrompt', () => ({ DeviceStatusPrompt: () => null }))
vi.mock('@/features/workflows/WorkflowConversationCards', () => ({ WorkflowConversationCards: () => null }))

const attachmentMessage = {
  id: 'later-user', role: 'user', content: '', status: 'done',
  attachments: [{ id: 1, filename: 'source.png' }],
} as WorkbenchMessage

function history(kind: 'question' | 'plan'): WorkbenchMessage[] {
  return [{
    id: 'earlier-assistant', role: 'assistant', content: '', status: 'done',
    blocks: [kind === 'question' ? {
      id: 'earlier-question', type: 'tool', toolName: 'request_user_input', status: 'pending',
      renderPayload: { kind: 'request_user_input', requestId: 41,
        questions: [{ id: 'choice', question: 'Use the earlier source?', options: [] }] },
    } : {
      id: 'earlier-plan', type: 'plan', status: 'done', content: 'Use the earlier source.',
    }],
  }] as WorkbenchMessage[]
}

for (const kind of ['question', 'plan'] as const) {
  test(`attachment-only input retires the earlier ${kind} overlay and leaves the actual composer editable`, () => {
    const messages = [...history(kind), attachmentMessage]
    const pending = pendingRequestUserInputPayload(messages)
    const model = {
      paneActive: true, paneKey: 'original-task', pendingRequestUserInput: pending,
      workflowRefs: [], workflowScope: 'original-task',
      workflowComposerIntent: { active: false, onChange: vi.fn() },
      projectChatWithModelSelectorSignal: { scopeKey: 'original-task' },
      t: (key: string) => key,
      paneSession: { messages, requestUserInputAliasTrackerRef: { current: { aliasesByKey: new Map() } },
        input: '', status: { isSubmitting: false }, sessionMode: 'chat', setInput: vi.fn() },
      devices: [], upgradingDevices: {}, showConversationDeviceBanner: false,
      workspaceFileApi: {}, effectiveWorkspaceTarget: { deviceId: 'device', path: '/workspace' },
      activeDeviceId: 'device',
    } as unknown as Parameters<typeof PaneComposer>[0]['model']
    render(<PaneComposer model={model} />)
    expect(pending).toBeNull()
    const composer = screen.getByRole('textbox', { name: 'Ordinary conversation' })
    fireEvent.change(composer, { target: { value: 'Continue with the attached source' } })
    expect(composer).toHaveValue('Continue with the attached source')
    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
  })
}

test('an empty user placeholder does not hide a still-pending question', () => {
  const messages = history('question')
  expect(pendingRequestUserInputPayload([...messages, { ...attachmentMessage, attachments: [] }]))
    .toEqual(pendingRequestUserInputPayload(messages))
})

test('a question received after attachment input remains the current overlay', () => {
  const messages = history('question')
  expect(pendingRequestUserInputPayload([attachmentMessage, ...messages]))
    .toEqual(pendingRequestUserInputPayload(messages))
})
