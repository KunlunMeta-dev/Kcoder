import { afterEach, expect, it, vi } from 'vitest'
import { readRuntimeClock } from './gatewayRuntimeClock'
import type { GatewayClient } from './gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

const context = vi.hoisted(() => ({ valid: true, generation: 0 }))
vi.mock('./accountContextEvents', async importOriginal => ({
  ...await importOriginal<typeof import('./accountContextEvents')>(),
  captureAccountContextRevision: () => {
    const generation = context.generation
    return () => context.valid && generation === context.generation
  },
}))
afterEach(() => { context.valid = true; context.generation = 0 })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(supported = true) {
  const request = vi.fn().mockResolvedValue({ sampledAtMs: 1795262400000 })
  const serverForParams = vi.fn().mockResolvedValue({ id: 'execution', host: 'remote', transport: 'ssh' })
  const client = { supportsExperimental: () => supported, request,
    diagnosticConnection: { connectionId: 'original-connection' } }
  const commandClient = vi.fn().mockResolvedValue(client)
  const runtime = {
    disposed: false, serverForParams, commandClient,
    accountEpochByTarget: new Map(), configurationEpochByTarget: new Map(),
    commandDirectoryRefresh: new Map(), appServerDisconnectedClients: new WeakSet(),
    captureReadSource: (target?: string) => KCoderGatewayRuntime.prototype.captureReadSource.call(
      runtime as unknown as GatewayRuntimeCore, target),
  }
  return { runtime: runtime as unknown as GatewayRuntimeCore, request, serverForParams, client, commandClient }
}

it('shares twelve pending samples, isolates returned objects, and samples again after completion', async () => {
  const { runtime, request } = fixture()
  const pending = deferred<{ sampledAtMs: number }>()
  request.mockReturnValueOnce(pending.promise)
  const reads = Array.from({ length: 12 }, () => readRuntimeClock(runtime, 'execution'))
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(request).toHaveBeenCalledTimes(1)
  } finally { pending.resolve({ sampledAtMs: 1000 }) }
  const values = await Promise.all(reads)
  expect(values).toEqual(Array.from({ length: 12 }, () => ({ sampledAtMs: 1000 })))
  values[0]!.sampledAtMs = 9
  expect(values[1]!.sampledAtMs).toBe(1000)
  expect(await readRuntimeClock(runtime, 'execution')).toEqual({ sampledAtMs: 1795262400000 })
  expect(request).toHaveBeenCalledTimes(2)
})

it('retires a failed shared sample and permits a fresh read', async () => {
  const { runtime, request } = fixture()
  const pending = deferred<{ sampledAtMs: number }>()
  request.mockReturnValueOnce(pending.promise)
  const reads = [readRuntimeClock(runtime, 'execution'), readRuntimeClock(runtime, 'execution')]
  const settled = Promise.allSettled(reads)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  pending.reject(new Error('owned sample failed'))
  expect((await settled).map(value => value.status)).toEqual(['rejected', 'rejected'])
  expect(await readRuntimeClock(runtime, 'execution')).not.toBeNull()
  expect(request).toHaveBeenCalledTimes(2)
})

it.each(['account', 'configuration', 'connection'])('does not share a sample across a changed %s', async change => {
  const { runtime, request, serverForParams, client } = fixture()
  const old = deferred<{ sampledAtMs: number }>()
  const fresh = deferred<{ sampledAtMs: number }>()
  request.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const oldResult = Promise.allSettled([readRuntimeClock(runtime, 'execution')])
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  if (change === 'account') context.generation++
  if (change === 'configuration') {
    runtime.configurationEpochByTarget.set('execution', {})
    serverForParams.mockResolvedValue({ id: 'execution', host: 'replacement', transport: 'ssh' })
  }
  if (change === 'connection') client.diagnosticConnection.connectionId = 'replacement-connection'
  const freshResult = readRuntimeClock(runtime, 'execution')
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  fresh.resolve({ sampledAtMs: 2000 })
  expect(await freshResult).toEqual({ sampledAtMs: 2000 })
  old.resolve({ sampledAtMs: 1000 })
  expect((await oldResult)[0]?.status).toBe('rejected')
})

it('does not share a pending sample between runtime owners even if a client is reused', async () => {
  const first = fixture(), second = fixture()
  second.commandClient.mockResolvedValue(first.client)
  const pending = deferred<{ sampledAtMs: number }>()
  first.request.mockReturnValue(pending.promise)
  const reads = [readRuntimeClock(first.runtime, 'execution'), readRuntimeClock(second.runtime, 'execution')]
  try { await vi.waitFor(() => expect(first.request).toHaveBeenCalledTimes(2)) }
  finally { pending.resolve({ sampledAtMs: 1000 }) }
  await Promise.all(reads)
})

it('reads the selected execution target once without polling or using the Gateway clock', async () => {
  const { runtime, request, serverForParams } = fixture()
  expect(await readRuntimeClock(runtime, 'execution')).toEqual({ sampledAtMs: 1795262400000 })
  expect(serverForParams).toHaveBeenCalledExactlyOnceWith({ deviceId: 'execution' })
  expect(request).toHaveBeenCalledExactlyOnceWith('server/resources/read', {})
})
it('does not guess support for an old target', async () => {
  const { runtime, request } = fixture(false)
  expect(await readRuntimeClock(runtime, 'execution')).toBeNull()
  expect(request).not.toHaveBeenCalled()
})
it('discards a result when account ownership changes during the read', async () => {
  const { runtime, request } = fixture()
  request.mockImplementation(async () => { context.valid = false; return { sampledAtMs: 1795262400000 } })
  await expect(readRuntimeClock(runtime, 'execution')).rejects.toThrow('Execution target changed')
})

it('routes the public runtime command without creating a conversation or sending a turn', async () => {
  const client = new FakeGatewayClient(null)
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'server/resources/read') {
      client.requests.push({ method, params })
      return { sampledAtMs: 1795262400000 } as T
    }
    return original<T>(method, params)
  }
  const runtime = new KCoderGatewayRuntime('fixture', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  try {
    await expect(runtime.request('runtime.clock.read', { serverId: 'local' }))
      .resolves.toEqual({ sampledAtMs: 1795262400000 })
    expect(client.requests.filter(request => request.method === 'server/resources/read')).toHaveLength(1)
    expect(client.requests.some(request => ['thread/start', 'turn/start'].includes(request.method))).toBe(false)
  } finally { await runtime.dispose() }
})

it.each(['success', 'failure'])('retires an old clock %s after target configuration changes back', async outcome => {
  const { runtime, request } = fixture()
  const pending = deferred<{ sampledAtMs: number }>()
  request.mockReturnValueOnce(pending.promise)
  const settled = Promise.allSettled([readRuntimeClock(runtime, 'execution')])
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  runtime.configurationEpochByTarget.set('execution', {})
  runtime.configurationEpochByTarget.set('execution', {})
  if (outcome === 'success') pending.resolve({ sampledAtMs: 1000 })
  else pending.reject(new Error('old Native failure'))
  const result = (await settled)[0]!
  expect(result.status).toBe('rejected')
  if (result.status === 'rejected') expect(String(result.reason)).toContain('Execution target changed')
})

it.each(['success', 'failure'])('rejects a clock %s after its original connection disconnects', async outcome => {
  const { runtime, request, client } = fixture()
  const pending = deferred<{ sampledAtMs: number }>()
  request.mockReturnValueOnce(pending.promise)
  const settled = Promise.allSettled([readRuntimeClock(runtime, 'execution')])
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  runtime.appServerDisconnectedClients.add(client as unknown as GatewayClient)
  if (outcome === 'success') pending.resolve({ sampledAtMs: 1000 })
  else pending.reject(new Error('old disconnected failure'))
  const result = (await settled)[0]!
  expect(result.status).toBe('rejected')
  if (result.status === 'rejected') expect(String(result.reason)).toContain('Execution target changed')
})

it.each(['success', 'failure'])('does not acquire a replacement client after stale target discovery %s', async outcome => {
  const { runtime, serverForParams, commandClient } = fixture()
  const pending = deferred<{ id: string }>()
  serverForParams.mockReturnValueOnce(pending.promise)
  const settled = Promise.allSettled([readRuntimeClock(runtime, 'execution')])
  runtime.configurationEpochByTarget.set('execution', {})
  if (outcome === 'success') pending.resolve({ id: 'execution' })
  else pending.reject(new Error('old discovery failure'))
  const result = (await settled)[0]!
  expect(result.status).toBe('rejected')
  if (result.status === 'rejected') expect(String(result.reason)).toContain('Execution target changed')
  expect(commandClient).not.toHaveBeenCalled()
})

it('preserves a current Native failure and resolves the target only once', async () => {
  const { runtime, serverForParams, request } = fixture()
  const failure = new Error('current Native failure')
  request.mockRejectedValueOnce(failure)
  await expect(readRuntimeClock(runtime, 'execution')).rejects.toBe(failure)
  expect(serverForParams).toHaveBeenCalledTimes(1)
})

it.each(['success', 'failure'])('does not sample after stale command connection acquisition %s', async outcome => {
  const { runtime, commandClient, client, request } = fixture()
  const pending = deferred<typeof client>()
  commandClient.mockReturnValueOnce(pending.promise)
  const settled = Promise.allSettled([readRuntimeClock(runtime, 'execution')])
  await vi.waitFor(() => expect(commandClient).toHaveBeenCalledTimes(1))
  runtime.configurationEpochByTarget.set('execution', {})
  if (outcome === 'success') pending.resolve(client)
  else pending.reject(new Error('old connect failure'))
  const result = (await settled)[0]!
  expect(result.status).toBe('rejected')
  if (result.status === 'rejected') expect(String(result.reason)).toContain('Execution target changed')
  expect(request).not.toHaveBeenCalled()
})

it('keeps a pending sample valid when another target changes configuration', async () => {
  const { runtime, request } = fixture()
  const pending = deferred<{ sampledAtMs: number }>()
  request.mockReturnValueOnce(pending.promise)
  const result = readRuntimeClock(runtime, 'execution')
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  runtime.configurationEpochByTarget.set('other-target', {})
  pending.resolve({ sampledAtMs: 1000 })
  await expect(result).resolves.toEqual({ sampledAtMs: 1000 })
})

it('does not dispatch a queued sample after its source retires before the shared read begins', async () => {
  const { runtime, client, request } = fixture()
  const supports = client.supportsExperimental
  client.supportsExperimental = () => {
    queueMicrotask(() => runtime.configurationEpochByTarget.set('execution', {}))
    return supports()
  }
  await expect(readRuntimeClock(runtime, 'execution')).rejects.toThrow('Execution target changed')
  expect(request).not.toHaveBeenCalled()
})
