import { afterEach, describe, expect, test } from 'vitest'
import { ToolPathPreviewConsumer, toolPathPreviews } from './toolPathPreview'

const consumers: ToolPathPreviewConsumer[] = []
const releaseLeases: Array<() => void> = []

test('tool input progress remains transient and clears when execution starts or the turn ends', () => {
  const { send } = fixture()
  const input = (sequence: number, chars: number) => send('item/event', sequence, {
    event: { type: 'tool_input_progress', id: 'write-1', name: 'write', chars, input: 'must-not-retain' },
  })
  input(2, 0)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([{ id: 'write-1', name: 'write', chars: 0 }])
  input(3, 512)
  expect(toolPathPreviews.readInputs('target', 'task')[0].chars).toBe(512)
  expect(toolPathPreviews.readInputs('other', 'task')).toEqual([])
  send('item/started', 4, { item: { type: 'toolCall', id: 'write-1', name: 'write', input: {} } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  input(5, 1024)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  send('item/event', 6, { event: { type: 'tool_input_progress', id: 'write-2', name: 'edit', chars: 0 } })
  send('turn/completed', 7)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  input(8, 2048)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
})

test('disconnect removes pending input and rejects malformed counters', () => {
  const { send, consumer, client } = fixture()
  for (const [index, chars] of [-1, Infinity, '10'].entries()) {
    send('item/event', index + 2, { event: { type: 'tool_input_progress', id: 'a', name: 'write', chars } })
  }
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  send('item/event', 5, { event: { type: 'tool_input_progress', id: 'a', name: 'write', chars: 128 } })
  consumer.disconnect(client)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
})

test('attempt reset clears old preparation and exhausted tombstones cannot revive tools', () => {
  const { send } = fixture()
  let sequence = 2
  send('item/event', sequence++, { event: { type: 'tool_input_progress', id: 'old', name: 'write', chars: 100 } })
  send('item/event', sequence++, { event: { type: 'tool_input_reset' } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  for (let index = 0; index < 65; index++) {
    send('item/started', sequence++, { item: { type: 'toolCall', id: `tool-${index}` } })
  }
  send('item/event', sequence++, { event: { type: 'tool_input_progress', id: 'tool-64', name: 'write', chars: 200 } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  send('item/event', sequence++, { event: { type: 'tool_input_reset' } })
  send('item/event', sequence++, { event: { type: 'tool_input_progress', id: 'new', name: 'write', chars: 0 } })
  expect(toolPathPreviews.readInputs('target', 'task')).toHaveLength(1)
  send('item/event', sequence++, { event: { type: 'system_notice', kind: 'provider_retry' } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
})
afterEach(() => {
  releaseLeases.splice(0).forEach(release => release())
  consumers.splice(0).forEach(consumer => consumer.dispose())
})

function fixture(subscribed = true) {
  const consumer = new ToolPathPreviewConsumer()
  consumers.push(consumer)
  if (subscribed) releaseLeases.push(toolPathPreviews.acquire('target', 'task'))
  const client = {}
  const send = (method: string, sequence: number, extra: Record<string, unknown> = {}) =>
    consumer.handle(
      method,
      {
        serverId: 'instance',
        threadId: 'thread',
        turnId: 'turn',
        sequence,
        ...extra,
      },
      'target',
      'task',
      client
    )
  const preview = (sequence: number, path: string | null, attempt = 'a', id = 'tool') =>
    send('item/event', sequence, {
      event: { type: 'tool_path_preview', attempt_id: attempt, id, path },
    })
  send('turn/started', 1)
  return { consumer, client, send, preview, read: () => toolPathPreviews.read('target', 'task') }
}

describe('bounded transient tool path preview', () => {
  test('continues displaying new provider attempts after 80 invocations in one turn', () => {
    const f = fixture()
    for (let index = 0; index < 80; index++) {
      f.preview(index + 2, `path-${index}`, `attempt-${index}`)
      expect(f.read()[0].path).toBe(`path-${index}`)
    }
    f.preview(2, 'late', 'attempt-0')
    expect(f.read()[0].path).toBe('path-79')
  })
  test('rejects reordered Set/Clear and old attempts, and never revives a terminal turn', () => {
    const f = fixture()
    f.preview(2, 'old')
    f.preview(4, 'new', 'b')
    f.preview(3, null)
    f.preview(5, null)
    expect(f.read().map(item => item.path)).toEqual(['new'])
    f.preview(6, 'stale', 'a')
    expect(f.read().map(item => item.path)).toEqual(['new'])
    f.send('turn/completed', 7)
    f.preview(8, 'late', 'b')
    expect(f.read()).toEqual([])
  })

  test('new turn clears the old turn and rejects delayed notifications', () => {
    const f = fixture()
    f.preview(2, 'old')
    f.send('turn/started', 3, { turnId: 'next' })
    f.preview(4, 'late')
    expect(f.read()).toEqual([])
  })

  test('disconnect and dispose reject queued notifications', () => {
    const f = fixture()
    f.preview(2, 'old')
    f.consumer.disconnect(f.client)
    f.send('turn/started', 3, { turnId: 'next' })
    f.preview(4, 'late')
    expect(f.read()).toEqual([])
    f.consumer.dispose()
    f.send('turn/started', 5)
    expect(f.read()).toEqual([])
  })

  test('enforces UTF-8 and ID limits, safe text and 64 entries per scope', () => {
    const f = fixture()
    f.preview(2, '界'.repeat(1366))
    f.preview(3, 'path', 'a'.repeat(1025))
    expect(f.read()).toEqual([])
    f.preview(4, '<img>\u001b\n\u202e')
    expect(f.read()[0].path).toBe('<img>\\u001b\\u000a\\u202e')
    for (let index = 0; index < 100; index++) f.preview(5 + index, 'path', 'a', String(index))
    expect(f.read()).toHaveLength(64)
  })

  test('survives more than 64 turns and recycles inactive scopes after 128 tasks', () => {
    const f = fixture()
    for (let index = 0; index < 200; index++) {
      const release = toolPathPreviews.acquire('target', `task-${index}`)
      const base = { serverId: 'instance', threadId: 'thread', turnId: `turn-${index}` }
      f.consumer.handle(
        'turn/started',
        { ...base, sequence: index * 3 },
        'target',
        `task-${index}`,
        f.client
      )
      f.consumer.handle(
        'item/event',
        {
          ...base,
          sequence: index * 3 + 1,
          event: { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path: 'live' },
        },
        'target',
        `task-${index}`,
        f.client
      )
      expect(toolPathPreviews.read('target', `task-${index}`)).toHaveLength(1)
      f.consumer.handle(
        'turn/completed',
        { ...base, sequence: index * 3 + 2 },
        'target',
        `task-${index}`,
        f.client
      )
      f.send('turn/started', index * 3 + 2, { turnId: `next-${index}` })
      release()
    }
    f.send('item/event', 1000, {
      turnId: 'next-199',
      event: {
        type: 'tool_path_preview',
        attempt_id: 'a',
        id: 'tool',
        path: 'still-live',
      },
    })
    expect(f.read()[0].path).toBe('still-live')
  })

  test('new backend instance may reuse a turn ID without old client close affecting it', () => {
    const f = fixture()
    f.preview(2, 'old')
    const replacement = {}
    f.consumer.handle(
      'turn/started',
      { serverId: 'replacement', threadId: 'thread', turnId: 'turn', sequence: 0 },
      'target',
      'task',
      replacement
    )
    f.consumer.disconnect(f.client)
    f.consumer.handle(
      'item/event',
      {
        serverId: 'replacement',
        threadId: 'thread',
        turnId: 'turn',
        sequence: 1,
        event: { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path: 'replacement' },
      },
      'target',
      'task',
      replacement
    )
    expect(f.read()[0].path).toBe('replacement')
    f.send('turn/started', 999, { turnId: 'old-late' })
    expect(f.read()[0].path).toBe('replacement')
  })

  test('closing one pane preserves another lease and reopening accepts fresh Sets', () => {
    const f = fixture(false)
    const closeFirst = toolPathPreviews.acquire('target', 'task')
    const closeSecond = toolPathPreviews.acquire('target', 'task')
    f.preview(2, 'visible')
    closeFirst()
    expect(f.read()).toHaveLength(1)
    closeSecond()
    f.preview(3, 'late')
    expect(f.read()).toEqual([])
    const closeReopened = toolPathPreviews.acquire('target', 'task')
    expect(f.read()).toEqual([])
    f.preview(4, 'fresh')
    expect(f.read()[0].path).toBe('fresh')
    closeReopened()
  })
})
