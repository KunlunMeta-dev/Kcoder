import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime } from './installGatewayRuntime'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway history (%s)', (_entry, RuntimeConstructor) => {
  const runtimes = new Set<{ dispose(): void; disposeAsync?: () => Promise<void> }>()
  class KCoderGatewayRuntime extends RuntimeConstructor {
    constructor(...args: ConstructorParameters<typeof CoreRuntime>) {
      super(...args)
      runtimes.add(this)
    }
  }
  beforeEach(() => localStorage.clear())
  afterEach(async () => {
    await Promise.all([...runtimes].map(runtime => runtime.disposeAsync?.() ?? runtime.dispose()))
    runtimes.clear()
    clearMocks()
    vi.restoreAllMocks()
  })
  test('lists opened workspaces and hydrates their threads in the matching process cwd', async () => {
    const connections: Array<string | undefined> = []
    const command = new FakeGatewayClient(null)
    command.threadResumeSupported = true
    command.pinnedTaskIds = ['secondary-thread']
    command.workspaceItems = [
      {
        workspacePath: '/workspace/secondary',
        label: 'Secondary',
        projectKey: 'secondary-project',
        projectSource: 'legacy_root',
        projectPinned: true,
        projectActive: true,
      },
    ]
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: (_serverId, _token, _channel, workspacePath) => {
        connections.push(workspacePath)
        if (workspacePath === undefined) return command
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        if (workspacePath === '/workspace/secondary') {
          client.persistedThreads = [
            {
              id: 'secondary-thread',
              cwd: '/workspace/secondary',
              title: 'Secondary task',
              status: 'idle',
            },
          ]
        }
        return client
      },
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          workspacePath: '/workspace/secondary',
          label: 'Secondary',
          projectKey: 'secondary-project',
          projectSource: 'local_project',
          projectPinned: true,
          tasks: [
            expect.objectContaining({
              taskId: 'kcoder:local:secondary-thread',
              pinned: true,
              pinnedOrder: 0,
            }),
          ],
        }),
      ]),
    })
    expect(connections).toContain('/workspace')
    expect(connections).toContain('/workspace/secondary')
  })

  test('renames, archives, lists, and restores tasks with durable gateway metadata', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const client = new FakeGatewayClient('thread-metadata')
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'metadata-task',
      executionRequest: { prompt: 'first title' },
    })) as { taskId: string }
    client.emitNotification('turn/completed', {
      threadId: 'thread-metadata',
      turnId: 'thread-metadata-turn',
      turn: { id: 'thread-metadata-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    await expect(
      runtime.request('runtime.tasks.rename', {
        address: { taskId: created.taskId },
        title: 'Renamed task',
      })
    ).resolves.toMatchObject({ accepted: true, taskId: created.taskId })
    await expect(
      runtime.request('runtime.tasks.archive', { taskId: created.taskId })
    ).resolves.toMatchObject({ accepted: true, taskId: created.taskId })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [] }],
    })
    client.threadMessages = [
      {
        id: 'archived-answer',
        turnId: 'turn-1',
        role: 'assistant',
        content: 'The durable transcript contains a nebula-marker for later search.',
        timestampMs: 1700000000500,
      },
    ]
    await expect(
      runtime.request('runtime.tasks.search', {
        query: 'nebula-marker',
        limit: 20,
        includeArchived: true,
      })
    ).resolves.toMatchObject({
      items: [
        {
          title: 'Renamed task',
          archived: true,
          snippet: expect.stringContaining('nebula-marker'),
        },
      ],
    })
    await expect(
      runtime.request('runtime.archived_conversations.cleanup_preview', {
        items: [{ taskId: created.taskId, workspacePath: '/workspace', deviceId: 'local' }],
      })
    ).resolves.toMatchObject({
      success: true,
      deleted: false,
      taskCount: 1,
      targetCount: 0,
      results: [{ taskId: created.taskId, workspacePath: '/workspace' }],
    })
    await expect(runtime.request('runtime.archived_conversations.list', {})).resolves.toMatchObject(
      {
        items: [
          {
            taskId: created.taskId,
            threadId: 'thread-metadata',
            title: 'Renamed task',
            deviceId: 'local',
            source: 'local',
          },
        ],
        projectGroups: [{ projectKey: 'runtime-target:local', count: 1 }],
        total: 1,
      }
    )
    await expect(
      runtime.request('runtime.archived_conversations.unarchive', {
        taskId: created.taskId,
        workspacePath: '/workspace',
        deviceId: 'local',
      })
    ).resolves.toMatchObject({ accepted: true, taskId: created.taskId })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: created.taskId, title: 'Renamed task' }] }],
    })
    await runtime.request('runtime.tasks.archive', { taskId: created.taskId })
    await expect(
      runtime.request('runtime.archived_conversations.delete', {
        taskId: created.taskId,
        workspacePath: '/workspace',
        deviceId: 'local',
      })
    ).resolves.toMatchObject({ accepted: true, taskId: created.taskId })
    expect(client.requests).toContainEqual({
      method: 'thread/delete',
      params: { threadId: 'thread-metadata' },
    })
    await expect(runtime.request('runtime.archived_conversations.list', {})).resolves.toMatchObject(
      { items: [], total: 0 }
    )
  })

  test('restores renamed and archived tasks from app-server metadata without local storage', async () => {
    const persistedThreads: Array<Record<string, unknown>> = [
      {
        id: 'server-metadata-thread',
        cwd: '/workspace',
        title: '服务端原始标题',
        model: 'server-model',
        status: 'idle',
        createdAt: '1700000000000',
        updatedAt: '1700000001000',
      },
    ]
    const options = {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient('unused')
        client.threadResumeSupported = true
        client.persistedThreads = persistedThreads
        return client
      },
    }

    const runtime = new KCoderGatewayRuntime('token', options)
    await runtime.request('runtime.tasks.list', {})
    await runtime.request('runtime.tasks.rename', {
      taskId: 'kcoder:local:server-metadata-thread',
      title: '只保存在服务端的新标题',
    })
    await runtime.request('runtime.tasks.archive', {
      taskId: 'kcoder:local:server-metadata-thread',
    })
    expect(persistedThreads[0]).toMatchObject({
      title: '只保存在服务端的新标题',
      archivedAt: expect.any(String),
    })

    localStorage.clear()
    const reloaded = new KCoderGatewayRuntime('token', options)
    await expect(reloaded.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [] }],
    })
    await expect(
      reloaded.request('runtime.archived_conversations.list', {})
    ).resolves.toMatchObject({
      items: [
        {
          taskId: 'kcoder:local:server-metadata-thread',
          title: '只保存在服务端的新标题',
        },
      ],
    })
    await reloaded.request('runtime.archived_conversations.unarchive', {
      taskId: 'kcoder:local:server-metadata-thread',
    })
    expect(persistedThreads[0]).not.toHaveProperty('archivedAt')

    localStorage.clear()
    const restored = new KCoderGatewayRuntime('token', options)
    await expect(restored.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        {
          tasks: [
            {
              taskId: 'kcoder:local:server-metadata-thread',
              title: '只保存在服务端的新标题',
              model: 'server-model',
              modelSelection: {
                modelName: 'server-model',
                modelType: null,
                options: {},
              },
            },
          ],
        },
      ],
    })
  })

  test('treats explicit server metadata nulls as authoritative over stale local fields', async () => {
    localStorage.setItem(
      'kcoder-studio:task-metadata-v1',
      JSON.stringify({
        'local\u0000cleared-thread': {
          title: '不应复活的本地标题',
          model: 'stale-model',
          archivedAt: Date.now(),
          parent: { taskId: 'old', threadId: 'old', lastTurnId: 'old' },
          updatedAt: Date.now(),
        },
      })
    )
    const client = new FakeGatewayClient('unused')
    client.threadResumeSupported = true
    client.persistedThreads = [
      {
        id: 'cleared-thread',
        cwd: '/workspace',
        title: '不应复活的旧顶层标题',
        model: 'old-top-level-model',
        archivedAt: new Date().toISOString(),
        parent: { taskId: 'old', threadId: 'old', lastTurnId: 'old' },
        status: 'idle',
        metadata: {
          schema: 'kcoder.thread-metadata',
          version: 1,
          revision: 4,
          title: null,
          model: null,
          archivedAt: null,
          parent: null,
        },
      },
    ]
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        {
          tasks: [
            {
              taskId: 'kcoder:local:cleared-thread',
              title: 'KCoder 会话 cleared-',
            },
          ],
        },
      ],
    })
    const listed = (await runtime.request('runtime.tasks.list', {})) as {
      workspaces: Array<{ tasks: Array<Record<string, unknown>> }>
    }
    expect(listed.workspaces[0].tasks[0]).not.toHaveProperty('model')
    expect(listed.workspaces[0].tasks[0]).not.toHaveProperty('parent')
    await expect(runtime.request('runtime.archived_conversations.list', {})).resolves.toMatchObject(
      {
        total: 0,
      }
    )
  })

  test('deletes an archived thread through an app-server bound to its task workspace', async () => {
    const connections: Array<{ workspacePath: string | undefined; client: FakeGatewayClient }> = []
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: (_serverId, _token, _channel, workspacePath) => {
        const client = new FakeGatewayClient('secondary-thread')
        connections.push({ workspacePath, client })
        return client
      },
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'secondary-task',
      workspacePath: '/workspace/secondary',
      executionRequest: { prompt: 'secondary workspace' },
    })) as { taskId: string }
    connections[0].client.emitNotification('turn/completed', {
      threadId: 'secondary-thread',
      turnId: 'secondary-thread-turn',
      turn: { id: 'secondary-thread-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime.request('runtime.tasks.archive', { taskId: created.taskId })
    await runtime.request('runtime.archived_conversations.delete', { taskId: created.taskId })

    expect(
      connections.find(({ client }) =>
        client.requests.some(request => request.method === 'thread/delete')
      )?.workspacePath
    ).toBe('/workspace/secondary')
    expect(
      connections.some(({ client }) =>
        client.requests.some(request => request.method === 'runtime.worktrees.conversations.remove')
      )
    ).toBe(false)
  })

  test('retries the canonical transcript while a new thread history file becomes visible', async () => {
    const client = new FakeGatewayClient('new-thread')
    client.threadResumeSupported = true
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'optimistic-task',
      workspacePath: '/workspace',
      executionRequest: { prompt: 'first prompt' },
    })) as { taskId: string }
    client.threadReadFailures = 2

    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: created.taskId,
        threadId: 'new-thread',
        deviceId: 'local',
      })
    ).resolves.toMatchObject({
      taskId: 'kcoder:local:new-thread',
      messages: [{ content: '之前的问题' }],
    })
    expect(client.requests.filter(request => request.method === 'thread/read')).toHaveLength(3)

    client.threadReadFailures = 1
    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: created.taskId,
        threadId: 'new-thread',
        deviceId: 'local',
      })
    ).rejects.toThrow('persisted thread not found')
    expect(client.requests.filter(request => request.method === 'thread/read')).toHaveLength(4)
  })

  test('keeps a running task routable while thread/list persistence catches up', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('new-thread')
    client.threadResumeSupported = true
    let connectionCount = 0
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        if (connectionCount++ === 0) return client
        const transient = new FakeGatewayClient('new-thread')
        transient.threadResumeSupported = true
        transient.persistedThreads = client.persistedThreads
        transient.threadMessages = client.threadMessages
        return transient
      },
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'optimistic-task',
      workspacePath: '/workspace',
      executionRequest: { prompt: 'first prompt' },
    })) as { taskId: string }
    await runtime.request('runtime.tasks.transcript', {
      taskId: created.taskId,
      threadId: 'new-thread',
      deviceId: 'local',
    })

    client.persistedThreads = []
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:new-thread' }] }],
    })
    client.emitNotification('item/delta', {
      threadId: 'new-thread',
      turnId: 'new-thread-turn',
      itemId: 'item-1',
      delta: { text: 'still routed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(received).toContainEqual({
      event: 'response.output_text.delta',
      payload: expect.objectContaining({ taskId: 'kcoder:local:new-thread' }),
    })

    client.emitNotification('turn/completed', {
      threadId: 'new-thread',
      turnId: 'new-thread-turn',
      turn: { id: 'new-thread-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:new-thread' }] }],
    })
    client.persistedThreads = [{ id: 'new-thread', cwd: '/workspace', status: 'idle' }]
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:new-thread' }] }],
    })
    client.persistedThreads = []
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:new-thread' }] }],
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [] }],
    })
    unlisten()
    runtime.dispose()
  })

  test('treats a leased KCoder history thread as idle and removes it after two list misses', async () => {
    const client = new FakeGatewayClient(null)
    client.threadResumeSupported = true
    client.persistedThreads = [{ id: 'stale-thread', cwd: '/workspace', status: 'running' }]
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        { tasks: [{ taskId: 'kcoder:local:stale-thread', running: _entry === 'shared' }] },
      ],
    })
    client.persistedThreads = []
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:stale-thread' }] }],
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [] }],
    })
    runtime.dispose()
  })

  test('keeps a resumed KCoder history visibly running only while its local turn is active', async () => {
    const client = new FakeGatewayClient('resumed-thread')
    client.threadResumeSupported = true
    client.persistedThreads = [
      { id: 'resumed-thread', cwd: '/workspace', title: '恢复任务', status: 'running' },
    ]
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        { tasks: [{ taskId: 'kcoder:local:resumed-thread', running: _entry === 'shared' }] },
      ],
    })
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:resumed-thread',
      message: '继续执行',
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:resumed-thread', running: true }] }],
    })
    client.emitNotification('turn/completed', {
      threadId: 'resumed-thread',
      turnId: 'resumed-thread-turn',
      turn: { id: 'resumed-thread-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        { tasks: [{ taskId: 'kcoder:local:resumed-thread', running: _entry === 'shared' }] },
      ],
    })
    runtime.dispose()
  })

  test('archives project and all tasks, then bulk deletes archived histories', async () => {
    const clients: FakeGatewayClient[] = []
    const persistedThreads = [
      {
        id: 'archive-one',
        cwd: '/workspace/one',
        title: 'One',
        status: 'idle',
        createdAt: '1700000000000',
        updatedAt: '1700000001000',
      },
      {
        id: 'archive-two',
        cwd: '/workspace/two',
        title: 'Two',
        status: 'idle',
        createdAt: '1700000002000',
        updatedAt: '1700000003000',
      },
    ]
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient('unused')
        client.threadResumeSupported = true
        client.persistedThreads = persistedThreads
        clients.push(client)
        return client
      },
    })

    await expect(
      runtime.request('runtime.archived_conversations.archive_project', {
        runtimeProjectKey: 'kcoder:local',
        workspacePath: '/workspace/one',
      })
    ).resolves.toMatchObject({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
    })
    await expect(
      runtime.request('runtime.archived_conversations.archive_all', {})
    ).resolves.toMatchObject({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
    })
    const archived = (await runtime.request('runtime.archived_conversations.list', {})) as {
      items: Array<Record<string, unknown>>
      total: number
    }
    expect(archived.total).toBe(2)
    const deleted = await runtime.request('runtime.archived_conversations.delete_bulk', {
      items: archived.items.map(item => ({
        taskId: item.taskId,
        workspacePath: item.workspacePath,
        deviceId: item.deviceId,
      })),
    })
    expect(deleted).toMatchObject({
      accepted: true,
      requestedCount: 2,
      acceptedCount: 2,
      deletedCount: 2,
      results: [
        { accepted: true, deleted: true },
        { accepted: true, deleted: true },
      ],
    })
    expect(
      clients
        .flatMap(client => client.requests)
        .filter(request => request.method === 'thread/delete')
    ).toHaveLength(2)
  })

  test('hydrates every persisted-task page instead of deleting tasks after the first 100', async () => {
    const client = new FakeGatewayClient('unused')
    client.threadResumeSupported = true
    client.persistedThreads = Array.from({ length: 205 }, (_, index) => ({
      id: `persisted-${index}`,
      cwd: '/workspace',
      title: `历史任务 ${index}`,
      status: 'idle',
      createdAt: String(1_700_000_000_000 + index),
      updatedAt: String(1_700_000_000_000 + index),
    }))
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })

    const result = (await runtime.request('runtime.tasks.list', {})) as {
      workspaces: Array<{ tasks: Array<{ taskId: string }> }>
    }
    expect(result.workspaces[0].tasks).toHaveLength(205)
    expect(result.workspaces[0].tasks.at(-1)?.taskId).toBe('kcoder:local:persisted-204')
    expect(client.requests.filter(request => request.method === 'thread/list')).toEqual([
      { method: 'thread/list', params: { limit: 100 } },
      { method: 'thread/list', params: { limit: 100, cursor: '100' } },
      { method: 'thread/list', params: { limit: 100, cursor: '200' } },
    ])
  })

  test('uses the same public task address before and after persisted hydration', async () => {
    const liveClient = new FakeGatewayClient('stable-thread')
    const live = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => liveClient,
    })
    await expect(
      live.request('runtime.tasks.create', {
        taskId: 'renderer-draft-id',
        executionRequest: { prompt: 'stable task' },
      })
    ).resolves.toMatchObject({ taskId: 'kcoder:local:stable-thread' })

    const persistedClient = new FakeGatewayClient('unused')
    persistedClient.threadResumeSupported = true
    persistedClient.persistedThreads = [
      {
        id: 'stable-thread',
        cwd: '/workspace',
        title: 'stable task',
        status: 'idle',
      },
    ]
    const reloaded = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => persistedClient,
    })
    await expect(reloaded.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:stable-thread' }] }],
    })
  })

  test('hydrates 32 configured targets without retaining 32 command connections', async () => {
    let active = 0
    let maxActive = 0
    const clients: FakeGatewayClient[] = []
    const servers = Array.from({ length: 32 }, (_, index) => ({
      id: `server-${index}`,
      label: `服务器 ${index}`,
      description: 'SSH',
      transport: 'ssh' as const,
      host: `server-${index}`,
      workspacePath: `/workspace/${index}`,
    }))
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => servers,
      createClient: () => {
        const client = new FakeGatewayClient('unused')
        client.threadResumeSupported = true
        client.connect = async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
        }
        client.close = () => {
          if (!client.closed) active -= 1
          client.closed = true
        }
        clients.push(client)
        return client
      },
    })

    await runtime.request('runtime.tasks.list', {})
    expect(clients).toHaveLength(64)
    expect(maxActive).toBe(4)
    expect(active).toBe(0)
    expect(clients.every(client => client.closed)).toBe(true)
  })
})
