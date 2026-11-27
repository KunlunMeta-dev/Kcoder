import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { notifyAccountContextChange } from '../../accountContextEvents'
import { readContinuousWorkCapabilities, readContinuousWorks } from './continuousWorks'
import type { GatewayTask } from './contracts'
import { persistentTaskWorkspaceHints } from './persistentTaskWorkspace'
import { getTaskGoalObservation } from './goalObservation'

const readMethods = ['runtime.workspaces.list', 'thread/list', 'thread/goal/status/readMany', 'work/list', 'thread/workspace/lookup', 'thread/goal/get'] as const

class RegistryClient extends FakeGatewayClient {
  threadResumeSupported = true
  diagnosticConnection = { targetId: 'local', connectionId: 'original-connection' }
  readonly boundRequests = vi.fn()
  override supportsExperimental(capability: string) {
    return capability === 'threadWorkspaceLookupV1' || super.supportsExperimental(capability)
  }
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'thread/workspace/lookup') {
      this.requests.push({ method, params })
      return { threadId: params.threadId, candidates: [], completeness: 'complete', issueCount: 0, scannedProjects: 0 } as T
    }
    if (method === 'thread/goal/get') {
      this.requests.push({ method, params })
      return { goal: null } as T
    }
    if (method === 'work/list') {
      this.requests.push({ method, params })
      return { items: [] } as T
    }
    return super.request<T>(method, params)
  }
  requestOnConnection: NonNullable<GatewayClient['requestOnConnection']> = async <T>(id, method, params = {}, options) => {
    this.boundRequests(id, method, options)
    options?.signal?.throwIfAborted()
    if (method === 'thread/goal/status/readMany') return {
      observations: (params.threadIds as string[]).map(threadId => ({ threadId, availability: 'available', status: null })),
    } as T
    if (method === 'work/list') return { items: [] } as T
    if (method === 'thread/workspace/lookup' || method === 'thread/goal/get') return this.request<T>(method, params)
    return super.request<T>(method, params)
  }
}

function fixture() {
  const server = localGatewayServer()
  const clients: RegistryClient[] = []
  const runtime = new Runtime('fixture', {
    loadServers: async () => [server],
    createClient: () => { const client = new RegistryClient(null); clients.push(client); return client },
  })
  const read = (method: typeof readMethods[number] = 'runtime.workspaces.list', scanBound = true) => runtime.withWorkspaceReadClient(server, client =>
    client.request(method, method === 'thread/list' ? { limit: 100 }
      : method === 'thread/goal/status/readMany' ? { threadIds: [] } : method === 'work/list' ? {}
        : method === 'thread/goal/get' ? { threadId: 'saved-thread' }
        : method === 'thread/workspace/lookup' ? { threadId: 'saved-thread', limit: 64 } : { deviceId: server.id }), undefined, scanBound)
  return { runtime, server, clients, read }
}

test('registry reads borrow an existing root command client without caching results or creating clients', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    await f.read(); await f.read()
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].boundRequests).toHaveBeenCalledTimes(2)
    expect(f.clients[0].closed).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test('persistent metadata reads borrow the original command connection and query Native afresh', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    for (let index = 0; index < 2; index++) {
      expect(await persistentTaskWorkspaceHints(f.runtime, f.server, 'saved-thread', async () => {})).toEqual([])
    }
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].boundRequests.mock.calls.map(([id, method]) => [id, method]))
      .toEqual(Array.from({ length: 2 }, () => ['original-connection', 'thread/workspace/lookup']))
    expect(f.clients[0].closed).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test('a cold Goal read uses an already held original-workspace command without acquiring a task runtime', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    const taskId = `kcoder:${f.server.id}:saved-thread`
    f.runtime.tasks.set(taskId, { taskId, serverId: f.server.id, threadId: 'saved-thread',
      workspacePath: f.server.workspacePath, persisted: true } as GatewayTask)
    for (let index = 0; index < 2; index++) {
      await expect(getTaskGoalObservation.call(f.runtime, { deviceId: f.server.id, taskId }))
        .resolves.toMatchObject({ accepted: true, taskId })
    }
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].boundRequests.mock.calls.filter(([, method]) => method === 'thread/goal/get')).toHaveLength(2)
    expect(f.runtime.clientByTask.size).toBe(0)
    expect(f.runtime.resumeClientByTask.size).toBe(0)
    expect(f.clients[0].closed).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test.each(['caller-cancel', 'connection-retired'] as const)(
  'a borrowed Goal read handles %s without reopening or closing the shared command', async change => {
    const f = fixture(), abort = new AbortController()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let settled: Promise<unknown> | undefined
    try {
      await f.runtime.commandClient(f.server)
      const taskId = `kcoder:${f.server.id}:saved-thread`
      f.runtime.tasks.set(taskId, { taskId, serverId: f.server.id, threadId: 'saved-thread',
        workspacePath: f.server.workspacePath, persisted: true } as GatewayTask)
      const client = f.clients[0], entered = vi.fn()
      vi.spyOn(client, 'requestOnConnection').mockImplementationOnce(async () => {
        entered(); await gate; return { goal: { status: 'active' } } as never
      })
      settled = getTaskGoalObservation.call(f.runtime, { deviceId: f.server.id, taskId }, { signal: abort.signal })
        .catch(error => error)
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      if (change === 'caller-cancel') abort.abort()
      else client.diagnosticConnection.connectionId = 'replacement'
      release()
      await expect(settled).resolves.toMatchObject({ name: 'AbortError',
        ...(change === 'connection-retired' ? { code: 'KCODER_RUNTIME_GOAL_SCOPE_RETIRED' } : {}) })
      expect(f.clients).toHaveLength(1)
      expect(client.closed).toBe(false)
      expect(f.runtime.clientByTask.size).toBe(0)
      expect(f.runtime.resumeClientByTask.size).toBe(0)
    } finally { release(); await settled; await f.runtime.disposeAsync() }
  }
)

test.each(['thread/list', 'thread/workspace/lookup', 'thread/goal/get'] as const)(
  'task-owned %s reads survive unrelated scan retirement on a borrowed connection', async method => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    try {
      await f.runtime.commandClient(f.server)
      let entered = false
      vi.spyOn(f.clients[0], 'requestOnConnection').mockImplementationOnce(async () => {
        entered = true; await gate; return { original: true } as never
      })
      const reading = f.read(method, false)
      const settled = reading.catch(error => error)
      await vi.waitFor(() => expect(entered).toBe(true))
      f.runtime.invalidateWorkspaceScans()
      release()
      await expect(settled).resolves.toEqual({ original: true })
      expect(f.clients).toHaveLength(1)
      expect(f.clients[0].closed).toBe(false)
    } finally { release(); await f.runtime.disposeAsync() }
  }
)

test('task-owned cold lookup survives sidebar scans without creating a command pool entry', async () => {
  const f = fixture(), create = f.runtime.createClient
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  vi.spyOn(f.runtime, 'createClient').mockImplementation((...args) => {
    const client = create(...args), request = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (method, params, options) => {
      if (method === 'thread/workspace/lookup') { entered = true; await gate }
      return request(method, params, options)
    })
    return client
  })
  const reading = f.read('thread/workspace/lookup', false)
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    f.runtime.invalidateWorkspaceScans()
    expect(f.clients[0].closed).toBe(false)
    release()
    await expect(reading).resolves.toHaveProperty('completeness', 'complete')
    expect(f.clients[0].closed).toBe(true)
    expect(f.runtime.commandClientByServer.size).toBe(0)
  } finally { release(); await reading.catch(() => {}); await f.runtime.disposeAsync() }
})

test('task-owned borrowed lookup still honors caller cancellation without closing the shared connection', async () => {
  const f = fixture(), controller = new AbortController()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  try {
    await f.runtime.commandClient(f.server)
    vi.spyOn(f.clients[0], 'requestOnConnection').mockImplementationOnce(async () => {
      entered = true; await gate; return {} as never
    })
    const reading = f.runtime.withWorkspaceReadClient(f.server, client =>
      client.request('thread/workspace/lookup', { threadId: 'saved-thread' }, { signal: controller.signal }), undefined, false)
    const settled = reading.catch(error => error)
    await vi.waitFor(() => expect(entered).toBe(true))
    controller.abort()
    await expect(settled).resolves.toMatchObject({ name: 'AbortError' })
    expect(f.clients[0].closed).toBe(false)
    release()
    await expect(f.read()).resolves.not.toHaveProperty('late')
    expect(f.clients).toHaveLength(1)
  } finally { release(); await f.runtime.disposeAsync() }
})

test('continuous work observation borrows the existing workspace read entry and keeps each read fresh', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    const client = f.clients[0]
    vi.spyOn(client, 'supportsExperimental').mockImplementation(name =>
      ['continuousWorkReadV1', 'continuousWorkInputV1', 'continuousWorkControlV1'].includes(name))
    f.runtime.tasks.set('original-task', { serverId: f.server.id, workspacePath: f.server.workspacePath,
      ephemeral: false } as GatewayTask)
    expect(await readContinuousWorkCapabilities(f.runtime, { deviceId: f.server.id }))
      .toEqual({ status: 'ready', read: true, input: true, control: true })
    for (let index = 0; index < 2; index++) {
      expect(await readContinuousWorks(f.runtime, { deviceId: f.server.id, workspacePath: f.server.workspacePath }))
        .toMatchObject({ status: 'complete', items: [], pageCount: 1 })
    }
    expect(f.clients).toHaveLength(1)
    expect(client.boundRequests).toHaveBeenCalledTimes(2)
    expect(client.boundRequests.mock.calls.every(([id, method]) => id === 'original-connection' && method === 'work/list')).toBe(true)
    expect(client.closed).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test('work lists for another workspace retain an owned transient connection', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    await f.runtime.withWorkspaceReadClient(f.server, client => client.request('work/list', {}), '/another-workspace')
    expect(f.clients).toHaveLength(2)
    expect(f.clients[0].boundRequests).not.toHaveBeenCalled()
    expect(f.clients[0].closed).toBe(false)
    expect(f.clients[1].closed).toBe(true)
    expect(f.clients[1].requests.some(request => request.method === 'work/list')).toBe(true)
  } finally { await f.runtime.disposeAsync() }
})

test.each([true, false])('accepted removal retires only its cached workspace connection (root: %s)', async root => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  try {
    await f.runtime.commandClient(f.server)
    await f.runtime.commandClient(f.server, '/other-workspace')
    const client = f.clients[0], original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async <T>(method: string, params?, options?) =>
      method === 'runtime.workspaces.remove' ? { accepted: true } as T : original<T>(method, params, options))
    let signal: AbortSignal | undefined
    vi.spyOn(client, 'requestOnConnection').mockImplementationOnce(async (_id, _method, _params, options) => {
      signal = options?.signal; await gate; return { late: true } as never
    })
    const reading = f.read()
    const settled = reading.catch(error => error)
    await vi.waitFor(() => expect(signal).toBeDefined())
    const removed = root ? f.server.workspacePath! : '/other-workspace'
    await expect(f.runtime.request('runtime.workspaces.remove', { deviceId: f.server.id, workspacePath: removed }))
      .resolves.toMatchObject({ accepted: true })
    expect(signal!.aborted).toBe(true)
    await expect(settled).resolves.toMatchObject({ name: 'AbortError' })
    expect(f.clients[0].closed).toBe(root)
    expect(f.clients[1].closed).toBe(!root)
    expect([...f.runtime.commandClientByServer.keys()].some(key => key.endsWith(`\0${removed}`))).toBe(false)
    expect([...f.runtime.commandClientScopeByKey.keys()].some(key => key.endsWith(`\0${removed}`))).toBe(false)
    finish()
    await f.runtime.commandClient(f.server, removed)
    expect(f.clients).toHaveLength(3)
    expect(f.clients[2].closed).toBe(false)
    expect(vi.mocked(client.request).mock.calls.filter(([method]) => method === 'runtime.workspaces.remove')).toHaveLength(1)
  } finally { finish(); await f.runtime.disposeAsync() }
})

test.each(['refused', 'missing-receipt', 'unknown', 'missing-path'] as const)(
  'workspace removal keeps its existing connection when %s', async outcome => {
    const f = fixture()
    try {
      await f.runtime.commandClient(f.server)
      const client = f.clients[0], generation = f.runtime.workspaceScanGeneration
      vi.spyOn(client, 'request').mockImplementation(async () => {
        if (outcome === 'unknown') throw new Error('lost removal receipt')
        return (outcome === 'refused' ? { accepted: false } : outcome === 'missing-path' ? { accepted: true } : {}) as never
      })
      const mutation = f.runtime.request('runtime.workspaces.remove', {
        deviceId: f.server.id, ...(outcome === 'missing-path' ? {} : { workspacePath: f.server.workspacePath }),
      })
      if (outcome === 'unknown') await expect(mutation).rejects.toThrow('lost removal receipt')
      else await mutation
      expect(client.closed).toBe(false)
      expect(f.runtime.workspaceScanGeneration).toBe(generation)
      expect(client.request).toHaveBeenCalledTimes(1)
    } finally { await f.runtime.disposeAsync() }
  }
)

test('an accepted removal receipt does not wait for a retired workspace connection to finish opening', async () => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  await f.runtime.commandClient(f.server)
  vi.spyOn(f.clients[0], 'request').mockResolvedValue({ accepted: true })
  const create = f.runtime.createClient
  vi.spyOn(f.runtime, 'createClient').mockImplementation((...args) => {
    const client = create(...args) as RegistryClient
    client.connectGate = gate
    return client
  })
  const opening = f.runtime.commandClient(f.server, '/other-workspace')
  let mutation: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(f.clients).toHaveLength(2))
    let receipt: unknown
    mutation = f.runtime.request('runtime.workspaces.remove', { deviceId: f.server.id,
      workspacePath: '/other-workspace' }).then(result => { receipt = result })
    await vi.waitFor(() => expect(receipt).toMatchObject({ accepted: true }))
    expect(f.clients[0].closed).toBe(false)
    expect(f.clients[1].closed).toBe(false)
    finish()
    await opening
    await vi.waitFor(() => expect(f.clients[1].closed).toBe(true))
  } finally { finish(); await opening.catch(() => {}); await mutation; await f.runtime.disposeAsync() }
})

test('scan invalidation aborts a cold registry request before retiring its transport', async () => {
  const f = fixture()
  const create = f.runtime.createClient
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let signal: AbortSignal | undefined
  let dispatched = false
  vi.spyOn(f.runtime, 'createClient').mockImplementation((...args) => {
    const client = create(...args), original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async <T>(method: string, params?, options?) => {
      if (method !== 'runtime.workspaces.list') return original<T>(method, params, options)
      dispatched = true
      signal = options?.signal
      await gate
      return { late: true } as T
    })
    return client
  })
  try {
    const reading = f.read()
    const settled = reading.catch(error => error)
    await vi.waitFor(() => expect(dispatched).toBe(true))
    f.runtime.invalidateWorkspaceScans()
    expect(signal?.aborted).toBe(true)
    finish()
    await expect(settled).resolves.toMatchObject({ name: 'AbortError' })
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].closed).toBe(true)
  } finally { finish(); await f.runtime.disposeAsync() }
})

test('a cold registry read retains its transient lifetime and creates no command pool entry', async () => {
  const f = fixture()
  try {
    await f.read()
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].closed).toBe(true)
    expect(f.runtime.commandClientByServer.size).toBe(0)
  } finally { await f.runtime.disposeAsync() }
})

test('history hydration borrows the matching command channel but reads fresh on every scan', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    const workspaces = await f.runtime.workspaceDescriptors([f.server], f.server)
    f.clients[0].boundRequests.mockClear()
    await f.runtime.hydratePersistedTasks(workspaces)
    await f.runtime.hydratePersistedTasks(workspaces)
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].boundRequests.mock.calls.filter(([, method]) => method === 'thread/list')).toHaveLength(2)
    expect(f.clients[0].closed).toBe(false)
    expect(workspaces[0].threadsComplete).toBe(true)
  } finally { await f.runtime.disposeAsync() }
})

test('history for a different workspace retains its owned transient connection', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    const [root] = await f.runtime.workspaceDescriptors([f.server], f.server)
    f.clients[0].boundRequests.mockClear()
    await f.runtime.hydratePersistedTasks([{ ...root, workspacePath: '/different-workspace' }])
    expect(f.clients).toHaveLength(2)
    expect(f.clients[0].closed).toBe(false)
    expect(f.clients[1].closed).toBe(true)
    expect(f.clients[0].boundRequests).not.toHaveBeenCalled()
    expect(f.clients[1].requests.some(request => request.method === 'thread/list')).toBe(true)
    expect(f.clients[1].requests.some(request => ['thread/start', 'thread/resume'].includes(request.method))).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})

test('a history scan with no pinned request capability retains the transient path', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    const workspaces = await f.runtime.workspaceDescriptors([f.server], f.server)
    Object.defineProperty(f.clients[0], 'requestOnConnection', { value: undefined })
    await f.runtime.hydratePersistedTasks(workspaces)
    expect(f.clients).toHaveLength(2)
    expect(f.clients[0].closed).toBe(false)
    expect(f.clients[1].closed).toBe(true)
    expect(workspaces[0].threadsComplete).toBe(true)
  } finally { await f.runtime.disposeAsync() }
})

test('history and Goal status reads use the same pinned command connection without caching either result', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    const workspaces = await f.runtime.workspaceDescriptors([f.server], f.server)
    const client = f.clients[0], capabilities = client.supportsExperimental.bind(client)
    vi.spyOn(client, 'supportsExperimental').mockImplementation(capability =>
      capability === 'threadGoalStatusBatchV1' || capabilities(capability))
    client.persistedThreads = [{ id: 'persisted-history-thread', cwd: f.server.workspacePath }]
    const pinned = vi.spyOn(client, 'requestOnConnection')
    await f.runtime.hydratePersistedTasks(workspaces)
    await f.runtime.hydratePersistedTasks(workspaces)
    expect(f.clients).toHaveLength(1)
    for (const method of ['thread/list', 'thread/goal/status/readMany'])
      expect(pinned.mock.calls.filter(([, name]) => name === method)).toHaveLength(2)
    expect(new Set(pinned.mock.calls.map(([id]) => id))).toEqual(new Set(['original-connection']))
    expect([...f.runtime.tasks.values()].find(task => task.threadId === 'persisted-history-thread')?.goalStatusObservation)
      .toEqual({ availability: 'available', status: null })
  } finally { await f.runtime.disposeAsync() }
})

test('a command entry for a different profile is not borrowed', async () => {
  const f = fixture()
  try {
    await f.runtime.commandClient(f.server)
    f.server.profile = 'other-profile'
    await f.read()
    expect(f.clients).toHaveLength(2)
    expect(f.clients[0].boundRequests).not.toHaveBeenCalled()
    expect(f.clients[1].closed).toBe(true)
  } finally { await f.runtime.disposeAsync() }
})

test('invalidating a pending shared connect releases only the scan waiter', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const create = f.runtime.createClient
  vi.spyOn(f.runtime, 'createClient').mockImplementation((...args) => {
    const client = create(...args) as RegistryClient; client.connectGate = gate; return client
  })
  const command = f.runtime.commandClient(f.server)
  try {
    await vi.waitFor(() => expect(f.clients).toHaveLength(1))
    const reading = f.read()
    f.runtime.invalidateWorkspaceScans()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.clients[0].closed).toBe(false)
    release(); await command
    await f.read()
    expect(f.clients).toHaveLength(1)
  } finally { release(); await command.catch(() => {}); await f.runtime.disposeAsync() }
})

test.each(readMethods)('invalidating an in-flight %s aborts its RPC while the shared command stays usable', async method => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await f.runtime.commandClient(f.server)
    const client = f.clients[0], original = client.requestOnConnection
    let signal: AbortSignal | undefined
    vi.spyOn(client, 'requestOnConnection').mockImplementationOnce(async (_id, _method, _params, options) => {
      signal = options?.signal; await gate; return { late: true } as never
    })
    const reading = f.read(method)
    await vi.waitFor(() => expect(signal).toBeDefined())
    f.runtime.invalidateWorkspaceScans()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal!.aborted).toBe(true); expect(client.closed).toBe(false)
    release(); client.requestOnConnection = original
    await expect(f.read(method)).resolves.not.toHaveProperty('late')
    expect(f.clients).toHaveLength(1)
  } finally { release(); await f.runtime.disposeAsync() }
})

test.each(['account', 'profile', 'connection-generation', 'cache-owner', 'disconnect', 'restart'].flatMap(change =>
  readMethods.flatMap(method => (method === 'thread/list' || method === 'thread/workspace/lookup' || method === 'thread/goal/get' ? [true, false] : [true])
    .map(scanBound => ({ change, method, scanBound })))))(
  'a late $method reply is rejected after $change changes (scanBound: $scanBound)', async ({ change, method, scanBound }) => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    try {
      await f.runtime.commandClient(f.server)
      const client = f.clients[0]
      let entered = false
      vi.spyOn(client, 'requestOnConnection').mockImplementationOnce(async () => {
        entered = true; await gate; return { items: [{ workspacePath: '/old-account' }] } as never
      })
      const reading = f.read(method, scanBound)
      await vi.waitFor(() => expect(entered).toBe(true))
      if (change === 'account') notifyAccountContextChange(f.server.id)
      else if (change === 'profile') f.server.profile = 'changed'
      else if (change === 'connection-generation') client.diagnosticConnection.connectionId = 'replacement'
      else if (change === 'disconnect') f.runtime.appServerDisconnectedClients.add(client)
      else if (change === 'restart') vi.spyOn(f.runtime, 'isRestartingServer').mockReturnValue(true)
      else f.runtime.commandClientByServer.clear()
      release()
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    } finally { release(); await f.runtime.disposeAsync() }
  }
)

test.each([false, true].flatMap(warm => [false, true].flatMap(scanBound =>
  ['runtime.workspaces.register', 'thread/start', 'thread/resume', 'turn/start', 'work/control', 'work/read']
    .map(method => ({ warm, method, scanBound })))))(
  'workspace reads cannot dispatch $method (warm: $warm, scanBound: $scanBound)', async ({ warm, method, scanBound }) => {
  const f = fixture()
  try {
    if (warm) await f.runtime.commandClient(f.server)
    await expect(f.runtime.withWorkspaceReadClient(f.server, client =>
      client.request(method, {}), undefined, scanBound)).rejects.toThrow('only permits scoped reads')
    expect(f.clients[0].boundRequests).not.toHaveBeenCalled()
    expect(f.clients[0].requests.some(request => request.method === method)).toBe(false)
  } finally { await f.runtime.disposeAsync() }
})
