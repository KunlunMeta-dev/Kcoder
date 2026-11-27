import { expect, test } from 'vitest'
import {
  acceptWidgetPreviewNotification,
  clearWidgetPreviews,
  readWidgetPreviews,
} from './widgetPreviewEvents'

test('actual preview prefixes respect sequence, attempt, reset, terminal and owner replacement', () => {
  clearWidgetPreviews('preview-target')
  const identity = {
    deviceId: 'preview-target',
    taskId: 'task',
    threadId: 'thread',
    turnId: 'turn',
    attemptId: 'attempt',
    client: {},
    serverId: 'instance',
    sequence: 1,
  }
  const event = (source: string) => ({
    type: 'widget_input_preview',
    id: 'call',
    preview: { source, format: 'svg', bytes: source.length, complete: false, truncated: false },
  })
  acceptWidgetPreviewNotification(identity, 'turn/started')
  acceptWidgetPreviewNotification({ ...identity, sequence: 2 }, 'item/event', event('<svg>'))
  expect(readWidgetPreviews('preview-target', 'task')[0].source).toBe('<svg>')
  acceptWidgetPreviewNotification({ ...identity, sequence: 1 }, 'item/event', event('stale'))
  acceptWidgetPreviewNotification(
    { ...identity, sequence: 3, attemptId: 'old-attempt' },
    'item/event',
    event('wrong')
  )
  expect(readWidgetPreviews('preview-target', 'task')[0].source).toBe('<svg>')
  acceptWidgetPreviewNotification({ ...identity, sequence: 4 }, 'item/event', {
    type: 'tool_input_reset',
  })
  expect(readWidgetPreviews('preview-target', 'task')).toEqual([])
  acceptWidgetPreviewNotification({ ...identity, sequence: 5 }, 'item/event', event('<svg><rect/>'))
  acceptWidgetPreviewNotification({ ...identity, sequence: 6 }, 'turn/completed')
  acceptWidgetPreviewNotification({ ...identity, sequence: 7 }, 'item/event', event('late'))
  expect(readWidgetPreviews('preview-target', 'task')[0].source).toBe('<svg><rect/>')
  acceptWidgetPreviewNotification(
    { ...identity, client: {}, serverId: 'next-instance', sequence: 1 },
    'turn/started'
  )
  expect(readWidgetPreviews('preview-target', 'task')).toEqual([])
  clearWidgetPreviews('preview-target')
})
