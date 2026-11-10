import { describe, expect, it, test, vi } from 'vitest'
import { releaseUnviewedTaskClient, sessionLifetime, taskView } from './sessionLifetime'
import type { GatewayRuntimeCore } from './core'

function fixture() {
  const client = { request: vi.fn().mockResolvedValue({ changed: true }),
    supportsExperimental: () => true, close: vi.fn() }
  const task = { taskId: 'kcoder:target:task', threadId: 'task' }
  const runtime = { taskViewGenerations: new Map(), tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client]]), resolveTaskId: (id: string) => id,
    taskConnection: vi.fn().mockResolvedValue({ client, task }) }
  return { runtime: runtime as unknown as GatewayRuntimeCore, client, task }
}

describe('session attachment generations', () => {
  it('keeps a background task connected until its terminal result has been delivered', async () => {
    const f = fixture()
    const runtime = f.runtime as GatewayRuntimeCore
    const task = f.task
    runtime.tasks.set(task.taskId, { ...runtime.tasks.get(task.taskId)!, running: true })
    Object.assign(runtime, {
      activeTurnByTask: new Map([[task.taskId, { turnId: 'turn-1' }]]),
      pendingTurnStartByTask: new Set(),
      backgroundJobById: new Map(),
    })
    await taskView(runtime, 'runtime.tasks.view.attach', { taskId: task.taskId, viewId: 'pane' })
    await taskView(runtime, 'runtime.tasks.view.release', { taskId: task.taskId, viewId: 'pane' })
    expect(f.client.close).not.toHaveBeenCalled()
    expect(runtime.clientByTask.get(task.taskId)).toBe(f.client)
    runtime.tasks.set(task.taskId, { ...runtime.tasks.get(task.taskId)!, running: false })
    runtime.activeTurnByTask.delete(task.taskId)
    releaseUnviewedTaskClient(runtime, task.taskId, f.client as never)
    expect(f.client.close).toHaveBeenCalledOnce()
    expect(runtime.clientByTask.has(task.taskId)).toBe(false)
  })

  it('closing one pane does not detach the same task still open in another pane', async () => {
    const f = fixture()
    await taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'old' })
    await taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'new' })
    f.client.request.mockClear()
    expect(await taskView(f.runtime, 'runtime.tasks.view.release', {
      taskId: f.task.taskId, viewId: 'old',
    })).toEqual({ released: true, detached: false })
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.client.close).not.toHaveBeenCalled()
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'new' })
    expect(f.client.request).toHaveBeenCalledWith('gateway/thread/detach', { threadId: 'task', viewId: expect.any(String) })
    expect(f.client.close).toHaveBeenCalledOnce()
    expect(f.runtime.tasks.has(f.task.taskId)).toBe(true)
  })

  it('a view closed during restoration cannot leave a ghost attachment', async () => {
    const f = fixture()
    let restored!: () => void
    const waiting = new Promise<void>(resolve => { restored = resolve })
    f.runtime.taskConnection = vi.fn(async () => {
      await waiting
      f.runtime.clientByTask.set(f.task.taskId, f.client as never)
      return { taskId: f.task.taskId, task: f.task, client: f.client } as never
    })
    f.runtime.clientByTask.clear()
    const opening = taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'old' })
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'old' })
    restored(); await opening
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.client.close).toHaveBeenCalledOnce()
  })

  it('an alias resolved during attachment shares the canonical pane generation', async () => {
    const f = fixture()
    const alias = 'original-index-alias'
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const originalConnection = f.runtime.taskConnection
    const originalResolver = f.runtime.resolveTaskId
    f.runtime.taskConnection = vi.fn(async params => {
      if (params.taskId === alias) {
        await waiting
        f.runtime.resolveTaskId = id => id === alias ? f.task.taskId : originalResolver(id)
      }
      return originalConnection(params)
    })
    const opening = taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: alias, viewId: 'alias' })
    await taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'canonical' })
    release()
    expect(await opening).toEqual({ attached: true })
    const [first, second] = f.client.request.mock.calls
    expect(first).toEqual(second)
    f.client.request.mockClear()
    expect(await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: alias, viewId: 'alias' }))
      .toEqual({ released: true, detached: false })
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.client.close).not.toHaveBeenCalled()
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'canonical' })
    expect(f.client.request).toHaveBeenCalledWith('gateway/thread/detach', first[1])
    expect(f.client.close).toHaveBeenCalledOnce()
  })

  it('preference writes carry the exact original revision and do not grant authorization', async () => {
    const f = fixture()
    await sessionLifetime(f.runtime, 'runtime.tasks.lifetime.set', {
      taskId: f.task.taskId, expectedRevision: 7, mode: 'background',
    })
    expect(f.client.request).toHaveBeenCalledWith('thread/lifetime/set', {
      threadId: 'task', expectedRevision: 7, mode: 'background',
    })
    expect(f.runtime.taskViewGenerations.size).toBe(0)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('an unresolved pane alias keeps the same task attached when its canonical pane closes', async () => {
  const task = { taskId: 'kcoder:local:one', threadId: 'one' }
  const client = { request: vi.fn().mockResolvedValue({ changed: true }),
    close: vi.fn(), supportsExperimental: () => true }
  const pendingAlias = deferred<{ task: typeof task; client: typeof client }>()
  let resolved = false
  const runtime = {
    taskViewGenerations: new Map(), tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client]]),
    resolveTaskId: (id: string) => id === 'index-alias' ? resolved ? task.taskId : null : id,
    taskConnection: vi.fn().mockImplementationOnce(() => pendingAlias.promise)
      .mockResolvedValue({ task, client }),
  } as unknown as GatewayRuntimeCore
  const aliasAttachment = taskView(runtime, 'runtime.tasks.view.attach', {
    taskId: 'index-alias', viewId: 'alias-pane',
  })
  resolved = true
  await taskView(runtime, 'runtime.tasks.view.attach', { taskId: task.taskId, viewId: 'canonical-pane' })
  client.request.mockClear()
  await taskView(runtime, 'runtime.tasks.view.release', { taskId: task.taskId, viewId: 'canonical-pane' })
  expect(client.close).not.toHaveBeenCalled()
  expect(client.request).not.toHaveBeenCalledWith('gateway/thread/detach', expect.anything())
  pendingAlias.resolve({ task, client })
  await expect(aliasAttachment).resolves.toEqual({ attached: true })
  expect(client.close).not.toHaveBeenCalled()
  await taskView(runtime, 'runtime.tasks.view.release', { taskId: 'index-alias', viewId: 'alias-pane' })
  expect(client.close).toHaveBeenCalledTimes(1)
})

test('a late detach receipt cannot close the conversation reopened while it was pending', async () => {
  const task = { taskId: 'kcoder:local:one', threadId: 'one' }
  const detached = deferred<{ changed: boolean }>()
  const client = { close: vi.fn(), supportsExperimental: () => true,
    request: vi.fn((method: string) => method.endsWith('/detach') ? detached.promise : Promise.resolve({ changed: true })) }
  const runtime = {
    taskViewGenerations: new Map(), tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client]]), resolveTaskId: (id: string) => id,
    taskConnection: async () => ({ task, client }),
  } as unknown as GatewayRuntimeCore
  await taskView(runtime, 'runtime.tasks.view.attach', { taskId: task.taskId, viewId: 'old-pane' })
  const releasing = taskView(runtime, 'runtime.tasks.view.release', { taskId: task.taskId, viewId: 'old-pane' })
  await taskView(runtime, 'runtime.tasks.view.attach', { taskId: task.taskId, viewId: 'reopened-pane' })
  detached.resolve({ changed: true })
  await releasing
  expect(client.close).not.toHaveBeenCalled()
  await taskView(runtime, 'runtime.tasks.view.release', { taskId: task.taskId, viewId: 'reopened-pane' })
  expect(client.close).toHaveBeenCalledTimes(1)
})

test('releasing the last view closes its own connection and preserves a peer task', async () => {
  const task = { taskId: 'kcoder:local:one', threadId: 'one' }
  const client = { close: vi.fn(), request: vi.fn().mockResolvedValue({ changed: true }), supportsExperimental: () => true }
  const peer = { ...client, close: vi.fn() }
  const runtime = {
    taskViewGenerations: new Map(), tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client], ['kcoder:local:two', peer]]),
    resolveTaskId: (id: string) => id, taskConnection: async () => ({ task, client }),
  } as unknown as GatewayRuntimeCore
  await taskView(runtime, 'runtime.tasks.view.attach', { taskId: task.taskId, viewId: 'last-pane' })
  await taskView(runtime, 'runtime.tasks.view.release', { taskId: task.taskId, viewId: 'last-pane' })
  expect(client.request).toHaveBeenLastCalledWith('gateway/thread/detach', {
    threadId: 'one', viewId: expect.any(String),
  })
  expect(client.close).toHaveBeenCalledTimes(1)
  expect(peer.close).not.toHaveBeenCalled()
})
