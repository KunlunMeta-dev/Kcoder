import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '../../accountContextEvents'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'
import { agentRequest, invalidateAgentList, readAgentList } from './agentRequests'
import { steerSubagent } from './turns'

vi.mock('../../gatewayServiceBridge', async original => ({
  ...await original<typeof import('../../gatewayServiceBridge')>(),
  emitRuntimeEvent: vi.fn(async () => undefined),
}))

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const task = { taskId: 'original-task', serverId: 'list-target', threadId: 'original-thread',
    workspacePath: '/workspace' } as GatewayTask
  const lists: ReturnType<typeof deferred<{ threadId: string; agents: [] }>>[] = []
  const mutation = deferred<unknown>()
  const request = vi.fn((method: string) => {
    if (method !== 'agent/list') return mutation.promise
    const list = deferred<{ threadId: string; agents: [] }>()
    lists.push(list)
    return list.promise
  })
  let connectionId = 'first-connection'
  const client = { request, supportsExperimental: () => true,
    get diagnosticConnection() { return { connectionId } } } as unknown as GatewayClient
  const owner = async () => ({ taskId: task.taskId, task, server: { id: task.serverId }, client })
  const runtime = { disposed: false, configurationEpochByTarget: new Map(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    activeTurnByTask: new Map(), appServerDisconnectedClients: new Set(),
    resolveTaskId: (id: string | null) => id, readyTaskClient: async () => client,
    taskDescriptor: owner, taskConnection: owner,
  } as unknown as GatewayRuntimeCore
  const complete = (index: number) => lists[index].resolve({ threadId: task.threadId, agents: [] })
  return { task, client, runtime, lists, request, mutation, complete,
    reconnect() { connectionId = 'replacement-connection' } }
}

test('original-task observers share one pending list, receive independent DTOs and reread after completion', async () => {
  const f = fixture()
  const first = readAgentList(f.runtime, f.task, f.client)
  const second = readAgentList(f.runtime, f.task, f.client)
  await vi.waitFor(() => expect(f.lists).toHaveLength(1))
  f.complete(0)
  const [a, b] = await Promise.all([first, second])
  expect(a).toEqual(b)
  expect(a).not.toBe(b)
  expect(a.agents).not.toBe(b.agents)
  const fresh = readAgentList(f.runtime, f.task, f.client)
  await vi.waitFor(() => expect(f.lists).toHaveLength(2))
  f.complete(1)
  await expect(fresh).resolves.toEqual(b)
})

test('a failed shared list is not retained for the next attempt', async () => {
  const f = fixture()
  const first = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('offline')
  const second = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('offline')
  await vi.waitFor(() => expect(f.lists).toHaveLength(1))
  f.lists[0].reject(new Error('offline'))
  await Promise.all([first, second])
  const fresh = readAgentList(f.runtime, f.task, f.client)
  await vi.waitFor(() => expect(f.lists).toHaveLength(2))
  f.complete(1)
  await fresh
})

test('a list retired before dispatch does not send another Native query', async () => {
  const f = fixture()
  const old = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('changed during read')
  invalidateAgentList(f.runtime, f.task.taskId)
  const current = readAgentList(f.runtime, f.task, f.client)
  await vi.waitFor(() => expect(f.lists.length).toBeGreaterThan(0))
  f.lists.forEach((_, index) => f.complete(index))
  await Promise.all([old, current])
  expect(f.request).toHaveBeenCalledTimes(1)
})

test.each(['account', 'configuration', 'thread', 'workspace', 'connection', 'client'] as const)(
  '%s replacement cannot join or accept an old list', async boundary => {
    const f = fixture()
    const old = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('owner changed')
    await vi.waitFor(() => expect(f.lists).toHaveLength(1))
    let client = f.client
    if (boundary === 'account') notifyAccountContextChange(f.task.serverId)
    if (boundary === 'configuration') f.runtime.configurationEpochByTarget.set(f.task.serverId, {})
    if (boundary === 'thread') f.task.threadId = 'replacement-thread'
    if (boundary === 'workspace') f.task.workspacePath = '/replacement'
    if (boundary === 'connection') f.reconnect()
    if (boundary === 'client') {
      client = { ...f.client } as GatewayClient
      f.runtime.clientByTask.set(f.task.taskId, client)
    }
    const current = readAgentList(f.runtime, f.task, client)
    await vi.waitFor(() => expect(f.lists).toHaveLength(2))
    f.complete(0); f.complete(1)
    await old
    await expect(current).resolves.toMatchObject({ threadId: f.task.threadId })
  }
)

test('another target configuration change does not retire the original task read', async () => {
  const f = fixture()
  const first = readAgentList(f.runtime, f.task, f.client)
  await vi.waitFor(() => expect(f.lists).toHaveLength(1))
  f.runtime.configurationEpochByTarget.set('another-target', {})
  const second = readAgentList(f.runtime, f.task, f.client)
  await Promise.resolve()
  expect(f.lists).toHaveLength(1)
  f.complete(0)
  await Promise.all([first, second])
})

test.each([
  { method: 'agent/messages/archive', failed: false }, { method: 'agent/messages/archive', failed: true },
  { method: 'agent/steer', failed: false }, { method: 'agent/steer', failed: true },
])('$method fences lists before and after its receipt (failed=$failed)', async ({ method, failed }) => {
  const f = fixture()
  const old = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('changed during read')
  await vi.waitFor(() => expect(f.lists).toHaveLength(1))
  const operation = method === 'agent/steer'
    ? steerSubagent.call(f.runtime, { taskId: f.task.taskId, agentId: 'worker', message: 'Adjust', clientMessageId: 'command' })
    : agentRequest.call(f.runtime, { taskId: f.task.taskId, agentId: 'worker',
      expectedEpoch: 1, confirmedMessageIds: [] }, method, 'agentCommandReceiptsV1')
  const settled = failed ? expect(operation).rejects.toThrow('mutation failed') : expect(operation).resolves.toBeDefined()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith(method, expect.anything()))
  const during = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('changed during read')
  await vi.waitFor(() => expect(f.lists).toHaveLength(2))
  if (failed) f.mutation.reject(new Error('mutation failed'))
  else f.mutation.resolve({})
  await settled
  const after = readAgentList(f.runtime, f.task, f.client)
  await vi.waitFor(() => expect(f.lists).toHaveLength(3))
  f.complete(0); f.complete(1); f.complete(2)
  await Promise.all([old, during, after])
})


test.each(['configuration', 'connection', 'disconnect', 'dispose'] as const)(
  'a failed list from a retired %s cannot publish its Native error', async boundary => {
    const f = fixture()
    const pending = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('owner changed')
    await vi.waitFor(() => expect(f.lists).toHaveLength(1))
    if (boundary === 'configuration') f.runtime.configurationEpochByTarget.set(f.task.serverId, {})
    else if (boundary === 'connection') f.reconnect()
    else if (boundary === 'disconnect') f.runtime.appServerDisconnectedClients.add(f.client)
    else f.runtime.disposed = true
    f.lists[0].reject(new Error('retired Native denial'))
    await pending
    expect(f.request).toHaveBeenCalledTimes(1)
  }
)

test('a disconnected original client does not dispatch another list read', async () => {
  const f = fixture()
  f.runtime.appServerDisconnectedClients.add(f.client)
  await expect(readAgentList(f.runtime, f.task, f.client)).rejects.toThrow('owner changed')
  expect(f.request).not.toHaveBeenCalled()
})

test('a current Native denial preserves the original error and does not retry', async () => {
  const f = fixture(), denied = new Error('Native denial')
  const pending = expect(readAgentList(f.runtime, f.task, f.client)).rejects.toBe(denied)
  await vi.waitFor(() => expect(f.lists).toHaveLength(1))
  f.lists[0].reject(denied)
  await pending
  expect(f.request).toHaveBeenCalledTimes(1)
})
