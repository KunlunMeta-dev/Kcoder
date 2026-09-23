import { listen } from '@tauri-apps/api/event'
import { describe, expect, test, vi } from 'vitest'
import {
  readPreferences,
  readGatewayCodexLocalConfig,
  updateGatewayCodexLocalConfig,
  writePreferences,
} from './gatewayRuntimeSettings'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { LEGACY_KCODER_STUDIO_STORAGE_KEYS } from './legacyRuntimeAbi'

describe('KCoder gateway runtime task isolation', () => {
  test('plugin operations open only the explicitly selected remote workspace', async () => {
    const connections: Array<{ serverId: string; workspacePath?: string }> = []
    const client = new FakeGatewayClient(null)
    const original = client.request.bind(client)
    const request = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'plugin/uninstall') return { changed: true } as never
      return original(method, params)
    })
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: 'Local',
          description: '',
          transport: 'local',
          workspacePath: '/local',
        },
        {
          id: 'remote',
          label: 'Remote',
          description: '',
          transport: 'ssh',
          host: 'remote.test',
          workspacePath: '/remote',
        },
      ],
      createClient: (serverId, _token, _channel, workspacePath) => {
        connections.push({ serverId, workspacePath })
        return client
      },
    })
    await runtime.request('runtime.plugins.request', {
      deviceId: 'remote',
      workspacePath: '/remote/project',
      method: 'plugin/uninstall',
      params: { pluginId: 'demo@market' },
    })
    expect(connections).toEqual([{ serverId: 'remote', workspacePath: '/remote/project' }])
    expect(request).toHaveBeenCalledWith('plugin/uninstall', { pluginId: 'demo@market' })
  })

  test('starts with the canonical quick phrases while preserving an explicit empty list', () => {
    localStorage.removeItem('kcoder-studio:app-preferences')

    expect(readPreferences().quickPhrases).toEqual([
      expect.objectContaining({ id: 'default-summary-progress', mode: 'normal' }),
      expect.objectContaining({ id: 'default-create-plan', mode: 'plan' }),
      expect.objectContaining({ id: 'default-pursue-goal', mode: 'goal' }),
    ])

    expect(writePreferences({ quickPhrases: [] }).quickPhrases).toEqual([])
    expect(readPreferences().quickPhrases).toEqual([])
  })

  test('keeps unavailable workspaces visible without opening app-server clients for them', async () => {
    const connections: Array<string | undefined> = []
    const command = new FakeGatewayClient(null)
    command.threadResumeSupported = true
    command.workspaceItems = [
      {
        workspacePath: '/workspace/deleted-project',
        label: 'Deleted project',
        projectKey: 'deleted-project',
        projectSource: 'local_project',
        available: false,
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
      createClient: (_serverId, _token, _channel, workspacePath) => {
        connections.push(workspacePath)
        if (workspacePath === undefined) return command
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        return client
      },
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          workspacePath: '/workspace/deleted-project',
          available: false,
          tasks: [],
        }),
      ]),
    })
    expect(connections).not.toContain('/workspace/deleted-project')
  })

  test('persists the remote apps setting instead of acknowledging a no-op write', () => {
    expect(readGatewayCodexLocalConfig().remoteAppsEnabled).toBe(true)
    expect(updateGatewayCodexLocalConfig({ remoteAppsEnabled: false }).remoteAppsEnabled).toBe(
      false
    )
    expect(readGatewayCodexLocalConfig().remoteAppsEnabled).toBe(false)
    expect(updateGatewayCodexLocalConfig({ unrelated: true }).remoteAppsEnabled).toBe(false)
  })

  test('does not persist gateway tokens or server connection fields in local Codex config', () => {
    updateGatewayCodexLocalConfig({
      remoteAppsEnabled: true,
      token: 'sensitive-token-value',
      serverId: 'remote-server',
      endpoint: 'https://private.example.test',
    })

    expect(localStorage.getItem('kcoder-studio:codex-local-config-v1')).toBe(
      JSON.stringify({ remoteAppsEnabled: true })
    )
  })

  test('uses runtime-neutral project keys and KCoder task identities for KCoder targets', async () => {
    const client = new FakeGatewayClient('codex-thread-1')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'codex-local',
          label: 'Codex Local',
          description: '本机 Codex',
          runtime: 'kcoder' as const,
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })

    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'draft-codex',
        workspacePath: '/workspace',
        executionRequest: {
          prompt: 'run Codex',
          model_config: { model_id: 'kunlunmeta' },
        },
      })
    ).resolves.toMatchObject({ taskId: 'kcoder:codex-local:codex-thread-1' })

    expect(client.requests).toContainEqual({
      method: 'thread/metadata/update',
      params: { threadId: 'codex-thread-1', title: 'run Codex', model: 'kunlunmeta' },
    })
    expect(client.requests).not.toContainEqual({
      method: 'thread/metadata/update',
      params: expect.objectContaining({ model: 'codex-selected-model' }),
    })

    expect(client.requests).toContainEqual({
      method: 'thread/start',
      params: { cwd: '/workspace', model: 'kunlunmeta', clientRequestId: 'draft-codex' },
    })
    expect(client.requests).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'codex-thread-1',
        input: [{ type: 'text', text: 'run Codex' }],
        model: 'kunlunmeta',
        proxyUrl: '',
      },
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        {
          projectKey: 'runtime-target:codex-local',
          tasks: [
            {
              taskId: 'kcoder:codex-local:codex-thread-1',
            },
          ],
        },
      ],
    })
    runtime.dispose()
  })

  test('persists keybinding overrides across runtime instances', async () => {
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
      createClient: () => new FakeGatewayClient('unused'),
    }
    const runtime = createTestGatewayRuntime('token', options)
    await expect(
      runtime.request('runtime.keybindings.update', {
        keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
      })
    ).resolves.toEqual({
      keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
    })
    const reloaded = createTestGatewayRuntime('token', options)
    await expect(reloaded.request('runtime.keybindings.get', {})).resolves.toEqual({
      keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
    })
  })

  test('persists context settings, applies them to prompts, and rejects the obsolete unscoped hook catalog', async () => {
    const client = new FakeGatewayClient('thread-context')
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

    await expect(
      runtime.request('runtime.instructions.write', { instructions: '始终先运行测试' })
    ).resolves.toEqual({ instructions: '始终先运行测试', configPath: null })
    await expect(
      runtime.request('runtime.personality.write', { personality: 'friendly' })
    ).resolves.toEqual({ personality: 'friendly' })
    await expect(runtime.request('runtime.instructions.read', {})).resolves.toEqual({
      instructions: '始终先运行测试',
      configPath: null,
    })
    await expect(runtime.request('runtime.hooks.list', {})).rejects.toMatchObject({
      data: { kind: 'hook_config_unsupported' },
    })

    await runtime.request('runtime.tasks.create', {
      taskId: 'context-task',
      executionRequest: { prompt: '实现功能' },
    })
    expect(client.requests.find(request => request.method === 'turn/start')).toMatchObject({
      params: {
        input: [
          {
            type: 'text',
            text: expect.stringContaining(
              '<kcoder_client_context personality="friendly">\n始终先运行测试'
            ),
          },
        ],
      },
    })
    runtime.dispose()
  })

  test('migrates execution context out of browser storage into the target runtime once', async () => {
    localStorage.setItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions, '迁移后的共享指令')
    localStorage.setItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality, 'friendly')
    const client = new FakeGatewayClient('thread-context-migration')
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
      createClient: () => client,
    }
    const runtime = createTestGatewayRuntime('token', options)

    await expect(runtime.request('runtime.instructions.read', {})).resolves.toEqual({
      instructions: '迁移后的共享指令',
      configPath: null,
    })
    expect(client.requests).toContainEqual({
      method: 'runtime.context.update',
      params: {
        instructions: '迁移后的共享指令',
        personality: 'friendly',
        onlyIfUnconfigured: true,
      },
    })
    expect(localStorage.getItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions)).toBeNull()
    expect(localStorage.getItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality)).toBeNull()

    const secondRuntime = createTestGatewayRuntime('token', options)
    await expect(secondRuntime.request('runtime.personality.read', {})).resolves.toEqual({
      personality: 'friendly',
    })
    expect(
      client.requests.filter(request => request.method === 'runtime.context.update')
    ).toHaveLength(1)
    runtime.dispose()
    secondRuntime.dispose()
  })

  test('does not let a stale browser migration overwrite a concurrent target write', async () => {
    localStorage.setItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions, '浏览器旧指令')
    localStorage.setItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality, 'friendly')
    const client = new FakeGatewayClient('thread-context-cas')
    client.onContextGet = () => {
      client.onContextGet = null
      client.sharedRuntimeContext = {
        instructions: '另一个客户端刚保存的指令',
        personality: 'pragmatic',
        instructionsConfigured: true,
        personalityConfigured: true,
        configPath: null,
      }
    }
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

    await expect(runtime.request('runtime.instructions.read', {})).resolves.toEqual({
      instructions: '另一个客户端刚保存的指令',
      configPath: null,
    })
    expect(client.sharedRuntimeContext.instructions).toBe('另一个客户端刚保存的指令')
    expect(client.sharedRuntimeContext.personality).toBe('pragmatic')
    expect(client.requests).toContainEqual({
      method: 'runtime.context.update',
      params: {
        instructions: '浏览器旧指令',
        personality: 'friendly',
        onlyIfUnconfigured: true,
      },
    })
    runtime.dispose()
  })

  test('starts a task process in the requested worktree and checks the canonical registry', async () => {
    const connections: Array<{
      serverId: string
      channel: string | undefined
      workspacePath: string | undefined
    }> = []
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
      createClient: (serverId, _token, channel, workspacePath) => {
        connections.push({ serverId, channel, workspacePath })
        return new FakeGatewayClient('thread-worktree')
      },
    })

    await runtime.request('runtime.tasks.create', {
      taskId: 'worktree-task',
      workspacePath: '/managed-worktrees/task-1',
      executionRequest: { prompt: 'work here' },
    })

    expect(connections).toEqual([
      {
        serverId: 'local',
        channel: 'runtime',
        workspacePath: '/managed-worktrees/task-1',
      },
      {
        serverId: 'local',
        channel: 'runtime',
        workspacePath: '/workspace',
      },
    ])
  })

  test('lists opened workspaces and hydrates their threads in the matching process cwd', async () => {
    const connections: Array<string | undefined> = []
    const command = new FakeGatewayClient(null)
    command.threadResumeSupported = true
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
          tasks: [expect.objectContaining({ taskId: 'kcoder:local:secondary-thread' })],
        }),
      ]),
    })
    expect(connections).toContain('/workspace')
    expect(connections).toContain('/workspace/secondary')
  })

  test('forwards the model catalog and keeps the selected model on follow-up turns', async () => {
    const client = new FakeGatewayClient('thread-model')
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

    await expect(runtime.request('runtime.models.list', {})).resolves.toMatchObject({
      data: [{ model: 'model' }],
      providers: [{ id: 'profile', current: true }],
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'model-task',
      executionRequest: {
        prompt: 'use selected model',
        model_config: {
          model_id: 'model-special',
          model_provider: 'provider-special',
          reasoning: { effort: 'high' },
          service_tier: 'priority',
          proxy: { url: 'http://127.0.0.1:7890' },
          runtime_config: { codex: { use_proxy: true } },
        },
      },
    })) as { taskId: string }
    client.emitNotification('turn/completed', {
      threadId: 'thread-model',
      turnId: 'thread-model-turn',
      turn: { id: 'thread-model-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime.request('runtime.tasks.send', {
      taskId: created.taskId,
      message: 'continue',
      executionRequest: {
        prompt: 'continue',
        model_config: {
          model_id: 'model-special',
          model_provider: 'provider-special',
        },
      },
    })

    expect(client.requests).toContainEqual({
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        model: 'provider-special::model-special',
        clientRequestId: 'model-task',
      },
    })
    expect(client.requests.filter(request => request.method === 'turn/start')).toEqual([
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-model',
          input: [{ type: 'text', text: 'use selected model' }],
          model: 'provider-special::model-special',
          reasoningEffort: 'high',
          proxyUrl: 'http://127.0.0.1:7890',
          serviceTier: 'priority',
        },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-model',
          input: [{ type: 'text', text: 'continue' }],
          model: 'provider-special::model-special',
          proxyUrl: '',
        },
      },
    ])
  })

  test('projects the app-server terminal error instead of a generic failed label', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-failed')
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

    await runtime.request('runtime.tasks.create', {
      taskId: 'failed-task',
      executionRequest: { prompt: 'fail visibly' },
    })
    client.emitNotification('turn/completed', {
      threadId: 'thread-failed',
      turnId: 'thread-failed-turn',
      turn: { id: 'thread-failed-turn', status: 'failed' },
      error: { code: -32010, message: 'provider authentication failed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(received.filter(event => event.event === 'response.failed')).toMatchObject([
      { payload: { data: { message: 'provider authentication failed' } } },
    ])
    unlisten()
    runtime.dispose()
  })

  test('treats an optimistic task goal lookup as pending instead of logging an address error', async () => {
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
      createClient: () => new FakeGatewayClient(null),
    })

    await expect(
      runtime.request('runtime.tasks.goal.get', {
        address: { taskId: 'runtime-optimistic-task' },
      })
    ).resolves.toEqual({
      accepted: false,
      taskId: 'runtime-optimistic-task',
      goal: null,
    })
    runtime.dispose()
  })

  test('reads a goal through a readonly client without replacing the active task client', async () => {
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
      createClient: () => {
        const client = new FakeGatewayClient('thread-goal-reload')
        client.goal = { objective: 'shared readonly goal', status: 'active' }
        clients.push(client)
        return client
      },
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'goal-reload',
      executionRequest: { prompt: 'seed reload goal' },
    })) as { taskId: string }
    await expect(
      runtime.request('runtime.tasks.goal.get', {
        address: { deviceId: 'local', taskId: created.taskId, threadId: 'thread-goal-reload' },
      })
    ).resolves.toMatchObject({
      accepted: true,
      taskId: created.taskId,
      goal: { objective: 'shared readonly goal', status: 'active' },
    })
    expect(clients).toHaveLength(2)
    expect(clients[0].closed).toBe(false)
    expect(clients[1].closed).toBe(true)
    expect(clients[1].requests.map(item => item.method)).toEqual(['thread/goal/get'])
    runtime.dispose()
  })

  test('does not retry unrelated readonly goal errors', async () => {
    const clients: FakeGatewayClient[] = []
    let failNextReadonlyClient = false
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
        const client = new FakeGatewayClient('thread-goal-error')
        if (failNextReadonlyClient) client.goalGetFailures.push(new Error('permission denied'))
        clients.push(client)
        return client
      },
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'goal-error',
      executionRequest: { prompt: 'seed goal error' },
    })) as { taskId: string }
    failNextReadonlyClient = true

    await expect(
      runtime.request('runtime.tasks.goal.get', {
        address: { deviceId: 'local', taskId: created.taskId, threadId: 'thread-goal-error' },
      })
    ).rejects.toThrow('permission denied')
    expect(clients).toHaveLength(2)
    expect(clients[0].closed).toBe(false)
    expect(clients[1].closed).toBe(true)
    runtime.dispose()
  })

  test('routes a follow-up to the original task process after a second task starts', async () => {
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
      createClient: () => {
        const client = new FakeGatewayClient(`thread-${clients.length + 1}`)
        clients.push(client)
        return client
      },
    })

    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: 'optimistic-draft',
        workspacePath: '/workspace',
      })
    ).resolves.toMatchObject({ taskId: 'optimistic-draft', messages: [] })
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'task-a',
        workspacePath: '/workspace',
        executionRequest: { prompt: 'first task' },
      })
    ).resolves.toMatchObject({ taskId: 'kcoder:local:thread-1' })
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-b',
      workspacePath: '/workspace',
      executionRequest: { prompt: 'second task' },
    })
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'task-a',
        workspacePath: '/workspace',
        executionRequest: { prompt: 'duplicate task' },
      })
    ).rejects.toThrow('任务已存在：task-a')
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'kcoder:local:spoofed-thread',
        workspacePath: '/workspace',
        executionRequest: { prompt: 'reserved task id' },
      })
    ).rejects.toThrow('任务 ID 使用了运行目标保留命名空间')
    await runtime.request('runtime.tasks.send', {
      address: { taskId: 'task-a', threadId: 'thread-1' },
      executionRequest: { prompt: 'continue first task' },
    })

    expect(clients).toHaveLength(2)
    expect(clients[0].requests.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'continue first task' }],
      },
    })
    expect(clients[1].requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
    expect(clients[1].requests).toContainEqual({
      method: 'thread/metadata/update',
      params: { threadId: 'thread-2', title: 'second task' },
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        {
          tasks: [{ taskId: 'kcoder:local:thread-1' }, { taskId: 'kcoder:local:thread-2' }],
        },
      ],
    })
    await expect(
      runtime.request('runtime.tasks.search', { query: 'first', limit: 20 })
    ).resolves.toMatchObject({
      items: [
        {
          title: 'first task',
          address: {
            deviceId: 'local',
            taskId: 'kcoder:local:thread-1',
            threadId: 'thread-1',
          },
        },
      ],
    })
  })

  test('implements compact, rollback, and goal operations through the owning app-server', async () => {
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-operations')
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
      taskId: 'operations',
      executionRequest: { prompt: 'first message' },
    })) as { taskId: string }
    client.emitNotification('turn/completed', {
      threadId: 'thread-operations',
      turnId: 'thread-operations-turn',
      turn: { id: 'thread-operations-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const address = { deviceId: 'local', taskId: created.taskId, threadId: 'thread-operations' }

    await expect(runtime.request('runtime.tasks.compact', { address })).resolves.toEqual({
      accepted: true,
      taskId: created.taskId,
    })
    await expect(
      runtime.request('runtime.tasks.revert_file_changes', {
        address,
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'artifact-1',
          device_id: 'local',
          workspace_path: '/workspace',
          file_count: 1,
          additions: 1,
          deletions: 0,
          files: [],
          diff: 'diff --git a/a.txt b/a.txt\n',
          revertible: true,
        },
      })
    ).resolves.toMatchObject({
      fileChanges: { artifact_id: 'artifact-1', status: 'reverted', revertible: false },
    })
    expect(client.requests).toContainEqual({
      method: 'device/execute',
      params: {
        deviceId: 'local',
        command_key: 'turn_file_changes_revert',
        threadId: 'thread-operations',
        path: '/workspace',
        args: ['artifact-1'],
        timeout_seconds: 30,
        max_output_bytes: 65536,
      },
    })
    await expect(
      runtime.request('runtime.tasks.goal.set', {
        address,
        objective: 'finish parity',
        mode: 'strict',
        verificationKind: 'answer',
        status: 'active',
        tokenBudget: 2000,
      })
    ).resolves.toMatchObject({
      accepted: true,
      taskId: created.taskId,
      goal: {
        objective: 'finish parity',
        mode: 'strict',
        verificationKind: 'answer',
        status: 'active',
        tokenBudget: 2000,
      },
    })
    await expect(runtime.request('runtime.tasks.goal.get', { address })).resolves.toMatchObject({
      accepted: true,
      goal: { objective: 'finish parity' },
    })
    await expect(
      runtime.request('runtime.tasks.goal.set', { address, tokenBudget: null })
    ).resolves.toMatchObject({ goal: { tokenBudget: null } })
    expect(client.requests).toContainEqual({
      method: 'thread/goal/set',
      params: { threadId: 'thread-operations', clearTokenBudget: true },
    })
    await expect(runtime.request('runtime.tasks.goal.clear', { address })).resolves.toMatchObject({
      accepted: true,
      cleared: true,
    })
    const attachmentPath = await runtime.saveAttachment({ filename: 'guide.txt', bytes: [103] })
    await expect(
      runtime.request('runtime.tasks.guidance', {
        address,
        message: 'inspect this',
        clientGuidanceId: 'guidance-1',
        attachments: [{ local_path: attachmentPath }],
        additionalContext: {
          selection: { kind: 'application', value: 'Selected deployment logs' },
        },
      })
    ).resolves.toMatchObject({
      accepted: true,
      success: true,
      guidanceId: 'guidance-1',
      turnId: 'thread-operations-turn',
    })
    expect(client.requests.at(-1)).toMatchObject({
      method: 'turn/start',
      params: {
        input: [
          {
            type: 'text',
            text: expect.stringContaining('[selection]\nSelected deployment logs'),
          },
        ],
      },
    })
    expect((client.requests.at(-1)?.params.input as Array<{ text: string }>)[0].text).toContain(
      JSON.stringify({
        filename: 'guide.txt',
        mimeType: 'application/octet-stream',
        fileSize: 1,
        path: attachmentPath,
      })
    )
    expect(received.filter(event => event.event === 'response.guidance.applied')).toMatchObject([
      {
        payload: {
          taskId: created.taskId,
          deviceId: 'local',
          data: {
            guidanceId: 'guidance-1',
            message: 'inspect this',
            appliedAtMs: expect.any(Number),
          },
        },
      },
    ])
    client.emitNotification('turn/completed', {
      threadId: 'thread-operations',
      turnId: 'thread-operations-turn',
      turn: { id: 'thread-operations-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    client.rollbackFailedFiles = 1
    const turnsBeforeFailedRollback = client.requests.filter(
      request => request.method === 'turn/start'
    ).length
    await expect(
      runtime.request('runtime.tasks.rollback', { address, message: 'must not send' })
    ).rejects.toThrow('回滚未完整恢复 1 个文件')
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(
      turnsBeforeFailedRollback
    )
    client.rollbackFailedFiles = 0
    client.rollbackRemovedMessages = 0
    await expect(
      runtime.request('runtime.tasks.rollback', { address, message: 'missing boundary' })
    ).rejects.toThrow('已找不到上一条消息边界')
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(
      turnsBeforeFailedRollback
    )
    client.rollbackRemovedMessages = 2
    await expect(
      runtime.request('runtime.tasks.rollback', { address, message: 'edited message' })
    ).resolves.toMatchObject({ accepted: true, taskId: created.taskId })

    expect(client.requests).toContainEqual({
      method: 'thread/compact',
      params: { threadId: 'thread-operations' },
    })
    expect(client.requests).toContainEqual({
      method: 'thread/rollback',
      params: { threadId: 'thread-operations' },
    })
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-operations',
        input: [{ type: 'text', text: 'edited message' }],
      },
    })
    unlisten()
  })

  test('opens a task on the server represented by its Wework project', async () => {
    const connectedServerIds: string[] = []
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
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
        {
          id: 'build-01',
          label: '构建服务器',
          description: 'SSH',
          transport: 'ssh',
          host: 'build-01',
          workspacePath: '/srv/project',
        },
      ],
      createClient: serverId => {
        connectedServerIds.push(serverId)
        const client = new FakeGatewayClient(`thread-${serverId}`)
        clients.push(client)
        return client
      },
    })

    await runtime.request('runtime.tasks.create', {
      taskId: 'remote-task',
      runtimeProjectKey: 'kcoder:build-01',
      workspacePath: '/srv/project',
      executionRequest: {
        prompt: 'run remotely',
        runtime_project_key: 'kcoder:build-01',
        project_workspace_path: '/srv/project',
      },
    })

    expect(connectedServerIds).toEqual(['build-01'])
    clients[0].emitNotification('turn/started', {
      threadId: 'thread-build-01',
      turnId: 'turn-1',
      turn: { id: 'turn-1' },
    })
    clients[0].emitNotification('turn/completed', {
      threadId: 'thread-build-01',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(received.filter(event => event.event === 'response.completed')).toMatchObject([
      { payload: { taskId: 'kcoder:build-01:thread-build-01', deviceId: 'build-01' } },
    ])
    await expect(
      runtime.request('device.execute_command', {
        deviceId: 'build-01',
        command_key: 'home_dir',
      })
    ).resolves.toMatchObject({ stdout: '/home/test\n' })
    await expect(
      runtime.request('device.execute_command', {
        deviceId: 'build-01',
        command_key: 'workspace_tree',
        path: '/srv/project',
      })
    ).resolves.toMatchObject({
      success: true,
      stdout: { path: '/srv/project', entries: [] },
    })
    await runtime.request('device.execute_command', {
      deviceId: 'build-01',
      command_key: 'git_status_porcelain',
      path: '/srv/project',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    await runtime.request('device.execute_command', {
      deviceId: 'build-01',
      command_key: 'workspace_write_text_file',
      path: '/srv/project',
      args: ['README.md', 'sha256:before'],
      stdin: 'updated',
    })
    await runtime.request('device.execute_command', {
      deviceId: 'build-01',
      command_key: 'ls_skills',
    })
    await runtime.request('runtime.worktrees.settings.get', { deviceId: 'build-01' })
    await runtime.request('runtime.worktrees.prepare', {
      deviceId: 'build-01',
      sourcePath: '/srv/project',
      worktreeId: 'task-1',
      ref: 'main',
    })
    await expect(
      runtime.request('runtime.workspace.search', {
        deviceId: 'build-01',
        root: '/srv/project',
        query: 'main',
      })
    ).resolves.toMatchObject({ files: [{ path: 'src/main.rs' }] })
    expect(connectedServerIds).toEqual(['build-01', 'build-01'])
    expect(clients[1].requests).toContainEqual({
      method: 'device/execute',
      params: {
        deviceId: 'build-01',
        command_key: 'git_status_porcelain',
        path: '/srv/project',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'runtime.workspace.search',
      params: {
        deviceId: 'build-01',
        root: '/srv/project',
        query: 'main',
      },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'device/execute',
      params: { deviceId: 'build-01', command_key: 'ls_skills' },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'runtime.worktrees.settings.get',
      params: { deviceId: 'build-01' },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'runtime.worktrees.prepare',
      params: {
        deviceId: 'build-01',
        sourcePath: '/srv/project',
        worktreeId: 'task-1',
        ref: 'main',
      },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'device/execute',
      params: {
        deviceId: 'build-01',
        command_key: 'workspace_write_text_file',
        path: '/srv/project',
        args: ['README.md', 'sha256:before'],
        stdin: 'updated',
      },
    })
    await expect(
      runtime.request('device.execute_command', {
        execution: { device_id: 'build-01' },
        command_key: 'project_workspace_root',
      })
    ).resolves.toMatchObject({ stdout: '/srv/project\n' })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        { projectKey: 'runtime-target:local', projectActive: true, tasks: [] },
        {
          projectKey: 'runtime-target:build-01',
          projectActive: false,
          tasks: [{ taskId: 'kcoder:build-01:thread-build-01' }],
        },
      ],
    })
    await expect(
      runtime.request('runtime.sidebar.projects.sync_remote', {
        deviceId: 'local',
        projects: [],
      })
    ).resolves.toMatchObject({ accepted: true, deviceId: 'local' })
    await expect(
      runtime.request('runtime.sidebar.projects.activate', {
        deviceId: 'local',
        projectKey: 'wegent-remote:build-01:project',
        workspacePath: '/srv/project',
      })
    ).resolves.toMatchObject({ accepted: true, deviceId: 'build-01' })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        { projectKey: 'runtime-target:local', projectActive: false },
        { projectKey: 'runtime-target:build-01', projectActive: true },
      ],
    })
    const reloaded = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
        {
          id: 'build-01',
          label: '构建服务器',
          description: 'SSH',
          transport: 'ssh',
          host: 'build-01',
          workspacePath: '/srv/project',
        },
      ],
      createClient: () => new FakeGatewayClient('unused'),
    })
    await expect(reloaded.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [
        { projectKey: 'runtime-target:local', projectActive: false },
        { projectKey: 'runtime-target:build-01', projectActive: true },
      ],
    })
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'unknown-task',
        runtimeProjectKey: 'kcoder:missing',
        executionRequest: { prompt: 'must not fall back', runtime_project_key: 'kcoder:missing' },
      })
    ).rejects.toThrow('未知的 KCoder 服务器：missing')
    await unlisten()
  })
})
