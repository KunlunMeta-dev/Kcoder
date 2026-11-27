import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import { renderToString } from 'react-dom/server'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import '@/i18n'

const preferences = vi.hoisted(() => ({ ready: false, collapsed: false }))
vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return {
    ...actual,
    useConversationPreferences: () => ({
      ...actual.useConversationPreferences(),
      conversationProcessDisplay: 'three-level-v1',
      hydration: preferences.ready ? 'ready' : 'loading',
      toolsCollapsedByDefault: preferences.collapsed,
      thinkingCollapsedByDefault: true,
    }),
  }
})

afterEach(() => {
  vi.useRealTimers()
  clearPersistentProcessingExpansions()
  preferences.ready = false
  preferences.collapsed = false
})

it('omits folded sibling rows on the first render before expansion effects can initialize', () => {
  preferences.ready = true
  preferences.collapsed = true
  const started = Date.parse('2026-11-21T12:00:00Z')
  const messages: WorkbenchMessage[] = ['first', 'new-item'].map((id, index) => ({
    id, role: 'assistant', status: 'done', content: '',
    turnId: 'same-turn', attemptId: 'same-attempt', createdAt: new Date(started).toISOString(),
    blocks: [{ id: `tool-${id}`, subtaskId: 'same-attempt', type: 'tool',
      toolName: 'read', status: 'done', createdAt: started + index * 1000 }],
  }))
  // Server rendering exercises the initial snapshot without any layout-effect repair.
  const html = renderToString(<MessageList messages={messages} conversationKey="first-fold" />)
  const container = document.createElement('div')
  container.innerHTML = html
  expect(container.querySelectorAll('[data-testid="message-hover-region"]')).toHaveLength(1)
  expect(container.querySelector('[data-testid="turn-process-content"]')).toBeNull()
})

it('freezes the first hydrated process preference and preserves an explicit user choice', () => {
  const response: WorkbenchMessage = {
    id: 'preference-response',
    role: 'assistant',
    status: 'done',
    content: 'Result',
    createdAt: '2026-10-26T00:00:00Z',
  }
  const view = render(<MessageList messages={[response]} conversationKey="preference-thread" />)
  const withTool: WorkbenchMessage = {
    ...response,
    blocks: [
      {
        id: 'preference-write',
        subtaskId: 'preference-thread',
        type: 'tool',
        toolName: 'write',
        toolInput: { file_path: 'result.txt' },
        toolOutput: 'written',
        status: 'done',
        createdAt: 1,
        completedAt: 2,
      },
    ],
  }
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  preferences.ready = true
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  preferences.collapsed = true
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  preferences.collapsed = false
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

it('folds process text on completion and keeps only the final reply outside the summary', () => {
  preferences.ready = true
  preferences.collapsed = true
  const createdAt = '2026-11-20T12:00:00.000Z'
  const messages: WorkbenchMessage[] = [
    {
      id: 'step-1',
      role: 'assistant',
      status: 'done',
      content: 'I found the relevant files.',
      createdAt,
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      blocks: [
        {
          id: 'thought-1',
          subtaskId: 'attempt-1',
          type: 'thinking',
          content: 'Check the file list first.',
          status: 'done',
          createdAt: Date.parse(createdAt),
          completedAt: Date.parse(createdAt) + 1000,
        },
        {
          id: 'read-1',
          subtaskId: 'attempt-1',
          type: 'tool',
          toolName: 'read',
          toolInput: { file_path: 'README.md' },
          toolOutput: 'First file output',
          status: 'done',
          createdAt: Date.parse(createdAt) + 1000,
          completedAt: Date.parse(createdAt) + 2000,
        },
      ],
    },
    {
      id: 'stage-reply',
      role: 'assistant',
      status: 'done',
      content: 'Progress update stays visible.',
      createdAt,
      turnId: 'turn-1',
      attemptId: 'attempt-1',
    },
    {
      id: 'step-2',
      role: 'assistant',
      status: 'done',
      content: 'Final reply stays visible.',
      createdAt,
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      blocks: [
        {
          id: 'command-1',
          subtaskId: 'attempt-1',
          type: 'tool',
          toolName: 'bash',
          toolInput: { command: 'pwd' },
          toolOutput: 'Second file output',
          status: 'done',
          createdAt: Date.parse(createdAt) + 2000,
          completedAt: Date.parse(createdAt) + 3000,
        },
      ],
    },
  ]

  render(<MessageList messages={messages} conversationKey="turn-process-thread" />)

  const summary = screen.getByTestId('final-processing-toggle')
  expect(screen.getAllByTestId('final-processing-toggle')).toHaveLength(1)
  expect(summary).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Progress update stays visible.')).not.toBeInTheDocument()
  expect(screen.queryByText('I found the relevant files.')).not.toBeInTheDocument()
  expect(screen.getByText('Final reply stays visible.')).toBeInTheDocument()
  expect(screen.queryByText('Check the file list first.')).not.toBeInTheDocument()
  expect(screen.queryByText('First file output')).not.toBeInTheDocument()

  fireEvent.click(summary)

  expect(summary).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByTestId('turn-process-content')).toHaveLength(3)
  fireEvent.click(screen.getAllByTestId('process-activity-toggle')[0])
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Progress update stays visible.')).toBeInTheDocument()
  expect(screen.getByText('Final reply stays visible.')).toBeInTheDocument()
})

it('starts live turns open and restores focus when completion folds the process', () => {
  preferences.ready = true
  preferences.collapsed = true
  const createdAt = '2026-11-20T12:00:00.000Z'
  const streaming: WorkbenchMessage = {
    id: 'live-process',
    role: 'assistant',
    status: 'streaming',
    content: '',
    createdAt,
    turnId: 'turn-live',
    attemptId: 'attempt-live',
    blocks: [
      {
        id: 'live-thinking',
        subtaskId: 'attempt-live',
        type: 'thinking',
        content: 'I am checking the request.',
        status: 'done',
        createdAt: Date.parse(createdAt),
      },
    ],
  }
  const view = render(<MessageList messages={[streaming]} conversationKey="live-thread" />)
  const liveSummary = screen.getByTestId('final-processing-toggle')
  expect(liveSummary).toBeEnabled()
  expect(liveSummary).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByTestId('process-activity-toggle'))
  const thinkingToggle = screen.getByTestId('assistant-thinking-toggle')
  expect(thinkingToggle).toHaveAttribute('aria-expanded', 'false')
  thinkingToggle.focus()
  expect(thinkingToggle).toHaveFocus()

  view.rerender(
    <MessageList
      messages={[
        {
          ...streaming,
          status: 'done',
          content: 'Final response.',
          completedAt: Date.parse(createdAt) + 2000,
        },
      ]}
      conversationKey="live-thread"
    />
  )

  const completedSummary = screen.getByTestId('final-processing-toggle')
  expect(completedSummary).toBeEnabled()
  expect(completedSummary).toHaveAttribute('aria-expanded', 'false')
  expect(completedSummary).toHaveFocus()
  expect(screen.getByText('Final response.')).toBeInTheDocument()
})

it('opens a recovered live process without inheriting the completed process fold', () => {
  preferences.ready = true
  preferences.collapsed = true
  const message: WorkbenchMessage = {
    id: 'recovered-process', role: 'assistant', status: 'done', content: 'Result',
    createdAt: '2026-11-20T12:00:00Z', turnId: 'recovered-turn', attemptId: 'recovered-attempt',
    blocks: [{ id: 'recovered-read', subtaskId: 'recovered-attempt', type: 'tool',
      toolName: 'read', toolInput: { file_path: 'README.md' }, status: 'done',
      toolOutput: 'Recovered output' }],
  }
  const view = render(<MessageList messages={[message]} conversationKey="recovered-thread" />)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.queryByTestId('turn-process-content')).not.toBeInTheDocument()
  view.rerender(<MessageList messages={[{ ...message, status: 'streaming' }]}
    conversationKey="recovered-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toBeEnabled()
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('turn-process-content')).toBeInTheDocument()
  expect(screen.getByText('Result')).toBeVisible()
})

it('folds a completed turn even when legacy tool preferences request expansion', () => {
  preferences.ready = true
  preferences.collapsed = false
  const message: WorkbenchMessage = {
    id: 'expanded-process', role: 'assistant', status: 'streaming', content: '',
    createdAt: '2026-11-20T12:00:00Z', turnId: 'expanded-turn', attemptId: 'expanded-attempt',
    blocks: [{ id: 'expanded-read', subtaskId: 'expanded-attempt', type: 'tool',
      toolName: 'read', toolInput: { file_path: 'README.md' }, status: 'done' }],
  }
  const view = render(<MessageList messages={[message]} conversationKey="expanded-thread" />)
  view.rerender(<MessageList messages={[{ ...message, status: 'done', content: 'Result' }]}
    conversationKey="expanded-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('turn-process-content')).not.toBeInTheDocument()
})

function processMessage(id: string, attemptId: string): WorkbenchMessage {
  return {
    id, role: 'assistant', status: 'done', content: '',
    createdAt: '2026-11-20T12:00:00Z', turnId: 'boundary-turn', attemptId,
    blocks: [{ id: `${id}-read`, subtaskId: attemptId, type: 'tool',
      toolName: 'read', toolInput: { file_path: 'README.md' }, status: 'done' }],
  }
}

it('preserves an invisible attempt boundary when deciding which process is waiting', () => {
  preferences.ready = true
  preferences.collapsed = true
  const previous = processMessage('before-empty-attempt', 'attempt-before')
  const emptyAttempt: WorkbenchMessage = {
    ...processMessage('empty-attempt', 'attempt-empty'), blocks: [],
  }
  render(<MessageList messages={[previous, emptyAttempt]} conversationKey="empty-attempt-thread"
    isWaitingForAssistant />)

  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  expect(screen.getByTestId('final-processing-toggle')).toBeEnabled()
  expect(screen.getByTestId('final-processing-toggle')).toHaveTextContent('已完成')
})

it('does not merge process groups across an invisible attempt', () => {
  preferences.ready = true
  preferences.collapsed = true
  const before = processMessage('before-hidden-boundary', 'same-attempt')
  const after = processMessage('after-hidden-boundary', 'same-attempt')
  const boundary = { ...processMessage('hidden-boundary', 'other-attempt'), blocks: [] }
  render(<MessageList messages={[before, boundary, after]} conversationKey="hidden-boundary-thread" />)

  expect(screen.getAllByTestId('final-processing-toggle')).toHaveLength(2)
  fireEvent.click(screen.getAllByTestId('final-processing-toggle')[0])
  expect(screen.getAllByTestId('turn-process-content')).toHaveLength(1)
})

it('does not inherit disclosure defaults when a mounted message changes attempt identity', () => {
  preferences.ready = true
  preferences.collapsed = false
  const message = processMessage('changed-attempt-message', 'first-attempt')
  const view = render(<MessageList messages={[message]} conversationKey="changed-attempt-thread" />)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')

  preferences.collapsed = true
  view.rerender(<MessageList messages={[{ ...message, attemptId: 'second-attempt' }]}
    conversationKey="changed-attempt-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

it('removes folded process-only follower rows and restores them when expanded', () => {
  preferences.ready = true
  preferences.collapsed = true
  const messages = [processMessage('compact-owner', 'compact-attempt'),
    processMessage('compact-follower', 'compact-attempt')]
  const view = render(<MessageList messages={messages} conversationKey="compact-thread" />)

  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(2)
  expect(screen.getAllByTestId('turn-process-content')).toHaveLength(2)
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  view.unmount()
  render(<MessageList messages={messages} conversationKey="compact-thread" />)
  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})

it('folds intermediate replies while preserving artifacts and transcript-gap rows', () => {
  preferences.ready = true
  preferences.collapsed = true
  const owner = processMessage('artifact-owner', 'artifact-attempt')
  const reply = { ...processMessage('artifact-reply', 'artifact-attempt'), content: 'Visible reply' }
  const image = processMessage('artifact-image', 'artifact-attempt')
  image.blocks = [{ id: 'generated-image-call', subtaskId: 'artifact-attempt', type: 'tool',
    toolName: 'image_generation', status: 'done',
    renderPayload: { imageBase64: 'iVBORw0KGgo=', revisedPrompt: 'Owned generated image' } }]
  const gap = processMessage('artifact-gap', 'artifact-attempt')
  render(<MessageList messages={[owner, reply, image, gap]} conversationKey="artifact-thread"
    renderGapAfterMessage={message => message.id === gap.id ? <div>Missing transcript marker</div> : null} />)

  expect(screen.getAllByTestId('message-assistant')).toHaveLength(2)
  expect(screen.getByText('Missing transcript marker')).toBeVisible()
  expect(screen.getByText('Missing transcript marker').previousElementSibling).not.toHaveAttribute('data-message-id', gap.id)
  expect(screen.queryByText('Visible reply')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  expect(screen.getByText('Visible reply')).toBeInTheDocument()
  expect(screen.getByText('Missing transcript marker')).toBeInTheDocument()
})

it('does not turn intentionally folded rows into a transcript gap', () => {
  preferences.ready = true
  preferences.collapsed = true
  const owner = processMessage('adjacency-owner', 'adjacency-attempt')
  const follower = processMessage('adjacency-follower', 'adjacency-attempt')
  render(<MessageList messages={[owner, follower]} conversationKey="adjacency-thread"
    renderGapAfterMessage={(message, next) =>
      message.id === owner.id && next?.id !== follower.id ? <div>False transcript gap</div> : null} />)

  expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  expect(screen.queryByText('False transcript gap')).not.toBeInTheDocument()
})

it('settles earlier tools from the same attempt when a separate stop marker arrives', () => {
  preferences.ready = true
  preferences.collapsed = true
  const start = Date.parse('2026-11-21T02:53:20Z')
  vi.useFakeTimers()
  vi.setSystemTime(start + 250000)
  const message = processMessage('stopped-process', 'stopped-attempt')
  message.status = 'streaming'
  message.blocks = [
    { id: 'stopped-widget', type: 'tool', subtaskId: 'stopped-attempt', toolName: 'show_widget',
      status: 'streaming', createdAt: start },
    { id: 'stopped-fetch', type: 'tool', subtaskId: 'stopped-attempt', toolName: 'WebFetch',
      status: 'pending', createdAt: start },
    { id: 'stopped-agent', type: 'tool', subtaskId: 'stopped-attempt', toolName: 'spawn_agent',
      status: 'pending', createdAt: start, toolInput: { message: 'a long instruction\nwith a private path' } },
  ]
  const view = render(<MessageList messages={[message]} conversationKey="stopped-attempt-thread" />)
  const terminal: WorkbenchMessage = {
    ...message, id: 'stop-marker', status: 'done', blocks: [], runtimeStatus: 'cancelled',
    createdAt: new Date(start + 206000).toISOString(),
  }
  view.rerender(<MessageList messages={[message, terminal]} conversationKey="stopped-attempt-thread" />)

  expect(screen.getByTestId('final-processing-toggle')).toHaveTextContent('已中断')
  expect(screen.getByTestId('final-processing-toggle')).toBeEnabled()
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  fireEvent.click(screen.getByTestId('process-activity-toggle'))
  expect(screen.getByTestId('subagent-tool-block')).toHaveAttribute('data-subagent-lifecycle', 'unknown')
  expect(view.container.querySelector('.animate-spin')).toBeNull()
  expect(screen.queryByText('失败')).not.toBeInTheDocument()
  expect(screen.queryByText('正在获取网页')).not.toBeInTheDocument()
  expect(message.blocks.map(block => block.status)).toEqual(['streaming', 'pending', 'pending'])
  const stoppedContent = view.container.textContent
  act(() => vi.advanceTimersByTime(25000))
  expect(view.container.textContent).toBe(stoppedContent)
})

it('folds a finished turn containing a failed tool and successful retry while preserving the reply', () => {
  preferences.ready = true
  preferences.collapsed = true
  const message = processMessage('retried-tool-process', 'retried-tool-attempt')
  const start = Date.parse(message.createdAt)
  message.status = 'streaming'
  message.blocks = [
    { id: 'failed-glob', type: 'tool', toolName: 'glob', subtaskId: 'retried-tool-attempt',
      status: 'error', createdAt: start, completedAt: start + 1000, toolOutput: 'Access denied' },
    { id: 'retry-glob', type: 'tool', toolName: 'glob', subtaskId: 'retried-tool-attempt',
      status: 'streaming', createdAt: start + 1000 },
  ]
  const view = render(<MessageList messages={[message]} conversationKey="retried-tool-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('final-processing-toggle')).toBeEnabled()
  view.rerender(<MessageList messages={[{ ...message, status: 'done', content: 'Retry succeeded.',
    blocks: [message.blocks[0], { ...message.blocks[1], status: 'done', completedAt: start + 2000 }] }]}
    conversationKey="retried-tool-thread" />)
  const toggle = screen.getByTestId('final-processing-toggle')
  expect(toggle).toBeEnabled()
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveTextContent('已完成')
  expect(screen.queryByTestId('turn-process-content')).not.toBeInTheDocument()
  expect(screen.getByText('Retry succeeded.')).toBeInTheDocument()
  fireEvent.click(toggle)
  expect(screen.getByTestId('turn-process-content')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('process-activity-toggle'))
  expect(screen.getByText('运行失败 glob')).toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

it.each(['failed', 'unknown'] as const)('folds a terminal %s message while retaining its status', status => {
  preferences.ready = true
  preferences.collapsed = true
  const message = processMessage('terminal-fold', 'terminal-fold-attempt')
  message.status = status
  render(<MessageList messages={[message]} conversationKey={`terminal-fold-${status}`} />)
  const toggle = screen.getByTestId('final-processing-toggle')
  expect(toggle).toBeEnabled()
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveTextContent(status === 'failed' ? '执行失败' : '状态待确认')
  fireEvent.click(toggle)
  expect(screen.getByTestId('turn-process-content')).toBeInTheDocument()
})
