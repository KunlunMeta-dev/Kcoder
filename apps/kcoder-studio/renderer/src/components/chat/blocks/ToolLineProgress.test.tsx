import '@/i18n'
import { Profiler } from 'react'
import { act, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import { ToolBlockItem } from './ToolBlockItem'
import { ToolLineProgress } from './ToolLineProgress'

test('one tool argument stream does not read every peer tool row in the same task', () => {
  const consumer = new ToolPathPreviewConsumer(), client = {}
  const target = 'line-fanout-target', task = 'line-fanout-task'
  const release = toolPathPreviews.acquire(target, task)
  const ids = Array.from({ length: 64 }, (_, index) => `writer-${index}`)
  const view = render(<ToolProgressScopeContext.Provider value={{ target, task }}>
    {ids.map(id => <ToolLineProgress key={id} id={id} running />)}
  </ToolProgressScopeContext.Provider>)
  let sequence = 0
  const send = (method: string, extra = {}) => act(() => consumer.handle(method,
    { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence: ++sequence, ...extra },
    target, task, client))
  const input = (id: string, chars: number) => send('item/event', {
    event: { type: 'tool_input_progress', id, name: 'write', chars, lines: { generatedLines: 1 } },
  })
  try {
    send('turn/started')
    ids.forEach(id => input(id, 1))
    expect(screen.getAllByTestId('tool-line-progress')).toHaveLength(ids.length)
    const reads = vi.spyOn(toolPathPreviews, 'readToolLines')
    try {
      for (let chars = 2; chars <= 41; chars++) input(ids[0], chars)
      const current = reads.mock.calls.filter(call => call[2] === ids[0]).length
      const peers = reads.mock.calls.length - current
      console.info(JSON.stringify({ toolRows: ids.length, updates: 40, currentReads: current, peerReads: peers }))
      expect(peers).toBe(0)
      expect(current).toBe(40)
    } finally { reads.mockRestore() }
    send('item/event', { event: { type: 'tool_input_reset' } })
    expect(screen.queryAllByTestId('tool-line-progress')).toHaveLength(0)
  } finally { view.unmount(); release(); consumer.dispose() }
})

test('unchanged generated-line counts do not redraw the tool row while character progress advances', () => {
  const consumer = new ToolPathPreviewConsumer(), client = {}, rendered = vi.fn()
  const release = toolPathPreviews.acquire('stable-lines-target', 'stable-lines-task')
  const view = render(
    <ToolProgressScopeContext.Provider value={{ target: 'stable-lines-target', task: 'stable-lines-task' }}>
      <Profiler id="line-progress" onRender={rendered}><ToolLineProgress id="writer" running /></Profiler>
    </ToolProgressScopeContext.Provider>
  )
  let sequence = 0
  const send = (method: string, extra = {}) => act(() => consumer.handle(method,
    { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence: ++sequence, ...extra },
    'stable-lines-target', 'stable-lines-task', client))
  const input = (chars: number, lines?: { generatedLines: number; replacedLines?: number }) =>
    send('item/event', { event: { type: 'tool_input_progress', id: 'writer', name: 'write', chars, lines } })
  const changed = vi.fn()
  const unsubscribe = toolPathPreviews.subscribe(changed, 'stable-lines-target', 'stable-lines-task')
  try {
    send('turn/started')
    input(1, { generatedLines: 2 })
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+2')
    rendered.mockClear(); changed.mockClear()
    for (let chars = 2; chars <= 41; chars++) input(chars, { generatedLines: 2 })
    expect(toolPathPreviews.readInputs('stable-lines-target', 'stable-lines-task')[0].chars).toBe(41)
    expect(changed).toHaveBeenCalledTimes(40)
    expect(rendered).not.toHaveBeenCalled()
    input(42, { generatedLines: 3, replacedLines: 0 })
    expect(rendered).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+3-0')
    input(43, { generatedLines: 3, replacedLines: 1 })
    expect(rendered).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+3-1')
    input(44)
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    input(45, { generatedLines: 3 })
    expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+3')
    send('turn/completed')
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
  } finally { unsubscribe(); view.unmount(); release(); consumer.dispose() }
})

test.each([
  { kind: 'unobserved', generated: true, files: 0, binaryFiles: 0, partial: true },
  { kind: 'unobserved', generated: false, files: 0, binaryFiles: 0, partial: true },
  { kind: 'binary-only', generated: true, files: 2, binaryFiles: 2, partial: false },
  { kind: 'binary-only', generated: false, files: 2, binaryFiles: 2, partial: false },
])('uses only known generated text for $kind progress (generated=$generated)', scenario => {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const release = toolPathPreviews.acquire('fallback-target', 'fallback-task')
  const content = (running: boolean) => (
    <ToolProgressScopeContext.Provider value={{ target: 'fallback-target', task: 'fallback-task' }}>
      <ToolLineProgress id="writer" running={running} />
    </ToolProgressScopeContext.Provider>
  )
  const view = render(content(true))
  const send = (method: string, sequence: number, extra = {}) =>
    act(() =>
      consumer.handle(
        method,
        { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
        'fallback-target',
        'fallback-task',
        client
      )
    )
  try {
    send('turn/started', 1)
    if (scenario.generated) {
      send('item/event', 2, {
        event: {
          type: 'tool_input_progress',
          id: 'writer',
          name: 'write',
          chars: 256,
          lines: { generatedLines: 17, replacedLines: 5 },
        },
      })
    }
    send('item/started', 3, { item: { type: 'toolCall', id: 'writer' } })
    send('item/event', 4, {
      event: {
        type: 'tool_file_progress',
        id: 'writer',
        counts: {
          additions: 0,
          deletions: 0,
          files: scenario.files,
          binaryFiles: scenario.binaryFiles,
          partial: scenario.partial,
        },
      },
    })
    if (scenario.generated) {
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+17-5')
      expect(screen.getByTestId('tool-line-progress').title).toMatch(/尚未写入|Not yet written/)
    } else expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    expect(view.container.textContent).not.toContain('+0')
    expect(view.container.textContent).not.toContain('-0')
    view.rerender(content(false))
    expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
  } finally {
    view.unmount()
    release()
    consumer.dispose()
  }
})

test.each(['write', 'edit', 'apply_patch', 'PowerShell', 'plugin__custom_writer'])(
  'updates the %s tool row live without a workspace summary',
  name => {
    const consumer = new ToolPathPreviewConsumer()
    const client = {}
    const release = toolPathPreviews.acquire('lines-target', 'lines-task')
    const view = render(
      <ToolProgressScopeContext.Provider value={{ target: 'lines-target', task: 'lines-task' }}>
        <ToolBlockItem
          block={{
            id: 'writer',
            subtaskId: 'task',
            type: 'tool',
            toolName: name,
            status: 'streaming',
            createdAt: Date.now(),
          }}
        />
      </ToolProgressScopeContext.Provider>
    )
    const send = (method: string, sequence: number, extra = {}) =>
      act(() =>
        consumer.handle(
          method,
          { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
          'lines-target',
          'lines-task',
          client
        )
      )
    try {
      send('turn/started', 1)
      send('item/event', 2, {
        event: {
          type: 'tool_input_progress',
          id: 'writer',
          name,
          chars: 128,
          lines: { generatedLines: 12, replacedLines: 3 },
        },
      })
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+12-3')
      expect(screen.getByTestId('tool-line-progress').title).toMatch(/尚未写入|Not yet written/)
      send('item/started', 3, { item: { type: 'toolCall', id: 'writer' } })
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+12-3')
      send('item/event', 4, {
        event: {
          type: 'tool_file_progress',
          id: 'writer',
          counts: { additions: 15, deletions: 4, files: 1 },
        },
      })
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+15-4')
      send('item/event', 5, {
        event: {
          type: 'tool_file_progress',
          id: 'writer',
          counts: { additions: 21, deletions: 4, files: 2, partial: true },
        },
      })
      expect(screen.getByTestId('tool-line-progress')).toHaveTextContent('+21-4*')
      expect(screen.queryByTestId('workspace-file-progress')).not.toBeInTheDocument()
      send('turn/cancelled', 6)
      expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
    } finally {
      view.unmount()
      release()
      consumer.dispose()
    }
  }
)

test('a tool without an explicit conversation scope cannot display another task counts', () => {
  const view = render(
    <ToolBlockItem
      block={{
        id: 'writer',
        subtaskId: 'child',
        type: 'tool',
        toolName: 'write',
        status: 'streaming',
        createdAt: Date.now(),
      }}
    />
  )
  expect(screen.queryByTestId('tool-line-progress')).not.toBeInTheDocument()
  view.unmount()
})
