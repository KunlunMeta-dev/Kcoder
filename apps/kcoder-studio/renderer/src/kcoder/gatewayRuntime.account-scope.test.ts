import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'

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
})
