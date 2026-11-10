import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as ModularRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'
import { KCODER_RUNTIME_METHODS } from './legacyRuntimeAbi'
import { GatewayRpcError } from './gatewayRpc'

const server = {
  id: 'local',
  label: 'Local',
  description: '',
  transport: 'local' as const,
  workspacePath: '/workspace',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// These clients model broker ownership and initialize barriers, not model output.
describe.each([
  ['modular', ModularRuntime],
  ['installed', InstalledRuntime],
] as const)('%s restart ownership', (_name, Runtime) => {
  let runtime: InstanceType<typeof Runtime>
  const clients: RestartClient[] = []
  const events: string[] = []
  let detachGate: Promise<void> | null = null
  let connectGate: Promise<void> | null = null
  let restartFailure: Error | null = null
  let detachFailure: Error | null = null
  let stopAcknowledged = true
  let connectFailure: Error | null = null

  class RestartClient extends FakeGatewayClient {
    detached = false
    connected = false
    nativeManagementOnly = false
    useNativeManagementTransport() {
      this.nativeManagementOnly = true
    }
    constructor(readonly index: number) {
      super(`thread-${index}`)
    }
    override async connect() {
      if (connectGate) await connectGate
      if (connectFailure) throw connectFailure
      this.connected = true
      events.push(`initialized:${this.index}`)
    }
    override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === 'plugin/list') return {} as T
      if (['skills/import', 'skills/remove', 'mcp/list', 'mcp/setEnabled', 'mcp/install', 'mcp/remove', 'mcp/logout', 'mcp/providerRevocation', 'mcp/login', 'mcp/callback', 'mcp/cancel', 'gateway/mcp/login'].includes(method)) {
        this.requests.push({ method, params })
        return { forwarded: method } as T
      }
      if (method === 'gateway/client/detach') {
        this.requests.push({ method, params })
        if (detachFailure) throw detachFailure
        if (detachGate) await detachGate
        this.detached = true
        events.push(`detached:${this.index}`)
        return { detached: true } as T
      }
      if (method === 'gateway/app-server/restart') {
        this.requests.push({ method, params })
        if (restartFailure) throw restartFailure
        if (!stopAcknowledged) return { restarted: true } as T
        const owners = clients.filter(
          client => client.connected && !client.detached && !client.closed
        )
        if (owners.length !== 1) throw new Error('other workspace clients remain attached')
        events.push(`stopped:${this.index}`)
        return { restarted: false, stopped: true, reconnectRequired: true } as T
      }
      return super.request<T>(method, params)
    }
  }

  test.each(['skills/import', 'skills/remove', 'mcp/list', 'mcp/setEnabled', 'mcp/install', 'mcp/remove', 'mcp/logout', 'mcp/providerRevocation', 'mcp/login', 'mcp/callback', 'mcp/cancel', 'gateway/mcp/login'])('forwards %s through the target command client', async method => {
    const params = method === 'mcp/logout' ? { name: 'oauth-tool', pluginId: 'test-plugin' } : method === 'mcp/providerRevocation' ? { action: 'read', requestId: 'original-provider-request', server: { name: 'oauth-tool', pluginId: 'test-plugin' } } : {}
    const result = await runtime.request('runtime.plugins.request', {
      deviceId: 'local',
      workspacePath: '/workspace',
      method,
      params,
    })
    expect(result).toEqual({ forwarded: method })
    expect(clients.flatMap(client => client.requests)).toContainEqual({ method, params })
  })

  test('rejects private provider revocation overrides before starting or sending through a command client', async () => {
    await expect(runtime.request('runtime.plugins.request', {deviceId:'local',workspacePath:'/workspace',method:'mcp/providerRevocation',params:{action:'prepare',requestId:'original',server:{name:'oauth-tool'},token:'forbidden-public-field'}})).rejects.toMatchObject({code:-32602})
    expect(clients.flatMap(client => client.requests).some(request => request.method==='mcp/providerRevocation')).toBe(false)
  })

  beforeEach(() => {
    localStorage.clear()
    clients.length = 0
    events.length = 0
    detachGate = null
    connectGate = null
    restartFailure = null
    detachFailure = null
    stopAcknowledged = true
    connectFailure = null
    runtime = new Runtime('test-token', {
      loadServers: async () => [server],
      createClient: () => {
        const client = new RestartClient(clients.length)
        clients.push(client)
        return client
      },
    })
  })
  afterEach(async () => {
    runtime.dispose()
  })

  test('awaits own extra task, command and control detach before one workspace restart', async () => {
    await runtime.status()
    await runtime.request('runtime.plugins.request', { method: 'plugin/list' })
    await runtime.request('runtime.tasks.create', {
      taskId: 'first',
      executionRequest: { prompt: 'first' },
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'second',
      executionRequest: { prompt: 'second' },
    })
    const gate = deferred()
    detachGate = gate.promise
    const result = runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { force: true })
    await vi.waitFor(() =>
      expect(
        clients.some(client =>
          client.requests.some(request => request.method === 'gateway/client/detach')
        )
      ).toBe(true)
    )
    expect(events.some(event => event.startsWith('stopped:'))).toBe(false)
    gate.resolve()
    await expect(result).resolves.toMatchObject({ restarted: true })
    expect(events.filter(event => event.startsWith('detached:'))).toHaveLength(3)
    expect(events.filter(event => event.startsWith('stopped:'))).toHaveLength(1)
    expect(events.at(-1)).toBe('initialized:4')
  })

  test.each(['command', 'control'] as const)(
    'restarts a %s-only workspace and waits for fresh initialize',
    async kind => {
      if (kind === 'control') await runtime.status()
      else await runtime.request('runtime.plugins.request', { method: 'plugin/list' })
      const gate = deferred()
      connectGate = gate.promise
      let finished = false
      const result = runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, {}).then(value => {
        finished = true
        return value
      })
      await vi.waitFor(() => expect(events.some(event => event.startsWith('stopped:'))).toBe(true))
      expect(finished).toBe(false)
      gate.resolve()
      await expect(result).resolves.toMatchObject({ restarted: true })
      expect(events).toEqual(['initialized:0', 'stopped:0', 'initialized:1'])
    }
  )

  test('does not report success for an empty target set', async () => {
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, {})
    ).resolves.toMatchObject({ restarted: false })
  })

  test('groups Windows path aliases into one backend restart', async () => {
    await runtime.connectClient(server, 'runtime', 'C:\\workspace')
    await runtime.connectClient(server, 'runtime', 'C:/workspace/')
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { serverId: server.id, ifIdle: true })
    ).resolves.toMatchObject({ restarted: true, requiresConfirmation: false })
    expect(events.filter(event => event.startsWith('stopped:'))).toHaveLength(1)
    expect(events.filter(event => event.startsWith('detached:'))).toHaveLength(1)
  })

  test('reports a broker restart refusal as busy and retains the requester', async () => {
    await runtime.status()
    restartFailure = new GatewayRpcError('Another client is using this app-server', -32043)
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { serverId: server.id, ifIdle: true })
    ).resolves.toMatchObject({ restarted: false, requiresConfirmation: true })
    expect(clients[0].closed).toBe(false)
    expect(clients[0].requests.filter(request => request.method === 'gateway/app-server/restart'))
      .toEqual([{ method: 'gateway/app-server/restart', params: { confirm: true, force: false } }])
  })

  test('keeps its browser resources open when backend restart is requested', async () => {
    await runtime.status()
    const browser = await runtime.connectClient(server, 'browser')
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { serverId: server.id, ifIdle: true })
    ).resolves.toMatchObject({ restarted: false, requiresConfirmation: true })
    expect((browser as RestartClient).closed).toBe(false)
    expect(events.some(event => event.startsWith('stopped:'))).toBe(false)
  })

  test.each([true, false])('releases its SDK management connection before restart with managementFirst=%s', async managementFirst => {
    if (!managementFirst) await runtime.status()
    await runtime.commandClient(server, undefined, true)
    if (managementFirst) await runtime.status()
    const management = clients.find(client => client.nativeManagementOnly)!
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { serverId: server.id, ifIdle: true })
    ).resolves.toMatchObject({ restarted: true })
    expect(management.detached).toBe(true)
    expect(management.closed).toBe(true)
    expect(management.requests.some(request => request.method === 'gateway/app-server/restart')).toBe(false)
    expect(events.filter(event => event.startsWith('stopped:'))).toHaveLength(1)
  })

  test('releases a management-only connection without sending it a backend restart', async () => {
    await runtime.commandClient(server, undefined, true)
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { serverId: server.id, ifIdle: true })
    ).resolves.toMatchObject({ restarted: false })
    expect(clients[0].detached).toBe(true)
    expect(clients[0].closed).toBe(true)
    expect(events.some(event => event.startsWith('stopped:'))).toBe(false)
  })

  test('propagates broker rejection without closing its only requester', async () => {
    await runtime.status()
    restartFailure = new Error('another renderer owns the workspace')
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { force: true })
    ).rejects.toThrow('another renderer owns')
    expect(clients[0].closed).toBe(false)
    expect(clients).toHaveLength(1)
  })

  test('propagates fresh initialize failure after an acknowledged stop', async () => {
    await runtime.status()
    connectFailure = new Error('fresh initialize failed')
    await expect(runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, {})).rejects.toThrow(
      'fresh initialize failed'
    )
    expect(events).toEqual(['initialized:0', 'stopped:0'])
    expect(clients.every(client => client.closed)).toBe(true)
  })

  test('does not restart when a self detach is rejected', async () => {
    await runtime.status()
    await runtime.request('runtime.plugins.request', { method: 'plugin/list' })
    detachFailure = new Error('own turn drain did not complete')
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, { force: true })
    ).rejects.toThrow('own turn drain')
    expect(events.some(event => event.startsWith('stopped:'))).toBe(false)
    expect(clients.every(client => !client.closed)).toBe(true)
  })

  test('rejects a restarted claim without an actual stop acknowledgement', async () => {
    await runtime.status()
    stopAcknowledged = false
    await expect(runtime.request(KCODER_RUNTIME_METHODS.appServerRestart, {})).rejects.toThrow(
      'stop was not acknowledged'
    )
    expect(clients).toHaveLength(1)
    expect(clients[0].closed).toBe(false)
  })
})
