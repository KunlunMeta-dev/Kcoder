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

function localDateTime(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month - 1, day, hour, minute)
}

function localTimestamp(year: number, month: number, day: number, hour: number, minute: number) {
  return localDateTime(year, month, day, hour, minute).toISOString()
}

describe('MessageList', () => {
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
  test('shows user message hover actions with time, copy label, and resettable success icon', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(localDateTime(2026, 5, 25, 16, 0))

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '对 bind_shell=openclaw 直接跳过',
            status: 'done',
            createdAt: localTimestamp(2026, 5, 25, 15, 8),
          },
        ]}
      />
    )

    const hoverRegion = screen.getByTestId('message-hover-region')
    const hoverActions = screen.getByTestId('message-hover-actions')
    expect(hoverActions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(hoverActions).not.toHaveClass(
      'group-hover/message:opacity-100',
      'group-focus-within/message:opacity-100'
    )
    expect(hoverRegion).toHaveClass('max-w-[80%]')

    fireEvent.pointerEnter(hoverRegion)
    expect(hoverActions).toHaveClass('opacity-100', 'pointer-events-auto')

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('15:08')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('opacity-0')
    expect(screen.getByTestId('message-hover-time')).toHaveClass('select-none')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('pointer-events-none')
    expect(screen.getByTestId('copy-message-label')).toHaveTextContent('复制')
    expect(screen.getByTestId('copy-message-label')).toHaveClass(
      'opacity-0',
      'group-hover/copy:opacity-100'
    )
    expect(screen.getByTestId('copy-message-label')).not.toHaveClass(
      'group-focus-within/copy:opacity-100'
    )
    expect(screen.getByTestId('copy-message-icon')).toBeInTheDocument()

    vi.useRealTimers()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveAttribute('title', '复制')
    expect(copyButton).not.toHaveClass('opacity-0')

    await userEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('对 bind_shell=openclaw 直接跳过')
    expect(await screen.findByTestId('copy-message-success-icon')).toBeInTheDocument()
    expect(copyButton).toHaveClass('bg-text-primary', 'text-background/70')

    fireEvent.mouseLeave(hoverActions)
    fireEvent.pointerLeave(hoverRegion)
    expect(hoverActions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(screen.getByTestId('copy-message-success-icon')).toBeInTheDocument()
    fireEvent.transitionEnd(screen.getByTestId('copy-message-label'), { propertyName: 'opacity' })
    expect(screen.getByTestId('copy-message-success-icon')).toBeInTheDocument()
    fireEvent.transitionEnd(hoverActions, { propertyName: 'opacity' })
    expect(screen.getByTestId('copy-message-icon')).toBeInTheDocument()
  })

  test('shows edit action only for the final completed user turn and submits edited text', async () => {
    const onEditLastUserMessage = vi.fn().mockResolvedValue(true)
    render(
      <MessageList
        messages={[
          {
            id: 'user-old',
            role: 'user',
            content: '旧问题',
            status: 'done',
            createdAt: '2026-05-25T15:00:00.000+08:00',
          },
          {
            id: 'assistant-old',
            role: 'assistant',
            content: '旧回答',
            status: 'done',
            createdAt: '2026-05-25T15:01:00.000+08:00',
          },
          {
            id: 'user-last',
            role: 'user',
            content: '最后问题',
            status: 'done',
            createdAt: '2026-05-25T15:02:00.000+08:00',
          },
          {
            id: 'assistant-last',
            role: 'assistant',
            content: '最后回答',
            status: 'done',
            createdAt: '2026-05-25T15:03:00.000+08:00',
          },
        ]}
        onEditLastUserMessage={onEditLastUserMessage}
        canEditLastUserMessage
      />
    )

    expect(screen.getAllByTestId('edit-message-button')).toHaveLength(1)

    const lastHoverRegion = screen
      .getByText('最后问题')
      .closest('[data-testid="message-hover-region"]')
    expect(lastHoverRegion).toBeInstanceOf(HTMLElement)
    fireEvent.pointerEnter(lastHoverRegion as HTMLElement)

    expect(screen.getByTestId('edit-message-label')).toHaveTextContent('编辑')
    expect(screen.getByTestId('edit-message-button')).toHaveAttribute('title', '编辑')

    await userEvent.click(screen.getByTestId('edit-message-button'))
    expect(screen.getByTestId('edit-user-message-form')).toBeInTheDocument()
    expect(screen.getByTestId('edit-user-message-textarea')).toHaveValue('最后问题')

    await userEvent.click(screen.getByTestId('cancel-edit-user-message-button'))
    expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()

    fireEvent.pointerEnter(lastHoverRegion as HTMLElement)
    await userEvent.click(screen.getByTestId('edit-message-button'))
    const textarea = screen.getByTestId('edit-user-message-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, '编辑后的问题')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}继续')

    expect(onEditLastUserMessage).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('编辑后的问题\n继续')

    await userEvent.keyboard('{Enter}')

    await waitFor(() =>
      expect(onEditLastUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-last' }),
        '编辑后的问题\n继续'
      )
    )
    expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()
  })

  test('hides edit action while the final user turn is still streaming', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'user-last',
            role: 'user',
            content: '最后问题',
            status: 'done',
            createdAt: '2026-05-25T15:02:00.000+08:00',
          },
          {
            id: 'assistant-last',
            role: 'assistant',
            content: '正在回答',
            status: 'streaming',
            createdAt: '2026-05-25T15:03:00.000+08:00',
          },
        ]}
        onEditLastUserMessage={vi.fn()}
        canEditLastUserMessage
      />
    )

    expect(screen.queryByTestId('edit-message-button')).not.toBeInTheDocument()
  })

  test('collapses long user messages without changing copied content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const content = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行内容`).join('\n')

    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content,
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    const messageContent = screen.getByTestId('user-message-content')
    const toggleButton = screen.getByTestId('toggle-user-message-button')

    expect(messageContent).toHaveClass('max-h-44', 'overflow-hidden')
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false')
    expect(toggleButton).toHaveTextContent('展开')

    await userEvent.click(toggleButton)

    expect(messageContent).not.toHaveClass('max-h-44')
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true')
    expect(toggleButton).toHaveTextContent('收起')

    const hoverRegion = screen.getByTestId('message-hover-region')
    expect(hoverRegion).toHaveClass('max-w-[80%]')
    fireEvent.pointerEnter(hoverRegion)

    await userEvent.click(screen.getByTestId('copy-message-button'))
    expect(writeText).toHaveBeenCalledWith(content)
  })

  test('does not show a collapse control for short user messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: '短消息',
            status: 'done',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('toggle-user-message-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).not.toHaveClass('max-h-44')
  })

  test('does not collapse long runtime guidance messages', () => {
    const content = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行引导`).join('\n')

    render(
      <MessageList
        messages={[
          {
            id: 'guidance-user',
            role: 'user',
            content,
            status: 'done',
            runtimeGuidance: true,
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('toggle-user-message-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).not.toHaveClass('max-h-44')
  })

  test('shows only clock time for messages created today', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(localDateTime(2026, 5, 25, 18, 50))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '今天的消息',
              status: 'done',
              createdAt: localTimestamp(2026, 5, 25, 18, 49),
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('18:49')
      expect(screen.getByTestId('message-hover-time')).not.toHaveTextContent('Mon')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows weekday and clock time for messages created within seven days', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(localDateTime(2026, 6, 29, 18, 50))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '昨天的消息',
              status: 'done',
              createdAt: localTimestamp(2026, 6, 28, 15, 27),
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('星期日15:27')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows date and clock time for messages not created today in the current year', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(localDateTime(2026, 5, 25, 18, 50))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '昨天的消息',
              status: 'done',
              createdAt: localTimestamp(2026, 6, 18, 12, 4),
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('6月18日 12:04')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows year for messages not created this year', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(localDateTime(2026, 5, 25, 18, 50))

      render(
        <MessageList
          messages={[
            {
              id: '1',
              role: 'user',
              content: '去年的消息',
              status: 'done',
              createdAt: localTimestamp(2025, 6, 18, 12, 4),
            },
          ]}
        />
      )

      expect(screen.getByTestId('message-hover-time')).toHaveTextContent('2025年6月18日 12:04')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows assistant message hover actions with time and icon-hover copy label', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(localDateTime(2026, 5, 25, 19, 0))

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '好的，以下是作文内容。',
            status: 'done',
            createdAt: localTimestamp(2026, 5, 25, 18, 38),
          },
        ]}
      />
    )

    const hoverRegion = screen.getByTestId('message-hover-region')
    const hoverActions = screen.getByTestId('message-hover-actions')
    expect(hoverActions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(hoverActions).not.toHaveClass(
      'group-hover/message:opacity-100',
      'group-focus-within/message:opacity-100'
    )
    expect(hoverRegion).toHaveClass('w-full', 'max-w-full')

    fireEvent.pointerEnter(hoverRegion)
    expect(hoverActions).toHaveClass('opacity-100', 'pointer-events-auto')

    expect(screen.getByTestId('message-hover-time')).toHaveTextContent('18:38')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('opacity-0')
    expect(screen.getByTestId('message-hover-time')).toHaveClass('select-none')
    expect(screen.getByTestId('message-hover-time')).not.toHaveClass('pointer-events-none')
    expect(screen.getByTestId('copy-message-label')).toHaveTextContent('复制')
    expect(screen.getByTestId('copy-message-label')).toHaveClass(
      'opacity-0',
      'group-hover/copy:opacity-100'
    )
    expect(screen.getByTestId('copy-message-label')).not.toHaveClass(
      'group-focus-within/copy:opacity-100'
    )

    vi.useRealTimers()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const copyButton = screen.getByTestId('copy-message-button')
    expect(copyButton).toHaveAttribute('title', '复制')
    expect(copyButton).not.toHaveClass('opacity-0')

    await userEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('好的，以下是作文内容。')
  })

  test('continues a completed Codex turn in a new task', async () => {
    let resolveFork: (() => void) | undefined
    const onForkMessage = vi.fn(() => new Promise<void>(resolve => (resolveFork = resolve)))
    const message = {
      id: 'assistant-turn-1',
      role: 'assistant' as const,
      content: '已完成当前修改。',
      status: 'done' as const,
      turnId: 'turn-1',
      createdAt: '2026-05-25T18:38:00.000+08:00',
    }

    render(<MessageList messages={[message]} onForkMessage={onForkMessage} />)

    const button = screen.getByTestId('fork-message-button')
    expect(button).toHaveAttribute('aria-label', '在新任务中继续')
    await userEvent.click(button)
    expect(onForkMessage).toHaveBeenCalledWith(message)
    expect(button).toBeDisabled()

    await userEvent.click(button)
    expect(onForkMessage).toHaveBeenCalledTimes(1)

    resolveFork?.()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  test('hides assistant hover actions while the response is streaming', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '我正在处理你的请求。',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('message-hover-time')).not.toBeInTheDocument()
    expect(screen.queryByTestId('copy-message-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('shows waiting rather than invented reasoning before the first response arrives', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
    const thinkingIndicator = screen.getByTestId('thinking-indicator')
    expect(thinkingIndicator).toHaveTextContent('等待响应')
    expect(thinkingIndicator).not.toHaveClass('bg-surface')
    expect(screen.getByText('等待响应')).toHaveClass('waiting-thinking-text')
  })

  test('does not label body output as thinking', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '我先',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    const status = screen.getByText('1 秒')

    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /已处理/ })).not.toBeInTheDocument()
    expect(status.parentElement).toHaveAttribute('data-testid', 'processing-summary-header')
    expect(status.parentElement).not.toHaveClass('border-b')
    expect(screen.getByTestId('message-hover-region')).toHaveClass('w-full', 'max-w-full')
  })

  test('starts the live processing timer when the first visible response appears', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-25T18:46:08.000+08:00'))

      render(
        <MessageList
          messages={[
            {
              id: '2',
              role: 'assistant',
              content: '我先',
              status: 'streaming',
              createdAt: '2026-05-25T18:46:00.000+08:00',
            },
          ]}
        />
      )

      expect(screen.getByText('1 秒')).toBeInTheDocument()
      expect(screen.queryByText('8 秒')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows thinking in the message list while waiting for the assistant response', () => {
    render(
      <MessageList
        isWaitingForAssistant
        messages={[
          {
            id: '1',
            role: 'user',
            content: 'hi',
            status: 'done',
            createdAt: '2026-05-25T18:45:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.queryByText(/已处理/)).not.toBeInTheDocument()
    const thinkingIndicator = screen.getByTestId('thinking-indicator')
    expect(thinkingIndicator).toHaveTextContent('等待响应')
    expect(thinkingIndicator).not.toHaveClass('bg-surface')
    expect(screen.getByText('等待响应')).toHaveClass('waiting-thinking-text')
  })

  test('shows thinking between active Goal turns after the previous assistant message settles', () => {
    render(
      <MessageList
        isWaitingForAssistant
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '本轮完成，准备继续',
            status: 'done',
            createdAt: '2026-05-25T18:45:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('等待响应')
  })

  test('keeps the retry card visible while waiting for the retried response', () => {
    render(
      <MessageList
        isWaitingForAssistant
        messages={[
          {
            id: '1',
            role: 'user',
            content: 'hi',
            status: 'done',
            createdAt: '2026-05-25T18:45:00.000+08:00',
          },
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'temporary failure',
            createdAt: '2026-05-25T18:45:01.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
    expect(screen.getByTestId('message-assistant-waiting')).toBeInTheDocument()
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('等待响应')
  })

  test('does not show thinking while completed processing activity is visible', () => {
    const completedBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
      toolOutput: '/workspace/project',
      status: 'done',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [completedBlock],
          },
        ]}
      />
    )

    expect(screen.getByText('运行 pwd')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('does not duplicate thinking when live process text is visible', () => {
    const processBlock: ProcessingBlock = {
      id: 'text-1',
      subtaskId: 1,
      type: 'text',
      content: 'Let me inspect the repository first.',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [processBlock],
          },
        ]}
      />
    )

    expect(screen.getByText('Let me inspect the repository first.')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('collapses tool rows and shows trailing thinking once final text is visible', () => {
    const runningBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'rg -n "foo" src' },
      status: 'done',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: 'Let me explore the repo structure for you.',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [runningBlock],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-block-thinking')).not.toBeInTheDocument()
    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  test('renders process text inside the processing timeline before the following tool', () => {
    const processBlock: ProcessingBlock = {
      id: 'text-1',
      subtaskId: 1,
      type: 'text',
      content: 'Let me explore the repository structure.',
      status: 'done',
      createdAt: 1770000000000,
    }
    const runningBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      status: 'streaming',
      createdAt: 1770000000001,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [processBlock, runningBlock],
          },
        ]}
      />
    )

    const processText = screen.getByTestId('process-text-block')
    const runningTool = screen.getByText('正在搜索代码')

    expect(processText.compareDocumentPosition(runningTool)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('does not insert thinking or waiting before subsequent process text', () => {
    const completedBlock: ProcessingBlock = {
      id: 'call-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'uptime' },
      status: 'done',
      createdAt: 1770000000000,
    }
    const processBlock: ProcessingBlock = {
      id: 'text-1',
      subtaskId: 1,
      type: 'text',
      content: '负载均值明显偏高。',
      status: 'streaming',
      createdAt: 1770000000001,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [completedBlock, processBlock],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-block-waiting')).not.toBeInTheDocument()
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-text-block')).toHaveTextContent('负载均值明显偏高。')
  })

  test('keeps context compaction visible between separate tool groups', () => {
    const command = (id: string, createdAt: number): ProcessingBlock => ({
      id,
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
      status: 'done',
      createdAt,
    })
    const contextCompaction: ProcessingBlock = {
      id: 'context-compaction-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'context_compaction',
      status: 'done',
      createdAt: 1770000001000,
    }

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-context-compaction',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [
              command('command-before', 1770000000000),
              contextCompaction,
              command('command-after', 1770000002000),
            ],
          },
        ]}
      />
    )

    expect(screen.getByText('上下文已自动压缩')).toBeInTheDocument()
    expect(screen.getAllByTestId('processing-summary-toggle')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /调用 1 个工具 已处理/ })).toHaveLength(2)
  })

  test('preserves tool summaries between narrative blocks in runtime guidance turns', () => {
    const files = Array.from({ length: 3 }, (_, index) => ({
      path: `src/edited-${index + 1}.ts`,
      change_type: 'modified' as const,
      additions: 1,
      deletions: 0,
      binary: false,
    }))
    const blocks: ProcessingBlock[] = [
      {
        id: 'guidance-1',
        subtaskId: 1,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: '继续检查读取记录' },
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'text-before',
        subtaskId: 1,
        type: 'text',
        content: '我先核对读取记录。',
        status: 'done',
        createdAt: 1770000001000,
      },
      {
        id: 'search-1',
        subtaskId: 1,
        type: 'tool',
        toolName: 'bash',
        toolInput: { command: 'rg -n toolBlock src' },
        status: 'done',
        createdAt: 1770000002000,
      },
      ...Array.from({ length: 3 }, (_, index): ProcessingBlock => ({
        id: `read-${index + 1}`,
        subtaskId: 1,
        type: 'tool',
        toolName: 'bash',
        toolInput: { command: `sed -n '1,20p' src/file-${index + 1}.ts` },
        status: 'done',
        createdAt: 1770000003000 + index,
      })),
      {
        id: 'text-after',
        subtaskId: 1,
        type: 'text',
        content: '读取记录确认存在。',
        status: 'done',
        createdAt: 1770000004000,
      },
      {
        id: 'file-changes-1',
        subtaskId: 1,
        type: 'file_changes',
        status: 'done',
        createdAt: 1770000005000,
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'artifact-1',
          device_id: 'device-1',
          workspace_path: '/workspace/project',
          file_count: 3,
          additions: 3,
          deletions: 0,
          files,
          reverted_at: null,
          revertible: false,
        },
      },
    ]

    render(
      <MessageList
        messages={[
          {
            id: 'assistant-guidance-tools',
            role: 'assistant',
            content: '',
            status: 'done',
            runtimeGuidanceContinuation: true,
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks,
          },
        ]}
      />
    )

    const before = screen.getByText('我先核对读取记录。')
    const toolSummary = screen.getByRole('button', { name: /调用 4 个工具 已处理/ })
    const after = screen.getByText('读取记录确认存在。')
    const editSummary = screen.getByRole('button', { name: /编辑 3 个文件 已处理/ })

    expect(toolSummary).toHaveAttribute('data-testid', 'processing-summary-toggle')
    expect(editSummary).toHaveAttribute('data-testid', 'processing-summary-toggle')
    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(screen.getByText('引导对话')).toBeInTheDocument()
    fireEvent.click(toolSummary)
    expect(screen.getByLabelText('搜索 1')).toBeInTheDocument()
    expect(screen.getByLabelText('读取 3')).toBeInTheDocument()
    expect(screen.getByLabelText('编辑 3')).toBeInTheDocument()
    expect(before.compareDocumentPosition(toolSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(toolSummary.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(after.compareDocumentPosition(editSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    expect(screen.getByText('读取 file-1.ts')).toBeInTheDocument()
    expect(screen.getByText('读取 file-2.ts')).toBeInTheDocument()
    expect(screen.getByText('读取 file-3.ts')).toBeInTheDocument()
  })

  test('keeps process text even when it matches the final assistant content', () => {
    const finalTextBlock: ProcessingBlock = {
      id: 'text-final',
      subtaskId: 1,
      type: 'text',
      content: '这是最终回答。',
      status: 'done',
      createdAt: 1770000000000,
    }

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '这是最终回答。',
            status: 'done',
            createdAt: '2026-05-25T18:46:00.000+08:00',
            blocks: [finalTextBlock],
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getByTestId('process-text-block')).toHaveTextContent('这是最终回答。')
    expect(screen.getAllByText('这是最终回答。')).toHaveLength(2)
  })
})
