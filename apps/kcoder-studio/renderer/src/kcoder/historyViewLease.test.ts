import { afterEach, expect, test, vi } from 'vitest'
import { HistoryViewLeaseController } from '../../../shared/historyViewLease'

function fixture() {
  let now = 1000, nonce = 0
  const lease = (requestId: string, sequence = 1) => ({ requestId, leaseId: `lease-${requestId}`, jobId: 'job', archiveId: 'archive', normalizationRevision: 'vendor/4', viewId: null,
    sequence, state: 'active' as const, remainingMs: 30_000, managedArchives: 1, legacyArchives: 0 })
  const api = {
    historyViewOpen: vi.fn(async (p: { requestId: string }) => ({ lease: lease(p.requestId) })),
    historyViewRead: vi.fn(async (p: { requestId: string }) => ({ lease: lease(p.requestId) })),
    historyViewRenew: vi.fn(async (p: { requestId: string; expectedSequence: number }) => ({ lease: lease(p.requestId, p.expectedSequence + 1) })),
    historyViewRelease: vi.fn(async (p: { requestId: string }) => ({ lease: { ...lease(p.requestId), state: 'released' as const, remainingMs: 0 } })),
  }
  const controller = new HistoryViewLeaseController(api, { jobId: 'job', archiveId: 'archive' }, () => `owned-${++nonce}`, () => now)
  return { api, controller, lease, clock: (value: number) => { now = value } }
}
const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => vi.useRealTimers())

test('request elapsed time is subtracted and an already expired reply cannot renew or reopen', async () => {
  vi.useFakeTimers(); const f = fixture(), response = pending<{ lease: ReturnType<typeof f.lease> }>()
  f.api.historyViewOpen.mockReturnValueOnce(response.promise)
  const open = f.controller.open(); f.clock(32_000)
  response.resolve({ lease: f.lease('owned-1') }); await open
  expect(f.controller.snapshot().state).toBe('expired')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.api.historyViewOpen).toHaveBeenCalledTimes(1)
  expect(f.api.historyViewRenew).not.toHaveBeenCalled()
  expect(f.api.historyViewRelease).toHaveBeenCalledWith({ requestId: 'owned-1', leaseId: 'lease-owned-1' })
  f.controller.dispose()
})

test('a pending renewal cannot revive protection after local expiry', async () => {
  vi.useFakeTimers(); const f = fixture(), response = pending<{ lease: ReturnType<typeof f.lease> }>()
  await f.controller.open(); f.api.historyViewRenew.mockReturnValueOnce(response.promise)
  f.clock(11_000); await vi.advanceTimersByTimeAsync(10_000)
  expect(f.api.historyViewRenew).toHaveBeenCalledTimes(1)
  f.clock(32_000); await vi.advanceTimersByTimeAsync(20_000)
  expect(f.controller.snapshot().state).toBe('expired')
  response.resolve({ lease: f.lease('owned-1', 2) }); await Promise.resolve(); await Promise.resolve()
  expect(f.controller.snapshot().state).toBe('expired')
  expect(f.api.historyViewOpen).toHaveBeenCalledTimes(1)
  expect(f.api.historyViewRelease).toHaveBeenCalledTimes(1)
  f.controller.dispose()
})

test('offline invalidation stops renewals and only an explicit new open gets a new nonce', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.controller.open()
  f.controller.invalidate(); await vi.advanceTimersByTimeAsync(60_000)
  expect(f.controller.snapshot().state).toBe('unconfirmed')
  expect(f.api.historyViewRenew).not.toHaveBeenCalled()
  expect(f.api.historyViewOpen).toHaveBeenCalledTimes(1)
  await f.controller.open()
  expect(f.api.historyViewOpen).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'owned-2' }))
  f.controller.dispose()
})

test('disposing before a late open reply cleans only the original API and never a replacement target', async () => {
  vi.useFakeTimers(); const original = fixture(), replacement = fixture(), response = pending<{ lease: ReturnType<typeof original.lease> }>()
  original.api.historyViewOpen.mockReturnValueOnce(response.promise)
  const open = original.controller.open()
  original.controller.dispose()
  response.resolve({ lease: original.lease('owned-1') }); await open; await Promise.resolve()
  expect(original.api.historyViewRelease).toHaveBeenCalled()
  expect(replacement.api.historyViewOpen).not.toHaveBeenCalled()
  expect(replacement.api.historyViewRelease).not.toHaveBeenCalled()
  replacement.controller.dispose()
})

test('an unknown open response is read back on the same nonce before explicit release', async () => {
  vi.useFakeTimers(); const f = fixture(); f.api.historyViewOpen.mockRejectedValueOnce(new Error('transport unknown'))
  await f.controller.open(); expect(f.controller.snapshot().state).toBe('unconfirmed')
  await f.controller.release()
  expect(f.api.historyViewRead).toHaveBeenCalledWith({ requestId: 'owned-1' })
  expect(f.api.historyViewRelease).toHaveBeenCalledWith({ requestId: 'owned-1', leaseId: 'lease-owned-1' })
  expect(f.api.historyViewOpen).toHaveBeenCalledTimes(1)
  expect(f.controller.snapshot().state).toBe('released')
  f.controller.dispose()
})
