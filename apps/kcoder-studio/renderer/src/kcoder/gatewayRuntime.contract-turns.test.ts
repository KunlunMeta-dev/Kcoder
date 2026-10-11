import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { GatewayRpcError } from './gatewayRpc'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime } from './installGatewayRuntime'
import { KCODER_RUNTIME_METHODS } from './legacyRuntimeAbi'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway turns (%s)', (_entry, RuntimeConstructor) => {
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
          proxyUrl: _entry === 'installed' ? 'http://127.0.0.1:7890' : '',
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
})
