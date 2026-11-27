import { afterEach, expect, test, vi } from 'vitest'
import { sharedRuntimeContext } from './connections'
import { requestRuntimeContextSettings } from './runtimeContextSettings'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { SharedRuntimeContext } from './contracts'
import { LEGACY_KCODER_STUDIO_STORAGE_KEYS } from '../../legacyRuntimeAbi'

const saved: SharedRuntimeContext = { instructions: 'original', personality: 'pragmatic',
  instructionsConfigured: true, personalityConfigured: true, configPath: null }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const target = { id: 'owned-context', transport: 'local' }
  const request = vi.fn<(method: string, params?: unknown) => Promise<SharedRuntimeContext>>(async () => ({ ...saved }))
  const client = { request, diagnosticConnection: { targetId: target.id, connectionId: 'original' } } as unknown as GatewayClient
  const runtime = { workspaceScanGeneration: 0, disposed: false,
    runtimeContextReads: new WeakMap(), serverForParams: vi.fn(async () => target),
    commandClient: vi.fn(async () => client),
  } as unknown as GatewayRuntimeCore
  runtime.sharedRuntimeContext = client => sharedRuntimeContext.call(runtime, client)
  const read = () => runtime.sharedRuntimeContext(client)
  const write = () => requestRuntimeContextSettings(runtime, { deviceId: target.id, instructions: 'new' }, 'instructions', true)
  return { runtime, client, request, read, write }
}
afterEach(() => localStorage.clear())

test('concurrent same-connection reads share only the unfinished Native request and return separate DTOs', async () => {
  const f = fixture(), gate = deferred<SharedRuntimeContext>()
  f.request.mockReturnValueOnce(gate.promise)
  const first = f.read(), second = f.read()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
  expect(f.request).toHaveBeenCalledTimes(1)
  gate.resolve({ ...saved })
  const [a, b] = await Promise.all([first, second])
  a.instructions = 'caller-only'
  expect(b.instructions).toBe('original')
  await f.read()
  expect(f.request).toHaveBeenCalledTimes(2)
  expect(f.runtime.runtimeContextReads.has(f.client)).toBe(false)
})

test.each(['generation', 'connection', 'disposal'] as const)('%s retirement refuses an old context result', async owner => {
  const f = fixture(), gate = deferred<SharedRuntimeContext>()
  f.request.mockReturnValueOnce(gate.promise)
  const result = f.read().catch(error => error)
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
  if (owner === 'generation') f.runtime.workspaceScanGeneration++
  if (owner === 'connection') f.client.diagnosticConnection!.connectionId = 'replacement'
  if (owner === 'disposal') f.runtime.disposed = true
  gate.resolve({ ...saved })
  expect(await result).toMatchObject({ name: 'AbortError' })
})

test('a replacement connection starts its own read while the old connection is still pending', async () => {
  const f = fixture(), gate = deferred<SharedRuntimeContext>()
  f.request.mockReturnValueOnce(gate.promise)
  const original = f.read().catch(error => error)
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
  f.client.diagnosticConnection!.connectionId = 'replacement'
  await expect(f.read()).resolves.toEqual(saved)
  gate.resolve({ ...saved })
  expect(await original).toMatchObject({ name: 'AbortError' })
  expect(f.request).toHaveBeenCalledTimes(2)
})

test('different Runtime or client owners never share pending context reads', async () => {
  const a = fixture(), b = fixture(), gate = deferred<SharedRuntimeContext>()
  a.request.mockReturnValueOnce(gate.promise)
  const first = a.read()
  await vi.waitFor(() => expect(a.request).toHaveBeenCalledTimes(1))
  await b.runtime.sharedRuntimeContext(a.client)
  await a.runtime.sharedRuntimeContext(b.client)
  gate.resolve({ ...saved }); await first
  expect(a.request).toHaveBeenCalledTimes(2)
  expect(b.request).toHaveBeenCalledTimes(1)
})

test('failed shared reads are removed so a later caller can retry', async () => {
  const f = fixture(), gate = deferred<SharedRuntimeContext>()
  f.request.mockReturnValueOnce(gate.promise)
  const both = Promise.allSettled([f.read(), f.read()])
  await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
  gate.reject(new Error('offline'))
  expect((await both).map(result => result.status)).toEqual(['rejected', 'rejected'])
  await expect(f.read()).resolves.toEqual(saved)
  expect(f.request).toHaveBeenCalledTimes(2)
})

test('a write retires the older pending read and is never replayed', async () => {
  const f = fixture(), gate = deferred<SharedRuntimeContext>()
  f.request.mockReturnValueOnce(gate.promise)
  const old = f.read().catch(error => error)
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
  await f.write()
  gate.resolve({ ...saved })
  expect(await old).toMatchObject({ name: 'AbortError' })
  await f.read()
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.context.get', 'runtime.context.update', 'runtime.context.get'])
})

test('a read started during a write cannot supply the post-write reconciliation', async () => {
  const f = fixture(), writing = deferred<SharedRuntimeContext>(), reading = deferred<SharedRuntimeContext>()
  f.request.mockReturnValueOnce(writing.promise).mockReturnValueOnce(reading.promise)
  const write = f.write()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
  const beforeReceipt = f.read().catch(error => error)
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2))
  writing.resolve({ ...saved }); await write
  await expect(f.read()).resolves.toEqual(saved)
  reading.resolve({ ...saved })
  expect(await beforeReceipt).toMatchObject({ name: 'AbortError' })
  expect(f.request).toHaveBeenCalledTimes(3)
})

test('shared legacy restoration runs once and retains Native only-if-unconfigured protection', async () => {
  const f = fixture(), gate = deferred<SharedRuntimeContext>()
  localStorage.setItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions, 'legacy')
  f.request.mockReturnValueOnce(gate.promise)
  const both = Promise.all([f.read(), f.read()])
  await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
  gate.resolve({ ...saved, instructionsConfigured: false })
  await both
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.context.get', 'runtime.context.update'])
  expect(f.request).toHaveBeenLastCalledWith('runtime.context.update', { instructions: 'legacy', onlyIfUnconfigured: true })
})
