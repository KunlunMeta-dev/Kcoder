import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ToolBlocksDisplay } from '@/components/chat/blocks/ToolBlocksDisplay'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { ToolsCatalogProvider } from './toolsCatalog'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const catalog = (displayName: string, icon = 'globe') => ({
  scope: 'thread',
  threadId: 'wire',
  cachePolicy: 'no-store',
  total: 1,
  truncated: false,
  tools: [{ name: 'plugin_lookup', displayName, icon, group: 'web', description: 'Description' }],
})
const blocks = [
  {
    id: 'b',
    subtaskId: 1,
    type: 'tool' as const,
    toolName: 'plugin_lookup',
    status: 'done' as const,
    createdAt: 1,
    input: {},
  },
]
const view = (taskId: string, revision = 1) => (
  <ToolsCatalogProvider taskId={taskId} serverId="remote" revision={revision}>
    <ToolBlocksDisplay blocks={blocks} isStreaming={false} forceExpanded showSummary={false} />
  </ToolsCatalogProvider>
)

test('reports a partial catalog once and clears the notice on target change', async () => {
  vi.mocked(requestLocalExecutor)
    .mockReset()
    .mockResolvedValue({
      ...catalog('Partial'),
      total: 700,
      truncated: true,
    })
  const { rerender } = render(view('large'))
  const notice = await screen.findByTestId('tools-catalog-truncation')
  expect(notice).toHaveTextContent('1')
  expect(notice).toHaveTextContent('700')
  expect(screen.getAllByTestId('tools-catalog-truncation')).toHaveLength(1)
  vi.mocked(requestLocalExecutor).mockResolvedValue(catalog('Complete'))
  rerender(view('small'))
  expect(screen.queryByTestId('tools-catalog-truncation')).not.toBeInTheDocument()
  expect(await screen.findByText(/Complete/)).toBeInTheDocument()
  expect(screen.queryByTestId('tools-catalog-truncation')).not.toBeInTheDocument()
})

// Mock only the transport: real processing blocks consume the returned catalog.
test('renders safe metadata, clears on switch, ignores late results and refetches invalidation', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(requestLocalExecutor)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce(catalog('Current <img src=x onerror=alert(1)>', 'https://bad/icon.svg'))
    .mockResolvedValueOnce(catalog('Refreshed'))
  const { rerender, container } = render(view('first'))
  rerender(view('second'))
  expect(await screen.findByText(/Current <img/)).toBeInTheDocument()
  expect(container.querySelector('img')).toBeNull()
  await act(async () => finish(catalog('Stale')))
  expect(screen.queryByText(/Stale/)).not.toBeInTheDocument()
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.tools.catalog', {
    taskId: 'second',
    serverId: 'remote',
  })
  rerender(view('second', 2))
  expect(await screen.findByText(/Refreshed/)).toBeInTheDocument()
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce(null)
  rerender(view('old-server'))
  await waitFor(() => expect(screen.queryByText(/Refreshed/)).not.toBeInTheDocument())
  expect(screen.getByText(/plugin lookup/)).toBeInTheDocument()
})

test('production conversation forwards explicit task context and refetches model changes', async () => {
  const metadata = catalog('Workbench catalog')
  metadata.tools[0].group = 'terminal'
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(metadata)
  const messages = [
    {
      id: 'm',
      role: 'assistant' as const,
      content: '',
      status: 'done' as const,
      createdAt: '2026-09-09T00:00:00Z',
      blocks,
    },
  ]
  render(
    <ScrollableMessageArea
      messages={messages}
      toolsCatalogTaskId="task"
      toolsCatalogServerId="remote"
    />
  )
  fireEvent.click(screen.getByTestId('processing-summary-toggle'))
  expect(await screen.findByText(/Workbench catalog/)).toBeInTheDocument()
  expect(
    screen.getByTestId('processing-tool-stats').querySelector('.lucide-square-terminal')
  ).not.toBeNull()
  const count = vi.mocked(requestLocalExecutor).mock.calls.length
  act(() => window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
  await waitFor(() =>
    expect(vi.mocked(requestLocalExecutor).mock.calls.length).toBeGreaterThan(count)
  )
})

test('refreshes lifecycle changes but not text tokens and removes listeners on unmount', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Stable catalog'))
  const message = {
    id: 'stream',
    role: 'assistant' as const,
    content: '',
    status: 'streaming' as const,
    createdAt: '2026-09-09T00:00:00Z',
    blocks,
  }
  const pane = (content: string, waiting: boolean) => (
    <ScrollableMessageArea
      messages={[{ ...message, content }]}
      isWaitingForAssistant={waiting}
      toolsCatalogTaskId="task"
      toolsCatalogServerId="remote"
    />
  )
  const { rerender, unmount } = render(pane('', true))
  await waitFor(() => expect(requestLocalExecutor).toHaveBeenCalledTimes(1))
  await act(async () => {
    rerender(pane('one token', true))
  })
  await act(async () => {
    rerender(pane('one token plus another', true))
  })
  expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  for (const event of ['focus', 'kcoder:tools-catalog-invalidated']) {
    const before = vi.mocked(requestLocalExecutor).mock.calls.length
    act(() => window.dispatchEvent(new Event(event)))
    await waitFor(() => expect(requestLocalExecutor).toHaveBeenCalledTimes(before + 1))
  }
  const beforeReconnect = vi.mocked(requestLocalExecutor).mock.calls.length
  rerender(pane('one token plus another', false))
  await waitFor(() => expect(requestLocalExecutor).toHaveBeenCalledTimes(beforeReconnect + 1))
  rerender(pane('one token plus another', true))
  await waitFor(() => expect(requestLocalExecutor).toHaveBeenCalledTimes(beforeReconnect + 2))
  unmount()
  const afterUnmount = vi.mocked(requestLocalExecutor).mock.calls.length
  act(() => {
    for (const event of [
      'focus',
      'kcoder:tools-catalog-invalidated',
      LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
    ]) {
      window.dispatchEvent(new Event(event))
    }
  })
  expect(requestLocalExecutor).toHaveBeenCalledTimes(afterUnmount)
})
