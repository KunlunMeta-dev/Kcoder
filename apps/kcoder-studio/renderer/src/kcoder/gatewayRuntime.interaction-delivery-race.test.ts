import { listen } from '@/lib/runtime-events'
import { expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

test.each(['question', 'approval'] as const)(
  '%s request and immediate resolution cannot reopen a pending card through the registered client',
  async kind => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = []
    const stop = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event', event => events.push(event.payload)
    )
    const client = new FakeGatewayClient('delivery-thread')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    try {
      const { taskId } = await runtime.request('runtime.tasks.create', {
        taskId: 'delivery-draft', executionRequest: { prompt: 'controlled task' },
      }) as { taskId: string }
      const params = { threadId: 'delivery-thread', turnId: 'delivery-turn', appServerEpoch: 'delivery-epoch',
        ...(kind === 'question'
          ? { questionId: 'delivery-question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
          : { approvalId: 'delivery-approval', action: { type: 'command', command: 'echo controlled' } }) }
      client.dispatchEvent(new CustomEvent('request', {
        detail: { id: 1_000_000, method: `${kind}/request`, params },
      }))
      client.emitNotification(`${kind}/resolved`, { ...params, requestId: 1_000_000, reason: 'cancelled' })
      await vi.waitFor(() => expect(events.some(event => event.event === 'response.block.updated')).toBe(true))
      await Promise.all([...runtime.pendingAsyncJobs])
      expect(runtime.pendingQuestionByKey.has(`${taskId}\0${1_000_000}`)).toBe(false)
      const cardEvents = events.filter(event => {
        const data = event.payload.data as { blockId?: string; block?: { id?: string } }
        return ['response.block.created', 'response.block.updated'].includes(event.event) &&
          (data?.blockId === 'request-user-input-1000000' || data?.block?.id === 'request-user-input-1000000')
      })
      expect(cardEvents.map(event => event.event)).toEqual(['response.block.updated'])
      expect(client.responses).toEqual([])
    } finally {
      stop()
    }
  }
)

test('a registered request replay recovers from an actual UI listener failure without answering', async () => {
  const client = new FakeGatewayClient('publication-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const cards: unknown[] = []
  let failPublication = true
  const stopFailure = await listen<{ event: string }>('local-executor:event', event => {
    if (failPublication && event.payload.event === 'response.block.created')
      throw new Error('question UI listener temporarily unavailable')
  })
  const stopCards = await listen<{ event: string; payload: unknown }>('local-executor:event', event => {
    if (event.payload.event === 'response.block.created') cards.push(event.payload.payload)
  })
  try {
    const { taskId } = await runtime.request('runtime.tasks.create', {
      taskId: 'publication-draft', executionRequest: { prompt: 'controlled task' },
    }) as { taskId: string }
    const request = { id: 1_000_000, method: 'question/request', params: {
      threadId: 'publication-thread', turnId: 'publication-turn', appServerEpoch: 'publication-epoch',
      questionId: 'publication-question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }],
    } }
    await expect(runtime.forwardServerRequest(client, request, 'local'))
      .rejects.toThrow('question UI listener temporarily unavailable')
    const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${request.id}`)
    expect(pending).toBeDefined()
    expect(cards).toHaveLength(0)

    failPublication = false
    client.dispatchEvent(new CustomEvent('request', { detail: request }))
    await vi.waitFor(() => expect(cards).toHaveLength(1))
    expect(cards[0]).toMatchObject({ taskId, data: { block: pending!.block } })
    expect(runtime.pendingQuestionByKey.get(`${taskId}\0${request.id}`)).toBe(pending)
    client.dispatchEvent(new CustomEvent('request', { detail: request }))
    await Promise.all([...runtime.pendingAsyncJobs])
    expect(cards).toHaveLength(1)
    expect(client.responses).toEqual([])
  } finally {
    stopFailure()
    stopCards()
    await runtime.disposeAsync()
  }
})
