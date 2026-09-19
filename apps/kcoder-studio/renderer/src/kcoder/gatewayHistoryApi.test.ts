import { expect, test, vi } from 'vitest'
import { advanceHistoryRefresh } from './gatewayHistoryApi'
import {
  historyRefreshInput,
  historyRefreshResult,
  type HistoryRefreshResult,
} from './gatewayHistoryRefresh'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const progress = (nextCursor: string): HistoryRefreshResult => ({
  status: 'building',
  nextCursor,
  examinedEntries: 128,
  indexedSessions: 3,
  issueCount: 0,
})

test('history refresh pauses at its step budget and resumes with the cursor', async () => {
  const step = vi.fn().mockResolvedValueOnce(progress('a')).mockResolvedValueOnce(progress('b'))
  const onCursor = vi.fn()
  const outcome = await advanceHistoryRefresh(step, {
    cancelled: () => false,
    onCursor,
    onProgress: vi.fn(),
    maxSteps: 2,
  })
  expect(outcome.paused).toBe(true)
  expect(step.mock.calls.map(call => call[0])).toEqual([
    { acknowledgeExternalWriters: true },
    { cursor: 'a' },
  ])
  expect(onCursor).toHaveBeenLastCalledWith('b')
})

test('history refresh closes an in-flight step using its new cursor, not the consumed one', async () => {
  let release!: (result: HistoryRefreshResult) => void
  let cancelled = false
  const step = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    .mockResolvedValue({
      status: 'cancelled',
      examinedEntries: 128,
      indexedSessions: 3,
      issueCount: 0,
    })
  const onProgress = vi.fn()
  const running = advanceHistoryRefresh(step, {
    cursor: 'old',
    cancelled: () => cancelled,
    onCursor: vi.fn(),
    onProgress,
  })
  cancelled = true
  release(progress('new'))
  await running
  expect(step.mock.calls.map(call => call[0])).toEqual([
    { cursor: 'old' },
    { cursor: 'new', cancel: true },
  ])
  expect(onProgress).not.toHaveBeenCalled()
})

test('history refresh rejects repeated cursors and never retries indefinitely', async () => {
  const step = vi.fn().mockResolvedValue(progress('same'))
  await expect(
    advanceHistoryRefresh(step, {
      cursor: 'same',
      cancelled: () => false,
      onCursor: vi.fn(),
      onProgress: vi.fn(),
    })
  ).rejects.toThrow('repeated')
  expect(step).toHaveBeenCalledTimes(2)
  expect(step).toHaveBeenLastCalledWith({ cursor: 'same', cancel: true })
})

test('history refresh validates acknowledgement, cancellation and result boundaries', () => {
  expect(() => historyRefreshResult({ status: ['ready'], examinedEntries: 0, indexedSessions: 0, issueCount: 0 })).toThrow()
  expect(() => historyRefreshResult({ status: 'ready', examinedEntries: 1, indexedSessions: 0, issueCount: 1 })).toThrow()
  expect(() => historyRefreshInput({ cancel: true })).toThrow()
  expect(() => historyRefreshInput({})).toThrow()
  expect(() => historyRefreshInput({ cursor: 'x', acknowledgeExternalWriters: true })).toThrow()
  expect(historyRefreshInput({ cursor: 'x', cancel: true })).toEqual({ cursor: 'x', cancel: true })
  expect(() => historyRefreshResult({ ...progress('x'), indexedSessions: -1 })).toThrow()
  expect(() => historyRefreshResult({ ...progress('x'), status: 'ready' })).toThrow()
  expect(
    historyRefreshResult({
      status: 'cancelled',
      examinedEntries: 0,
      indexedSessions: 0,
      issueCount: 0,
    }).status
  ).toBe('cancelled')
})

test('history refresh cannot exceed the hard step cap and pauses when the deadline is reached', async () => {
  let index = 0
  const step = vi.fn(async () => progress(`cursor-${index++}`))
  const callbacks = { cancelled: () => false, onCursor: vi.fn(), onProgress: vi.fn() }
  expect((await advanceHistoryRefresh(step, { ...callbacks, maxSteps: 1000 })).paused).toBe(true)
  expect(step).toHaveBeenCalledTimes(200)
  step.mockClear()
  expect((await advanceHistoryRefresh(step, { ...callbacks, maxDurationMs: 0 })).paused).toBe(true)
  expect(step).not.toHaveBeenCalled()
})
