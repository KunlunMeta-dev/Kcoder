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

test.each(['text', 'thinking'])('defers receipt reads during valid %s output and reconciles after 15 seconds of silence', async kind => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({
    threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status: 'completed',
  })
  const source = runtime.tasks.get(taskId)!.serverId
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(10_000)
    await runtime.forwardNotification(kind === 'text' ? 'item/delta' : 'item/event', {
      threadId: 'receipt-thread', turnId: 'receipt-thread-turn',
      ...(kind === 'text' ? { delta: { text: 'more' } } : { event: { type: 'assistant_thinking_delta', text: 'more' } }),
    }, source, client)
    expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(0)
  }
  await vi.advanceTimersByTimeAsync(14_999)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(1)
  expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
})

test.each(['client', 'target', 'thread', 'turn', 'attempt', 'empty', 'unknown-event'])('a %s mismatch cannot postpone original receipt reconciliation', async mismatch => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({
    threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status: 'completed', attemptId: 'current-attempt',
  })
  runtime.turnAttemptIds.set(`${taskId}:receipt-thread-turn`, 'current-attempt')
  await vi.advanceTimersByTimeAsync(10_000)
  await runtime.forwardNotification(mismatch === 'unknown-event' ? 'item/event' : 'item/delta', {
    threadId: mismatch === 'thread' ? 'foreign-thread' : 'receipt-thread',
    turnId: mismatch === 'turn' ? 'foreign-turn' : 'receipt-thread-turn',
    attemptId: mismatch === 'attempt' ? 'old-attempt' : 'current-attempt',
    delta: { text: mismatch === 'empty' ? '' : 'foreign output' },
    ...(mismatch === 'unknown-event' ? { event: { type: 'unknown', text: 'ignored' } } : {}),
  }, mismatch === 'target' ? 'foreign-target' : runtime.tasks.get(taskId)!.serverId,
  mismatch === 'client' ? new FakeGatewayClient('receipt-thread') : client)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(1)
})

test('a normal terminal notification cancels quiet-time observation without a receipt read', async () => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({})
  const source = runtime.tasks.get(taskId)!.serverId
  await vi.advanceTimersByTimeAsync(10_000)
  await runtime.forwardNotification('item/delta', { threadId: 'receipt-thread',
    turnId: 'receipt-thread-turn', delta: { text: 'current output' } }, source, client)
  await runtime.forwardNotification('turn/completed', { threadId: 'receipt-thread',
    turn: { id: 'receipt-thread-turn', status: 'completed' } }, source, client)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(0)
  expect(runtime.turnReceiptObservers.size).toBe(0)
})

test('a running receipt stays bounded and an account change stops further reads', async () => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({
    threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status: 'running',
  })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(2)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
  runtime.accountEpochByTarget.set(runtime.tasks.get(taskId)!.serverId, {})
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(2)
  expect(runtime.turnReceiptObservers.size).toBe(0)
})


test.each(['configuration', 'connection'] as const)('a changed %s retires the original quiet-time receipt observer', async boundary => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({
    threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status: 'completed',
  })
  if (boundary === 'configuration') runtime.configurationEpochByTarget.set(runtime.tasks.get(taskId)!.serverId, {})
  else Object.assign(client, { diagnosticConnection: { connectionId: 'replacement-socket' } })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(0)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
  expect(runtime.turnReceiptObservers.size).toBe(0)
})


test.each(['configuration', 'connection'] as const)('a receipt returned after %s replacement cannot settle the original turn', async boundary => {
  vi.useFakeTimers()
  const { runtime, client, taskId } = await createAcceptedTurn({})
  const request = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method !== 'turn/receipt/read') return request<T>(method, params)
    client.requests.push({ method, params })
    if (boundary === 'configuration') runtime.configurationEpochByTarget.set(runtime.tasks.get(taskId)!.serverId, {})
    else Object.assign(client, { diagnosticConnection: { connectionId: 'replacement-socket' } })
    return { receipt: { threadId: 'receipt-thread', turnId: 'receipt-thread-turn', status: 'completed' } } as T
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(1)
  expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
  expect(runtime.turnReceiptObservers.size).toBe(0)
})
