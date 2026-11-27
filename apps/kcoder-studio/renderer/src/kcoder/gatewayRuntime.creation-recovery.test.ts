import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { notifyAccountContextChange } from './accountContextEvents'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

const generatedWorkspace = '/home/test/Documents/KCoder/2026-11-13/minimal-task'
const threadId = 'ready-thread'
const requestId = 'original-create-request'
const messageId = 'original-first-message'

type ReceiptOptions = {
  creationReceipt?: unknown
  turnReceipt?: unknown
  creationCapability?: boolean
  registeredWorkspace?: boolean
  thread?: Record<string, unknown>
  creationReadGate?: Promise<void>
  onCreationRead?: () => void
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function makeFixture(RuntimeClass: typeof Runtime | typeof InstalledRuntime, options: ReceiptOptions = {}) {
  const server = localGatewayServer({ workspacePath: '/workspace' })
  const clients: Array<{ workspacePath?: string; client: FakeGatewayClient }> = []
  const persistedThread = {
    id: threadId,
    cwd: generatedWorkspace,
    status: 'idle',
    title: 'Original no-project task',
    ...options.thread,
  }
  const workspaceItems = options.registeredWorkspace
    ? [{
        workspacePath: generatedWorkspace,
        workspaceKind: 'workspace',
        label: 'minimal-task',
        projectName: 'minimal-task',
        projectKey: generatedWorkspace,
        projectRoots: [generatedWorkspace],
        projectActive: false,
        projectPinned: false,
        available: true,
      }]
    : []
  const runtime = new RuntimeClass('token', {
    loadServers: async () => [server],
    createClient: (_serverId, _token, _channel, workspacePath) => {
      const client = new FakeGatewayClient(threadId)
      client.threadResumeSupported = true
      client.workspaceItems = workspaceItems
      client.threadMessages = [{
        id: 'persisted-user-message',
        role: 'user',
        content: 'Original minimum message',
        timestampMs: 1_700_000_000_500,
      }]
      const originalRequest = client.request.bind(client)
      const supportsExperimental = client.supportsExperimental.bind(client)
      client.supportsExperimental = capability =>
        capability === 'threadCreationReceiptsV1'
          ? options.creationCapability !== false
          : supportsExperimental(capability)
      client.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (method === 'thread/creation/read') {
          client.requests.push({ method, params })
          options.onCreationRead?.()
          if (options.creationReadGate) await options.creationReadGate
          return { receipt: options.creationReceipt } as T
        }
        if (method === 'turn/receipt/read') {
          client.requests.push({ method, params })
          return { receipt: options.turnReceipt } as T
        }
        if (method === 'thread/list') {
          client.requests.push({ method, params })
          const threads = workspacePath === generatedWorkspace ? [persistedThread] : []
          return { threads, nextCursor: null } as T
        }
        return originalRequest<T>(method, params)
      }
      clients.push({ workspacePath, client })
      return client
    },
  })
  return { runtime, clients, server }
}

function readParams() {
  return {
    deviceId: 'local',
    workspacePath: generatedWorkspace,
    clientRequestId: requestId,
    clientMessageId: messageId,
  }
}

function canonicalAddress() {
  return {
    deviceId: 'local',
    taskId: `kcoder:local:${threadId}`,
    threadId,
    workspacePath: generatedWorkspace,
    runtimeHandle: { threadId, studioWorkMode: 'kcoder' },
  }
}

function readyCreationReceipt(thread: Record<string, unknown> = {}) {
  return {
    threadId,
    status: 'ready',
    thread: { id: threadId, cwd: generatedWorkspace, ...thread },
  }
}

function expectNoReplay(clients: Array<{ workspacePath?: string; client: FakeGatewayClient }>) {
  const methods = clients.flatMap(({ client }) => client.requests.map(request => request.method))
  expect(methods).not.toContain('thread/start')
  expect(methods).not.toContain('turn/start')
  expect(methods).not.toContain('thread/delete')
  expect(methods).not.toContain('thread/dispose')
  expect(methods).not.toContain('thread/metadata/update')
}

function expectExactOriginalThreadRead(
  clients: Array<{ workspacePath?: string; client: FakeGatewayClient }>
) {
  const generatedWorkspaceRequests = clients
    .filter(item => item.workspacePath === generatedWorkspace)
    .flatMap(item => item.client.requests)
  expect(generatedWorkspaceRequests).toContainEqual(expect.objectContaining({
    method: 'thread/read',
    params: expect.objectContaining({ threadId }),
  }))
  expect(clients.flatMap(({ client }) => client.requests.map(request => request.method)))
    .not.toContain('thread/list')
}

describe.each([
  ['Runtime', Runtime],
  ['InstalledRuntime', InstalledRuntime],
])('%s task creation receipt recovery', (_label, RuntimeClass) => {
  test.each([
    ['running', 'running'],
    ['completed', 'completed'],
    ['failed', 'execution_failed'],
    ['interrupted', 'interrupted'],
  ])('returns the original ready thread and initial %s receipt', async (receiptStatus, expectedStatus) => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      creationReceipt: {
        threadId,
        status: 'ready',
        thread: { id: threadId, cwd: generatedWorkspace },
      },
      turnReceipt: { threadId, turnId: 'initial-turn', status: receiptStatus },
    })
    try {
      await expect(runtime.request('runtime.tasks.creation.read', readParams())).resolves.toEqual({
        status: 'ready',
        address: canonicalAddress(),
        initialMessage: { status: expectedStatus, turnId: 'initial-turn' },
      })
      expect(clients.flatMap(({ client }) => client.requests)).toContainEqual({
        method: 'thread/creation/read',
        params: { clientRequestId: requestId },
      })
      expect(clients.flatMap(({ client }) => client.requests)).toContainEqual({
        method: 'turn/receipt/read',
        params: { threadId, clientMessageId: messageId },
      })
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test.each([
    ['missing creation receipt', null, 'unknown'],
    ['unknown creation receipt', { threadId, status: 'unknown' }, 'unknown'],
    ['missing initial turn receipt', {
      threadId,
      status: 'ready',
      thread: { id: threadId, cwd: generatedWorkspace },
    }, 'ready'],
  ])('%s never authorizes replay', async (_label, receipt, expectedStatus) => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      creationReceipt: receipt,
      turnReceipt: null,
    })
    try {
      const result = await runtime.request('runtime.tasks.creation.read', readParams()) as Record<string, unknown>
      expect(result.status).toBe(expectedStatus)
      if (expectedStatus === 'ready') expect(result.initialMessage).toEqual({ status: 'unknown' })
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('missing receipt capability is unavailable and performs no receipt request or replay', async () => {
    const { runtime, clients } = makeFixture(RuntimeClass, { creationCapability: false })
    try {
      await expect(runtime.request('runtime.tasks.creation.read', readParams())).resolves.toEqual({ status: 'unavailable' })
      expect(clients.flatMap(({ client }) => client.requests.map(request => request.method)))
        .not.toContain('thread/creation/read')
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects a ready receipt whose embedded thread id differs', async () => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      creationReceipt: {
        threadId,
        status: 'ready',
        thread: { id: 'different-thread', cwd: generatedWorkspace },
      },
    })
    try {
      await expect(runtime.request('runtime.tasks.creation.read', readParams())).resolves.toEqual({ status: 'unknown' })
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects a ready receipt from a different workspace', async () => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      creationReceipt: {
        threadId,
        status: 'ready',
        thread: { id: threadId, cwd: '/home/another-account/other-workspace' },
      },
    })
    try {
      await expect(runtime.request('runtime.tasks.creation.read', readParams()))
        .rejects.toThrow('Original task creation workspace does not match')
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test.each(['account', 'target'])('rejects a late receipt after %s scope changes', async scope => {
    const gate = deferred()
    const entered = deferred()
    const { runtime, clients, server } = makeFixture(RuntimeClass, {
      creationReceipt: {
        threadId,
        status: 'ready',
        thread: { id: threadId, cwd: generatedWorkspace },
      },
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
      creationReadGate: gate.promise,
      onCreationRead: entered.resolve,
    })
    try {
      const pending = runtime.request('runtime.tasks.creation.read', readParams())
      await entered.promise
      if (scope === 'account') notifyAccountContextChange('local')
      else server.host = 'changed-target.example'
      gate.resolve()
      await expect(pending).rejects.toThrow()
      expect(clients.flatMap(({ client }) => client.requests.map(request => request.method)))
        .not.toContain('turn/receipt/read')
      expectNoReplay(clients)
    } finally {
      gate.resolve()
      await runtime.dispose()
    }
  })

  test('projects KWorker mode and original agent/channel bindings into the recovered address', async () => {
    const owner = { accountId: 'account-1', targetId: 'local', workspaceId: null }
    const agentDefinition = {
      definition: { id: 'expert-1', version: '1', definitionSha256: 'a'.repeat(64) },
      owner,
      source: 'expert',
      title: 'Original expert',
    }
    const channelTaskSource = { channelId: 'channel-1', owner }
    const thread = {
      studioWorkMode: 'kworker',
      agentDefinition,
      channelTaskSource,
    }
    const { runtime, clients } = makeFixture(RuntimeClass, {
      thread,
      creationReceipt: readyCreationReceipt(thread),
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    })
    try {
      const result = await runtime.request('runtime.tasks.creation.read', readParams()) as {
        address: ReturnType<typeof canonicalAddress>
      }
      expect(result.address.runtimeHandle).toMatchObject({
        threadId,
        studioWorkMode: 'kworker',
        agentDefinition,
        channelTaskSource,
      })
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('projects the explicit model in the recovered address without consulting the global catalog', async () => {
    const thread = {
      modelSelectionMode: 'explicit',
      selectedModel: 'profile::explicit-model',
    }
    const { runtime, clients } = makeFixture(RuntimeClass, {
      thread,
      creationReceipt: readyCreationReceipt(thread),
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    })
    try {
      const result = await runtime.request('runtime.tasks.creation.read', readParams()) as {
        address: ReturnType<typeof canonicalAddress> & { runtimeHandle: Record<string, unknown> }
      }
      expect(result.address.runtimeHandle.modelSelection).toEqual({
        modelName: 'profile::explicit-model',
        modelType: null,
        options: {},
      })
      expect(clients.flatMap(({ client }) => client.requests.map(request => request.method)))
        .not.toContain('runtime.models.list')
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves follow_target_default as an empty model selection without consulting the global catalog', async () => {
    const thread = {
      model: 'stale-explicit-model',
      modelSelectionMode: 'follow_target_default',
    }
    const { runtime, clients } = makeFixture(RuntimeClass, {
      thread,
      creationReceipt: readyCreationReceipt(thread),
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    })
    try {
      const result = await runtime.request('runtime.tasks.creation.read', readParams()) as {
        address: ReturnType<typeof canonicalAddress> & { runtimeHandle: Record<string, unknown> }
      }
      expect(result.address.runtimeHandle.modelSelection).toEqual({
        modelName: '',
        modelType: null,
        options: {},
      })
      expect(clients.flatMap(({ client }) => client.requests.map(request => request.method)))
        .not.toContain('runtime.models.list')
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('does not replace an updated in-memory task with an older ready receipt', async () => {
    const options: ReceiptOptions = {
      creationReceipt: readyCreationReceipt({ title: 'Original receipt title' }),
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    }
    const { runtime, clients } = makeFixture(RuntimeClass, options)
    try {
      await expect(runtime.request('runtime.tasks.creation.read', readParams()))
        .resolves.toMatchObject({ status: 'ready' })
      const taskId = canonicalAddress().taskId
      const current = runtime.tasks.get(taskId)
      expect(current).toBeDefined()
      const updated = {
        ...current!,
        title: 'Newer in-memory title',
        studioWorkMode: 'kworker' as const,
        runtimeHandle: { ...current!.runtimeHandle, studioWorkMode: 'kworker', localUpdate: 'kept' },
      }
      runtime.tasks.set(taskId, updated)
      options.creationReceipt = readyCreationReceipt({
        title: 'Stale receipt title',
        studioWorkMode: 'kcoder',
      })

      const recovered = await runtime.request('runtime.tasks.creation.read', readParams()) as {
        address: ReturnType<typeof canonicalAddress>
      }
      expect(runtime.tasks.get(taskId)).toBe(updated)
      expect(runtime.tasks.get(taskId)?.title).toBe('Newer in-memory title')
      expect(recovered.address.runtimeHandle).toEqual(updated.runtimeHandle)
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('does not resurrect a thread with a deleted metadata marker', async () => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      creationReceipt: readyCreationReceipt(),
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    })
    try {
      const threadKey = runtime.threadKey('local', threadId)
      runtime.taskMetadata.set(threadKey, { deletedAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001 })

      await expect(runtime.request('runtime.tasks.creation.read', readParams()))
        .resolves.toEqual({ status: 'unknown' })
      expect(runtime.tasks.has(canonicalAddress().taskId)).toBe(false)
      expect(runtime.archivedTasks.has(canonicalAddress().taskId)).toBe(false)
      expect(runtime.taskByThread.has(threadKey)).toBe(false)
      expect(runtime.threadByTask.has(canonicalAddress().taskId)).toBe(false)
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('ready receipt opens the canonical address through existing hydration and reads its saved history', async () => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      registeredWorkspace: true,
      creationReceipt: {
        threadId,
        status: 'ready',
        thread: { id: threadId, cwd: generatedWorkspace },
      },
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    })
    try {
      const recovered = await runtime.request('runtime.tasks.creation.read', readParams()) as {
        status: string
        address: ReturnType<typeof canonicalAddress>
      }
      expect(recovered.status).toBe('ready')
      const transcript = await runtime.request('runtime.tasks.transcript', { address: recovered.address }) as {
        taskId: string
        workspacePath: string
        messages: Array<{ content: string }>
      }
      expect(transcript).toMatchObject({
        taskId: canonicalAddress().taskId,
        workspacePath: generatedWorkspace,
        messages: [expect.objectContaining({ content: 'Original minimum message' })],
      })
      expectExactOriginalThreadRead(clients)
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })

  test('a ready no-project receipt hydrates the original history from its exact generated workspace', async () => {
    const { runtime, clients } = makeFixture(RuntimeClass, {
      registeredWorkspace: false,
      creationReceipt: {
        threadId,
        status: 'ready',
        thread: { id: threadId, cwd: generatedWorkspace },
      },
      turnReceipt: { threadId, turnId: 'initial-turn', status: 'running' },
    })
    try {
      const recovered = await runtime.request('runtime.tasks.creation.read', readParams()) as {
        status: string
        address: ReturnType<typeof canonicalAddress>
      }
      expect(recovered.status).toBe('ready')
      const transcript = await runtime.request('runtime.tasks.transcript', { address: recovered.address }) as {
        taskId: string
        workspacePath: string
        messages: Array<{ content: string }>
      }
      expect(transcript).toMatchObject({
        taskId: canonicalAddress().taskId,
        workspacePath: generatedWorkspace,
        messages: [expect.objectContaining({ content: 'Original minimum message' })],
      })
      expectExactOriginalThreadRead(clients)
      expectNoReplay(clients)
    } finally {
      await runtime.dispose()
    }
  })
})
