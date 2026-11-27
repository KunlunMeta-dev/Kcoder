import { afterEach, describe, expect, test, vi } from 'vitest'
import { withRefreshBudget } from '../refreshBudget'

afterEach(() => {
  vi.useRealTimers()
})

describe('bounded board refresh', () => {
  test('a settling refresh passes its value through', async () => {
    await expect(withRefreshBudget(Promise.resolve('done'))).resolves.toBe('done')
  })

  test('a refresh that never settles is reported instead of blocking the affordance', async () => {
    vi.useFakeTimers()
    const pending = new Promise<string>(() => {})
    const budget = withRefreshBudget(pending, 8_000)
    const observed = expect(budget).rejects.toThrow('TASK_REFRESH_TIMEOUT')
    await vi.advanceTimersByTimeAsync(8_000)
    await observed
  })

  test('a rejection keeps its original error', async () => {
    await expect(withRefreshBudget(Promise.reject(new Error('target gone')))).rejects.toThrow(
      'target gone'
    )
  })
})
