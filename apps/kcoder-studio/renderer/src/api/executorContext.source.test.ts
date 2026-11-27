import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './local/localServices'
import { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import {
  createGatewayIpcHandler,
  installGatewayIpc,
  installGatewayRuntimeLifecycle,
} from '@/kcoder/gatewayRuntimeInstall'
import { FakeGatewayClient, localGatewayServer } from '@/kcoder/gatewayRuntime.test-support'
import { createGatewayPageIpcHandler } from '@/kcoder/gateway/install/ipc'
import { InstalledGatewayRuntime } from '@/kcoder/gateway/install/runtime'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { ensureLocalExecutorStarted } from '@/host/localExecutor'

let ordinal = 0
const cleanup: (() => Promise<void> | void)[] = []
beforeEach(() => {
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  meta.content = 'owned-context-fixture'
  document.head.append(meta)
  cleanup.push(() => meta.remove())
})
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
  vi.restoreAllMocks()
  localStorage.clear()
})

function fixture(
  Runtime: typeof GatewayRuntimeCore,
  createIpcHandler: typeof createGatewayIpcHandler
) {
  const localId = `owned-context-${++ordinal}`
  const peerId = `${localId}-peer`
  localStorage.setItem('kcoder-studio:selected-server', localId)
  const servers = [
    localGatewayServer({ id: localId, label: 'Original', profile: 'original' }),
    localGatewayServer({ id: peerId, workspacePath: '/peer' }),
  ]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request =>
    Response.json(
      String(request).endsWith('/api/servers/status')
        ? { statuses: servers.map(server => ({ id: server.id, status: 'online' })) }
        : { servers }
    )
  )
  const clients: Array<{ targetId: string; client: FakeGatewayClient }> = []
  const runtime = new Runtime('owned-context-fixture', {
    createClient: targetId => {
      const client = new FakeGatewayClient(null)
      clients.push({ targetId, client })
      return client
    },
  })
  const installation = installGatewayRuntimeLifecycle({
    readToken: () => 'owned-context-fixture',
    createRuntime: () => runtime,
    createIpcHandler,
    installIpc: installGatewayIpc,
    registerWorkspaceRuntime: () => () => {},
    addBeforeUnload: () => {},
    removeBeforeUnload: () => {},
  })!
  cleanup.push(installation.cleanup)
  cleanup.push(() => runtime.disposeAsync())
  const services = createLocalAppServices()
  return {
    localId,
    peerId,
    servers,
    runtime,
    clients,
    api: services.deviceApi,
    executor: services.executorClient!,
  }
}

describe.each([
  { name: 'compatibility', Runtime: GatewayRuntimeCore, createIpcHandler: createGatewayIpcHandler },
  {
    name: 'installed-page',
    Runtime: InstalledGatewayRuntime,
    createIpcHandler: createGatewayPageIpcHandler,
  },
])('$name source ownership', ({ Runtime, createIpcHandler }) => {
  test('cold commands discover only their Runtime target without full-health preparation', async () => {
    const f = fixture(Runtime, createIpcHandler)
    await expect(f.executor.commands.getHomeDirectory(f.localId)).resolves.toBe('/home/test')
    await expect(f.executor.commands.getHomeDirectory(f.localId)).resolves.toBe('/home/test')
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/api/servers'])
    expect(f.clients.map(value => value.targetId)).toEqual([f.localId])
    expect(f.clients.flatMap(value => value.client.requests).filter(value => value.method === 'device/execute'))
      .toHaveLength(2)
  })

  test('a selected-only offline projection does not prohibit a command to a different actual target', async () => {
    const f = fixture(Runtime, createIpcHandler)
    await f.executor.commands.listDevices({ health: 'selected' })
    expect(f.executor.registry.list().find(value => value.deviceId === f.peerId)?.status).toBe('offline')
    await expect(f.executor.commands.getHomeDirectory(f.peerId)).resolves.toBe('/home/test')
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/api/servers'])
    expect(f.clients.map(value => value.targetId)).toEqual([f.localId, f.peerId])
    expect(f.clients[0].client.requests.filter(value => value.method === 'device/execute')).toHaveLength(0)
    expect(f.clients[1].client.requests.filter(value => value.method === 'device/execute')).toHaveLength(1)
  })

  test.each(['account', 'configuration'] as const)(
    'same-transport %s invalidation retires the registry snapshot',
    async reason => {
      const f = fixture(Runtime, createIpcHandler)
      await f.executor.commands.listDevices()
      expect(f.executor.registry.list()).toHaveLength(2)
      const source = f.api.captureReadSource!(f.localId)
      if (reason === 'account') notifyAccountContextChange(f.localId)
      else {
        f.servers[0] = { ...f.servers[0], profile: 'replacement' }
        window.dispatchEvent(
          new CustomEvent('kcoder:servers-changed', { detail: { targetId: f.localId } })
        )
      }
      await Promise.all([...f.runtime.commandDirectoryRefresh.values()].map(read => read.result))
      expect(f.executor.registry.list()).toEqual([])
      expect(source()).toBe(false)
      await expect(f.executor.commands.getHomeDirectory(f.localId)).resolves.toBe('/home/test')
      const reads = vi.mocked(fetch).mock.calls.length
      await f.executor.commands.getHomeDirectory(f.localId)
      expect(vi.mocked(fetch).mock.calls).toHaveLength(reads)
    }
  )

  test.each(['account', 'configuration'] as const)(
    'unrelated %s invalidation preserves an explicit command source but retires whole-directory facts',
    async reason => {
      const f = fixture(Runtime, createIpcHandler)
      await f.executor.commands.listDevices()
      const directory = f.api.captureReadSource!()
      const local = f.api.captureReadSource!(f.localId)
      if (reason === 'account') notifyAccountContextChange(f.peerId)
      else {
        f.servers[1] = { ...f.servers[1], profile: 'replacement' }
        window.dispatchEvent(
          new CustomEvent('kcoder:servers-changed', { detail: { targetId: f.peerId } })
        )
      }
      await Promise.all([...f.runtime.commandDirectoryRefresh.values()].map(read => read.result))
      expect(local()).toBe(true)
      expect(directory()).toBe(false)
      expect(f.executor.registry.list()).toEqual([])
    }
  )

  test('a failed authority refresh retires prior source facts and preserves the Runtime dispatch barrier', async () => {
    const f = fixture(Runtime, createIpcHandler)
    await f.executor.commands.listDevices()
    const source = f.api.captureReadSource!(f.localId)
    const request = vi.spyOn(f.runtime, 'request')
    vi.spyOn(f.runtime, 'loadServers').mockRejectedValue(new Error('owned metadata failure'))
    window.dispatchEvent(
      new CustomEvent('kcoder:servers-changed', { detail: { targetId: f.localId } })
    )
    await Promise.allSettled(
      [...f.runtime.commandDirectoryRefresh.values()].map(read => read.result)
    )
    expect(source()).toBe(false)
    expect(f.executor.registry.list()).toEqual([])
    await expect(f.executor.commands.getHomeDirectory(f.localId)).rejects.toThrow(
      'owned metadata failure'
    )
    expect(request).toHaveBeenCalledOnce()
    expect(f.clients.flatMap(value => value.client.requests).filter(value => value.method === 'device/execute'))
      .toHaveLength(0)
    await expect(f.runtime.commandDirectoryRefresh.get(f.localId)!.result).rejects.toThrow(
      'owned metadata failure'
    )
  })

  test('a removed explicit target fails in Runtime without falling back to the selected target', async () => {
    const f = fixture(Runtime, createIpcHandler)
    await f.executor.commands.listDevices()
    f.servers.splice(1, 1)
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: f.peerId } }))
    await Promise.all([...f.runtime.commandDirectoryRefresh.values()].map(read => read.result))
    vi.mocked(fetch).mockClear()
    await expect(f.executor.commands.getHomeDirectory(f.peerId)).rejects.toThrow(f.peerId)
    expect(fetch).not.toHaveBeenCalled()
    expect(f.clients.flatMap(value => value.client.requests).filter(value => value.method === 'device/execute'))
      .toHaveLength(0)
  })

  test.each(['account', 'configuration'] as const)(
    '%s invalidation while connecting cannot dispatch the old command', async reason => {
      const f = fixture(Runtime, createIpcHandler)
      await f.runtime.servers()
      let release!: () => void
      const client = new FakeGatewayClient(null)
      client.connectGate = new Promise<void>(resolve => { release = resolve })
      vi.spyOn(f.runtime, 'createClient').mockReturnValue(client)
      const reading = f.executor.commands.getHomeDirectory(f.localId)
      const outcome = reading.then(() => null, error => error)
      try {
        await vi.waitFor(() => expect(f.runtime.connectionsByClient.has(client)).toBe(true))
        if (reason === 'account') notifyAccountContextChange(f.localId)
        else {
          f.servers[0] = { ...f.servers[0], profile: 'replacement' }
          window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: f.localId } }))
        }
        await Promise.all([...f.runtime.commandDirectoryRefresh.values()].map(read => read.result))
        release()
        expect(await outcome).toBeInstanceOf(Error)
        expect(client.requests.filter(value => value.method === 'device/execute')).toHaveLength(0)
        expect(client.closed).toBe(true)
      } finally {
        release()
        await outcome
      }
    }
  )

  test('a disposed Runtime cannot start another directory read through its still-installed adapter', async () => {
    const f = fixture(Runtime, createIpcHandler)
    await f.executor.commands.listDevices()
    await f.runtime.disposeAsync()
    vi.mocked(fetch).mockClear()
    await expect(f.executor.commands.getHomeDirectory(f.localId)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  test('a current protected-target handshake failure still publishes the login-required status', async () => {
    const f = fixture(Runtime, createIpcHandler)
    f.servers[0] = { ...f.servers[0], security: { identity: { mode: 'kcoder-account' } } }
    vi.spyOn(f.runtime, 'createClient').mockImplementation(() => {
      const client = new FakeGatewayClient(null)
      vi.spyOn(client, 'connect').mockRejectedValue(new Error('owned current handshake failure'))
      return client
    })
    await expect(ensureLocalExecutorStarted()).resolves.toMatchObject({
      ready: false,
      accountLoginServerId: f.localId,
    })
  })
})
