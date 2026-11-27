import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'
import { WORKSPACE_SCAN_CANCELLED } from './workspaceScanError'

describe.each([Runtime, InstalledRuntime])('account scoped invalidation', RuntimeClass => {
  test('a late target-directory response cannot select the former account', async () => {
    let resolveOld!: (value: ReturnType<typeof localGatewayServer>[]) => void
    let count = 0
    const createClient = vi.fn(() => new FakeGatewayClient('new-account-thread'))
    const runtime = new RuntimeClass('token', {
      loadServers: () => ++count === 1
        ? new Promise(resolve => { resolveOld = resolve })
        : Promise.resolve([localGatewayServer({ id: 'account', label: 'new identity' })]),
      createClient,
    })
    try {
      const old = runtime.status()
      const rejected = expect(old).rejects.toThrow()
      notifyAccountContextChange('account')
      resolveOld([localGatewayServer({ id: 'account', label: 'old identity' })])
      await rejected
      expect(createClient).not.toHaveBeenCalled()
      await expect(runtime.status()).resolves.toMatchObject({ ready: true, deviceId: 'account' })
      expect(count).toBe(2)
    } finally { await runtime.dispose() }
  })

  test('rejects a late old account reply while preserving the other active target', async () => {
    let resolveOld!: (value: unknown) => void
    let held = false
    const clients: Array<{ serverId: string; client: FakeGatewayClient }> = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () => ['account', 'other'].map(id => localGatewayServer({ id, workspacePath: '/' + id })),
      createClient: serverId => {
        const client = new FakeGatewayClient(`thread-${serverId}`)
        const request = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (serverId === 'account' && method === 'runtime.providers.list') {
            held = true
            return new Promise(resolve => { resolveOld = value => resolve(value as T) })
          }
          return request<T>(method, params)
        }
        clients.push({ serverId, client }); return client
      },
    })
    try {
      await runtime.request('runtime.tasks.create', { deviceId: 'other', taskId: 'other-active', executionRequest: { prompt: 'Keep running' } })
      const other = clients.find(item => item.serverId === 'other')!.client
      const close = vi.spyOn(other, 'close')
      const old = runtime.request('runtime.providers.request', { serverId: 'account', method: 'runtime.providers.list', params: {} })
      const rejected = expect(old).rejects.toThrow()
      await vi.waitFor(() => expect(held).toBe(true))
      notifyAccountContextChange('account')
      resolveOld({ profiles: [{ secret: 'old account data' }] })
      await rejected
      expect(close).not.toHaveBeenCalled()
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
      expect(close).not.toHaveBeenCalled()
    } finally { await runtime.dispose() }
  })

  test.each(['resolved', 'rejected'])('an old account %s handshake is cancelled instead of requesting login', async outcome => {
    const server = localGatewayServer({ id: 'pending-account', security: { identity: { mode: 'kcoder-account' } } })
    localStorage.setItem('kcoder-studio:selected-server', server.id)
    let finish!: () => void, fail!: (error: Error) => void
    const first = new FakeGatewayClient(null)
    first.connectGate = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    const connect = vi.spyOn(first, 'connect')
    const second = new FakeGatewayClient(null)
    const createClient = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
    const runtime = new RuntimeClass('owned-token', { loadServers: async () => [server], createClient })
    const reading = runtime.status()
    const result = reading.then(status => ({ status }), error => ({ error }))
    try {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
      notifyAccountContextChange(server.id)
      if (outcome === 'resolved') finish()
      else fail(new Error('Old account authentication failed'))
      await expect(result).resolves.toMatchObject({ error: { name: 'AbortError', code: WORKSPACE_SCAN_CANCELLED } })
      expect(first.closed).toBe(true)
      await expect(runtime.status()).resolves.toMatchObject({ ready: true, deviceId: server.id })
      expect(createClient).toHaveBeenCalledTimes(2)
    } finally { finish(); await result; await runtime.disposeAsync() }
  })

  test('an unrelated account change leaves the current pending status usable', async () => {
    const server = localGatewayServer({ id: 'unchanged-account', security: { identity: { mode: 'kcoder-account' } } })
    let finish!: () => void
    const client = new FakeGatewayClient(null)
    client.connectGate = new Promise<void>(resolve => { finish = resolve })
    const connect = vi.spyOn(client, 'connect')
    const runtime = new RuntimeClass('owned-token', { loadServers: async () => [server], createClient: () => client })
    const reading = runtime.status()
    try {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
      notifyAccountContextChange('unrelated-account')
      finish()
      await expect(reading).resolves.toMatchObject({ ready: true, deviceId: server.id })
      expect(client.closed).toBe(false)
    } finally { finish(); await reading.catch(() => {}); await runtime.disposeAsync() }
  })

  test('a current authentication failure remains a login result even when its transport closes', async () => {
    const server = localGatewayServer({ id: 'denied-account', security: { identity: { mode: 'kcoder-account' } } })
    const client = new FakeGatewayClient(null)
    vi.spyOn(client, 'connect').mockImplementation(async () => {
      client.close()
      throw new Error('Current authentication required')
    })
    const runtime = new RuntimeClass('owned-token', { loadServers: async () => [server], createClient: () => client })
    try {
      await expect(runtime.status()).resolves.toMatchObject({ ready: false, accountLoginServerId: server.id })
    } finally { await runtime.disposeAsync() }
  })

})
