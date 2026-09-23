import { expect, test, vi } from 'vitest'
import { invalidateModelCatalog, readModelCatalog } from './modelCatalogFlight'
import type { UnifiedModelListResponse } from '@/types/api'

test('two views share one read; cancelling one leaves the other live', async () => {
  let complete!: (value: UnifiedModelListResponse) => void
  let upstream!: AbortSignal
  const api = { listModels: vi.fn((_target, options) => {
    upstream = options.signal
    return new Promise<UnifiedModelListResponse>(resolve => { complete = resolve })
  }) }
  const a = new AbortController(), b = new AbortController()
  const first = readModelCatalog(api, 'owner:A:target:local', undefined, a.signal)
  const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const second = readModelCatalog(api, 'owner:A:target:local', undefined, b.signal)
  await Promise.resolve()
  expect(api.listModels).toHaveBeenCalledTimes(1)
  a.abort()
  await rejection
  expect(upstream.aborted).toBe(false)
  complete({ data: [] })
  await expect(second).resolves.toEqual({ data: [] })
})

test('last cancellation aborts the read and replacement does not join abandoned work', async () => {
  const signals: AbortSignal[] = []
  const api = { listModels: vi.fn((_target, options) => {
    signals.push(options.signal)
    return new Promise<UnifiedModelListResponse>(() => {})
  }) }
  const a = new AbortController()
  const promise = readModelCatalog(api, 'same', undefined, a.signal)
  const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve(); a.abort(); await rejection
  expect(signals[0].aborted).toBe(true)
  const b = new AbortController()
  const next = readModelCatalog(api, 'same', undefined, b.signal)
  const nextRejection = expect(next).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve(); expect(api.listModels).toHaveBeenCalledTimes(2)
  b.abort(); await nextRejection
})

test('configuration revision and account scope do not join stale work', async () => {
  const api = { listModels: vi.fn(async () => ({ data: [] })) }
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const old = readModelCatalog(api, 'A', undefined, controllers[0].signal)
  const event = new Event('configuration-changed')
  invalidateModelCatalog(api, event)
  const current = readModelCatalog(api, 'A', undefined, controllers[1].signal)
  invalidateModelCatalog(api, event)
  const shared = readModelCatalog(api, 'A', undefined, controllers[2].signal)
  const otherOwner = readModelCatalog(api, 'B', undefined, controllers[3].signal)
  await Promise.all([old, current, shared, otherOwner])
  expect(api.listModels).toHaveBeenCalledTimes(3)
})
