import { afterEach, expect, test, vi } from 'vitest'
import { GatewayRuntimeCore } from './core'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

const runtimes: GatewayRuntimeCore[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.disposeAsync()
  vi.useRealTimers()
})

async function createAcceptedTurn(receipt: Record<string, unknown>, startStatus?: string) {
  const client = new FakeGatewayClient('receipt-thread')
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'turn/start' && startStatus) {
      client.requests.push({ method, params })
      return { turn: { id: 'receipt-thread-turn', status: startStatus } } as T
    }
    if (method === 'turn/receipt/read') {
      client.requests.push({ method, params })
      return { receipt } as T
    }
    return original<T>(method, params)
  }
  const runtime = new GatewayRuntimeCore('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  runtimes.push(runtime)
  const created = await runtime.request('runtime.tasks.create', {
    clientMessageId: 'owned-input-1', executionRequest: { prompt: 'one input' },
  }) as { taskId: string }
  return { runtime, client, taskId: created.taskId }
}

test('an already completed creation acknowledgement never reopens a running turn', async () => {
  const { runtime, taskId } = await createAcceptedTurn({}, 'completed')
  expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
  expect(runtime.tasks.get(taskId)?.running).toBe(false)
  expect(runtime.turnReceiptObservers.size).toBe(0)
})

test.each(['completed', 'failed', 'interrupted'])('reconciles a lost %s notification from the original receipt', async status => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  window.addEventListener('kcoder:turn-receipt-reconciled', refresh)
  try {
    const { runtime, client, taskId } = await createAcceptedTurn({
      threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status,
    })
    expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
    expect(runtime.tasks.get(taskId)?.turnStatus).toBe(status)
    expect(refresh).toHaveBeenCalledOnce()
    expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toEqual([
      { method: 'turn/receipt/read', params: { threadId: 'receipt-thread', clientMessageId: 'owned-input-1' } },
    ])
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(refresh).toHaveBeenCalledOnce()
  } finally {
    window.removeEventListener('kcoder:turn-receipt-reconciled', refresh)
  }
})

test('an older attempt receipt cannot settle current work and disposal stops observation', async () => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({
    threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status: 'completed', attemptId: 'old-attempt',
  })
  runtime.turnAttemptIds.set(`${taskId}:receipt-thread-turn`, 'current-attempt')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
  await runtime.disposeAsync()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(1)
  expect(runtime.turnReceiptObservers.size).toBe(0)
})
