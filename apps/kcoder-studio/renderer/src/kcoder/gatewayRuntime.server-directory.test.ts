import { afterEach, describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { fetchGatewayServersWithHealth } from './gatewayRpc'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

afterEach(() => vi.unstubAllGlobals())

describe.each([Runtime, InstalledRuntime])(
  'authenticated runtime target directory',
  RuntimeClass => {
    test('connects the selected target while an unrelated health request remains pending', async () => {
      let releaseHealth!: (response: Response) => void
      let releaseConnect!: () => void
      const healthGate = new Promise<Response>(resolve => {
        releaseHealth = resolve
      })
      const client = new FakeGatewayClient(null)
      client.connectGate = new Promise<void>(resolve => {
        releaseConnect = resolve
      })
      const connect = vi.spyOn(client, 'connect')
      const servers = [localGatewayServer(), localGatewayServer({ id: 'slow', transport: 'ssh' })]
      const fetch = vi.fn(async (url: unknown) => {
        if (url === '/api/servers') return Response.json({ servers })
        if (url === '/api/servers/status') return healthGate
        throw new Error(`Unexpected request: ${url}`)
      })
      vi.stubGlobal('fetch', fetch)
      localStorage.setItem('kcoder-studio:selected-server', 'local')
      const health = fetchGatewayServersWithHealth()
      await vi.waitFor(() =>
        expect(fetch).toHaveBeenCalledWith('/api/servers/status', { cache: 'no-store' })
      )
      const createClient = vi.fn(() => client)
      const runtime = new RuntimeClass('fixture-token', { createClient })
      let ready = false
      const status = runtime.status().then(value => {
        ready = true
        return value
      })
      try {
        await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
        expect(ready).toBe(false)
        expect(createClient).toHaveBeenCalledWith('local', 'fixture-token', 'runtime', undefined)
        releaseConnect()
        await expect(status).resolves.toMatchObject({
          ready: true,
          running: true,
          deviceId: 'local',
        })
        expect(createClient).toHaveBeenCalledOnce()
        expect(fetch.mock.calls.filter(([url]) => url === '/api/servers/status')).toHaveLength(1)
        expect(servers[1].status).toBeUndefined()
      } finally {
        releaseConnect()
        releaseHealth(Response.json({ statuses: [{ id: 'slow', status: 'offline' }] }))
        await health
        await status.catch(() => undefined)
        await runtime.dispose()
      }
    })

    test('does not report readiness when the selected target initialization fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ servers: [localGatewayServer()] }))
      )
      localStorage.setItem('kcoder-studio:selected-server', 'local')
      const client = new FakeGatewayClient(null)
      vi.spyOn(client, 'connect').mockRejectedValue(
        new Error('selected target refused initialization')
      )
      const runtime = new RuntimeClass('fixture-token', { createClient: () => client })
      try {
        await expect(runtime.status()).rejects.toThrow('selected target refused initialization')
        expect(client.closed).toBe(true)
      } finally {
        await runtime.dispose()
      }
    })

    test('an account target exposes login before its runtime becomes ready', async () => {
      const server = localGatewayServer({
        transport: 'ssh',
        security: { identity: { mode: 'kcoder-account', username: 'alice' } },
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ servers: [server] }))
      )
      const client = new FakeGatewayClient(null)
      vi.spyOn(client, 'connect').mockRejectedValue(new Error('Account authentication required'))
      const runtime = new RuntimeClass('fixture-token', { createClient: () => client })
      try {
        await expect(runtime.status()).resolves.toMatchObject({
          ready: false,
          running: true,
          accountLoginServerId: server.id,
        })
      } finally {
        await runtime.dispose()
      }
    })

    test('rejects an unavailable authenticated directory before opening any target', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 403 }))
      )
      const createClient = vi.fn(() => new FakeGatewayClient(null))
      const runtime = new RuntimeClass('fixture-token', { createClient })
      try {
        await expect(runtime.status()).rejects.toMatchObject({
          code: 403,
          operation: 'list-targets',
        })
        expect(createClient).not.toHaveBeenCalled()
      } finally {
        await runtime.dispose()
      }
    })
  }
)
