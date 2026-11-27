import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { InlineWidgetHostProps } from '@/features/widgets'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import {
  ConversationWidgetsContext,
  WidgetMessageContext,
  type ConversationWidgetsValue,
} from './widgetContext'
import { WidgetFirstFrameProbe } from './WidgetFirstFrameProbe'

const rendered = vi.hoisted(() => ({ props: undefined as InlineWidgetHostProps | undefined }))
vi.mock('@/features/widgets', () => ({
  isolatedHtmlWidgetRenderer: () => null,
  InlineWidgetHost: (props: InlineWidgetHostProps) => {
    rendered.props = props
    return (
      <button
        data-testid="proof-ready"
        onClick={() =>
          props.onFeedback?.({
            status: 'ready',
            widgetId: props.widget.widgetId,
            revision: props.widget.revision,
          })
        }
      >
        ready
      </button>
    )
  },
}))
afterEach(() => {
  vi.useRealTimers()
  rendered.props = undefined
})
const widget: WidgetRef = {
  widgetId: 'w',
  threadId: 't',
  turnId: 'turn',
  attemptId: 'attempt',
  toolCallId: 'tool',
  revision: 1,
  title: 'Figure',
  summary: 'Summary',
  format: 'svg',
  executionMode: 'managed',
  libraries: [],
  sha256: 'a'.repeat(64),
  bytes: 1,
  createdAtMs: 1,
}
function fixture() {
  const claims = new Set<string>()
  return {
    hostPanelId: 'owned',
    invalidated: false,
    isCurrent: () => true,
    claimProbe: vi.fn((ref: WidgetRef) => {
      const key = `${ref.widgetId}:${ref.revision}`
      if (claims.has(key)) return false
      claims.add(key)
      return true
    }),
    api: { receipt: vi.fn(async () => ({ accepted: true })), content: vi.fn() },
  } as unknown as ConversationWidgetsValue
}
function View({
  value,
  terminal = false,
  active = !terminal,
}: {
  value: ConversationWidgetsValue
  terminal?: boolean
  active?: boolean
}) {
  return (
    <ConversationWidgetsContext.Provider value={value}>
      <WidgetMessageContext.Provider value={{ terminal, active }}>
        <WidgetFirstFrameProbe widget={widget} />
      </WidgetMessageContext.Provider>
    </ConversationWidgetsContext.Provider>
  )
}
test('trusted active commit reports a first frame before terminal with no interactive callbacks', async () => {
  const value = fixture()
  const { rerender } = render(<View value={value} />)
  fireEvent.click(await screen.findByTestId('proof-ready'))
  await waitFor(() =>
    expect(value.api.receipt).toHaveBeenCalledExactlyOnceWith(widget, 'rendered', undefined)
  )
  expect(rendered.props?.verificationOnly).toBe(true)
  expect(rendered.props?.onSendPrompt).toBeUndefined()
  expect(rendered.props?.onAppMessage).toBeUndefined()
  expect(rendered.props?.onState).toBeUndefined()
  expect(screen.queryByTestId('proof-ready')).not.toBeInTheDocument()
  rerender(<View value={value} terminal />)
  expect(value.api.receipt).toHaveBeenCalledTimes(1)
})
test('a missing frame or terminal cleanup stays unconfirmed and never invents success', async () => {
  vi.useFakeTimers()
  const value = fixture()
  const { rerender } = render(<View value={value} />)
  expect(screen.getByTestId('proof-ready')).toBeInTheDocument()
  act(() => {
    vi.advanceTimersByTime(3000)
  })
  expect(screen.queryByTestId('proof-ready')).not.toBeInTheDocument()
  expect(value.api.receipt).not.toHaveBeenCalled()
  rerender(<View value={value} terminal />)
  expect(value.api.receipt).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
test('an explicit renderer failure is reported once and a lost receipt is not replayed', async () => {
  const value = fixture()
  vi.mocked(value.api.receipt).mockRejectedValue(new Error('transport lost'))
  render(<View value={value} />)
  await screen.findByTestId('proof-ready')
  act(() =>
    rendered.props?.onFeedback?.({ status: 'error', widgetId: 'w', revision: 1, message: 'syntax' })
  )
  await waitFor(() =>
    expect(value.api.receipt).toHaveBeenCalledExactlyOnceWith(widget, 'failed', 'render_failed')
  )
  expect(screen.queryByTestId('proof-ready')).not.toBeInTheDocument()
})

test('unconfirmed stops the probe without an RPC receipt or a late callback becoming success', async () => {
  const value = fixture()
  const { rerender } = render(<View value={value} />)
  await screen.findByTestId('proof-ready')
  const feedback = rendered.props?.onFeedback
  act(() => feedback?.({ status: 'unconfirmed', widgetId: 'w', revision: 1 }))
  expect(screen.queryByTestId('proof-ready')).not.toBeInTheDocument()
  expect(value.api.receipt).not.toHaveBeenCalled()
  act(() => feedback?.({ status: 'ready', widgetId: 'w', revision: 1 }))
  expect(value.api.receipt).not.toHaveBeenCalled()
  rerender(<View value={value} terminal />)
  expect(value.api.receipt).not.toHaveBeenCalled()
})

test('a failed or inactive attempt cannot start a hidden first-frame probe', () => {
  const value = fixture()
  render(<View value={value} terminal={false} active={false} />)
  expect(screen.queryByTestId('proof-ready')).not.toBeInTheDocument()
  expect(value.claimProbe).not.toHaveBeenCalled()
  expect(value.api.receipt).not.toHaveBeenCalled()
})


test('a first-frame data error retains its cause and numeric country in the receipt', async () => {
  const value = fixture()
  render(<View value={value} />)
  await screen.findByTestId('proof-ready')
  act(() => rendered.props?.onFeedback?.({ status: 'error', widgetId: 'w', revision: 1,
    message: 'invalid_widget: /values/999 (unknown_country_id) unknown ISO numeric country ID 999',
  }))
  await waitFor(() => expect(value.api.receipt).toHaveBeenCalledExactlyOnceWith(
    widget, 'failed', 'invalid_widget_unknown_country_id_999'
  ))
})
