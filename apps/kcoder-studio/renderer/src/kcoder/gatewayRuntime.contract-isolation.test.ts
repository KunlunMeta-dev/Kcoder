import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime, readGatewayRuntimeConfig } from './installGatewayRuntime'
import { LEGACY_KCODER_STUDIO_STORAGE_KEYS } from './legacyRuntimeAbi'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway isolation (%s)', (_entry, RuntimeConstructor) => {
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
  test('migrates the legacy Wework runtime config key without keeping ambiguous storage', () => {
    localStorage.setItem(
      LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig,
      JSON.stringify({ remoteAppsEnabled: false })
    )

    expect(readGatewayRuntimeConfig().remoteAppsEnabled).toBe(false)
    expect(localStorage.getItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig)).toBeNull()
    expect(localStorage.getItem('kcoder-studio:kcoder-runtime-config-v1')).not.toBeNull()
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
})
