import { listen } from '@tauri-apps/api/event'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime } from './installGatewayRuntime'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway resources (%s)', (_entry, RuntimeConstructor) => {
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
