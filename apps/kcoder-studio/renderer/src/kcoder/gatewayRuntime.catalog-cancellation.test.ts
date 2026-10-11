import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { createLocalAppServices } from '@/api/local/localServices'
import { registerGatewayCommandTransport } from './gatewayServiceBridge'
import { createGatewayIpcHandler } from './gatewayRuntimeInstall'
import { readModelCatalog } from '@/features/workbench/modelCatalogFlight'

describe.each([Runtime, InstalledRuntime])('catalog cancellation across service and adapter', RuntimeClass => {
  test('last subscriber removes the actual RPC waiter; the first cannot cancel another view', async () => {
    const client = new FakeGatewayClient('fixture-thread')
    let received: AbortSignal | undefined
    const original = client.request.bind(client)
    client.request = async <T>(method: string, params: Record<string, unknown> = {}, options?: { signal?: AbortSignal }): Promise<T> => {
      if (method !== 'runtime.models.list') return original<T>(method, params)
      received = options?.signal
      return new Promise<T>((_resolve, reject) => received?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    }
    const runtime = new RuntimeClass('fixture', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    const unregister = registerGatewayCommandTransport(createGatewayIpcHandler(runtime as Runtime))
    document.head.innerHTML = '<meta name="kcoder-rpc-token" content="fixture">'
    try {
      const services = createLocalAppServices()
      const a = new AbortController(), b = new AbortController()
      const target = { deviceId: 'local', workspacePath: '/workspace', taskId: undefined }
      const first = readModelCatalog(services.modelApi, 'local/workspace', target, a.signal)
      const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
      const second = readModelCatalog(services.modelApi, 'local/workspace', target, b.signal)
      const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(received).toBeInstanceOf(AbortSignal))
      a.abort(); await firstRejected
      expect(received!.aborted).toBe(false)
      b.abort(); await secondRejected
      expect(received!.aborted).toBe(true)
    } finally {
      unregister(); document.head.innerHTML = ''; await runtime.dispose()
    }
  })
})
