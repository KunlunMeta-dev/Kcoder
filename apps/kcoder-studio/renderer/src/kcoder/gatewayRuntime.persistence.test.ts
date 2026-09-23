import { listen } from '@tauri-apps/api/event'
import { describe, expect, test } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('KCoder gateway runtime task isolation', () => {
  test('durably links a newly created Web task to its managed worktree', async () => {
    const workspacePath = '/workspace/.managed/web-task'
    const worktreeItems: Array<Record<string, unknown>> = [
      {
        path: workspacePath,
        sourcePath: '/workspace',
        state: 'active',
        revision: 1,
        conversations: [],
      },
    ]
    const clients: FakeGatewayClient[] = []
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          runtime: 'kcoder' as const,
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient('web-managed-thread')
        client.worktreeItems = worktreeItems
        clients.push(client)
        return client
      },
    })

    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'web-managed-task',
      workspacePath,
      executionRequest: { prompt: '在隔离工作树中修改' },
    })) as { taskId: string }

    expect(worktreeItems[0].conversations).toEqual([
      expect.objectContaining({
        taskId: created.taskId,
        threadId: 'web-managed-thread',
        workspacePath,
      }),
    ])
    expect(
      clients.some(client =>
        client.requests.some(
          request =>
            request.method === 'runtime.worktrees.conversations.link' &&
            request.params.path === workspacePath
        )
      )
    ).toBe(true)

    await runtime.request('runtime.worktrees.archive', {
      deviceId: 'local',
      path: workspacePath,
      expectedRevision: 1,
      expectedContentToken: 'token',
      riskAccepted: false,
    })
    expect(
      clients.some(client =>
        client.requests.some(
          request =>
            request.method === 'runtime.worktrees.archive' &&
            Array.isArray(request.params.archivedConversations) &&
            request.params.archivedConversations.some(
              conversation =>
                typeof conversation === 'object' &&
                conversation !== null &&
                (conversation as Record<string, unknown>).taskId === created.taskId
            )
        )
      )
    ).toBe(true)
  })

  test('fails closed and deletes the empty thread when worktree linking fails', async () => {
    const workspacePath = '/workspace/.managed/link-failure'
    const taskClient = new FakeGatewayClient('unlinked-thread')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          runtime: 'kcoder' as const,
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: (_serverId, _token, _channel, requestedWorkspacePath) => {
        if (requestedWorkspacePath === workspacePath) return taskClient
        const registryClient = new FakeGatewayClient(null)
        registryClient.worktreeItems = [
          {
            path: workspacePath,
            sourcePath: '/workspace',
            state: 'active',
            revision: 1,
            conversations: [],
          },
        ]
        const request = registryClient.request.bind(registryClient)
        registryClient.request = async <T>(
          method: string,
          params: Record<string, unknown> = {}
        ) => {
          if (method === 'runtime.worktrees.conversations.link') {
            throw new Error('registry write failed')
          }
          return request<T>(method, params)
        }
        return registryClient
      },
    })

    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'unlinked-task',
        workspacePath,
        executionRequest: { prompt: '不能留下孤立会话' },
      })
    ).rejects.toThrow('registry write failed')
    expect(taskClient.requests).toContainEqual({
      method: 'thread/delete',
      params: { threadId: 'unlinked-thread' },
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: expect.not.arrayContaining([
        expect.objectContaining({
          tasks: expect.arrayContaining([
            expect.objectContaining({ taskId: 'kcoder:local:unlinked-thread' }),
          ]),
        }),
      ]),
    })
  })

  test('preserves an empty cancelled assistant outcome from durable history', async () => {
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          runtime: 'kcoder' as const,
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        client.persistedThreads = [
          {
            id: 'cancelled-thread',
            cwd: '/workspace',
            title: '停止的任务',
            status: 'idle',
            createdAt: '1700000000000',
            updatedAt: '1700000001000',
          },
        ]
        client.threadMessages = [
          {
            id: 'user-message',
            turnId: 'turn-1',
            role: 'user',
            content: '请生成长回答',
            timestampMs: 1700000000500,
          },
          {
            id: 'cancelled-message',
            turnId: 'turn-1',
            role: 'assistant',
            content: '',
            status: 'cancelled',
            timestampMs: 1700000000600,
          },
        ]
        return client
      },
    })

    await runtime.request('runtime.tasks.list', {})
    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: 'kcoder:local:cancelled-thread',
        threadId: 'cancelled-thread',
        deviceId: 'local',
        limit: 50,
      })
    ).resolves.toMatchObject({
      messages: [
        { id: 'user-message', role: 'user', status: 'done' },
        {
          id: 'cancelled-message',
          role: 'assistant',
          content: '',
          status: 'cancelled',
        },
      ],
    })
  })

  test.each([false, true])('keeps three transcript pages ordered, indexed=%s', async indexed => {
    const taskClient = new FakeGatewayClient('codex-paged-thread')
    const transcriptClient = new FakeGatewayClient(null)
    transcriptClient.threadResumeSupported = true
    transcriptClient.indexedPagesSupported = indexed
    let createdClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'codex-local',
          label: 'Codex Local',
          description: 'Codex',
          runtime: 'kcoder' as const,
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: () => (createdClients++ === 0 ? taskClient : transcriptClient),
    })

    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'codex-paged-draft',
      executionRequest: { prompt: 'create paged thread' },
    })) as { taskId: string }
    const taskId = created.taskId
    expect(taskId).toBe('kcoder:codex-local:codex-paged-thread')
    taskClient.emitNotification('turn/completed', {
      threadId: 'codex-paged-thread',
      turnId: 'codex-paged-thread-turn',
      turn: { id: 'codex-paged-thread-turn', status: 'completed' },
    })
    transcriptClient.threadReadPages = [
      {
        messages: [
          {
            id: 'newest',
            turnId: 'turn-3',
            role: 'assistant',
            content: 'newest',
            blocks: [],
            timestampMs: 3,
          },
        ],
        rangeStart: 999_999_999,
        rangeEnd: 1_000_000_000,
        hasMoreBefore: true,
        beforeCursor: 'codex-history-v1:page-2',
      },
      {
        messages: [
          {
            id: 'middle',
            turnId: 'turn-2',
            role: 'assistant',
            content: 'middle',
            blocks: [],
            timestampMs: 2,
          },
        ],
        rangeStart: 999_999_998,
        rangeEnd: 999_999_999,
        hasMoreBefore: true,
        beforeCursor: 'codex-history-v1:page-3',
      },
      {
        messages: [
          {
            id: 'oldest',
            turnId: 'turn-1',
            role: 'assistant',
            content: 'oldest',
            blocks: [],
            timestampMs: 1,
          },
        ],
        rangeStart: 999_999_997,
        rangeEnd: 999_999_998,
        hasMoreBefore: false,
        beforeCursor: null,
      },
    ]
    const pages = []
    let beforeCursor: string | null = null
    for (let index = 0; index < 3; index += 1) {
      const page = (await runtime.request('runtime.tasks.transcript', {
        taskId,
        deviceId: 'codex-local',
        threadId: 'codex-paged-thread',
        ...(beforeCursor ? { beforeCursor } : {}),
      })) as {
        messages: Array<{ messageIndex: number; subtaskId: string; content: string }>
        beforeCursor: string | null
      }
      pages.push(page)
      beforeCursor = page.beforeCursor
    }

    const chronological = pages.toReversed().flatMap(page => page.messages)
    expect(chronological.map(message => message.content)).toEqual(['oldest', 'middle', 'newest'])
    expect(chronological.map(message => message.messageIndex)).toEqual([
      999_999_997, 999_999_998, 999_999_999,
    ])
    expect(new Set(chronological.map(message => message.subtaskId)).size).toBe(3)
    expect(transcriptClient.requests.filter(request => request.method === (indexed ? 'thread/read/indexed' : 'thread/read'))).toHaveLength(3)
    runtime.dispose()
  })

  test('renames, archives, lists, and restores tasks with durable gateway metadata', async () => {
    const client = new FakeGatewayClient('thread-metadata')
    const runtime = createTestGatewayRuntime('token', {
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
      runtimeProjectKey: 'project:alpha',
      runtimeProjectName: 'Alpha project',
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
            projectKey: 'project:alpha',
            projectName: 'Alpha project',
          },
        ],
        projectGroups: [{ projectKey: 'project:alpha', projectName: 'Alpha project', count: 1 }],
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

    const runtime = createTestGatewayRuntime('token', options)
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
    const reloaded = createTestGatewayRuntime('token', options)
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
    const restored = createTestGatewayRuntime('token', options)
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

  test('discovers archived tasks from restorable worktrees and restores them on demand', async () => {
    const workspacePath = '/workspace/.managed/task-1'
    const taskId = 'kcoder:local:managed-archived-thread'
    const worktreeItems: Array<Record<string, unknown>> = [
      {
        path: workspacePath,
        state: 'restorable',
        revision: 3,
        conversations: [
          {
            deviceId: 'local',
            taskId,
            threadId: 'managed-archived-thread',
            workspacePath,
            title: 'Archived managed task',
            model: 'server-model',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_001_000,
          },
        ],
      },
    ]
    const clients: Array<{ workspacePath?: string; client: FakeGatewayClient }> = []
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: (_serverId, _token, _channel, requestedWorkspacePath) => {
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        client.worktreeItems = worktreeItems
        clients.push({ workspacePath: requestedWorkspacePath, client })
        return client
      },
    })

    await expect(runtime.request('runtime.archived_conversations.list', {})).resolves.toMatchObject(
      {
        items: [
          {
            taskId,
            workspacePath,
            title: 'Archived managed task',
          },
        ],
        total: 1,
      }
    )
    await runtime.request('runtime.worktrees.delete', {
      deviceId: 'local',
      path: workspacePath,
      preserveSnapshot: true,
    })
    expect(
      clients.some(({ client }) =>
        client.requests.some(
          request =>
            request.method === 'runtime.worktrees.delete' &&
            Array.isArray(request.params.archivedConversations) &&
            request.params.archivedConversations.some(
              conversation =>
                typeof conversation === 'object' &&
                conversation !== null &&
                (conversation as Record<string, unknown>).taskId === taskId
            )
        )
      )
    ).toBe(true)

    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId,
        threadId: 'managed-archived-thread',
        deviceId: 'local',
      })
    ).resolves.toMatchObject({
      taskId,
      messages: [{ content: '之前的问题' }],
    })
    expect(worktreeItems[0].state).toBe('active')
    expect(
      clients.some(({ client }) =>
        client.requests.some(request => request.method === 'runtime.worktrees.restore')
      )
    ).toBe(true)

    await expect(
      runtime.request('runtime.archived_conversations.delete', { taskId, workspacePath })
    ).resolves.toMatchObject({ accepted: true, deleted: true, taskId })
    expect(worktreeItems[0].conversations).toEqual([])
    expect(
      clients.some(
        ({ workspacePath: requestedWorkspace, client }) =>
          requestedWorkspace === workspacePath &&
          client.requests.some(request => request.method === 'thread/delete')
      )
    ).toBe(true)
  })

  test('serializes archived deletion with persisted hydration for the same worktree', async () => {
    const workspacePath = '/workspace/managed/task-1'
    const taskId = 'kcoder:local:managed-thread'
    const deleteStarted = deferred()
    const releaseDelete = deferred()
    const events: string[] = []
    const worktreeItems = [
      {
        path: workspacePath,
        state: 'restorable',
        revision: 3,
        worktreeId: 'managed-task-1',
        repositoryName: 'workspace',
        conversations: [
          {
            taskId,
            threadId: 'managed-thread',
            workspacePath,
            title: 'Managed task',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_001_000,
          },
        ],
      },
    ]
    const workspaceClients: FakeGatewayClient[] = []
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: (_serverId, _token, _channel, requestedWorkspacePath) => {
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        client.worktreeItems = worktreeItems
        if (requestedWorkspacePath === workspacePath) {
          workspaceClients.push(client)
          const originalRequest = client.request.bind(client)
          client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
            if (method === 'thread/delete') {
              events.push('delete-started')
              deleteStarted.resolve()
              await releaseDelete.promise
              events.push('delete-released')
            } else if (method === 'thread/list') {
              events.push('hydrate-started')
            }
            return originalRequest<T>(method, params)
          }
        }
        return client
      },
    })

    await expect(runtime.request('runtime.archived_conversations.list', {})).resolves.toMatchObject(
      {
        items: [{ taskId, workspacePath }],
        total: 1,
      }
    )

    const deleting = runtime.request('runtime.archived_conversations.delete', {
      taskId,
      workspacePath,
    })
    await deleteStarted.promise
    const hydrating = runtime.request('runtime.tasks.list', {})
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(workspaceClients).toHaveLength(1)
    expect(events).toEqual(['delete-started'])

    releaseDelete.resolve()
    await expect(deleting).resolves.toMatchObject({ accepted: true, deleted: true, taskId })
    await expect(hydrating).resolves.toMatchObject({ workspaces: expect.any(Array) })
    expect(workspaceClients).toHaveLength(2)
    expect(events).toEqual(['delete-started', 'delete-released', 'hydrate-started'])
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
    const runtime = createTestGatewayRuntime('token', {
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
    const runtime = createTestGatewayRuntime('token', {
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
    const runtime = createTestGatewayRuntime('token', {
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
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('new-thread')
    client.threadResumeSupported = true
    let connectionCount = 0
    const runtime = createTestGatewayRuntime('token', {
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

  test('removes a stale hydrated running task after two complete thread-list misses', async () => {
    const client = new FakeGatewayClient(null)
    client.threadResumeSupported = true
    client.persistedThreads = [{ id: 'stale-thread', cwd: '/workspace', status: 'running' }]
    const runtime = createTestGatewayRuntime('token', {
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
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:stale-thread', running: true }] }],
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

  test('hydrates persisted app-server threads and resumes one before a follow-up', async () => {
    const clients: FakeGatewayClient[] = []
    const runtime = createTestGatewayRuntime('token', {
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
        const client = new FakeGatewayClient('unused')
        client.threadResumeSupported = true
        if (workspacePath === '/workspace') {
          client.persistedThreads = [
            {
              id: 'persisted-thread',
              cwd: '/workspace',
              title: '恢复后的任务',
              model: 'persisted-model',
              status: 'idle',
              createdAt: '1700000000000',
              updatedAt: '1700000001000',
            },
          ]
        }
        clients.push(client)
        return client
      },
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        {
          projectKey: 'runtime-target:local',
          tasks: [
            {
              taskId: 'kcoder:local:persisted-thread',
              threadId: 'persisted-thread',
              title: '恢复后的任务',
              workspacePath: '/workspace',
              running: false,
            },
          ],
        },
      ],
    })
    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: 'kcoder:local:persisted-thread',
        threadId: 'persisted-thread',
        deviceId: 'local',
        limit: 50,
      })
    ).resolves.toMatchObject({
      taskId: 'kcoder:local:persisted-thread',
      workspacePath: '/workspace',
      messages: [
        {
          id: 'history-message-1',
          turnId: 'turn-1',
          role: 'user',
          content: '之前的问题',
          blocks: [expect.objectContaining({ id: 'thinking-1', type: 'thinking', status: 'done' })],
          messageIndex: 0,
          status: 'done',
        },
      ],
      rangeStart: 0,
      rangeEnd: 1,
      hasMoreBefore: false,
    })
    await runtime.request('runtime.tasks.send', {
      address: {
        deviceId: 'local',
        taskId: 'kcoder:local:persisted-thread',
        threadId: 'persisted-thread',
        workspacePath: '/workspace',
      },
      message: '继续这个任务',
    })
    expect(clients).toHaveLength(4)
    expect(clients[2].requests).toContainEqual({
      method: 'thread/read',
      params: { threadId: 'persisted-thread', limit: 50 },
    })
    expect(
      clients[3].requests.filter(request => request.method !== 'runtime.context.get').slice(0, 3)
    ).toEqual([
      { method: 'thread/resume', params: { threadId: 'persisted-thread' } },
      { method: 'agent/list', params: { threadId: 'persisted-thread' } },
      {
        method: 'turn/start',
        params: {
          threadId: 'persisted-thread',
          input: [{ type: 'text', text: '继续这个任务' }],
          model: 'persisted-model',
        },
      },
    ])
  })

  test('reads a persisted goal without resuming the thread owned by another page', async () => {
    const registryClient = new FakeGatewayClient('unused-registry-thread')
    const listClient = new FakeGatewayClient('unused-list-thread')
    listClient.threadResumeSupported = true
    listClient.persistedThreads = [
      {
        id: 'reload-goal-thread',
        cwd: '/workspace',
        title: 'Reload goal',
        status: 'idle',
        createdAt: '1700000000000',
        updatedAt: '1700000001000',
      },
    ]
    const readonlyClient = new FakeGatewayClient('reload-goal-thread')
    readonlyClient.goal = { objective: 'restore without ownership', status: 'active' }
    const clients = [registryClient, listClient, readonlyClient]
    let issuedClients = 0
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients[issuedClients++]!,
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:reload-goal-thread' }] }],
    })
    await expect(
      runtime.request('runtime.tasks.goal.get', {
        address: {
          deviceId: 'local',
          taskId: 'kcoder:local:reload-goal-thread',
          threadId: 'reload-goal-thread',
          workspacePath: '/workspace',
        },
      })
    ).resolves.toMatchObject({
      accepted: true,
      goal: { objective: 'restore without ownership', status: 'active' },
    })
    expect(readonlyClient.closed).toBe(true)
    expect(readonlyClient.requests).toEqual([
      {
        method: 'thread/goal/get',
        params: { threadId: 'reload-goal-thread' },
      },
    ])
  })

  test('restores persisted attachments while keeping injected client context out of visible history', async () => {
    const runtime = createTestGatewayRuntime('token', {
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
        client.persistedThreads = [
          {
            id: 'persisted-attachment-thread',
            cwd: '/workspace',
            title: '附件任务',
            status: 'idle',
            createdAt: '1700000000000',
            updatedAt: '1700000001000',
          },
        ]
        client.threadMessages = [
          {
            id: 'history-attachment-message',
            clientMessageId: 'client-attachment-message',
            turnId: 'turn-attachment',
            role: 'user',
            content: [
              '<kcoder_client_context personality="friendly">',
              '内部 instructions',
              '</kcoder_client_context>',
              '',
              '检查截图',
              '',
              '<kcoder_attachments version="1">',
              '{"filename":"screen.png","mimeType":"image/png","fileSize":42,"path":"/tmp/private-screen.png"}',
              '</kcoder_attachments>',
            ].join('\n'),
            timestampMs: 1700000000500,
          },
        ]
        return client
      },
    })

    await runtime.request('runtime.tasks.list', {})
    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: 'kcoder:local:persisted-attachment-thread',
        threadId: 'persisted-attachment-thread',
        deviceId: 'local',
        limit: 50,
      })
    ).resolves.toMatchObject({
      messages: [
        {
          clientMessageId: 'client-attachment-message',
          content: '检查截图',
          attachments: [
            {
              filename: 'screen.png',
              mime_type: 'image/png',
              file_size: 42,
              local_path: '/tmp/private-screen.png',
            },
          ],
        },
      ],
    })
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
    const runtime = createTestGatewayRuntime('token', {
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
    const runtime = createTestGatewayRuntime('token', {
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
    const live = createTestGatewayRuntime('token', {
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
    const reloaded = createTestGatewayRuntime('token', {
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
})
