import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeSubagentConversation } from './subagentConversation'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
import {
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
} from '@/host/localExecutor'

vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))
vi.mock('@/lib/random-id', () => ({ createRandomUuid: () => 'owned-sub' }))
const address = { deviceId: 'device', taskId: 'parent', threadId: 'thread' }
const identity = { threadId: 'thread', agentId: 'child', subscriptionId: 'owned-sub', runId: 'run' }
const snapshot = {
  ...identity,
  sequence: 1,
  active: true,
  activeAssistantItemId: 'answer',
  messages: [
    {
      id: 'answer',
      role: 'assistant',
      status: 'streaming',
      content: 'first',
      timestampMs: 1770000000000,
    },
  ],
}
let listener: (event: LocalExecutorEvent) => void
const unlisten = vi.fn()
function send(sequence: number, text: string, overrides = {}) {
  listener({
    event: 'response.subagent.conversation',
    payload: {
      deviceId: address.deviceId,
      taskId: address.taskId,
      data: {
        type: 'event',
        ...identity,
        sequence,
        occurredAtMs: 1770000000001,
        method: 'item/delta',
        params: { itemId: 'answer', delta: { text } },
        ...overrides,
      },
    },
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(subscribeLocalExecutorEvents).mockImplementation(async handler => {
    listener = handler
    return unlisten
  })
  vi.mocked(requestLocalExecutor).mockImplementation(async method =>
    method.endsWith('subscribe') ? snapshot : { unsubscribed: true }
  )
})
describe('owned child conversation IPC subscription', () => {
  it('uses its own retry status, restores the countdown, and clears it at actual model progress', async () => {
    const parent = new ToolPathPreviewConsumer()
    const client = {}
    const parentTurn = { threadId: address.threadId, serverId: 'main-server', turnId: 'parent-turn' }
    const retry = {
      type: 'system_notice', kind: 'provider_retry', request_kind: 'main',
      attempt: 2, max_retries: 5, retry_after_ms: 1200,
    }
    parent.handle('turn/started', { ...parentTurn, sequence: 1 }, address.deviceId, address.taskId, client)
    parent.handle('item/event', {
      ...parentTurn, sequence: 2, event: { ...retry, attempt: 1, retry_after_ms: 9000 },
    }, address.deviceId, address.taskId, client)
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({ ...snapshot, pendingEvents: [retry] })
    const child = await subscribeSubagentConversation({ address, agentId: 'child' }, vi.fn())
    try {
      expect(child.snapshot.activityTaskId).toBeDefined()
      const childRetry = () => toolPathPreviews.readProviderRetry(address.deviceId, child.snapshot.activityTaskId)
      expect(childRetry()).toMatchObject({ attempt: 2, retryAfterMs: 1200 })
      await new Promise(resolve => setTimeout(resolve, 0))
      send(2, '', { method: 'item/event', params: { event: { type: 'assistant_thinking_started' } } })
      expect(childRetry()).toBeNull()
      send(3, '', { method: 'item/event', params: { event: { ...retry, attempt: 3 } } })
      expect(childRetry()?.attempt).toBe(3)
      expect(toolPathPreviews.readProviderRetry(address.deviceId, address.taskId)?.attempt).toBe(1)
      await child.unsubscribe()
      expect(childRetry()).toBeNull()
    } finally {
      await child.unsubscribe()
      parent.dispose()
    }
  })

  it('installs listener before admission and applies an early delta after its snapshot', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(requestLocalExecutor).mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const events = vi.fn()
    const pending = subscribeSubagentConversation({ address, agentId: 'child' }, events)
    await vi.waitFor(() => expect(requestLocalExecutor).toHaveBeenCalled())
    send(2, ' next')
    expect(events).not.toHaveBeenCalled()
    resolve(snapshot)
    const result = await pending
    expect(result.snapshot.messages[0].content).toBe('first')
    await vi.waitFor(() => expect(events).toHaveBeenCalledOnce())
    expect(events.mock.calls[0][0].actions[0]).toMatchObject({
      type: 'assistant_chunk',
      content: ' next',
    })
    await result.unsubscribe()
    expect(unlisten).toHaveBeenCalledOnce()
    send(3, 'late')
    expect(events).toHaveBeenCalledOnce()
  })
  it('drops duplicates and reports gaps before mutating projection state', async () => {
    const events = vi.fn(),
      result = await subscribeSubagentConversation({ address, agentId: 'child' }, events)
    await new Promise(resolve => setTimeout(resolve, 0))
    send(2, ' second')
    send(2, 'duplicate')
    send(4, 'gap')
    expect(events).toHaveBeenCalledTimes(2)
    expect(events.mock.calls[1][0].actions).toEqual([])
    await result.unsubscribe()
  })
  it('rejects a different child identity and unregisters on admission failure', async () => {
    vi.mocked(requestLocalExecutor).mockImplementationOnce(async () => ({
      ...snapshot,
      agentId: 'foreign',
    }))
    await expect(
      subscribeSubagentConversation({ address, agentId: 'child' }, vi.fn())
    ).rejects.toThrow('identity changed')
    expect(unlisten).toHaveBeenCalledOnce()
  })
  it('ignores stale reset snapshots before they can replace the projection mirror', async () => {
    const events = vi.fn(),
      result = await subscribeSubagentConversation({ address, agentId: 'child' }, events)
    await new Promise(resolve => setTimeout(resolve, 0))
    send(2, ' second')
    send(1, '', { type: 'reset', messages: [{ ...snapshot.messages[0], content: 'stale' }] })
    send(3, '', {
      method: 'item/completed',
      params: { item: { id: 'answer', type: 'agentMessage' } },
    })
    expect(events).toHaveBeenCalledTimes(2)
    expect(events.mock.calls[1][0].actions[0]).toMatchObject({
      type: 'reset',
      messages: [expect.objectContaining({ content: 'first second', status: 'done' })],
    })
    await result.unsubscribe()
  })
  it('resubscribes after overflowing early frames instead of replaying an incomplete stream', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(requestLocalExecutor).mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const events = vi.fn()
    const pending = subscribeSubagentConversation({ address, agentId: 'child' }, events)
    await vi.waitFor(() => expect(requestLocalExecutor).toHaveBeenCalled())
    for (let i = 0; i < 4097; i += 1) send(i + 2, ' buffered')
    resolve(snapshot)
    const result = await pending
    await vi.waitFor(() => expect(events).toHaveBeenCalledOnce())
    expect(events.mock.calls[0][0]).toMatchObject({
      type: 'disconnected',
      reason: 'subagent stream buffer exceeded',
    })
    await result.unsubscribe()
  })
})
