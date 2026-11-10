import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { QueuedWorkbenchMessage } from '@/types/workbench'
import { ComposerStatusRegion } from './composer/ComposerStatusRegion'
import { ConversationQueuePanel } from './ConversationQueuePanel'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { count?: number; defaultValue?: string }) => {
      if (key === 'queue.paused') return 'Paused'
      if (key === 'composer_status.queue_attention') {
        return `Failed or expired messages: ${typeof options === 'object' ? options?.count : ''}`
      }
      if (typeof options === 'string') return options
      return options?.defaultValue ?? key
    },
  }),
}))

const message = (status: QueuedWorkbenchMessage['status']): QueuedWorkbenchMessage => ({
  id: 'dispatch',
  content: 'Synthetic message',
  status,
  createdAt: '2026-11-03T00:00:00Z',
})

describe('ConversationQueuePanel dispatch visibility', () => {
  afterEach(() => vi.useRealTimers())

  test('does not mount a panel for a short in-flight dispatch', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />
    )
    expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(80))
    rerender(<ConversationQueuePanel queuedMessages={[]} guidanceMessages={[]} />)
    act(() => vi.runAllTimers())
    expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
  })

  test('shows a slow dispatch and resets the delay for the next independent send', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />
    )
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    rerender(<ConversationQueuePanel queuedMessages={[]} guidanceMessages={[]} />)
    rerender(<ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />)
    expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
  })

  test('shows a real queued message immediately and keeps it visible during dispatch', () => {
    const { rerender } = render(
      <ConversationQueuePanel queuedMessages={[message('queued')]} guidanceMessages={[]} />
    )
    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    rerender(<ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />)
    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
  })

  test('shows failures and a paused queue immediately', () => {
    const { rerender } = render(
      <ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />
    )
    rerender(<ConversationQueuePanel queuedMessages={[message('failed')]} guidanceMessages={[]} />)
    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    rerender(<ConversationQueuePanel queuedMessages={[]} guidanceMessages={[]} />)
    rerender(
      <ConversationQueuePanel
        queuedMessages={[message('sending')]}
        guidanceMessages={[]}
        queuePaused
      />
    )
    expect(screen.getByTestId('resume-queue-button')).toBeInTheDocument()
  })

  test('embedded summary keeps pause and actual failure count separate from total queue count', async () => {
    render(
      <ComposerStatusRegion>
        <ConversationQueuePanel
          queuedMessages={[
            { ...message('queued'), id: 'queued' },
            { ...message('failed'), id: 'failed' },
            { ...message('expired'), id: 'expired' },
          ]}
          guidanceMessages={[]}
          queuePaused
          presentation="embedded"
        />
      </ComposerStatusRegion>
    )

    const statusRegion = await screen.findByTestId('composer-status-region')
    const trigger = statusRegion.querySelector('[data-status-item="queue"] button')
    expect(trigger).not.toBeNull()
    expect(trigger).toHaveTextContent('Paused · Failed or expired messages: 2')
    expect(trigger).toHaveTextContent('3')
  })

  test('also suppresses short guidance sends without delaying expired guidance', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <ConversationQueuePanel queuedMessages={[]} guidanceMessages={[message('sending')]} />
    )
    expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
    rerender(
      <ConversationQueuePanel
        queuedMessages={[]}
        guidanceMessages={[{ ...message('sending'), status: 'expired' }]}
      />
    )
    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
  })

  test('cancels the pending reveal when unmounted', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />
    )
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('does not let a replaced dispatch reveal the next request early', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <ConversationQueuePanel queuedMessages={[message('sending')]} guidanceMessages={[]} />
    )
    act(() => vi.advanceTimersByTime(80))
    rerender(
      <ConversationQueuePanel
        queuedMessages={[{ ...message('sending'), id: 'next-request' }]}
        guidanceMessages={[]}
      />
    )
    act(() => vi.advanceTimersByTime(130))
    expect(screen.queryByTestId('conversation-queue-panel')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(80))
    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
  })
})
