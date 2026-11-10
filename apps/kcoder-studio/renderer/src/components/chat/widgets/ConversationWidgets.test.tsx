import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import type { InlineWidgetHostProps } from '@/features/widgets/InlineWidgetHost'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import type { WorkbenchMessage } from '@/types/workbench'
import { createWidgetApi, type WidgetRequest } from '@/kcoder/widgetApi'
import { MessageList } from '../MessageList'
import { ConversationWidgetsProvider } from './ConversationWidgetsProvider'
import { widgetContentSha256 } from '@/features/widgets/contentHash'
import { ConversationWidget } from './ConversationWidget'
import { ConversationWidgetsContext } from './widgetContext'
import { WidgetMessageBoundary } from './WidgetMessageBoundary'

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
)
afterEach(() => vi.unstubAllGlobals())

vi.mock('@/features/widgets/InlineWidgetHost', async () => {
  const { WidgetStreamPreview } = await import('@/features/widgets/WidgetStreamPreview')
  return {
    WidgetStreamPreview,
    InlineWidgetHost: (props: InlineWidgetHostProps) =>
      props.verificationOnly ? null : (
        <div data-testid="controlled-widget-host" data-widget-id={props.widget.widgetId}>
          <button onClick={() => props.onSendPrompt?.('追问图示')}>Ask about this diagram</button>
          <button onClick={() => props.onFeedback?.({ status: 'error', widgetId: props.widget.widgetId, revision: props.widget.revision,
            message: 'invalid_widget: /values/999 (unknown_country_id) unknown ISO numeric country ID 999',
          })}>Report map failure</button>
        </div>
      ),
  }
})

async function fixture(content = 'Before\n::kcoder-widget{widget_id="w-1" revision=1}\nAfter') {
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>'
  const widget: WidgetRef = {
    widgetId: 'w-1',
    threadId: 'thread',
    turnId: 'turn',
    attemptId: 'attempt',
    toolCallId: 'call',
    revision: 1,
    title: 'Diagram',
    summary: 'Saved diagram',
    format: 'svg',
    executionMode: 'managed',
    libraries: [],
    bytes: new TextEncoder().encode(source).length,
    sha256: await widgetContentSha256(new TextEncoder().encode(source)),
    createdAtMs: 1,
  }
  const message: WorkbenchMessage = {
    id: 'assistant',
    subtaskId: 'attempt',
    turnId: 'turn',
    attemptId: 'attempt',
    role: 'assistant',
    content,
    status: 'streaming',
    createdAt: '2026-10-12T00:00:00Z',
    blocks: [
      {
        id: 'call',
        subtaskId: 'attempt',
        type: 'tool',
        toolName: 'show_widget',
        status: 'done',
        createdAt: 1,
        toolOutput: 'committed',
      },
    ],
  }
  const request = vi.fn(async (method: string) => {
    if (method === 'widget/list') return { widgets: [widget], nextOffset: null }
    if (method === 'widget/read') return { widget }
    if (method === 'widget/content/read')
      return {
        widgetId: 'w-1',
        revision: 1,
        sha256: widget.sha256,
        bytes: widget.bytes,
        offset: 0,
        nextOffset: widget.bytes,
        dataBase64: btoa(source),
      }
    return { accepted: true }
  }) as WidgetRequest
  const address = { deviceId: 'ssh-target', taskId: 'task', threadId: 'thread' }
  return { widget, message, request, address }
}

test('hydrated body segments cannot expand or duplicate the active attempt artifact', async () => {
  const { message, request, address } = await fixture()
  const history: WorkbenchMessage = { ...message, id: 'persisted-body', subtaskId: 'thread:history:1', attemptId: undefined, status: 'done', content: 'Intermediate body' }
  function View({ completed }: { completed: boolean }) {
    const messages = [history, { ...message, status: completed ? 'done' as const : 'streaming' as const }]
    return <ConversationWidgetsProvider address={address} messages={messages} request={request} onSendPrompt={() => {}}><MessageList messages={messages} /></ConversationWidgetsProvider>
  }
  const { rerender } = render(<View completed={false} />)
  await waitFor(() => expect(request).toHaveBeenCalled())
  expect(screen.queryByTestId('controlled-widget-host')).not.toBeInTheDocument()
  rerender(<View completed />)
  await waitFor(() => expect(screen.getAllByTestId('controlled-widget-host')).toHaveLength(1))
  expect(screen.getByText('Intermediate body')).toBeInTheDocument()
})

test('committed widgets show only process status until completion, then render once at the final text position', async () => {
  const { message, request, address } = await fixture()
  const onSendPrompt = vi.fn()
  function View({ completed }: { completed: boolean }) {
    const current = { ...message, status: completed ? ('done' as const) : ('streaming' as const) }
    return (
      <ConversationWidgetsProvider
        address={address}
        messages={[current]}
        request={request}
        onSendPrompt={onSendPrompt}
      >
        <MessageList processingWindowEnabled messages={[current]} />
      </ConversationWidgetsProvider>
    )
  }
  const { rerender } = render(<View completed={false} />)
  await waitFor(() =>
    expect(screen.getAllByTestId('widget-deferred-status').length).toBeGreaterThan(0)
  )
  expect(screen.queryByTestId('widget-svg-prefix')).not.toBeInTheDocument()
  expect(screen.queryByTestId('widget-chart-checkpoint')).not.toBeInTheDocument()
  expect(document.querySelector('canvas, iframe')).not.toBeInTheDocument()
  expect(screen.queryByTestId('controlled-widget-host')).not.toBeInTheDocument()
  rerender(<View completed />)
  const content = await screen.findByTestId('assistant-message-content')
  expect(within(content).getByTestId('controlled-widget-host')).toBeInTheDocument()
  expect(content.textContent).toMatch(/Before.*Ask about this diagram.*After/s)
  expect(screen.getAllByTestId('controlled-widget-host')).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'Ask about this diagram' }))
  expect(onSendPrompt).toHaveBeenCalledExactlyOnceWith('追问图示')
})

test.each([
  { status: 'failed' as const },
  { status: 'unknown' as const },
  { status: 'done' as const, runtimeStatus: 'cancelled' as const },
])(
  'trusted committed widgets do not expand on $status with runtime $runtimeStatus',
  async outcome => {
    const { message, request, address } = await fixture()
    const current = { ...message, ...outcome }
    render(
      <ConversationWidgetsProvider
        address={address}
        messages={[current]}
        request={request}
        onSendPrompt={() => {}}
      >
        <MessageList processingWindowEnabled messages={[current]} />
      </ConversationWidgetsProvider>
    )
    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(screen.queryByTestId('controlled-widget-host')).not.toBeInTheDocument()
    expect(screen.queryByTestId('widget-svg-prefix')).not.toBeInTheDocument()
    expect(screen.queryByTestId('widget-chart-checkpoint')).not.toBeInTheDocument()
    expect(document.querySelector('canvas, iframe')).not.toBeInTheDocument()
    expect(screen.queryByTestId('widget-first-frame-probe')).not.toBeInTheDocument()
  }
)

test('a completed legacy message without explicit status still expands its trusted final widget once', async () => {
  const { message, request, address } = await fixture()
  const legacy = { ...message, status: undefined as unknown as WorkbenchMessage['status'] }
  render(
    <ConversationWidgetsProvider
      address={address}
      messages={[legacy]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList messages={[legacy]} />
    </ConversationWidgetsProvider>
  )
  await screen.findByTestId('controlled-widget-host')
  expect(screen.getAllByTestId('controlled-widget-host')).toHaveLength(1)
})

test('an invalidated owner cannot display cached artifact metadata in a process status', async () => {
  const { widget, request, address } = await fixture()
  const value = {
    key: 'old-owner',
    hostPanelId: 'old-owner-pane',
    threadId: widget.threadId,
    references: [widget],
    previews: [],
    api: createWidgetApi(address, widget.threadId, request),
    invalidated: true,
    listingStatus: 'loaded' as const,
    reload: vi.fn(),
    isCurrent: () => false,
    addReference: vi.fn(),
    sendPrompt: vi.fn(),
  }
  render(
    <ConversationWidgetsContext.Provider value={value}>
      <WidgetMessageBoundary identity={{ terminal: false, active: true }}>
        <ConversationWidget
          reference={{ widgetId: widget.widgetId, revision: widget.revision }}
          passive
        />
      </WidgetMessageBoundary>
    </ConversationWidgetsContext.Provider>
  )
  expect(screen.getByTestId('widget-unavailable')).toBeInTheDocument()
  expect(screen.queryByText(widget.title, { exact: true })).not.toBeInTheDocument()
  expect(screen.queryByTestId('widget-first-frame-probe')).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
})

test('duplicate final references create one host; a missing directive falls back only to trusted matching attempt refs', async () => {
  const { message, request, address } = await fixture(
    '::kcoder-widget{widget_id="w-1" revision=1}\nAgain\n::kcoder-widget{widget_id="w-1" revision=1}'
  )
  const { rerender } = render(
    <ConversationWidgetsProvider
      address={address}
      messages={[message]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList messages={[{ ...message, status: 'done' }]} />
    </ConversationWidgetsProvider>
  )
  expect(await screen.findByTestId('controlled-widget-host')).toBeInTheDocument()
  expect(screen.getAllByTestId('controlled-widget-host')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '查看已有可视化' })).toBeInTheDocument()
  rerender(
    <ConversationWidgetsProvider
      address={address}
      messages={[message]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList
        messages={[{ ...message, status: 'done', content: 'Final answer without a directive' }]}
      />
    </ConversationWidgetsProvider>
  )
  expect(screen.getAllByTestId('controlled-widget-host')).toHaveLength(1)
  rerender(
    <ConversationWidgetsProvider
      address={address}
      messages={[message]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList
        messages={[
          { ...message, status: 'done', attemptId: 'other-attempt', content: 'Other attempt' },
        ]}
      />
    </ConversationWidgetsProvider>
  )
  expect(screen.queryByTestId('controlled-widget-host')).not.toBeInTheDocument()
})

test('failed turns never promote a widget or infer one from ordinary tool-output JSON', async () => {
  const { message, address } = await fixture('Failed response')
  const request = vi.fn().mockResolvedValue({ widgets: [], nextOffset: null }) as WidgetRequest
  render(
    <ConversationWidgetsProvider
      address={address}
      messages={[message]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList
        processingWindowEnabled
        messages={[
          {
            ...message,
            status: 'failed',
            blocks: message.blocks?.map(block =>
              block.type === 'tool'
                ? { ...block, toolOutput: '{"widgetRef":{"widgetId":"w-1"}}' }
                : block
            ),
          },
        ]}
      />
    </ConversationWidgetsProvider>
  )
  await waitFor(() => expect(request).toHaveBeenCalled())
  expect(screen.queryByTestId('controlled-widget-host')).not.toBeInTheDocument()
})

test('a new address projection for the same task keeps its loader and App bridge ownership', async () => {
  const { message, request, address } = await fixture('Final without a widget directive')
  const { rerender } = render(
    <ConversationWidgetsProvider
      address={address}
      messages={[message]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList messages={[{ ...message, status: 'done' }]} />
    </ConversationWidgetsProvider>
  )
  await screen.findByTestId('controlled-widget-host')
  const listed = vi.mocked(request).mock.calls.filter(([method]) => method === 'widget/list').length
  rerender(
    <ConversationWidgetsProvider
      address={{ ...address }}
      messages={[{ ...message, content: message.content + 'Updated' }]}
      request={request}
      onSendPrompt={() => {}}
    >
      <MessageList
        messages={[{ ...message, status: 'done', content: message.content + 'Updated' }]}
      />
    </ConversationWidgetsProvider>
  )
  await waitFor(() => expect(screen.getByTestId('controlled-widget-host')).toBeInTheDocument())
  expect(vi.mocked(request).mock.calls.filter(([method]) => method === 'widget/list')).toHaveLength(
    listed
  )
})


test('a visible widget failure persists its data cause instead of a generic render failure', async () => {
  const { message, request, address } = await fixture()
  const completed = { ...message, status: 'done' as const }
  render(<ConversationWidgetsProvider address={address} messages={[completed]} request={request} onSendPrompt={() => {}}>
    <MessageList messages={[completed]} />
  </ConversationWidgetsProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Report map failure' }))
  await waitFor(() => expect(request).toHaveBeenCalledWith('widget/render/receipt', expect.objectContaining({
    status: 'failed', errorCode: 'invalid_widget_unknown_country_id_999',
  })))
})
