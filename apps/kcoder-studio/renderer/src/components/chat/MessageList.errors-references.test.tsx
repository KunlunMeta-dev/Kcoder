import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import { runtimeMessagesToWorkbenchMessages } from '@/features/workbench/runtimePaneMessages'
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
  test.each([
    ['authentication_error', 'needs_human', 'API 认证失败', false],
    ['forbidden', 'needs_human', '访问被拒绝', false],
    ['model_or_route', 'needs_human', '模型名称或 API 地址配置需要检查', false],
    ['quota_exceeded', 'needs_human', '当前模型的使用额度已耗尽', false],
    ['provider_error', 'diagnose_only', '模型服务异常', false],
    ['rate_limit', 'diagnose_only', '请求过于频繁', false],
    ['network_error', 'diagnose_only', '网络连接失败', false],
    ['timeout_error', 'diagnose_only', '请求超时', true],
  ] as const)('trusted %s facts determine the error card and preserve partial output', (category, recovery_action, title, partial) => {
    const onRetry = vi.fn()
    const onSwitchModel = vi.fn()
    const messages = runtimeMessagesToWorkbenchMessages([{
      id: 'typed-failure', role: 'assistant', content: partial ? '已经生成的部分回答仍然可见。' : '', status: 'failed',
      error: 'HTTP 401 quota exceeded network timeout model not found', errorType: 'invalid_parameter',
      providerFailure: { category, recovery_action, retryable: false, resume_safe: false, retry_after_ms: 0 },
    }])
    render(<MessageList messages={messages} onRetryFailedMessage={onRetry} onSwitchModelForFailedMessage={onSwitchModel} />)
    const card = screen.getByTestId('assistant-error-card')
    expect(card).toHaveTextContent(title)
    expect(card.textContent?.includes('需要人工处理')).toBe(recovery_action === 'needs_human')
    if (category === 'model_or_route') {
      expect(card).toHaveTextContent('请核对配置中的模型名称与 API 地址')
      expect(card).not.toHaveTextContent('模型服务异常')
      expect(card).not.toHaveTextContent('模型不存在')
    }
    if (partial) expect(screen.getByText('已经生成的部分回答仍然可见。')).toBeVisible()
    expect(onRetry).not.toHaveBeenCalled()
    expect(onSwitchModel).not.toHaveBeenCalled()
  })
  test('invalid cached facts do not produce typed recovery guidance', () => {
    render(<MessageList messages={[{
      id: 'cache', role: 'assistant', content: '', status: 'failed', error: 'HTTP 401', createdAt: '',
      providerFailure: { category: 'forbidden', recovery_action: 'needs_human', retryable: true, resume_safe: true },
    }]} />)
    expect(screen.getByTestId('assistant-error-card')).not.toHaveTextContent('需要人工处理')
  })
  test.each([true, false])('history error card uses validated facts only: %s', valid => {
    const messages = runtimeMessagesToWorkbenchMessages([{
      id: 'history-failure', role: 'assistant', content: '', status: 'failed', error: 'HTTP 401 quota network',
      providerFailure: {
        category: 'invalid_parameter', recovery_action: 'needs_human', retryable: false,
        resume_safe: !valid,
      },
    }])
    render(<MessageList messages={messages} />)
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent(valid ? '参数错误' : '认证')
    expect(screen.getByTestId('assistant-error-card').textContent?.includes('需要人工处理')).toBe(valid)
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
      .mockImplementation(
        (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`
      )
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.isTauri.mockReset().mockReturnValue(false)
    openExternalUrlMock.mockClear()
    requestEmbeddedBrowserOpenMock.mockClear()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
  })
  test('keeps local-runtime details and retry without recommending a model switch', async () => {
    const onRetryFailedMessage = vi.fn()
    render(<MessageList messages={[{
      id: 'local-failure', role: 'assistant', content: '', status: 'failed',
      error: 'Storage initialization failed', errorType: 'local_runtime_error',
      createdAt: '2026-09-13T00:00:00Z',
    }]} onRetryFailedMessage={onRetryFailedMessage} />)
    expect(screen.getByText('本地运行环境准备失败')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent('Storage initialization failed')
    await userEvent.click(screen.getByTestId('assistant-error-retry'))
    expect(onRetryFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-failure' }))
  })

  test('renders failed assistant messages in the approved error-card layout', () => {
    const rawError =
      'API Error: 400 {"error":{"message":"模型 deepseek-v3.1 不支持 Anthropic 协议, model_id: ali-deepseek-v3.1"}}'

    const { container } = render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: rawError,
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    const errorCard = screen.getByTestId('assistant-error-card')
    expect(errorCard).toBeInTheDocument()
    expect(errorCard).toHaveClass('w-[min(546px,100%)]', 'rounded-[14px]')
    expect(screen.getByText('模型与当前运行协议不匹配')).toBeInTheDocument()
    expect(screen.getByText('切换模型并重试')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-switch-model-retry')).toHaveClass(
      'bg-text-primary',
      'text-background'
    )
    expect(screen.getByTestId('assistant-error-switch-model-retry')).not.toHaveClass(
      'bg-primary',
      'text-bg-base'
    )
    expect(screen.getByText('重试')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(rawError)
    expect(screen.getByTestId('assistant-error-details')).toHaveClass('truncate')
    expect(container.querySelector('.assistant-markdown')).not.toBeInTheDocument()
    expect(screen.queryByText(rawError, { selector: 'p.text-red-500' })).not.toBeInTheDocument()
  })

  test('renders retry card for failed assistant messages without error details', async () => {
    const user = userEvent.setup()
    const onRetryFailedMessage = vi.fn()

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
        onRetryFailedMessage={onRetryFailedMessage}
      />
    )

    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
    expect(screen.getByText('消息生成失败')).toBeInTheDocument()
    expect(screen.getByText('请求未能完成。你可以稍后重试。')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-details-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-details')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('assistant-error-retry'))

    expect(onRetryFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
  })

  test('classifies hidden raw failed content before generic task status errors', () => {
    const rawError =
      'API Error: 400 {"error":{"message":"模型 deepseek-v3.1 不支持 Anthropic 协议, model_id: ali-deepseek-v3.1"}}'

    const { container } = render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: rawError,
            status: 'failed',
            error: 'Task failed with status: FAILED',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(container.querySelector('.assistant-markdown')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('模型与当前运行协议不匹配')
    expect(
      screen.getByText('ali-deepseek-v3.1 不支持当前运行协议。请切换兼容模型后重试。')
    ).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(rawError)
  })

  test('expands raw error details from the compact details row', async () => {
    const user = userEvent.setup()
    const rawError = 'Task failed with status: FAILED'

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: rawError,
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    await user.click(screen.getByTestId('assistant-error-details-toggle'))

    expect(screen.getByTestId('assistant-error-details-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('assistant-error-details')).toHaveClass('whitespace-pre-wrap')
  })

  test('calls retry and switch-model handlers from failed assistant actions', async () => {
    const user = userEvent.setup()
    const onRetryFailedMessage = vi.fn()
    const onSwitchModelForFailedMessage = vi.fn()

    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'Task failed with status: FAILED',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
        onRetryFailedMessage={onRetryFailedMessage}
        onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
      />
    )

    await user.click(screen.getByTestId('assistant-error-switch-model-retry'))
    await user.click(screen.getByTestId('assistant-error-retry'))

    expect(onRetryFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(onSwitchModelForFailedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(screen.getByTestId('assistant-error-card')).toBeInTheDocument()
  })

  test('uses backend error type before raw error text when rendering failed messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '2',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'network down',
            errorType: 'rate_limit',
            createdAt: '2026-05-25T18:46:00.000+08:00',
          },
        ]}
      />
    )

    expect(screen.getByText('请求过于频繁，请稍后再试')).toBeInTheDocument()
    expect(screen.queryByText('网络连接失败：请检查网络连接后重试')).not.toBeInTheDocument()
  })

  test('keeps regular long content inside the page while tables and highlighted code scroll locally', () => {
    const longToken = 'a'.repeat(120)
    const { container } = render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: longToken,
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
          {
            id: '2',
            role: 'assistant',
            content: [
              `https://example.com/${longToken}`,
              '',
              '| 超长列 |',
              '| --- |',
              `| ${longToken} |`,
              '',
              '```css',
              `.collapsible { color: ${longToken}; }`,
              '```',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('message-user')).not.toHaveClass(
      'overflow-x-hidden',
      'overflow-x-clip'
    )
    expect(screen.getByTestId('message-assistant')).not.toHaveClass(
      'overflow-x-hidden',
      'overflow-x-clip'
    )
    expect(container.querySelector('.assistant-markdown')).toHaveClass('break-words', 'max-w-full')
    expect(container.querySelector('.assistant-markdown')).not.toHaveClass(
      'select-text',
      'overflow-x-hidden',
      'overflow-x-clip'
    )
    expect(container.querySelector('table')?.parentElement).toHaveClass(
      'overflow-x-auto',
      'max-w-full'
    )
    expect(screen.getByTestId('markdown-code-block')).toHaveTextContent('.collapsible')
    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('css')
    expect(screen.getByTestId('markdown-code-block')).toHaveClass('overflow-hidden')
  })

  test('limits highlighted code selection to the code body', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'assistant-code-selection',
            role: 'assistant',
            content: ['```bash', 'git push origin feature/example', '```'].join('\n'),
            status: 'done',
            createdAt: '2026-05-25T00:00:01.000Z',
          },
        ]}
      />
    )

    const block = screen.getByTestId('markdown-code-block')
    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    const code = block.querySelector('code')

    expect(block).toHaveClass('select-none')
    expect(screen.getByTestId('markdown-code-block-language')).toHaveClass('select-none')
    expect(scrollContainer).toHaveClass('select-none')
    expect(code).toHaveClass('select-text')
  })

  test('renders local skill markdown links in user messages', () => {
    const onOpenLocalSkillFile = vi.fn()
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content:
              'hello [$env-context](/Users/dev/.codex/skills/env-context/SKILL.md) context',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
        ]}
        onOpenLocalSkillFile={onOpenLocalSkillFile}
      />
    )

    const skillLink = screen.getByTestId('sent-local-skill-token-env-context')

    expect(skillLink).toHaveAttribute('href', '/Users/dev/.codex/skills/env-context/SKILL.md')
    fireEvent.click(skillLink)
    expect(onOpenLocalSkillFile).toHaveBeenCalledWith(
      '/Users/dev/.codex/skills/env-context/SKILL.md'
    )
    expect(screen.getByTestId('message-user')).toHaveTextContent('hello Env Context context')
  })

  test('renders plugin markdown links in user messages', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content:
              '[$Documents](plugin://documents@openai-primary-runtime) Draft a project memo as a document',
            status: 'done',
            createdAt: '2026-05-25T00:00:00.000Z',
          },
        ]}
      />
    )

    const pluginLink = screen.getByTestId('sent-plugin-token-Documents')

    expect(pluginLink).toHaveAttribute('href', 'plugin://documents@openai-primary-runtime')
    expect(screen.getByTestId('sent-plugin-icon-Documents')).toBeInTheDocument()
    expect(screen.getByTestId('message-user')).toHaveTextContent(
      'Documents Draft a project memo as a document'
    )
    expect(
      screen.queryByText(/plugin:\/\/documents@openai-primary-runtime/)
    ).not.toBeInTheDocument()
  })

  test('renders cloud references in user messages without exposing the internal URI', () => {
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content:
              '[$WEG0001-1](cloud://projects/3/todos/WEG0001-1) 结合代码分析，这个问题可能是因为什么',
            status: 'done',
            createdAt: '2026-07-23T00:00:00.000Z',
          },
        ]}
      />
    )

    const cloudLink = screen.getByTestId('sent-cloud-token-WEG0001-1')

    expect(cloudLink).toHaveAttribute('href', 'cloud://projects/3/todos/WEG0001-1')
    expect(cloudLink).toHaveAttribute('data-cloud-resource-kind', 'todo')
    expect(screen.getByTestId('sent-cloud-icon-WEG0001-1')).toBeInTheDocument()
    expect(screen.getByTestId('message-user')).toHaveTextContent(
      'WEG0001-1 结合代码分析，这个问题可能是因为什么'
    )
    expect(screen.queryByText(/cloud:\/\/projects\/3\/todos/)).not.toBeInTheDocument()
  })

  test('renders conversation references in user messages without exposing the internal URI', () => {
    const href =
      'wework-conversation://%7B%22deviceId%22%3A%22local-device%22%2C%22taskId%22%3A%22runtime-42%22%7D'
    render(
      <MessageList
        messages={[
          {
            id: '1',
            role: 'user',
            content: `[$修复登录流程](${href}) 继续分析`,
            status: 'done',
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ]}
      />
    )

    const conversationLink = screen.getByTestId(/^sent-conversation-token-/)

    expect(conversationLink).toHaveAttribute('href', href)
    expect(screen.getByTestId(/^sent-conversation-icon-/)).toBeInTheDocument()
    expect(screen.getByTestId('message-user')).toHaveTextContent('修复登录流程 继续分析')
    expect(screen.queryByText(/wework-conversation:\/\//)).not.toBeInTheDocument()
  })
})
