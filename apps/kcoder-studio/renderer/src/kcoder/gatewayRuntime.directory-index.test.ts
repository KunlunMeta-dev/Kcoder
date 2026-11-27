import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { localGatewayServer } from './gatewayRuntime.test-support'
import { hookTargetScope } from './gatewayHookConfiguration'
import { WorkspaceScanCancelledError } from './workspaceScanError'
import type { GatewayServer } from './gatewayRpc'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('concurrent and warm target lookups index a loaded directory only once', async () => {
  const directory = Array.from({ length: 20 }, (_, index) => localGatewayServer({ id: `owner-${index}` }))
  const load = vi.fn().mockResolvedValue(directory)
  const runtime = new KCoderGatewayRuntime('owned-directory', { loadServers: load })
  const clear = vi.spyOn(runtime.serverIdentityById, 'clear')
  const write = vi.spyOn(runtime.serverIdentityById, 'set')
  try {
    await Promise.all(Array.from({ length: 100 }, () => runtime.serverForParams({ deviceId: directory[0].id })))
    expect(load).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledTimes(directory.length)
    for (let i = 0; i < 100; i++) await runtime.serverForParams({ deviceId: directory[1].id })
    expect(load).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledTimes(directory.length)
  } finally { await runtime.disposeAsync() }
})

test('a retired directory producer cannot replace the accepted replacement index', async () => {
  const old = deferred<GatewayServer[]>()
  const replacement = localGatewayServer({ id: 'current-owner', profile: 'replacement' })
  const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue([replacement])
  const runtime = new KCoderGatewayRuntime('owned-directory', { loadServers: load })
  try {
    const pending = runtime.servers().then(value => ({ value }), error => ({ error }))
    runtime.handleServersChanged()
    await expect(runtime.servers()).resolves.toEqual([replacement])
    old.resolve([localGatewayServer({ id: 'old-owner' })])
    expect(await pending).toEqual({ error: expect.any(WorkspaceScanCancelledError) })
    expect([...runtime.serverIdentityById]).toEqual([[replacement.id, hookTargetScope(replacement)]])
    expect(load).toHaveBeenCalledTimes(2)
  } finally { old.resolve([]); await runtime.disposeAsync() }
})

test('an already loaded directory still rejects an observer retired before its continuation', async () => {
  const original = localGatewayServer({ id: 'owner', profile: 'original' })
  const replacement = { ...original, profile: 'replacement' }
  const load = vi.fn().mockResolvedValueOnce([original]).mockResolvedValue([replacement])
  const runtime = new KCoderGatewayRuntime('owned-directory', { loadServers: load })
  try {
    await runtime.servers()
    const pending = runtime.servers().then(value => ({ value }), error => ({ error }))
    runtime.handleServersChanged()
    expect(await pending).toEqual({ error: expect.any(WorkspaceScanCancelledError) })
    await expect(runtime.servers()).resolves.toEqual([replacement])
    expect(runtime.serverIdentityById.get('owner')).toBe(hookTargetScope(replacement))
  } finally { await runtime.disposeAsync() }
})
