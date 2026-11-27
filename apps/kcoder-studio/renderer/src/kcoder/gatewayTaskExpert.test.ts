import { expect, it, vi } from 'vitest'
import { requestTaskExpert } from './gatewayTaskExpert'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { ThreadExpertResult } from '../../../shared/generated/contracts'
import { notifyAccountContextChange } from './accountContextEvents'
import { GatewayRpcError } from './gatewayRpc'

function fixture(supported = true, lightweightReadSupported = true) {
  const task = { taskId: 'task-b', threadId: 'thread-b', serverId: 'target', workspacePath: '/owned' }
  const client = { supportsExperimental: vi.fn((capability: string) => capability === 'threadExpertReadWithoutTurnsV1' ? lightweightReadSupported : supported),
    request: vi.fn<(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<ThreadExpertResult>>(async () =>
      ({ threadId: task.threadId, revision: 2, expert: null, turns: [] })) }
  const server = { id: task.serverId }
  const first = { request: vi.fn() }
  const host = { disposed: false, workspaceScanGeneration: 0, tasks: new Map([[task.taskId, task]]), clientByTask: new Map([['task-a', first], [task.taskId, client]]),
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server })),
    readyTaskClient: vi.fn(async () => client) }
  const call = (extra: Record<string, unknown> = {}, options?: { signal?: AbortSignal }) => requestTaskExpert.call(host as unknown as GatewayRuntimeCore,
    { taskId: task.taskId, threadId: task.threadId, deviceId: task.serverId, ...extra }, options)
  return { task, client, first, host, call }
}

function holdRequests(f: ReturnType<typeof fixture>) {
  const pending: Array<{
    params?: Record<string, unknown>
    signal?: AbortSignal
    finish: (result: ThreadExpertResult) => void
  }> = []
  f.client.request.mockImplementation((_method, params, options) => new Promise((resolve, reject) => {
    pending.push({ params, signal: options?.signal, finish: resolve })
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }))
  const result = (revision = 2): ThreadExpertResult => ({ threadId: f.task.threadId, revision, expert: null, turns: [] })
  return { pending, result }
}

it('changes only the explicitly selected original task and preserves null plus its CAS revision', async () => {
  const f = fixture()
  await f.call({ change: { expectedRevision: 1, expert: null }, input: 'must not execute' })
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('thread/expert', {
    threadId: 'thread-b', includeTurns: false, change: { expectedRevision: 1, expert: null },
  })
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

it('omits the lightweight-read field for older app servers', async () => {
  const old = fixture(true, false)
  await old.call()
  expect(old.client.request).toHaveBeenCalledExactlyOnceWith('thread/expert', { threadId: 'thread-b' }, { signal: expect.any(AbortSignal) })
})

it('reads legacy task metadata through its registered thread and requires a thread for changes', async () => {
  const f = fixture()
  await expect(f.call({ threadId: undefined })).resolves.toMatchObject({ threadId: 'thread-b' })
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('thread/expert', {
    threadId: 'thread-b', includeTurns: false,
  }, { signal: expect.any(AbortSignal) })
  await expect(f.call({ threadId: undefined, change: { expectedRevision: 2, expert: null } }))
    .rejects.toThrow('AGENT_ORIGINAL_TASK_REQUIRED')
  expect(f.client.request).toHaveBeenCalledOnce()
})

it('rejects wrong original task/target and a reply from a replaced connection without replay', async () => {
  const f = fixture()
  await expect(f.call({ threadId: 'thread-a' })).rejects.toThrow('CHANGED')
  await expect(f.call({ deviceId: 'another' })).rejects.toThrow('CHANGED')
  expect(f.host.readyTaskClient).not.toHaveBeenCalled()
  expect(f.client.request).not.toHaveBeenCalled()
  f.client.request.mockImplementation(async () => {
    f.host.clientByTask.set(f.task.taskId, { ...f.client })
    return { threadId: f.task.threadId, revision: 2, expert: null, turns: [] }
  })
  await expect(f.call({ change: { expectedRevision: 1, expert: null } })).rejects.toThrow('CHANGED')
  expect(f.client.request).toHaveBeenCalledTimes(1)
})

it('a reply from a replaced connection is discarded as a retryable connection change', async () => {
  const f = fixture()
  f.client.request.mockImplementation(async () => {
    f.host.clientByTask.set(f.task.taskId, { ...f.client })
    return { threadId: f.task.threadId, revision: 2, expert: null, turns: [] }
  })
  await expect(f.call()).rejects.toThrow('AGENT_TASK_CONNECTION_CHANGED')
  expect(f.host.tasks.get(f.task.taskId)).not.toHaveProperty('agentDefinition')
  await expect(f.call({ deviceId: 'another' })).rejects.toThrow('AGENT_ORIGINAL_TASK_CHANGED')
})

it('an expert read merges into current task metadata without rolling back intervening turn events', async () => {
  const f = fixture()
  let finish!: (value: { threadId: string; revision: number; expert: null; turns: [] }) => void
  f.client.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const reading = f.call()
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledOnce())
  expect(f.client.request).toHaveBeenCalledOnce()
  const latest = { ...f.task, running: false, turnStatus: 'completed', title: 'Updated while reading',
    runtimeHandle: { threadId: f.task.threadId, cursor: 'new-event-cursor' } }
  f.host.tasks.set(f.task.taskId, latest)
  finish({ threadId: f.task.threadId, revision: 2, expert: null, turns: [] })
  await reading
  expect(f.host.tasks.get(f.task.taskId)).toMatchObject(latest)
})

it('shares only overlapping expert reads on the same original task connection', async () => {
  const f = fixture()
  const completions: Array<(value: { threadId: string; revision: number; expert: null; turns: [] }) => void> = []
  f.client.request.mockImplementation(() => new Promise(resolve => { completions.push(resolve) }))
  const reads = [f.call(), f.call()]
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalled())
  const requestsWhilePending = f.client.request.mock.calls.length
  for (const finish of completions) finish({ threadId: f.task.threadId, revision: 2, expert: null, turns: [] })
  await Promise.all(reads)
  expect(requestsWhilePending).toBe(1)
})

it('an admitted binding change retires the queued read before Native dispatch', async () => {
  const f = fixture(), held = holdRequests(f)
  const stale = expect(f.call()).rejects.toThrow('STALE_REPLY')
  const change = f.call({ change: { expectedRevision: 2, expert: null } })
  await vi.waitFor(() => expect(held.pending.some(read => read.params?.change !== undefined)).toBe(true))
  for (const read of held.pending) read.finish(held.result(3))
  await Promise.all([stale, change])
  expect(f.client.request).toHaveBeenCalledTimes(1)
  expect(held.pending[0].params).toHaveProperty('change')
  const current = f.call()
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  held.pending[1].finish(held.result(3))
  await current
})

it('cancelling one view keeps the shared RPC and peer view alive', async () => {
  const f = fixture(), held = holdRequests(f)
  const a = new AbortController(), b = new AbortController()
  const first = f.call({}, { signal: a.signal })
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const second = f.call({}, { signal: b.signal })
  await vi.waitFor(() => expect(held.pending).toHaveLength(1))
  a.abort(); await cancelled
  expect(held.pending[0].signal?.aborted).toBe(false)
  held.pending[0].finish(held.result())
  await expect(second).resolves.toEqual(held.result())
  expect(f.client.request).toHaveBeenCalledOnce()
})

it('last cancellation releases the RPC and a later read starts fresh work', async () => {
  const f = fixture(), held = holdRequests(f)
  const a = new AbortController(), b = new AbortController()
  const first = f.call({}, { signal: a.signal }), second = f.call({}, { signal: b.signal })
  const failures = [expect(first).rejects.toMatchObject({ name: 'AbortError' }),
    expect(second).rejects.toMatchObject({ name: 'AbortError' })]
  await vi.waitFor(() => expect(held.pending).toHaveLength(1))
  a.abort(); b.abort(); await Promise.all(failures)
  expect(held.pending[0].signal?.aborted).toBe(true)
  const next = f.call()
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  held.pending[1].finish(held.result(3))
  await expect(next).resolves.toMatchObject({ revision: 3 })
})

it('each view receives its own DTO and completed reads are never reused', async () => {
  const f = fixture(), held = holdRequests(f)
  const first = f.call(), second = f.call()
  await vi.waitFor(() => expect(held.pending).toHaveLength(1))
  held.pending[0].finish(held.result())
  const [a, b] = await Promise.all([first, second]) as ThreadExpertResult[]
  expect(a).not.toBe(b)
  expect(a.turns).not.toBe(b.turns)
  a.revision = 99
  expect(b.revision).toBe(2)
  const later = f.call()
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  held.pending[1].finish(held.result(3))
  await expect(later).resolves.toMatchObject({ revision: 3 })
})

it.each(['account', 'workspace generation', 'connection'])('does not share a pending read across a changed %s', async boundary => {
  const f = fixture(), held = holdRequests(f)
  const first = f.call()
  const stale = expect(first).rejects.toThrow('CHANGED')
  await vi.waitFor(() => expect(held.pending).toHaveLength(1))
  if (boundary === 'account') notifyAccountContextChange(f.task.serverId)
  else if (boundary === 'workspace generation') f.host.workspaceScanGeneration++
  else {
    const replacement = { ...f.client }
    f.host.clientByTask.set(f.task.taskId, replacement)
    f.host.readyTaskClient.mockResolvedValue(replacement)
  }
  const current = f.call()
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  held.pending[1].finish(held.result(4))
  await current
  held.pending[0].finish(held.result(2))
  await stale
  expect(f.host.tasks.get(f.task.taskId)).toMatchObject({ threadId: f.task.threadId })
})

it('mutations remain independent and invalidate reads started before or during the change', async () => {
  const f = fixture(), held = holdRequests(f)
  const project = vi.spyOn(f.host.tasks, 'set')
  const before = f.call()
  const beforeRejected = expect(before).rejects.toThrow('STALE_REPLY')
  await vi.waitFor(() => expect(held.pending).toHaveLength(1))
  const change = f.call({ change: { expectedRevision: 2, expert: null } })
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  const during = f.call()
  const duringRejected = expect(during).rejects.toThrow('STALE_REPLY')
  await vi.waitFor(() => expect(held.pending).toHaveLength(3))
  held.pending[1].finish(held.result(3))
  await change
  held.pending[0].finish(held.result(2)); held.pending[2].finish(held.result(2))
  await Promise.all([beforeRejected, duringRejected])
  expect(project).toHaveBeenCalledTimes(1)
  const latest = f.call()
  await vi.waitFor(() => expect(held.pending).toHaveLength(4))
  held.pending[3].finish(held.result(3))
  await expect(latest).resolves.toMatchObject({ revision: 3 })
  expect(held.pending.filter(read => read.params?.change)).toHaveLength(1)
})

it('rejects an already cancelled read before resolving a task connection', async () => {
  const f = fixture(), abort = new AbortController()
  abort.abort()
  await expect(f.call({}, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.host.taskDescriptor).not.toHaveBeenCalled()
  expect(f.client.request).not.toHaveBeenCalled()
})

it('a failed shared read is retired and the next read performs a fresh RPC', async () => {
  const f = fixture()
  f.client.request.mockRejectedValueOnce(new Error('target unavailable'))
  const replies = await Promise.allSettled([f.call(), f.call()])
  expect(replies.every(reply => reply.status === 'rejected')).toBe(true)
  expect(f.client.request).toHaveBeenCalledOnce()
  await expect(f.call()).resolves.toMatchObject({ revision: 2 })
  expect(f.client.request).toHaveBeenCalledTimes(2)
})

it('two explicit changes are never combined even with identical CAS input', async () => {
  const f = fixture(), held = holdRequests(f)
  const changes = [f.call({ change: { expectedRevision: 2, expert: null } }),
    f.call({ change: { expectedRevision: 2, expert: null } })]
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  for (const request of held.pending) request.finish(held.result(3))
  await Promise.all(changes)
  expect(held.pending.every(request => request.params?.change)).toBe(true)
})

it('runtime owners never share a pending request even if they are given the same client', async () => {
  const a = fixture(), b = fixture(), held = holdRequests(a)
  b.host.clientByTask.set(b.task.taskId, a.client)
  b.host.readyTaskClient.mockResolvedValue(a.client)
  const reads = [a.call(), b.call()]
  await vi.waitFor(() => expect(held.pending).toHaveLength(2))
  for (const request of held.pending) request.finish(held.result())
  await Promise.all(reads)
})

it('reports the same thread\'s compaction as busy without resending the change', async () => {
  const f = fixture()
  f.client.request.mockRejectedValueOnce(new GatewayRpcError('thread compact is in progress', -32028, undefined, 'unknown', 'remote'))
  await expect(f.call({ change: { expectedRevision: 1, expert: null } })).rejects.toThrow('AGENT_TASK_APP_SERVER_BUSY')
  expect(f.client.request).toHaveBeenCalledOnce()
  await expect(f.call()).resolves.toMatchObject({ revision: 2 })
})

it('resumes an evicted thread on the same connection and resends a change once', async () => {
  const f = fixture()
  const methods: string[] = []
  f.client.request.mockImplementation(async (method: string) => {
    methods.push(method)
    if (method === 'thread/resume') return { thread: { id: f.task.threadId } } as never
    if (methods.filter(name => name === 'thread/expert').length === 1)
      throw new GatewayRpcError('thread is not resident', -32027, { threadId: f.task.threadId, reason: 'capacity' }, 'unknown', 'remote')
    return { threadId: f.task.threadId, revision: 2, expert: null, turns: [] }
  })
  await expect(f.call({ change: { expectedRevision: 1, expert: null } })).resolves.toMatchObject({ revision: 2 })
  expect(methods).toEqual(['thread/expert', 'thread/resume', 'thread/expert'])
  expect(f.host.readyTaskClient).toHaveBeenCalledOnce()
})
