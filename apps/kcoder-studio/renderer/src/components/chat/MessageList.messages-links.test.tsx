import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProcessingBlock } from '@/types/workbench'
import { MessageList } from './MessageList'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import '@/i18n'

const tauriCoreMock = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))
const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const requestEmbeddedBrowserOpenMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@tauri-apps/api/core', () => tauriCoreMock)
vi.mock('@/lib/external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/external-links')>()),
  openExternalUrl: openExternalUrlMock,
}))
vi.mock('@/lib/embedded-browser', () => ({
  requestEmbeddedBrowserOpen: requestEmbeddedBrowserOpenMock,
}))

describe('MessageList', () => {
  test('renders a goal badge on goal-first user messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-goal',
            role: 'user',
            content: '实现 goal 功能',
            status: 'done',
            createdAt: '2026-06-10T08:00:00Z',
            runtimeGoalRequest: true,
          },
        ]}
      />
    )

    expect(screen.getByTestId('user-message-goal-badge')).toHaveTextContent('目标')
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('实现 goal 功能')
    expect(screen.getByTestId('user-message-content').lastElementChild).toContainElement(
      screen.getByTestId('user-message-goal-badge')
    )
  })

  test('renders attached comment badges on user messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-comment',
            role: 'user',
            content: '请根据我附加的批注内容继续处理。',
            status: 'done',
            createdAt: '2026-06-10T08:00:00Z',
            codeComments: [
              {
                id: 'browser-comment-1',
                filePath: 'browser:https://example.test/',
                fileName: 'example.test',
                startLine: 1,
                endLine: 1,
                selectedText: '{}',
                comment: '这个导航太抢眼',
                createdAt: '2026-06-10T08:00:00Z',
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-code-comment-context-badge')).toHaveTextContent('1 个评论')
    expect(screen.getByTestId('user-message-content')).not.toHaveTextContent(
      '<workspace_comment_context>'
    )
  })

  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  afterEach(() => {
    vi.useRealTimers()
    clearPersistentProcessingExpansions()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    tauriCoreMock.convertFileSrc
      .mockReset()
      .mockImplementation((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`)
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.isTauri.mockReset().mockReturnValue(false)
    openExternalUrlMock.mockClear()
    requestEmbeddedBrowserOpenMock.mockClear()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
  })

  test('renders user and assistant messages', () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '你好',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
          {
            id: '2',
            role: 'assistant',
            content: '你好，我在。',
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('你好')).toBeInTheDocument()
    expect(screen.getByText('你好，我在。')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('min-w-0')
    expect(container.firstElementChild).not.toHaveClass('overflow-x-hidden', 'overflow-x-clip')
  })

  test('does not render blank completed assistant placeholders', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: '执行pwd',
            status: 'done',
            createdAt: '2026-06-24T08:00:00.000Z',
          },
          {
            id: 'assistant-empty',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
          {
            id: 'user-2',
            role: 'user',
            content: '执行ls',
            status: 'done',
            createdAt: '2026-06-24T08:00:02.000Z',
          },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: 'ls output',
            status: 'done',
            createdAt: '2026-06-24T08:00:03.000Z',
          },
        ]}
      />
    )

    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(screen.getByText('执行pwd')).toBeInTheDocument()
    expect(screen.getByText('执行ls')).toBeInTheDocument()
    expect(screen.getByText('ls output')).toBeInTheDocument()
  })

  test('retains completed reasoning-only turns as collapsed details', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'thinking-1',
        subtaskId: 11,
        type: 'thinking',
        content: '正在执行 pwd',
        status: 'done',
        createdAt: 1770000000000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-blocks',
            role: 'assistant',
            content: '',
            status: 'done',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText('正在执行 pwd')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
    expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('正在执行 pwd')
  })

  test('retains actual reasoning in a collapsed user-expandable section', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'thinking-1',
        subtaskId: 11,
        type: 'thinking',
        content: '不应展示的模型思考字符',
        status: 'streaming',
        createdAt: 1770000000000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-blocks',
            role: 'assistant',
            content: '',
            status: 'streaming',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-thinking-toggle')).toHaveTextContent('正在思考')
    expect(screen.getByTestId('assistant-thinking-spinner')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText('不应展示的模型思考字符')).not.toBeInTheDocument()
    expect(screen.queryByText('思考过程')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
    expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent(
      '不应展示的模型思考字符'
    )
  })

  test('preserves reasoning and tool chronology through updates and completion', () => {
    const thought = (id: string, content: string): ProcessingBlock => ({
      id,
      subtaskId: 11,
      type: 'thinking',
      content,
      status: 'done',
      createdAt: 1770000000000,
    })
    const tool: ProcessingBlock = {
      id: 'ordered-tool',
      subtaskId: 11,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
      status: 'streaming',
      createdAt: 1770000000001,
    }
    const blocks = [thought('before', 'Reasoning before tool'), tool]
    const message = {
      id: 'ordered-message',
      role: 'assistant' as const,
      content: '',
      status: 'streaming' as const,
      createdAt: '2026-06-24T08:00:01.000Z',
      blocks,
    }
    const { container, rerender } = render(<MessageList messages={[message]} />)
    const firstToggle = screen.getByTestId('assistant-thinking-toggle')
    expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument()
    fireEvent.click(firstToggle)
    expect(
      screen
        .getByTestId('assistant-thinking-content')
        .compareDocumentPosition(
          container.querySelector('[data-processing-block-id="ordered-tool"]')!
        )
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    const updatedBlocks: ProcessingBlock[] = [
      blocks[0],
      { ...tool, status: 'done' },
      { ...thought('after', 'Reasoning after tool'), status: 'streaming' },
    ]
    rerender(<MessageList messages={[{ ...message, blocks: updatedBlocks }]} />)
    expect(screen.getAllByTestId('assistant-thinking-toggle')[0]).toBe(firstToggle)
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('assistant-thinking-toggle')[1]).toHaveTextContent('正在思考')
    expect(screen.getAllByTestId('assistant-thinking-spinner')).toHaveLength(1)
    expect(screen.getAllByTestId('assistant-thinking-toggle')[1]).toContainElement(
      screen.getByTestId('assistant-thinking-spinner')
    )
    expect(screen.queryByTestId('tool-block-waiting')).not.toBeInTheDocument()
    const summary = screen.getByTestId('processing-summary-header')
    expect(firstToggle.compareDocumentPosition(summary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(
      summary.compareDocumentPosition(screen.getAllByTestId('assistant-thinking-toggle')[1])
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    rerender(
      <MessageList
        messages={[
          {
            ...message,
            content: 'Final answer',
            status: 'done',
            blocks: updatedBlocks.map(block => ({ ...block, status: 'done' })),
          },
        ]}
      />
    )
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    const toggles = screen.getAllByTestId('assistant-thinking-toggle')
    expect(toggles).toHaveLength(2)
    expect(
      toggles[0].compareDocumentPosition(screen.getByTestId('processing-summary-header'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(
      screen.getByTestId('processing-summary-header').compareDocumentPosition(toggles[1])
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(
      toggles[1].compareDocumentPosition(screen.getByTestId('assistant-message-content'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument()
  })

  test('does not label completed reasoning as running during later tool activity', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-reasoning-finished',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-24T08:00:01.000Z',
            blocks: [
              {
                id: 'thinking-finished',
                subtaskId: 11,
                type: 'thinking',
                content: 'Actual upstream reasoning',
                status: 'done',
                createdAt: 1770000000000,
              },
            ],
          },
        ]}
      />
    )
    expect(screen.getByTestId('assistant-thinking-toggle')).not.toHaveTextContent('正在思考')
    expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument()
  })

  test('keeps completed process text inside the message-level processing group', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'process-1',
        subtaskId: 11,
        type: 'text',
        content: '我会先看这个 skill 当前的流程结构和相关记忆。',
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'tool-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'rg -n workflow' },
        toolOutput: 'ok',
        status: 'done',
        createdAt: 1770000001000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-with-process',
            role: 'assistant',
            content: '最终建议放在 PR flow 里。',
            status: 'done',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('最终建议放在 PR flow 里。')).toBeInTheDocument()
    const finalProcessingToggle = screen.getByTestId('final-processing-toggle')
    expect(finalProcessingToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(finalProcessingToggle)
    expect(screen.getByText('我会先看这个 skill 当前的流程结构和相关记忆。')).toBeInTheDocument()
    const processStatus = screen.getByRole('button', { name: /调用 1 个工具/ })
    expect(
      processStatus.compareDocumentPosition(screen.getByText('最终建议放在 PR flow 里。')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getAllByTestId('processing-collapse-content')).toHaveLength(2)

    fireEvent.click(processStatus)
    expect(screen.getAllByTestId('processing-collapse-content')[1]).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.getByText('搜索代码')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('keeps a running tool visible when streamed answer text appears', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'tool-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolOutput: '/workspace/project\n',
        status: 'streaming',
        createdAt: 1770000000000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-streaming-with-process',
            role: 'assistant',
            content: '这是正在流式输出的最终答案。',
            status: 'streaming',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    const finalAnswer = screen.getByTestId('message-assistant').querySelector('p')
    expect(finalAnswer).toHaveTextContent('这是正在流式输出的最终答案。')
    const processStatus = screen.getByTestId('processing-summary-header')
    const collapseContent = screen.getByTestId('processing-collapse-content')

    expect(
      processStatus.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.getByText('正在运行 pwd')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))

    expect(screen.getByText('/workspace/project')).toBeInTheDocument()
  })

  test('keeps narrative visible but collapses tools before runtime guidance', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'process-1',
        subtaskId: 11,
        type: 'text',
        content: '我正在检查项目结构。',
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'tool-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolOutput: '/workspace/project\n',
        status: 'done',
        createdAt: 1770000001000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-before-guidance',
            role: 'assistant',
            content: '先看一下当前目录。',
            status: 'done',
            blocks,
            runtimeGuidanceSplitBefore: true,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    const collapseContents = screen.getAllByTestId('processing-collapse-content')
    expect(collapseContents).toHaveLength(2)
    expect(collapseContents.some(content => content.getAttribute('aria-hidden') === 'false')).toBe(
      true
    )
    expect(screen.getByText('我正在检查项目结构。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /调用 1 个工具 已处理/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  test('keeps processing expanded for the assistant continuation after runtime guidance', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-after-guidance',
            role: 'assistant',
            content: '继续处理。',
            status: 'done',
            runtimeGuidanceContinuation: true,
            blocks: [
              {
                id: 'guidance-1',
                subtaskId: 12,
                type: 'tool',
                toolName: 'conversation_guidance',
                toolInput: { message: '也看看内存' },
                status: 'done',
                createdAt: 1770000002000,
              },
            ],
            createdAt: '2026-06-24T08:00:02.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(screen.getByText('引导对话')).toBeInTheDocument()
  })

  test('renders final answer web search sources as a source chip', async () => {
    const user = userEvent.setup()
    const blocks: ProcessingBlock[] = [
      {
        id: 'web-search-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'web_search',
        toolInput: {
          type: 'search',
          query: 'site:weather.com weather today Beijing China',
        },
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'web-query-url-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'web_search',
        toolInput: {
          type: 'search',
          query: 'https://www.weather.com/weather/today/l/Beijing+China',
        },
        status: 'done',
        createdAt: 1770000001000,
      },
      {
        id: 'web-open-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'web_search',
        toolInput: {
          type: 'open_page',
          url: 'https://www.weather.com/weather/today/l/Beijing+China',
        },
        status: 'done',
        createdAt: 1770000002000,
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-web-sources',
            role: 'assistant',
            content: '北京今天适合室内活动。',
            status: 'done',
            blocks,
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByText('北京今天适合室内活动。')).toBeInTheDocument()
    expect(screen.getByTestId('web-search-sources-chip')).toHaveTextContent('来源')
    expect(screen.getByTestId('web-search-source-popup')).toHaveTextContent(
      'weather.com/weather/today/l/Beijing+China'
    )
    expect(screen.getAllByTestId('web-search-source-icon').length).toBeGreaterThanOrEqual(1)

    await user.click(screen.getByTestId('web-search-source-popup-row'))

    await waitFor(() =>
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        'https://www.weather.com/weather/today/l/Beijing+China'
      )
    )
  })

  test('keeps processing expansion state scoped to each conversation', () => {
    const blocks: ProcessingBlock[] = [
      {
        id: 'tool-1',
        subtaskId: 11,
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolOutput: '/workspace/project\n',
        status: 'done',
        createdAt: 1770000000000,
      },
    ]
    const buildMessage = (id: string): Parameters<typeof MessageList>[0]['messages'][number] => ({
      id,
      role: 'assistant',
      content: 'Done',
      status: 'done',
      blocks,
      createdAt: '2026-06-24T08:00:01.000Z',
    })

    const { rerender } = render(
      <MessageList conversationKey="conversation-a" messages={[buildMessage('assistant-a')]} />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')

    rerender(
      <MessageList conversationKey="conversation-b" messages={[buildMessage('assistant-b')]} />
    )

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')

    rerender(
      <MessageList conversationKey="conversation-a" messages={[buildMessage('assistant-a')]} />
    )

    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('reserves enough marker gutter for multi-digit ordered lists', () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'assistant-list',
            role: 'assistant',
            content: Array.from(
              { length: 12 },
              (_, index) => `${index + 1}. item ${index + 1}`
            ).join('\n'),
            status: 'done',
            createdAt: '2026-06-21T00:00:00.000Z',
          },
        ]}
      />
    )

    const orderedList = container.querySelector('.assistant-markdown ol')
    expect(orderedList).toHaveClass('pl-8')
    expect(orderedList).not.toHaveClass('pl-5')
  })

  test('renders assistant markdown headings with the semantic theme color', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-headings',
            role: 'assistant',
            content: ['# Heading 1', '## Heading 2', '### Heading 3'].join('\n\n'),
            status: 'done',
            createdAt: '2026-07-09T00:00:00.000Z',
          },
        ]}
      />
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-text-primary')
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-text-primary')
    expect(screen.getByRole('heading', { level: 3 })).toHaveClass('text-text-primary')
  })

  test('routes assistant markdown links through the configured browser target', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-link',
            role: 'assistant',
            content: '[MessageList.tsx](https://example.com/MessageList.tsx)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    const link = screen.getByRole('link', { name: 'MessageList.tsx' })
    expect(link).toHaveClass(
      'inline-flex',
      'items-center',
      'gap-1',
      'rounded-md',
      'text-blue-600',
      'no-underline'
    )
    expect(link).not.toHaveClass('bg-blue-50')
    expect(link).not.toHaveClass('hover:bg-blue-100')
    expect(link).not.toHaveClass('ring-1')
    expect(link).not.toHaveClass('text-primary')
    expect(link).not.toHaveAttribute('target')
    expect(screen.getByTestId('assistant-markdown-link-icon')).toBeInTheDocument()

    fireEvent.click(link)
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/MessageList.tsx')
  })

  test('keeps angle-bracket external link destinations as external links', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-angle-bracket-external-link',
            role: 'assistant',
            content: '[Wegent](<https://github.com/wecode-ai/Wegent>)',
            status: 'done',
            createdAt: '2026-07-13T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByRole('link', { name: 'Wegent' })).toHaveAttribute(
      'href',
      'https://github.com/wecode-ai/Wegent'
    )
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled()
  })

  test('routes assistant file-path links to the workspace file panel', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-file-link',
            role: 'assistant',
            content: '[managing-tasks.md](/Users/dev/repo/docs/zh/managing-tasks.md)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    // A filesystem path must not render as a navigating anchor.
    expect(screen.queryByRole('link', { name: /managing-tasks\.md/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/dev/repo/docs/zh/managing-tasks.md')
  })

  test('routes assistant folder links to the workspace directory panel', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-folder-link',
            role: 'assistant',
            content: '[docs](folder://%2FUsers%2Fdev%2Frepo%2Fdocs)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/dev/repo/docs', {
      isDirectory: true,
    })
  })

  test('opens local HTML file links in the Wework built-in browser', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-html-file-link',
            role: 'assistant',
            content: '[trend.html](/Users/dev/workspace/trend.html)',
            status: 'done',
            createdAt: '2026-07-22T08:00:00.000Z',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(requestEmbeddedBrowserOpenMock).toHaveBeenCalledWith(
      'asset://localhost/Users/dev/workspace/trend.html'
    )
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled()
  })

  test('treats local filesystem paths encoded as Tauri URLs as file links', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-tauri-file-link',
            role: 'assistant',
            content: '[report](tauri://localhost/Users/dev/workspace/report.md)',
            status: 'done',
            createdAt: '2026-07-22T08:00:00.000Z',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/dev/workspace/report.md')
  })

  test('opens Tauri-encoded local HTML paths in the Wework built-in browser', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-tauri-html-file-link',
            role: 'assistant',
            content: '[trend](tauri://localhost/Users/dev/workspace/trend.html)',
            status: 'done',
            createdAt: '2026-07-22T08:00:00.000Z',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(requestEmbeddedBrowserOpenMock).toHaveBeenCalledWith(
      'asset://localhost/Users/dev/workspace/trend.html'
    )
  })

  test('removes angle brackets from assistant file link destinations', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-angle-bracket-file-link',
            role: 'assistant',
            content:
              '[MessageList.tsx](</Users/dev/repo/renderer/src/components/chat/MessageList.tsx:18>)',
            status: 'done',
            createdAt: '2026-07-13T08:00:01.000Z',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      '/Users/dev/repo/renderer/src/components/chat/MessageList.tsx',
      {
        lineStart: 18,
        lineEnd: undefined,
      }
    )
  })

  test('passes assistant file link line numbers to open-file actions', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-file-line-link',
            role: 'assistant',
            content:
              '放在 [references/github-pr-flow.md](references/github-pr-flow.md:18) 的 PR 段落。',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-markdown-link-line')).toHaveTextContent('(line 18)')
    expect(screen.getByTestId('assistant-markdown-link-tooltip')).toHaveTextContent(
      'references/github-pr-flow.md (line 18)'
    )
    expect(screen.getByTestId('assistant-markdown-link-tooltip')).toHaveClass(
      'max-w-[min(36rem,calc(100vw-3rem))]',
      'break-all'
    )
    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('references/github-pr-flow.md', {
      lineStart: 18,
      lineEnd: undefined,
    })
  })

  test('renders assistant file links with extension-specific icons', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-file-type-links',
            role: 'assistant',
            content:
              '[`scripts/build-mac-app.sh`](/Users/dev/dev/git/Wegent/renderer/scripts/build-mac-app.sh:49) and [package.json](/Users/dev/dev/git/Wegent/renderer/package.json:15)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    const links = screen.getAllByTestId('assistant-markdown-link')
    const icons = screen.getAllByTestId('assistant-markdown-link-icon')

    expect(icons[0]).toHaveTextContent('$')
    expect(icons[1]).toHaveTextContent('{}')
    expect(links[0]).toHaveClass('[&_code]:!bg-transparent', '[&_code]:!rounded-none')
    expect(links[0]).toHaveTextContent('scripts/build-mac-app.sh(line 49)')
    expect(links[1]).toHaveTextContent('package.json(line 15)')
  })

  test('keeps normal assistant inline code styled as code chips', () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            id: 'assistant-inline-code',
            role: 'assistant',
            content: 'Use `.env` and `pnpm run tauri:build` for local configuration.',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-markdown-link')).not.toBeInTheDocument()
    const inlineCodes = Array.from(container.querySelectorAll('.assistant-markdown code'))
    expect(inlineCodes).toHaveLength(2)
    expect(inlineCodes[0]).toHaveTextContent('.env')
    expect(inlineCodes[0]).toHaveClass('rounded', 'bg-muted')
    expect(inlineCodes[1]).toHaveTextContent('pnpm run tauri:build')
    expect(inlineCodes[1]).toHaveClass('rounded', 'bg-muted')
  })

  test('routes assistant file links from changed turns to the workspace file panel', async () => {
    const onOpenFileChangesReview = vi.fn()
    const onLoadFileChangesDiff = vi.fn().mockResolvedValue('')
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenFileChangesReview={onOpenFileChangesReview}
        onLoadFileChangesDiff={onLoadFileChangesDiff}
        onRevertFileChanges={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-changed-file-link',
            subtaskId: '42',
            role: 'assistant',
            content: '[managing-tasks.md](docs/zh/user-guide/chat/managing-tasks.md:18)',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-42',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 2,
              deletions: 2,
              files: [
                {
                  path: 'docs/zh/user-guide/chat/managing-tasks.md',
                  change_type: 'modified',
                  additions: 2,
                  deletions: 2,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('docs/zh/user-guide/chat/managing-tasks.md', {
      lineStart: 18,
      lineEnd: undefined,
    })
    expect(onOpenFileChangesReview).not.toHaveBeenCalled()
    expect(onLoadFileChangesDiff).not.toHaveBeenCalled()
  })

  test('renders Codex memory citations and one-column deduped file references', async () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <MessageList
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        messages={[
          {
            id: 'assistant-codex-rich',
            role: 'assistant',
            content:
              'Updated [SKILL.md](/workspace/project/SKILL.md), [github-pr-flow.md](/workspace/project/references/github-pr-flow.md:18), [paas-context.log](/workspace/project/logs/paas-context.log), and [notify_pr_ready.sh](/workspace/project/scripts/notify_pr_ready.sh).',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
            references: [
              { path: '/workspace/project/SKILL.md' },
              { path: '/workspace/project/references/github-pr-flow.md', lineStart: 18 },
              { path: '/workspace/project/SKILL.md:22' },
              { path: '/workspace/project/logs/paas-context.log' },
              { path: '/workspace/project/scripts/notify_pr_ready.sh' },
            ],
            memoryCitations: [
              {
                entries: [
                  {
                    path: 'MEMORY.md',
                    lineStart: 10,
                    lineEnd: 12,
                    note: 'repo guidance',
                  },
                ],
                threadIds: ['thread-1'],
              },
            ],
          },
        ]}
      />
    )

    expect(screen.queryByText('引用文件')).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-memory-citations')).toBeInTheDocument()
    expect(screen.getByTestId('codex-reference-list')).toBeInTheDocument()
    expect(
      screen
        .getByTestId('codex-memory-citations')
        .compareDocumentPosition(screen.getByTestId('codex-reference-list')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    const referenceCards = screen.getAllByTestId('codex-reference-card')
    expect(referenceCards).toHaveLength(2)
    expect(screen.getByTestId('codex-reference-list')).not.toHaveTextContent('paas-context.log')
    expect(screen.getByTestId('codex-reference-list')).not.toHaveTextContent('notify_pr_ready.sh')
    expect(referenceCards[0]).toHaveTextContent('SKILL.md')
    expect(referenceCards[0]).toHaveTextContent('文档 · MD')
    expect(referenceCards[0]).toHaveTextContent('打开预览')
    expect(screen.getAllByTestId('codex-reference-kind-label')[0]).toHaveClass(
      'group-hover/reference-card:opacity-0'
    )
    expect(screen.getAllByTestId('codex-reference-preview-label')[0]).toHaveClass(
      'opacity-0',
      'group-hover/reference-card:opacity-100'
    )
    expect(referenceCards[1]).toHaveTextContent('github-pr-flow.md')

    await userEvent.click(referenceCards[1])
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      '/workspace/project/references/github-pr-flow.md',
      {
        lineStart: 18,
        lineEnd: undefined,
      }
    )

    expect(screen.getByTestId('codex-memory-citations-toggle')).toHaveTextContent('1 条记忆引用')
    await userEvent.click(screen.getByTestId('codex-memory-citations-toggle'))
    const memoryEntry = screen.getByTestId('codex-memory-citation-entry')
    expect(memoryEntry).toHaveTextContent('MEMORY.md')
    expect(memoryEntry).toHaveTextContent('10-12 行')
    expect(memoryEntry).toHaveTextContent('repo guidance')
    expect(memoryEntry).toHaveAttribute('aria-label', '打开 MEMORY.md')
    expect(screen.getByTestId('codex-memory-citation-tooltip')).toHaveTextContent('MEMORY.md')
    expect(screen.getByTestId('codex-memory-citation-tooltip')).toHaveClass(
      'max-w-[min(28rem,calc(100vw-3rem))]',
      'break-all'
    )

    onOpenWorkspaceFile.mockClear()
    await userEvent.click(memoryEntry)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('MEMORY.md', {
      lineStart: 10,
      lineEnd: 12,
    })
  })

  test('waits until streaming finishes before rendering final answer artifacts', () => {
    render(
      <MessageList
        onOpenWorkspaceFile={vi.fn()}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-streaming-artifacts',
            subtaskId: 42,
            role: 'assistant',
            content: 'See [README.md](/workspace/project/README.md) for details.',
            status: 'streaming',
            createdAt: '2026-06-24T08:00:01.000Z',
            references: [{ path: '/workspace/project/README.md' }],
            memoryCitations: [
              {
                entries: [{ path: 'MEMORY.md', lineStart: 10, note: 'repo guidance' }],
                threadIds: ['thread-1'],
              },
            ],
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-42',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 2,
              deletions: 0,
              files: [
                {
                  path: 'README.md',
                  change_type: 'modified',
                  additions: 2,
                  deletions: 0,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-assistant').querySelector('p')).toHaveTextContent(/See/)
    expect(screen.queryByTestId('codex-reference-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('codex-memory-citations')).not.toBeInTheDocument()
    expect(screen.queryByTestId('file-changes-card')).not.toBeInTheDocument()
  })

  test('adds deduped document references from turn file changes and expands hidden references', async () => {
    render(
      <MessageList
        onOpenWorkspaceFile={vi.fn()}
        onLoadFileChangesDiff={vi.fn().mockResolvedValue('')}
        onRevertFileChanges={vi.fn()}
        messages={[
          {
            id: 'assistant-file-change-documents',
            subtaskId: 42,
            role: 'assistant',
            content:
              'Updated [SKILL.md](/workspace/project/SKILL.md) and [wegent-merged-env.md](/workspace/project/references/wegent-merged-env.md).',
            status: 'done',
            createdAt: '2026-06-24T08:00:01.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-42',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 10,
              additions: 64,
              deletions: 130,
              files: [
                {
                  path: 'SKILL.md',
                  change_type: 'modified',
                  additions: 12,
                  deletions: 12,
                  binary: false,
                },
                {
                  path: 'scripts/run_on_integration_env.sh',
                  change_type: 'deleted',
                  additions: 0,
                  deletions: 58,
                  binary: false,
                },
                {
                  path: 'references/acceptance-validation-contract.md',
                  change_type: 'modified',
                  additions: 1,
                  deletions: 1,
                  binary: false,
                },
                {
                  path: 'references/browser-validation.md',
                  change_type: 'modified',
                  additions: 1,
                  deletions: 1,
                  binary: false,
                },
                {
                  path: 'references/github-pr-flow.md',
                  change_type: 'modified',
                  additions: 3,
                  deletions: 3,
                  binary: false,
                },
                {
                  path: 'references/post-review-follow-up.md',
                  change_type: 'modified',
                  additions: 3,
                  deletions: 9,
                  binary: false,
                },
                {
                  path: 'references/pr-review-notification.md',
                  change_type: 'modified',
                  additions: 2,
                  deletions: 2,
                  binary: false,
                },
                {
                  path: 'references/wegent-integration-test-env.md',
                  change_type: 'modified',
                  additions: 22,
                  deletions: 23,
                  binary: false,
                },
                {
                  path: 'references/wegent-merged-env.md',
                  change_type: 'modified',
                  additions: 4,
                  deletions: 4,
                  binary: false,
                },
                {
                  path: 'scripts/start_executor_local.sh',
                  change_type: 'renamed',
                  additions: 1,
                  deletions: 1,
                  binary: false,
                },
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getAllByTestId('codex-reference-card')).toHaveLength(3)
    expect(screen.getByTestId('toggle-codex-reference-list-button')).toHaveTextContent(
      '显示另外 5 个'
    )

    await userEvent.click(screen.getByTestId('toggle-codex-reference-list-button'))

    const expandedReferenceCards = screen.getAllByTestId('codex-reference-card')
    expect(expandedReferenceCards).toHaveLength(8)
    expect(screen.getByTestId('toggle-codex-reference-list-button')).toHaveTextContent('收起文件')
    expect(expandedReferenceCards.map(card => card.textContent)).toEqual([
      expect.stringContaining('SKILL.md'),
      expect.stringContaining('acceptance-validation-contract.md'),
      expect.stringContaining('browser-validation.md'),
      expect.stringContaining('github-pr-flow.md'),
      expect.stringContaining('post-review-follow-up.md'),
      expect.stringContaining('pr-review-notification.md'),
      expect.stringContaining('wegent-integration-test-env.md'),
      expect.stringContaining('wegent-merged-env.md'),
    ])
  })

  test('renders IM source badge for user messages with channel label', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '来自 IM 的消息',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
            source: {
              source: 'im',
              channel_type: 'dingtalk',
              channel_label: '钉钉',
            },
          },
        ]}
      />
    )

    const badge = screen.getByTestId('message-source-badge')
    expect(badge).toHaveTextContent('钉钉')
    expect(badge.closest('.opacity-0')).toBeNull()
    expect(screen.getByTestId('message-source-row')).toContainElement(badge)
  })
})
