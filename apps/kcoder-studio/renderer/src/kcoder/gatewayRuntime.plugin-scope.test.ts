import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'

describe.each([Runtime, InstalledRuntime])('plugin request account scope', RuntimeClass => {
  test('a pending connection rejects at its epoch guard before a plugin mutation', async () => {
    const client = new FakeGatewayClient(null)
    let release!: () => void
    client.connectGate = new Promise(resolve => {
      release = resolve
    })
    const create = vi.fn(() => client)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        {
          id: 'alpha',
          label: 'A',
          runtime: 'kcoder',
          description: '',
          transport: 'local',
          workspacePath: '/owned',
        },
      ],
      createClient: create,
    })
    try {
      const pending = runtime.request('runtime.plugins.request', {
        deviceId: 'alpha',
        method: 'plugin/uninstall',
        params: { pluginId: 'demo@market' },
      })
      // The connection has not become ready, so its epoch guard rejects
      // before the outer plugin-operation scope guard can produce typed data.
      const rejected = expect(pending).rejects.toThrow('KCoder 网关运行时已关闭')
      await vi.waitFor(() => expect(create).toHaveBeenCalled())
      notifyAccountContextChange('alpha')
      release()
      await rejected
      expect(client.closed).toBe(true)
      expect(client.requests.some(request => request.method === 'plugin/uninstall')).toBe(false)
    } finally {
      release?.()
      await runtime.dispose()
    }
  })

  test('a ready connection still uses the typed plugin scope guard for a queued operation', async () => {
    const client = new FakeGatewayClient(null)
    const create = vi.fn(() => client)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        {
          id: 'alpha',
          label: 'A',
          runtime: 'kcoder',
          description: '',
          transport: 'local',
          workspacePath: '/owned',
        },
      ],
      createClient: create,
    })
    try {
      await expect(runtime.status()).resolves.toMatchObject({ ready: true })
      expect(client.closed).toBe(false)
      const pending = runtime.request('runtime.plugins.request', {
        deviceId: 'alpha',
        method: 'plugin/uninstall',
        params: { pluginId: 'demo@market' },
      })
      const rejected = expect(pending).rejects.toMatchObject({
        code: -32049,
        data: { kind: 'plugin_scope_changed' },
      })
      notifyAccountContextChange('alpha')
      await rejected
      expect(client.closed).toBe(true)
      expect(create).toHaveBeenCalledTimes(1)
      expect(client.requests.some(request => request.method === 'plugin/uninstall')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
