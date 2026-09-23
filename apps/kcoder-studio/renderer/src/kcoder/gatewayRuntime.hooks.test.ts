import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'
import {
  HOOK_CONFIGURATION_READ,
  HOOK_CONFIGURATION_UPDATE,
  hookTargetScope,
} from './gatewayHookConfiguration'
import type { GatewayServer } from './gatewayRpc'
class HookClient extends FakeGatewayClient {
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method.startsWith('hooks/config/')) {
      this.requests.push({ method, params })
      return {} as T
    }
    return super.request<T>(method, params)
  }
}
const target: GatewayServer = {
  id: 'local',
  label: 'local',
  runtime: 'kcoder',
  description: '',
  transport: 'local',
  workspacePath: '/owned',
}
describe.each([Runtime, InstalledRuntime])('Hook target scope', RuntimeClass => {
  test('forwards user configuration to the intended target, rejects old capabilities', async () => {
    const client = new HookClient(null)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [target],
      createClient: () => client,
    })
    try {
      await runtime.request(HOOK_CONFIGURATION_READ, {
        deviceId: 'local',
        targetScope: hookTargetScope(target),
      })
      expect(client.requests).toContainEqual({ method: 'hooks/config/read', params: {} })
      await expect(
        runtime.request(HOOK_CONFIGURATION_UPDATE, {
          deviceId: 'local',
          targetScope: 'wrong',
          hooks: {},
          expectedRevision: 'r',
        })
      ).rejects.toThrow('changed')
      expect(client.requests.some(item => item.method === 'hooks/config/update')).toBe(false)
      client.supportsExperimental = () => false
      await expect(
        runtime.request(HOOK_CONFIGURATION_READ, {
          deviceId: 'local',
          targetScope: hookTargetScope(target),
        })
      ).rejects.toThrow('support')
    } finally {
      await runtime.dispose()
    }
  })
  test('does not send a queued write after account context changes', async () => {
    const client = new HookClient(null)
    let release!: () => void
    client.connectGate = new Promise(resolve => {
      release = resolve
    })
    const create = vi.fn(() => client)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [target],
      createClient: create,
    })
    try {
      const pending = runtime.request(HOOK_CONFIGURATION_UPDATE, {
        deviceId: 'local',
        targetScope: hookTargetScope(target),
        hooks: {},
        expectedRevision: 'r',
      })
      const rejected = expect(pending).rejects.toThrow('changed')
      await vi.waitFor(() => expect(create).toHaveBeenCalled())
      window.dispatchEvent(new Event('kcoder:servers-changed'))
      release()
      await rejected
      expect(client.requests.some(item => item.method === 'hooks/config/update')).toBe(false)
    } finally {
      release?.()
      await runtime.dispose()
    }
  })
})
