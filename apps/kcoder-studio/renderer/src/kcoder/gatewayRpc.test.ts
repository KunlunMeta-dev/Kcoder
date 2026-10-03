import { afterEach, describe, expect, test, vi } from 'vitest'
import { classifyPluginFailure } from '@/components/plugins/plugin-errors'
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
  safeGatewayFailureDiagnostic,
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
  static attempts = 0
  readyState = WebSocket.CONNECTING

  constructor() {
    super()
    FailingWebSocket.attempts++
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

  test('catalog cancellation drops only its pending request and ignores the late frame', async () => {
    const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    await client.connect()
    const controller = new AbortController()
    const request = client.request('runtime.models.list', {}, { signal: controller.signal })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const socket = FakeWebSocket.instances[0]
    const catalogFrame = JSON.parse(socket.sent.at(-1)!)
    controller.abort()
    await rejected
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect((client as unknown as { pending: Map<number, unknown> }).pending.has(catalogFrame.id)).toBe(false)
    socket.respond(catalogFrame.id, { models: ['stale'] })
    const other = client.request('server/info')
    const otherFrame = JSON.parse(socket.sent.at(-1)!)
    socket.respond(otherFrame.id, { available: true })
    await expect(other).resolves.toEqual({ available: true })
    client.close()
  })

  test('limits handshakes across clients and cancels a queued disposed client', async () => {
    FakeWebSocket.autoInitialize = false
    const clients = Array.from(
      { length: 6 },
      (_, index) =>
        new GatewayRpcClient(
          `budget-${index}`,
          'token',
          FakeWebSocket as unknown as typeof WebSocket
        )
    )
    const outcomes = Promise.allSettled(clients.map(client => client.connect()))
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))
    clients[4].close()
    for (const socket of FakeWebSocket.instances.slice()) {
      await vi.waitFor(() =>
        expect(socket.sent.some(raw => JSON.parse(raw).method === 'initialize')).toBe(true)
      )
      socket.respond(1)
    }
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(5))
    const last = FakeWebSocket.instances[4]
    await vi.waitFor(() => expect(last.sent.length).toBeGreaterThan(0))
    last.respond(1)
    expect((await outcomes).map(outcome => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ])
    clients.forEach(client => client.close())
  })

  test.each(['gateway', 'account'] as const)(
    'stops transport retries once %s authentication fails',
    async mode => {
      FailingWebSocket.attempts = 0
      const changed = vi.fn()
      window.addEventListener('kcoder:account-context-invalidated', changed)
      const fetchImpl = vi.fn().mockResolvedValue(
        mode === 'gateway'
          ? { ok: false, status: 401, json: async () => ({}) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                servers: [{ id: 'expired', security: { identity: { mode: 'kcoder-account' } } }],
              }),
            }
      ) as unknown as typeof fetch
      const client = new GatewayRpcClient(
        'expired',
        'token',
        FailingWebSocket as unknown as typeof WebSocket,
        'runtime',
        undefined,
        fetchImpl
      )
      await expect(client.request('thread/list', {})).rejects.toMatchObject({ code: 401 })
      expect(FailingWebSocket.attempts).toBe(1)
      if (mode === 'account') {
        expect(navigateGatewayLogin).not.toHaveBeenCalled()
        expect(changed).toHaveBeenCalledWith(
          expect.objectContaining({ detail: expect.objectContaining({ targetId: 'expired' }) })
        )
      }
      window.removeEventListener('kcoder:account-context-invalidated', changed)
    }
  )

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
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/servers',
      expect.objectContaining({ cache: 'no-store' })
    )
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
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/servers',
      expect.objectContaining({ cache: 'no-store' })
    )
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
        capabilities: {
          experimental: {
            toolPathPreviewV1: true,
            threadRunSummaryV1: true,
            interactionBindingV1: true,
            turnRetryOperationV1: true,
          },
        },
      },
    })
    expect(messages[1]).toMatchObject({ method: 'initialized' })
    expect(client.supportsExperimental('workspaceFiles')).toBe(true)
    expect(client.supportsExperimental('toolPathPreviewV1')).toBe(false)
    expect(client.supportsExperimental('unknown')).toBe(false)
    expect(client.supportsThreadResume()).toBe(true)
  })

  test.each([
    ['plugin/install', 'network_reset', 'unreachable', 'plugin-install'],
    ['plugin/install', 'policy_denied', 'forbidden', 'plugin-install'],
    ['plugin/install', 'network_tls', 'tls', 'plugin-install'],
    ['marketplace/add', 'proxy_failed', 'proxy', 'marketplace-manage'],
    ['plugin/install', 'cancelled', 'cancelled', 'plugin-install'],
    ['marketplace/add', 'not_found', 'not-found', 'marketplace-manage'],
    ['plugin/install', 'plugin_operation_failed', 'unknown', 'plugin-install'],
  ])(
    'classifies serialized RPC failure for %s/%s without exposing payload',
    async (method, kind, code, phase) => {
      const client = new GatewayRpcClient(
        'local',
        'test-token',
        FakeWebSocket as unknown as typeof WebSocket
      )
      await client.connect()
      const request = client.request(method, {})
      const socket = FakeWebSocket.instances[0]
      const frame = JSON.parse(socket.sent.at(-1)!)
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: {
              code: -32050,
              message: 'https://user:secret@example.test/?token=secret',
              data: { kind },
            },
          }),
        })
      )
      const error = await request.catch(error => error)
      expect(error).toBeInstanceOf(GatewayRpcError)
      expect(error).toMatchObject({ reason: 'remote', operation: phase })
      const failure = classifyPluginFailure(error)
      expect(failure).toMatchObject({ code, phase })
      expect(JSON.stringify(failure)).not.toContain('secret')
      client.close()
    }
  )

  test.each([
    ['diagnostics/storage/read', 'storage-scan'],
    ['diagnostics/storage/clean', 'storage-clean'],
    ['cron/preview', 'schedule-preview'],
    ['runtime.providers.validate', 'provider-probe'],
    ['runtime.providers.upsert', 'provider-save'],
    ['runtime.models.list', 'model-catalog'],
  ])('keeps safe scoped diagnostic metadata for %s', async (method, phase) => {
    const diagnosticLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new GatewayRpcClient(
      'remote-fixture',
      'test-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    const request = client.request(method, { threadId: '12345678-1234-1234-1234-123456789abc', turnId: 'private prompt secret' })
    const socket = FakeWebSocket.instances[0]
    const frame = JSON.parse(socket.sent.at(-1)!)
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          error: {
            code: -32034,
            message: 'https://secret@example.test/?token=secret',
            data: { prompt: 'private prompt', apiKey: 'secret' },
          },
        }),
      })
    )
    const error = await request.catch(error => error)
    expect(error.diagnostic).toEqual({
      code: -32034,
      phase,
      reason: 'remote',
      targetId: 'remote-fixture',
      connectionId: expect.stringMatching(/^rpc-\d+-\d+$/),
      requestId: frame.id,
      threadId: '12345678-1234-1234-1234-123456789abc',
      turnId: null,
      retryable: true,
    })
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/secret|prompt|example.test/)
    expect(diagnosticLog).toHaveBeenCalledWith('[kcoder-rpc-failure]', error.diagnostic)
    diagnosticLog.mockRestore()
    expect(
      new GatewayRpcError('unknown outcome', -1, undefined, 'provider-save', 'connection')
        .diagnostic.retryable
    ).toBe(false)
    client.close()
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


test('diagnostic context whitelists runtime identifiers and cannot copy arbitrary payload fields', () => {
  const context = { connectionId: 'https://secret.invalid', requestId: 9,
    threadId: 'private prompt', turnId: '12345678-1234-1234-1234-123456789abc', token: 'secret' }
  const error = new GatewayRpcError('private error', -1, { token: 'secret' }, 'runtime-session', 'connection', 'local', context)
  expect(error.diagnostic).toMatchObject({ connectionId: 'unknown', requestId: 9, threadId: null,
    turnId: '12345678-1234-1234-1234-123456789abc' })
  expect(JSON.stringify(error.diagnostic)).not.toMatch(/secret|private|token|invalid/)
})


test('generic runtime errors never expose their message or attached payload in diagnostics', () => {
  const error = Object.assign(new Error('private prompt and secret key'), { response: 'private response', headers: { Authorization: 'secret' } })
  expect(safeGatewayFailureDiagnostic(error)).toEqual({ code: -1, phase: 'runtime-session', reason: 'unknown', retryable: false })
  expect(JSON.stringify(safeGatewayFailureDiagnostic({ diagnostic: { token: 'secret' }, message: 'private' }))).not.toMatch(/private|secret|token/)
})


test('diagnostics retain canonical turn sequence identifiers', () => {
  const error = new GatewayRpcError('failed', -1, undefined, 'runtime-session', 'remote', 'local', {
    connectionId: 'rpc-1-1', requestId: 3, threadId: '12345678-1234-1234-1234-123456789abc', turnId: 'turn-2',
  })
  expect(error.diagnostic).toMatchObject({ turnId: 'turn-2', requestId: 3 })
})
