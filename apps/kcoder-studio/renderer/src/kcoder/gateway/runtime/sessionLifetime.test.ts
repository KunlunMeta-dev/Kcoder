import { describe, expect, it, test, vi } from 'vitest'
import { attachTaskViews, releaseUnviewedTaskClient, sessionLifetime, taskView } from './sessionLifetime'
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
  it('reserves a creating task view without querying a missing Native task, then folds its alias', async () => {
    const f = fixture(), alias = 'runtime-creating-task'
    const originalResolver = f.runtime.resolveTaskId
    await expect(taskView(f.runtime, 'runtime.tasks.view.attach', {
      taskId: alias, viewId: 'creating-pane', reserveOnly: true,
    })).resolves.toEqual({ attached: false })
    expect(f.runtime.taskConnection).not.toHaveBeenCalled()
    expect(f.client.request).not.toHaveBeenCalled()
    f.runtime.resolveTaskId = id => id === alias ? f.task.taskId : originalResolver(id)
    await expect(attachTaskViews(f.runtime, f.task, f.client as never)).resolves.toBe(true)
    expect(releaseUnviewedTaskClient(f.runtime, f.task.taskId, f.client as never)).toBe(false)
    expect(f.client.close).not.toHaveBeenCalled()
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: alias, viewId: 'creating-pane' })
    expect(f.client.close).toHaveBeenCalledOnce()
  })

  it('releases an unconfirmed view reservation without querying or creating a task', async () => {
    const f = fixture(), alias = 'runtime-cancelled-creation'
    const before = f.runtime.tasks.size
    await taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: alias, viewId: 'pane', reserveOnly: true })
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: alias, viewId: 'pane' })
    expect(f.runtime.taskConnection).not.toHaveBeenCalled()
    expect(f.runtime.tasks.size).toBe(before)
    expect(f.runtime.taskViewGenerations.size).toBe(0)
    expect(f.client.close).not.toHaveBeenCalled()
  })

  it('a late provisional reservation does not downgrade an existing Native view', async () => {
    const f = fixture()
    await taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'ready' })
    f.client.request.mockClear()
    await taskView(f.runtime, 'runtime.tasks.view.attach', {
      taskId: f.task.taskId, viewId: 'provisional', reserveOnly: true,
    })
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'provisional' })
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.client.close).not.toHaveBeenCalled()
    await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'ready' })
    expect(f.client.request).toHaveBeenCalledExactlyOnceWith('gateway/thread/detach', expect.any(Object))
  })

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
    const [first] = f.client.request.mock.calls
    expect(f.client.request).toHaveBeenCalledTimes(1)
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


test('restoration and pane attachment register the same client generation once', async () => {
  const f = fixture()
  f.runtime.taskConnection = vi.fn(async () => {
    await attachTaskViews(f.runtime, f.task, f.client as never)
    return { task: f.task, client: f.client } as never
  })
  await expect(taskView(f.runtime, 'runtime.tasks.view.attach', {
    taskId: f.task.taskId, viewId: 'pane',
  })).resolves.toEqual({ attached: true })
  expect(f.client.request).toHaveBeenCalledTimes(1)
})

test('concurrent panes share the in-flight registration and release only the last view', async () => {
  const f = fixture()
  const receipt = deferred<{ changed: boolean }>()
  f.client.request.mockReturnValueOnce(receipt.promise)
  const first = taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'first' })
  const second = taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'second' })
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
  receipt.resolve({ changed: true })
  await Promise.all([first, second])
  await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'first' })
  expect(f.client.request).toHaveBeenCalledTimes(1)
  await taskView(f.runtime, 'runtime.tasks.view.release', { taskId: f.task.taskId, viewId: 'second' })
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['gateway/thread/attach', 'gateway/thread/detach'])
})

test('failed registrations can retry and a new connection must register again', async () => {
  const f = fixture()
  f.client.request.mockRejectedValueOnce(new Error('attachment refused'))
  const params = { taskId: f.task.taskId, viewId: 'pane' }
  await expect(taskView(f.runtime, 'runtime.tasks.view.attach', params)).rejects.toThrow('attachment refused')
  await expect(taskView(f.runtime, 'runtime.tasks.view.attach', params)).resolves.toEqual({ attached: true })
  const replacement = { ...f.client, request: vi.fn().mockResolvedValue({ changed: true }) }
  f.runtime.clientByTask.set(f.task.taskId, replacement as never)
  await expect(attachTaskViews(f.runtime, f.task, replacement as never)).resolves.toBe(true)
  expect(replacement.request).toHaveBeenCalledTimes(1)
  expect(replacement.request.mock.calls[0]).toEqual(f.client.request.mock.calls[1])
})

test('a view released while its registration is pending is detached after the late receipt', async () => {
  const f = fixture()
  const receipt = deferred<{ changed: boolean }>()
  f.client.request.mockReturnValueOnce(receipt.promise)
  const params = { taskId: f.task.taskId, viewId: 'pane' }
  const opening = taskView(f.runtime, 'runtime.tasks.view.attach', params)
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
  await taskView(f.runtime, 'runtime.tasks.view.release', params)
  receipt.resolve({ changed: true })
  await expect(opening).resolves.toEqual({ attached: false })
  expect(f.client.request).toHaveBeenLastCalledWith('gateway/thread/detach', f.client.request.mock.calls[0][1])
  expect(f.runtime.taskViewGenerations.size).toBe(0)
})


test('a late old-client receipt cannot replace the reopened connection registration', async () => {
  const f = fixture()
  const receipt = deferred<{ changed: boolean }>()
  f.client.request.mockReturnValueOnce(receipt.promise)
  const opening = taskView(f.runtime, 'runtime.tasks.view.attach', { taskId: f.task.taskId, viewId: 'pane' })
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
  const replacement = { ...f.client, request: vi.fn().mockResolvedValue({ changed: true }) }
  f.runtime.clientByTask.set(f.task.taskId, replacement as never)
  await expect(attachTaskViews(f.runtime, f.task, replacement as never)).resolves.toBe(true)
  receipt.resolve({ changed: true })
  await expect(opening).resolves.toEqual({ attached: false })
  await expect(attachTaskViews(f.runtime, f.task, replacement as never)).resolves.toBe(true)
  expect(replacement.request).toHaveBeenCalledTimes(1)
  expect(f.client.request).toHaveBeenLastCalledWith('gateway/thread/detach', f.client.request.mock.calls[0][1])
  expect(replacement.close).not.toHaveBeenCalled()
})


test('a reconnected socket on the same client gets a new registration on its actual connection', async () => {
  const f = fixture()
  const pinned = vi.fn().mockResolvedValue({ changed: true })
  const identity = { connectionId: 'socket-1' }
  Object.assign(f.client, { diagnosticConnection: identity, requestOnConnection: pinned })
  const params = { taskId: f.task.taskId, viewId: 'pane' }
  await taskView(f.runtime, 'runtime.tasks.view.attach', params)
  identity.connectionId = 'socket-2'
  await taskView(f.runtime, 'runtime.tasks.view.attach', params)
  expect(pinned.mock.calls.map(([connection, method]) => [connection, method])).toEqual([
    ['socket-1', 'gateway/thread/attach'], ['socket-2', 'gateway/thread/attach'],
  ])
  await taskView(f.runtime, 'runtime.tasks.view.release', params)
  expect(pinned).toHaveBeenLastCalledWith('socket-2', 'gateway/thread/detach', expect.anything())
  expect(f.client.request).not.toHaveBeenCalled()
})

test('release and a late registration acknowledgement share the same original-connection cleanup', async () => {
  const f = fixture()
  const receipt = deferred<{ changed: boolean }>()
  const pinned = vi.fn().mockImplementation((_connection: string, method: string) =>
    method.endsWith('/attach') ? receipt.promise : Promise.resolve({ changed: true }))
  Object.assign(f.client, { diagnosticConnection: { connectionId: 'original-socket' }, requestOnConnection: pinned })
  const params = { taskId: f.task.taskId, viewId: 'pane' }
  const opening = taskView(f.runtime, 'runtime.tasks.view.attach', params)
  await vi.waitFor(() => expect(pinned).toHaveBeenCalledTimes(1))
  await taskView(f.runtime, 'runtime.tasks.view.release', params)
  receipt.resolve({ changed: true })
  await expect(opening).resolves.toEqual({ attached: false })
  expect(pinned.mock.calls.map(([connection, method]) => [connection, method])).toEqual([
    ['original-socket', 'gateway/thread/attach'], ['original-socket', 'gateway/thread/detach'],
  ])
  expect(f.client.request).not.toHaveBeenCalled()
})
