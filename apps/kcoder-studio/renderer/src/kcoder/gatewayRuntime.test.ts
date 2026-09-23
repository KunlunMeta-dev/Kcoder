import i18n from '@/i18n'
import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  KCoderGatewayRuntime,
  readGatewayRuntimeConfig,
  updateGatewayRuntimeConfig,
} from './installGatewayRuntime'
import { GatewayRpcError } from './gatewayRpc'
import { KCODER_RUNTIME_METHODS, LEGACY_KCODER_STUDIO_STORAGE_KEYS } from './legacyRuntimeAbi'

class FakeGatewayClient extends EventTarget {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly responses: Array<{ id: number; result?: unknown; error?: unknown }> = []
  interruptResult = true
  threadResumeSupported = false
  connectGate: Promise<void> | null = null
  resumeGate: Promise<void> | null = null
  resumeFailure: Error | null = null
  persistedThreads: Array<Record<string, unknown>> = []
  archivedThreads: Array<Record<string, unknown>> = []
  threadReadFailures = 0
  threadReadPages: Array<Record<string, unknown>> | null = null
  closed = false
  goal: Record<string, unknown> | null = null
  goalGetFailures: Error[] = []
  rollbackFailedFiles = 0
  rollbackRemovedMessages = 2
  respondFailure: Error | null = null
  turnStartFailure: Error | null = null
  turnStartGate: Promise<void> | null = null
  workspaceItems: Array<Record<string, unknown>> = []
  pinnedTaskIds: string[] = []
  worktreeItems: Array<Record<string, unknown>> = []
  sharedRuntimeContext = {
    instructions: '',
    personality: 'pragmatic' as 'friendly' | 'pragmatic',
    instructionsConfigured: false,
    personalityConfigured: false,
    configPath: null as string | null,
  }
  threadMessages: Array<Record<string, unknown>> = [
    {
      id: 'history-message-1',
      turnId: 'turn-1',
      role: 'user',
      content: '之前的问题',
      blocks: [{ id: 'thinking-1', type: 'thinking', content: '已分析', status: 'done' }],
      timestampMs: 1700000000500,
    },
  ]
  private readonly threadId: string | null

  constructor(threadId: string | null) {
    super()
    this.threadId = threadId
  }

  async connect() {
    if (this.connectGate) await this.connectGate
  }

  close() {
    this.closed = true
    this.dispatchEvent(new Event('close'))
  }

  supportsThreadResume() {
    return this.threadResumeSupported
  }

  supportsExperimental(capability: string) {
    return capability !== 'threadIndexedPagesV1' && capability !== 'threadListCompleteness'
  }

  respond(id: number, result: unknown) {
    if (this.respondFailure) throw this.respondFailure
    this.responses.push({ id, result })
  }

  respondError(id: number, code: number, message: string, data?: unknown) {
    this.responses.push({ id, error: { code, message, data } })
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'thread/start')
      return (this.threadId ? { thread: { id: this.threadId } } : {}) as T
    if (method === 'thread/list') {
      const start = Number(params.cursor ?? 0)
      const limit = Number(params.limit ?? 100)
      const source = params.archived === true ? this.archivedThreads : this.persistedThreads
      const threads = source.slice(start, start + limit)
      return {
        threads,
        nextCursor: start + threads.length < source.length ? String(start + threads.length) : null,
      } as T
    }
    if (method === 'thread/read') {
      if (this.threadReadFailures > 0) {
        this.threadReadFailures -= 1
        throw new Error('persisted thread not found: test history')
      }
      if (this.threadReadPages) {
        const page = this.threadReadPages.shift()
        if (!page) throw new Error('unexpected extra transcript page request')
        return page as T
      }
      return {
        messages: this.threadMessages,
        rangeStart: 0,
        rangeEnd: 1,
        hasMoreBefore: false,
        beforeCursor: null,
      } as T
    }
    if (method === 'thread/resume') {
      if (this.resumeGate) await this.resumeGate
      if (this.resumeFailure) throw this.resumeFailure
      return { thread: { id: params.threadId } } as T
    }
    if (method === 'thread/metadata/update') {
      const thread = this.persistedThreads.find(item => item.id === params.threadId) ?? {
        id: params.threadId,
        cwd: '/workspace',
        status: 'idle',
      }
      const previousMetadata =
        typeof thread.metadata === 'object' && thread.metadata !== null
          ? (thread.metadata as Record<string, unknown>)
          : {}
      for (const field of ['title', 'model', 'archivedAt', 'parent'] as const) {
        if (!(field in params)) continue
        if (params[field] === null) delete thread[field]
        else thread[field] = params[field]
      }
      thread.metadata = {
        schema: 'kcoder.thread-metadata',
        version: 1,
        revision: Number(previousMetadata.revision ?? 0) + 1,
        title: 'title' in params ? params.title : (previousMetadata.title ?? thread.title ?? null),
        model: 'model' in params ? params.model : (previousMetadata.model ?? thread.model ?? null),
        archivedAt:
          'archivedAt' in params
            ? params.archivedAt
            : (previousMetadata.archivedAt ?? thread.archivedAt ?? null),
        parent:
          'parent' in params ? params.parent : (previousMetadata.parent ?? thread.parent ?? null),
      }
      thread.updatedAt = String(Date.now())
      if (!this.persistedThreads.includes(thread)) this.persistedThreads.push(thread)
      return { thread } as T
    }
    if (method === 'thread/fork') {
      return { thread: { id: `${this.threadId ?? 'thread'}-fork` } } as T
    }
    if (method === 'thread/compact') {
      return { threadId: params.threadId, compacted: true, preTokens: 100, postTokens: 40 } as T
    }
    if (method === 'thread/rollback') {
      return {
        threadId: params.threadId,
        turn: 1,
        removedMessages: this.rollbackRemovedMessages,
        failedFiles: this.rollbackFailedFiles,
      } as T
    }
    if (method === 'thread/goal/get') {
      const failure = this.goalGetFailures.shift()
      if (failure) throw failure
      return { threadId: params.threadId, goal: this.goal } as T
    }
    if (method === 'thread/goal/set') {
      const tokenBudget =
        params.clearTokenBudget === true
          ? null
          : (params.tokenBudget ?? this.goal?.tokenBudget ?? null)
      this.goal = {
        threadId: params.threadId,
        objective: params.objective ?? this.goal?.objective ?? '',
        mode: params.mode ?? this.goal?.mode ?? 'standard',
        verificationKind: params.verificationKind ?? this.goal?.verificationKind ?? 'artifact',
        status: params.status ?? this.goal?.status ?? 'active',
        tokenBudget,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      return { threadId: params.threadId, goal: this.goal } as T
    }
    if (method === 'thread/goal/clear') {
      const cleared = this.goal !== null
      this.goal = null
      return { threadId: params.threadId, cleared } as T
    }
    if (method === 'thread/delete') {
      return { threadId: params.threadId, deleted: true, deletedFiles: 3 } as T
    }
    if (method === KCODER_RUNTIME_METHODS.modelsList) {
      return {
        data: [{ id: 'profile::model', model: 'model' }],
        providers: [{ id: 'profile', current: true, available: true }],
      } as T
    }
    if (method === 'runtime.context.get') {
      return { ...this.sharedRuntimeContext } as T
    }
    if (method === 'runtime.context.update') {
      if (
        typeof params.instructions === 'string' &&
        (params.onlyIfUnconfigured !== true || !this.sharedRuntimeContext.instructionsConfigured)
      ) {
        this.sharedRuntimeContext.instructions = params.instructions
        this.sharedRuntimeContext.instructionsConfigured = true
      }
      if (
        (params.personality === 'friendly' || params.personality === 'pragmatic') &&
        (params.onlyIfUnconfigured !== true || !this.sharedRuntimeContext.personalityConfigured)
      ) {
        this.sharedRuntimeContext.personality = params.personality
        this.sharedRuntimeContext.personalityConfigured = true
      }
      return { ...this.sharedRuntimeContext } as T
    }
    if (method === 'runtime.workspace.search') {
      return {
        files: [
          {
            root: params.root,
            path: 'src/main.rs',
            fileName: 'main.rs',
            matchType: 'file',
            score: 100,
            indices: [4, 5, 6, 7],
          },
        ],
      } as T
    }
    if (method === 'runtime.workspaces.list') {
      return {
        success: true,
        items: this.workspaceItems,
        pinnedTaskIds: this.pinnedTaskIds,
        taskOrders: {},
      } as T
    }
    if (method === 'runtime.worktrees.list') {
      return { success: true, items: this.worktreeItems } as T
    }
    if (method === 'runtime.worktrees.delete') {
      const path = String(params.path)
      const conversations = Array.isArray(params.archivedConversations)
        ? params.archivedConversations
        : []
      const item = this.worktreeItems.find(candidate => candidate.path === path)
      if (item) {
        item.state = params.preserveSnapshot === false ? 'deleted' : 'restorable'
        item.conversations = conversations
      }
      return { success: true, accepted: true, worktree: item } as T
    }
    if (method === 'runtime.worktrees.restore') {
      const item = this.worktreeItems.find(candidate => candidate.path === params.path)
      if (item) item.state = 'active'
      return { success: true, accepted: true, worktree: item } as T
    }
    if (method === 'runtime.worktrees.conversations.remove') {
      const item = this.worktreeItems.find(candidate => candidate.path === params.path)
      if (item && Array.isArray(item.conversations)) {
        item.conversations = item.conversations.filter(
          conversation =>
            typeof conversation !== 'object' ||
            conversation === null ||
            (conversation as Record<string, unknown>).taskId !== params.taskId
        )
      }
      return { success: true, accepted: true, removed: true } as T
    }
    if (method === 'runtime.worktrees.conversations.link') {
      const item = this.worktreeItems.find(candidate => candidate.path === params.path)
      const conversation = params.conversation
      if (item && conversation && typeof conversation === 'object') {
        const conversations = Array.isArray(item.conversations) ? item.conversations : []
        item.conversations = [
          ...conversations.filter(
            existing =>
              typeof existing !== 'object' ||
              existing === null ||
              (existing as Record<string, unknown>).taskId !==
                (conversation as Record<string, unknown>).taskId
          ),
          conversation as Record<string, unknown>,
        ]
      }
      return { success: true, accepted: true, linked: true } as T
    }
    if (
      method.startsWith('runtime.workspaces.') ||
      method.startsWith('runtime.projects.') ||
      method.startsWith('runtime.sidebar.')
    ) {
      return { success: true, accepted: true, deviceId: params.deviceId ?? 'local' } as T
    }
    if (method === 'turn/start') {
      if (this.turnStartFailure) throw this.turnStartFailure
      if (this.turnStartGate) await this.turnStartGate
      return { turn: { id: `${this.threadId}-turn` } } as T
    }
    if (method === 'turn/interrupt') return { interrupted: this.interruptResult } as T
    if (method === 'gateway/client/detach') return { detached: true } as T
    if (method === 'gateway/app-server/restart') {
      return { restarted: false, stopped: true, reconnectRequired: true } as T
    }
    if (method === 'device/execute') {
      if (params.command_key === 'home_dir') {
        return { success: true, exit_code: 0, stdout: '/home/test\n', stderr: '' } as T
      }
      if (params.command_key === 'turn_file_changes_revert') {
        return {
          success: true,
          exit_code: 0,
          stdout: {
            success: true,
            file_changes: {
              version: 1,
              status: 'reverted',
              artifact_id: Array.isArray(params.args) ? params.args[0] : '',
              device_id: 'kcoder',
              workspace_path: params.path,
              file_count: 1,
              additions: 1,
              deletions: 0,
              files: [],
              revertible: false,
            },
          },
          stderr: '',
        } as T
      }
      return {
        success: true,
        exit_code: 0,
        stdout: { path: params.path, entries: [] },
        stderr: '',
      } as T
    }
    if (method === 'attachment/save') return { path: `/tmp/${String(params.filename)}` } as T
    if (method === 'terminal/start') {
      return { session_id: `${this.threadId ?? 'command'}-terminal`, cwd: params.cwd } as T
    }
    if (method === 'terminal/attach') {
      return {
        session_id: params.session_id,
        cwd: '/workspace',
        transcript: 'restored transcript\r\n',
        through_sequence: 3,
      } as T
    }
    if (method === 'terminal/resize' || method === 'terminal/write') {
      return { accepted: true } as T
    }
    if (method === 'terminal/close') return { closed: true } as T
    if (method === 'runtime.worktrees.settings.get') {
      return { success: true, settings: {} } as T
    }
    if (method === 'runtime.worktrees.prepare') {
      return { success: true, accepted: true } as T
    }
    if (method === 'runtime.worktrees.archive') {
      return { success: true, accepted: true } as T
    }
    if (method === 'browser/start') {
      return {
        session_id: `${this.threadId ?? 'command'}-browser`,
        url: params.url,
        width: Math.max(320, Math.min(1920, Number(params.width))),
        height: Math.max(240, Math.min(1080, Number(params.height))),
      } as T
    }
    if (method === 'browser/screenshot') {
      return {
        session_id: params.session_id,
        data_base64: 'YWJj',
        mime_type: 'image/jpeg',
        width: 320,
        height: 240,
        page: {
          url: 'https://example.test/ready',
          title: 'Remote example',
          faviconUrl: 'https://example.test/favicon.ico',
        },
      } as T
    }
    if (method === 'browser/action') {
      return {
        accepted: true,
        page:
          params.action === 'navigate'
            ? { url: params.url, title: 'Navigated', faviconUrl: null }
            : undefined,
      } as T
    }
    if (method === 'browser/evaluate') return { value: { ok: true } } as T
    if (method === 'browser/close') return { closed: true } as T
    throw new Error(`FakeGatewayClient 未建模 RPC：${method}`)
  }

  emitNotification(method: string, params: Record<string, unknown>) {
    this.dispatchEvent(new CustomEvent('notification', { detail: { method, params } }))
  }
}

describe('KCoder gateway runtime task isolation', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => clearMocks())

  test('persists the remote apps setting instead of acknowledging a no-op write', () => {
    expect(readGatewayRuntimeConfig().remoteAppsEnabled).toBe(true)
    expect(updateGatewayRuntimeConfig({ remoteAppsEnabled: false }).remoteAppsEnabled).toBe(false)
    expect(readGatewayRuntimeConfig().remoteAppsEnabled).toBe(false)
    expect(updateGatewayRuntimeConfig({ unrelated: true }).remoteAppsEnabled).toBe(false)
  })

  test('migrates the legacy Wework runtime config key without keeping ambiguous storage', () => {
    localStorage.setItem(
      LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig,
      JSON.stringify({ remoteAppsEnabled: false })
    )

    expect(readGatewayRuntimeConfig().remoteAppsEnabled).toBe(false)
    expect(localStorage.getItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig)).toBeNull()
    expect(localStorage.getItem('kcoder-studio:kcoder-runtime-config-v1')).not.toBeNull()
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
    const runtime = new KCoderGatewayRuntime('token', options)
    await expect(
      runtime.request('runtime.keybindings.update', {
        keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
      })
    ).resolves.toEqual({
      keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
    })
    const reloaded = new KCoderGatewayRuntime('token', options)
    await expect(reloaded.request('runtime.keybindings.get', {})).resolves.toEqual({
      keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
    })
  })

  test('persists context settings, applies them to prompts, and rejects the obsolete unscoped hook catalog', async () => {
    const client = new FakeGatewayClient('thread-context')
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

    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.instructionsWrite, {
        instructions: '始终先运行测试',
      })
    ).resolves.toEqual({ instructions: '始终先运行测试', configPath: null })
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.personalityWrite, { personality: 'friendly' })
    ).resolves.toEqual({ personality: 'friendly' })
    await expect(runtime.request(KCODER_RUNTIME_METHODS.instructionsRead, {})).resolves.toEqual({
      instructions: '始终先运行测试',
      configPath: null,
    })
    await expect(runtime.request('runtime.hooks.list', {})).rejects.toMatchObject({ data: { kind: 'hook_config_unsupported' } })

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

  test('starts a task process in the requested worktree', async () => {
    const connections: Array<{
      serverId: string
      channel: string | undefined
      workspacePath: string | undefined
    }> = []
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

  test('does not resurrect a fast completed first turn when turn start acknowledges late', async () => {
    const client = new FakeGatewayClient('thread-fast-complete')
    let releaseTurnStart = () => undefined
    client.turnStartGate = new Promise<void>(resolve => {
      releaseTurnStart = resolve
    })
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

    const creating = runtime.request('runtime.tasks.create', {
      taskId: 'fast-complete-task',
      executionRequest: { prompt: 'fast response' },
    })
    await vi.waitFor(() => {
      expect(client.requests.some(request => request.method === 'turn/start')).toBe(true)
    })
    client.emitNotification('turn/completed', {
      threadId: 'thread-fast-complete',
      turnId: 'thread-fast-complete-turn',
      turn: { id: 'thread-fast-complete-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseTurnStart()

    const created = (await creating) as { taskId: string }
    await expect(
      runtime.request('runtime.tasks.cancel', {
        address: { deviceId: 'local', taskId: created.taskId },
      })
    ).resolves.toMatchObject({ accepted: false, interrupted: false })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: created.taskId, running: false }] }],
    })
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

  test('does not warn when page teardown cancels persisted task hydration', async () => {
    let releaseHydration!: () => void
    const hydrationGate = new Promise<void>(resolve => {
      releaseHydration = resolve
    })
    const command = new FakeGatewayClient(null)
    command.threadResumeSupported = true
    let hydrationClient: FakeGatewayClient | undefined
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
        if (workspacePath === undefined) return command
        hydrationClient = new FakeGatewayClient(null)
        hydrationClient.threadResumeSupported = true
        hydrationClient.connectGate = hydrationGate
        return hydrationClient
      },
    })
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const listing = runtime.request('runtime.tasks.list', {})
    await vi.waitFor(() => expect(hydrationClient).toBeDefined())
    runtime.dispose()
    releaseHydration()
    await expect(listing).rejects.toMatchObject({
      name: 'AbortError', code: 'KCODER_WORKSPACE_SCAN_CANCELLED',
    })

    expect(consoleWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('无法同步 当前虚拟机 的持久任务'),
      expect.anything()
    )
  })

  test('forwards the model catalog and keeps the selected model on follow-up turns', async () => {
    const client = new FakeGatewayClient('thread-model')
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

    await expect(runtime.request(KCODER_RUNTIME_METHODS.modelsList, {})).resolves.toMatchObject({
      data: [{ model: 'model' }],
      providers: [{ id: 'profile', current: true }],
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'model-task',
      clientMessageId: 'client-create-1',
      executionRequest: {
        prompt: 'use selected model',
        model_config: {
          model_id: 'model-special',
          reasoning: { effort: 'high' },
          service_tier: 'priority',
          proxy: { url: 'http://127.0.0.1:7890' },
          runtime_config: { kcoder: { use_proxy: true } },
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
      clientMessageId: 'client-send-2',
    })

    expect(client.requests).toContainEqual({
      method: 'thread/start',
      params: { cwd: '/workspace', model: 'model-special', clientRequestId: 'model-task' },
    })
    expect(client.requests.filter(request => request.method === 'turn/start')).toEqual([
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-model',
          input: [{ type: 'text', text: 'use selected model' }],
          clientMessageId: 'client-create-1',
          model: 'model-special',
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
          clientMessageId: 'client-send-2',
          model: 'model-special',
        },
      },
    ])
  })

  test('projects the app-server terminal error instead of a generic failed label', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-failed')
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

  test('projects turn/start RPC errors as a terminal retryable response', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-start-error')
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
      taskId: 'turn-start-error-task',
      executionRequest: { prompt: 'first message' },
    })) as { taskId: string }
    client.turnStartFailure = new Error('Turn already running')

    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: created.taskId,
        message: 'must fail visibly',
      })
    ).rejects.toThrow('Turn already running')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(received.slice(-2)).toMatchObject([
      {
        event: 'response.created',
        payload: { taskId: created.taskId },
      },
      {
        event: 'response.failed',
        payload: {
          taskId: created.taskId,
          data: { message: 'Turn already running', retryable: true },
        },
      },
    ])
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: created.taskId, running: false }] }],
    })
    unlisten()
    runtime.dispose()
  })

  test('keeps a newly persisted task and reports a visible failure when its first turn is rejected', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-first-turn-error')
    client.turnStartFailure = new Error('attachment ownership rejected')
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
      taskId: 'first-turn-error-task',
      executionRequest: { prompt: 'keep this task' },
    })) as { taskId: string }
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(received.slice(-2)).toMatchObject([
      { event: 'response.created', payload: { taskId: created.taskId } },
      {
        event: 'response.failed',
        payload: {
          taskId: created.taskId,
          data: { message: 'attachment ownership rejected', retryable: true },
        },
      },
    ])
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: created.taskId, persisted: true, running: false }] }],
    })
    expect(client.requests.some(request => request.method === 'thread/delete')).toBe(false)
    unlisten()
    runtime.dispose()
  })

  test('treats an optimistic task goal lookup as pending instead of logging an address error', async () => {
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

  test('reads a persisted goal without resuming the thread owned by another client', async () => {
    const clients: FakeGatewayClient[] = []
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
    expect(clients[1].requests.map(item => item.method)).toEqual(['thread/goal/get'])
    runtime.dispose()
  })

  test('reacquires the task client when readonly goal load races a closing connection', async () => {
    const clients: FakeGatewayClient[] = []
    let failNextReadonlyClient = false
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
        const client = new FakeGatewayClient('thread-goal-reconnect')
        if (failNextReadonlyClient) {
          failNextReadonlyClient = false
          client.goalGetFailures.push(
            new GatewayRpcError(
              'KCoder app-server 连接已断开',
              -1,
              undefined,
              'runtime-session',
              'connection'
            )
          )
        }
        clients.push(client)
        return client
      },
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'goal-reconnect',
      executionRequest: { prompt: 'seed reconnect goal' },
    })) as { taskId: string }
    failNextReadonlyClient = true

    await expect(
      runtime.request('runtime.tasks.goal.get', {
        address: { deviceId: 'local', taskId: created.taskId, threadId: 'thread-goal-reconnect' },
      })
    ).resolves.toMatchObject({ accepted: true, taskId: created.taskId, goal: null })
    expect(clients).toHaveLength(3)
    expect(clients[0].closed).toBe(false)
    expect(clients[1].closed).toBe(true)
    expect(clients[2].closed).toBe(true)
    expect(clients[1].requests.map(item => item.method)).toEqual(['thread/goal/get'])
    expect(clients[2].requests.map(item => item.method)).toEqual(['thread/goal/get'])
    runtime.dispose()
  })

  test('does not retry unrelated readonly goal errors', async () => {
    const clients: FakeGatewayClient[] = []
    let failNextReadonlyClient = false
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
    mockIPC(() => undefined, { shouldMockEvents: true })
    const client = new FakeGatewayClient('thread-operations')
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
    expect(client.requests).toContainEqual({
      method: 'thread/goal/set',
      params: {
        threadId: 'thread-operations',
        objective: 'finish parity',
        mode: 'strict',
        verificationKind: 'answer',
        status: 'active',
        tokenBudget: 2000,
      },
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

  test('restores an empty failed assistant turn with its provider error', async () => {
    const client = new FakeGatewayClient('failed-history-thread')
    client.threadResumeSupported = true
    client.threadMessages = [
      {
        id: 'failed-history-user',
        turnId: 'turn-1',
        role: 'user',
        content: 'retry this prompt',
        timestampMs: 1_700_000_000_000,
      },
      {
        id: 'failed-history-assistant',
        turnId: 'turn-1',
        role: 'assistant',
        content: '',
        status: 'failed',
        error: 'provider unavailable',
        errorType: 'response.failed',
        timestampMs: 1_700_000_000_001,
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
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'failed-history-task',
      workspacePath: '/workspace',
      executionRequest: { prompt: 'retry this prompt' },
    })) as { taskId: string }

    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: created.taskId,
        threadId: 'failed-history-thread',
        deviceId: 'local',
      })
    ).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'retry this prompt' },
        {
          role: 'assistant',
          content: '',
          status: 'failed',
          error: 'provider unavailable',
          errorType: 'response.failed',
        },
      ],
    })
    runtime.dispose()
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
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:stale-thread', running: false }] }],
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

  test('derives the authoritative run activity from the server run summary', async () => {
    const client = new FakeGatewayClient(null)
    client.threadResumeSupported = true
    client.persistedThreads = [
      {
        id: 'waiting-thread',
        cwd: '/workspace',
        // The coarse status cannot express a pending approval.
        status: 'idle',
        runSummary: {
          mainTurn: 'running',
          pendingApprovals: 1,
          pendingQuestions: 0,
          activeJobs: 0,
          tasksPending: 0,
          tasksRunning: 0,
          pendingFollowups: 0,
          pendingGoals: 0,
        },
      },
      {
        id: 'background-thread',
        cwd: '/workspace',
        status: 'idle',
        runSummary: {
          mainTurn: 'idle',
          pendingApprovals: 0,
          pendingQuestions: 0,
          activeJobs: 0,
          tasksPending: 0,
          tasksRunning: 2,
          pendingFollowups: 0,
          pendingGoals: 0,
        },
      },
      {
        id: 'unknown-thread',
        cwd: '/workspace',
        status: 'idle',
        runSummary: {
          mainTurn: 'unknown',
          pendingApprovals: null,
          pendingQuestions: 0,
          activeJobs: 0,
          tasksPending: 0,
          tasksRunning: 0,
          pendingFollowups: 0,
          pendingGoals: 0,
        },
      },
      { id: 'legacy-thread', cwd: '/workspace', status: 'idle' },
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

    const listing = await runtime.request<{
      workspaces: Array<{ tasks: Array<{ taskId: string; runActivity?: string }> }>
    }>('runtime.tasks.list', {})
    const activity = new Map(
      listing.workspaces[0].tasks.map(task => [task.taskId, task.runActivity])
    )
    expect(activity.get('kcoder:local:waiting-thread')).toBe('waiting_approval')
    expect(activity.get('kcoder:local:background-thread')).toBe('background')
    expect(activity.get('kcoder:local:unknown-thread')).toBe('unknown')
    // A server without the capability keeps the coarse status meaning.
    expect(activity.get('kcoder:local:legacy-thread')).toBe('idle')
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
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:resumed-thread', running: false }] }],
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
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:resumed-thread', running: false }] }],
    })
    runtime.dispose()
  })

  test('opens a task on the server represented by its Wework project', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const connectedServerIds: string[] = []
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const clients: FakeGatewayClient[] = []
    const runtime = new KCoderGatewayRuntime('token', {
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
      command_key: 'workspace_create_directory',
      path: '/srv/project',
      args: ['notes'],
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
    expect(clients[1].requests).toContainEqual({
      method: 'device/execute',
      params: {
        deviceId: 'build-01',
        command_key: 'workspace_create_directory',
        path: '/srv/project',
        args: ['notes'],
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
    const reloaded = new KCoderGatewayRuntime('token', {
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

  test('hydrates persisted app-server threads and resumes one before a follow-up', async () => {
    const clients: FakeGatewayClient[] = []
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

  test('reads a persisted goal without acquiring the previous page session lease', async () => {
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

  test('forks a completed turn into an independently resumed task', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const clients: FakeGatewayClient[] = []
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
        const client = new FakeGatewayClient(clients.length === 0 ? 'thread-1' : 'fork-process')
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'source-draft',
      executionRequest: { prompt: 'first turn' },
    })
    clients[0].emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'thread-1-turn',
      turn: { id: 'thread-1-turn', status: 'completed' },
    })

    await expect(
      runtime.request('runtime.tasks.fork_at_turn', {
        taskId: 'kcoder:local:thread-1',
        source: { deviceId: 'local', taskId: 'kcoder:local:thread-1' },
        target: { deviceId: 'local', workspacePath: '/workspace' },
        lastTurnId: 'turn-1',
        title: 'forked task',
      })
    ).resolves.toEqual({
      success: true,
      accepted: true,
      source: { deviceId: 'local', taskId: 'kcoder:local:thread-1' },
      target: {
        deviceId: 'local',
        taskId: 'kcoder:local:thread-1-fork',
        threadId: 'thread-1-fork',
        workspacePath: '/workspace',
        runtimeHandle: { threadId: 'thread-1-fork' },
      },
      runtime: 'kcoder',
    })
    expect(clients[0].requests).toContainEqual({
      method: 'thread/fork',
      params: {
        threadId: 'thread-1',
        lastTurnId: 'turn-1',
        cwd: '/workspace',
        excludeTurns: true,
      },
    })
    expect(clients[1].requests).toContainEqual({
      method: 'thread/resume',
      params: { threadId: 'thread-1-fork' },
    })
    expect(
      JSON.parse(localStorage.getItem('kcoder-studio:task-metadata-v1') ?? '{}')
    ).toMatchObject({
      'local\u0000thread-1-fork': {
        title: 'forked task',
        parent: {
          taskId: 'kcoder:local:thread-1',
          threadId: 'thread-1',
          lastTurnId: 'turn-1',
        },
      },
    })
  })

  test('deletes a fork through its creator when the new owner cannot resume it', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const source = new FakeGatewayClient('thread-source-resume-failure')
    const rejectedOwner = new FakeGatewayClient('thread-rejected-owner')
    rejectedOwner.resumeFailure = new Error('resume failed')
    const clients = [source, rejectedOwner]
    let issuedClients = 0
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
      createClient: () => clients[issuedClients++]!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'source-resume-failure',
      executionRequest: { prompt: 'first turn' },
    })
    source.emitNotification('turn/completed', {
      threadId: 'thread-source-resume-failure',
      turnId: 'thread-source-resume-failure-turn',
      turn: { id: 'thread-source-resume-failure-turn', status: 'completed' },
    })

    await expect(
      runtime.request('runtime.tasks.fork_at_turn', {
        taskId: 'kcoder:local:thread-source-resume-failure',
        lastTurnId: 'turn-1',
      })
    ).resolves.toMatchObject({ accepted: false, code: 'fork_failed' })
    expect(source.requests).toContainEqual({
      method: 'thread/delete',
      params: { threadId: 'thread-source-resume-failure-fork' },
    })
    expect(rejectedOwner.requests.some(request => request.method === 'thread/delete')).toBe(false)
    expect(rejectedOwner.closed).toBe(true)
  })

  test('requires confirmation before restarting app servers with an active turn', async () => {
    const clients: FakeGatewayClient[] = []
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
        const client = new FakeGatewayClient('thread-1')
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'active-draft',
      executionRequest: { prompt: 'still running' },
    })
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { ifIdle: true })
    ).resolves.toEqual({ restarted: false, requiresConfirmation: true, activeTaskCount: 1 })
    expect(clients[0].closed).toBe(false)
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { force: true })
    ).resolves.toEqual({ restarted: true, requiresConfirmation: false, activeTaskCount: 1 })
    expect(clients[0].closed).toBe(true)
  })

  test('restarts a shared app server once per workspace while closing every task client', async () => {
    const clients: FakeGatewayClient[] = []
    let nextThread = 1
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
        const client = new FakeGatewayClient(`thread-${nextThread++}`)
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'first-draft',
      executionRequest: { prompt: 'first' },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'second-draft',
      executionRequest: { prompt: 'second' },
    })

    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { force: true })
    ).resolves.toMatchObject({ restarted: true })
    expect(
      clients
        .flatMap(client => client.requests)
        .filter(request => request.method === 'gateway/app-server/restart')
    ).toHaveLength(1)
    expect(clients.every(client => client.closed)).toBe(true)
  })

  test('projects app-server questions and returns the selected answer on the same turn', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-1')
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
    await runtime.request('runtime.tasks.create', {
      taskId: 'question-draft',
      executionRequest: { prompt: 'ask me' },
    })
    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 1_000_000,
          method: 'question/request',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            questionId: 'question-1000000',
            questions: [
              {
                id: 'question-1',
                header: 'Database',
                prompt: 'Which database?',
                options: [{ label: 'SQLite', value: 'SQLite', description: 'Keep state local.' }],
                allowsFreeform: true,
              },
            ],
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.created',
        payload: expect.objectContaining({
          taskId: 'kcoder:local:thread-1',
          data: expect.objectContaining({
            block: expect.objectContaining({
              tool_name: 'request_user_input',
              status: 'pending',
            }),
          }),
        }),
      })
    )

    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-1',
        address: { deviceId: 'local', taskId: 'kcoder:local:thread-1' },
        requestUserInputResponse: {
          requestId: 1_000_000,
          itemId: 'question-1000000',
          answers: { 'question-1': { answers: ['SQLite'] } },
        },
      })
    ).resolves.toMatchObject({ accepted: true, taskId: 'kcoder:local:thread-1' })
    expect(client.responses).toContainEqual({
      id: 1_000_000,
      result: {
        answers: { 'question-1': { answers: ['SQLite'] } },
        questionId: 'question-1000000',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    })
    expect(received).not.toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-1000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )
    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-1',
        requestUserInputResponse: {
          requestId: 1_000_000,
          answers: { 'question-1': { answers: ['SQLite'] } },
        },
      })
    ).resolves.toMatchObject({
      accepted: false,
      code: 'request_user_input_response_pending',
    })
    client.emitNotification('question/resolved', {
      requestId: 1_000_000,
      questionId: 'question-1000000',
      threadId: 'thread-1',
      turnId: 'turn-1',
      reason: 'client_response',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-1000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 1_000_001,
          method: 'question/request',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-interrupted',
            questionId: 'question-interrupted',
            questions: [{ id: 'question-1', prompt: 'Will this turn stop?', options: [] }],
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    client.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-interrupted',
      turn: { id: 'turn-interrupted', status: 'interrupted' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-1000001',
            updates: expect.objectContaining({
              status: 'error',
              tool_output: expect.stringContaining('未收到服务端确认'),
            }),
          }),
        }),
      })
    )
    await unlisten()
  })

  test('projects app-server approvals and returns an explicit fail-closed decision', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-approval')
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
    await runtime.request('runtime.tasks.create', {
      taskId: 'approval-draft',
      executionRequest: { prompt: 'run a command' },
    })
    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_000,
          method: 'approval/request',
          params: {
            serverId: 'server-1',
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-1',
            action: { type: 'command', command: 'cargo test --workspace' },
            reason: '运行工作区测试',
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.created',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            block: expect.objectContaining({
              tool_name: 'request_user_input',
              renderPayload: expect.objectContaining({
                itemId: 'approval-1',
                questions: [
                  expect.objectContaining({
                    id: 'approval-1',
                    header: 'Permission request',
                    options: expect.arrayContaining([
                      expect.objectContaining({ label: 'Allow once' }),
                      expect.objectContaining({ label: 'Decline' }),
                    ]),
                  }),
                ],
              }),
            }),
          }),
        }),
      })
    )

    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_000,
        itemId: 'approval-1',
        answers: { 'approval-1': { answers: ['Allow once'] } },
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_000,
      result: {
        decision: 'accept',
        approvalId: 'approval-1',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
    })
    expect(received).not.toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )
    client.emitNotification('approval/resolved', {
      requestId: 2_000_000,
      approvalId: 'approval-1',
      threadId: 'thread-approval',
      turnId: 'turn-approval',
      decision: 'accept',
      reason: 'client_response',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000000',
            updates: expect.objectContaining({ status: 'done' }),
          }),
        }),
      })
    )

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_001,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-2',
            action: { type: 'file_change', path: '/workspace/secret.txt' },
            reason: '修改文件',
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_001,
        itemId: 'approval-2',
        answers: {},
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_001,
      result: {
        decision: 'decline',
        approvalId: 'approval-2',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
    })
    expect(received.flatMap(event => JSON.stringify(event))).not.toContain(
      expect.stringContaining('Always allow for this session')
    )

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_007,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-file-without-root',
            action: { type: 'file_change', itemId: 'file-item-1' },
            reason: '修改当前工作区文件',
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.responses).not.toContainEqual({ id: 2_000_007, result: { decision: 'decline' } })
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_007,
        answers: { 'approval-file-without-root': { answers: ['Allow once'] } },
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_007,
      result: {
        decision: 'accept',
        approvalId: 'approval-file-without-root',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
    })

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_008,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-permissions',
            availableDecisions: ['accept', 'acceptForSession', 'decline'],
            action: {
              type: 'permission',
              cwd: '/workspace',
              permissions: { network: { enabled: true } },
            },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(JSON.stringify(received)).toContain('Always allow for this session')
    expect(JSON.stringify(received)).toContain('network')
    await runtime.request('runtime.tasks.send', {
      taskId: 'kcoder:local:thread-approval',
      requestUserInputResponse: {
        requestId: 2_000_008,
        answers: { 'approval-permissions': { answers: ['Always allow for this session'] } },
      },
    })
    expect(client.responses).toContainEqual({
      id: 2_000_008,
      result: {
        decision: 'accept_for_session',
        approvalId: 'approval-permissions',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
    })

    for (const id of [2_000_002, 2_000_003]) {
      client.dispatchEvent(
        new CustomEvent('request', {
          detail: {
            id,
            method: 'approval/request',
            params: {
              threadId: 'thread-approval',
              turnId: 'turn-approval',
              approvalId: `approval-${id}`,
              action: { type: 'command', command: `echo ${id}` },
            },
          },
        })
      )
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const id of [2_000_002, 2_000_003]) {
      await runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-approval',
        requestUserInputResponse: {
          requestId: id,
          itemId: `approval-${id}`,
          answers: { [`approval-${id}`]: { answers: ['拒绝'] } },
        },
      })
      expect(client.responses).toContainEqual({
        id,
        result: {
          decision: 'decline',
          approvalId: `approval-${id}`,
          threadId: 'thread-approval',
          turnId: 'turn-approval',
        },
      })
    }

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_005,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-timeout',
            action: { type: 'command', command: 'sleep 600' },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    client.emitNotification('approval/resolved', {
      requestId: 2_000_005,
      approvalId: 'approval-timeout',
      threadId: 'thread-approval',
      turnId: 'turn-approval',
      decision: 'decline',
      reason: 'timeout',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000005',
            updates: expect.objectContaining({
              status: 'error',
              tool_output: i18n.t('approvalUi.timeout'),
            }),
          }),
        }),
      })
    )
    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-approval',
        requestUserInputResponse: {
          requestId: 2_000_005,
          itemId: 'approval-timeout',
          answers: { 'approval-timeout': { answers: ['Allow once'] } },
        },
      })
    ).resolves.toMatchObject({ accepted: false, code: 'missing_request_user_input' })

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_004,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-unknown',
            action: { type: 'unknown', payload: 'cannot review' },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.responses).toContainEqual({
      id: 2_000_004,
      result: {
        decision: 'decline',
        approvalId: 'approval-unknown',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
      },
    })

    client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2_000_006,
          method: 'approval/request',
          params: {
            threadId: 'thread-approval',
            turnId: 'turn-approval',
            approvalId: 'approval-send-failure',
            action: { type: 'command', command: 'echo send-failure' },
          },
        },
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    client.respondFailure = new Error('socket closed before send')
    await expect(
      runtime.request('runtime.tasks.send', {
        taskId: 'kcoder:local:thread-approval',
        requestUserInputResponse: {
          requestId: 2_000_006,
          itemId: 'approval-send-failure',
          answers: { 'approval-send-failure': { answers: ['Allow once'] } },
        },
      })
    ).resolves.toMatchObject({
      accepted: false,
      code: 'request_user_input_send_failed',
    })
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({
          data: expect.objectContaining({
            blockId: 'request-user-input-2000006',
            updates: expect.objectContaining({
              status: 'error',
              tool_output: expect.stringContaining('socket closed before send'),
            }),
          }),
        }),
      })
    )
    await unlisten()
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

  test('keeps same-named turn buffers isolated across task processes', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const clients: FakeGatewayClient[] = []
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
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
        const client = new FakeGatewayClient(`thread-${clients.length + 1}`)
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-a',
      executionRequest: { prompt: 'A' },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-b',
      executionRequest: { prompt: 'B' },
    })

    clients[0].emitNotification('turn/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turn: { id: 'turn-1' },
    })
    clients[1].emitNotification('turn/started', {
      threadId: 'thread-2',
      turnId: 'turn-1',
      turn: { id: 'turn-1' },
    })
    clients[0].emitNotification('item/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: { text: 'answer-a' },
    })
    clients[0].emitNotification('item/event', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      event: { type: 'assistant_thinking_delta', text: 'checking-a' },
    })
    clients[1].emitNotification('item/delta', {
      threadId: 'thread-2',
      turnId: 'turn-1',
      delta: { text: 'answer-b' },
    })
    clients[0].emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    clients[1].emitNotification('turn/completed', {
      threadId: 'thread-2',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    await vi.waitFor(() => {
      expect(received.filter(event => event.event === 'response.completed')).toHaveLength(2)
    })
    await unlisten()

    const completed = received
      .filter(event => event.event === 'response.completed')
      .map(event => ({
        taskId: event.payload.taskId,
        value: (event.payload.data as Record<string, unknown>).value,
      }))
    expect(completed).toEqual(
      expect.arrayContaining([
        { taskId: 'kcoder:local:thread-1', value: 'answer-a' },
        { taskId: 'kcoder:local:thread-2', value: 'answer-b' },
      ])
    )
    expect(received).toContainEqual({
      event: 'response.reasoning_summary_text.delta',
      payload: {
        taskId: 'kcoder:local:thread-1',
        subtaskId: 'turn-1',
        deviceId: 'local',
        data: { delta: 'checking-a' },
      },
    })
  })

  test('links background subagent completion back to its original tool block', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-background-agent')
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
      taskId: 'background-agent-task',
      executionRequest: { prompt: 'delegate work' },
    })) as { taskId: string }

    client.emitNotification('item/started', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      item: {
        id: 'call-spawn-1',
        type: 'toolCall',
        name: 'spawn_agent',
        input: { task_name: 'reviewer', run_in_background: true },
      },
    })
    client.emitNotification('item/event', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      event: {
        type: 'background_job_associated',
        id: 'agent-job-1',
        tool_call_id: 'call-spawn-1',
        run_in_background: true,
      },
    })
    client.emitNotification('item/completed', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      item: {
        id: 'call-spawn-1',
        type: 'toolCall',
        name: 'spawn_agent',
        status: 'completed',
        output: '后台子 Agent 已启动',
      },
    })
    await expect
      .poll(
        () =>
          received.filter(event => {
            const data = event.payload.data as Record<string, unknown>
            const item = data?.item as Record<string, unknown> | undefined
            const output = item?.output as Record<string, unknown> | undefined
            return (
              event.event === 'response.output_item.done' &&
              item?.call_id === 'call-spawn-1' &&
              output?.status === 'running'
            )
          }).length
      )
      .toBeGreaterThan(0)
    client.emitNotification('item/event', {
      threadId: 'thread-background-agent',
      turnId: 'turn-background-agent',
      event: {
        type: 'background_job_completed',
        id: 'agent-job-1',
        text: '审查已完成',
        is_error: false,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(received).toContainEqual({
      event: 'response.output_item.done',
      payload: {
        taskId: created.taskId,
        subtaskId: 'turn-background-agent',
        deviceId: 'local',
        data: {
          item: {
            type: 'function_call',
            call_id: 'call-spawn-1',
            name: 'spawn_agent',
            status: 'completed',
            output: {
              agent_id: 'agent-job-1',
              status: 'completed',
              output: '审查已完成',
            },
          },
        },
      },
    })
    expect(
      received
        .filter(event => event.event === 'response.subagent.activity')
        .map(event => (event.payload.data as Record<string, unknown>).status)
    ).toEqual(['running', 'completed'])
    await unlisten()
  })

  test('interrupts the exact active turn and waits for completion before replacing it', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const client = new FakeGatewayClient('thread-1')
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
    await runtime.request('runtime.tasks.create', {
      taskId: 'task-a',
      executionRequest: { prompt: 'first' },
    })

    client.interruptResult = false
    await expect(
      runtime.request('runtime.tasks.cancel', {
        address: { taskId: 'kcoder:local:thread-1' },
      })
    ).resolves.toMatchObject({ accepted: false, interrupted: false })
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'thread-1-turn' },
    })

    client.interruptResult = true
    const replacement = runtime.request('runtime.tasks.interrupt_and_send', {
      address: { taskId: 'kcoder:local:thread-1' },
      executionRequest: { prompt: 'replacement' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'thread-1-turn' },
    })
    client.emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'thread-1-turn',
      turn: { id: 'thread-1-turn', status: 'interrupted' },
    })
    await expect(replacement).resolves.toMatchObject({
      accepted: true,
      taskId: 'kcoder:local:thread-1',
    })
    expect(client.requests.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'replacement' }],
      },
    })
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [{ taskId: 'kcoder:local:thread-1', running: true }] }],
    })
  })

  test('retains unknown creation and closes a client that returns a malformed result', async () => {
    const client = new FakeGatewayClient(null)
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
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'malformed',
        executionRequest: { prompt: 'hello' },
      })
    ).rejects.toThrow('无法确认会话是否已创建')
    expect(client.closed).toBe(true)
    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: [{ tasks: [] }],
    })
  })

  test('interrupts the foreground turn but preserves resident background jobs across reconnect', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const first = new FakeGatewayClient('thread-reconnect')
    const second = new FakeGatewayClient('thread-reconnect')
    const unexpectedThird = new FakeGatewayClient('thread-reconnect')
    let releaseResume: (() => void) | undefined
    second.resumeGate = new Promise<void>(resolve => {
      releaseResume = resolve
    })
    const clients = [first, second, unexpectedThird]
    let issuedClients = 0
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
      createClient: () => clients[issuedClients++]!,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'reconnect-task',
      executionRequest: { prompt: 'first message' },
    })) as { taskId: string }

    first.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.requests[0]).toEqual({
      method: 'thread/resume',
      params: { threadId: 'thread-reconnect' },
    })
    expect(received).toContainEqual(
      expect.objectContaining({
        event: 'response.failed',
        payload: expect.objectContaining({
          taskId: created.taskId,
          data: { message: 'KCoder app-server 连接已断开，已停止当前任务' },
        }),
      })
    )
    const sendAfterReconnect = runtime.request('runtime.tasks.send', {
      taskId: created.taskId,
      message: 'after reconnect',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(issuedClients).toBe(2)
    releaseResume?.()
    await expect(sendAfterReconnect).resolves.toMatchObject({
      accepted: true,
      taskId: created.taskId,
    })
    expect(
      second.requests.filter(request => request.method !== 'runtime.context.get').slice(0, 3)
    ).toEqual([
      { method: 'thread/resume', params: { threadId: 'thread-reconnect' } },
      { method: 'agent/list', params: { threadId: 'thread-reconnect' } },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-reconnect',
          input: [{ type: 'text', text: 'after reconnect' }],
        },
      },
    ])
    second.emitNotification('turn/completed', {
      threadId: 'thread-reconnect',
      turnId: 'thread-reconnect-turn',
      turn: { id: 'thread-reconnect-turn', status: 'completed' },
    })
    second.emitNotification('item/started', {
      threadId: 'thread-reconnect',
      turnId: 'turn-background',
      item: { id: 'call-background-disconnect', type: 'toolCall', name: 'spawn_agent', input: {} },
    })
    second.emitNotification('item/event', {
      threadId: 'thread-reconnect',
      turnId: 'turn-background',
      event: {
        type: 'background_job_associated',
        id: 'job-background-disconnect',
        tool_call_id: 'call-background-disconnect',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    second.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unexpectedThird.requests[0]).toEqual({
      method: 'thread/resume',
      params: { threadId: 'thread-reconnect' },
    })
    expect(
      received.some(
        event =>
          event.event === 'response.subagent.activity' &&
          (event.payload.data as Record<string, unknown>)?.agent_path ===
            'job-background-disconnect' &&
          (event.payload.data as Record<string, unknown>)?.status === 'interrupted'
      )
    ).toBe(false)
    unexpectedThird.emitNotification('item/event', {
      threadId: 'thread-reconnect',
      turnId: 'turn-background',
      event: {
        type: 'background_job_completed',
        id: 'job-background-disconnect',
        text: 'completed after reconnect',
      },
    })
    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.agent_path ===
              'job-background-disconnect' &&
            (event.payload.data as Record<string, unknown>)?.status === 'completed'
        )
      )
      .toBe(true)
    await unlisten()
  })

  test('waits for the latest reconnect generation before sending a new turn', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const first = new FakeGatewayClient('thread-reconnect-generation')
    const second = new FakeGatewayClient('thread-reconnect-generation')
    const third = new FakeGatewayClient('thread-reconnect-generation')
    let releaseSecondResume: (() => void) | undefined
    let releaseThirdResume: (() => void) | undefined
    second.resumeGate = new Promise<void>(resolve => {
      releaseSecondResume = resolve
    })
    third.resumeGate = new Promise<void>(resolve => {
      releaseThirdResume = resolve
    })
    const clients = [first, second, third]
    let issuedClients = 0
    let closedSecond = false
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => {
        const forwarded = event.payload
        const data = forwarded.payload as Record<string, unknown>
        const updates = data?.data as Record<string, unknown> | undefined
        const blockUpdates = updates?.updates as Record<string, unknown> | undefined
        if (
          !closedSecond &&
          forwarded.event === 'response.block.updated' &&
          blockUpdates?.status === 'done'
        ) {
          closedSecond = true
          second.close()
        }
      }
    )
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
      createClient: () => clients[issuedClients++]!,
    })
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'reconnect-generation-task',
      executionRequest: { prompt: 'first message' },
    })) as { taskId: string }

    first.close()
    const sendDuringRecovery = runtime.request('runtime.tasks.send', {
      taskId: created.taskId,
      message: 'send only after the latest recovery',
    })
    await expect
      .poll(() => second.requests[0])
      .toEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-reconnect-generation' },
      })
    releaseSecondResume?.()

    await expect
      .poll(() => third.requests[0])
      .toEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-reconnect-generation' },
      })
    expect(second.requests.some(request => request.method === 'turn/start')).toBe(false)

    releaseThirdResume?.()
    await expect(sendDuringRecovery).resolves.toMatchObject({ accepted: true })
    expect(third.requests.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-reconnect-generation',
        input: [{ type: 'text', text: 'send only after the latest recovery' }],
      },
    })
    await unlisten()
  })

  test('uses authoritative background completion after reconnect despite stale history', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event',
      event => received.push(event.payload)
    )
    const first = new FakeGatewayClient('thread-stale-background')
    const resumed = new FakeGatewayClient('thread-stale-background')
    const historyReader = new FakeGatewayClient('thread-stale-background')
    historyReader.threadResumeSupported = true
    historyReader.threadMessages = [
      {
        id: 'assistant-stale-background',
        turnId: 'turn-stale-background',
        role: 'assistant',
        content: '',
        blocks: [
          {
            id: 'call-stale-background',
            type: 'tool',
            toolName: 'spawn_agent',
            toolInput: { run_in_background: true },
            toolOutput: { agent_id: 'job-stale-background', status: 'running' },
            status: 'done',
          },
        ],
        timestampMs: 1700000000500,
      },
    ]
    const clients = [first, resumed, historyReader]
    let issuedClients = 0
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
      createClient: () => clients[issuedClients++]!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'stale-background-task',
      executionRequest: { prompt: 'spawn a background agent' },
    })
    first.emitNotification('item/started', {
      threadId: 'thread-stale-background',
      turnId: 'turn-stale-background',
      item: {
        id: 'call-stale-background',
        type: 'toolCall',
        name: 'spawn_agent',
        input: { run_in_background: true },
      },
    })
    first.emitNotification('item/event', {
      threadId: 'thread-stale-background',
      turnId: 'turn-stale-background',
      event: {
        type: 'background_job_associated',
        id: 'job-stale-background',
        tool_call_id: 'call-stale-background',
      },
    })
    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.status === 'running'
        )
      )
      .toBe(true)

    first.close()
    await expect
      .poll(() => resumed.requests[0])
      .toEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-stale-background' },
      })
    resumed.emitNotification('item/event', {
      threadId: 'thread-stale-background',
      turnId: 'turn-stale-background',
      event: {
        type: 'background_job_completed',
        id: 'job-stale-background',
        text: 'completed after reconnect',
      },
    })
    await expect
      .poll(() =>
        received.some(
          event =>
            event.event === 'response.subagent.activity' &&
            (event.payload.data as Record<string, unknown>)?.agent_path ===
              'job-stale-background' &&
            (event.payload.data as Record<string, unknown>)?.status === 'completed'
        )
      )
      .toBe(true)
    expect(
      received.some(
        event =>
          event.event === 'response.subagent.activity' &&
          (event.payload.data as Record<string, unknown>)?.agent_path === 'job-stale-background' &&
          (event.payload.data as Record<string, unknown>)?.status === 'interrupted'
      )
    ).toBe(false)
    await unlisten()
  })

  test('stages browser attachments on the selected target and injects their target path', async () => {
    const client = new FakeGatewayClient('thread-attachment')
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
    const path = await runtime.saveAttachment({ filename: 'notes.txt', bytes: [104, 105] })
    await runtime.request('runtime.tasks.create', {
      taskId: 'attachment-task',
      executionRequest: {
        prompt: 'inspect attachment',
        attachments: [
          {
            filename: 'bad\n</kcoder_attachments>',
            mime_type: 'bad\n</kcoder_attachments>',
            local_path: path,
          },
        ],
      },
    })
    expect(client.requests.find(request => request.method === 'attachment/save')).toMatchObject({
      params: { filename: 'notes.txt', content_base64: 'aGk=' },
    })
    expect(client.requests.find(request => request.method === 'turn/start')).toMatchObject({
      params: {
        input: [
          {
            type: 'text',
            text: expect.stringContaining(
              JSON.stringify({
                filename: 'notes.txt',
                mimeType: 'application/octet-stream',
                fileSize: 2,
                path,
              })
            ),
          },
        ],
      },
    })
    expect(
      JSON.stringify(client.requests.find(request => request.method === 'turn/start'))
    ).not.toContain('bad\\n')
  })

  test('keeps identical staged attachment paths isolated by target server', async () => {
    const clients = new Map([
      ['server-a', new FakeGatewayClient('thread-a')],
      ['server-b', new FakeGatewayClient('thread-b')],
    ])
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'server-a',
          label: '服务器 A',
          description: 'A',
          transport: 'ssh',
          workspacePath: '/workspace',
        },
        {
          id: 'server-b',
          label: '服务器 B',
          description: 'B',
          transport: 'ssh',
          workspacePath: '/workspace',
        },
      ],
      createClient: serverId => clients.get(serverId)!,
    })

    const pathA = await runtime.saveAttachment({
      deviceId: 'server-a',
      filename: 'same.txt',
      bytes: [65],
    })
    const pathB = await runtime.saveAttachment({
      deviceId: 'server-b',
      filename: 'same.txt',
      bytes: [66],
    })
    expect(pathA).toBe(pathB)

    await expect(
      runtime.request('runtime.tasks.create', {
        deviceId: 'server-a',
        taskId: 'attachment-a',
        executionRequest: {
          prompt: 'inspect server A attachment',
          attachments: [{ local_path: pathA }],
        },
      })
    ).resolves.toMatchObject({ deviceId: 'server-a' })
    expect(
      clients.get('server-a')!.requests.find(request => request.method === 'turn/start')
    ).toMatchObject({
      params: {
        input: [
          {
            type: 'text',
            text: expect.stringContaining(
              JSON.stringify({
                filename: 'same.txt',
                mimeType: 'application/octet-stream',
                fileSize: 1,
                path: pathA,
              })
            ),
          },
        ],
      },
    })
  })

  test('invalidates staged attachment paths when their command connection closes', async () => {
    const command = new FakeGatewayClient('command')
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
      createClient: () => command,
    })
    const path = await runtime.saveAttachment({ filename: 'ephemeral.txt', bytes: [1] })
    command.close()
    await expect(
      runtime.request('runtime.tasks.create', {
        taskId: 'stale-attachment',
        executionRequest: {
          prompt: 'must reject stale path',
          attachments: [{ local_path: path }],
        },
      })
    ).rejects.toThrow('附件不属于当前 KCoder 服务器')
  })

  test('adapts app-server terminal RPCs to the upstream remote terminal client', async () => {
    const client = new FakeGatewayClient('terminal-command')
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
    const session = await runtime.startTerminal('local', '/workspace')
    expect(session).toMatchObject({
      session_id: 'gateway-terminal:local:terminal-command-terminal',
      device_id: 'local',
      transport: 'socketio',
    })
    client.emitNotification('terminal/output', {
      session_id: 'terminal-command-terminal',
      data: 'shell ready\r\n',
    })
    const remote = runtime.createTerminalClient(session.session_id)
    const output = vi.fn()
    const exit = vi.fn()
    remote.onOutput(output)
    remote.onExit(exit)
    await remote.attach()
    expect(output).toHaveBeenCalledWith({
      session_id: session.session_id,
      data: 'shell ready\r\n',
    })
    await remote.resize(40, 120)
    await remote.write('pwd\n')
    client.emitNotification('terminal/exit', {
      session_id: 'terminal-command-terminal',
      exit_code: 0,
    })
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith({ session_id: session.session_id, exit_code: 0 })
    })
    await remote.resize(50, 140)
    await remote.write('ignored\n')
    await remote.close()
    expect(client.requests.slice(-2)).toEqual([
      {
        method: 'terminal/resize',
        params: { session_id: 'terminal-command-terminal', rows: 40, cols: 120 },
      },
      {
        method: 'terminal/write',
        params: { session_id: 'terminal-command-terminal', data: 'pwd\n' },
      },
    ])
    client.emitNotification('terminal/exit', {
      session_id: 'terminal-command-terminal',
      exit_code: 0,
    })
    expect(() => runtime.createTerminalClient(session.session_id)).toThrow('不存在')
  })

  test('restores a persisted terminal through app-server attach', async () => {
    const client = new FakeGatewayClient('restored-command')
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
    const publicSessionId = 'gateway-terminal:local:persisted-terminal'

    const session = await runtime.restoreTerminal('local', '/workspace', publicSessionId)

    expect(session).toMatchObject({
      session_id: publicSessionId,
      device_id: 'local',
      path: '/workspace',
    })
    expect(client.requests).toContainEqual({
      method: 'terminal/attach',
      params: { session_id: 'persisted-terminal', rows: 24, cols: 80 },
    })
    const output = vi.fn()
    const remote = runtime.createTerminalClient(publicSessionId)
    remote.onOutput(output)
    await remote.attach()
    expect(output).toHaveBeenCalledWith({
      session_id: publicSessionId,
      data: 'restored transcript\r\n',
    })
  })

  test('scopes workspace commands and terminals to the requested workspace root', async () => {
    const connections: Array<{ serverId: string; workspacePath?: string }> = []
    const clients: FakeGatewayClient[] = []
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/default-workspace',
        },
      ],
      createClient: (serverId, _token, _channel, workspacePath) => {
        connections.push({ serverId, workspacePath })
        const client = new FakeGatewayClient(`workspace-${clients.length}`)
        clients.push(client)
        return client
      },
    })

    await runtime.request('device.execute_command', {
      deviceId: 'local',
      command_key: 'workspace_tree',
      path: '/project-alpha',
    })
    await runtime.request('device.execute_command', {
      deviceId: 'local',
      command_key: 'git_status_porcelain',
      path: '/project-alpha',
    })
    await runtime.startTerminal('local', '/project-alpha')
    await runtime.request('device.execute_command', {
      deviceId: 'local',
      command_key: 'workspace_tree',
      path: '/project-beta',
    })

    expect(connections).toEqual([
      { serverId: 'local', workspacePath: '/project-alpha' },
      { serverId: 'local', workspacePath: '/project-beta' },
    ])
    expect(clients[0].requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'device/execute' }),
        {
          method: 'terminal/start',
          params: { cwd: '/project-alpha', rows: 24, cols: 80 },
        },
      ])
    )
  })

  test('isolates identical wire terminal ids from different gateway targets', async () => {
    const clients = new Map<string, FakeGatewayClient>()
    const runtime = new KCoderGatewayRuntime('token', {
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
          workspacePath: '/srv/project',
        },
      ],
      createClient: serverId => {
        const client = new FakeGatewayClient('same')
        clients.set(serverId, client)
        return client
      },
    })
    const local = await runtime.startTerminal('local', '/workspace')
    const remote = await runtime.startTerminal('build-01', '/srv/project')
    expect(local.session_id).not.toBe(remote.session_id)
    clients.get('local')?.emitNotification('terminal/output', {
      session_id: 'same-terminal',
      data: 'LOCAL',
    })
    clients.get('build-01')?.emitNotification('terminal/output', {
      session_id: 'same-terminal',
      data: 'REMOTE',
    })
    const localOutput = vi.fn()
    const remoteOutput = vi.fn()
    const localClient = runtime.createTerminalClient(local.session_id)
    const remoteClient = runtime.createTerminalClient(remote.session_id)
    localClient.onOutput(localOutput)
    remoteClient.onOutput(remoteOutput)
    await localClient.attach()
    await remoteClient.attach()
    expect(localOutput).toHaveBeenCalledWith({ session_id: local.session_id, data: 'LOCAL' })
    expect(remoteOutput).toHaveBeenCalledWith({ session_id: remote.session_id, data: 'REMOTE' })
  })

  test('binds a remote browser surface to the task server for its full lifetime', async () => {
    const connectedServerIds: string[] = []
    const connectedChannels: Array<string | undefined> = []
    const clients: FakeGatewayClient[] = []
    const runtime = new KCoderGatewayRuntime('token', {
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
          workspacePath: '/srv/project',
        },
      ],
      createClient: (serverId, _token, channel) => {
        connectedServerIds.push(serverId)
        connectedChannels.push(channel)
        const client = new FakeGatewayClient(
          clients.length === 0 ? 'thread-build-01' : 'browser-build-01'
        )
        clients.push(client)
        return client
      },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'remote-task',
      runtimeProjectKey: 'kcoder:build-01',
      executionRequest: {
        prompt: 'remote task',
        runtime_project_key: 'kcoder:build-01',
      },
    })
    const label = 'workspace-browser-kcoder-build-01-thread-build-01'
    await expect(
      runtime.openBrowser({
        label,
        url: 'https://example.test/',
        bounds: { x: 10, y: 20, width: 200, height: 100 },
      })
    ).resolves.toMatchObject({ url: 'https://example.test/' })
    expect(connectedServerIds).toEqual(['build-01', 'build-01'])
    expect(connectedChannels).toEqual(['runtime', 'browser'])
    expect(document.querySelector('[data-testid="kcoder-remote-browser-surface"]')).toHaveStyle({
      opacity: '0',
      pointerEvents: 'none',
    })

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(clients[1].requests).toContainEqual({
      method: 'browser/screenshot',
      params: { session_id: 'browser-build-01-browser' },
    })
    const surface = document.querySelector<HTMLImageElement>(
      '[data-testid="kcoder-remote-browser-surface"]'
    )!
    expect(surface).toHaveStyle({ opacity: '1', pointerEvents: 'auto' })
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 210,
      bottom: 120,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    })
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300)
    surface.dispatchEvent(new MouseEvent('pointerdown', { clientX: 110, clientY: 70 }))
    surface.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 45 }))
    surface.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 95 }))
    surface.dispatchEvent(new MouseEvent('pointerup', { clientX: 110, clientY: 70 }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(
      clients[1].requests
        .filter(request => request.method === 'browser/action')
        .map(request => request.params)
    ).toEqual([
      { session_id: 'browser-build-01-browser', action: 'pointer_down', x: 160, y: 120 },
      { session_id: 'browser-build-01-browser', action: 'pointer_move', x: 240, y: 180 },
      { session_id: 'browser-build-01-browser', action: 'pointer_up', x: 160, y: 120 },
    ])
    await runtime.controlBrowser(label, {
      action: 'navigate',
      url: 'https://example.test/next',
    })
    expect(runtime.readBrowserPageState(label)).toMatchObject({
      nativeLabel: expect.stringContaining('build-01'),
      url: 'https://example.test/next',
      title: 'Navigated',
    })
    await expect(runtime.evaluateBrowser({ label, expression: '({ ok: true })' })).resolves.toEqual(
      { ok: true, value: { ok: true } }
    )
    await runtime.relabelBrowser(label, 'workspace-browser-transferred')
    await runtime.closeBrowser('workspace-browser-transferred')
    expect(clients[1].closed).toBe(true)
    expect(document.querySelector('[data-testid="kcoder-remote-browser-surface"]')).toBeNull()
    expect(clients[1].requests.at(-1)).toEqual({
      method: 'browser/close',
      params: { session_id: 'browser-build-01-browser' },
    })
  })

  test('stops frame polling and rejects state reads after browser disconnect', async () => {
    const client = new FakeGatewayClient('browser-disconnect')
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
    await runtime.openBrowser({
      label: 'workspace-browser-disconnect',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    client.close()
    const screenshots = client.requests.filter(
      request => request.method === 'browser/screenshot'
    ).length
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(client.requests.filter(request => request.method === 'browser/screenshot')).toHaveLength(
      screenshots
    )
    expect(() => runtime.readBrowserPageState('workspace-browser-disconnect')).toThrow('连接已断开')
    expect(document.querySelector('[data-testid="kcoder-remote-browser-surface"]')).toHaveAttribute(
      'data-connection',
      'disconnected'
    )
    await runtime.closeBrowser('workspace-browser-disconnect')
    expect(client.requests.filter(request => request.method === 'browser/close')).toHaveLength(0)
  })
})
