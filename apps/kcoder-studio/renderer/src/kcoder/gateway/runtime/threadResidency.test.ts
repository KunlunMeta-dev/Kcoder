import { expect, it, vi } from 'vitest'
import { GatewayRpcError } from '../../gatewayRpc'
import { notifyAccountContextChange } from '../../accountContextEvents'
import { startTurnWithReceipt, TurnAcceptanceUnknownError } from '../../gatewayTurnReceipt'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'
import {
  isThreadEvicted,
  isThreadNotResident,
  observeThreadEvicted,
  reactivateEvictedThread,
  requestResidentTaskRpc,
} from './threadResidency'

const task = { taskId: 'task-a', threadId: 'thread-a', serverId: 'target' }
const notResident = () =>
  new GatewayRpcError('thread is not resident', -32027, { threadId: task.threadId, reason: 'capacity' }, 'unknown', 'remote')

function host(client: unknown) {
  return {
    disposed: false,
    tasks: new Map([[task.taskId, { ...task }]]),
    clientByTask: new Map([[task.taskId, client]]),
  } as unknown as GatewayRuntimeCore
}

function client(handler: (method: string, params?: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => handler(method, params))
  return { request, supportsExperimental: () => true } as unknown as GatewayClient & { request: typeof request }
}

it('resumes an evicted thread on the same connection and resends turn/start once with its stable identity', async () => {
  let starts = 0
  const target = client(method => {
    if (method === 'thread/resume') return { thread: { id: task.threadId } }
    starts += 1
    if (starts === 1) throw notResident()
    return { turn: { id: 'turn-1', status: 'running' } }
  })
  const runtime = host(target)
  const recover = vi.fn(async () => target)
  const params = { threadId: task.threadId, clientMessageId: 'stable-1', input: [] }
  const submitted = await startTurnWithReceipt(target, params, recover, {
    notResident: error => isThreadNotResident(error, task.threadId),
    reactivate: current => reactivateEvictedThread(runtime, task, current),
  })
  expect(submitted).toMatchObject({ client: target, recovered: false, result: { turn: { id: 'turn-1' } } })
  expect(target.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['turn/start', params],
    ['thread/resume', { threadId: task.threadId }],
    ['turn/start', params],
  ])
  expect(recover).not.toHaveBeenCalled()
})

it('never resends an ambiguous turn/start and does not retry without residency support', async () => {
  const ambiguous = client(method => {
    if (method === 'turn/receipt/read') return { receipt: null }
    throw new GatewayRpcError('socket closed', -1, undefined, 'unknown', 'transport')
  })
  await expect(startTurnWithReceipt(ambiguous, { threadId: task.threadId, clientMessageId: 'stable-2' },
    async () => ambiguous, { notResident: error => isThreadNotResident(error, task.threadId), reactivate: async () => undefined }))
    .rejects.toBeInstanceOf(TurnAcceptanceUnknownError)
  expect(ambiguous.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)

  const legacy = client(() => { throw notResident() })
  await expect(startTurnWithReceipt(legacy, { threadId: task.threadId }, async () => legacy)).rejects.toThrow('not resident')
  expect(legacy.request).toHaveBeenCalledOnce()
})

it('shares one re-activation per connection and refuses a replaced task binding', async () => {
  let release!: () => void
  const resumed = new Promise<void>(done => { release = done })
  const target = client(async method => {
    if (method !== 'thread/resume') throw new Error(`unexpected ${method}`)
    await resumed
    return { thread: { id: task.threadId } }
  })
  const runtime = host(target)
  observeThreadEvicted({ threadId: task.threadId, reason: 'capacity' }, target)
  expect(isThreadEvicted(target, task.threadId)).toBe(true)
  const first = reactivateEvictedThread(runtime, task, target)
  const second = reactivateEvictedThread(runtime, task, target)
  release()
  await Promise.all([first, second])
  expect(target.request).toHaveBeenCalledOnce()
  expect(isThreadEvicted(target, task.threadId)).toBe(false)

  const replaced = client(() => ({ thread: { id: task.threadId } }))
  observeThreadEvicted({ threadId: task.threadId, reason: 'capacity' }, replaced)
  await expect(reactivateEvictedThread(host(target), task, replaced)).rejects.toThrow('ownership changed')
  expect(isThreadEvicted(replaced, task.threadId)).toBe(true)
})

it('resends only once even if the thread is evicted again before the resend', async () => {
  const target = client(method => {
    if (method === 'thread/resume') return { thread: { id: task.threadId } }
    throw notResident()
  })
  const runtime = host(target)
  await expect(requestResidentTaskRpc(runtime, task, target, 'tools/catalog', {})).rejects.toThrow('not resident')
  expect(target.request.mock.calls.map(([method]) => method)).toEqual([
    'tools/catalog', 'thread/resume', 'tools/catalog',
  ])
  expect(isThreadEvicted(target, task.threadId)).toBe(true)
})

it('shares the completed restore with a late refusal and invalidates a resumed account before resending', async () => {
  let rejectLate!: (error: unknown) => void
  const late = new Promise((_resolve, reject) => { rejectLate = reject })
  let restored = false
  const target = client((method, params) => {
    if (method === 'thread/resume') {
      restored = true
      return { thread: { id: task.threadId } }
    }
    if (restored) return 'restored'
    if (params?.source === 'late') return late
    throw notResident()
  })
  const runtime = host(target)
  const slow = requestResidentTaskRpc(runtime, task, target, 'tools/catalog', { source: 'late' })
  await expect(requestResidentTaskRpc(runtime, task, target, 'tools/catalog', {})).resolves.toBe('restored')
  rejectLate(notResident())
  await expect(slow).resolves.toBe('restored')
  expect(target.request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1)

  const accountChanged = client(method => {
    if (method !== 'thread/resume') throw notResident()
    notifyAccountContextChange(task.serverId)
    return { thread: { id: task.threadId } }
  })
  await expect(requestResidentTaskRpc(host(accountChanged), task, accountChanged, 'tools/catalog', {}))
    .rejects.toThrow('ownership changed')
  expect(accountChanged.request.mock.calls.map(([method]) => method)).toEqual(['tools/catalog', 'thread/resume'])
})

it('shares a failed restore among the requests that were already in flight', async () => {
  let rejectLate!: (error: unknown) => void
  const late = new Promise((_resolve, reject) => { rejectLate = reject })
  const busy = new Error('restore busy')
  const target = client((method, params) => {
    if (method === 'thread/resume') throw busy
    if (params?.source === 'late') return late
    throw notResident()
  })
  const runtime = host(target)
  const slow = requestResidentTaskRpc(runtime, task, target, 'tools/catalog', { source: 'late' })
  await expect(requestResidentTaskRpc(runtime, task, target, 'tools/catalog', {})).rejects.toBe(busy)
  rejectLate(notResident())
  await expect(slow).rejects.toBe(busy)
  expect(target.request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1)

  await expect(requestResidentTaskRpc(runtime, task, target, 'tools/catalog', {})).rejects.toBe(busy)
  expect(target.request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(2)
})
