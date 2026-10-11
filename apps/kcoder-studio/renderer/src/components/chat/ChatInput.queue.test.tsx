import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { action?: string; count?: number; device?: string; location?: string },
      interpolation?: { model?: string }
    ) => {
      if (typeof options === 'string') {
        return interpolation?.model ? options.replace('{{model}}', interpolation.model) : options
      }
      if (key === 'workbench.goal_standard_label') return '普通目标（/goal）'
      if (key === 'workbench.goal_pro_label') return '严格目标（/goal-pro）'
      if (key === 'workbench.goal_pro_description') return '持续执行目标，并进行独立验证'
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.project_work_trigger_device_aria') {
        return `${options?.action ?? ''}，当前设备 ${options?.device ?? ''}`
      }
      if (key === 'workbench.environment_cloud_device') return '云设备'
      if (key === 'workbench.environment_local') return '本机'
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return key
    },
  }),
}))
describe('ChatInput queue', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalInnerWidth = window.innerWidth
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })
  test('offers interrupt-and-send while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="立即改方向"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        isStreaming
      />
    )

    const menuButton = screen.getByTestId('send-mode-menu-button')
    expect(menuButton).toHaveAttribute('title', '选择发送方式')
    expect(menuButton.querySelector('.lucide-chevron-down')).toBeInTheDocument()

    await userEvent.click(menuButton)
    expect(
      screen.getByTestId('send-after-turn-option').querySelector('.lucide-clock-3')
    ).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('interrupt-and-send-option'))

    expect(onSubmit).toHaveBeenCalledWith('立即改方向', { interruptWhenBusy: true })
  })

  test('renders queued messages and guidance controls above the composer', async () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-1',
        content: '继续检查 capability sync',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
      },
    ]
    const guidanceMessages: GuidanceWorkbenchMessage[] = [
      {
        id: 'guidance-1',
        content: '先跳过 device:sync_capabilities',
        status: 'queued',
        createdAt: '2026-05-25T15:09:00.000+08:00',
      },
    ]
    const onSendQueuedAsGuidance = vi.fn()
    const onInterruptAndSendQueuedMessage = vi.fn()
    const onCancelQueuedMessage = vi.fn()
    const onEditQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={guidanceMessages}
        onSendQueuedAsGuidance={onSendQueuedAsGuidance}
        onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onEditQueuedMessage={onEditQueuedMessage}
      />
    )

    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    expect(screen.getByText('继续检查 capability sync')).toBeInTheDocument()
    expect(screen.getByText('先跳过 device:sync_capabilities')).toBeInTheDocument()
    expect(
      screen.getAllByTestId(/^conversation-queue-row-/).map(row => row.getAttribute('data-testid'))
    ).toEqual(['conversation-queue-row-guidance-1', 'conversation-queue-row-queued-1'])

    await userEvent.click(screen.getByTestId('queue-guidance-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-interrupt-button-guidance-1'))
    await userEvent.click(screen.getByTestId('queue-interrupt-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-cancel-button-queued-1'))

    expect(onSendQueuedAsGuidance).toHaveBeenCalledWith('queued-1')
    expect(onInterruptAndSendQueuedMessage).toHaveBeenNthCalledWith(1, 'guidance-1')
    expect(onInterruptAndSendQueuedMessage).toHaveBeenNthCalledWith(2, 'queued-1')
    expect(onEditQueuedMessage).toHaveBeenCalledWith('queued-1')
    expect(onCancelQueuedMessage).toHaveBeenCalledWith('queued-1')
  })

  test('restores queued message text into the composer when editing', async () => {
    function Harness() {
      const [value, setValue] = useState('')
      const [queuedMessages, setQueuedMessages] = useState<QueuedWorkbenchMessage[]>([
        {
          id: 'queued-1',
          content: '先检查引导条里的文本',
          status: 'queued',
          createdAt: '2026-05-25T15:08:00.000+08:00',
        },
      ])

      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          queuedMessages={queuedMessages}
          onEditQueuedMessage={id => {
            const message = queuedMessages.find(item => item.id === id)
            if (!message) return
            setValue(message.content)
            setQueuedMessages(current => current.filter(item => item.id !== id))
          }}
        />
      )
    }

    render(<Harness />)

    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))

    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveTextContent('先检查引导条里的文本')
    )
  })

  test('shows lightweight interrupt action while guidance is sending', async () => {
    const onInterruptAndSendQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'sending-guidance',
            content: '请停止等待并检查目录',
            status: 'sending',
            notice: '正在引导当前对话',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
      />
    )

    const interruptButton = screen.getByTestId('queue-interrupt-button-sending-guidance')
    expect(screen.getByText('引导中')).toBeInTheDocument()
    expect(interruptButton).toHaveTextContent('workbench.interrupt_and_send_short')
    expect(interruptButton).toHaveClass('text-text-secondary', 'hover:bg-muted')
    expect(interruptButton).not.toHaveClass('border', 'bg-base', 'shadow-sm')
    expect(screen.queryByTestId('queue-guidance-button-sending-guidance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-cancel-button-sending-guidance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-more-button-sending-guidance')).not.toBeInTheDocument()

    await userEvent.click(interruptButton)

    expect(onInterruptAndSendQueuedMessage).toHaveBeenCalledWith('sending-guidance')
  })

  test('shows active queued guidance before messages waiting to send', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-waiting',
            content: '看磁盘',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
          {
            id: 'queued-guidance',
            content: '看 cpu',
            status: 'sending',
            notice: '正在引导当前对话',
            createdAt: '2026-05-25T15:09:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
      />
    )

    expect(
      screen.getAllByTestId(/^conversation-queue-row-/).map(row => row.getAttribute('data-testid'))
    ).toEqual(['conversation-queue-row-queued-guidance', 'conversation-queue-row-queued-waiting'])
  })

  test('shows a control to resume a paused queue', async () => {
    const onResumeQueue = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-paused',
            content: '等待发送',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
        queuePaused
        onResumeQueue={onResumeQueue}
      />
    )

    await userEvent.click(screen.getByTestId('resume-queue-button'))

    expect(onResumeQueue).toHaveBeenCalledTimes(1)
  })

  test('asks whether to preserve a paused queue before sending a new message', async () => {
    const onSubmit = vi.fn()
    const onResumeQueue = vi.fn()
    const onChange = vi.fn()
    const onResumeQueueWithInput = vi.fn()

    render(
      <ChatInput
        value="发送新消息"
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={false}
        queuedMessages={[
          {
            id: 'queued-paused-send',
            content: '等待发送',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
        queuePaused
        onResumeQueue={onResumeQueue}
        onResumeQueueWithInput={onResumeQueueWithInput}
      />
    )

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(screen.getByTestId('paused-queue-send-dialog')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('paused-queue-send-preserve-button'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onResumeQueueWithInput).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('')
  })

  test('keeps queued rows compact without generic queue notices', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-notice',
        content: '执行pwd',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
        notice: '已排队，当前回复结束后发送',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByText('执行pwd')).toBeInTheDocument()
    expect(screen.queryByText('已排队，当前回复结束后发送')).not.toBeInTheDocument()
  })

  test('shows sending notices for queued rows that are actively being sent', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-sending',
        content: '执行ls',
        status: 'sending',
        createdAt: '2026-05-25T15:08:00.000+08:00',
        notice: '正在发送',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByText('执行ls')).toBeInTheDocument()
    expect(screen.getByText('正在发送')).toBeInTheDocument()
  })
})
