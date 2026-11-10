import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeThreadGoalStatuses } from './goalStatusBatch'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('bounded Goal status reads', () => {
  it('keeps active Goals, verified absence, and unavailable observations distinct', async () => {
    const client = { request: vi.fn().mockResolvedValue({ observations: [
      { threadId: 'a', availability: 'available', status: 'active' },
      { threadId: 'b', availability: 'available', status: null },
      { threadId: 'c', availability: 'unavailable' },
    ] }) }
    const result = await observeThreadGoalStatuses(client, ['a', 'b', 'c'], () => false)
    expect(result.get('a')).toEqual({ availability: 'available', status: 'active' })
    expect(result.get('b')).toEqual({ availability: 'available', status: null })
    expect(result.get('c')).toEqual({ availability: 'unavailable' })
  })

  it('rejects duplicate or foreign thread observations for the whole batch', async () => {
    for (const rows of [
      [{ threadId: 'a', availability: 'available', status: null }, { threadId: 'a', availability: 'available', status: null }],
      [{ threadId: 'a', availability: 'available', status: null }, { threadId: 'other', availability: 'available', status: null }],
    ]) {
      const result = await observeThreadGoalStatuses({ request: vi.fn().mockResolvedValue({ observations: rows }) }, ['a', 'b'], () => false)
      expect([...result.values()]).toEqual([{ availability: 'unavailable' }, { availability: 'unavailable' }])
    }
  })

  it('bounds the number of reads and leaves unobserved rows unavailable', async () => {
    const ids = Array.from({ length: 10_001 }, (_, i) => `thread-${i}`)
    const client = { request: vi.fn().mockImplementation(async (_method, params) => ({
      observations: params.threadIds.map((threadId: string) => ({ threadId, availability: 'available', status: null })),
    })) }
    const result = await observeThreadGoalStatuses(client, ids, () => false, 60_000)
    expect(client.request).toHaveBeenCalledTimes(100)
    expect(result.get('thread-9999')).toEqual({ availability: 'available', status: null })
    expect(result.get('thread-10000')).toEqual({ availability: 'unavailable' })
  })

  it('stops waiting when the scan budget expires even if the transport ignores abort', async () => {
    vi.useFakeTimers()
    const result = observeThreadGoalStatuses({ request: vi.fn(() => new Promise(() => {})) }, ['a'], () => false, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect((await result).get('a')).toEqual({ availability: 'unavailable' })
  })

  it('does not continue sending batches after the read transport fails', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `thread-${i}`)
    const client = { request: vi.fn().mockRejectedValue(new Error('connection closed')) }
    const result = await observeThreadGoalStatuses(client, ids, () => false)
    expect(client.request).toHaveBeenCalledTimes(1)
    expect([...result.values()].every(value => value.availability === 'unavailable')).toBe(true)
  })

  it('discards a late result after the owning scan or account is retired', async () => {
    let finish!: (value: unknown) => void
    let retired = false
    const client = { request: vi.fn(() => new Promise(resolve => { finish = resolve })) }
    const result = observeThreadGoalStatuses(client, ['a'], () => retired)
    retired = true
    finish({ observations: [{ threadId: 'a', availability: 'available', status: 'complete' }] })
    expect((await result).get('a')).toEqual({ availability: 'unavailable' })
  })

  it('discards a response that arrives after the budget even if its timer was delayed', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(801)
    const result = await observeThreadGoalStatuses({ request: vi.fn().mockResolvedValue({
      observations: [{ threadId: 'a', availability: 'available', status: 'complete' }],
    }) }, ['a'], () => false)
    expect(result.get('a')).toEqual({ availability: 'unavailable' })
  })
})
