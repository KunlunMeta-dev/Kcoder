import { afterEach, expect, it, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { sampleRuntimeClock } from './runtimeClock'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it('does not turn slow connection setup into extra elapsed time', async () => {
  let monotonic = 100
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  vi.mocked(requestLocalExecutor).mockImplementation(async <T>() => {
    monotonic += 20_000
    return { sampledAtMs: 1795262420000 } as T
  })
  const sample = await sampleRuntimeClock('remote')
  expect(sample?.serverTimeMs).toBe(1795262420000)
  expect(sample?.monotonicTimeMs).toBe(monotonic)
  expect(requestLocalExecutor).toHaveBeenCalledExactlyOnceWith('runtime.clock.read', { serverId: 'remote' })
})

it('does not manufacture a clock when the selected backend has no usable time fact', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue(null)
  expect(await sampleRuntimeClock('legacy')).toBeNull()
})
