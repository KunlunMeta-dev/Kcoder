import { afterEach, describe, expect, test, vi } from 'vitest'
import { navigateGatewayLogin } from './gatewayLoginNavigation'
import {
  fetchGatewayServers,
  fetchGatewayServersWithHealth,
  removeGatewayServer,
  saveGatewayServer,
  testGatewayServer,
  gatewayToken,
  GatewayRpcClient,
  GatewayRpcError,
  isKCoderDesktopHostPage,
  isKCoderGatewayPage,
  resetGatewayLoginRedirectForTests,
  submitKCoderGatewayLogout,
} from './gatewayRpc'

vi.mock('./gatewayLoginNavigation', () => ({ navigateGatewayLogin: vi.fn() }))

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = []
  static autoInitialize = true
  static autoRespond = false
  readonly url: string
  readonly sent: string[] = []
  readyState = WebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  send(raw: string) {
    this.sent.push(raw)
    const request = JSON.parse(raw) as { id?: number; method?: string }
    if (request.id === undefined) return
    if (request.method === 'initialize') {
      if (FakeWebSocket.autoInitialize) queueMicrotask(() => this.respond(request.id!))
      return
    }
    if (FakeWebSocket.autoRespond) queueMicrotask(() => this.respond(request.id!, {}))
  }

  respond(
    id: number,
    result: unknown = {
      protocolVersion: '2026-07-27',
      capabilities: {
        threadResume: true,
        experimental: {
          browserAttachments: true,
          terminalSessions: true,
          workspaceFiles: true,
        },
      },
    }
  ) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id, result }),
      })
    )
  }

  close() {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

class FailingWebSocket extends EventTarget {
  readyState = WebSocket.CONNECTING

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED
      this.dispatchEvent(new Event('error'))
    })
  }

  send() {}
  close() {
    this.readyState = WebSocket.CLOSED
  }
}

describe('KCoder gateway RPC boundary', () => {
  afterEach(() => {
    resetGatewayLoginRedirectForTests()
    FakeWebSocket.instances = []
    FakeWebSocket.autoInitialize = true
    FakeWebSocket.autoRespond = false
    document.head.innerHTML = ''
    document.body.querySelectorAll('form[action="/logout"]').forEach(form => form.remove())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  test('returns to login when a websocket reconnect reveals an expired gateway session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch
    const client = new GatewayRpcClient(
      'local',
      'expired-capability-token',
      FailingWebSocket as unknown as typeof WebSocket,
      'runtime',
      undefined,
      fetchImpl
    )

    await expect(client.connect()).rejects.toThrow('无法连接 KCoder app-server')
    await vi.waitFor(() => expect(navigateGatewayLogin).toHaveBeenCalledTimes(1))
    expect(fetchImpl).toHaveBeenCalledWith('/api/servers', { cache: 'no-store' })
  })

  test('classifies an in-flight websocket close as a connection failure', async () => {
    const client = new GatewayRpcClient(
      'local',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()

    const pending = client.request('thread/goal/get', { threadId: 'thread-1' })
    FakeWebSocket.instances[0].close()

    await expect(pending).rejects.toMatchObject({
      name: 'GatewayRpcError',
      operation: 'runtime-session',
      reason: 'connection',
    })
  })

  test('activates only when the gateway injected its capability token', () => {
    expect(gatewayToken()).toBeNull()
    expect(isKCoderGatewayPage()).toBe(false)
    document.head.innerHTML = '<meta name="kcoder-rpc-token" content="capability-token">'
    expect(gatewayToken()).toBe('capability-token')
    expect(isKCoderGatewayPage()).toBe(true)
    expect(isKCoderDesktopHostPage()).toBe(false)
    document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-desktop-host" content="1">')
    expect(isKCoderDesktopHostPage()).toBe(true)
  })

  test('submits gateway logout as a same-origin POST form', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)

    submitKCoderGatewayLogout()

    const form = document.body.querySelector('form')
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('action', '/logout')
    expect(form).toHaveAttribute('hidden')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  test('validates the same-origin server registry response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [
          {
            id: 'local',
            label: '当前虚拟机',
            description: '本机',
            transport: 'local',
            workspacePath: '/workspace',
          },
        ],
      }),
    })
    await expect(fetchGatewayServers(fetchImpl as unknown as typeof fetch)).resolves.toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledWith('/api/servers', { cache: 'no-store' })
  })

  test('accepts an empty configured registry as a valid empty state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ servers: [] }),
    })

    await expect(fetchGatewayServers(fetchImpl as unknown as typeof fetch)).resolves.toEqual([])
  })

  test('exposes stable operation and reason metadata for localized HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    })

    const error = await fetchGatewayServers(fetchImpl as unknown as typeof fetch).catch(
      value => value
    )
    expect(error).toBeInstanceOf(GatewayRpcError)
    expect(error).toMatchObject({ operation: 'list-targets', reason: 'http', code: 503 })
  })

  test('redirects an expired gateway session only once across concurrent target requests', async () => {
    const unauthorized = () => Promise.resolve({ ok: false, status: 401, json: async () => ({}) })
    const listFetch = vi.fn(unauthorized) as unknown as typeof fetch
    const healthFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          servers: [
            { id: 'local', label: 'Local', description: '', runtime: 'kcoder', transport: 'local' },
          ],
        }),
      })
      .mockImplementationOnce(unauthorized) as unknown as typeof fetch
    const results = await Promise.allSettled([
      fetchGatewayServers(listFetch),
      fetchGatewayServersWithHealth(healthFetch),
    ])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(
      results.map(result => (result.status === 'rejected' ? result.reason.message : ''))
    ).toEqual([expect.stringMatching(/登录已失效/), expect.stringMatching(/登录已失效/)])
    expect(navigateGatewayLogin).toHaveBeenCalledTimes(1)
  })

  test('merges probed online state and latency into configured servers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          servers: [
            { id: 'local', label: '本机', description: 'Local', transport: 'local' },
            { id: 'ssh', label: 'SSH', description: 'Remote', transport: 'ssh', host: 'host' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          statuses: [
            { id: 'local', status: 'online', latencyMs: 12 },
            { id: 'ssh', status: 'offline', latencyMs: 10004, error: 'Connection timed out' },
          ],
        }),
      })
    await expect(
      fetchGatewayServersWithHealth(fetchImpl as unknown as typeof fetch)
    ).resolves.toEqual([
      expect.objectContaining({ id: 'local', status: 'online', latencyMs: 12 }),
      expect.objectContaining({ id: 'ssh', status: 'offline', error: 'Connection timed out' }),
    ])
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/servers/status', { cache: 'no-store' })
  })

  test('keeps configured targets manageable when health probing is unavailable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          servers: [
            { id: 'local', label: 'Local', description: '', runtime: 'kcoder', transport: 'local' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })

    await expect(
      fetchGatewayServersWithHealth(fetchImpl as unknown as typeof fetch)
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'local',
        status: 'unavailable',
        healthError: expect.any(String),
      }),
    ])
  })

  test('marks a target omitted by the health response as unknown instead of offline', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          servers: [
            { id: 'local', label: 'Local', description: '', runtime: 'kcoder', transport: 'local' },
            { id: 'new', label: 'New', description: '', runtime: 'kcoder', transport: 'local' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ statuses: [{ id: 'local', status: 'online', latencyMs: 3 }] }),
      })

    const servers = await fetchGatewayServersWithHealth(fetchImpl as unknown as typeof fetch)
    expect(servers.find(server => server.id === 'new')).toMatchObject({ status: 'unknown' })
  })

  test('writes, tests, and removes SSH targets through same-origin JSON endpoints', async () => {
    const server = {
      id: 'gpu-01',
      label: 'GPU',
      description: 'SSH',
      transport: 'ssh' as const,
      host: '100.64.0.21',
      user: 'devuser',
      port: 2222,
      workspacePath: '/data/project',
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ server }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, protocolVersion: '2026-07-27' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ removed: 'gpu-01' }) })
    await expect(saveGatewayServer(server, fetchImpl as unknown as typeof fetch)).resolves.toEqual(
      server
    )
    await expect(
      testGatewayServer(server, fetchImpl as unknown as typeof fetch)
    ).resolves.toMatchObject({ ok: true })
    await expect(
      removeGatewayServer('gpu-01', fetchImpl as unknown as typeof fetch)
    ).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls.map(call => [call[0], call[1]?.method])).toEqual([
      ['/api/servers/gpu-01', 'PUT'],
      ['/api/servers/test', 'POST'],
      ['/api/servers/gpu-01', 'DELETE'],
    ])
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ 'content-type': 'application/json' })
    const saveBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    const testBody = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(saveBody).toEqual({
      id: 'gpu-01',
      label: 'GPU',
      description: 'SSH',
      runtime: 'kcoder',
      transport: 'ssh',
      host: '100.64.0.21',
      user: 'devuser',
      port: 2222,
      workspace: '/data/project',
    })
    expect(testBody).toEqual(saveBody)
  })

  test('strips health and SSH-only fields from local target mutations', async () => {
    const server = {
      id: 'local-two',
      label: 'Local two',
      description: 'Local',
      runtime: 'kcoder' as const,
      transport: 'local' as const,
      workspacePath: '/workspace',
      command: 'kcoder',
      host: 'stale-host',
      user: 'stale-user',
      port: 2222,
      acceptNewHostKey: true,
      status: 'offline' as const,
      latencyMs: 1000,
      checkedAt: 123,
      error: 'stale error',
      capabilities: { terminalSessions: true },
    }
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ server }),
    })

    await saveGatewayServer(server, fetchImpl as unknown as typeof fetch)

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      id: 'local-two',
      label: 'Local two',
      description: 'Local',
      runtime: 'kcoder',
      transport: 'local',
      command: 'kcoder',
      workspace: '/workspace',
    })
  })

  test('treats a successful HTTP response with a failed connection result as an actionable error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        error: 'ssh: connect to host 127.0.0.1 port 1: Connection refused',
      }),
    })
    await expect(
      testGatewayServer(
        {
          id: 'offline',
          label: 'Offline',
          description: 'SSH',
          transport: 'ssh',
          host: '127.0.0.1',
          port: 1,
        },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow('Connection refused')
  })

  test('rejects a malformed save response instead of corrupting the target list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    await expect(
      saveGatewayServer(
        {
          id: 'target',
          label: 'Target',
          description: '',
          runtime: 'kcoder',
          transport: 'local',
        },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/无效响应/)
  })

  test('sends the typed protocol version before declaring initialization complete', async () => {
    const client = new GatewayRpcClient(
      'local',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()

    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toContain('/rpc?')
    expect(socket.url).toContain('token=capability-token')
    expect(socket.url).toContain('server=local')
    const messages = socket.sent.map(raw => JSON.parse(raw) as Record<string, unknown>)
    expect(messages[0]).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-27',
        capabilities: { experimental: { toolPathPreviewV1: true } },
      },
    })
    expect(messages[1]).toMatchObject({ method: 'initialized' })
    expect(client.supportsExperimental('workspaceFiles')).toBe(true)
    expect(client.supportsExperimental('toolPathPreviewV1')).toBe(false)
    expect(client.supportsExperimental('unknown')).toBe(false)
    expect(client.supportsThreadResume()).toBe(true)
  })

  test('shares one full handshake across concurrent connect calls', async () => {
    FakeWebSocket.autoInitialize = false
    const client = new GatewayRpcClient(
      'local',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    let secondResolved = false
    const first = client.connect()
    const second = client.connect().then(() => {
      secondResolved = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(secondResolved).toBe(false)
    const socket = FakeWebSocket.instances[0]
    const initialize = socket.sent
      .map(raw => JSON.parse(raw))
      .find(item => item.method === 'initialize')
    expect(initialize).toBeTruthy()
    socket.respond(initialize.id)
    await Promise.all([first, second])
    expect(
      socket.sent.map(raw => JSON.parse(raw)).filter(item => item.method === 'initialize')
    ).toHaveLength(1)
  })

  test('marks dedicated browser connections for the gateway-wide quota', async () => {
    const client = new GatewayRpcClient(
      'build-01',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket,
      'browser'
    )
    await client.connect()
    const url = new URL(FakeWebSocket.instances[0].url)
    expect(url.searchParams.get('server')).toBe('build-01')
    expect(url.searchParams.get('channel')).toBe('browser')
  })

  test('binds a task connection to its selected workspace', async () => {
    const client = new GatewayRpcClient(
      'build-01',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket,
      'runtime',
      '/srv/worktrees/task-1'
    )
    await client.connect()

    const url = new URL(FakeWebSocket.instances[0].url)
    expect(url.searchParams.get('server')).toBe('build-01')
    expect(url.searchParams.get('workspace')).toBe('/srv/worktrees/task-1')
  })

  test('dispatches server requests and sends a JSON-RPC response', async () => {
    const client = new GatewayRpcClient(
      'local',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    const socket = FakeWebSocket.instances[0]
    const requests: Array<Record<string, unknown>> = []
    client.addEventListener('request', event => {
      const message = (event as CustomEvent<Record<string, unknown>>).detail
      requests.push(message)
      client.respond(Number(message.id), { answers: { 'question-1': { answers: ['SQLite'] } } })
    })

    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: 1_000_000,
          method: 'question/request',
          params: { questionId: 'question-1', questions: [] },
        }),
      })
    )

    expect(requests).toHaveLength(1)
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 1_000_000,
      result: { answers: { 'question-1': { answers: ['SQLite'] } } },
    })
  })

  describe('lazy reconnect', () => {
    test('request reconnects after the socket closes', async () => {
      FakeWebSocket.autoRespond = true
      FakeWebSocket.instances.length = 0
      const client = new GatewayRpcClient(
        'server-1',
        'token',
        FakeWebSocket as unknown as typeof WebSocket
      )
      const first = client.request('thread/list', {})
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      const firstSocket = FakeWebSocket.instances[0]
      await vi.waitFor(() => expect(firstSocket.readyState).toBe(WebSocket.OPEN))
      await vi.waitFor(() =>
        expect(firstSocket.sent.some(raw => raw.includes('"thread/list"'))).toBe(true)
      )
      firstSocket.close()

      const second = client.request('thread/list', {})
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
      expect(FakeWebSocket.instances[1].url).toContain('token=token')
      await vi.waitFor(() =>
        expect(FakeWebSocket.instances[1].sent.some(raw => raw.includes('"initialize"'))).toBe(true)
      )
      await expect(second).resolves.toBeDefined()
      await expect(first).resolves.toBeDefined()
    })

    test('concurrent requests during a reconnect share one socket', async () => {
      FakeWebSocket.autoRespond = true
      FakeWebSocket.instances.length = 0
      const client = new GatewayRpcClient(
        'server-1',
        'token',
        FakeWebSocket as unknown as typeof WebSocket
      )
      await client.connect()
      FakeWebSocket.instances[0].close()
      const pending = Promise.all([
        client.request('thread/list', {}),
        client.request('thread/list', {}),
        client.request('thread/list', {}),
      ])
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
      await expect(pending).resolves.toHaveLength(3)
      expect(FakeWebSocket.instances).toHaveLength(2)
    })

    test('reconnect gives up after the bounded attempts', async () => {
      const client = new GatewayRpcClient(
        'server-1',
        'token',
        FailingWebSocket as unknown as typeof WebSocket
      )
      await expect(client.request('thread/list', {})).rejects.toThrow(/无法连接 KCoder app-server/)
    }, 15_000)
  })
})
