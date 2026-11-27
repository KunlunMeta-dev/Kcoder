import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageList } from './MessageList'
import { localSkillReference } from '@/lib/local-skill-reference'
import { runtimeMessagesToWorkbenchMessages } from '@/features/workbench/runtimePaneMessages'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import type { WorkbenchMessage } from '@/types/workbench'
import '@/i18n'

const runtimeCommandMock = vi.hoisted(() => ({
  clientResourceUrl: vi.fn((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`),
  invoke: vi.fn(),
  isGateway: vi.fn(() => false),
}))
const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const requestEmbeddedBrowserOpenMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/lib/client-resource-url', () => runtimeCommandMock)
vi.mock('@/lib/runtime-commands', () => ({ invoke: runtimeCommandMock.invoke }))

vi.mock('@/lib/external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/external-links')>()),
  openExternalUrl: openExternalUrlMock,
}))
vi.mock('@/lib/embedded-browser', () => ({
  requestEmbeddedBrowserOpen: requestEmbeddedBrowserOpenMock,
}))

describe('MessageList', () => {
  function failedProcess(index: number): WorkbenchMessage {
    return {
      id: `failure-${index}`, role: 'assistant', status: 'failed', content: '',
      turnId: `turn-${index}`, attemptId: `attempt-${index}`, createdAt: '2026-11-22T00:00:00Z',
      error: `Recorded failure ${index}`,
      blocks: [{ id: `read-${index}`, type: 'tool', toolName: 'read', status: 'done',
        createdAt: 1795305600000, toolInput: { file_path: 'README.md' }, toolOutput: 'Owned output' }],
    }
  }

  test('keeps historical failures in their own process summary and preserves the latest recovery identity', () => {
    const messages = [1, 2, 3, 4, 5].map(failedProcess)
    const original = JSON.stringify(messages)
    const retry = vi.fn()
    render(<MessageList messages={messages} conversationKey="failure-history" onRetryFailedMessage={retry} />)
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(1)
    expect(screen.getAllByTestId('final-processing-toggle')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('assistant-error-retry'))
    expect(retry).toHaveBeenCalledWith(messages[4])
    fireEvent.click(screen.getAllByTestId('final-processing-toggle')[0])
    const history = screen.getAllByTestId('assistant-error-card').find(card => card.dataset.presentation === 'history')!
    expect(history).not.toHaveClass('border')
    expect(screen.queryByText('Recorded failure 1')).not.toBeInTheDocument()
    fireEvent.click(within(history).getByTestId('assistant-error-details-toggle'))
    expect(within(history).getByTestId('assistant-error-details')).toHaveTextContent('Recorded failure 1')
    expect(screen.getAllByTestId('assistant-error-retry')).toHaveLength(1)
    expect(JSON.stringify(messages)).toBe(original)
  })

  test.each([true, false])('folds repeated failures of one confirmed attempt without losing records (process=%s)', hasProcess => {
    const messages = [1, 2, 3, 4, 5].map(index => ({ ...failedProcess(index),
      turnId: 'same-turn', attemptId: 'same-attempt', ...(hasProcess ? {} : { blocks: [] }) }))
    render(<MessageList messages={messages} conversationKey={`same-failure-${hasProcess}`} onRetryFailedMessage={vi.fn()} />)
    expect(screen.getAllByTestId('final-processing-toggle')).toHaveLength(1)
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(1)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(5)
    expect(screen.getAllByTestId('assistant-error-historical')).toHaveLength(4)
    expect(screen.getAllByTestId('assistant-error-retry')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(1)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(2)
  })

  test('keeps a failed terminal record and its recovery even when no error text was supplied', () => {
    const process = { ...failedProcess(1), status: 'done' as const, error: undefined }
    const terminal = { ...process, id: 'failed-terminal', status: 'failed' as const, blocks: [] }
    const retry = vi.fn()
    render(<MessageList messages={[process, terminal]} onRetryFailedMessage={retry} />)
    expect(screen.getByTestId('assistant-error-card')).toBeVisible()
    expect(screen.getByTestId('assistant-error-retry')).toBeEnabled()
    fireEvent.click(screen.getByTestId('assistant-error-retry'))
    expect(retry).toHaveBeenCalledWith(terminal)
  })

  test('puts raw failed content without an error field in details while retaining useful partial output', () => {
    const message = { ...failedProcess(1), blocks: [], error: undefined,
      content: 'API error: upstream request timed out' }
    const view = render(<MessageList messages={[message]} />)
    expect(screen.queryByTestId('assistant-message-content')).not.toBeInTheDocument()
    expect(screen.queryByText(message.content)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-error-details-toggle'))
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(message.content)
    view.rerender(<MessageList messages={[{ ...message, content: 'Useful partial answer before the request failed.' }]} />)
    expect(screen.getByTestId('assistant-message-content')).toHaveTextContent('Useful partial answer')
  })

  test('omits manually folded live siblings instead of leaving empty message gaps', () => {
    const messages = [1, 2, 3, 4, 5].map(index => ({ ...failedProcess(index), turnId: 'live-turn',
      attemptId: 'live-attempt', status: 'streaming' as const, error: undefined }))
    const view = render(<MessageList messages={messages} conversationKey="live-empty-gaps" />)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(screen.queryByTestId('turn-process-content')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('final-processing-toggle'))
    view.rerender(<MessageList messages={[...messages, { ...messages[4], id: 'new-sibling' }]} conversationKey="live-empty-gaps" />)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
  })

  test('does not revive an older failure when the latest sibling is folded', () => {
    const failure = failedProcess(1)
    const latest = { ...failure, id: 'active-sibling', status: 'streaming' as const, error: undefined }
    render(<MessageList messages={[failure, latest]} conversationKey="latest-hidden-owner" onRetryFailedMessage={vi.fn()} />)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(screen.queryByTestId('assistant-error-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
  })

  test('legacy historical failures are inline and reserve no hidden action row', () => {
    const messages = [1, 2, 3].map(index => ({ ...failedProcess(index), attemptId: undefined }))
    render(<MessageList messages={messages} />)
    const history = screen.getAllByTestId('assistant-error-card').find(card => card.dataset.presentation === 'history')!
    expect(history).not.toHaveClass('border')
    expect(screen.getAllByTestId('message-hover-actions')).toHaveLength(1)
    fireEvent.click(within(history).getByTestId('assistant-error-details-toggle'))
    expect(screen.getAllByTestId('message-hover-actions')).toHaveLength(2)
  })

  test('keeps an empty future attempt visible and offers no retry or execution action', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'future-attempt',
            role: 'assistant',
            content: '',
            status: 'unknown',
            rawStatus: 'future_cleanup',
            runtimeStatus: 'unknown',
            createdAt: '',
            turnId: 'turn-1',
            attemptId: 'attempt-1',
          },
        ]}
        onRetryFailedMessage={vi.fn()}
      />
    )
    expect(screen.getByTestId('assistant-attempt-unknown')).toBeVisible()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-stopped-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-message-content')).not.toBeInTheDocument()
  })

  test('only the latest failed attempt offers recovery while older failures retain details', () => {
    const messages = [1, 2, 3].map(index => ({
      id: `failure-${index}`,
      role: 'assistant' as const,
      content: '',
      createdAt: '',
      status: 'failed' as const,
      error: `Saved failure ${index}`,
      turnId: `turn-${index}`,
    }))
    render(
      <MessageList
        messages={messages}
        onRetryFailedMessage={vi.fn()}
        onSwitchModelForFailedMessage={vi.fn()}
      />
    )
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(3)
    expect(screen.getAllByTestId('assistant-error-retry')).toHaveLength(1)
    expect(screen.getAllByTestId('assistant-error-switch-model-retry')).toHaveLength(1)
    expect(screen.getAllByTestId('assistant-error-historical')).toHaveLength(2)
    expect(screen.getAllByTestId('assistant-error-details-toggle')).toHaveLength(3)
    fireEvent.click(screen.getAllByTestId('assistant-error-details-toggle')[0])
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent('Saved failure 1')
  })

  test('a successful later response retires earlier recovery actions without claiming they succeeded', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'old',
            role: 'assistant',
            content: '',
            createdAt: '',
            status: 'failed',
            error: 'old diagnostic',
          },
          { id: 'new', role: 'assistant', content: 'New answer', createdAt: '', status: 'done' },
        ]}
        onRetryFailedMessage={vi.fn()}
      />
    )
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-historical')).toBeVisible()
    expect(screen.queryByTestId('assistant-error-continued')).not.toBeInTheDocument()
  })

  test('retains the failed attempt after accepted continuation without labelling it cancelled', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'continued-failure',
            role: 'assistant',
            content: 'Partial answer remains',
            status: 'failed',
            runtimeStatus: 'failed',
            createdAt: '',
            error: 'HTTP 503',
            continuationAccepted: true,
          },
        ]}
      />
    )
    expect(screen.getByText('Partial answer remains')).toBeVisible()
    expect(screen.getByTestId('assistant-error-card')).toBeVisible()
    expect(screen.getByTestId('assistant-error-continued')).toBeVisible()
    expect(screen.queryByTestId('assistant-stopped-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details-toggle')).toBeVisible()
  })

  test.each([
    {
      continuationAccepted: true,
      retriedByMessageId: undefined,
      marker: 'assistant-error-continued',
    },
    {
      continuationAccepted: false,
      retriedByMessageId: 'next-attempt',
      marker: 'assistant-error-retried',
    },
  ])('retains the failed attempt after recovery: $marker', ({ marker, ...recovery }) => {
    render(
      <MessageList
        messages={[
          {
            id: 'continued-failure',
            role: 'assistant',
            content: 'Partial answer remains',
            status: 'failed',
            runtimeStatus: 'failed',
            createdAt: '',
            error: 'HTTP 503',
            ...recovery,
          },
        ]}
      />
    )
    expect(screen.getByText('Partial answer remains')).toBeVisible()
    expect(screen.getByTestId('assistant-error-card')).toBeVisible()
    expect(screen.getByTestId(marker)).toBeVisible()
    expect(screen.queryByTestId('assistant-stopped-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-details-toggle')).toBeVisible()
  })

  test('recovered failures keep evidence behind details without stale configuration warnings', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'past-failure',
            role: 'assistant',
            content: '',
            createdAt: '',
            status: 'failed',
            error: 'saved diagnostic',
            continuationAccepted: true,
            providerFailure: {
              category: 'authentication_error',
              recovery_action: 'needs_human',
              retryable: false,
              resume_safe: false,
            },
          },
        ]}
      />
    )
    expect(screen.getByTestId('assistant-error-continued')).toBeVisible()
    expect(screen.queryByText('API 认证失败')).not.toBeInTheDocument()
    expect(screen.queryByText(/需要人工处理/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('assistant-error-details-toggle'))
    expect(screen.getByText('API 认证失败')).toBeVisible()
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent('saved diagnostic')
  })

  test.each([
    ['authentication_error', 'needs_human', 'API 认证失败', false],
    ['forbidden', 'needs_human', '访问被拒绝', false],
    ['model_or_route', 'needs_human', '模型名称或 API 地址配置需要检查', false],
    ['quota_exceeded', 'needs_human', '当前模型的使用额度已耗尽', false],
    ['provider_error', 'diagnose_only', '模型服务异常', false],
    ['rate_limit', 'diagnose_only', '请求过于频繁', false],
    ['network_error', 'diagnose_only', '网络连接失败', false],
    ['timeout_error', 'diagnose_only', '请求超时', true],
  ] as const)(
    'trusted %s facts determine the error card and preserve partial output',
    (category, recovery_action, title, partial) => {
      const onRetry = vi.fn()
      const onSwitchModel = vi.fn()
      const messages = runtimeMessagesToWorkbenchMessages([
        {
          id: 'typed-failure',
          role: 'assistant',
          content: partial ? '已经生成的部分回答仍然可见。' : '',
          status: 'failed',
          error: 'HTTP 401 quota exceeded network timeout model not found',
          errorType: 'invalid_parameter',
          providerFailure: {
            category,
            recovery_action,
            retryable: false,
            resume_safe: false,
            retry_after_ms: 0,
          },
        },
      ])
      render(
        <MessageList
          messages={messages}
          onRetryFailedMessage={onRetry}
          onSwitchModelForFailedMessage={onSwitchModel}
        />
      )
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
    }
  )
  test.each([true, false])(
    'context preflight actions follow the saved checkpoint: %s',
    async available => {
      const onSwitchModel = vi.fn()
      const onRetry = vi.fn()
      render(
        <MessageList
          messages={[
            {
              id: 'context-failure',
              role: 'assistant',
              content: '',
              status: 'failed',
              turnId: 'turn-1',
              createdAt: '',
              error:
                'Context request blocked before sending: estimated 20000 tokens exceeds the hard input limit 8000.',
              providerFailure: {
                category: 'context_length_exceeded',
                recovery_action: 'needs_human',
                retryable: false,
                resume_safe: false,
                context_preflight: {
                  request_tokens: 20000,
                  input_limit_tokens: 8000,
                  count_is_exact: false,
                  compaction: 'no_compactable_history',
                  continuation_available: available,
                },
              },
            },
          ]}
          onRetryFailedMessage={onRetry}
          onSwitchModelForFailedMessage={onSwitchModel}
        />
      )
      expect(screen.getByTestId('context-preflight-failure')).toHaveTextContent('20,000')
      expect(screen.getByTestId('context-preflight-failure')).toHaveTextContent('8,000')
      expect(screen.getByTestId('context-preflight-failure')).not.toBeVisible()
      expect(screen.getByText('本次模型请求未发送。')).toBeVisible()
      if (!available) expect(screen.getByText(/没有可用的续接检查点/)).toBeVisible()
      expect(screen.getByText('失败阶段：模型请求发送前的上下文检查')).not.toBeVisible()
      await userEvent.click(screen.getByTestId('assistant-error-details-toggle'))
      expect(screen.getByTestId('context-preflight-failure')).toBeVisible()
      expect(screen.getByText('失败阶段：模型请求发送前的上下文检查')).toBeVisible()
      expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
      if (available) {
        await userEvent.click(screen.getByTestId('assistant-error-switch-model-retry'))
        expect(onSwitchModel).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-1' }))
      } else {
        expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
        await userEvent.click(screen.getByTestId('assistant-error-switch-model'))
        expect(onSwitchModel).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-1' }))
        expect(screen.getByText(/没有可用的续接检查点/)).toBeVisible()
      }
      expect(onRetry).not.toHaveBeenCalled()
    }
  )

  test('legacy context preflight failures never offer a continuation without a checkpoint', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'legacy-context',
            role: 'assistant',
            content: '',
            status: 'failed',
            turnId: 'turn-1',
            createdAt: '',
            error:
              'Context request blocked before sending: estimated 20000 tokens exceeds the hard input limit 8000.',
          },
        ]}
      />
    )
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('上下文长度限制')
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-switch-model')).toHaveTextContent('切换模型')
  })

  test('forwards a legacy diagnostic stored in raw content only to model selection', async () => {
    const onSwitchModel = vi.fn()
    const raw =
      'API Error: Context request blocked before sending: estimated 48264 tokens exceeds the hard input limit 28672.'
    render(
      <MessageList
        messages={[
          {
            id: 'raw-context',
            role: 'assistant',
            content: raw,
            status: 'failed',
            turnId: 'turn-1',
            createdAt: '',
            error: 'Task failed with status: FAILED',
          },
        ]}
        onSwitchModelForFailedMessage={onSwitchModel}
      />
    )
    await userEvent.click(screen.getByTestId('assistant-error-switch-model'))
    expect(onSwitchModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'raw-context', error: raw })
    )
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
  })

  test('fixed tool overhead prompts a larger model instead of blaming conversation history', async () => {
    render(
      <MessageList
        messages={[
          {
            id: 'small-local-model',
            role: 'assistant',
            content: '',
            status: 'failed',
            turnId: 'turn-1',
            createdAt: '',
            error:
              'Context request blocked before sending: fixed overhead exceeds the input limit.',
            providerFailure: {
              category: 'context_length_exceeded',
              recovery_action: 'needs_human',
              retryable: false,
              resume_safe: false,
              context_preflight: {
                request_tokens: 48264,
                input_limit_tokens: 28672,
                count_is_exact: false,
                compaction: 'fixed_overhead_exceeds_limit',
                continuation_available: true,
              },
            },
          },
        ]}
      />
    )
    const card = screen.getByTestId('assistant-error-card')
    expect(card).toHaveTextContent('当前模型上下文不足')
    expect(card).toHaveTextContent('系统指令与已启用工具的固定开销')
    expect(screen.getByText('本次模型请求未发送。')).toBeVisible()
    expect(screen.getByTestId('context-preflight-failure')).not.toBeVisible()
    expect(card).not.toHaveTextContent('检查模型服务配置、凭据')
    expect(screen.getByTestId('assistant-error-switch-model-retry')).toBeVisible()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('assistant-error-details-toggle'))
    expect(screen.getByTestId('context-preflight-failure')).toBeVisible()
    expect(screen.getByTestId('context-preflight-failure')).toHaveTextContent('已跳过历史压缩')
  })

  test('invalid cached facts do not produce typed recovery guidance', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'cache',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'HTTP 401',
            createdAt: '',
            providerFailure: {
              category: 'forbidden',
              recovery_action: 'needs_human',
              retryable: true,
              resume_safe: true,
            },
          },
        ]}
      />
    )
    expect(screen.getByTestId('assistant-error-card')).not.toHaveTextContent('需要人工处理')
  })
  test.each([true, false])('history error card uses validated facts only: %s', valid => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'history-failure',
        role: 'assistant',
        content: '',
        status: 'failed',
        error: 'HTTP 401 quota network',
        providerFailure: {
          category: 'invalid_parameter',
          recovery_action: 'needs_human',
          retryable: false,
          resume_safe: !valid,
        },
      },
    ])
    render(<MessageList messages={messages} />)
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent(
      valid ? '参数错误' : '认证'
    )
    expect(screen.getByTestId('assistant-error-card').textContent?.includes('需要人工处理')).toBe(
      valid
    )
  })
  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  afterEach(() => {
    vi.useRealTimers()
    clearPersistentProcessingExpansions()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    runtimeCommandMock.clientResourceUrl
      .mockReset()
      .mockImplementation((path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`)
    runtimeCommandMock.invoke.mockReset()
    runtimeCommandMock.isGateway.mockReset().mockReturnValue(false)
    openExternalUrlMock.mockClear()
    requestEmbeddedBrowserOpenMock.mockClear()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
  })
  test('keeps local-runtime details and retry without recommending a model switch', async () => {
    const onRetryFailedMessage = vi.fn()
    render(
      <MessageList
        messages={[
          {
            id: 'local-failure',
            role: 'assistant',
            content: '',
            status: 'failed',
            error: 'Storage initialization failed',
            errorType: 'local_runtime_error',
            createdAt: '2026-09-13T00:00:00Z',
          },
        ]}
        onRetryFailedMessage={onRetryFailedMessage}
      />
    )
    expect(screen.getByText('本地运行环境准备失败')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-details')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('assistant-error-details-toggle'))
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(
      'Storage initialization failed'
    )
    await userEvent.click(screen.getByTestId('assistant-error-retry'))
    expect(onRetryFailedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-failure' })
    )
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
    expect(screen.getByText('选择模型并使用当前配置继续')).toBeInTheDocument()
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
    expect(screen.queryByTestId('assistant-error-details')).not.toBeInTheDocument()
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
    expect(screen.queryByTestId('assistant-error-details')).not.toBeInTheDocument()
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

    expect(screen.queryByText(rawError)).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-recovery-facts')).not.toBeVisible()
    await user.click(screen.getByTestId('assistant-error-details-toggle'))

    expect(screen.getByTestId('assistant-error-details-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('assistant-error-details')).toHaveClass('whitespace-pre-wrap')
    expect(screen.getByTestId('assistant-error-details')).toHaveTextContent(rawError)
    expect(screen.getByTestId('assistant-error-recovery-facts')).toBeVisible()
    await user.click(screen.getByTestId('assistant-error-details-toggle'))
    expect(screen.queryByText(rawError)).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-recovery-facts')).not.toBeVisible()
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
            content: 'hello [$env-context](/Users/dev/.codex/skills/env-context/SKILL.md) context',
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

  test.each([
    [String.raw`C:\Users\test\plugins\factory\skills\factory\SKILL.md`, false],
    [String.raw`C:\Users\test\plugins\factory (work)\skills\factory\SKILL.md`, false],
    [String.raw`C:\Users\test\plugins\factory ((work))\skills\factory\SKILL.md`, true],
  ])('renders skill path %s and opens the original target path', (path, encoded) => {
    const onOpenLocalSkillFile = vi.fn()
    render(
      <MessageList
        messages={[
          {
            id: 'windows-skill',
            role: 'user',
            content: encoded
              ? localSkillReference({ name: 'factory', path })
              : `[$factory](${path})`,
            status: 'done',
            createdAt: '2026-11-12T00:00:00Z',
          },
        ]}
        onOpenLocalSkillFile={onOpenLocalSkillFile}
      />
    )
    const token = screen.getByTestId('sent-local-skill-token-factory')
    fireEvent.click(token)
    expect(onOpenLocalSkillFile).toHaveBeenCalledWith(path)
    expect(screen.getByTestId('message-user')).not.toHaveTextContent('C:\\Users')
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

  test.each(['wework', 'kcoder'])(
    'renders %s conversation references without exposing the internal URI',
    scheme => {
      const href = `${scheme}-conversation://%7B%22deviceId%22%3A%22local-device%22%2C%22taskId%22%3A%22runtime-42%22%7D`
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
      expect(screen.queryByText(/(?:wework|kcoder)-conversation:\/\//)).not.toBeInTheDocument()
    }
  )
})

describe('peer turn failure presentation', () => {
  const peerId = 'peer-2-12345678-1234-1234-1234-123456789abc'
  test('a known local peer authorization failure shows its safe reason without model switch or replay', async () => {
    const retry = vi.fn(),
      model = vi.fn()
    render(
      <MessageList
        messages={[
          {
            id: 'local-peer',
            role: 'assistant',
            status: 'failed',
            content: '',
            createdAt: '',
            turnId: peerId,
            error: 'KCoder peer turn authorization failed [peer_provider_start_owner_changed]',
          },
        ]}
        onRetryFailedMessage={retry}
        onSwitchModelForFailedMessage={model}
      />
    )
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('跨会话执行未能继续')
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('当前会话中手动继续')
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('assistant-error-details-toggle'))
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent(
      'peer_provider_start_owner_changed'
    )
    expect(retry).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
  })
  test('old peer unknown stays unknown without inventing a local cause and real HTTP stays a model failure', () => {
    const facts = {
      category: 'provider_error' as const,
      recovery_action: 'diagnose_only' as const,
      retryable: false,
      resume_safe: false,
    }
    const view = render(
      <MessageList
        messages={[
          {
            id: 'old-peer',
            role: 'assistant',
            status: 'failed',
            content: '',
            createdAt: '',
            turnId: peerId,
            providerFailure: facts,
            error: 'Provider error: unknown_error. Response details withheld.',
          },
        ]}
      />
    )
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('未记录具体原因')
    expect(screen.queryByTestId('assistant-error-switch-model-retry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-error-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-card')).not.toHaveTextContent('授权校验')
    view.unmount()
    render(
      <MessageList
        messages={[
          {
            id: 'http-peer',
            role: 'assistant',
            status: 'failed',
            content: '',
            createdAt: '',
            turnId: peerId,
            providerFailure: { ...facts, http_status: 503 },
            error: 'Provider error: unknown_error; HTTP 503. Response details withheld.',
          },
        ]}
      />
    )
    expect(screen.getByTestId('assistant-error-card')).toHaveTextContent('模型服务异常')
    expect(screen.getByTestId('assistant-error-switch-model-retry')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-error-retry')).toBeInTheDocument()
  })
})

vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...actual.useConversationPreferences(), conversationProcessDisplay: 'three-level-v1',
  }) }
})
