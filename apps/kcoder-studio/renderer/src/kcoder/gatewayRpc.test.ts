import { afterEach, describe, expect, test, vi } from 'vitest'
import { classifyPluginFailure } from '@/components/plugins/plugin-errors'
import { navigateGatewayLogin } from './gatewayLoginNavigation'
import { listenChannelBindingChanges } from './channelBindingEvents'
import { subscribeRuntimeWorkChanged } from './runtimeWorkEvents'
import { notifyAccountContextChange, verifiedAccountContextScopes } from './accountContextEvents'
import { INTEGRATION_CONTROL_CAPABILITIES } from '../../../shared/integrationControlMethods.mjs'
import {
  fetchGatewayServers,
  fetchGatewayServerStatuses,
  fetchGatewayServersWithHealth,
  removeGatewayServer,
  saveGatewayServer,
  testGatewayServer,
  gatewayToken,
  GatewayRpcClient,
  GatewayRpcError,
  GatewayRpcTimeoutError,
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
  test('ordinary notifications reuse their current immutable connection identity without allocating another snapshot', async () => {
    const client = new GatewayRpcClient('identity-cost-target', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    const observed: Array<typeof client.diagnosticConnection> = []
    client.addEventListener('notification', () => observed.push(client.diagnosticConnection))
    try {
      await client.connect()
      const identity = client.diagnosticConnection, socket = FakeWebSocket.instances.at(-1)!
      const freeze = vi.spyOn(Object, 'freeze')
      let allocations = 0
      try {
        for (let sequence = 0; sequence < 100; sequence++) socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc: '2.0', method: 'item/delta', params: {
            threadId: 'owned-thread', turnId: 'owned-turn', sequence, delta: { text: 'sample' },
          } }),
        }))
        allocations = freeze.mock.calls.filter(([value]) => value?.targetId === identity.targetId &&
          value?.connectionId === identity.connectionId).length
      } finally { freeze.mockRestore() }
      console.info(JSON.stringify({ notifications: observed.length, connectionIdentityAllocations: allocations }))
      expect(observed).toHaveLength(100)
      expect(new Set(observed).size).toBe(1)
      expect(observed[0]).toBe(identity)
      expect(Object.isFrozen(identity)).toBe(true)
      expect(allocations).toBe(0)
    } finally { client.close() }
  })

  test('reconnecting replaces the identity without changing captured old metadata or accepting the old socket', async () => {
    const client = new GatewayRpcClient('identity-generation-target', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    const initial = client.diagnosticConnection
    const notification = vi.fn()
    client.addEventListener('notification', notification)
    try {
      await client.connect()
      const first = client.diagnosticConnection, oldSocket = FakeWebSocket.instances.at(-1)!
      expect(first.connectionId).not.toBe(initial.connectionId)
      const captured = { ...first }
      oldSocket.close()
      await client.connect()
      const current = client.diagnosticConnection
      expect(current.connectionId).not.toBe(first.connectionId)
      expect(current.targetId).toBe(first.targetId)
      expect(first).toEqual(captured)
      expect(client.diagnosticConnection).toBe(current)
      const frame = new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'item/delta', params: {} }) })
      oldSocket.dispatchEvent(frame)
      expect(notification).not.toHaveBeenCalled()
      FakeWebSocket.instances.at(-1)!.dispatchEvent(frame)
      expect(notification).toHaveBeenCalledTimes(1)
    } finally { client.close() }
  })
  for (const method of ['question/request', 'approval/request']) {
    test.each([null, '1.0', 2].flatMap(jsonrpc => [41, 'original-id'].map(id => ({ jsonrpc, id }))))(
      `${method} rejects version $jsonrpc before delivering request $id`, async ({ jsonrpc, id }) => {
      const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
      try {
        await client.connect()
        const socket = FakeWebSocket.instances.at(-1)!
        const request = vi.fn(), notification = vi.fn()
        client.addEventListener('request', request)
        client.addEventListener('notification', notification)
        const frame = { id, method, params: { threadId: 'thread', turnId: 'turn',
          ...(method === 'question/request' ? { questionId: 'question' } : { approvalId: 'approval' }) } }
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...frame, jsonrpc }) }))
        expect(request).not.toHaveBeenCalled()
        expect(notification).not.toHaveBeenCalled()
        expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual(['initialize', 'initialized'])
        // Invalid frames cannot reserve a card or retire the original request ID.
        for (const version of [undefined, '2.0']) {
          const valid = { ...frame, ...(version === undefined ? {} : { jsonrpc: version }) }
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(valid) }))
          expect((request.mock.calls.at(-1)![0] as CustomEvent).detail).toEqual(valid)
        }
        expect(request).toHaveBeenCalledTimes(2)
      } finally { client.close() }
    })
  }

  test.each(['question/request', 'approval/request'])(
    '%s preserves a string request ID through delivery and reply', async method => {
      const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
      try {
        await client.connect()
        const socket = FakeWebSocket.instances.at(-1)!
        const request = vi.fn(), notification = vi.fn()
        client.addEventListener('request', request)
        client.addEventListener('notification', notification)
        const frame = { jsonrpc: '2.0', id: 'original-interaction', method,
          params: { threadId: 'thread', turnId: 'turn' } }
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
        expect(request).toHaveBeenCalledOnce()
        expect((request.mock.calls[0][0] as CustomEvent).detail).toEqual(frame)
        expect(notification).not.toHaveBeenCalled()
        client.respond(frame.id, { accepted: true })
        expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
          jsonrpc: '2.0', id: frame.id, result: { accepted: true },
        })
        client.respondError(frame.id, -32601, 'Unsupported request')
        expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
          id: frame.id, error: { code: -32601 },
        })
      } finally { client.close() }
    }
  )

  test('channel invalidations reuse runtime notifications and resynchronize after reconnect', async () => {
    const changed = vi.fn(), stop = listenChannelBindingChanges(changed)
    const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    try {
      await client.connect()
      expect(changed).not.toHaveBeenCalled()
      const socket = FakeWebSocket.instances.at(-1)!
      const observerId = new URL(socket.url).searchParams.get('channelObserver')
      expect(observerId).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        jsonrpc: '2.0', method: 'gateway/channels/changed', params: {},
      }) }))
      expect(changed).toHaveBeenCalledOnce()
      socket.close()
      await client.connect()
      const replacement = FakeWebSocket.instances.at(-1)!
      expect(new URL(replacement.url).searchParams.get('channelObserver')).toBe(observerId)
      expect(changed).toHaveBeenCalledOnce()
      replacement.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        jsonrpc: '2.0', method: 'gateway/channels/changed', params: {},
      }) }))
      expect(changed).toHaveBeenCalledTimes(2)
    } finally { client.close(); stop() }
  })

  test('authenticated activity invalidations refresh the work list without exposing a conversation', async () => {
    const changed = vi.fn(), stop = subscribeRuntimeWorkChanged(changed)
    const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    try {
      await client.connect()
      const socket = FakeWebSocket.instances.at(-1)!
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        jsonrpc: '2.0', method: 'gateway/runtimeActivity/changed', params: {},
      }) }))
      expect(changed).toHaveBeenCalledOnce()
    } finally { client.close(); stop() }
  })

  test('transient reads opt out of channel observation and ordinary connections share the page identity', async () => {
    const first = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    const other = new GatewayRpcClient('remote', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    const transient = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    transient.setChannelInventoryObservation(false)
    try {
      await first.connect(); await other.connect(); await transient.connect()
      const ids = FakeWebSocket.instances.map(socket => new URL(socket.url).searchParams.get('channelObserver'))
      expect(ids[0]).toBe(ids[1])
      expect(ids[2]).toBe('none')
      expect(() => first.setChannelInventoryObservation(false)).toThrow('already initialized')
    } finally { first.close(); other.close(); transient.close() }
  })

  for (const method of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
    test.each([null, '1.0', 2].flatMap(jsonrpc => [false, true].map(remoteError => ({ jsonrpc, remoteError }))))(
      `${method} rejects an invalid version ($jsonrpc, remote error=$remoteError)`, async ({ jsonrpc, remoteError }) => {
      const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
      try {
        await client.connect()
        const socket = FakeWebSocket.instances.at(-1)!
        const result = { threadId: 'original-thread', questions: [] }
        const pending = client.request(method, { threadId: 'original-thread' }).then(
          value => ({ value, error: undefined }), error => ({ value: undefined, error }))
        const request = JSON.parse(socket.sent.at(-1)!)
        socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc, id: request.id,
            ...(remoteError ? { error: { code: -32602, message: 'Unconfirmed refusal' } } : { result }) }),
        }))
        const outcome = await pending
        expect(outcome.error).toMatchObject({ reason: 'invalid-response', code: -1 })
        expect(outcome.value).toBeUndefined()
        socket.respond(request.id, result)
        const reading = client.request('asyncQuestion/list', { threadId: 'original-thread' })
        socket.respond(JSON.parse(socket.sent.at(-1)!).id, result)
        expect(await reading).toEqual(result)
        expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual([
          'initialize', 'initialized', method, 'asyncQuestion/list',
        ])
      } finally { client.close() }
    })

    test.each([undefined, '2.0'])(`${method} preserves version compatibility: %j`, async jsonrpc => {
      const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
      try {
        await client.connect()
        const socket = FakeWebSocket.instances.at(-1)!
        const result = { threadId: 'original-thread' }
        const pending = client.request(method, { threadId: 'original-thread' })
        socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc, id: JSON.parse(socket.sent.at(-1)!).id, result }),
        }))
        expect(await pending).toEqual(result)
      } finally { client.close() }
    })
  }

  afterEach(() => {
    vi.useRealTimers()
    resetGatewayLoginRedirectForTests()
    FakeWebSocket.instances = []
    FakeWebSocket.autoInitialize = true
    FakeWebSocket.autoRespond = false
    document.head.innerHTML = ''
    document.body.querySelectorAll('form[action="/logout"]').forEach(form => form.remove())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  test('relay-mounted gateways keep HTTP and WebSocket traffic inside their prefix', async () => {
    const base = document.createElement('meta')
    base.name = 'kcoder-app-base-path'
    base.content = '/g/owned-gateway'
    document.head.appendChild(base)
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) })
    await fetchGatewayServers(fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledWith('/g/owned-gateway/api/servers', { cache: 'no-store', signal: expect.any(AbortSignal) })
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    try {
      await client.connect()
      expect(new URL(FakeWebSocket.instances[0].url).pathname).toBe('/g/owned-gateway/rpc')
    } finally {
      client.close()
    }
  })

  test.each(['runtime', 'browser'] as const)(
    'requests finite integration capabilities and scopes shared conversations to the %s channel',
    async channel => {
      const client = new GatewayRpcClient(
        'local',
        'fixture-token',
        FakeWebSocket as unknown as typeof WebSocket,
        channel
      )
      await client.connect()
      const initialize = FakeWebSocket.instances[0].sent
        .map(raw => JSON.parse(raw))
        .find(frame => frame.method === 'initialize')
      for (const capability of INTEGRATION_CONTROL_CAPABILITIES)
        expect(initialize.params.capabilities.experimental[capability]).toBe(true)
      expect(initialize.params.capabilities.experimental.computerUseTurnStatusV1).toBe(true)
      expect(initialize.params.capabilities.experimental.officeWorkspaceV1).toBe(true)
      expect(initialize.params.capabilities.experimental.gatewaySharedThreadsV1).toBe(
        channel === 'runtime'
      )
      client.close()
    }
  )

  test('management socket closing before open rejects immediately', async () => {
    vi.useFakeTimers()
    class ClosingBeforeOpen extends EventTarget {
      readyState = WebSocket.CONNECTING
      constructor() {
        super()
        queueMicrotask(() => { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')) })
      }
      close() { this.readyState = WebSocket.CLOSED }
    }
    const client = new GatewayRpcClient('local', 'fixture-token', ClosingBeforeOpen as unknown as typeof WebSocket)
    client.useNativeManagementTransport()
    let outcome: unknown
    const pending = client.connect().then(() => { outcome = 'success' }, error => { outcome = error })
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(outcome).toMatchObject({ reason: 'connection' })
    } finally {
      client.close()
      await vi.advanceTimersByTimeAsync(300_000)
      await pending
    }
  })

  test('management connection closes before initialize without waiting for its own reconnect', async () => {
    vi.useFakeTimers()
    class ClosingSocket extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url)
        queueMicrotask(() => this.close())
      }
    }
    const client = new GatewayRpcClient('local', 'fixture-token', ClosingSocket as unknown as typeof WebSocket)
    client.useNativeManagementTransport()
    let outcome: unknown
    const pending = client.connect().then(() => { outcome = 'success' }, error => { outcome = error })
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(outcome).toMatchObject({ reason: 'connection' })
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(FakeWebSocket.instances[0].sent).toEqual([])
    } finally {
      client.close()
      await vi.advanceTimersByTimeAsync(300_000)
      await pending
    }
  })

  test('SDK management selects an isolated transport and refuses task execution', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    client.useNativeManagementTransport()
    try {
      await client.connect()
      const socket = FakeWebSocket.instances[0]
      expect(new URL(socket.url).searchParams.get('nativeManagement')).toBe('1')
      const initialize = socket.sent
        .map(raw => JSON.parse(raw))
        .find(frame => frame.method === 'initialize')
      expect(initialize.params.capabilities.experimental).toMatchObject({
        gatewaySharedThreadsV1: false,
        taskSourcesV1: false,
        threadRuntimeHandoffV1: false,
      })
      const sent = socket.sent.length
      await expect(client.request('thread/start', {})).rejects.toThrow(
        'cannot execute task commands'
      )
      await expect(client.request('gateway/app-server/restart', { confirm: true })).rejects.toThrow(
        'cannot execute task commands'
      )
      expect(socket.sent).toHaveLength(sent)
      FakeWebSocket.autoRespond = true
      await expect(client.request('plugin/proxy/status', {})).resolves.toEqual({})
      await expect(client.request('plugin/proxy/configure', { enabled: false })).resolves.toEqual({})
      for (const method of ['plugin/list', 'plugin/install', 'runtime.models.list', 'plugin/proxy/status/extra']) {
        const before = socket.sent.length
        await expect(client.request(method, {})).rejects.toThrow('cannot execute task commands')
        expect(socket.sent).toHaveLength(before)
      }
      await expect(
        client.request('gateway/client/detach', { confirm: true, force: false })
      ).resolves.toEqual({})
      expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
        method: 'gateway/client/detach',
        params: { confirm: true, force: false },
      })
    } finally {
      client.close()
    }
  })

  test('an online socket cannot keep a read request pending forever', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    let failure: unknown
    const request = client.request('workflow/list').catch(error => {
      failure = error
    })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(failure).toMatchObject({ reason: 'timeout', data: { outcome: 'readOnly' } })
    await request
    expect(FakeWebSocket.instances[0].readyState).toBe(WebSocket.OPEN)
    client.close()
  })

  test('Feishu registration keeps its own typed reply projection on the real websocket client', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    const fields = {
      requestId: 'original-feishu',
      action: 'create',
      scope: {
        accountId: 'owned',
        targetId: 'target',
        workspaceId: null,
        identityGeneration: '1',
        targetRevision: '1',
      },
      connectionRef: { id: 'draft', revision: '1' },
    }
    const pending = client.request('integrations/connectivity/feishuRegistration', fields)
    const socket = FakeWebSocket.instances[0]
    const sent = socket.sent
      .map(raw => JSON.parse(raw))
      .find(frame => frame.method === 'integrations/connectivity/feishuRegistration')
    const result = {
      requestId: fields.requestId,
      connectionRef: fields.connectionRef,
      phase: 'waiting',
      verificationUrl: 'https://open.feishu.cn/page/launcher?owned-fixture=1',
      expiresAtMs: 10000,
      intervalMs: 5000,
      appId: null,
      credential: null,
    }
    socket.respond(sent.id, result)
    await expect(pending).resolves.toEqual(result)
    client.close()
  })

  test.each([
    'knowledge/imageImport/list',
    'workflow/runs/archive/list',
    'workflow/runs/archive/read',
  ])('an online socket expires the verified read %s with a readonly outcome', async method => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    const request = client.request(method).catch(error => error)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await request).toMatchObject({ reason: 'timeout', data: { outcome: 'readOnly' } })
    expect(FakeWebSocket.instances[0].readyState).toBe(WebSocket.OPEN)
    client.close()
  })

  test('image resume keeps a longer finite deadline and archive confirmation remains a mutation', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    const resumed = vi.fn()
    const archived = vi.fn()
    const resume = client.request('knowledge/imageImport/resume', {}).catch(resumed)
    const archive = client.request('workflow/runs/archive', { confirm: true }).catch(archived)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(resumed).not.toHaveBeenCalled()
    expect(archived).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(90_000)
    await archive
    expect(archived.mock.calls[0][0]).toMatchObject({
      reason: 'timeout',
      data: { outcome: 'unknown', timeoutMs: 120_000 },
    })
    expect(resumed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(180_000)
    await resume
    expect(resumed.mock.calls[0][0]).toMatchObject({
      reason: 'timeout',
      data: { outcome: 'unknown', timeoutMs: 300_000 },
    })
    const sent = FakeWebSocket.instances[0].sent.map(raw => JSON.parse(raw))
    expect(sent.filter(frame => frame.method === 'knowledge/imageImport/resume')).toHaveLength(1)
    expect(sent.filter(frame => frame.method === 'workflow/runs/archive')).toHaveLength(1)
    client.close()
  })

  test.each([
    ['en', /read request timed out/, /server may still complete/],
    ['zh-CN', /读取请求超时/, /服务端仍可能完成操作/],
  ])(
    'timeout errors use the application translations in %s without initializing the transport',
    async (language, readMessage, unknownMessage) => {
      const { default: appI18n } = await import('@/i18n')
      const previous = appI18n.language
      try {
        await appI18n.changeLanguage(String(language))
        expect(new GatewayRpcTimeoutError('workflow/list', 30_000, 'local').message).toMatch(
          readMessage
        )
        expect(new GatewayRpcTimeoutError('workflow/create', 120_000, 'local').message).toMatch(
          unknownMessage
        )
      } finally {
        await appI18n.changeLanguage(previous)
      }
    }
  )

  test('a write timeout reports unknown outcome and never resends the mutation', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    let failure: unknown
    const request = client.request('workflow/create', { title: 'Owned fixture' }).catch(error => {
      failure = error
    })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(failure).toMatchObject({ reason: 'timeout', data: { outcome: 'unknown' } })
    await request
    const socket = FakeWebSocket.instances[0]
    const writes = socket.sent
      .map(raw => JSON.parse(raw))
      .filter(frame => frame.method === 'workflow/create')
    expect(writes).toHaveLength(1)
    socket.respond(writes[0].id, { created: true })
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0)
    client.close()
  })

  test('an unknown list-shaped method remains a mutation with the longer deadline', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    const failure = vi.fn()
    const request = client.request('custom/list', {}).catch(failure)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(failure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(90_000)
    await request
    expect(failure.mock.calls[0][0]).toMatchObject({
      reason: 'timeout',
      data: { outcome: 'unknown' },
    })
    client.close()
  })

  test('aborting a connection waiter never submits its mutation or closes the shared connection', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const controller = new AbortController()
    const cancelled = client.request('workflow/create', {}, { signal: controller.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    await client.connect()
    const socket = FakeWebSocket.instances[0]
    const read = client.request('workflow/list')
    socket.respond(JSON.parse(socket.sent.at(-1)!).id, { items: [] })
    await expect(read).resolves.toEqual({ items: [] })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.sent.some(raw => JSON.parse(raw).method === 'workflow/create')).toBe(false)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    client.close()
  })

  test('late receipts cannot settle a new read, while another pending thread remains usable', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    const socket = FakeWebSocket.instances[0]
    const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    const controller = new AbortController()
    const first = client
      .request('workflow/read', { id: 'one' }, { signal: controller.signal })
      .catch(error => error)
    const firstId = JSON.parse(socket.sent.at(-1)!).id
    const second = client.request('workflow/create', { title: 'other thread' })
    const secondId = JSON.parse(socket.sent.at(-1)!).id
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await first).toMatchObject({ reason: 'timeout', data: { outcome: 'readOnly' } })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    const latest = client.request('workflow/read', { id: 'one' })
    const latestId = JSON.parse(socket.sent.at(-1)!).id
    socket.respond(firstId, { obsolete: true })
    socket.respond(secondId, { created: true })
    socket.respond(latestId, { latest: true })
    await expect(second).resolves.toEqual({ created: true })
    await expect(latest).resolves.toEqual({ latest: true })
    expect(vi.getTimerCount()).toBe(0)
    client.close()
  })

  test('explicit long deadlines stay finite and abort/resolve/remote rejection clear timers', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    vi.useFakeTimers()
    const socket = FakeWebSocket.instances[0]
    const controller = new AbortController()
    const aborted = client.request(
      'workflow/read',
      {},
      { signal: controller.signal, timeoutMs: 60_000 }
    )
    const rejected = expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    const success = client.request('workflow/read')
    socket.respond(JSON.parse(socket.sent.at(-1)!).id, {})
    await success
    const remote = client.request('workflow/read')
    const remoteRejected = expect(remote).rejects.toMatchObject({ reason: 'remote' })
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          id: JSON.parse(socket.sent.at(-1)!).id,
          error: { code: -32000, message: 'Fixture rejection' },
        }),
      })
    )
    await remoteRejected
    expect(vi.getTimerCount()).toBe(0)
    await expect(client.request('workflow/read', {}, { timeoutMs: 0 })).rejects.toThrow(RangeError)
    client.close()
  })

  test('catalog cancellation drops only its pending request and ignores the late frame', async () => {
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    const controller = new AbortController()
    const request = client.request('runtime.models.list', {}, { signal: controller.signal })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const socket = FakeWebSocket.instances[0]
    const catalogFrame = JSON.parse(socket.sent.at(-1)!)
    controller.abort()
    await rejected
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(
      (client as unknown as { pending: Map<number, unknown> }).pending.has(catalogFrame.id)
    ).toBe(false)
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

  test('concurrent failed socket clients share their unfinished session directory check', async () => {
    FailingWebSocket.attempts = 0
    const finish: Array<(response: Response) => void> = []
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve) })) as typeof fetch
    const clients = ['runtime-A', 'runtime-B', 'browser-C'].map((id, index) => new GatewayRpcClient(
      id, 'fixture-token', FailingWebSocket as unknown as typeof WebSocket,
      index === 2 ? 'browser' : 'runtime', undefined, fetchImpl
    ))
    const connections = clients.map(client => client.connect().catch(error => error))
    try {
      await vi.waitFor(() => expect(FailingWebSocket.attempts).toBe(3))
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      finish.forEach(resolve => resolve(Response.json({ servers: [] })))
      await Promise.all(connections)
      clients.forEach(client => client.close())
    }
  })

  test('failed socket clients keep independent five-second waits on a shared directory read', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })) as typeof fetch
    const clients = ['timeout-A', 'timeout-B'].map(id => new GatewayRpcClient(
      id, 'fixture-token', FailingWebSocket as unknown as typeof WebSocket, 'runtime', undefined, fetchImpl))
    let firstDone = false, secondDone = false
    const first = clients[0].connect().catch(() => { firstDone = true })
    let second: Promise<void> | undefined
    try {
      await vi.advanceTimersByTimeAsync(1000)
      second = clients[1].connect().catch(() => { secondDone = true })
      await vi.advanceTimersByTimeAsync(4000)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(firstDone).toBe(true)
      expect(secondDone).toBe(false)
      expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(secondDone).toBe(true)
      expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(true)
    } finally {
      clients.forEach(client => client.close())
      await vi.advanceTimersByTimeAsync(6000)
      await Promise.all([first, second])
      vi.useRealTimers()
    }
  })

  test.each(['account', 'gateway'] as const)('closing a failed socket client releases its login check and ignores late %s failure', async mode => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
    const changed = vi.fn()
    window.addEventListener('kcoder:account-context-invalidated', changed)
    const client = new GatewayRpcClient('closed-login-owner', 'fixture-token',
      FailingWebSocket as unknown as typeof WebSocket, 'runtime', undefined, fetchImpl)
    let settled = false
    const connected = client.connect().catch(() => { settled = true })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      client.close()
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(true)
      // Deliberately ignore transport cancellation to test late-response side effects.
      finish(mode === 'gateway' ? Response.json({}, { status: 401 }) : Response.json({ servers: [
        { id: 'closed-login-owner', security: { identity: { mode: 'kcoder-account' } } },
      ] }))
      await vi.advanceTimersByTimeAsync(0)
      expect(changed).not.toHaveBeenCalled()
      expect(navigateGatewayLogin).not.toHaveBeenCalled()
    } finally {
      client.close()
      finish(Response.json({ servers: [] }))
      await vi.advanceTimersByTimeAsync(0)
      await connected
      window.removeEventListener('kcoder:account-context-invalidated', changed)
      vi.useRealTimers()
    }
  })

  test('closing one failed client preserves its peer and cannot invalidate the departed account', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
    const changed = vi.fn()
    window.addEventListener('kcoder:account-context-invalidated', changed)
    const clients = ['departed-login-owner', 'live-login-peer'].map(id => new GatewayRpcClient(
      id, 'fixture-token', FailingWebSocket as unknown as typeof WebSocket, 'runtime', undefined, fetchImpl))
    let departedSettled = false, peerSettled = false
    const connected = [clients[0].connect().catch(() => { departedSettled = true }),
      clients[1].connect().catch(() => { peerSettled = true })]
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      clients[0].close()
      await vi.advanceTimersByTimeAsync(0)
      expect(departedSettled).toBe(true)
      expect(peerSettled).toBe(false)
      expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(false)
      finish(Response.json({ servers: [
        { id: 'departed-login-owner', security: { identity: { mode: 'kcoder-account' } } },
        { id: 'live-login-peer', transport: 'local' },
      ] }))
      await vi.advanceTimersByTimeAsync(0)
      expect(peerSettled).toBe(true)
      expect(changed).not.toHaveBeenCalled()
      expect(navigateGatewayLogin).not.toHaveBeenCalled()
    } finally {
      clients.forEach(client => client.close())
      finish(Response.json({ servers: [] }))
      await vi.advanceTimersByTimeAsync(0)
      await Promise.all(connected)
      window.removeEventListener('kcoder:account-context-invalidated', changed)
      vi.useRealTimers()
    }
  })

  test('a cancelled directory subscriber ignores a late unauthorized HTTP response before navigation', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
    const controller = new AbortController()
    const pending = fetchGatewayServers(fetchImpl, { signal: controller.signal }).catch(error => error)
    try {
      controller.abort()
      expect(await pending).toMatchObject({ name: 'AbortError' })
      finish(Response.json({}, { status: 401 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(navigateGatewayLogin).not.toHaveBeenCalled()
    } finally {
      finish(Response.json({ servers: [] }))
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  test.each(['directory', 'health'].flatMap(kind =>
    ['account', 'configuration', 'mount'].map(boundary => ({ kind, boundary }))))(
    '$kind rejects obsolete 401 after $boundary changes while current 401 still navigates', async ({ kind, boundary }) => {
      const prefix = document.createElement('meta')
      prefix.name = 'kcoder-app-base-path'
      document.head.append(prefix)
      try {
        prefix.content = `/g/old-${kind}-${boundary}`
        const finish: Array<(response: Response) => void> = []
        const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve) })) as typeof fetch
        const read = () => kind === 'directory' ? fetchGatewayServers(fetchImpl) : fetchGatewayServerStatuses(fetchImpl)
        const obsolete = read().catch(error => error)
        if (boundary === 'account') notifyAccountContextChange(`obsolete-${kind}`)
        else if (boundary === 'configuration') window.dispatchEvent(new Event('kcoder:servers-changed'))
        else prefix.content = `/g/current-${kind}-${boundary}`
        const current = read()
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        finish[0](Response.json({}, { status: 401 }))
        const oldError = await obsolete
        expect(navigateGatewayLogin).not.toHaveBeenCalled()
        expect(oldError).toMatchObject({ name: 'AbortError' })
        finish[1](Response.json(kind === 'directory'
          ? { servers: [{ id: 'fresh-scope', label: 'Current', transport: 'local' }] }
          : { statuses: [{ id: 'fresh-scope', status: 'online' }] }))
        await expect(current).resolves.toMatchObject([{ id: 'fresh-scope' }])
        const expired = read().catch(error => error)
        expect(fetchImpl).toHaveBeenCalledTimes(3)
        finish[2](Response.json({}, { status: 401 }))
        expect(await expired).toMatchObject({ reason: 'unauthorized', code: 401 })
        expect(navigateGatewayLogin).toHaveBeenCalledTimes(1)
      } finally { prefix.remove() }
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
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/servers/status', { cache: 'no-store', signal: expect.any(AbortSignal) })
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

  test('preserves a Windows SSH platform and paths for both save and connection test', async () => {
    const server = { id: 'windows', label: 'Windows', description: 'SSH', runtime: 'kcoder' as const,
      transport: 'ssh' as const, remotePlatform: 'windows' as const, host: 'win.example',
      workspacePath: String.raw`C:\Projects\My Project`, command: String.raw`C:\KCoder\kcoder.exe` }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ server }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    await saveGatewayServer(server, fetchImpl as unknown as typeof fetch)
    await testGatewayServer(server, fetchImpl as unknown as typeof fetch)
    for (const [, init] of fetchImpl.mock.calls) {
      expect(JSON.parse(String(init.body))).toMatchObject({ remotePlatform: 'windows',
        workspace: server.workspacePath, command: server.command })
    }
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
            migrationHistoryWorkerStateClientV1: true,
            workspaceBinaryRevisionV1: true,
            threadRunSummaryV1: true,
            threadGoalStatusBatchV1: true,
            continuousWorkReadV1: true,
            continuousWorkPartialListV1: true,
            interactionBindingV1: true,
            interactionStatusReadV1: true,
            turnRetryOperationV1: true,
          },
        },
      },
    })
    expect(
      (messages[0].params as { capabilities: { experimental: Record<string, unknown> } })
        .capabilities.experimental
    ).not.toHaveProperty('migrationHistoryWorkerStateV1')
    expect(messages[1]).toMatchObject({ method: 'initialized' })
    expect(client.supportsExperimental('workspaceFiles')).toBe(true)
    expect(client.supportsExperimental('toolPathPreviewV1')).toBe(false)
    expect(client.supportsExperimental('unknown')).toBe(false)
    expect(client.supportsThreadResume()).toBe(true)
  })

  test('requests on an open socket wait for initialization before sending', async () => {
    FakeWebSocket.autoInitialize = false
    FakeWebSocket.autoRespond = true
    const client = new GatewayRpcClient(
      'local',
      'fixture-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    try {
      const connection = client.connect()
      await vi.waitFor(() => expect(FakeWebSocket.instances[0]?.sent.length).toBe(1))
      const socket = FakeWebSocket.instances[0]
      const request = client.request('thread/list')
      await Promise.resolve()
      expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual(['initialize'])
      socket.respond(JSON.parse(socket.sent[0]).id)
      await connection
      await request
      expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual([
        'initialize',
        'initialized',
        'thread/list',
      ])
    } finally {
      client.close()
    }
  })

  test.each([true, false])(
    'Gateway startup waits up to 300 seconds with readiness=%s',
    async ready => {
      vi.useFakeTimers()
      FakeWebSocket.autoInitialize = false
      const client = new GatewayRpcClient(
        'local',
        'fixture-token',
        FakeWebSocket as unknown as typeof WebSocket
      )
      const settled = vi.fn()
      const connection = client.connect().then(
        () => {
          settled('ready')
          return null
        },
        error => {
          settled('failed')
          return error
        }
      )
      try {
        await vi.advanceTimersByTimeAsync(299_999)
        expect(settled).not.toHaveBeenCalled()
        const socket = FakeWebSocket.instances[0]
        expect(socket.readyState).toBe(WebSocket.OPEN)
        if (ready) {
          socket.respond(JSON.parse(socket.sent[0]).id)
          expect(await connection).toBeNull()
          expect(settled).toHaveBeenCalledWith('ready')
        } else {
          await vi.advanceTimersByTimeAsync(1)
          expect(await connection).toMatchObject({ reason: 'connection' })
          expect(settled).toHaveBeenCalledWith('failed')
          expect(socket.readyState).toBe(WebSocket.CLOSED)
        }
      } finally {
        client.close()
      }
    }
  )

  test('keeps transcript snapshot opt-in disabled for a legacy renderer across reconnects', async () => {
    FakeWebSocket.autoInitialize = false
    FakeWebSocket.autoRespond = false
    const client = new GatewayRpcClient(
      'local',
      'capability-token',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const serverInitializeResult = {
      protocolVersion: '2026-07-27',
      capabilities: {
        threadResume: true,
        experimental: { threadTranscriptSnapshotV1: true },
      },
    }
    const legacyReadResult = {
      thread: { id: 'thread-legacy', title: 'Legacy thread' },
      messages: [],
      rangeStart: 0,
      rangeEnd: 0,
      hasMoreBefore: false,
    }

    const firstConnection = client.connect()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const firstSocket = FakeWebSocket.instances[0]
    await vi.waitFor(() => expect(firstSocket.readyState).toBe(WebSocket.OPEN))
    await vi.waitFor(() =>
      expect(firstSocket.sent.some(raw => JSON.parse(raw).method === 'initialize')).toBe(true)
    )
    const firstInitialize = firstSocket.sent
      .map(raw => JSON.parse(raw))
      .find(message => message.method === 'initialize')
    expect(firstInitialize).toBeTruthy()
    expect(firstInitialize.params.capabilities.experimental).not.toHaveProperty(
      'threadTranscriptSnapshotV1'
    )
    firstSocket.respond(firstInitialize.id, serverInitializeResult)
    await firstConnection
    expect(client.supportsExperimental('threadTranscriptSnapshotV1')).toBe(true)

    const legacyRead = client.request('thread/read', { threadId: 'thread-legacy' })
    await vi.waitFor(() =>
      expect(firstSocket.sent.some(raw => JSON.parse(raw).method === 'thread/read')).toBe(true)
    )
    const firstRead = firstSocket.sent
      .map(raw => JSON.parse(raw))
      .find(message => message.method === 'thread/read')
    expect(firstRead.params).toEqual({ threadId: 'thread-legacy' })
    expect(firstRead.params).not.toHaveProperty('transcriptSnapshotV1')
    firstSocket.respond(firstRead.id, legacyReadResult)
    await expect(legacyRead).resolves.toEqual(legacyReadResult)
    expect(legacyReadResult).not.toHaveProperty('transcriptSnapshotV1')

    firstSocket.close()
    const reconnectedRead = client.request('thread/read', { threadId: 'thread-legacy' })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const secondSocket = FakeWebSocket.instances[1]
    await vi.waitFor(() => expect(secondSocket.readyState).toBe(WebSocket.OPEN))
    await vi.waitFor(() =>
      expect(secondSocket.sent.some(raw => JSON.parse(raw).method === 'initialize')).toBe(true)
    )
    const secondInitialize = secondSocket.sent
      .map(raw => JSON.parse(raw))
      .find(message => message.method === 'initialize')
    expect(secondInitialize).toBeTruthy()
    expect(secondInitialize.params.capabilities.experimental).not.toHaveProperty(
      'threadTranscriptSnapshotV1'
    )
    secondSocket.respond(secondInitialize.id, serverInitializeResult)
    await vi.waitFor(() =>
      expect(secondSocket.sent.some(raw => JSON.parse(raw).method === 'thread/read')).toBe(true)
    )
    const secondRead = secondSocket.sent
      .map(raw => JSON.parse(raw))
      .find(message => message.method === 'thread/read')
    expect(secondRead.params).toEqual({ threadId: 'thread-legacy' })
    secondSocket.respond(secondRead.id, legacyReadResult)
    await expect(reconnectedRead).resolves.toEqual(legacyReadResult)
    client.close()
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
    const request = client.request(method, {
      threadId: '12345678-1234-1234-1234-123456789abc',
      turnId: 'private prompt secret',
    })
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

    test('reconnect gives up after bounded attempts with one fast session read per attempt', async () => {
      FailingWebSocket.attempts = 0
      const fetchImpl = vi.fn(async () => Response.json({ servers: [] })) as typeof fetch
      const client = new GatewayRpcClient(
        'server-1',
        'token',
        FailingWebSocket as unknown as typeof WebSocket,
        'runtime', undefined, fetchImpl
      )
      try {
        await expect(client.request('thread/list', {})).rejects.toThrow(/无法连接 KCoder app-server/)
        expect(FailingWebSocket.attempts).toBe(4)
        expect(fetchImpl).toHaveBeenCalledTimes(4)
      } finally { client.close() }
    }, 15_000)
  })
})

test('diagnostic context whitelists runtime identifiers and cannot copy arbitrary payload fields', () => {
  const context = {
    connectionId: 'https://secret.invalid',
    requestId: 9,
    threadId: 'private prompt',
    turnId: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
  }
  const error = new GatewayRpcError(
    'private error',
    -1,
    { token: 'secret' },
    'runtime-session',
    'connection',
    'local',
    context
  )
  expect(error.diagnostic).toMatchObject({
    connectionId: 'unknown',
    requestId: 9,
    threadId: null,
    turnId: '12345678-1234-1234-1234-123456789abc',
  })
  expect(JSON.stringify(error.diagnostic)).not.toMatch(/secret|private|token|invalid/)
})

test('generic runtime errors never expose their message or attached payload in diagnostics', () => {
  const error = Object.assign(new Error('private prompt and secret key'), {
    response: 'private response',
    headers: { Authorization: 'secret' },
  })
  expect(safeGatewayFailureDiagnostic(error)).toEqual({
    code: -1,
    phase: 'runtime-session',
    reason: 'unknown',
    retryable: false,
  })
  expect(
    JSON.stringify(
      safeGatewayFailureDiagnostic({ diagnostic: { token: 'secret' }, message: 'private' })
    )
  ).not.toMatch(/private|secret|token/)
})

test.each([
  ['abcd-ef01-2345', 'abcd-ef01-2345'],
  ['Ab123', 'Ab123'],
  ['ABCD-EF01-2345', null],
  ['abcd-ef01-234', null],
  ['abcd-ef01-2345-', null],
  ['abcdef012345', null],
])('diagnostics accept grouped and legacy short session IDs only (%s)', (threadId, expected) => {
  const error = new GatewayRpcError('failed', -1, undefined, 'runtime-session', 'remote', 'local', {
    connectionId: 'rpc-1-1',
    requestId: 4,
    threadId,
    turnId: null,
  })
  expect(error.diagnostic).toMatchObject({ threadId: expected })
})

test('diagnostics retain canonical turn sequence identifiers', () => {
  const error = new GatewayRpcError('failed', -1, undefined, 'runtime-session', 'remote', 'local', {
    connectionId: 'rpc-1-1',
    requestId: 3,
    threadId: '12345678-1234-1234-1234-123456789abc',
    turnId: 'turn-2',
  })
  expect(error.diagnostic).toMatchObject({ turnId: 'turn-2', requestId: 3 })
})

test('Gateway expiry preserves transport ambiguity for receipt recovery', async () => {
  const client = new GatewayRpcClient(
    'local',
    'fixture-token',
    FakeWebSocket as unknown as typeof WebSocket
  )
  await client.connect()
  const request = client
    .request('turn/start', { threadId: 'owned', clientRequestId: 'once' })
    .catch(error => error)
  await Promise.resolve()
  const socket = FakeWebSocket.instances.at(-1)!
  const sent = JSON.parse(socket.sent.at(-1)!)
  socket.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        error: {
          code: -32000,
          message: 'upstream outcome unknown',
          data: { kind: 'gatewayRequestExpired', outcome: 'unknown' },
        },
      }),
    })
  )
  expect(await request).toMatchObject({ code: -1, reason: 'unknown' })
  client.close()
})

test('target save and delete preserve the exact publication-unknown code without private diagnostics', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED',
          externalOutcome: 'failed',
          error: 'PRIVATE_PUBLISH_CANARY',
        }),
        { status: 409 }
      )
  )
  for (const action of [
    () =>
      saveGatewayServer(
        {
          id: 'owned',
          label: 'Owned',
          description: '',
          runtime: 'kcoder',
          transport: 'ssh',
          host: 'owned.invalid',
        },
        fetchImpl
      ),
    () => removeGatewayServer('owned', fetchImpl),
  ]) {
    const error = await action().catch(error => error)
    expect(error).toMatchObject({
      uncertain: true,
      data: { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' },
    })
    expect(error.message).not.toContain('PRIVATE_PUBLISH_CANARY')
  }
})

test('untrusted target error outcome metadata alone cannot grant publication uncertainty', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          code: 'SCHEMA_INVALID',
          externalOutcome: 'unknown',
          error: 'schema error',
        }),
        { status: 400 }
      )
  )
  const error = await removeGatewayServer('owned', fetchImpl).catch(error => error)
  expect(error).toMatchObject({ uncertain: false })
})

describe('async question response envelopes', () => {
  afterEach(() => { FakeWebSocket.instances = []; vi.restoreAllMocks() })
  test.each([
    ['asyncQuestion/answer', -32001, 'unknown', -1],
    ['asyncQuestion/cancel', -32001, 'unknown', -1],
    ['asyncQuestion/list', -32001, 'unknown', -1],
    ['asyncQuestion/answer', -32045, 'unknown', -1],
    ['asyncQuestion/cancel', -32045, 'unknown', -1],
    ['asyncQuestion/answer', -32065, 'unknown', -1],
    ['asyncQuestion/cancel', -32065, 'unknown', -1],
    ['asyncQuestion/answer', -32064, 'remote', -32064],
    ['thread/read', -32001, 'remote', -32001],
  ] as const)('%s preserves the outcome meaning of RPC code %i', async (method, code, reason, expectedCode) => {
    const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    try {
      await client.connect()
      const socket = FakeWebSocket.instances.at(-1)!
      const pending = client.request(method, { threadId: 'original-thread' }).catch(error => error)
      const { id } = JSON.parse(socket.sent.at(-1)!)
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id,
        error: { code, message: 'Check the original task receipt.' } }) }))
      expect(await pending).toMatchObject({ reason, code: expectedCode })
      const reading = client.request('asyncQuestion/list', { threadId: 'original-thread' })
      socket.respond(JSON.parse(socket.sent.at(-1)!).id, { threadId: 'original-thread', questions: [] })
      expect(await reading).toEqual({ threadId: 'original-thread', questions: [] })
      expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual([
        'initialize', 'initialized', method, 'asyncQuestion/list',
      ])
    } finally { client.close() }
  })

  for (const method of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
    test.each([
      { result: {}, error: { code: -32034, message: 'Conflicting refusal' } },
      { result: null, error: null }, {}, { error: null }, { error: false },
      { error: [] }, { error: { code: -32602 } },
      { error: { code: '-32602', message: 'Invalid code' } },
      { params: { threadId: 'other-thread' }, result: { threadId: 'original-thread' } },
      { params: null, error: { code: -32602, message: 'Unconfirmed refusal' } },
      ...[null, '', false, 0].flatMap(method => [
        { method, result: {} }, { method, error: { code: -32602, message: 'Unconfirmed refusal' } },
      ]),
    ])(`${method} keeps malformed outcomes unknown: %j`, async fields => {
      const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
      try {
        await client.connect()
        const socket = FakeWebSocket.instances.at(-1)!
        const pending = client.request(method, { threadId: 'original-thread' }).catch(error => error)
        const id = JSON.parse(socket.sent.at(-1)!).id
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, ...fields }) }))
        const error = await pending
        expect(error).toMatchObject({ reason: 'invalid-response', code: -1 })
        expect(error.diagnostic.retryable).toBe(false)
        socket.respond(id, {})
        const reading = client.request('asyncQuestion/list', { threadId: 'original-thread' })
        socket.respond(JSON.parse(socket.sent.at(-1)!).id, { threadId: 'original-thread', questions: [] })
        expect(await reading).toEqual({ threadId: 'original-thread', questions: [] })
        expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual([
          'initialize', 'initialized', method, 'asyncQuestion/list',
        ])
      } finally { client.close() }
    })
  }

  test.each([
    { result: { threadId: 'original-thread' } },
    { error: { code: -32602, message: 'Unconfirmed refusal' } },
  ])('keeps a method-bearing answer receipt out of interaction delivery: %j', async fields => {
    const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    try {
      await client.connect()
      const socket = FakeWebSocket.instances.at(-1)!
      const requests = vi.fn()
      client.addEventListener('request', requests)
      const pending = client.request('asyncQuestion/answer', { threadId: 'original-thread' }).catch(error => error)
      const id = JSON.parse(socket.sent.at(-1)!).id
      const emit = (frame: unknown) =>
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
      // The server and client request ID spaces may overlap.
      const question = { jsonrpc: '2.0', id, method: 'question/request',
        params: { threadId: 'original-thread', turnId: 'turn', questionId: 'sync-question' } }
      emit({ ...question, id: 'server-only', ...fields })
      emit(question)
      expect(requests).toHaveBeenCalledTimes(1)
      expect(requests.mock.calls[0][0].detail).toEqual(question)
      emit({ ...question, ...fields })
      expect(requests).toHaveBeenCalledTimes(1)
      expect(await pending).toMatchObject({ reason: 'invalid-response', code: -1 })

      const readback = { threadId: 'original-thread', questions: [] }
      socket.respond(id, readback)
      const reading = client.request('asyncQuestion/list', { threadId: 'original-thread' })
      socket.respond(JSON.parse(socket.sent.at(-1)!).id, readback)
      expect(await reading).toEqual(readback)
      expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual([
        'initialize', 'initialized', 'asyncQuestion/answer', 'asyncQuestion/list',
      ])
    } finally { client.close() }
  })

  test.each(['asyncQuestion/list', 'asyncQuestion/answer'])(
    '%s waits for its receipt despite malformed question notifications',
    async method => {
      const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
      try {
        await client.connect()
        const socket = FakeWebSocket.instances.at(-1)!
        const requests = vi.fn()
        const notifications = vi.fn()
        client.addEventListener('request', requests)
        client.addEventListener('notification', notifications)
        const reading = client.request(method, { threadId: 'original-thread' }).catch(error => error)
        const id = JSON.parse(socket.sent.at(-1)!).id
        const notification = { jsonrpc: '2.0', method: 'asyncQuestion/changed', params: { threadId: 'original-thread' } }
        const emit = (frame: unknown) =>
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
        for (const method of [
          'turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted', 'question/resolved', 'approval/resolved',
        ]) {
          emit({ ...notification, method, id, result: null })
          emit({ ...notification, method, id, error: { code: -32602, message: 'Unconfirmed refusal' } })
        }
        emit({ ...notification, id, result: {} })
        emit({ ...notification, id, error: { code: -32602, message: 'Unconfirmed refusal' } })
        emit({ ...notification, id })
        emit({ ...notification, jsonrpc: '1.0' })
        emit(notification)
        const receipt = { threadId: 'original-thread' }
        socket.respond(id, receipt)
        expect(await reading).toEqual(receipt)
        expect(requests).not.toHaveBeenCalled()
        expect(notifications.mock.calls.map(([event]) => event.detail)).toEqual([notification])
        expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual(['initialize', 'initialized', method])
      } finally { client.close() }
    },
  )

  test('discards non-object frames without throwing or settling the original request', async () => {
    const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
    try {
      await client.connect()
      const socket = FakeWebSocket.instances.at(-1)!
      const notification = vi.fn()
      client.addEventListener('notification', notification)
      const pending = client.request('asyncQuestion/list', { threadId: 'original-thread' }).catch(error => error)
      const id = JSON.parse(socket.sent.at(-1)!).id
      const receiver = client as unknown as { receive(raw: string): void }
      for (const frame of [null, [], 'text', 1, true])
        expect(() => receiver.receive(JSON.stringify(frame))).not.toThrow()
      expect(notification).not.toHaveBeenCalled()
      socket.respond(id, null)
      expect(await pending).toBeNull()
    } finally { client.close() }
  })
})

test('pre-initialize failure retains only the closed startup diagnostic through the socket close', async () => {
  FakeWebSocket.autoInitialize = false
  const client = new GatewayRpcClient('local', 'fixture-token', FakeWebSocket as unknown as typeof WebSocket)
  client.useNativeManagementTransport()
  const connected = client.connect().catch(error => error)
  try {
    await vi.waitFor(() => expect(FakeWebSocket.instances.at(-1)?.sent.some(raw => JSON.parse(raw).method === 'initialize')).toBe(true))
    const socket = FakeWebSocket.instances.at(-1)!
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'server/disconnected',
      params: { message: 'SECRET_NATIVE_STDERR_MUST_NOT_ESCAPE', startupDiagnostic: { version: 1, code: 'settings_parse_failed', phase: 'initialize',
        token: 'SECRET_NESTED_VALUE_MUST_NOT_ESCAPE' } } }) }))
    socket.close()
    const failure = await connected
    expect(failure).toMatchObject({ reason: 'connection', code: -32071, data: { startupDiagnostic: { version: 1, code: 'settings_parse_failed', phase: 'initialize' } } })
    expect(failure.message).not.toContain('SECRET_')
    expect(JSON.stringify(failure.data)).not.toContain('SECRET_')
    expect(FakeWebSocket.instances).toHaveLength(1)
  } finally { client.close(); FakeWebSocket.autoInitialize = true }
})

test('late target metadata cannot restore a draft account identity after invalidation', async () => {
  let resolve!: (response: Response) => void
  const fetchImpl = vi.fn(() => new Promise<Response>(done => { resolve = done }))
  const result = fetchGatewayServers(fetchImpl as unknown as typeof fetch)
  notifyAccountContextChange('late-draft-target')
  resolve(new Response(JSON.stringify({ servers: [{ id: 'late-draft-target', transport: 'local', label: 'Fixture' }] })))
  await result
  expect(verifiedAccountContextScopes().has('late-draft-target')).toBe(false)
})

test('concurrent directory readers share only the pending transport and retain separate DTOs', async () => {
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve })) as unknown as typeof fetch
  const first = fetchGatewayServers(fetchImpl)
  const second = fetchGatewayServers(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  finish(Response.json({ servers: [{ id: 'coalesced', label: 'Original', transport: 'local' }] }))
  const [left, right] = await Promise.all([first, second])
  left[0].label = 'Changed by first consumer'
  expect(right[0].label).toBe('Original')
  const next = fetchGatewayServers(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  finish(Response.json({ servers: [] }))
  await expect(next).resolves.toEqual([])
})

test('a cancelled directory subscriber releases only its own wait', async () => {
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn(() =>
    new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
  const first = new AbortController(), second = new AbortController()
  const cancelled = fetchGatewayServers(fetchImpl, { signal: first.signal })
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const peer = fetchGatewayServers(fetchImpl, { signal: second.signal })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  first.abort()
  await rejected
  expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(false)
  finish(Response.json({ servers: [{ id: 'peer-directory', label: 'Peer', transport: 'local' }] }))
  await expect(peer).resolves.toMatchObject([{ id: 'peer-directory' }])
})

test('the last directory subscriber aborts the transport and cannot retire a replacement read', async () => {
  const finish: Array<(response: Response) => void> = []
  const fetchImpl = vi.fn(() =>
    new Promise<Response>(resolve => { finish.push(resolve) })) as typeof fetch
  const controller = new AbortController()
  const cancelled = fetchGatewayServers(fetchImpl, { signal: controller.signal })
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(true)
  const current = fetchGatewayServers(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  // The test transport ignores cancellation to exercise late completion cleanup.
  finish[0](Response.json({ servers: [{ id: 'cancelled-directory', label: 'Retired', transport: 'local' }] }))
  await Promise.resolve()
  const peer = fetchGatewayServers(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  finish[1](Response.json({ servers: [{ id: 'current-directory', label: 'Current', transport: 'local' }] }))
  expect(await current).toEqual(await peer)
  expect(verifiedAccountContextScopes().has('cancelled-directory')).toBe(false)
})

test('an already cancelled directory subscriber never starts HTTP', async () => {
  const fetchImpl = vi.fn() as typeof fetch
  const controller = new AbortController()
  controller.abort()
  await expect(fetchGatewayServers(fetchImpl, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test.each(['account', 'configuration'] as const)('a %s change retires a pending directory read without letting its cleanup retire the replacement', async boundary => {
  const finish: Array<(response: Response) => void> = []
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve) })) as unknown as typeof fetch
  const id = `coalesced-owner-${boundary}`
  const first = fetchGatewayServers(fetchImpl)
  if (boundary === 'account') notifyAccountContextChange(id)
  else window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
  const replacement = fetchGatewayServers(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  finish[0](Response.json({ servers: [{ id, authorityId: 'old', label: 'Retired' }] }))
  await first
  expect(verifiedAccountContextScopes().has(id)).toBe(false)
  const joined = fetchGatewayServers(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  finish[1](Response.json({ servers: [{ id, authorityId: 'new', label: 'Current' }] }))
  expect(await replacement).toEqual(await joined)
})

test('a failed directory read is shared but never cached as a successful or reusable result', async () => {
  let reject!: (error: Error) => void
  const fetchImpl = vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail }))
  const reads = Promise.allSettled([fetchGatewayServers(fetchImpl as typeof fetch), fetchGatewayServers(fetchImpl as typeof fetch)])
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  reject(new Error('Directory unavailable'))
  expect((await reads).map(result => result.status)).toEqual(['rejected', 'rejected'])
  fetchImpl.mockResolvedValueOnce(Response.json({ servers: [] }))
  await expect(fetchGatewayServers(fetchImpl as typeof fetch)).resolves.toEqual([])
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test('different Gateway mounts do not join pending directory reads or restore the previous mount identity', async () => {
  const prefix = document.createElement('meta')
  prefix.name = 'kcoder-app-base-path'
  prefix.content = '/g/directory-before'
  document.head.append(prefix)
  const finish: Array<(response: Response) => void> = []
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve) })) as unknown as typeof fetch
  try {
    const before = fetchGatewayServers(fetchImpl)
    prefix.content = '/g/directory-after'
    const after = fetchGatewayServers(fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/g/directory-before/api/servers', { cache: 'no-store', signal: expect.any(AbortSignal) })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/g/directory-after/api/servers', { cache: 'no-store', signal: expect.any(AbortSignal) })
    finish[0](Response.json({ servers: [{ id: 'previous-directory-mount', label: 'Previous' }] }))
    finish[1](Response.json({ servers: [] }))
    await Promise.all([before, after])
    expect(verifiedAccountContextScopes().has('previous-directory-mount')).toBe(false)
  } finally { prefix.remove() }
})


test.each(['account', 'configuration', 'mount'] as const)('full health drops its late snapshot after %s changes', async boundary => {
  const prefix = document.createElement('meta')
  prefix.name = 'kcoder-app-base-path'
  prefix.content = '/g/health-owner-before'
  document.head.append(prefix)
  const id = `health-owner-${boundary}`
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/servers')) return Response.json({ servers: [{ id, label: 'Old target', transport: 'local' }] })
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  try {
    const pending = fetchGatewayServersWithHealth(fetchImpl)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    if (boundary === 'account') notifyAccountContextChange(id)
    else if (boundary === 'configuration') window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
    else prefix.content = '/g/health-owner-after'
    finish(Response.json({ statuses: [{ id, status: 'online', latencyMs: 1 }] }))
    await rejected
  } finally { prefix.remove() }
})

test.each(['account', 'configuration'] as const)('full health does not start probing after %s retires its directory', async boundary => {
  const id = `health-before-probe-${boundary}`
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    .mockResolvedValue(Response.json({ statuses: [{ id, status: 'online', latencyMs: 1 }] })) as typeof fetch
  const pending = fetchGatewayServersWithHealth(fetchImpl)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  if (boundary === 'account') notifyAccountContextChange(id)
  else window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
  finish(Response.json({ servers: [{ id, label: 'Old target', transport: 'local' }] }))
  await rejected
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('full health discards an empty directory from a retired account context', async () => {
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
  const pending = fetchGatewayServersWithHealth(fetchImpl)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  notifyAccountContextChange('health-empty-directory')
  finish(Response.json({ servers: [] }))
  await rejected
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('health readers share in-flight HTTP only and invalidate on account or configuration changes', async () => {
  const finish: Array<(response: Response) => void> = []
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve) })) as typeof fetch
  const first = fetchGatewayServerStatuses(fetchImpl)
  const joined = fetchGatewayServerStatuses(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  notifyAccountContextChange('health-read-owner')
  const replacement = fetchGatewayServerStatuses(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  finish[0]!(Response.json({ statuses: [{ id: 'health-read-owner', status: 'online' }] }))
  const [left, right] = await Promise.all([first, joined])
  left[0]!.status = 'offline'
  expect(right[0]!.status).toBe('online')
  const replacementJoined = fetchGatewayServerStatuses(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
  const fresh = fetchGatewayServerStatuses(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(3)
  finish[1]!(Response.json({ statuses: [] }))
  finish[2]!(Response.json({ statuses: [] }))
  await Promise.all([replacement, replacementJoined, fresh])
  const next = fetchGatewayServerStatuses(fetchImpl)
  expect(fetchImpl).toHaveBeenCalledTimes(4)
  finish[3]!(Response.json({ statuses: [] }))
  await next
})

test('cancelled full health releases only its directory waiter and never starts a health probe', async () => {
  const controller = new AbortController()
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
  const peer = fetchGatewayServers(fetchImpl)
  const own = fetchGatewayServersWithHealth(fetchImpl, { signal: controller.signal })
  const rejected = expect(own).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  finish(Response.json({ servers: [{ id: 'owned-health', label: 'Owned', transport: 'local' }] }))
  await rejected
  await expect(peer).resolves.toHaveLength(1)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('a cancelled health-stage waiter leaves its peer live and never publishes a failed-health fallback', async () => {
  const controller = new AbortController()
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn(async (url: unknown) => String(url).endsWith('/status')
    ? new Promise<Response>(resolve => { finish = resolve })
    : Response.json({ servers: [{ id: 'health-peer', label: 'Peer', transport: 'local' }] })) as typeof fetch
  const own = fetchGatewayServersWithHealth(fetchImpl, { signal: controller.signal })
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
  const peer = fetchGatewayServerStatuses(fetchImpl)
  const rejected = expect(own).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  finish(Response.json({ statuses: [{ id: 'health-peer', status: 'online' }] }))
  await rejected
  await expect(peer).resolves.toEqual([{ id: 'health-peer', status: 'online' }])
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})
