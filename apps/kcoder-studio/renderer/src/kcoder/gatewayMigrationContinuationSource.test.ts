import { describe, expect, it, vi } from 'vitest'
import { continuationSourceClient } from './gatewayMigrationContinuationSource'
import { requestNativeMigration } from './gatewayMigration'
import { notifyAccountContextChange } from './accountContextEvents'
import { GatewayRpcError } from './gatewayRpc'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const method = 'migration/history/continuation/source'

function fixture() {
  const target = { id: 'source-target', runtime: 'kcoder' as const, label: 'Source target',
    description: '', transport: 'ssh' as const, host: 'source.test', workspacePath: '/default' }
  const task = { taskId: 'task-A', threadId: 'thread-A', serverId: target.id, workspacePath: '/workspace-A' }
  const owned = { supportsExperimental: vi.fn<(capability: string) => boolean>(() => true), request: vi.fn(async () => ({ source: null })) }
  const command = { supportsExperimental: vi.fn<(capability: string) => boolean>(() => true), request: vi.fn(async () => {
    throw new GatewayRpcError('thread is already active in another Gateway client', -32023)
  }) }
  const key = (server: string, thread: string) => `${server}\0${thread}`
  const host = {
    disposed: false, threadKey: key,
    taskByThread: new Map([[key(target.id, task.threadId), task.taskId]]),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, owned]]),
    resumeClientByTask: new Map<string, Promise<unknown>>(), disconnectRecoveryByTask: new Map<string, Promise<void>>(),
    readyTaskClient: vi.fn(async () => owned), commandClient: vi.fn(async () => command),
    serverForParams: vi.fn(async () => target),
  }
  const params = { deviceId: target.id, workspacePath: task.workspacePath, method, params: { threadId: task.threadId } }
  const options = { signal: new AbortController().signal }
  const core = host as unknown as GatewayRuntimeCore
  return { task, target, owned, command, host, core, params, options,
    call: (changes: Record<string, unknown> = {}) => requestNativeMigration.call(core, { ...params, ...changes }, options) }
}

describe('continuation source observes the actual Native task owner', () => {
  it('routes a fresh ordinary task through its owner and preserves Native source:null', async () => {
    const { call, owned, command, host, options } = fixture()
    expect(await call()).toEqual({ source: null })
    expect(host.readyTaskClient).toHaveBeenCalledOnce()
    expect(owned.request).toHaveBeenCalledExactlyOnceWith(method, { threadId: 'thread-A' }, options)
    expect(command.request).not.toHaveBeenCalled()
    expect(host.commandClient).not.toHaveBeenCalled()
  })

  it('waits for existing recovery before using the replacement owning channel', async () => {
    const { call, host, task, owned, command } = fixture()
    let finish!: () => void
    const recovery = new Promise<void>(resolve => { finish = resolve })
    host.disconnectRecoveryByTask.set(task.taskId, recovery)
    host.readyTaskClient.mockImplementation(async () => { await recovery; return owned })
    const pending = call()
    await vi.waitFor(() => expect(host.readyTaskClient).toHaveBeenCalledWith(task))
    expect(owned.request).not.toHaveBeenCalled()
    host.disconnectRecoveryByTask.delete(task.taskId)
    finish()
    expect(await pending).toEqual({ source: null })
    expect(command.request).not.toHaveBeenCalled()
  })

  it('rejects wrong known workspace/thread facts and malformed Native input before any request', async () => {
    const { call, host, task, owned, command } = fixture()
    await expect(call({ workspacePath: '/workspace-B' })).rejects.toThrow('workspace_changed')
    await expect(call({ params: { threadId: '' } })).rejects.toThrow('migration_invalid_parameters')
    await expect(call({ params: { threadId: 'thread-A', peer: true } })).rejects.toThrow('migration_invalid_parameters')
    task.threadId = 'thread-B'
    await expect(call()).rejects.toThrow('scope_changed')
    expect(host.readyTaskClient).not.toHaveBeenCalled()
    expect(owned.request).not.toHaveBeenCalled()
    expect(command.request).not.toHaveBeenCalled()
  })

  it('rejects account, workspace or client changes after readiness without a fallback', async () => {
    for (const change of ['account', 'workspace', 'client']) {
      const { call, host, task, owned, command, target } = fixture()
      host.readyTaskClient.mockImplementation(async () => {
        if (change === 'account') notifyAccountContextChange(target.id)
        else if (change === 'workspace') task.workspacePath = '/workspace-B'
        else host.clientByTask.set(task.taskId, { ...owned })
        return owned
      })
      await expect(call()).rejects.toThrow(/scope_changed|workspace_changed/)
      expect(owned.request).not.toHaveBeenCalled()
      expect(command.request).not.toHaveBeenCalled()
    }
  })

  it('rejects a replaced client after the reply and propagates real Native owner denial once', async () => {
    const { call, owned, host, task, command } = fixture()
    owned.request.mockImplementationOnce(async () => {
      host.clientByTask.set(task.taskId, { ...owned })
      return { source: null }
    })
    await expect(call()).rejects.toThrow('scope_changed')
    host.clientByTask.set(task.taskId, owned)
    const denial = new GatewayRpcError('Native owner denied', -32023)
    owned.request.mockRejectedValueOnce(denial)
    await expect(call()).rejects.toBe(denial)
    expect(owned.request).toHaveBeenCalledTimes(2)
    expect(command.request).not.toHaveBeenCalled()
    expect(host.commandClient).not.toHaveBeenCalled()
  })

  it('keeps source capability negotiation independent and sends no unsupported RPC', async () => {
    const { call, owned, host } = fixture()
    owned.supportsExperimental.mockImplementation(capability => capability !== 'migrationContinuationSourceV1')
    await expect(call()).rejects.toThrow('migration_continuation_source_update_required')
    expect(owned.request).not.toHaveBeenCalled()
    expect(host.commandClient).not.toHaveBeenCalled()
  })

  it('observes cold history in the selected known workspace without resuming a task', async () => {
    const { host, core, target, params, options, command, task, owned } = fixture()
    host.clientByTask.clear()
    const routing = await continuationSourceClient(core, target, { ...params, workspacePath: undefined }, options)
    expect(routing.client).toBe(command)
    expect(host.commandClient).toHaveBeenCalledExactlyOnceWith(target, task.workspacePath)
    expect(host.readyTaskClient).not.toHaveBeenCalled()
    routing.assertCurrent()
    host.clientByTask.set(task.taskId, { ...owned })
    expect(routing.assertCurrent).toThrow('scope_changed')
  })

  it('preserves explicit cold imported-history observation and its real nullable result', async () => {
    const { host, call, target, command } = fixture()
    host.tasks.clear()
    host.taskByThread.clear()
    command.request.mockResolvedValueOnce({ source: null } as never)
    expect(await call({ workspacePath: '/historical-workspace' })).toEqual({ source: null })
    expect(host.commandClient).toHaveBeenCalledExactlyOnceWith(target, '/historical-workspace')
    expect(host.readyTaskClient).not.toHaveBeenCalled()
    expect(command.request).toHaveBeenCalledOnce()
  })

  it('reconciles an owner that becomes resident before command connection completes', async () => {
    const { host, call, task, owned, command } = fixture()
    host.clientByTask.clear()
    host.commandClient.mockImplementation(async () => {
      host.clientByTask.set(task.taskId, owned)
      return command
    })
    expect(await call()).toEqual({ source: null })
    expect(host.readyTaskClient).toHaveBeenCalledWith(task)
    expect(command.request).not.toHaveBeenCalled()
    expect(owned.request).toHaveBeenCalledOnce()
  })

  it('does not send after caller cancellation or reject a harmless task projection update', async () => {
    const first = fixture()
    const controller = new AbortController()
    first.host.readyTaskClient.mockImplementation(async () => { controller.abort(); return first.owned })
    await expect(continuationSourceClient(first.core, first.target, first.params, { signal: controller.signal })).rejects.toThrow()
    expect(first.owned.request).not.toHaveBeenCalled()
    const next = fixture()
    next.host.readyTaskClient.mockImplementation(async () => {
      next.host.tasks.set(next.task.taskId, { ...next.task })
      return next.owned
    })
    expect(await next.call()).toEqual({ source: null })
  })
})
