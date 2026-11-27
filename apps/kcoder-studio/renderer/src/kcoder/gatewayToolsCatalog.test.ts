import { describe, expect, it, vi } from 'vitest'
import { requestToolsCatalog } from './gatewayToolsCatalog'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { GatewayRpcError } from './gatewayRpc'
import { notifyAccountContextChange } from './accountContextEvents'

function fixture() {
  const task = {
    taskId: 'task-A',
    threadId: 'thread-A',
    serverId: 'target-A',
    workspacePath: '/workspace-A',
    studioWorkMode: 'kcoder',
  }
  const stale = {
    supportsExperimental: () => true,
    request: vi.fn(async () => {
      throw new GatewayRpcError('wrong owner', -32023)
    }),
  }
  const owned = {
    supportsExperimental: () => true,
    request: vi.fn(async () => ({ tools: [{ name: 'owned-tool' }] })),
  }
  const host = {
    disposed: false,
    resolveTaskId: (id: string | null) => id,
    configurationEpochByTarget: new Map(),
    appServerDisconnectedClients: new Set(),
    taskDescriptor: vi.fn(async () => ({
      task,
      taskId: task.taskId,
      server: { id: task.serverId },
    })),
    tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, owned as typeof owned | typeof stale]]),
    resumeClientByTask: new Map(),
    disconnectRecoveryByTask: new Map(),
    readyTaskClient: vi.fn(async () => owned),
    commandClient: vi.fn(),
    withTransientClient: vi.fn(),
    serverForParams: vi.fn(async () => ({ id: 'target-A', workspacePath: '/workspace-A' })),
  }
  return {
    host,
    task,
    stale,
    owned,
    call: (params: Record<string, unknown> = {}) =>
      requestToolsCatalog.call(host as unknown as GatewayRuntimeCore, {
        taskId: 'task-A',
        serverId: 'target-A',
        ...params,
      }),
  }
}
describe('tools catalog waits for completed ownership of the original task', () => {
  it('waits for the original task recovery and never sends its thread through a stale or command client', async () => {
    const { host, task, stale, owned, call } = fixture()
    let finish!: () => void
    const recovery = new Promise<void>(resolve => {
      finish = resolve
    })
    host.clientByTask.set(task.taskId, stale)
    host.disconnectRecoveryByTask.set(task.taskId, recovery)
    host.readyTaskClient.mockImplementation(async () => {
      await recovery
      return owned
    })
    const pending = call()
    await vi.waitFor(() => expect(host.readyTaskClient).toHaveBeenCalledWith(task))
    expect(stale.request).not.toHaveBeenCalled()
    expect(owned.request).not.toHaveBeenCalled()
    host.clientByTask.set(task.taskId, owned)
    host.disconnectRecoveryByTask.delete(task.taskId)
    finish()
    expect(await pending).toEqual({ tools: [{ name: 'owned-tool' }] })
    expect(owned.request).toHaveBeenCalledWith('tools/catalog', {
      threadId: 'thread-A',
      clientPresentation: { version: 1, studioWorkMode: 'kcoder', inlineWidgets: true },
    })
    expect(host.commandClient).not.toHaveBeenCalled()
    expect(host.withTransientClient).not.toHaveBeenCalled()
  })
  it('rejects target/thread/workspace ambiguity without falling back to another session', async () => {
    const { owned, host, call } = fixture()
    for (const scope of [
      { serverId: 'peer' },
      { threadId: 'thread-B' },
      { workspacePath: '/workspace-B' },
      { address: { taskId: 'task-B' } },
    ])
      await expect(call(scope)).rejects.toThrow()
    expect(owned.request).not.toHaveBeenCalled()
    expect(host.readyTaskClient).not.toHaveBeenCalled()
  })
  it('rejects a mutated task or late replacement connection instead of accepting peer output', async () => {
    const { task, host, owned, call } = fixture()
    host.readyTaskClient.mockImplementation(async () => {
      task.threadId = 'thread-B'
      return owned
    })
    await expect(call()).rejects.toThrow('ownership changed')
    expect(owned.request).not.toHaveBeenCalled()
    task.threadId = 'thread-A'
    host.readyTaskClient.mockResolvedValue(owned)
    owned.request.mockImplementation(async () => {
      host.clientByTask.set(task.taskId, { ...owned })
      return { tools: [] }
    })
    await expect(call()).rejects.toThrow('ownership changed')
    expect(owned.request).toHaveBeenCalledTimes(1)
  })
  it('preserves Native owner denial and account invalidation as failures without retry', async () => {
    const { host, owned, call } = fixture()
    const denied = new GatewayRpcError('Native owner denied', -32023)
    owned.request.mockRejectedValueOnce(denied)
    await expect(call()).rejects.toBe(denied)
    expect(owned.request).toHaveBeenCalledTimes(1)
    owned.request.mockImplementation(async () => {
      notifyAccountContextChange('target-A')
      return { tools: [] }
    })
    await expect(call()).rejects.toThrow('ownership changed')
    expect(host.commandClient).not.toHaveBeenCalled()
  })
  it('requires a task for a resident thread and keeps cold historical sessions inactive', async () => {
    const { host, task, call } = fixture()
    await expect(call({ taskId: undefined, threadId: 'thread-A' })).rejects.toThrow(
      'task identity is required'
    )
    expect(host.withTransientClient).not.toHaveBeenCalled()
    host.clientByTask.delete(task.taskId)
    await expect(call()).rejects.toThrow('not resident')
    expect(host.readyTaskClient).not.toHaveBeenCalled()
  })
})


it.each(['resident', 'transient'] as const)('%s catalog checks the original configuration before acquiring the connection', async mode => {
  const { host, owned, call } = fixture()
  host.readyTaskClient.mockImplementation(async () => {
    host.configurationEpochByTarget.set('target-A', {})
    return owned
  })
  host.withTransientClient.mockImplementation(async (_target: unknown, read: (client: typeof owned) => Promise<unknown>) => {
    host.configurationEpochByTarget.set('target-A', {})
    return read(owned)
  })
  await expect(call(mode === 'transient' ? { taskId: undefined } : {})).rejects.toThrow('ownership changed')
  expect(owned.request).not.toHaveBeenCalled()
})

it.each((['resident', 'transient'] as const).flatMap(mode =>
  (['configuration', 'socket', 'dispose', 'disconnect'] as const).flatMap(boundary =>
    [false, true].map(rejected => [mode, boundary, rejected] as const))
))('%s catalog rejects late results after %s changes (rejected=%s)', async (mode, boundary, rejected) => {
  const { host, owned, call } = fixture()
  const connection = { connectionId: 'original-socket' }
  Object.assign(owned, { diagnosticConnection: connection })
  host.withTransientClient.mockImplementation(async (_target: unknown, read: (client: typeof owned) => Promise<unknown>) => read(owned))
  owned.request.mockImplementation(async () => {
    if (boundary === 'configuration') host.configurationEpochByTarget.set('target-A', {})
    else if (boundary === 'socket') connection.connectionId = 'replacement-socket'
    else if (boundary === 'dispose') host.disposed = true
    else host.appServerDisconnectedClients.add(owned)
    if (rejected) throw new GatewayRpcError('Retired Native owner denied', -32023)
    return { tools: [] }
  })
  await expect(call(mode === 'transient' ? { taskId: undefined } : {})).rejects.toThrow('ownership changed')
  expect(owned.request).toHaveBeenCalledTimes(1)
})

it.each([
  { address: { deviceId: 'peer-target' } },
  { address: { threadId: 'peer-thread' } },
  { address: { workspacePath: '/peer-workspace' } },
  { threadId: 'thread-A', address: { threadId: 'peer-thread' } },
  { workspacePath: '/workspace-A', address: { workspacePath: '/peer-workspace' } },
])('catalog address selectors narrow the same original owner: %j', async params => {
  const { host, owned, call } = fixture()
  await expect(call(params)).rejects.toThrow()
  expect(owned.request).not.toHaveBeenCalled()
  expect(host.readyTaskClient).not.toHaveBeenCalled()
})

it('forwards the original Native session address expectation into task lookup', async () => {
  const { host, call } = fixture()
  const address = { deviceId: 'target-A', taskId: 'task-A', threadId: 'thread-A',
    workspacePath: '/workspace-A', expectedSessionAddress: {
      targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'thread-A',
    } }
  await call({ address })
  expect(host.taskDescriptor).toHaveBeenCalledWith(expect.objectContaining({ address }))
})


it.each(['resident', 'transient'] as const)('%s catalog keeps fresh Native reads and denial results independent', async mode => {
  const { host, owned, call } = fixture()
  host.withTransientClient.mockImplementation(async (_target: unknown, read: (client: typeof owned) => Promise<unknown>) => read(owned))
  const params = mode === 'transient' ? { taskId: undefined } : {}
  for (let i = 0; i < 40; i++) {
    const result = { tools: [{ name: `current-tool-${i}` }] }
    owned.request.mockResolvedValueOnce(result)
    expect(await call(params)).toBe(result)
  }
  expect(owned.request).toHaveBeenCalledTimes(40)
  expect(owned.request).toHaveBeenLastCalledWith('tools/catalog', expect.objectContaining(
    mode === 'resident' ? { threadId: 'thread-A' } : { clientPresentation: expect.any(Object) }
  ))
  const denied = new GatewayRpcError('Native owner denied', -32023)
  owned.request.mockRejectedValueOnce(denied)
  await expect(call(params)).rejects.toBe(denied)
  expect(owned.request).toHaveBeenCalledTimes(41)
})


it.each(['resident', 'transient', 'implicit-resident'] as const)('%s catalog retires a configuration changed during target lookup before acquiring another client', async mode => {
  const { host, task, owned, call } = fixture()
  host.taskDescriptor.mockImplementation(async () => {
    host.configurationEpochByTarget.set('target-A', {})
    return { task, taskId: task.taskId, server: { id: task.serverId } }
  })
  host.serverForParams.mockImplementation(async () => {
    host.configurationEpochByTarget.set('target-A', {})
    return { id: 'target-A', workspacePath: '/workspace-A' }
  })
  host.withTransientClient.mockImplementation(async (_target: unknown, read: (client: typeof owned) => Promise<unknown>) => read(owned))
  await expect(call(mode === 'transient' ? { taskId: undefined }
    : mode === 'implicit-resident' ? { serverId: undefined } : {})).rejects.toThrow('ownership changed')
  expect(host.readyTaskClient).not.toHaveBeenCalled()
  expect(host.withTransientClient).not.toHaveBeenCalled()
  expect(owned.request).not.toHaveBeenCalled()
})


it('a replaced task alias retires its pending catalog without touching the replacement', async () => {
  const { host, owned, call } = fixture()
  owned.request.mockImplementation(async () => {
    host.resolveTaskId = () => 'replacement-task'
    return { tools: [] }
  })
  await expect(call()).rejects.toThrow('ownership changed')
  expect(owned.request).toHaveBeenCalledTimes(1)
  expect(host.readyTaskClient).toHaveBeenCalledTimes(1)
})
