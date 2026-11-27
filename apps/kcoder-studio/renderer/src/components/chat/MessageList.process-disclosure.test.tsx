import i18n from '@/i18n'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import { reviewEvidenceFixture } from '@/features/workbench/reviewEvidence.test-support'

const start = Date.parse('2026-11-21T12:00:00Z')
function response(): WorkbenchMessage {
  return {
    id: 'response', role: 'assistant', turnId: 'turn', attemptId: 'attempt',
    status: 'streaming', content: 'I am checking the second result.', createdAt: new Date(start).toISOString(),
    blocks: [
      { id: 'thought-one', subtaskId: 'attempt', type: 'thinking', status: 'done',
        content: 'Inspect the first file.', createdAt: start },
      { id: 'read-one', subtaskId: 'attempt', type: 'tool', toolName: 'bash', status: 'done',
        toolInput: { command: 'printf first' }, toolOutput: 'First tool output', createdAt: start + 1000 },
      { id: 'narrative', subtaskId: 'attempt', type: 'text', status: 'done',
        content: 'The first check is complete.', createdAt: start + 2000 },
      { id: 'thought-two', subtaskId: 'attempt', type: 'thinking', status: 'done',
        content: 'Inspect the second file.', createdAt: start + 3000 },
      { id: 'read-two', subtaskId: 'attempt', type: 'tool', toolName: 'read', status: 'pending',
        toolInput: { file_path: 'two.txt' }, toolOutput: 'Second tool output', createdAt: start + 4000 },
    ],
  }
}
afterEach(() => { cleanup(); clearPersistentProcessingExpansions() })

it('keeps a later pending question outside the fold and removes its row after resolution', () => {
  const message = response()
  const question: WorkbenchMessage = { ...message, id: 'later-question', content: '', blocks: [{
    id: 'question-block', type: 'tool', toolName: 'AskUserQuestion', status: 'pending',
    createdAt: start + 5000, renderPayload: { kind: 'request_user_input', requestId: 42,
      questions: [{ id: 'destination', question: 'Which destination?', options: [] }] },
  }] }
  const view = render(<MessageList conversationKey="later-question" messages={[message, question]} />)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  const input = screen.getByTestId('request-user-input-custom-destination')
  fireEvent.change(input, { target: { value: 'Keep this answer draft' } })
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getByTestId('request-user-input-custom-destination')).toBe(input)
  expect(input).toHaveValue('Keep this answer draft')
  view.rerender(<MessageList conversationKey="later-question" messages={[message, question]} hideRequestUserInputBlocks />)
  expect(screen.queryByTestId('request-user-input-custom-destination')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  view.rerender(<MessageList conversationKey="later-question" messages={[message, question]}
    hiddenRequestUserInputIds={new Set(['request:42'])} />)
  expect(screen.queryByTestId('request-user-input-custom-destination')).not.toBeInTheDocument()
  view.rerender(<MessageList conversationKey="later-question" messages={[message, {
    ...question, blocks: question.blocks!.map(block => block.type === 'tool' ? {
      ...block, status: 'done', renderPayload: { ...block.renderPayload as object, resolved: true },
    } : block),
  }]} />)
  expect(screen.queryByTestId('request-user-input-custom-destination')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
})

it('does not retain a folded sibling just for an empty image payload or unsupported file card', () => {
  const message = response()
  const siblings: WorkbenchMessage[] = [{ ...message, id: 'empty-image', content: '', blocks: [{
    id: 'image-block', type: 'tool', toolName: 'image_generation', status: 'done', createdAt: start,
  }] }, { ...message, id: 'unsupported-file', content: '', blocks: [],
    fileChanges: { version: 1, status: 'active', artifact_id: 'artifact', device_id: 'target',
      workspace_path: '/workspace', file_count: 0, additions: 0, deletions: 0, files: [] },
  }]
  const view = render(<MessageList conversationKey="empty-artifacts" messages={[message, ...siblings]} />)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(view.container.querySelector('[data-message-id="empty-image"]')).toBeInTheDocument()
})

it.each(['conversation', 'subagent'] as const)('resets local error details when another %s reuses the same message identifiers', scope => {
  const failure: WorkbenchMessage = { ...response(), status: 'failed', error: 'First task diagnostic' }
  const props = { messages: [failure], onRetryFailedMessage: vi.fn() }
  const view = render(<MessageList {...props} conversationKey="first-task" processRunId="first-run" />)
  fireEvent.click(screen.getByTestId('assistant-error-details-toggle'))
  expect(screen.getByTestId('assistant-error-details')).toBeVisible()
  view.rerender(<MessageList {...props} messages={[{ ...failure, error: 'Second task diagnostic' }]}
    conversationKey={scope === 'conversation' ? 'second-task' : 'first-task'}
    processRunId={scope === 'subagent' ? 'second-run' : 'first-run'} />)
  expect(screen.queryByTestId('assistant-error-details')).not.toBeInTheDocument()
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

it.each([true, false])('does not transfer editing mode or a late acknowledgement into another conversation (reused IDs=%s)', async reusedIds => {
  let acknowledge: (value: boolean) => void = () => {}
  const receipt = new Promise<boolean>(resolve => { acknowledge = resolve })
  const edit = vi.fn(() => receipt)
  const messages: WorkbenchMessage[] = [{ id: 'reused-user', role: 'user', content: 'Original question',
    status: 'done', createdAt: '' }, { ...response(), status: 'done', blocks: [], content: 'Answer' }]
  const props = { messages, onEditLastUserMessage: edit, canEditLastUserMessage: true }
  const view = render(<MessageList {...props} conversationKey="edit-first" />)
  fireEvent.click(screen.getByTestId('edit-message-button'))
  fireEvent.click(screen.getByTestId('submit-edit-user-message-button'))
  expect(edit).toHaveBeenCalledTimes(1)
  view.rerender(<MessageList {...props} conversationKey="edit-second"
    messages={reusedIds ? messages : messages.map(message => ({ ...message, id: `second-${message.id}` }))} />)
  expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('edit-message-button'))
  const draft = screen.getByTestId('edit-user-message-textarea')
  expect(draft).toBeEnabled()
  fireEvent.change(draft, { target: { value: 'Second task draft' } })
  await act(async () => acknowledge(true))
  expect(screen.getByTestId('edit-user-message-textarea')).toBe(draft)
  expect(draft).toHaveValue('Second task draft')
  expect(edit).toHaveBeenCalledTimes(1)
})

it('retains real generated images, enabled file cards, and the external review entry outside the fold', () => {
  const message = response()
  const fileChanges: NonNullable<WorkbenchMessage['fileChanges']> = { version: 1, status: 'active',
    artifact_id: 'artifact', device_id: 'target', workspace_path: '/workspace', file_count: 1,
    additions: 1, deletions: 0, files: [{ path: 'result.txt', change_type: 'created',
      additions: 1, deletions: 0, binary: false }] }
  const image: WorkbenchMessage = { ...message, id: 'actual-image', status: 'done', content: '', blocks: [{
    id: 'image', type: 'tool', toolName: 'image_generation', status: 'done', createdAt: start,
    renderPayload: { imageBase64: 'iVBORw0KGgo=', revisedPrompt: 'Owned image' },
  }] }
  const file: WorkbenchMessage = { ...message, id: 'actual-file', status: 'done', subtaskId: 'attempt',
    content: '', blocks: [], fileChanges }
  const review: WorkbenchMessage = { ...message, id: 'review', status: 'done', content: '', blocks: [],
    reviewEvidence: reviewEvidenceFixture }
  const view = render(<MessageList conversationKey="visible-artifacts" messages={[message, image, file, review]}
    onLoadFileChangesDiff={vi.fn(async () => ({ diff: '', truncated: false }))}
    onRevertFileChanges={vi.fn(async () => fileChanges)}
    renderGapAfterMessage={item => item.id === 'review' ? <div>Open original review</div> : null} />)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getByTestId('generated-image-gallery')).toBeVisible()
  expect(view.container.querySelector('[data-message-id="actual-file"]')).toHaveTextContent('result.txt')
  expect(screen.getByText('Open original review')).toBeVisible()
  expect(view.container.querySelector('[data-message-id="review"]')).not.toBeInTheDocument()
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

it('also opens legacy process rows directly without requiring an Engine attempt identity', () => {
  const message = response()
  render(<MessageList conversationKey="legacy-process" messages={[{
    ...message, turnId: undefined, attemptId: undefined, status: 'done', content: 'Legacy final answer.',
    blocks: message.blocks!.map(block => ({ ...block, status: 'done' as const })),
  }]} />)
  const outer = screen.getByTestId('final-processing-toggle')
  expect(outer).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Legacy final answer.')).toBeVisible()
  fireEvent.click(outer)
  expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
  expect(screen.queryByTestId('process-activity-toggle')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('assistant-thinking-toggle')).toHaveLength(2)
  for (const thought of screen.getAllByTestId('assistant-thinking-toggle'))
    expect(thought).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('First tool output')).not.toBeInTheDocument()
})

it('keeps earlier reasoning settled while later reasoning or parallel tools are active', () => {
  const message = response()
  message.latestModelActivity = 'text'
  message.blocks = message.blocks!.map(block => block.id === 'thought-one'
    ? { ...block, status: 'streaming' } : block)
  const view = render(<MessageList conversationKey="reasoning-phase" messages={[message]} />)
  expect(screen.getAllByTestId('process-activity-toggle')[0].querySelector('.animate-spin')).toBeNull()
  expect(screen.getAllByTestId('process-activity-toggle')[1].querySelector('.animate-spin')).not.toBeNull()
  const laterThought = { id: 'thought-three', type: 'thinking' as const, subtaskId: 'attempt',
    content: 'Reasoning after a parallel tool starts.', status: 'streaming' as const, createdAt: start + 5000 }
  view.rerender(<MessageList conversationKey="reasoning-phase" messages={[{ ...message,
    latestModelActivity: 'thinking', blocks: [...message.blocks!, laterThought] }]} />)
  expect(screen.getAllByTestId('process-activity-toggle')[0].querySelector('.animate-spin')).toBeNull()
  fireEvent.click(screen.getAllByTestId('process-activity-toggle')[0])
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-busy', 'false')
  fireEvent.click(screen.getAllByTestId('process-activity-toggle')[1])
  expect(screen.getAllByTestId('assistant-thinking-toggle').at(-1)).toHaveAttribute('aria-busy', 'true')
})

it('localizes all three disclosure levels without changing model content', async () => {
  await i18n.changeLanguage('en')
  try {
    const message = response()
    message.blocks = message.blocks!.map(block => block.type === 'tool'
      ? { ...block, displayText: { en: 'Reading files', 'zh-CN': '正在读取文件' } } : block)
    const view = render(<MessageList conversationKey="locale-switch" messages={[message]} />)
    expect(screen.getByTestId('turn-process-status')).toHaveTextContent('Processing')
    const group = screen.getAllByTestId('process-activity-toggle')[1]
    expect(group).toHaveTextContent('1 reasoning step · 1 tool call · Reading files')
    fireEvent.click(group)
    expect(screen.getByText('Running read')).toBeInTheDocument()
    expect(screen.getAllByTestId('assistant-thinking-toggle')[0]).toHaveAccessibleName('Thought process')
    expect(screen.getByText(message.content)).toBeVisible()
    await act(async () => { await i18n.changeLanguage('zh-CN') })
    expect(screen.getByTestId('turn-process-status')).toHaveTextContent('处理中')
    expect(group).toHaveTextContent('思考 1 · 工具调用 1 · 正在读取文件')
    expect(screen.getByText('正在运行 read')).toBeInTheDocument()
    expect(screen.getByText(message.content)).toBeVisible()
    await act(async () => { await i18n.changeLanguage('en') })
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getByTestId('turn-process-activity')).toHaveTextContent('Reading files')
    view.rerender(<MessageList conversationKey="locale-switch" messages={[{ ...message, status: 'done',
      content: 'Final answer.', completedAt: start + 59_000,
      blocks: message.blocks!.map(block => ({ ...block, status: 'done' })) }]} />)
    expect(screen.getByTestId('final-processing-toggle')).toHaveAccessibleName('Completed 59s')
  } finally { await i18n.changeLanguage('zh-CN') }
})

it('starts open with folded activity batches and details, then folds the process on completion', () => {
  const message = response()
  const view = render(<MessageList conversationKey="two-level" messages={[message]} />)
  const outer = screen.getByTestId('final-processing-toggle')
  expect(outer).toHaveAttribute('aria-expanded', 'true')
  expect(outer.firstElementChild).toBe(screen.getByTestId('turn-process-heading'))
  expect(screen.queryByTestId('turn-process-activity')).not.toBeInTheDocument()
  expect(screen.getByText('The first check is complete.')).toBeVisible()
  expect(screen.getByText('I am checking the second result.')).toBeVisible()
  const groups = screen.getAllByTestId('process-activity-toggle')
  expect(groups).toHaveLength(2)
  for (const group of groups) expect(group).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('assistant-thinking-toggle')).not.toBeInTheDocument()
  expect(screen.queryByText('First tool output')).not.toBeInTheDocument()

  fireEvent.click(groups[0])
  const thought = screen.getByTestId('assistant-thinking-toggle')
  expect(thought).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Inspect the first file.')).not.toBeInTheDocument()
  fireEvent.click(thought)
  expect(screen.getByText('Inspect the first file.')).toBeVisible()
  const tool = view.container.querySelector<HTMLButtonElement>('[data-processing-block-id="read-one"] [data-tool-detail-toggle]')!
  expect(tool).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(tool)
  expect(screen.getByText('First tool output')).toBeVisible()

  const finished: WorkbenchMessage = { ...message, status: 'done', content: 'Final answer.', completedAt: start + 6000,
    blocks: [...message.blocks!.map(block => ({ ...block, status: 'done' as const, completedAt: start + 5000 })),
      { id: 'last-narrative', subtaskId: 'attempt', type: 'text', status: 'done', createdAt: start + 5000,
        content: message.content }] }
  view.rerender(<MessageList conversationKey="two-level" messages={[finished]} />)
  expect(outer).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('process-activity-toggle')).not.toBeInTheDocument()
  expect(screen.queryByText('The first check is complete.')).not.toBeInTheDocument()
  expect(screen.queryByText(message.content)).not.toBeInTheDocument()
  expect(screen.getByText('Final answer.')).toBeVisible()
  fireEvent.click(outer)
  expect(screen.getByText('The first check is complete.')).toBeVisible()
  expect(screen.getByText(message.content)).toBeVisible()
  for (const group of screen.getAllByTestId('process-activity-toggle'))
    expect(group).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Inspect the first file.')).not.toBeInTheDocument()
  expect(screen.queryByText('First tool output')).not.toBeInTheDocument()
})

it('keeps a manual live fold while new text and tool items arrive', () => {
  const message = response()
  const view = render(<MessageList conversationKey="manual-live" messages={[message]} />)
  const outer = screen.getByTestId('final-processing-toggle')
  fireEvent.click(outer)
  view.rerender(<MessageList conversationKey="manual-live" messages={[message,
    { ...message, id: 'next-message', content: 'New progress text.', blocks: [message.blocks![1]] }]} />)
  expect(outer).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('New progress text.')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  fireEvent.click(outer)
  expect(screen.getByText('New progress text.')).toBeVisible()
  expect(screen.getAllByTestId('process-activity-toggle')).toHaveLength(3)
  expect(screen.queryByTestId('assistant-thinking-toggle')).not.toBeInTheDocument()
})

it('keeps a folded header stable while model text and reasoning change', () => {
  const original = response()
  let messages: WorkbenchMessage[] = [{ ...original, subtaskId: 'attempt', latestModelActivity: 'text',
    blocks: original.blocks!.map(block => ({ ...block, status: 'done' as const })) }]
  const view = render(<MessageList conversationKey="model-kind" messages={messages} />)
  const outer = screen.getByTestId('final-processing-toggle')
  fireEvent.click(outer)
  expect(outer).toHaveTextContent('处理中')
  messages = reduceWorkbenchMessages(messages, { type: 'assistant_chunk', subtaskId: 'attempt',
    reasoningChunk: 'New reasoning after earlier prose.', occurredAtMs: start + 7000 })
  view.rerender(<MessageList conversationKey="model-kind" messages={messages} />)
  expect(outer).toHaveTextContent('处理中')
  expect(screen.queryByText('New reasoning after earlier prose.')).not.toBeInTheDocument()
  messages = reduceWorkbenchMessages(messages, { type: 'assistant_chunk', subtaskId: 'attempt',
    content: 'Later progress.', occurredAtMs: start + 8000 })
  view.rerender(<MessageList conversationKey="model-kind" messages={messages} />)
  expect(outer).toHaveTextContent('处理中')
  expect(screen.queryByTestId('turn-process-content')).not.toBeInTheDocument()
})

it('keeps a pending question and its draft outside the folded process', () => {
  const message = response()
  render(<MessageList conversationKey="pending-question" messages={[{
    ...message, blocks: [...message.blocks!, {
      id: 'pending-question', type: 'tool', toolName: 'AskUserQuestion', status: 'pending',
      createdAt: start + 5000, renderPayload: {
        kind: 'request_user_input', requestId: 41,
        questions: [{ id: 'source', question: 'Which source should I use?', options: [] }],
      },
    }],
  }]} />)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByTestId('request-user-input-custom-source')).toBeVisible()
  expect(screen.getByText('Which source should I use?')).toBeVisible()
  const input = screen.getByTestId('request-user-input-custom-source')
  fireEvent.change(input, { target: { value: 'Keep my draft' } })
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getByTestId('request-user-input-custom-source')).toBe(input)
  expect(input).toHaveValue('Keep my draft')
})

it('folds failed process text without treating it as a final answer or opening tool details', () => {
  const message = response()
  const view = render(<MessageList conversationKey="failed-process" messages={[message]} />)
  view.rerender(<MessageList conversationKey="failed-process" messages={[
    { ...message, status: 'failed', error: 'The provider request failed.', completedAt: start + 6000 },
  ]} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText(message.content)).not.toBeInTheDocument()
  expect(screen.queryByTestId('process-activity-toggle')).not.toBeInTheDocument()
  expect(screen.getByTestId('assistant-error-card')).toBeVisible()
  expect(screen.getByTestId('final-processing-toggle')).toHaveTextContent('执行失败')
  expect(screen.queryByText('The provider request failed.')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('assistant-error-details-toggle'))
  expect(screen.getByText('The provider request failed.')).toBeVisible()
})

it('keeps the confirmed final answer visible when a tool result remains unknown', () => {
  const message = response()
  render(<MessageList conversationKey="unknown-tool-final" messages={[{
    ...message, status: 'done', content: 'A confirmed final answer.',
    blocks: message.blocks!.map(block => ({ ...block, status: block.type === 'tool' ? 'unknown' as const : 'done' as const })),
  }]} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('A confirmed final answer.')).toBeVisible()
})

it('does not lose the outer header or final answer to invisible assistant bookkeeping rows', () => {
  const message = response()
  const empty = { ...message, blocks: [], content: '', status: 'done' as const }
  render(<MessageList conversationKey="bookkeeping" messages={[
    { ...empty, id: 'empty-before' },
    { ...message, status: 'done', blocks: message.blocks!.map(block => ({ ...block, status: 'done' as const })),
      content: 'Final answer after bookkeeping.' },
    { ...empty, id: 'empty-after' },
  ]} />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Final answer after bookkeeping.')).toBeVisible()
})

vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...actual.useConversationPreferences(), conversationProcessDisplay: 'three-level-v1',
  }) }
})
