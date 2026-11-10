import { describe, expect, it, vi } from 'vitest'
import { requestTaskDelivery } from './gatewayTaskDelivery'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

function fixture(supported = true) {
  const task = { taskId: 'task-a', threadId: 'thread-a', serverId: 'target-a', workspacePath: '/owned/a' }
  const client = { supportsExperimental: vi.fn(() => supported), request: vi.fn(async () => ({ threadId: task.threadId })) }
  const server = { id: task.serverId }
  const host = { disposed: false, tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    taskConnection: vi.fn(async () => ({ taskId: task.taskId, task, client, server })) }
  return { host, client, call: (params: Record<string, unknown>) => requestTaskDelivery.call(host as unknown as GatewayRuntimeCore, {
    taskId: task.taskId, threadId: task.threadId, deviceId: server.id, ...params,
  }) }
}

describe('task delivery runtime ownership', () => {
  it('uses the original task connection and forwards only explicit typed fields', async () => {
    const { host, client, call } = fixture()
    await call({ method: 'task/delivery/prepare', baseBranch: 'main', comparisonId: 'comparison-1', path: '/forged', headCommit: 'forged', owner: { taskId: 'forged-task', deviceId: 'forged-target', threadId: 'forged-thread' } })
    expect(host.taskConnection).toHaveBeenCalledTimes(1)
    expect(client.request).toHaveBeenCalledWith('task/delivery/prepare', {
      threadId: 'thread-a', owner: { taskId: 'task-a', threadId: 'thread-a', deviceId: 'target-a' }, baseBranch: 'main', comparisonId: 'comparison-1',
    }, undefined)
    expect(client.supportsExperimental).toHaveBeenCalledWith('taskDeliveryV1')
  })

  it('reports old-target capability without assuming another successful command proves support', async () => {
    const { client, call } = fixture(false)
    expect(await call({ method: 'capabilities' })).toEqual({ supported: false })
    await expect(call({ method: 'task/delivery/read', deliveryId: 'id' })).rejects.toThrow()
    expect(client.request).not.toHaveBeenCalled()
  })

  it('rejects a mismatched target or thread before sending any native request', async () => {
    const { client, call } = fixture()
    await expect(call({ method: 'task/delivery/read', deliveryId: 'id', threadId: 'thread-other' })).rejects.toThrow()
    await expect(call({ method: 'task/delivery/read', deliveryId: 'id', deviceId: 'target-other' })).rejects.toThrow()
    expect(client.request).not.toHaveBeenCalled()
  })

  it('rejects a late reply from a replaced connection without replaying a prepared intent', async () => {
    const { host, client, call } = fixture()
    client.request.mockImplementation(async () => {
      host.clientByTask.set('task-a', { ...client })
      return { threadId: 'thread-a' }
    })
    await expect(call({ method: 'task/delivery/request', deliveryId: 'id', requestId: 'stable-id', title: 'title', body: 'body' })).rejects.toThrow()
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  it('rejects a native response owned by a different viewing thread', async () => {
    const { client, call } = fixture()
    client.request.mockResolvedValue({ threadId: 'thread-other' })
    await expect(call({ method: 'task/delivery/failure', deliveryId: 'id', checkId: 'check:3' })).rejects.toThrow()
    expect(client.request).toHaveBeenCalledTimes(1)
  })
})
