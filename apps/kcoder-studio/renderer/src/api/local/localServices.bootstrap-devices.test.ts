import { afterEach, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './localServices'

afterEach(() => {
  document.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function gateway() {
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  meta.content = 'fixture-only-token'
  document.head.append(meta)
}

test('bootstrap lists authenticated targets without waiting for unrelated health and primes executor routing', async () => {
  gateway()
  let releaseHealth!: (response: Response) => void
  const health = new Promise<Response>(resolve => {
    releaseHealth = resolve
  })
  const fetch = vi.fn(async (url: unknown) => {
    if (url === '/api/servers')
      return Response.json({
        servers: [
          { id: 'selected', label: 'Selected', transport: 'local' },
          { id: 'slow', label: 'Slow', transport: 'ssh' },
        ],
      })
    if (url === '/api/servers/status') return health
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const services = createLocalAppServices({
    ensure: vi.fn().mockResolvedValue({ ready: true, running: true, deviceId: 'selected' }),
    request: vi.fn(),
    subscribe: vi.fn(),
  })
  let settled = false
  const loading = services
    .executorClient!.commands.listDevices({ health: 'selected' })
    .then(value => {
      settled = true
      return value
    })
  try {
    await vi.waitFor(() => expect(settled).toBe(true))
    expect((await loading).map(device => [device.device_id, device.status])).toEqual([
      ['selected', 'online'],
      ['slow', 'offline'],
    ])
    await expect(services.executorClient!.registry.resolve('selected')).resolves.toMatchObject({
      status: 'online',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const refresh = services.executorClient!.commands.listDevices()
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/servers/status', { cache: 'no-store' })
    )
    releaseHealth(
      Response.json({
        statuses: [
          { id: 'selected', status: 'online' },
          { id: 'slow', status: 'online' },
        ],
      })
    )
    expect((await refresh).map(device => device.status)).toEqual(['online', 'online'])
  } finally {
    releaseHealth(Response.json({ statuses: [] }))
    await loading
  }
})

test.each([false, true])(
  'bootstrap never reports online when selected runtime ready=%s and running=false',
  async ready => {
    gateway()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          servers: [
            { id: 'selected', label: 'Selected', transport: 'local' },
            { id: 'unverified', label: 'Unverified', transport: 'local', status: 'online' },
          ],
        })
      )
    )
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ ready, running: false, deviceId: 'selected' }),
      request: vi.fn(),
      subscribe: vi.fn(),
    })
    const devices = await services.deviceApi.listDevices({ health: 'selected' })
    expect(devices.map(device => device.status)).toEqual(['offline', 'offline'])
  }
)
