import { describe, expect, test, vi } from 'vitest'
import { GatewayRuntimeCore } from './gateway/runtime/core'
import { InstalledGatewayRuntime } from './gateway/install/runtime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'

function fixture(Runtime: typeof GatewayRuntimeCore) {
  localStorage.setItem('kcoder-studio:selected-server', 'local')
  const servers = [localGatewayServer(), localGatewayServer({ id: 'peer', workspacePath: '/peer' })]
  const clients: FakeGatewayClient[] = []
  const loadServers = vi.fn(async () => servers)
  const runtime = new Runtime('owned-status-test', {
    loadServers,
    createClient: () => {
      const client = new FakeGatewayClient(null)
      clients.push(client)
      return client
    },
  })
  return { runtime, servers, clients, loadServers }
}

describe.each([
  { name: 'source', Runtime: GatewayRuntimeCore },
  { name: 'installed', Runtime: InstalledGatewayRuntime },
])('$name status connection ownership', ({ Runtime }) => {
  test.each(['status-first', 'command-first', 'concurrent'] as const)(
    'status and commands use one existing owner (%s)', async order => {
      const f = fixture(Runtime)
      try {
        if (order === 'status-first') await f.runtime.status()
        else if (order === 'command-first') await f.runtime.commandClient(f.servers[0])
        const [status, command] = await Promise.all([
          f.runtime.status(), f.runtime.commandClient(f.servers[0]),
        ])
        expect(status).toMatchObject({ ready: true, deviceId: 'local' })
        expect(f.clients).toHaveLength(1)
        expect(command).toBe(f.clients[0])
        expect(f.runtime.connectionsByClient.size).toBe(1)
      } finally { await f.runtime.disposeAsync() }
    }
  )

  test.each(['other-workspace', 'native-management'] as const)(
    'status keeps its normal workspace/transport boundary (%s)', async kind => {
      const f = fixture(Runtime)
      try {
        const isolated = await f.runtime.commandClient(f.servers[0],
          kind === 'other-workspace' ? '/other' : undefined, kind === 'native-management')
        await f.runtime.status()
        const normal = await f.runtime.commandClient(f.servers[0])
        expect(normal).not.toBe(isolated)
        expect(f.clients).toHaveLength(2)
        expect(isolated.closed).toBe(false)
        expect(f.runtime.connectionsByClient.get(normal)).toMatchObject({
          workspacePath: '/workspace', nativeManagementOnly: false,
        })
      } finally { await f.runtime.disposeAsync() }
    }
  )

  test.each(['local', 'peer'])(
    'project activation selects %s without closing an existing command owner', async targetId => {
      const f = fixture(Runtime)
      try {
        await f.runtime.status()
        const original = await f.runtime.commandClient(f.servers[0])
        const target = f.servers.find(server => server.id === targetId)!
        await f.runtime.request('runtime.sidebar.projects.activate', {
          deviceId: target.id, workspacePath: target.workspacePath,
        })
        expect(original.closed).toBe(false)
        await expect(f.runtime.status()).resolves.toMatchObject({ ready: true, deviceId: targetId })
        expect(f.clients).toHaveLength(targetId === 'local' ? 1 : 2)
        expect(await f.runtime.commandClient(f.servers[0])).toBe(original)
      } finally { await f.runtime.disposeAsync() }
    }
  )

  test('an actual close invalidates the shared owner and the next status establishes a new one', async () => {
    const f = fixture(Runtime)
    try {
      await f.runtime.status()
      const original = await f.runtime.commandClient(f.servers[0])
      original.close()
      await f.runtime.status()
      const replacement = await f.runtime.commandClient(f.servers[0])
      expect(replacement).not.toBe(original)
      expect(f.clients).toHaveLength(2)
      expect(replacement.closed).toBe(false)
    } finally { await f.runtime.disposeAsync() }
  })

  test('account invalidation retires its status/command owner while preserving the peer', async () => {
    const f = fixture(Runtime)
    try {
      await f.runtime.status()
      const original = await f.runtime.commandClient(f.servers[0])
      const peer = await f.runtime.commandClient(f.servers[1])
      notifyAccountContextChange('local')
      expect(original.closed).toBe(true)
      expect(peer.closed).toBe(false)
      await f.runtime.status()
      expect(await f.runtime.commandClient(f.servers[0])).not.toBe(original)
      expect(await f.runtime.commandClient(f.servers[1])).toBe(peer)
      expect(f.clients).toHaveLength(3)
    } finally { await f.runtime.disposeAsync() }
  })

  test('a failed handshake is not retained as a healthy status or a completed result', async () => {
    const f = fixture(Runtime), create = f.runtime.createClient
    vi.spyOn(f.runtime, 'createClient').mockImplementationOnce((...args) => {
      const client = create(...args)
      vi.spyOn(client, 'connect').mockRejectedValueOnce(new Error('owned handshake failure'))
      return client
    })
    try {
      await expect(f.runtime.status()).rejects.toThrow('owned handshake failure')
      await expect(f.runtime.status()).resolves.toMatchObject({ ready: true })
      expect(f.clients).toHaveLength(2)
      expect(await f.runtime.commandClient(f.servers[0])).toBe(f.clients[1])
    } finally { await f.runtime.disposeAsync() }
  })

  test('a retired status entry cannot load a directory or allocate a connection', async () => {
    const f = fixture(Runtime)
    f.runtime.dispose()
    await expect(f.runtime.status()).rejects.toThrow()
    expect(f.loadServers).not.toHaveBeenCalled()
    expect(f.clients).toHaveLength(0)
    await f.runtime.disposeAsync()
  })
})
