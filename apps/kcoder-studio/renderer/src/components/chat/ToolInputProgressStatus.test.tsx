import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ToolPathPreviewConsumer } from '@/kcoder/toolPathPreview'
import { ToolInputProgressStatus } from './ToolInputProgressStatus'
import '@/i18n'

test.each(['write', 'edit', 'apply_patch', 'CreateWorkPlan', 'EditWorkPlan', 'AppendWorkNotepad',
  'RecordTaskAcceptance', 'RecordTaskAcceptances', 'ReopenTask', 'SelectActiveWork',
  'spawn_agent', 'explore_agent', 'custom_mutation'])
('shows preparation spinner for %s and hands off on actual tool start', (name) => {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const view = render(<ToolInputProgressStatus target="target" task="task" />)
  const send = (method: string, sequence: number, extra = {}) => act(() => consumer.handle(method,
    { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, ...extra },
    'target', 'task', client))
  try {
    send('turn/started', 1)
    send('item/event', 2, { event: { type: 'tool_input_progress', id: 'write', name, chars: 0 } })
    expect(screen.getByTestId('tool-input-progress-status')).toHaveTextContent(name)
    expect(screen.getByTestId('tool-input-progress-status').querySelector('svg')).toHaveClass('animate-spin')
    send('item/event', 3, { event: { type: 'tool_input_progress', id: 'write', name, chars: 2048 } })
    expect(screen.getByTestId('tool-input-progress-status')).toHaveTextContent('2048')
    send('item/started', 4, { item: { id: 'write', type: 'toolCall' } })
    expect(screen.queryByTestId('tool-input-progress-status')).toBeNull()
    send('item/event', 5, { event: { type: 'tool_input_progress', id: 'next', name: 'edit', chars: 0 } })
    send('turn/completed', 6)
    expect(screen.queryByTestId('tool-input-progress-status')).toBeNull()
  } finally { view.unmount(); consumer.dispose() }
})
