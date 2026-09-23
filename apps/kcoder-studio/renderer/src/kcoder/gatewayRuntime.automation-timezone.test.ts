import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'
import '@/i18n'

describe.each([Runtime, InstalledRuntime])('timezone schedule capability', RuntimeClass => {
  test('old targets reject zoned creation before RPC but still accept legacy UTC', async () => {
    const client = new FakeGatewayClient(null)
    const originalRequest = client.request.bind(client)
    client.request = async <T>(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<T> => {
      if (method === 'cron/create') {
        client.requests.push({ method, params })
        return { accepted: true } as T
      }
      return originalRequest<T>(method, params)
    }
    client.supportsExperimental = capability =>
      !['cronTimezoneV1', 'cronPreviewV1'].includes(capability)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [{ id: 'local', transport: 'local', workspacePath: '/workspace' }],
      createClient: () => client,
    })
    const base = {
      address: { deviceId: 'local', workspacePath: '/workspace' },
      deviceId: 'local',
      method: 'cron/create',
    }
    try {
      await expect(
        runtime.request('runtime.automations.request', {
          ...base,
          params: {
            confirmed: true,
            prompt: 'review',
            schedule: { kind: 'zoned_cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo' },
          },
        })
      ).rejects.toThrow(/时区|timezone/)
      expect(client.requests.some(request => request.method === 'cron/create')).toBe(false)
      await expect(
        runtime.request('runtime.automations.request', {
          ...base,
          method: 'cron/preview',
          params: { schedule: { kind: 'cron', expression: '0 9 * * *' } },
        })
      ).rejects.toThrow(/预览|preview/)
      expect(client.requests.some(request => request.method === 'cron/preview')).toBe(false)
      await runtime.request('runtime.automations.request', {
        ...base,
        params: {
          confirmed: true,
          prompt: 'review',
          schedule: { kind: 'cron', expression: '0 9 * * *' },
        },
      })
      expect(client.requests.filter(request => request.method === 'cron/create')).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })
})
