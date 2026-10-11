import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ToolPathPreviewConsumer } from '@/kcoder/toolPathPreview'
import { ToolInputProgressStatus } from './ToolInputProgressStatus'
import '@/i18n'

test.each([false, true])(
  'hides workspace change summaries during generation (embedded=%s)',
  embedded => {
    const consumer = new ToolPathPreviewConsumer()
    const client = {}
    const view = render(
      <ToolInputProgressStatus target="files-target" task="files-task" embedded={embedded} />
    )
    const send = (method: string, sequence: number, extra = {}) =>
      act(() =>
        consumer.handle(
          method,
          { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
          'files-target',
          'files-task',
          client
        )
      )
    try {
      send('turn/started', 1)
      send('item/event', 2, {
        event: {
          type: 'workspace_file_progress',
          counts: { additions: 12, deletions: 3, files: 2, binaryFiles: 0, partial: false },
        },
      })
      expect(screen.queryByTestId('workspace-file-progress')).not.toBeInTheDocument()
      expect(screen.queryByTestId('tool-input-progress-status')).not.toBeInTheDocument()
      send('turn/completed', 3)
      expect(screen.queryByTestId('tool-input-progress-status')).not.toBeInTheDocument()
    } finally {
      view.unmount()
      consumer.dispose()
    }
  }
)

test('shows streamed write/edit line counts without reporting them as committed changes', () => {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const view = render(<ToolInputProgressStatus target="lines-target" task="lines-task" />)
  const send = (sequence: number, lines: unknown) =>
    act(() =>
      consumer.handle(
        'item/event',
        {
          serverId: 'instance',
          threadId: 'thread',
          turnId: 'turn',
          sequence,
          event: {
            type: 'tool_input_progress',
            id: 'edit-1',
            name: 'edit',
            chars: sequence * 128,
            lines,
          },
        },
        'lines-target',
        'lines-task',
        client
      )
    )
  try {
    act(() =>
      consumer.handle(
        'turn/started',
        { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence: 1 },
        'lines-target',
        'lines-task',
        client
      )
    )
    send(2, { generatedLines: 12, replacedLines: 8 })
    expect(screen.getByTestId('tool-input-progress-count')).toHaveTextContent('+12')
    expect(screen.getByTestId('tool-input-progress-count')).toHaveTextContent('-8')
    send(3, { generatedLines: 34, replacedLines: 8 })
    expect(screen.getByTestId('tool-input-progress-count')).toHaveTextContent('+34')
    expect(screen.getByTestId('tool-input-progress-status')).not.toHaveTextContent('已写入')
    send(4, { generatedLines: -1 })
    expect(screen.getByTestId('tool-input-progress-count')).toHaveTextContent('512')
  } finally {
    view.unmount()
    consumer.dispose()
  }
})

test.each([
  'write',
  'edit',
  'apply_patch',
  'CreateWorkPlan',
  'EditWorkPlan',
  'AppendWorkNotepad',
  'RecordTaskAcceptance',
  'RecordTaskAcceptances',
  'ReopenTask',
  'SelectActiveWork',
  'spawn_agent',
  'explore_agent',
  'custom_mutation',
])('shows preparation spinner for %s and hands off on actual tool start', name => {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const view = render(<ToolInputProgressStatus target="target" task="task" />)
  const send = (method: string, sequence: number, extra = {}) =>
    act(() =>
      consumer.handle(
        method,
        { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
        'target',
        'task',
        client
      )
    )
  try {
    send('turn/started', 1)
    send('item/event', 2, { event: { type: 'tool_input_progress', id: 'write', name, chars: 0 } })
    expect(screen.getByTestId('tool-input-progress-status')).toHaveTextContent(name)
    expect(screen.getByTestId('tool-input-progress-status').querySelector('svg')).toHaveClass(
      'animate-spin'
    )
    send('item/event', 3, {
      event: { type: 'tool_input_progress', id: 'write', name, chars: 2048 },
    })
    expect(screen.getByTestId('tool-input-progress-status')).toHaveTextContent('2048')
    send('item/started', 4, { item: { id: 'write', type: 'toolCall' } })
    expect(screen.queryByTestId('tool-input-progress-status')).toBeNull()
    send('item/event', 5, {
      event: { type: 'tool_input_progress', id: 'next', name: 'edit', chars: 0 },
    })
    send('turn/completed', 6)
    expect(screen.queryByTestId('tool-input-progress-status')).toBeNull()
  } finally {
    view.unmount()
    consumer.dispose()
  }
})
