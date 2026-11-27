import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'
import { hydratePersistedTask } from './gateway/runtime/coldTaskIndex'

const original = '/native/private/old-auto-workspace'
const threadId = 'old_thread'
const taskId = `kcoder:origin:${threadId}`
function fixture(options: { partial?: boolean; stale?: boolean; absent?: boolean; duplicate?: boolean; goalStatus?: boolean; incompleteList?: boolean;
  beforeLookup?: (call: number) => Promise<void> } = {}) {
  const server = localGatewayServer({ id: 'origin', workspacePath: '/saved/default' })
  const clients: Array<{ path?: string; client: FakeGatewayClient }> = []
  let lookupCalls = 0
  const runtime = createTestGatewayRuntime('fixture-token', {
    loadServers: async () => [server],
    createClient: (_serverId, _token, _channel, path) => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      const supports = client.supportsExperimental.bind(client)
      client.supportsExperimental = capability => capability === 'threadWorkspaceLookupV1' ||
        Boolean(options.incompleteList && capability === 'threadListCompleteness') ||
        Boolean(options.goalStatus && capability === 'threadGoalStatusBatchV1') || supports(capability)
      if (path === original && !options.absent)
        client.persistedThreads = [{ id: threadId, cwd: original, status: 'idle' }]
      if (path === '/native/private/duplicate')
        client.persistedThreads = [{ id: threadId, cwd: path, status: 'idle' }]
      const request = client.request.bind(client)
      client.request = async (method, params) => {
        if (options.incompleteList && method === 'thread/list') return {
          ...await request<{ threads: unknown[] }>(method, params),
          completeness: path === original ? 'partial' : 'complete',
          issueCount: path === original ? 1 : 0,
          nextCursor: path === original ? 'must-not-follow' : null,
        } as never
        if (options.goalStatus && method === 'thread/goal/status/readMany') {
          client.requests.push({ method, params: params ?? {} })
          return { observations: (params?.threadIds as string[])
            .map(id => ({ threadId: id, availability: 'available', status: null })) } as never
        }
        if (method !== 'thread/workspace/lookup') return request(method, params)
        lookupCalls++
        await options.beforeLookup?.(lookupCalls)
        client.requests.push({ method, params: params ?? {} })
        if (options.stale) notifyAccountContextChange(server.id)
        return { threadId, candidates: [{ workspacePath: original }, ...(options.duplicate
          ? [{ workspacePath: '/native/private/duplicate' }] : [])],
          completeness: options.partial ? 'partial' : 'complete', issueCount: options.partial ? 1 : 0,
          scannedProjects: 2 } as never
      }
      clients.push({ path, client })
      return client
    },
  })
  return { runtime, clients, server, get lookupCalls() { return lookupCalls } }
}

test('parallel cold observers share discovery only until it settles and still validate each route', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ beforeLookup: () => held })
  const params = { taskId, threadId, deviceId: 'origin' }
  const read = () => hydratePersistedTask.call(f.runtime, taskId, params)
  const first = read(), second = read(), third = read()
  const outcome = Promise.all([first, second, third])
  try {
    await vi.waitFor(() => expect(f.lookupCalls).toBeGreaterThan(0))
    expect(f.lookupCalls).toBe(1)
    await expect(hydratePersistedTask.call(f.runtime, taskId, { ...params, deviceId: 'different' }))
      .rejects.toThrow('ORIGINAL_TASK_IDENTITY_CHANGED')
    release()
    const results = await outcome
    expect(results).toEqual([results[0], results[0], results[0]])
    expect(f.lookupCalls).toBe(1)
    await read()
    expect(f.lookupCalls).toBe(2)
    expect(f.clients.flatMap(row => row.client.requests)
      .filter(row => ['thread/start', 'thread/resume', 'turn/start'].includes(row.method))).toEqual([])
  } finally { release(); await outcome.catch(() => {}); await f.runtime.disposeAsync() }
})

test.each(['account', 'configuration', 'scan'] as const)(
  'a replaced %s discovery cannot be joined or retire its replacement', async change => {
    const release: Array<() => void> = []
    const gates = [0, 1].map(() => new Promise<void>(resolve => release.push(resolve)))
    const f = fixture({ beforeLookup: call => gates[call - 1] ?? Promise.resolve() })
    const read = () => hydratePersistedTask.call(f.runtime, taskId, { deviceId: 'origin', threadId })
    const original = read().catch(error => error)
    const replacements: Array<ReturnType<typeof read>> = []
    try {
      await vi.waitFor(() => expect(f.lookupCalls).toBe(1))
      if (change === 'account') notifyAccountContextChange('origin')
      else if (change === 'configuration') f.runtime.configurationEpochByTarget.set('origin', {})
      else f.runtime.invalidateWorkspaceScans()
      replacements.push(read(), read())
      await vi.waitFor(() => expect(f.lookupCalls).toBe(2))
      release[0]()
      const old = await original
      if (change !== 'scan') expect(old).toBeInstanceOf(Error)
      replacements.push(read())
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(f.lookupCalls).toBe(2)
      release[1]()
      await expect(Promise.all(replacements)).resolves.toHaveLength(3)
      expect(f.lookupCalls).toBe(2)
    } finally {
      release.forEach(settle => settle())
      await Promise.allSettled([original, ...replacements])
      await f.runtime.disposeAsync()
    }
  }
)

test('failed shared discovery is retired before the next fresh attempt', async () => {
  const options = { partial: true }
  const f = fixture(options)
  const read = () => hydratePersistedTask.call(f.runtime, taskId, { deviceId: 'origin', threadId })
  try {
    const failures = await Promise.allSettled([read(), read()])
    expect(failures.every(result => result.status === 'rejected')).toBe(true)
    expect(f.lookupCalls).toBe(1)
    options.partial = false
    await expect(read()).resolves.toHaveProperty('targetScope')
    expect(f.lookupCalls).toBe(2)
  } finally { await f.runtime.disposeAsync() }
})

test('a fully cold unregistered workspace is located only by negotiated Native metadata and then real thread/list', async () => {
  const f = fixture()
  const result = await f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })
  expect(result).toMatchObject({ taskId, workspacePath: original })
  expect(f.lookupCalls).toBe(1)
  const actual = f.clients.find(row => row.path === original)!
  expect(actual.client.requests.some(row => row.method === 'thread/list')).toBe(true)
  expect(f.clients.flatMap(row => row.client.requests).filter(row => ['thread/start', 'turn/start'].includes(row.method))).toEqual([])
})

test('cold candidate verification supplies the original inventory to hydration without a second Native list', async () => {
  const f = fixture()
  try {
    const result = await f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })
    expect(result).toMatchObject({ taskId, workspacePath: original })
    const originalLists = f.clients.filter(row => row.path === original)
      .flatMap(row => row.client.requests).filter(row => row.method === 'thread/list')
    expect(originalLists).toHaveLength(1)
  } finally { await f.runtime.disposeAsync() }
})

test('events after candidate inventory capture outrank its older task and Goal projection', async () => {
  const f = fixture({ goalStatus: true })
  try {
    await f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })
    const previous = f.runtime.tasks.get(taskId)!
    const observation = { availability: 'unavailable' as const }
    const hydrate = f.runtime.hydratePersistedTasks.bind(f.runtime)
    vi.spyOn(f.runtime, 'hydratePersistedTasks').mockImplementationOnce(async (...args) => {
      f.runtime.tasks.set(taskId, { ...previous, running: true, turnStatus: 'inProgress', goalStatusObservation: observation })
      for (const row of f.clients) row.client.persistedThreads = row.client.persistedThreads.map(thread =>
        thread.id === threadId ? { ...thread, status: 'running' } : thread)
      return hydrate(...args)
    })
    await hydratePersistedTask.call(f.runtime, taskId, { deviceId: 'origin', threadId })
    expect(f.runtime.tasks.get(taskId)).toMatchObject({ running: true, turnStatus: 'inProgress' })
    expect(f.runtime.tasks.get(taskId)?.goalStatusObservation).toBe(observation)
    expect(f.clients.flatMap(row => row.client.requests).filter(row => row.method === 'thread/goal/status/readMany')).toHaveLength(2)
  } finally { await f.runtime.disposeAsync() }
})

test('an account replacement before inventory handoff cannot project or resume old task data', async () => {
  const f = fixture()
  const hydrate = f.runtime.hydratePersistedTasks.bind(f.runtime)
  vi.spyOn(f.runtime, 'hydratePersistedTasks').mockImplementationOnce(async (...args) => {
    notifyAccountContextChange('origin')
    return hydrate(...args)
  })
  try {
    await expect(hydratePersistedTask.call(f.runtime, taskId, { deviceId: 'origin', threadId })).rejects.toThrow()
    expect(f.runtime.tasks.has(taskId)).toBe(false)
    expect(f.clients.flatMap(row => row.client.requests).some(row => row.method === 'thread/resume')).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test.each([false, true])('tasks arriving after inventory capture cannot be pruned by its older omission (archived: %s)', async archived => {
  const f = fixture()
  try {
    await f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })
    const arriving = { ...f.runtime.tasks.get(taskId)!, taskId: 'kcoder:origin:arriving', threadId: 'arriving' }
    const collection = archived ? f.runtime.archivedTasks : f.runtime.tasks
    const hydrate = f.runtime.hydratePersistedTasks.bind(f.runtime)
    vi.spyOn(f.runtime, 'hydratePersistedTasks').mockImplementationOnce(async (...args) => {
      collection.set(arriving.taskId, arriving)
      f.runtime.persistedThreadMisses.set(f.runtime.threadKey('origin', arriving.threadId), 1)
      return hydrate(...args)
    })
    await hydratePersistedTask.call(f.runtime, taskId, { deviceId: 'origin', threadId })
    expect(collection.get(arriving.taskId)).toBe(arriving)
  } finally { await f.runtime.disposeAsync() }
})

test('a partial Native candidate stops before following its cursor or projecting any task', async () => {
  const f = fixture({ incompleteList: true })
  try {
    await expect(hydratePersistedTask.call(f.runtime, taskId, { deviceId: 'origin', threadId }))
      .rejects.toThrow('ORIGINAL_TASK_INDEX_UNAVAILABLE')
    expect(f.clients.filter(row => row.path === original).flatMap(row => row.client.requests)
      .filter(row => row.method === 'thread/list')).toHaveLength(1)
    expect(f.runtime.tasks.has(taskId)).toBe(false)
    expect(f.clients.flatMap(row => row.client.requests).some(row => row.method === 'thread/resume')).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test('sidebar scan replacement during metadata lookup preserves the original cold task lifetime', async () => {
  const f = fixture({ beforeLookup: async () => { f.runtime.invalidateWorkspaceScans() } })
  try {
    const result = await f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })
    expect(result).toMatchObject({ taskId, workspacePath: original })
    expect(f.lookupCalls).toBe(1)
    expect(f.clients.flatMap(row => row.client.requests).filter(row => ['thread/start', 'turn/start'].includes(row.method))).toEqual([])
  } finally { await f.runtime.disposeAsync() }
})

test('metadata hints never replace real history visibility or unique workspace binding', async () => {
  for (const options of [{ absent: true }, { duplicate: true }, { partial: true }]) {
    const f = fixture(options)
    await expect(f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })).rejects.toThrow()
    expect(f.runtime.tasks.has(taskId)).toBe(false)
    expect(f.clients.flatMap(row => row.client.requests)
      .filter(row => ['thread/resume', 'thread/read', 'thread/read/indexed'].includes(row.method))).toEqual([])
  }
})

test('an account change during Native metadata lookup cannot publish or resume into the replacement account', async () => {
  const f = fixture({ stale: true })
  await expect(f.runtime.request('runtime.tasks.transcript', { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true })).rejects.toThrow()
  expect(f.runtime.tasks.has(taskId)).toBe(false)
  expect(f.clients.flatMap(row => row.client.requests).filter(row => row.method === 'thread/resume')).toEqual([])
})

test('warm reads reuse the verified task binding without another persistent metadata traversal', async () => {
  const f = fixture()
  const request = { taskId, threadId, deviceId: 'origin', attachToLiveTurn: true }
  await f.runtime.request('runtime.tasks.transcript', request)
  await f.runtime.request('runtime.tasks.transcript', request)
  expect(f.lookupCalls).toBe(1)
})
