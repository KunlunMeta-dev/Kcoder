import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import { ComposerStatusRegion } from './composer/ComposerStatusRegion'
import { ConversationQueuePanel } from './ConversationQueuePanel'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { count?: number; defaultValue?: string }) => {
      if (key === 'queue.paused') return 'Paused'
      if (key === 'composer_status.queue_failures') return `Send issues ${typeof options === 'object' ? options?.count : ''}`
      if (key === 'composer_status.queue_unknown')
        return `Send results to check: ${typeof options === 'object' ? options?.count : ''}`
      if (typeof options === 'string') return options
      return options?.defaultValue ?? key
    },
  }),
}))

const message = (
  status: QueuedWorkbenchMessage['status'],
  id = 'dispatch',
  ownerKey?: string
): QueuedWorkbenchMessage => ({
  id,
  content: 'Synthetic message',
  status,
  createdAt: '2026-11-03T00:00:00Z',
  ...(ownerKey === undefined ? {} : { ownerKey }),
}) as QueuedWorkbenchMessage

const statusSurface = (
  queuedMessages: QueuedWorkbenchMessage[],
  queuePaused = false
) => (
  <ComposerStatusRegion>
    <ConversationQueuePanel
      queuedMessages={queuedMessages}
      guidanceMessages={[]}
      queuePaused={queuePaused}
      presentation="embedded"
    />
  </ComposerStatusRegion>
)

describe('ConversationQueuePanel delivery visibility', () => {
  test('delays only the initial sending-only entry for 200ms, then updates immediately', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(statusSurface([message('sending', 'first', 'owner-a')]))
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()

      act(() => vi.advanceTimersByTime(199))
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByTestId('composer-status-trigger-queue')).toBeInTheDocument()

      rerender(statusSurface([message('accepted', 'first', 'owner-a')]))
      expect(screen.getByTestId('conversation-queue-row-first')).toHaveAttribute(
        'data-status',
        'accepted'
      )
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('restarts a pending delay when the owner or sending item changes', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(statusSurface([message('sending', 'same-id', 'owner-a')]))
      act(() => vi.advanceTimersByTime(100))

      rerender(statusSurface([message('sending', 'same-id', 'owner-b')]))
      act(() => vi.advanceTimersByTime(100))
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()

      rerender(statusSurface([message('sending', 'new-id', 'owner-b')]))
      act(() => vi.advanceTimersByTime(199))
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByTestId('composer-status-trigger-queue')).toBeInTheDocument()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test.each([
    ['queued message', [message('queued')], false],
    ['sending backlog', [message('sending', 'sending'), message('queued', 'queued')], false],
    ['failed message', [message('failed')], false],
    ['unknown receipt', [message('unknown')], false],
    ['paused sending message', [message('sending')], true],
  ] as const)('%s is visible immediately', (_label, messages, paused) => {
    const view = render(statusSurface([...messages], paused))
    expect(screen.getByTestId('composer-status-trigger-queue')).toBeInTheDocument()
    view.unmount()
  })

  test('direct continuation keeps the composer status region absent through sending and acceptance', () => {
    const renderQueue = (status: QueuedWorkbenchMessage['status']) => (
      <ComposerStatusRegion>
        <ConversationQueuePanel queuedMessages={[{ ...message(status), directSubmission: true }]}
          guidanceMessages={[]} presentation="embedded" />
      </ComposerStatusRegion>
    )
    const view = render(renderQueue('sending'))
    for (const status of ['sending', 'accepted', 'running', 'completed'] as const) {
      view.rerender(renderQueue(status))
      expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()
      expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()
    }
  })

  test.each(['unknown', 'failed'] as const)('a genuine direct-send %s still shows its recovery row', status => {
    render(<ConversationQueuePanel queuedMessages={[{ ...message(status), directSubmission: true }]}
      guidanceMessages={[]} />)
    expect(screen.getByTestId('conversation-queue-row-dispatch')).toHaveAttribute('data-status', status)
    expect(screen.getByTestId('queue-cancel-button-dispatch')).toBeEnabled()
  })

  test('shows sending and acceptance, then removes the row when execution begins', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />)
      expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(200))
      const row = screen.getByTestId('conversation-queue-row-dispatch')
      expect(row).toHaveAttribute('data-status', 'sending')
      rerender(<ConversationQueuePanel queuedMessages={[message('accepted')]} guidanceMessages={[]} />)
      expect(screen.getByTestId('conversation-queue-row-dispatch')).toBe(row)
      expect(row).toHaveTextContent('input_delivery.accepted')
      rerender(<ConversationQueuePanel queuedMessages={[message('running')]} guidanceMessages={[]} />)
      expect(screen.queryByTestId('conversation-queue-row-dispatch')).not.toBeInTheDocument()
      expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('keeps total count and failed count visible together', async () => {
    render(<ComposerStatusRegion><ConversationQueuePanel queuedMessages={[
      { ...message('queued'), id: 'queued' }, { ...message('failed'), id: 'failed' },
      { ...message('execution_failed'), id: 'execution-failed' },
    ]} guidanceMessages={[]} queuePaused presentation="embedded" /></ComposerStatusRegion>)
    const trigger = await screen.findByTestId('composer-status-trigger-queue')
    expect(trigger).toHaveTextContent('Message queue2Send issues 1')
    expect(trigger.querySelector('.tabular-nums')).toHaveTextContent('2')
    expect(trigger.querySelector('.text-warning')).toHaveTextContent('Send issues 1')
  })

  test('surfaces unknown queued and guidance delivery in the folded summary until applied', async () => {
    const unknownGuidance = {
      id: 'guidance-unknown',
      content: 'Synthetic guidance',
      status: 'unknown',
      createdAt: '2026-11-03T00:00:00Z',
    } as unknown as GuidanceWorkbenchMessage
    const appliedGuidance = { ...unknownGuidance, status: 'applied' }
    const { rerender } = render(
      <ComposerStatusRegion>
        <ConversationQueuePanel
          queuedMessages={[
            { ...message('queued'), id: 'queued' },
            { ...message('unknown'), id: 'unknown' },
            { ...message('failed'), id: 'failed' },
          ]}
          guidanceMessages={[unknownGuidance]}
          presentation="embedded"
        />
      </ComposerStatusRegion>
    )

    const trigger = await screen.findByTestId('composer-status-trigger-queue')
    expect(trigger).toHaveTextContent('Message queue4')
    expect(trigger).toHaveTextContent('Send results to check: 2')
    expect(trigger).toHaveTextContent('Send issues 1')
    expect(trigger).toHaveClass('text-warning')
    expect(
      screen.getByTestId('conversation-queue-row-unknown').querySelector('.text-warning')
    ).toHaveTextContent('input_delivery.unknown')
    expect(screen.getByTestId('conversation-queue-row-guidance-unknown')).toHaveAttribute(
      'data-status',
      'unknown'
    )

    rerender(
      <ComposerStatusRegion>
        <ConversationQueuePanel
          queuedMessages={[
            { ...message('queued'), id: 'queued' },
            { ...message('failed'), id: 'failed' },
            { ...message('applied'), id: 'unknown' },
          ]}
          guidanceMessages={[appliedGuidance]}
          presentation="embedded"
        />
      </ComposerStatusRegion>
    )

    await waitFor(() => expect(trigger).toHaveTextContent('Message queue2'))
    expect(trigger).not.toHaveTextContent('Send results to check')
    expect(trigger).toHaveTextContent('Send issues 1')

    rerender(
      <ComposerStatusRegion>
        <ConversationQueuePanel
          queuedMessages={[message('applied')]}
          guidanceMessages={[appliedGuidance]}
          presentation="embedded"
        />
      </ComposerStatusRegion>
    )
    await waitFor(() =>
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()
    )
  })

  test.each(['accepted', 'unknown'] as const)(
    '%s cannot be replayed through guidance, edit, or interrupt-and-send', status => {
      render(<ConversationQueuePanel queuedMessages={[message(status)]} guidanceMessages={[]} />)
      expect(screen.queryByTestId('queue-guidance-button-dispatch')).not.toBeInTheDocument()
      expect(screen.queryByTestId('queue-interrupt-button-dispatch')).not.toBeInTheDocument()
      expect(screen.queryByTestId('queue-more-button-dispatch')).not.toBeInTheDocument()
      expect(screen.getByTestId('queue-cancel-button-dispatch')).toBeEnabled()
    }
  )

  test.each(['running', 'completed', 'execution_failed', 'interrupted', 'applied'] as const)(
    '%s does not contribute a queue row or a status entry', status => {
      render(<ComposerStatusRegion><ConversationQueuePanel queuedMessages={[message(status)]} guidanceMessages={[]} presentation="embedded" /></ComposerStatusRegion>)
      expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('composer-status-trigger-queue')).not.toBeInTheDocument()
    }
  )

  test('sending can be cancelled, but an unresolved cancellation cannot be clicked twice', () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn()
      const { rerender } = render(<ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} onCancelQueuedMessage={cancel} />)
      act(() => vi.advanceTimersByTime(200))
      fireEvent.click(screen.getByTestId('queue-cancel-button-dispatch'))
      expect(cancel).toHaveBeenCalledWith('dispatch', 'cancel')
      rerender(<ConversationQueuePanel queuedMessages={[{ ...message('unknown'), cancelRequested: true }]} guidanceMessages={[]} onCancelQueuedMessage={cancel} />)
      expect(screen.getByTestId('queue-cancel-button-dispatch')).toBeDisabled()
      expect(screen.getByTestId('conversation-queue-row-dispatch')).toHaveTextContent('input_delivery.cancelling')
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('an empty message list has no panel or placeholder', () => {
    render(<ConversationQueuePanel queuedMessages={[]} guidanceMessages={[]} />)
    expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
  })
})


test('an image-only unknown submission retains a recognizable attachment preview', () => {
  const row = { ...message('unknown', 'image-only'), content: '', attachments: [{ id: 1, filename: 'owned-screenshot.png', file_size: 1, mime_type: 'image/png', status: 'ready' as const, file_extension: 'png', created_at: 'now' }] }
  render(<ConversationQueuePanel queuedMessages={[row]} guidanceMessages={[]} />)
  expect(screen.getByTestId('conversation-queue-row-image-only')).toHaveTextContent('owned-screenshot.png')
})

test('accepted steering explains that individual withdrawal is unavailable', () => {
  const cancel = vi.fn()
  render(<ConversationQueuePanel queuedMessages={[{ ...message('accepted', 'steer'), deliveryMode: 'guidance' }]} guidanceMessages={[]} onCancelQueuedMessage={cancel} presentation="detail" />)
  const button = screen.getByTestId('queue-cancel-button-steer')
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('title', 'input_delivery.guidance_withdraw_unavailable')
  expect(button).toHaveAccessibleName('input_delivery.guidance_withdraw_unavailable')
  fireEvent.click(button)
  expect(cancel).not.toHaveBeenCalled()
})
