import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolPathPreviewConsumer, toolPathPreviews } from './toolPathPreview'

const consumers: ToolPathPreviewConsumer[] = []
const releaseLeases: Array<() => void> = []

test.each(['reset', 'complete', 'resume', 'disconnect', 'clearTask', 'dispose', 'release'] as const)(
  '%s still reconciles every tool subscriber after selective argument progress', action => {
    const f = fixture(false), first = vi.fn(), second = vi.fn(), task = vi.fn(), foreign = vi.fn()
    const release = toolPathPreviews.acquire('target', 'task')
    const close = [
      toolPathPreviews.subscribe(first, 'target', 'task', 'first'),
      toolPathPreviews.subscribe(second, 'target', 'task', 'second'),
      toolPathPreviews.subscribe(task, 'target', 'task'),
      toolPathPreviews.subscribe(foreign, 'other-target', 'task', 'first'),
    ]
    let released = false
    try {
      f.send('item/event', 2, { event: { type: 'tool_input_progress', id: 'first', name: 'write', chars: 1 } })
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
      expect(task).toHaveBeenCalledTimes(1)
      for (const listener of [first, second, task]) listener.mockClear()
      if (action === 'reset') f.send('item/event', 3, { event: { type: 'tool_input_reset' } })
      else if (action === 'complete') f.send('turn/completed', 3)
      else if (action === 'resume') f.consumer.seedResume({ serverId: 'instance', throughSequence: 3,
        activeTurn: { id: 'turn', threadId: 'thread', status: 'running', attemptId: 'attempt' },
      }, 'target', 'task', 'thread', f.client)
      else if (action === 'disconnect') f.consumer.disconnect(f.client)
      else if (action === 'clearTask') f.consumer.clearTask('task')
      else if (action === 'dispose') f.consumer.dispose()
      else { release(); released = true }
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(task).toHaveBeenCalledTimes(1)
      expect(foreign).not.toHaveBeenCalled()
      expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
    } finally { close.forEach(unsubscribe => unsubscribe()); if (!released) release() }
  }
)

test.each(['disconnect', 'clearTask', 'dispose'] as const)(
  '%s retires its scopes without notifying peer tasks and publishes one cleanup cohort', action => {
    const f = fixture(), peer = new ToolPathPreviewConsumer(), peerClient = {}
    const selected = vi.fn(), second = vi.fn(), unrelated = vi.fn(), global = vi.fn()
    const release = toolPathPreviews.acquire('target', 'peer-task')
    const close = [
      toolPathPreviews.subscribe(selected, 'target', 'task'),
      toolPathPreviews.subscribe(second, 'second-target', 'task'),
      toolPathPreviews.subscribe(unrelated, 'target', 'peer-task'),
      toolPathPreviews.subscribe(global),
    ]
    const frame = { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence: 1 }
    try {
      f.send('item/event', 2, {
        event: { type: 'tool_input_progress', id: 'pending', name: 'read', chars: 8 },
      })
      f.consumer.handle('turn/started', frame, 'second-target', 'task', f.client)
      peer.handle('turn/started', frame, 'target', 'peer-task', peerClient)
      peer.handle('item/event', { ...frame, sequence: 2,
        event: { type: 'tool_input_progress', id: 'peer-input', name: 'read', chars: 16 },
      }, 'target', 'peer-task', peerClient)
      for (const listener of [selected, second, unrelated, global]) listener.mockClear()
      if (action === 'disconnect') f.consumer.disconnect(f.client)
      else if (action === 'clearTask') f.consumer.clearTask('task')
      else f.consumer.dispose()
      expect(selected).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(unrelated).not.toHaveBeenCalled()
      expect(global).toHaveBeenCalledTimes(1)
      expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
      expect(toolPathPreviews.readInputs('target', 'peer-task')).toEqual([
        expect.objectContaining({ id: 'peer-input', chars: 16 }),
      ])
    } finally { close.forEach(unsubscribe => unsubscribe()); release(); peer.dispose() }
  }
)

test('closing metadata-only clients or empty owners does not invalidate tool progress', () => {
  const f = fixture(), listener = vi.fn(), empty = new ToolPathPreviewConsumer()
  const close = toolPathPreviews.subscribe(listener)
  const revision = toolPathPreviews.snapshot()
  try {
    for (let index = 0; index < 40; index++) f.consumer.disconnect({})
    f.consumer.clearTask('missing-task')
    empty.dispose()
    expect(listener).not.toHaveBeenCalled()
    expect(toolPathPreviews.snapshot()).toBe(revision)
  } finally { close(); empty.dispose() }
})

test('display notifications select the exact target/task and retain global cleanup notifications', () => {
  const f = fixture(), selected = vi.fn(), global = vi.fn()
  const other = new ToolPathPreviewConsumer(), client = {}
  const close = toolPathPreviews.subscribe(selected, 'target', 'task')
  const closeGlobal = toolPathPreviews.subscribe(global)
  const release = toolPathPreviews.acquire('target', 'peer-task')
  try {
    for (const [target, task] of [['peer-target', 'task'], ['target', 'peer-task']]) {
      other.handle('turn/started', { serverId: 'peer-instance', threadId: task,
        turnId: 'peer-turn', sequence: 1 }, target, task, client)
    }
    expect(selected).not.toHaveBeenCalled()
    expect(global).toHaveBeenCalledTimes(2)
    f.send('item/event', 2, { event: { type: 'tool_input_progress', id: 'pending', name: 'read', chars: 8 } })
    expect(selected).toHaveBeenCalledTimes(1)
    expect(f.consumer.seedResume({ serverId: 'instance', throughSequence: 3,
      activeTurn: { id: 'turn', threadId: 'thread', status: 'running', attemptId: 'attempt' },
    }, 'target', 'task', 'thread', f.client)).toBe(true)
    expect(selected).toHaveBeenCalledTimes(2)
    expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
    for (const cleanup of [() => f.consumer.clearTask('task'),
      () => f.consumer.disconnect(f.client), () => f.consumer.dispose()]) {
      const before = selected.mock.calls.length
      cleanup()
      expect(selected).toHaveBeenCalledTimes(before + 1)
    }
    close()
    const before = selected.mock.calls.length
    other.dispose()
    expect(selected).toHaveBeenCalledTimes(before)
    expect(global).toHaveBeenCalledTimes(8)
  } finally { close(); closeGlobal(); release(); other.dispose() }
})

test('input presence follows the exact display scope and retires at completion', () => {
  const { send } = fixture()
  expect(toolPathPreviews.hasInputs('target', 'task')).toBe(false)
  send('item/event', 2, { event: { type: 'tool_input_progress', id: 'pending', name: 'read', chars: 8 } })
  expect(toolPathPreviews.hasInputs('target', 'task')).toBe(true)
  expect(toolPathPreviews.hasInputs('peer', 'task')).toBe(false)
  expect(toolPathPreviews.hasInputs('target', 'peer')).toBe(false)
  send('turn/completed', 3)
  expect(toolPathPreviews.hasInputs('target', 'task')).toBe(false)
})

test('limits pending generations concurrently and accepts a new tool when a slot opens', () => {
  const { send } = fixture()
  let sequence = 2
  const input = (id: string, chars = 8) =>
    send('item/event', sequence++, {
      event: {
        type: 'tool_input_progress',
        id,
        name: 'write',
        chars,
        lines: { generatedLines: chars / 8 },
      },
    })
  for (let index = 0; index < 64; index++) input(`pending-${index}`)
  input('waiting-for-slot')
  expect(toolPathPreviews.readInputs('target', 'task')).toHaveLength(64)
  expect(
    toolPathPreviews.readInputs('target', 'task').some(item => item.id === 'waiting-for-slot')
  ).toBe(false)
  input('pending-63', 16)
  expect(
    toolPathPreviews.readToolLines('target', 'task', 'pending-63')?.generated?.generatedLines
  ).toBe(2)
  send('item/started', sequence++, { item: { type: 'toolCall', id: 'pending-0' } })
  input('waiting-for-slot', 16)
  expect(toolPathPreviews.readInputs('target', 'task')).toHaveLength(64)
  expect(
    toolPathPreviews.readToolLines('target', 'task', 'waiting-for-slot')?.generated?.generatedLines
  ).toBe(2)
  input('pending-0', 24)
  expect(toolPathPreviews.readInputs('target', 'task').some(item => item.id === 'pending-0')).toBe(
    false
  )
})

test('retains active identity fences while the presentation lease is released', () => {
  const { send } = fixture(false)
  const close = toolPathPreviews.acquire('target', 'task')
  send('item/started', 2, { item: { type: 'toolCall', id: 'still-running' } })
  close()
  const reopen = toolPathPreviews.acquire('target', 'task')
  releaseLeases.push(reopen)
  send('item/event', 3, {
    event: {
      type: 'tool_input_progress',
      id: 'still-running',
      name: 'write',
      chars: 24,
      lines: { generatedLines: 3 },
    },
  })
  expect(toolPathPreviews.readInputs('target', 'task')).toHaveLength(0)
  send('item/event', 4, {
    event: {
      type: 'tool_file_progress',
      id: 'still-running',
      counts: { additions: 2, deletions: 0, files: 1 },
    },
  })
  expect(
    toolPathPreviews.readToolLines('target', 'task', 'still-running')?.observed?.additions
  ).toBe(2)
})

test('continues observing sequential writers after the bounded input tombstones fill', () => {
  const { send } = fixture()
  let sequence = 2
  for (let index = 0; index < 80; index++) {
    const id = `writer-${index}`
    send('item/started', sequence++, { item: { type: 'toolCall', id } })
    send('item/event', sequence++, {
      event: {
        type: 'tool_file_progress',
        id,
        counts: { additions: index + 1, deletions: 0, files: 1 },
      },
    })
    expect(toolPathPreviews.readToolLines('target', 'task', id)?.observed?.additions).toBe(
      index + 1
    )
    send('item/completed', sequence++, { item: { type: 'toolCall', id } })
    send('item/event', sequence++, {
      event: { type: 'tool_file_progress', id, counts: { additions: 999, deletions: 0, files: 1 } },
    })
    expect(toolPathPreviews.readToolLines('target', 'task', id)?.observed?.additions).toBe(
      index + 1
    )
  }
  expect(toolPathPreviews.readToolLines('target', 'task', 'writer-0')).toBeNull()
})

test('keeps generated lines on the tool row until observed tool-owned changes replace them', () => {
  const { send } = fixture()
  send('item/event', 2, {
    event: {
      type: 'tool_input_progress',
      id: 'edit',
      name: 'edit',
      chars: 256,
      lines: { generatedLines: 15, replacedLines: 4 },
    },
  })
  send('item/started', 3, { item: { type: 'toolCall', id: 'edit' } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  expect(toolPathPreviews.readToolLines('target', 'task', 'edit')).toEqual({
    generated: { generatedLines: 15, replacedLines: 4 },
  })
  send('item/event', 4, {
    event: {
      type: 'tool_file_progress',
      id: 'edit',
      counts: { additions: 8, deletions: 3, files: 1 },
    },
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'edit')).toEqual({
    generated: { generatedLines: 15, replacedLines: 4 },
    observed: { additions: 8, deletions: 3, files: 1, binaryFiles: 0, partial: false },
  })
  send('item/completed', 5, { item: { type: 'toolCall', id: 'edit' } })
  send('item/event', 6, {
    event: {
      type: 'tool_file_progress',
      id: 'edit',
      counts: { additions: 999, deletions: 0, files: 1 },
    },
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'edit')?.observed?.additions).toBe(8)
  send('turn/completed', 7)
  expect(toolPathPreviews.readToolLines('target', 'task', 'edit')).toBeNull()
})

test('attributes execution counts by tool id and never projects turn totals onto a tool', () => {
  const { send } = fixture()
  send('item/started', 2, { item: { type: 'toolCall', id: 'first' } })
  send('item/event', 3, {
    event: { type: 'workspace_file_progress', counts: { additions: 40, deletions: 10, files: 3 } },
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'first')).toBeNull()
  send('item/event', 4, {
    event: {
      type: 'tool_file_progress',
      id: 'first',
      counts: { additions: 4, deletions: 1, files: 1 },
    },
  })
  send('item/completed', 5, { item: { type: 'toolCall', id: 'first' } })
  send('item/started', 6, { item: { type: 'toolCall', id: 'second' } })
  send('item/event', 7, {
    event: {
      type: 'tool_file_progress',
      id: 'second',
      counts: { additions: 2, deletions: 5, files: 1 },
    },
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'first')?.observed).toMatchObject({
    additions: 4,
    deletions: 1,
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'second')?.observed).toMatchObject({
    additions: 2,
    deletions: 5,
  })
  expect(toolPathPreviews.readToolLines('other', 'task', 'second')).toBeNull()
  send('item/event', 8, {
    event: {
      type: 'tool_file_progress',
      id: 'not-started',
      counts: { additions: 12, deletions: 0, files: 1 },
    },
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'not-started')).toBeNull()
  send('item/event', 9, {
    event: {
      type: 'tool_file_progress',
      id: 'second',
      counts: { additions: -1, deletions: 0, files: 1 },
    },
  })
  expect(toolPathPreviews.readToolLines('target', 'task', 'second')?.observed?.additions).toBe(2)
})

test('does not keep generated content counts as a completed write receipt', () => {
  const { send } = fixture()
  send('item/event', 2, {
    event: {
      type: 'tool_input_progress',
      id: 'write',
      name: 'write',
      chars: 128,
      lines: { generatedLines: 8 },
    },
  })
  send('item/started', 3, { item: { type: 'toolCall', id: 'write' } })
  expect(toolPathPreviews.readToolLines('target', 'task', 'write')?.generated?.generatedLines).toBe(
    8
  )
  send('item/completed', 4, { item: { type: 'toolCall', id: 'write', status: 'error' } })
  expect(toolPathPreviews.readToolLines('target', 'task', 'write')).toBeNull()
})

test('observed file changes update independently of tool names and clear at the turn boundary', () => {
  const { send } = fixture()
  send('item/event', 2, {
    event: {
      type: 'workspace_file_progress',
      counts: { additions: 8, deletions: 3, files: 2, binaryFiles: 0, partial: false },
    },
  })
  expect(toolPathPreviews.readFiles('target', 'task')).toMatchObject({ additions: 8, deletions: 3 })
  send('item/event', 3, {
    event: { type: 'workspace_file_progress', counts: { additions: 20, deletions: 5, files: 2 } },
  })
  expect(toolPathPreviews.readFiles('target', 'task')).toMatchObject({
    additions: 20,
    deletions: 5,
  })
  expect(toolPathPreviews.readFiles('other', 'task')).toBeNull()
  send('turn/completed', 4)
  expect(toolPathPreviews.readFiles('target', 'task')).toBeNull()
  send('item/event', 5, {
    event: { type: 'workspace_file_progress', counts: { additions: 99, deletions: 9, files: 2 } },
  })
  expect(toolPathPreviews.readFiles('target', 'task')).toBeNull()
})

test('tool input progress remains transient and clears when execution starts or the turn ends', () => {
  const { send } = fixture()
  const input = (sequence: number, chars: number) =>
    send('item/event', sequence, {
      event: {
        type: 'tool_input_progress',
        id: 'write-1',
        name: 'write',
        chars,
        input: 'must-not-retain',
      },
    })
  input(2, 0)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([
    { id: 'write-1', name: 'write', chars: 0 },
  ])
  input(3, 512)
  expect(toolPathPreviews.readInputs('target', 'task')[0].chars).toBe(512)
  expect(toolPathPreviews.readInputs('other', 'task')).toEqual([])
  send('item/started', 4, { item: { type: 'toolCall', id: 'write-1', name: 'write', input: {} } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  input(5, 1024)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  send('item/event', 6, {
    event: { type: 'tool_input_progress', id: 'write-2', name: 'edit', chars: 0 },
  })
  send('turn/completed', 7)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  input(8, 2048)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
})

test('disconnect removes pending input and rejects malformed counters', () => {
  const { send, consumer, client } = fixture()
  for (const [index, chars] of [-1, Infinity, '10'].entries()) {
    send('item/event', index + 2, {
      event: { type: 'tool_input_progress', id: 'a', name: 'write', chars },
    })
  }
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  send('item/event', 5, {
    event: { type: 'tool_input_progress', id: 'a', name: 'write', chars: 128 },
  })
  consumer.disconnect(client)
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
})

test('concurrent capacity is temporary and recent settled tools cannot revive preparation', () => {
  const { send } = fixture()
  let sequence = 2
  send('item/event', sequence++, {
    event: { type: 'tool_input_progress', id: 'old', name: 'write', chars: 100 },
  })
  send('item/event', sequence++, { event: { type: 'tool_input_reset' } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  for (let index = 0; index < 65; index++) {
    send('item/started', sequence++, { item: { type: 'toolCall', id: `tool-${index}` } })
  }
  send('item/event', sequence++, {
    event: { type: 'tool_input_progress', id: 'tool-64', name: 'write', chars: 200 },
  })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
  send('item/completed', sequence++, { item: { type: 'toolCall', id: 'tool-64' } })
  send('item/event', sequence++, {
    event: {
      type: 'tool_input_progress',
      id: 'fresh',
      name: 'write',
      chars: 12,
      lines: { generatedLines: 2 },
    },
  })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([
    { id: 'fresh', name: 'write', chars: 12, lines: { generatedLines: 2 } },
  ])
  send('item/event', sequence++, {
    event: { type: 'tool_input_progress', id: 'tool-64', name: 'write', chars: 220 },
  })
  expect(toolPathPreviews.readInputs('target', 'task')).toHaveLength(1)
  send('item/event', sequence++, { event: { type: 'tool_input_reset' } })
  send('item/event', sequence++, {
    event: { type: 'tool_input_progress', id: 'new', name: 'write', chars: 0 },
  })
  expect(toolPathPreviews.readInputs('target', 'task')).toHaveLength(1)
  send('item/event', sequence, { event: { type: 'system_notice', kind: 'provider_retry' } })
  expect(toolPathPreviews.readInputs('target', 'task')).toEqual([])
})

test('provider retry feedback is main-request scoped and retains only safe display metadata', () => {
  const { send } = fixture()
  const retry = {
    type: 'system_notice',
    kind: 'provider_retry',
    request_kind: 'main',
    attempt: 1,
    max_retries: 3,
    retry_after_ms: 2500,
    text: 'raw provider text must not be retained',
    reason: 'network_error',
    provider: 'OwnedProvider',
    model: 'OwnedModel',
  }
  send('item/event', 2, { event: { ...retry, request_kind: 'compact' } })
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()
  send('item/event', 3, { event: { ...retry, attempt: 0 } })
  send('item/event', 4, {
    identity: {
      run: { parentSessionId: 'parent', agentId: 'agent', runId: 'run' },
      eventId: 'event-1',
      runSequence: 1,
    },
    event: retry,
  })
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()
  send('item/event', 5, { event: retry })
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toMatchObject({
    attempt: 1,
    maxRetries: 3,
    retryAfterMs: 2500,
  })
  expect(Object.keys(toolPathPreviews.readProviderRetry('target', 'task') ?? {}).sort()).toEqual([
    'attempt',
    'diagnostics',
    'maxRetries',
    'receivedAtMs',
    'retryAfterMs',
  ])
  expect(toolPathPreviews.readProviderRetry('target', 'task')?.diagnostics).toEqual({ reason: 'network_error', provider: 'OwnedProvider', model: 'OwnedModel' })
  send('item/event', 6, { event: { ...retry, attempt: 1, reason: 'stale duplicate' } })
  expect(toolPathPreviews.readProviderRetry('target', 'task')?.attempt).toBe(1)
})

test('provider retry feedback clears on recovery, terminal events, attempt replacement, and disconnect', () => {
  const { send, consumer, client } = fixture()
  const retry = (sequence: number, currentAttemptId?: string, turnId = 'turn') =>
    send(
      'item/event',
      sequence,
      {
        turnId,
        event: {
          type: 'system_notice',
          kind: 'provider_retry',
          request_kind: 'main',
          attempt: 1,
          max_retries: 3,
          retry_after_ms: 5000,
        },
      },
      currentAttemptId
    )

  retry(2)
  expect(toolPathPreviews.readProviderRetry('target', 'task')).not.toBeNull()
  send('item/delta', 3, { delta: { text: 'first token' } })
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()

  retry(4)
  send('item/event', 5, { event: { type: 'assistant_thinking_delta', text: 'reasoning' } })
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()

  retry(6)
  send('item/started', 7, { item: { type: 'toolCall', id: 'tool-1' } })
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()

  retry(8)
  send('turn/completed', 9)
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()

  send('turn/started', 10, { turnId: 'next', attemptId: 'attempt-a' }, 'attempt-a')
  retry(11, 'attempt-a', 'next')
  send('turn/started', 12, { turnId: 'next', attemptId: 'attempt-b' }, 'attempt-b')
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()
  // An old worker's retry notice has no attempt ID on the wire. The ordered sequence
  // is lower than the new attempt's turn/started event, so it must stay retired.
  retry(11, 'attempt-b', 'next')
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()
  retry(13, 'attempt-b', 'next')
  expect(toolPathPreviews.readProviderRetry('target', 'task')).not.toBeNull()
  consumer.disconnect(client)
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()
})

test('provider retry feedback works without the tool preview capability', () => {
  const { consumer, client } = fixture()
  consumer.handle(
    'item/event',
    {
      serverId: 'instance',
      threadId: 'thread',
      turnId: 'turn',
      sequence: 2,
      event: {
        type: 'system_notice',
        kind: 'provider_retry',
        request_kind: 'main',
        attempt: 1,
        max_retries: 2,
        retry_after_ms: 1000,
      },
    },
    'target',
    'task',
    client,
    null,
    false
  )
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toMatchObject({ attempt: 1 })
  expect(toolPathPreviews.read('target', 'task')).toEqual([])
  consumer.handle(
    'item/event',
    {
      serverId: 'instance',
      threadId: 'thread',
      turnId: 'turn',
      sequence: 3,
      event: { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path: 'private/path' },
    },
    'target',
    'task',
    client,
    null,
    false
  )
  consumer.handle(
    'item/event',
    {
      serverId: 'instance',
      threadId: 'thread',
      turnId: 'turn',
      sequence: 4,
      event: { type: 'tool_input_progress', id: 'tool', name: 'write', chars: 20 },
    },
    'target',
    'task',
    client,
    null,
    false
  )
  expect(toolPathPreviews.readProviderRetry('target', 'task')).toBeNull()
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
  const send = (
    method: string,
    sequence: number,
    extra: Record<string, unknown> = {},
    attemptId?: string | null
  ) =>
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
      client,
      attemptId
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

test('scoped retry projection never retains notice bodies, credentials or sensitive URLs', () => {
  const { send } = fixture()
  send('item/event', 2, { event: { type: 'system_notice', kind: 'provider_retry', request_kind: 'main',
    attempt: 1, max_retries: 3, retry_after_ms: 500, reason: 'network_error api_key=PRIVATE_RETRY_VALUE',
    provider: 'OwnedProvider', model: 'https://user:PRIVATE_URL_PASSWORD@owned.invalid/model?token=PRIVATE_URL_TOKEN',
    elapsed_ms: 1200, transport_elapsed_ms: 1000, timeout_kind: 'transport_timeout',
    text: 'PRIVATE_NOTICE', headers: { authorization: 'PRIVATE_HEADER' }, prompt: 'PRIVATE_PROMPT' } })
  const projected = toolPathPreviews.readProviderRetry('target', 'task')
  expect(projected?.diagnostics).toMatchObject({ provider: 'OwnedProvider', model: '[URL]', previousAttemptElapsedMs: 1200, previousTransportElapsedMs: 1000 })
  expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_RETRY_VALUE|PRIVATE_URL_PASSWORD|PRIVATE_URL_TOKEN|PRIVATE_NOTICE|PRIVATE_HEADER|PRIVATE_PROMPT/)
})
