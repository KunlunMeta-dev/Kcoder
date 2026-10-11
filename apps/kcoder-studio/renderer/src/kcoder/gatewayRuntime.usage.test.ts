import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

class UsageClient extends FakeGatewayClient {
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'usage/stats') {
      this.requests.push({ method, params })
      return { windowDays: 30, history: null } as T
    }
    return super.request<T>(method, params)
  }
}

describe.each([Runtime, InstalledRuntime])('target-owned token usage', RuntimeClass => {
  test('routes only to the selected target and never creates a conversation', async () => {
    const local = new UsageClient(null)
    const remote = new UsageClient(null)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/remote' },
      ],
      createClient: id => (id === 'remote' ? remote : local),
    })
    try {
      await runtime.request('runtime.usage.stats', { serverId: 'remote' })
      expect(remote.requests.filter(request => request.method === 'usage/stats')).toEqual([
        { method: 'usage/stats', params: {} },
      ])
      expect(local.requests).toEqual([])
      expect(remote.requests.some(request => request.method === 'thread/start')).toBe(false)
      remote.supportsExperimental = () => false
      await expect(runtime.request('runtime.usage.stats', { serverId: 'remote' })).rejects.toThrow(
        '升级'
      )
      await expect(runtime.request('runtime.usage.stats', {})).rejects.toThrow('target')
    } finally {
      await runtime.dispose()
    }
  })
})
