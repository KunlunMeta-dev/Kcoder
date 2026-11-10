import { describe, expect, it, vi } from 'vitest'
import { requestTaskComparison, TASK_COMPARISON_CAPABILITIES } from './gatewayTaskComparison'
import { TASK_COMPARISON_METHODS } from '@/features/task-comparison/controller'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

function fixture(supported = true) {
  const task = {
    taskId: 'task-A',
    threadId: 'thread-A',
    serverId: 'target-A',
    workspacePath: '/source',
  }
  const alternative = {
    taskId: 'task-B',
    threadId: 'thread-B',
    serverId: 'target-A',
    workspacePath: '/managed/B',
    title: 'B',
    createdAt: 1,
    updatedAt: 2,
  }
  const client = {
    supportsExperimental: vi.fn(() => supported),
    request: vi.fn(async () => ({}) as Record<string, unknown>),
  }
  const host = {
    disposed: false,
    tasks: new Map([
      [task.taskId, task],
      [alternative.taskId, alternative],
    ]),
    clientByTask: new Map([[task.taskId, client]]),
    resolveTaskId: (id: string) => id,
    taskConnection: vi.fn(async () => ({
      task,
      taskId: task.taskId,
      server: { id: task.serverId },
      client,
    })),
  }
  return {
    host,
    client,
    call: (method: string, params: Record<string, unknown> = {}) =>
      requestTaskComparison.call(host as unknown as GatewayRuntimeCore, method, {
        deviceId: 'target-A',
        comparisonOwnerTaskId: 'task-A',
        ownerThreadId: 'thread-A',
        sourcePath: '/source',
        comparisonId: 'requirement-A',
        ...params,
      }),
  }
}
describe('comparison Gateway preserves managing owner A and actual alternative B', () => {
  it('checks capability on A and forwards typed metadata without gaining B execution ownership', async () => {
    const { host, client, call } = fixture()
    await call(TASK_COMPARISON_METHODS.select, {
      threadId: 'thread-B',
      expectedRevision: 2,
      expectedHeadCommit: 'a'.repeat(40),
      expectedContentToken: 'b'.repeat(64),
    })
    expect(host.taskConnection).toHaveBeenCalledWith({
      taskId: 'task-A',
      threadId: 'thread-A',
      deviceId: 'target-A',
    })
    expect(client.request).toHaveBeenCalledExactlyOnceWith(TASK_COMPARISON_METHODS.select, {
      deviceId: 'target-A',
      ownerThreadId: 'thread-A',
      sourcePath: '/source',
      comparisonId: 'requirement-A',
      threadId: 'thread-B',
      expectedRevision: 2,
      expectedHeadCommit: 'a'.repeat(40),
      expectedContentToken: 'b'.repeat(64),
    })
  })
  it('links an existing real B conversation through A registry and carries its authoritative revision', async () => {
    const { client, call } = fixture()
    client.request.mockImplementation(async method => {
      if (method === 'runtime.worktrees.list')
        return { items: [{ path: '/managed/B', revision: 2, conversations: [] }] }
      if (method === 'runtime.worktrees.conversations.link') return { linked: true, revision: 3 }
      return {}
    })
    await call(TASK_COMPARISON_METHODS.bind, {
      taskId: 'task-B',
      threadId: 'thread-B',
      path: '/managed/B',
      expectedRevision: 2,
      requirement: 'same demand',
      label: 'B',
    })
    expect(client.request.mock.calls.map(call => call[0])).toEqual([
      'runtime.worktrees.list',
      'runtime.worktrees.conversations.link',
      TASK_COMPARISON_METHODS.bind,
    ])
    expect(client.request.mock.calls[1][1]).toMatchObject({
      path: '/managed/B',
      conversation: {
        taskId: 'task-B',
        threadId: 'thread-B',
        deviceId: 'target-A',
        workspacePath: '/managed/B',
      },
    })
    expect(client.request.mock.calls[2][1]).toMatchObject({
      taskId: 'task-B',
      threadId: 'thread-B',
      ownerThreadId: 'thread-A',
      expectedRevision: 3,
    })
  })
  it('refuses foreign B identities and changed A connections without issuing tools or retries', async () => {
    const { host, client, call } = fixture()
    await expect(
      call(TASK_COMPARISON_METHODS.bind, {
        taskId: 'task-B',
        threadId: 'forged',
        path: '/managed/B',
        expectedRevision: 2,
      })
    ).rejects.toThrow()
    expect(client.request).not.toHaveBeenCalled()
    client.request.mockImplementation(async () => {
      host.clientByTask.set('task-A', { ...client })
      return {}
    })
    await expect(call(TASK_COMPARISON_METHODS.read)).rejects.toThrow()
    expect(client.request).toHaveBeenCalledTimes(1)
  })
  it('exposes explicit legacy downgrade without forwarding an unsupported operation', async () => {
    const { client, call } = fixture(false)
    expect(await call(TASK_COMPARISON_CAPABILITIES)).toEqual({ supported: false })
    await expect(call(TASK_COMPARISON_METHODS.read)).rejects.toThrow()
    expect(client.request).not.toHaveBeenCalled()
  })
})
