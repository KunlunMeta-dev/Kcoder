import { expect, test, vi } from 'vitest'
import { computerUseStates } from './computerUseState'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

test('a server promise resolved after retirement never allocates or connects a client', async () => {
  const server = localGatewayServer()
  let release!: (servers: typeof server[]) => void
  const servers = new Promise<typeof server[]>(resolve => { release = resolve })
  const client = new FakeGatewayClient(null)
  const connect = vi.spyOn(client, 'connect')
  const create = vi.fn(() => client)
  const runtime = createTestGatewayRuntime('token', { loadServers: () => servers, createClient: create })
  const pending = runtime.controlClient()
  const rejected = expect(pending).rejects.toThrow()
  runtime.dispose()
  release([server])
  await rejected
  expect(create).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})

test('retired connection entry points reject before create/connect', async () => {
  const server = localGatewayServer()
  const create = vi.fn(() => new FakeGatewayClient(null))
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [server], createClient: create })
  runtime.dispose()
  for (const invoke of [() => runtime.connectClient(server), () => runtime.controlClient(), () => runtime.commandClient(server)])
    await expect(invoke()).rejects.toThrow()
  expect(create).not.toHaveBeenCalled()
})

test('synchronous projection cleanup cannot reenter connection allocation before the retired flag', async () => {
  const server = localGatewayServer()
  const create = vi.fn(() => new FakeGatewayClient(null))
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [server], createClient: create })
  let reentered!: Promise<unknown>
  vi.spyOn(computerUseStates, 'dispose').mockImplementationOnce(owner => {
    expect(owner).toBe(runtime)
    reentered = runtime.commandClient(server)
    void reentered.catch(() => {})
  })
  runtime.dispose()
  await expect(reentered).rejects.toThrow()
  expect(create).not.toHaveBeenCalled()
})

test('retirement still lets existing owner cleanup use its original client and closes that client', async () => {
  const server = localGatewayServer()
  const client = new FakeGatewayClient(null)
  const request = vi.spyOn(client, 'request').mockResolvedValue({ closed: true } as never)
  const close = vi.spyOn(client, 'close')
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [server], createClient: () => client })
  await runtime.connectClient(server)
  runtime.clientByTask.set('owned-task', client)
  vi.spyOn(runtime.browserRuntime, 'dispose').mockImplementation(async () => {
    await client.request('browser/close', { sessionId: 'owned-session' })
  })
  runtime.dispose()
  await runtime.disposeAsync()
  expect(request).toHaveBeenCalledExactlyOnceWith('browser/close', { sessionId: 'owned-session' })
  expect(close).toHaveBeenCalled()
})

test('retirement releases every connection role without requiring a business cache entry', async () => {
  const server = localGatewayServer()
  const clients: FakeGatewayClient[] = []
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [server],
    createClient: () => {
      const client = new FakeGatewayClient(null)
      clients.push(client)
      return client
    },
  })
  await runtime.connectClient(server)
  await runtime.connectClient(server, 'runtime', undefined, false, undefined, true)
  await runtime.connectClient(server, 'browser')
  expect(runtime.connectionsByClient.size).toBe(3)
  expect(runtime.clientByTask.size).toBe(0)
  expect(runtime.commandClientByServer.size).toBe(0)
  await runtime.disposeAsync()
  expect(clients.every(client => client.closed)).toBe(true)
  expect(runtime.connectionsByClient.size).toBe(0)
})

test('account invalidation releases only connections belonging to that target', async () => {
  const server = localGatewayServer()
  const peer = localGatewayServer({ id: 'peer' })
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [server, peer],
    createClient: () => new FakeGatewayClient(null),
  })
  const ordinary = await runtime.connectClient(server)
  const management = await runtime.connectClient(server, 'runtime', undefined, false, undefined, true)
  const browser = await runtime.connectClient(server, 'browser')
  const survivor = await runtime.connectClient(peer)
  runtime.invalidateAccountTarget(server.id)
  for (const client of [ordinary, management, browser])
    expect((client as FakeGatewayClient).closed).toBe(true)
  expect((survivor as FakeGatewayClient).closed).toBe(false)
  expect([...runtime.connectionsByClient.keys()]).toEqual([survivor])
})

test('a connection released before its handshake never starts connecting', async () => {
  const server = localGatewayServer()
  const client = new FakeGatewayClient(null)
  const connect = vi.spyOn(client, 'connect')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [server],
    createClient: () => client,
  })
  await expect(runtime.connectClient(server, 'runtime', undefined, false, created => {
    runtime.releaseClient(created)
  })).rejects.toThrow()
  expect(connect).not.toHaveBeenCalled()
  expect(client.closed).toBe(true)
  expect(runtime.connectionsByClient.size).toBe(0)
})

test('release invalidates command and control caches before delayed socket close events', async () => {
  const server = localGatewayServer()
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [server],
    createClient: () => new FakeGatewayClient(null),
  })
  const command = await runtime.commandClient(server)
  const control = await runtime.controlClient()
  for (const client of [command, control]) {
    vi.spyOn(client, 'close').mockImplementation(() => {})
    runtime.releaseClient(client)
  }
  expect(runtime.commandClientByServer.size).toBe(0)
  expect(runtime.commandClientScopeByKey.size).toBe(0)
  expect(runtime.controlClientPromise).toBeNull()
  const replacement = await runtime.commandClient(server)
  command.dispatchEvent(new Event('close'))
  control.dispatchEvent(new Event('close'))
  expect(await runtime.commandClient(server)).toBe(replacement)
  expect(runtime.connectionsByClient.size).toBe(1)
})
