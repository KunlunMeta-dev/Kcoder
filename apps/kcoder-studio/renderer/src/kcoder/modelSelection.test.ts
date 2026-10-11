import { describe, expect, test, vi } from 'vitest'
import { negotiateModelSelector } from '../../../shared/modelSelection'

describe('qualified model capability negotiation', () => {
  test('new peers and legacy bare selections need no catalog request', async () => {
    const request = vi.fn()
    expect(await negotiateModelSelector({ request, supportsExperimental: () => true }, 'p::m')).toBe('p::m')
    expect(await negotiateModelSelector({ request }, 'm')).toBe('m')
    expect(request).not.toHaveBeenCalled()
  })
  test('flat legacy catalog preserves provider routing despite same model names', async () => {
    const request = vi.fn(async () => ({ data: [{ providerId: 'a', model: 'same' }, { providerId: 'b', model: 'same' }] }))
    expect(await negotiateModelSelector({ request }, 'b::same')).toBe('b')
    expect(request).toHaveBeenCalledTimes(1)
  })
  test('missing or mismatched default cannot silently become a bare model', async () => {
    const request = vi.fn(async () => ({ providers: [{ id: 'p', data: [{ model: 'different' }] }] }))
    await expect(negotiateModelSelector({ request }, 'p::desired')).rejects.toThrow('升级')
  })
  test('legacy catalog lookup has one bounded wait and no retry', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(() => new Promise(() => {}))
      const pending = expect(negotiateModelSelector({ request }, 'p::m')).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(10000)
      await pending
      expect(request).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
