import '@/i18n'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ComposerStatusRegion } from './composer/ComposerStatusRegion'
import { RequestUserInputCard, type RequestUserInputPayload } from './RequestUserInputCard'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import { SubagentWorkspace } from '@/features/subagents/SubagentWorkspace'

afterEach(() => { cleanup(); clearPersistentProcessingExpansions(); localStorage.clear() })
const question: RequestUserInputPayload = {
  threadId: 'thread', turnId: 'turn', requestId: 41, itemId: 'question',
  questions: [{ id: 'choice', question: 'Which format?', options: [] }],
}

test.each([false, true])('a pending interaction (approval=%s) only shows a status reminder until clicked', approval => {
  const payload = approval ? { ...question, itemId: 'approval-41',
    questions: [{ id: 'choice', question: 'Allow this command?', options: [{ label: 'Allow once' }, { label: 'Deny' }] }] } : question
  const submit = vi.fn<(response: unknown) => boolean>(() => false)
  render(<ComposerStatusRegion ownerKey="owner">
    <textarea aria-label="Composer" defaultValue="Keep composing" />
    <RequestUserInputCard payload={payload} onSubmit={submit} autoSubmitOnOptionSelect={false} />
  </ComposerStatusRegion>)
  const trigger = within(screen.getByTestId('composer-status-row')).getByRole('button')
  const form = screen.getByTestId('request-user-input-card')
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(trigger).toHaveClass('text-warning')
  expect(form).not.toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Composer' })).toBeVisible()
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  expect(form).toBeVisible()
  const draft = screen.queryByTestId('request-user-input-custom-choice')
  if (approval) fireEvent.click(screen.getByTestId('request-user-input-option-choice-1'))
  else fireEvent.change(draft!, { target: { value: 'Keep this answer' } })
  fireEvent.click(trigger)
  expect(form).not.toBeVisible()
  fireEvent.click(trigger)
  if (!approval) {
    expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
    expect(draft).toHaveValue('Keep this answer')
  }
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledOnce()
  expect(submit.mock.calls[0][0]).toMatchObject({ threadId: 'thread', turnId: 'turn', itemId: payload.itemId,
    answers: { choice: { answers: [approval ? 'Deny' : 'Keep this answer'] } } })
})

test('new requests start folded and independent approvals do not open an existing question', () => {
  const submit = vi.fn()
  const content = (payload: RequestUserInputPayload) => <ComposerStatusRegion ownerKey="owner">
    <RequestUserInputCard payload={payload} onSubmit={submit} />
    <RequestUserInputCard payload={{ ...question, requestId: 42, itemId: 'approval-42' }} onSubmit={submit} />
  </ComposerStatusRegion>
  const view = render(content(question))
  const triggers = within(screen.getByTestId('composer-status-row')).getAllByRole('button')
  fireEvent.click(triggers[0])
  expect(triggers[0]).toHaveAttribute('aria-expanded', 'true')
  expect(triggers[1]).toHaveAttribute('aria-expanded', 'false')
  view.rerender(content({ ...question, requestId: 43, itemId: 'replacement-question' }))
  for (const trigger of within(screen.getByTestId('composer-status-row')).getAllByRole('button'))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(submit).not.toHaveBeenCalled()
})

test('a child question registers in the child status row and keeps its original source binding', () => {
  const submit = vi.fn<(response: unknown) => boolean>(() => false)
  const payload = { ...question, sourceAgent: { parentSessionId: 'thread', agentId: 'child' } }
  render(<SubagentWorkspace agent={{ id: 'child', agentId: 'child', agentPath: 'thread:child',
    agentName: 'Worker', status: 'running' }} connected runId="child-run" conversationMessages={[]}
    canSteer={false} onReadArtifact={vi.fn()} onSteer={vi.fn()} onClose={vi.fn()}
    interactions={<RequestUserInputCard payload={payload} onSubmit={submit} />} />)
  const trigger = within(screen.getByTestId('composer-status-row')).getByRole('button')
  expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
  fireEvent.click(trigger)
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), { target: { value: 'Child answer' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit.mock.calls[0][0]).toMatchObject({ sourceAgent: payload.sourceAgent })
})

test('retired small-window cache cannot restore a different presentation for a real conversation', () => {
  localStorage.setItem('kcoder-studio:conversation-processing-windows-v1', JSON.stringify([['server:task', true]]))
  render(<ScrollableMessageArea toolsCatalogServerId="server" toolsCatalogTaskId="task" conversationKey="task"
    messages={[{ id: 'process', role: 'assistant', content: 'Final response', status: 'done', createdAt: '',
      turnId: 'turn', attemptId: 'attempt', blocks: [{ id: 'thought', type: 'thinking', status: 'done',
        content: 'Private process detail', createdAt: 1 }] }]} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByTestId('turn-process-summary')).toBeVisible()
  expect(screen.queryByTestId('processing-group')).not.toBeInTheDocument()
  expect(screen.queryByTestId('turn-process-content')).not.toBeInTheDocument()
})

vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...actual.useConversationPreferences(), conversationProcessDisplay: 'three-level-v1',
  }) }
})
