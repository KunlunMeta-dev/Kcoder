import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ToolPathPreviewConsumer } from '@/kcoder/toolPathPreview'
import { ToolPathPreviewStatus } from './ToolPathPreviewStatus'

test.each([false, true])(
  'keeps a new turn suppressed while unmounted, with scope recycling %s',
  recycle => {
    const consumer = new ToolPathPreviewConsumer()
    const client = {}
    const send = (method: string, turnId: string, sequence: number, path?: string) => {
      act(() =>
        consumer.handle(
          method,
          {
            serverId: 'instance',
            threadId: 'thread',
            turnId,
            sequence,
            event: { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path },
          },
          'target',
          'task',
          client
        )
      )
    }
    let view = render(<ToolPathPreviewStatus target="target" task="task" />)
    try {
      send('turn/started', 'first', 1)
      send('item/event', 'first', 2, 'visible.ts')
      expect(screen.getByTestId('tool-path-preview')).toHaveTextContent('visible.ts')
      view.unmount()
      if (recycle) {
        send('turn/completed', 'first', 3)
        for (let index = 0; index < 128; index++) {
          const params = { serverId: 'instance', threadId: 'thread', turnId: 'turn' }
          consumer.handle(
            'turn/started',
            { ...params, sequence: 1 },
            'target',
            `other-${index}`,
            client
          )
          consumer.handle(
            'turn/completed',
            { ...params, sequence: 2 },
            'target',
            `other-${index}`,
            client
          )
        }
      }
      send('turn/started', 'second', 4)
      send('item/event', 'second', 5, 'unobserved.ts')
      view = render(<ToolPathPreviewStatus target="target" task="task" />)
      expect(screen.queryByTestId('tool-path-preview')).toBeNull()
      send('item/event', 'second', 6, 'fresh.ts')
      expect(screen.getByTestId('tool-path-preview')).toHaveTextContent('fresh.ts')
    } finally {
      view.unmount()
      act(() => consumer.dispose())
    }
  }
)

test('keeps long and numerous paths to three compact rows with bounded safe titles', () => {
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const view = render(<ToolPathPreviewStatus target="target" task="task" />)
  try {
    act(() => {
      consumer.handle(
        'turn/started',
        { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence: 0 },
        'target',
        'task',
        client
      )
      for (let index = 0; index < 64; index++)
        consumer.handle(
          'item/event',
          {
            serverId: 'instance',
            threadId: 'thread',
            turnId: 'turn',
            sequence: index + 1,
            event: {
              type: 'tool_path_preview',
              attempt_id: 'a',
              id: String(index),
              path: '\u001b'.repeat(4096),
            },
          },
          'target',
          'task',
          client
        )
    })
    expect(view.container.querySelectorAll('bdi')).toHaveLength(3)
    expect(screen.getByTestId('tool-path-preview')).toHaveTextContent('另有 61 项')
    for (const path of view.container.querySelectorAll('bdi')) {
      expect(path.textContent!.length).toBeLessThanOrEqual(2048)
      expect(path.getAttribute('title')!.length).toBeLessThanOrEqual(2048)
      expect(path.closest('div')).toHaveClass('truncate')
    }
  } finally {
    view.unmount()
    act(() => consumer.dispose())
  }
})
