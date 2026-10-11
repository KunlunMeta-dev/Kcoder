import '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import { ToolBlockItem } from './ToolBlockItem'
import { ToolLineProgress } from './ToolLineProgress'

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
