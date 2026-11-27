import { afterEach, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './localServices'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { WorkspaceScanCancelledError } from '@/kcoder/workspaceScanError'

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
          { id: 'selected', label: 'Selected', transport: 'local', labelKey: 'currentComputer' },
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
    expect((await loading)[0].nameKey).toBe('currentComputer')
    expect((await loading)[1].nameKey).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    const refresh = services.executorClient!.commands.listDevices()
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/servers/status', { cache: 'no-store', signal: expect.any(AbortSignal) })
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

test('retired full-health reads stay cancelled instead of replacing the registry with a local fallback', async () => {
  gateway()
  let finish!: (response: Response) => void
  const fetch = vi.fn(async (url: unknown) => {
    if (url === '/api/servers') return Response.json({ servers: [{ id: 'health-cancel-device', label: 'Selected', transport: 'local' }] })
    return new Promise<Response>(resolve => { finish = resolve })
  })
  vi.stubGlobal('fetch', fetch)
  const services = createLocalAppServices({
    ensure: vi.fn().mockResolvedValue({ ready: true, running: true, deviceId: 'health-cancel-device' }),
    request: vi.fn(), subscribe: vi.fn(),
  })
  const pending = services.executorClient!.commands.listDevices()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/servers/status', { cache: 'no-store', signal: expect.any(AbortSignal) }))
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  notifyAccountContextChange('health-cancel-device')
  finish(Response.json({ statuses: [{ id: 'health-cancel-device', status: 'online', latencyMs: 1 }] }))
  await rejected
  expect(services.executorClient!.registry.list()).toEqual([])
})


test.each([undefined, 'selected'] as const)('a cancelled %s status does not publish an offline fallback device', async health => {
  gateway()
  const fetch = vi.fn((url: unknown, options: { signal: AbortSignal }) => {
    expect(url).toBe('/api/servers')
    return new Promise<Response>(resolve => options.signal.addEventListener('abort',
      () => resolve(Response.json({ servers: [] })), { once: true }))
  })
  vi.stubGlobal('fetch', fetch)
  const services = createLocalAppServices({
    ensure: vi.fn().mockRejectedValue(new WorkspaceScanCancelledError()),
    request: vi.fn(), subscribe: vi.fn(),
  })
  await expect(services.executorClient!.commands.listDevices(health ? { health } : undefined))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(services.executorClient!.registry.list()).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]).toEqual(['/api/servers', { cache: 'no-store', signal: expect.objectContaining({ aborted: true }) }])
})

test('bootstrap preflight and device metadata share the original unfinished directory read', async () => {
  gateway()
  const { fetchGatewayServers } = await import('@/kcoder/gatewayRpc')
  let release!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
  vi.stubGlobal('fetch', fetch)
  const services = createLocalAppServices({
    ensure: async () => {
      await fetchGatewayServers()
      return { ready: true, running: true, deviceId: 'selected' }
    },
    request: vi.fn(), subscribe: vi.fn(),
  })
  const reading = services.executorClient!.commands.listDevices({ health: 'selected' })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  fetch.mockResolvedValue(Response.json({ servers: [{ id: 'selected', label: 'Selected', transport: 'local' }] }))
  release(Response.json({ servers: [{ id: 'selected', label: 'Selected', transport: 'local' }] }))
  expect((await reading).map(device => device.device_id)).toEqual(['selected'])
  expect(fetch).toHaveBeenCalledTimes(1)
  await services.executorClient!.commands.listDevices({ health: 'selected' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each(['account', 'configuration', 'mount'] as const)('the completed directory cannot cross %s retirement while preflight is pending', async boundary => {
  gateway()
  let finish!: (status: { ready: boolean; running: boolean; deviceId: string }) => void
  const fetch = vi.fn(async () => Response.json({ servers: [{ id: 'selected', label: 'Original', transport: 'local' }] }))
  vi.stubGlobal('fetch', fetch)
  const services = createLocalAppServices({
    ensure: () => new Promise(resolve => { finish = resolve }),
    request: vi.fn(), subscribe: vi.fn(),
  })
  const prefix = document.createElement('meta')
  prefix.name = 'kcoder-app-base-path'
  const read = services.executorClient!.commands.listDevices({ health: 'selected' })
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    // Let the metadata result finish while the independent Native preflight stays pending.
    await new Promise(resolve => setTimeout(resolve, 0))
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    if (boundary === 'account') notifyAccountContextChange('selected')
    else if (boundary === 'configuration') window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
    else { prefix.content = '/g/device-owner-replacement'; document.head.append(prefix) }
    finish({ ready: true, running: true, deviceId: 'selected' })
    await rejected
    expect(services.executorClient!.registry.list()).toEqual([])
  } finally { prefix.remove(); finish({ ready: true, running: true, deviceId: 'selected' }) }
})

test('a new Gateway device read does not join a retired preflight held by the services adapter', async () => {
  gateway()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ servers: [{ id: 'replacement', label: 'Replacement', transport: 'local' }] })))
  let finish!: (status: { running: boolean; ready: boolean; deviceId: string }) => void
  const ensure = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ready: true, running: true, deviceId: 'replacement' })
  const services = createLocalAppServices({ ensure, request: vi.fn(), subscribe: vi.fn() })
  const old = services.deviceApi.listDevices({ health: 'selected' }).then(value => value, error => error)
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce())
  notifyAccountContextChange('replacement')
  const next = services.deviceApi.listDevices({ health: 'selected' })
  try {
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(await next).toEqual([expect.objectContaining({ device_id: 'replacement', status: 'online', is_default: true })])
    expect(await old).toMatchObject({ name: 'AbortError' })
  } finally { finish({ ready: true, running: true, deviceId: 'original' }); await Promise.allSettled([old, next]) }
})
