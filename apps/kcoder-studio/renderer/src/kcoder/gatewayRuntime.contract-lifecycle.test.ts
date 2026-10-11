import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime } from './installGatewayRuntime'
import { KCODER_RUNTIME_METHODS } from './legacyRuntimeAbi'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway lifecycle (%s)', (_entry, RuntimeConstructor) => {
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
      name: 'AbortError',
      code: 'KCODER_WORKSPACE_SCAN_CANCELLED',
    })

    expect(consoleWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('无法同步 当前虚拟机 的持久任务'),
      expect.anything()
    )
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
})
