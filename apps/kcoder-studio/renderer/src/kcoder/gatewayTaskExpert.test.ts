import { expect, it, vi } from 'vitest'
import { requestTaskExpert } from './gatewayTaskExpert'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

function fixture(supported = true) {
  const task = { taskId: 'task-b', threadId: 'thread-b', serverId: 'target', workspacePath: '/owned' }
  const client = { supportsExperimental: vi.fn(() => supported), request: vi.fn(async () => ({ threadId: task.threadId, revision: 2, expert: null, turns: [] })) }
  const server = { id: task.serverId }
  const first = { request: vi.fn() }
  const host = { disposed: false, tasks: new Map([[task.taskId, task]]), clientByTask: new Map([['task-a', first], [task.taskId, client]]),
    taskConnection: vi.fn(async () => ({ taskId: task.taskId, task, client, server })) }
  const call = (extra: Record<string, unknown> = {}) => requestTaskExpert.call(host as unknown as GatewayRuntimeCore,
    { taskId: task.taskId, threadId: task.threadId, deviceId: task.serverId, ...extra })
  return { task, client, first, host, call }
}

it('changes only the explicitly selected original task and preserves null plus its CAS revision', async () => {
  const f = fixture()
  await f.call({ change: { expectedRevision: 1, expert: null }, input: 'must not execute' })
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('thread/expert', {
    threadId: 'thread-b', change: { expectedRevision: 1, expert: null },
  }, undefined)
  expect(f.first.request).not.toHaveBeenCalled()
})

it('does not infer support or silently apply incomplete configuration', async () => {
  const old = fixture(false)
  await expect(old.call()).rejects.toThrow('UNSUPPORTED')
  expect(old.client.request).not.toHaveBeenCalled()
  const f = fixture()
  await expect(f.call({ change: { expectedRevision: 0 } })).rejects.toThrow('INVALID')
  expect(f.client.request).not.toHaveBeenCalled()
})

it('rejects wrong original task/target and a reply from a replaced connection without replay', async () => {
  const f = fixture()
  await expect(f.call({ threadId: 'thread-a' })).rejects.toThrow('CHANGED')
  await expect(f.call({ deviceId: 'another' })).rejects.toThrow('CHANGED')
  expect(f.client.request).not.toHaveBeenCalled()
  f.client.request.mockImplementation(async () => {
    f.host.clientByTask.set(f.task.taskId, { ...f.client })
    return { threadId: f.task.threadId, revision: 2, expert: null, turns: [] }
  })
  await expect(f.call({ change: { expectedRevision: 1, expert: null } })).rejects.toThrow('CHANGED')
  expect(f.client.request).toHaveBeenCalledTimes(1)
})
