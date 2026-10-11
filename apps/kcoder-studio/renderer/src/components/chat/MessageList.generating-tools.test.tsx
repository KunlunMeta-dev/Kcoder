import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import * as toolsCatalogContext from '@/kcoder/toolsCatalogContext'
import { ToolsCatalogProvider } from '@/kcoder/toolsCatalog'
import { MessageList } from './MessageList'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
  isTauri: () => false,
}))

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

test('keeps incremental generation visible for 84 sequential tools with bounded retained counters', async () => {
  const catalogSpy = vi.spyOn(toolsCatalogContext, 'readToolsCatalog').mockResolvedValue({
    entries: new Map(),
    total: 0,
    truncated: false,
  })
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  let blocks: ProcessingBlock[] = []
  const original: WorkbenchMessage = {
    id: 'long-assistant',
    subtaskId: 'long-attempt',
    role: 'assistant',
    status: 'streaming',
    content: '',
    createdAt: '2026-10-11T00:00:00Z',
  }
  const content = () => (
    <ToolsCatalogProvider serverId="long-target" taskId="long-task">
      <MessageList messages={[{ ...original, blocks }]} processingWindowEnabled />
    </ToolsCatalogProvider>
  )
  const view = render(content())
  let sequence = 1
  const send = (method: string, extra = {}) =>
    act(() =>
      consumer.handle(
        method,
        {
          serverId: 'long-instance',
          threadId: 'long-thread',
          turnId: 'long-turn',
          sequence: sequence++,
          ...extra,
        },
        'long-target',
        'long-task',
        client
      )
    )
  try {
    await act(async () => {})
    send('turn/started')
    for (let index = 0; index < 84; index++) {
      const id = `long-write-${index}`
      for (const count of [1, 3]) {
        send('item/event', {
          event: {
            type: 'tool_input_progress',
            id,
            name: 'write',
            chars: count * 8,
            lines: { generatedLines: count },
          },
        })
        const counter = view.container.querySelector(
          `[data-testid="tool-line-progress"][data-tool-id="${id}"]`
        )
        expect(counter).toHaveTextContent(`+${count}`)
        expect(toolPathPreviews.readInputs('long-target', 'long-task')).toHaveLength(1)
      }
      const active: ProcessingBlock = {
        id,
        subtaskId: 'long-attempt',
        type: 'tool',
        toolName: 'write',
        status: 'streaming',
        createdAt: index + 1,
      }
      act(() => {
        send('item/started', { item: { type: 'toolCall', id } })
        blocks = [...blocks, active]
        view.rerender(content())
      })
      send('item/event', {
        event: { type: 'tool_file_progress', id, counts: { additions: 3, deletions: 0, files: 1 } },
      })
      act(() => {
        send('item/completed', { item: { type: 'toolCall', id } })
        blocks = blocks.map(block =>
          block.id === id ? { ...block, status: 'done', completedAt: index + 2 } : block
        )
        view.rerender(content())
      })
      send('item/event', {
        event: {
          type: 'tool_input_progress',
          id,
          name: 'write',
          chars: 999,
          lines: { generatedLines: 99 },
        },
      })
      expect(toolPathPreviews.readInputs('long-target', 'long-task')).toHaveLength(0)
    }
    const retained = Array.from({ length: 84 }, (_, index) =>
      toolPathPreviews.readToolLines('long-target', 'long-task', `long-write-${index}`)
    ).filter(Boolean)
    expect(retained).toHaveLength(64)
    expect(toolPathPreviews.readToolLines('long-target', 'long-task', 'long-write-0')).toBeNull()
    for (let index = 20; index < 84; index++) {
      send('item/event', {
        event: {
          type: 'tool_input_progress',
          id: `long-write-${index}`,
          name: 'write',
          chars: 999,
          lines: { generatedLines: 99 },
        },
      })
    }
    expect(toolPathPreviews.readInputs('long-target', 'long-task')).toHaveLength(0)
    // An expired tombstone does not permit replaying its original low sequence.
    send('item/event', {
      sequence: 2,
      event: {
        type: 'tool_input_progress',
        id: 'long-write-0',
        name: 'write',
        chars: 8,
        lines: { generatedLines: 1 },
      },
    })
    expect(toolPathPreviews.readInputs('long-target', 'long-task')).toHaveLength(0)
    send('turn/completed')
    expect(toolPathPreviews.readInputs('long-target', 'long-task')).toHaveLength(0)
    expect(toolPathPreviews.readToolLines('long-target', 'long-task', 'long-write-83')).toBeNull()
  } finally {
    view.unmount()
    consumer.dispose()
    catalogSpy.mockRestore()
    clearPersistentProcessingExpansions()
  }
}, 15000)

test('renders each short generation and actual write observation before completion through the provider lease', async () => {
  const catalogSpy = vi.spyOn(toolsCatalogContext, 'readToolsCatalog').mockResolvedValue({
    entries: new Map(),
    total: 0,
    truncated: false,
  })
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const original: WorkbenchMessage = {
    id: 'live-assistant',
    subtaskId: 'live-attempt',
    role: 'assistant',
    status: 'streaming',
    content: '',
    createdAt: '2026-10-11T00:00:00Z',
  }
  const content = (message = original) => (
    <ToolsCatalogProvider serverId="live-target" taskId="live-task">
      <MessageList messages={[message]} processingWindowEnabled />
    </ToolsCatalogProvider>
  )
  const view = render(content())
  const send = (method: string, sequence: number, extra = {}) =>
    act(() =>
      consumer.handle(
        method,
        {
          serverId: 'live-instance',
          threadId: 'live-thread',
          turnId: 'live-turn',
          sequence,
          ...extra,
        },
        'live-target',
        'live-task',
        client
      )
    )
  try {
    await act(async () => {})
    send('turn/started', 1)
    send('item/event', 2, {
      event: { type: 'tool_input_progress', id: 'live-write', name: 'write', chars: 0 },
    })
    expect(screen.getByTestId('processing-window')).toHaveTextContent(
      /正在生成 write 工具参数|Preparing write input/
    )
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    send('item/event', 3, {
      event: {
        type: 'tool_input_progress',
        id: 'live-write',
        name: 'write',
        chars: 14,
        lines: { generatedLines: 1 },
      },
    })
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+1')
    send('item/event', 4, {
      event: {
        type: 'tool_input_progress',
        id: 'live-write',
        name: 'write',
        chars: 29,
        lines: { generatedLines: 2 },
      },
    })
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+2')
    fireEvent.click(screen.getByTestId('processing-window-toggle'))
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    send('item/event', 5, {
      event: {
        type: 'tool_input_progress',
        id: 'live-write',
        name: 'write',
        chars: 36,
        lines: { generatedLines: 3 },
      },
    })
    fireEvent.click(screen.getByTestId('processing-window-toggle'))
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+3')
    expect(screen.getByTestId('tool-line-progress').title).toMatch(/尚未写入|Not yet written/)

    const executing: WorkbenchMessage = {
      ...original,
      blocks: [
        {
          id: 'live-write',
          subtaskId: 'live-attempt',
          type: 'tool',
          toolName: 'write',
          status: 'streaming',
          createdAt: Date.now(),
          toolInput: { path: 'live.txt' },
        },
      ],
    }
    act(() => {
      send('item/started', 6, { item: { type: 'toolCall', id: 'live-write' } })
      view.rerender(content(executing))
    })
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+3')
    const observe = (sequence: number, additions: number, deletions: number, files: number) =>
      send('item/event', sequence, {
        event: {
          type: 'tool_file_progress',
          id: 'live-write',
          counts: { additions, deletions, files, binaryFiles: 0, partial: false },
        },
      })
    // A zero execution snapshot is accurate, distinct from generated content.
    observe(7, 0, 0, 0)
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+0-0')
    expect(screen.getByTestId('tool-line-progress').title).toMatch(
      /当前工具执行前基线|since this tool started/
    )
    observe(8, 1, 0, 1)
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+1-0')
    observe(9, 4, 1, 1)
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+4-1')
    // A writer can undo its own changes; counters must reflect the observation.
    observe(10, 2, 0, 1)
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+2-0')
    expect(screen.queryByTestId('workspace-file-progress')).not.toBeInTheDocument()
    expect(original.blocks).toBeUndefined()
  } finally {
    view.unmount()
    consumer.dispose()
    catalogSpy.mockRestore()
    clearPersistentProcessingExpansions()
  }
})

test('keeps pending message content between the completed group and generating tool group', () => {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const release = toolPathPreviews.acquire('narrative-target', 'narrative-task')
  const readBlock = {
    id: 'read-call',
    subtaskId: 'attempt',
    type: 'tool' as const,
    toolName: 'read',
    status: 'done' as const,
    createdAt: 1,
    completedAt: 2,
  }
  const original: WorkbenchMessage = {
    id: 'assistant',
    role: 'assistant',
    status: 'streaming',
    subtaskId: 'attempt',
    createdAt: '2026-10-11T00:00:00Z',
    content: '接下来写报告。',
    blocks: [readBlock],
  }
  const originalJson = JSON.stringify(original)
  const content = (message = original) => (
    <ToolProgressScopeContext.Provider
      value={{ target: 'narrative-target', task: 'narrative-task' }}
    >
      <MessageList messages={[message]} processingWindowEnabled />
    </ToolProgressScopeContext.Provider>
  )
  const view = render(content())
  const send = (method: string, sequence: number, extra = {}) =>
    act(() =>
      consumer.handle(
        method,
        { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
        'narrative-target',
        'narrative-task',
        client
      )
    )
  const assertOrder = () => {
    const groups = screen.getAllByTestId('processing-group')
    const narrative = screen.getByText('接下来写报告。')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveTextContent(/已处理|Processed/)
    expect(groups[0].querySelector('.animate-spin')).toBeNull()
    expect(groups[1]).toHaveTextContent(/正在处理|Processing/)
    expect(groups[0].contains(narrative)).toBe(false)
    expect(groups[1].contains(narrative)).toBe(false)
    expect(
      groups[0].compareDocumentPosition(narrative) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      narrative.compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getAllByText('接下来写报告。')).toHaveLength(1)
  }
  try {
    send('turn/started', 1)
    send('item/event', 2, {
      event: {
        type: 'tool_input_progress',
        id: 'write-call',
        name: 'write',
        chars: 256,
        lines: { generatedLines: 19, replacedLines: 2 },
      },
    })
    assertOrder()
    expect(screen.getByTestId('processing-window')).toHaveTextContent(
      /正在生成 write 工具参数|Preparing write input/
    )
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+19-2')
    expect(JSON.stringify(original)).toBe(originalJson)
    act(() => {
      send('item/started', 3, { item: { type: 'toolCall', id: 'write-call' } })
      view.rerender(
        content({
          ...original,
          content: '',
          blocks: [
            readBlock,
            {
              id: 'real-narrative',
              subtaskId: 'attempt',
              type: 'text',
              status: 'done',
              content: original.content,
              createdAt: 3,
            },
            {
              id: 'write-call',
              subtaskId: 'attempt',
              type: 'tool',
              toolName: 'write',
              status: 'streaming',
              createdAt: 4,
              toolInput: { path: 'report.md' },
            },
          ],
        })
      )
    })
    assertOrder()
    expect(view.container.querySelectorAll('[data-processing-block-id="write-call"]')).toHaveLength(
      1
    )
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+19-2')
  } finally {
    view.unmount()
    release()
    consumer.dispose()
    clearPersistentProcessingExpansions()
  }
})

test.each([false, true])(
  'projects real generation events into the processing window (hasNarrative=%s)',
  hasNarrative => {
    const consumer = new ToolPathPreviewConsumer()
    const client = {}
    const release = toolPathPreviews.acquire('generation-target', 'generation-task')
    const original: WorkbenchMessage = {
      id: 'assistant',
      role: 'assistant',
      status: 'streaming',
      content: '',
      subtaskId: 'attempt',
      createdAt: '2026-10-11T00:00:00Z',
      ...(hasNarrative
        ? {
            blocks: [
              {
                id: 'narrative',
                subtaskId: 'attempt',
                type: 'text',
                content: '正在准备修改文件。',
                status: 'done',
                createdAt: 1,
              },
            ],
          }
        : {}),
    }
    const originalJson = JSON.stringify(original)
    const content = (message = original, enabled = true, scoped = true) => (
      <ToolProgressScopeContext.Provider
        value={scoped ? { target: 'generation-target', task: 'generation-task' } : {}}
      >
        <MessageList messages={[message]} processingWindowEnabled={enabled} />
      </ToolProgressScopeContext.Provider>
    )
    const view = render(content())
    const send = (method: string, sequence: number, extra = {}) =>
      act(() =>
        consumer.handle(
          method,
          { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
          'generation-target',
          'generation-task',
          client
        )
      )
    try {
      expect(screen.queryByTestId('processing-window')).not.toBeInTheDocument()
      send('turn/started', 1)
      send('item/event', 2, {
        event: {
          type: 'tool_input_progress',
          id: 'write-call',
          name: 'write',
          chars: 128,
          lines: { generatedLines: 12, replacedLines: 3 },
        },
      })
      const window = screen.getByTestId('processing-window')
      expect(window).toHaveTextContent(/正在生成 write 工具参数|Preparing write input/)
      expect(window).toHaveTextContent('+12-3')
      expect(window.querySelectorAll('[data-processing-block-id="write-call"]')).toHaveLength(1)
      if (hasNarrative) {
        expect(screen.getByText('正在准备修改文件。')).toBeInTheDocument()
        expect(window).not.toHaveTextContent('正在准备修改文件。')
      }
      send('item/event', 3, {
        event: {
          type: 'tool_input_progress',
          id: 'write-call',
          name: 'write',
          chars: 256,
          lines: { generatedLines: 27, replacedLines: 3 },
        },
      })
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+27-3')
      expect(JSON.stringify(original)).toBe(originalJson)

      // The actual started DTO replaces the transient projection by stable call ID.
      act(() => {
        send('item/started', 4, { item: { type: 'toolCall', id: 'write-call' } })
        view.rerender(
          content({
            ...original,
            blocks: [
              ...(original.blocks ?? []),
              {
                id: 'write-call',
                subtaskId: 'attempt',
                type: 'tool',
                toolName: 'write',
                status: 'streaming',
                createdAt: Date.now(),
                toolInput: { path: 'example.txt' },
              },
            ],
          })
        )
      })
      expect(
        view.container.querySelectorAll('[data-processing-block-id="write-call"]')
      ).toHaveLength(1)
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+27-3')
      expect(screen.getByTestId('processing-window')).not.toHaveTextContent(
        '正在生成 write 工具参数'
      )

      send('turn/cancelled', 5)
      view.rerender(content({ ...original, status: 'done' }))
      expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    } finally {
      view.unmount()
      release()
      consumer.dispose()
      clearPersistentProcessingExpansions()
    }
  }
)

test.each([
  { enabled: false, scoped: true, status: 'streaming' as const },
  { enabled: true, scoped: false, status: 'streaming' as const },
  { enabled: true, scoped: true, status: 'done' as const },
])('does not project generation outside the enabled active scope: %j', scenario => {
  const consumer = new ToolPathPreviewConsumer()
  const release = toolPathPreviews.acquire('fenced-target', 'fenced-task')
  const client = {}
  const view = render(
    <ToolProgressScopeContext.Provider
      value={scenario.scoped ? { target: 'fenced-target', task: 'fenced-task' } : {}}
    >
      <MessageList
        messages={[
          {
            id: 'assistant',
            role: 'assistant',
            content: '',
            status: scenario.status,
            createdAt: '2026-10-11T00:00:00Z',
          },
        ]}
        processingWindowEnabled={scenario.enabled}
      />
    </ToolProgressScopeContext.Provider>
  )
  try {
    act(() => {
      consumer.handle(
        'turn/started',
        { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence: 1 },
        'fenced-target',
        'fenced-task',
        client
      )
      consumer.handle(
        'item/event',
        {
          serverId: 'instance',
          threadId: 'thread',
          turnId: 'turn',
          sequence: 2,
          event: {
            type: 'tool_input_progress',
            id: 'write-call',
            name: 'write',
            chars: 128,
            lines: { generatedLines: 12 },
          },
        },
        'fenced-target',
        'fenced-task',
        client
      )
    })
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-processing-block-id="write-call"]')).toBeNull()
  } finally {
    view.unmount()
    release()
    consumer.dispose()
    clearPersistentProcessingExpansions()
  }
})
