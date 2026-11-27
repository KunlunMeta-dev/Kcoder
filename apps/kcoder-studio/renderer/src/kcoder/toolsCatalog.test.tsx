import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useGeneratingToolBlocks } from '@/components/chat/useGeneratingToolBlocks'
import { ToolLineProgress } from '@/components/chat/blocks/ToolLineProgress'
import { ToolBlocksDisplay } from '@/components/chat/blocks/ToolBlocksDisplay'
import { requestLocalExecutor } from '@/host/localExecutor'
import { ToolsCatalogProvider } from './toolsCatalog'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { RetainedPage } from '@/components/layout/retainedPages'
import type { WorkbenchMessage } from '@/types/workbench'
import { toolPathPreviews, ToolPathPreviewConsumer } from './toolPathPreview'
import { createGuidanceContinuationAssistantMessage } from '@/components/layout/pane/paneMessageReducer'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
// Catalog assertions use a fixed disclosure mode; defaults are covered by preference and browser tests.
vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...actual.useConversationPreferences(), conversationProcessDisplay: 'two-level-v1',
  }) }
})
// Conversation timing samples share this transport; count only catalog requests.
const catalogCalls = () => vi.mocked(requestLocalExecutor).mock.calls
  .filter(([command]) => command === 'runtime.tools.catalog')
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
  <ToolsCatalogProvider taskId={taskId} serverId="remote" messages={[{
    id: `catalog-view-${revision}`, role: 'assistant', status: 'done', blocks, content: '',
    createdAt: '2026-11-22T00:00:00Z',
  }]}>
    <ToolBlocksDisplay blocks={blocks} isStreaming={false} forceExpanded showSummary={false} />
  </ToolsCatalogProvider>
)

test('text and thinking defer metadata reads until a tool appears, without dropping progress ownership', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('First visible tool'))
  const release = vi.fn()
  const acquire = vi.spyOn(toolPathPreviews, 'acquire').mockReturnValue(release)
  const message: WorkbenchMessage = { id: 'metadata-demand', role: 'assistant', status: 'streaming',
    content: 'Readable text', createdAt: '2026-11-22T00:00:00Z', blocks: [
      { id: 'thought', type: 'thinking', content: 'Inspecting', status: 'streaming', createdAt: 1 },
    ] }
  const pane = (messages: WorkbenchMessage[]) => <ScrollableMessageArea messages={messages}
    showTransientToolStatus toolsCatalogTaskId="task" toolsCatalogServerId="remote" />
  const page = render(pane([message]))
  try {
    await act(async () => {})
    expect(catalogCalls()).toHaveLength(0)
    expect(acquire).toHaveBeenCalledWith('remote', 'task')
    expect(release).not.toHaveBeenCalled()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    })
    expect(catalogCalls()).toHaveLength(0)
    page.rerender(pane([{ ...message, blocks: [...message.blocks!, ...blocks] }]))
    await waitFor(() => expect(catalogCalls()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('process-activity-toggle'))
    await waitFor(() => expect(screen.getByTestId('process-activity-content')
      .querySelector('.lucide-globe[data-tool-group="web"]')).not.toBeNull())
    page.rerender(pane([message]))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(catalogCalls()).toHaveLength(1)
    page.unmount()
    expect(release).toHaveBeenCalledTimes(acquire.mock.calls.length)
  } finally { page.unmount(); acquire.mockRestore() }
})

test('generating arguments enable metadata once before transcript materialization', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Generating tool'))
  const consumer = new ToolPathPreviewConsumer(), client = {}
  const page = render(<ToolsCatalogProvider taskId="generating-task" serverId="remote"
    messages={[]}><p>Preparing arguments</p></ToolsCatalogProvider>)
  const send = (sequence: number, name: string, target = 'remote', task = 'generating-task') =>
    consumer.handle('item/event', { serverId: 'instance', threadId: 'wire', turnId: 'turn', sequence,
      event: { type: 'tool_input_progress', id: 'pending-tool', name, chars: sequence * 8 } }, target, task, client)
  try {
    await act(async () => {})
    expect(catalogCalls()).toHaveLength(0)
    await act(async () => {
      consumer.handle('turn/started', { serverId: 'instance', threadId: 'wire', turnId: 'turn', sequence: 1 },
        'remote', 'generating-task', client)
      send(2, 'plugin_lookup')
    })
    await waitFor(() => expect(catalogCalls()).toHaveLength(1))
    await act(async () => { for (let sequence = 3; sequence < 16; sequence++) send(sequence, 'plugin_lookup') })
    expect(catalogCalls()).toHaveLength(1)
    await act(async () => {
      consumer.handle('turn/completed', { serverId: 'instance', threadId: 'wire', turnId: 'turn', sequence: 16 },
        'remote', 'generating-task', client)
    })
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(catalogCalls()).toHaveLength(1)
  } finally { page.unmount(); consumer.dispose() }
})

test('local guidance presentation does not demand or invalidate a real tool catalog', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Real tool metadata'))
  const assistant: WorkbenchMessage & { subtaskId: string } = {
    id: 'owned-assistant', subtaskId: 'owned-turn', role: 'assistant', status: 'streaming',
    content: 'Owned text', createdAt: '2026-11-23T00:00:00Z',
  }
  const continuation = createGuidanceContinuationAssistantMessage(assistant, {
    id: 'owned-guidance', role: 'user', status: 'done', content: 'Owned guidance',
    createdAt: '2026-11-23T00:00:01Z',
  })
  const pane = (message: WorkbenchMessage) => <ToolsCatalogProvider taskId="guidance-task" serverId="remote"
    messages={[message]} isWaitingForAssistant>
    <ToolBlocksDisplay blocks={message.blocks ?? []} isStreaming forceExpanded showSummary={false} />
  </ToolsCatalogProvider>
  const page = render(pane(continuation))
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
  })
  expect(catalogCalls()).toHaveLength(0)
  expect(screen.getByText(/引导对话/)).toBeInTheDocument()
  const withTool = { ...continuation, blocks: [...continuation.blocks!, ...blocks] }
  page.rerender(pane(withTool))
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  expect(await screen.findByText(/Real tool metadata/)).toBeInTheDocument()
  page.rerender(pane({ ...withTool, blocks: [
    { ...continuation.blocks![0], id: 'another-local-guidance' }, ...blocks,
  ] }))
  await act(async () => {})
  expect(catalogCalls()).toHaveLength(1)
  expect(screen.getByText(/Real tool metadata/)).toBeInTheDocument()
})

test.each(['plugin.conversation_guidance', 'plugin__conversation_guidance', 'user_guidance'])(
  'only the canonical local marker is excluded; %s still requests metadata', async toolName => {
    vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Unchanged tool scope'))
    const message: WorkbenchMessage = { id: 'other-tool', role: 'assistant', status: 'done',
      content: '', createdAt: '2026-11-23T00:00:00Z', blocks: [{ ...blocks[0], toolName }] }
    render(<ToolsCatalogProvider taskId="other-tool-task" serverId="remote" messages={[message]}>
      <p>Independent tool metadata consumer</p>
    </ToolsCatalogProvider>)
    await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  }
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
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  rerender(view('second'))
  expect(await screen.findByText(/Current <img/)).toBeInTheDocument()
  expect(container.querySelector('img')).toBeNull()
  await act(async () => finish(catalog('Stale')))
  expect(screen.queryByText(/Stale/)).not.toBeInTheDocument()
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.tools.catalog', {
    taskId: 'second',
    serverId: 'remote',
  })
  await act(async () => { window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')) })
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
  fireEvent.click(screen.getByTestId('process-activity-toggle'))
  expect(await screen.findByText(/plugin_lookup/)).toBeInTheDocument()
  expect(
    screen.getByTestId('process-activity-content').querySelector('.lucide-globe[data-tool-group="terminal"]')
  ).not.toBeNull()
  const count = catalogCalls().length
  act(() => window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
  await waitFor(() =>
    expect(catalogCalls().length).toBeGreaterThan(count)
  )
})

test('refreshes catalog demand and explicit invalidations, not turn or tool status changes', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Stable catalog'))
  const message = {
    id: 'stream',
    role: 'assistant' as const,
    content: '',
    status: 'streaming' as const,
    createdAt: '2026-09-09T00:00:00Z',
    blocks,
  }
  const pane = (content: string, waiting: boolean, tools: NonNullable<WorkbenchMessage['blocks']> = blocks) => (
    <ScrollableMessageArea
      messages={[{ ...message, content, blocks: tools }]}
      isWaitingForAssistant={waiting}
      toolsCatalogTaskId="task"
      toolsCatalogServerId="remote"
    />
  )
  const { rerender, unmount } = render(pane('', true))
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  await act(async () => {
    rerender(pane('one token', true))
  })
  await act(async () => {
    rerender(pane('one token plus another', true))
  })
  expect(catalogCalls()).toHaveLength(1)
  for (const event of ['focus', 'kcoder:tools-catalog-invalidated']) {
    const before = catalogCalls().length
    act(() => window.dispatchEvent(new Event(event)))
    await waitFor(() => expect(catalogCalls()).toHaveLength(before + 1))
  }
  const beforeLifecycle = catalogCalls().length
  await act(async () => {
    rerender(pane('one token plus another', false))
    rerender(pane('one token plus another', true, blocks.map(block => ({ ...block, status: 'failed' as const }))))
  })
  expect(catalogCalls()).toHaveLength(beforeLifecycle)
  await act(async () => {
    rerender(pane('one token plus another', true, blocks.map(block => ({ ...block, toolName: 'new_tool' }))))
  })
  expect(catalogCalls()).toHaveLength(beforeLifecycle)
  unmount()
  const afterUnmount = catalogCalls().length
  act(() => {
    for (const event of [
      'focus',
      'kcoder:tools-catalog-invalidated',
      LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
    ]) {
      window.dispatchEvent(new Event(event))
    }
  })
  expect(catalogCalls()).toHaveLength(afterUnmount)
})

test.each(['separate-message', 'same-message'] as const)('%s non-tool lifecycle does not invalidate displayed tool metadata', async location => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Original metadata'))
  const thought = { id: 'text-thought', type: 'thinking' as const, content: 'Thinking', createdAt: 1,
    status: 'streaming' as const }
  const toolMessage: WorkbenchMessage = { id: 'tool-message', role: 'assistant', status: 'streaming',
    content: '', createdAt: '2026-11-22T00:00:00Z', blocks }
  const other: WorkbenchMessage = { id: 'text-message', role: 'assistant', status: 'streaming',
    content: 'Latest text', createdAt: '2026-11-22T00:00:00Z', blocks: [thought] }
  const pane = (settled: boolean) => {
    const changed = { ...thought, status: settled ? 'done' as const : 'streaming' as const }
    const messages = location === 'same-message'
      ? [{ ...toolMessage, blocks: [...blocks, changed] }]
      : [toolMessage, { ...other, status: settled ? 'done' as const : 'streaming' as const, blocks: [changed] }]
    return <ToolsCatalogProvider taskId="task" serverId="remote" messages={messages} isWaitingForAssistant>
      <ToolBlocksDisplay blocks={blocks} isStreaming={false} forceExpanded showSummary={false} />
    </ToolsCatalogProvider>
  }
  const page = render(pane(false))
  expect(await screen.findByText(/Original metadata/)).toBeInTheDocument()
  await act(async () => { page.rerender(pane(true)) })
  expect(catalogCalls()).toHaveLength(1)
  expect(screen.getByText(/Original metadata/)).toBeInTheDocument()
})

test('hidden retained tool catalogs defer all refresh triggers until their page returns', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Visible tools'))
  const pane = (open: boolean, revision = 1) => <RetainedPage open={open}>{view('task', revision)}</RetainedPage>
  const { rerender } = render(pane(false))
  const invalidate = () => {
    for (const event of ['focus', 'kcoder:tools-catalog-invalidated', LOCAL_MODEL_SETTINGS_CHANGED_EVENT])
      window.dispatchEvent(new Event(event))
  }
  await act(async () => { invalidate() })
  expect(catalogCalls()).toHaveLength(0)
  rerender(pane(true))
  expect(await screen.findByText(/Visible tools/)).toBeInTheDocument()
  expect(catalogCalls()).toHaveLength(1)
  rerender(pane(false, 2))
  await act(async () => { invalidate() })
  expect(catalogCalls()).toHaveLength(1)
  vi.mocked(requestLocalExecutor).mockResolvedValue(catalog('Returned tools'))
  rerender(pane(true, 2))
  expect(await screen.findByText(/Returned tools/)).toBeInTheDocument()
  expect(catalogCalls()).toHaveLength(2)
})

test('browser-hidden catalog refreshes wait for visibility return, including initial mount', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Foreground tools'))
  const { unmount } = render(view('task'))
  try {
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    })
    expect(catalogCalls()).toHaveLength(0)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(await screen.findByText(/Foreground tools/)).toBeInTheDocument()
    expect(catalogCalls()).toHaveLength(1)
    unmount()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(catalogCalls()).toHaveLength(1)
  } finally { unmount(); visibility.mockRestore() }
})

test('a retained catalog cannot publish its late pre-hide snapshot on return', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(requestLocalExecutor).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(catalog('Current tools'))
  const pane = (open: boolean) => <RetainedPage open={open}>{view('task')}</RetainedPage>
  const { rerender } = render(pane(true))
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  rerender(pane(false))
  rerender(pane(true))
  expect(await screen.findByText(/Current tools/)).toBeInTheDocument()
  await act(async () => { finish(catalog('Retired tools')) })
  expect(screen.queryByText(/Retired tools/)).not.toBeInTheDocument()
  expect(screen.getByText(/Current tools/)).toBeInTheDocument()
})

test('focus and visibility share an unfinished read but configuration invalidation requires a fresh read', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(requestLocalExecutor).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(catalog('Fresh tools'))
  render(view('task'))
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(catalogCalls()).toHaveLength(1)
  await act(async () => { window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')) })
  expect(await screen.findByText(/Fresh tools/)).toBeInTheDocument()
  expect(catalogCalls()).toHaveLength(2)
  await act(async () => { finish(catalog('Pre-change tools')) })
  expect(screen.queryByText(/Pre-change tools/)).not.toBeInTheDocument()
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(catalogCalls()).toHaveLength(3)
})

test.each(['resolved', 'rejected'] as const)('materializing a tool after progress reuses the pending %s catalog read', async outcome => {
  let finish!: (value: unknown) => void
  let fail!: (error: Error) => void
  vi.mocked(requestLocalExecutor).mockReset()
    .mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    .mockResolvedValue(catalog('Progress catalog'))
  const consumer = new ToolPathPreviewConsumer(), client = {}
  const pane = (messages: WorkbenchMessage[]) => <ToolsCatalogProvider
    taskId="overlap-task" serverId="remote" messages={messages}><p>Tool activity</p></ToolsCatalogProvider>
  const page = render(pane([]))
  await act(async () => {
    consumer.handle('turn/started', { serverId: 'instance', threadId: 'wire', turnId: 'turn', sequence: 1 },
      'remote', 'overlap-task', client)
    consumer.handle('item/event', { serverId: 'instance', threadId: 'wire', turnId: 'turn', sequence: 2,
      event: { type: 'tool_input_progress', id: 'pending-tool', name: 'plugin_lookup', chars: 8 } },
    'remote', 'overlap-task', client)
  })
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  await act(async () => { page.rerender(pane([{
    id: 'overlap-message', role: 'assistant', status: 'streaming', content: '',
    createdAt: '2026-11-23T00:00:00Z', blocks: [{ ...blocks[0], status: 'streaming', toolName: 'plugin_lookup' }],
  }])) })
  expect(catalogCalls()).toHaveLength(1)
  await act(async () => {
    if (outcome === 'resolved') finish(catalog('Progress catalog'))
    else fail(new Error('Original read failed'))
  })
  expect(catalogCalls()).toHaveLength(1)
  if (outcome === 'resolved') expect(await screen.findByText('Tool activity')).toBeInTheDocument()
  consumer.dispose()
  page.unmount()
})

test('an unmounted lifecycle waiter does not start a trailing catalog read', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(requestLocalExecutor).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(catalog('Unexpected follow-up'))
  const page = render(view('retired-waiter'))
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  page.rerender(view('retired-waiter', 2))
  page.unmount()
  await act(async () => { finish(catalog('Retired first read')) })
  expect(catalogCalls()).toHaveLength(1)
})

test.each(['target', 'visibility', 'configuration'] as const)('%s changes retire queued lifecycle reads without delaying the current catalog', async boundary => {
  let finish!: (value: unknown) => void
  vi.mocked(requestLocalExecutor).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(catalog('Current boundary metadata'))
  const pane = (task: string, open: boolean, revision: number) =>
    <RetainedPage open={open}>{view(task, revision)}</RetainedPage>
  const page = render(pane('boundary-task', true, 1))
  await waitFor(() => expect(catalogCalls()).toHaveLength(1))
  await act(async () => { page.rerender(pane('boundary-task', true, 2)) })
  expect(catalogCalls()).toHaveLength(1)
  if (boundary === 'target') page.rerender(pane('current-task', true, 2))
  else if (boundary === 'visibility') {
    page.rerender(pane('boundary-task', false, 2))
    page.rerender(pane('boundary-task', true, 2))
  } else act(() => window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
  expect(await screen.findByText(/Current boundary metadata/)).toBeInTheDocument()
  expect(catalogCalls()).toHaveLength(2)
  await act(async () => { finish(catalog('Retired boundary metadata')) })
  expect(screen.queryByText(/Retired boundary metadata/)).not.toBeInTheDocument()
  expect(screen.getByText(/Current boundary metadata/)).toBeInTheDocument()
  expect(catalogCalls()).toHaveLength(2)
})

test('waiting, tool status and additional tool names do not refresh a task catalog', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Lifecycle metadata'))
  const historyBlocks = Array.from({ length: 64 }, (_, index) => ({ ...blocks[0], id: `history-tool-${index}` }))
  const messages: WorkbenchMessage[] = [{
    id: 'catalog-layout-history', role: 'assistant' as const, status: 'streaming' as const,
    content: '', createdAt: '2026-11-22T00:00:00Z',
    blocks: historyBlocks,
  }]
  const pane = (className: string, waiting: boolean, data = messages) => <ToolsCatalogProvider
    messages={data} isWaitingForAssistant={waiting} taskId="task" serverId="remote">
    <div className={className}><ToolBlocksDisplay blocks={historyBlocks}
      isStreaming={false} forceExpanded showSummary={false} /></div>
  </ToolsCatalogProvider>
  const { rerender, container } = render(pane('layout-initial', true))
  await act(async () => {})
  for (let index = 0; index < 12; index++) {
    await act(async () => { rerender(pane(`layout-${index}`, true)) })
  }
  expect(container.firstElementChild).toHaveClass('layout-11')
  expect(catalogCalls()).toHaveLength(1)
  await act(async () => { rerender(pane('layout-11', false)) })
  expect(catalogCalls()).toHaveLength(1)
  await act(async () => { rerender(pane('layout-11', false, [{
    ...messages[0], blocks: historyBlocks.map((block, index) =>
      index === 0 ? { ...block, status: 'failed' as const } : block),
  }])) })
  expect(catalogCalls()).toHaveLength(1)
  await act(async () => { rerender(pane('layout-11', false, [{
    ...messages[0], blocks: historyBlocks.map((block, index) =>
      index === 0 ? { ...block, toolName: 'new_tool' } : block),
  }])) })
  expect(catalogCalls()).toHaveLength(1)
})

test.each(['text-only', 'retained-hidden', 'browser-hidden'] as const)('%s history reads catalog metadata only when tools are visible', async scenario => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Returned metadata'))
  const messages: WorkbenchMessage[] = Array.from({ length: 64 }, (_, index) => ({
    id: `catalog-quiet-${index}`, role: 'assistant', status: 'done', content: `Saved text ${index}`,
    createdAt: '2026-11-22T00:00:00Z',
    blocks: scenario !== 'text-only' ? blocks.map(block => ({ ...block, id: `quiet-tool-${index}` })) : [],
  }))
  let open = scenario !== 'retained-hidden'
  const visibility = scenario === 'browser-hidden'
    ? vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden') : undefined
  const pane = (content: string) => <RetainedPage open={open}><ToolsCatalogProvider
    messages={[...messages, { id: 'quiet-live', role: 'assistant', status: 'streaming', content,
      createdAt: '2026-11-22T00:00:00Z' }]} isWaitingForAssistant
    taskId="task" serverId="remote"><p>{content}</p></ToolsCatalogProvider></RetainedPage>
  const page = render(pane('Latest text 0'))
  try {
    await act(async () => {})
    for (let index = 1; index <= 12; index++) {
      await act(async () => { page.rerender(pane(`Latest text ${index}`)) })
    }
    expect(catalogCalls()).toHaveLength(0)
    expect(screen.getByText('Latest text 12')).toBeInTheDocument()
    if (!open || visibility) {
      open = true
      await act(async () => {
        visibility?.mockReturnValue('visible')
        page.rerender(pane('Latest text 12'))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(catalogCalls()).toHaveLength(1)
    }
  } finally { page.unmount(); visibility?.mockRestore() }
})

test.each(['retained', 'browser'] as const)('%s hidden catalog does not scan changing history', async boundary => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Visible history'))
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(
    boundary === 'browser' ? 'hidden' : 'visible')
  let open = boundary !== 'retained'
  const readBlocks = vi.fn(() => blocks)
  const messages: WorkbenchMessage[] = Array.from({ length: 64 }, (_, index) => ({
    id: `hidden-history-${index}`, role: 'assistant', status: 'done', content: '',
    createdAt: '2026-11-23T00:00:00Z', get blocks() { return readBlocks() },
  }))
  const pane = () => <RetainedPage open={open}><ToolsCatalogProvider
    taskId="hidden-history" serverId="remote" messages={[...messages]}>
    <p>Existing content</p>
  </ToolsCatalogProvider></RetainedPage>
  const page = render(pane())
  try {
    for (let index = 0; index < 40; index++) page.rerender(pane())
    expect(readBlocks).not.toHaveBeenCalled()
    expect(catalogCalls()).toHaveLength(0)
    open = true
    await act(async () => {
      visibility.mockReturnValue('visible')
      page.rerender(pane())
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(readBlocks).toHaveBeenCalled()
    expect(catalogCalls()).toHaveLength(1)
  } finally { page.unmount(); visibility.mockRestore() }
})

test('text output with saved tools ignores status changes and additional tool names', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Current history tools'))
  const readBlocks = vi.fn(() => blocks)
  const saved: WorkbenchMessage[] = Array.from({ length: 64 }, (_, index) => ({
    id: `catalog-output-${index}`, role: 'assistant', status: 'done', content: '',
    createdAt: '2026-11-23T00:00:00Z', get blocks() { return readBlocks() },
  }))
  const pane = (content: string, history = saved) => <ToolsCatalogProvider taskId="output-history"
    serverId="remote" messages={[...history, { id: 'live-output', role: 'assistant',
      status: 'streaming', content, createdAt: '2026-11-23T00:00:00Z' }]}>
    <p>{content}</p>
  </ToolsCatalogProvider>
  const page = render(pane('Output 0'))
  try {
    await act(async () => {})
    const scans = readBlocks.mock.calls.length
    expect(scans).toBeGreaterThan(0)
    for (let index = 1; index <= 40; index++) page.rerender(pane(`Output ${index}`))
    expect(readBlocks).toHaveBeenCalledTimes(scans)
    expect(screen.getByText('Output 40')).toBeInTheDocument()
    expect(catalogCalls()).toHaveLength(1)
    page.rerender(pane('Output 40', [{ id: saved[0].id, role: 'assistant', status: 'done', content: '',
      createdAt: saved[0].createdAt, blocks: [{ ...blocks[0], toolName: 'new_tool' }] }, ...saved.slice(1)]))
    expect(catalogCalls()).toHaveLength(1)
  } finally { page.unmount() }
})

function ProgressProbe() {
  const projection = useGeneratingToolBlocks([], true, 'progress-message', 'attempt', '')
  return <><output data-testid="progress-count">{projection.blocks.length}</output>
    <ToolLineProgress id="hidden-call" running /></>
}

test.each(['retained', 'browser'] as const)('%s hidden progress idles display subscribers while preserving the Native lease and terminal state', async boundary => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Visible progress'))
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let open = true
  const consumer = new ToolPathPreviewConsumer(), client = {}
  const listeners = new Set<() => void>()
  const subscribe = toolPathPreviews.subscribe
  const subscription = vi.spyOn(toolPathPreviews, 'subscribe').mockImplementation((listener, ...scope) => {
    listeners.add(listener)
    const unsubscribe = subscribe(listener, ...scope)
    return () => { listeners.delete(listener); unsubscribe() }
  })
  const acquire = toolPathPreviews.acquire
  const release = vi.fn()
  const lease = vi.spyOn(toolPathPreviews, 'acquire').mockImplementation((target, task) => {
    const dispose = acquire(target, task)
    return () => { release(); dispose() }
  })
  const readInputs = vi.spyOn(toolPathPreviews, 'readInputs')
  const hasInputs = vi.spyOn(toolPathPreviews, 'hasInputs')
  const readLines = vi.spyOn(toolPathPreviews, 'readToolLines')
  const pane = () => <RetainedPage open={open}><ToolsCatalogProvider taskId="hidden-progress"
    serverId="remote" messages={[]}><ProgressProbe /></ToolsCatalogProvider></RetainedPage>
  const page = render(pane())
  const send = (sequence: number, terminal = false) => consumer.handle(
    terminal ? 'turn/completed' : sequence === 1 ? 'turn/started' : 'item/event', {
      serverId: 'instance', threadId: 'wire', turnId: 'turn', sequence,
      ...(!terminal && sequence > 1 ? { event: { type: 'tool_input_progress',
        id: 'hidden-call', name: 'write', chars: sequence * 10,
        lines: { generatedLines: sequence } } } : {}),
    }, 'remote', 'hidden-progress', client)
  const setVisible = async (visible: boolean) => act(async () => {
    if (boundary === 'retained') open = visible
    else visibility.mockReturnValue(visible ? 'visible' : 'hidden')
    page.rerender(pane())
    document.dispatchEvent(new Event('visibilitychange'))
  })
  try {
    await act(async () => { send(1); send(2) })
    expect(screen.getByTestId('progress-count')).toHaveTextContent('1')
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+2')
    await setVisible(false)
    readInputs.mockClear(); hasInputs.mockClear(); readLines.mockClear()
    for (let sequence = 3; sequence <= 18; sequence++) await act(async () => { send(sequence) })
    expect(listeners.size).toBe(0)
    expect(readInputs).not.toHaveBeenCalled()
    expect(hasInputs).not.toHaveBeenCalled()
    expect(readLines).not.toHaveBeenCalled()
    expect(lease).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    await setVisible(true)
    expect(screen.getByTestId('progress-count')).toHaveTextContent('1')
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+18')
    await setVisible(false)
    await act(async () => { send(19, true) })
    await setVisible(true)
    expect(screen.getByTestId('progress-count')).toHaveTextContent('0')
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    page.unmount()
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    page.unmount(); consumer.dispose(); visibility.mockRestore(); subscription.mockRestore()
    lease.mockRestore(); readInputs.mockRestore(); hasInputs.mockRestore(); readLines.mockRestore()
  }
})

test.each(['kcoder:tools-catalog-invalidated', LOCAL_MODEL_SETTINGS_CHANGED_EVENT])(
  '%s coalesces same-turn invalidations before catalog RPC dispatch', async event => {
    vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Initial metadata'))
    const page = render(view('burst-task'))
    try {
      await screen.findByText(/Initial metadata/)
      expect(catalogCalls()).toHaveLength(1)
      vi.mocked(requestLocalExecutor).mockResolvedValue(catalog('Current metadata'))
      await act(async () => {
        for (let index = 0; index < 100; index++) window.dispatchEvent(new Event(event))
      })
      expect(catalogCalls()).toHaveLength(2)
      expect(screen.getByText(/Current metadata/)).toBeInTheDocument()
      act(() => { window.dispatchEvent(new Event(event)); page.unmount() })
      await act(async () => {})
      expect(catalogCalls()).toHaveLength(2)
    } finally { page.unmount() }
  }
)


test('target-scoped invalidations do not reread or clear a different target catalog', async () => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue(catalog('Original target metadata'))
  const page = render(view('scoped-invalidation'))
  try {
    await screen.findByText(/Original target metadata/)
    for (let i = 0; i < 40; i++) await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'other-target' } }))
    })
    expect(catalogCalls()).toHaveLength(1)
    expect(screen.getByText(/Original target metadata/)).toBeInTheDocument()
    vi.mocked(requestLocalExecutor).mockResolvedValue(catalog('Current target metadata'))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'remote' } }))
    })
    expect(catalogCalls()).toHaveLength(2)
    expect(screen.getByText(/Current target metadata/)).toBeInTheDocument()
    await act(async () => { window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')) })
    expect(catalogCalls()).toHaveLength(3)
  } finally { page.unmount() }
})


test.each(['remote', 'other-target'])('a %s notice preserves the correct pending catalog lifetime', async deviceId => {
  let finish!: (value: unknown) => void
  vi.mocked(requestLocalExecutor).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(catalog('Replacement metadata'))
  const page = render(view('pending-scoped-invalidation'))
  try {
    await waitFor(() => expect(catalogCalls()).toHaveLength(1))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId } }))
    })
    expect(catalogCalls()).toHaveLength(deviceId === 'remote' ? 2 : 1)
    await act(async () => { finish(catalog('Original pending metadata')) })
    expect(screen.getByText(deviceId === 'remote' ? /Replacement metadata/ : /Original pending metadata/)).toBeInTheDocument()
    expect(screen.queryByText(deviceId === 'remote' ? /Original pending metadata/ : /Replacement metadata/)).not.toBeInTheDocument()
  } finally { page.unmount() }
})
