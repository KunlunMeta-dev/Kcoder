import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startWorkflowPolling, workflowRunPollDelay } from './workflowPolling'

const stops: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(1)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('a single failure recovers and repeated failures back off with a bounded delay', async () => {
  const poll = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(1000)
  const onError = vi.fn()
  stops.push(startWorkflowPolling({ poll, onError, isCurrent: () => true }))
  await vi.advanceTimersByTimeAsync(0)
  expect(onError).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(2)
  poll.mockRejectedValue(new Error('offline'))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1999)
  expect(poll).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(poll).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(poll.mock.calls.length).toBeLessThan(12)
})

test('hidden pages stop polling; returning to the foreground verifies immediately', async () => {
  const poll = vi.fn().mockResolvedValue(1000)
  stops.push(startWorkflowPolling({ poll, onError: vi.fn(), isCurrent: () => true }))
  await vi.advanceTimersByTimeAsync(0)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(1)
  Object.defineProperty(document, 'visibilityState', { value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(2)
})

test('in-flight refreshes are coalesced and disposed requests cannot publish state', async () => {
  let resolve!: (delay: number) => void
  let live!: () => boolean
  const poll = vi.fn().mockImplementation((isLive: () => boolean) => {
    live = isLive
    return new Promise<number>(done => {
      resolve = done
    })
  })
  const stop = startWorkflowPolling({ poll, onError: vi.fn(), isCurrent: () => true })
  stops.push(stop)
  window.dispatchEvent(new Event('online'))
  window.dispatchEvent(new Event('online'))
  expect(poll).toHaveBeenCalledTimes(1)
  resolve(1000)
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(2)
  stop()
  expect(live()).toBe(false)
  resolve(1000)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(2)
})

test('terminal runs retain a slow check so resume is detected without high idle traffic', () => {
  expect(workflowRunPollDelay('running')).toBe(1000)
  expect(workflowRunPollDelay('interrupted')).toBe(2500)
  for (const status of ['completed', 'failed', 'cancelled', undefined])
    expect(workflowRunPollDelay(status)).toBe(15_000)
})

test('change notifications are target and identity scoped, monotonic and coalesced', async () => {
  const poll = vi.fn().mockResolvedValue(15_000)
  stops.push(
    startWorkflowPolling({
      poll,
      onError: vi.fn(),
      isCurrent: () => true,
      changes: { serverId: 'target', definitionId: 'flow', runId: 'run' },
    })
  )
  await vi.advanceTimersByTimeAsync(0)
  const changed = (detail: object) =>
    window.dispatchEvent(new CustomEvent('kcoder:workflow-run-changed', { detail }))
  changed({ serverId: 'other', definitionId: 'flow', runId: 'run', revision: 2 })
  changed({ serverId: 'target', definitionId: 'flow', runId: 'other-run', revision: 2 })
  changed({ serverId: 'target', definitionId: 'other-flow', runId: 'run', revision: 2 })
  changed({ serverId: 'target', definitionId: 'flow', runId: 'run', revision: -1 })
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(1)
  changed({ serverId: 'target', definitionId: 'flow', runId: 'run', revision: 3 })
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(2)
  changed({ serverId: 'target', definitionId: 'flow', runId: 'run', revision: 2 })
  changed({ serverId: 'target', definitionId: 'flow', runId: 'run', revision: 3 })
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(poll).toHaveBeenCalledTimes(3)
})

test('terminal and hidden polling reduce request counts against the former one-second loop', async () => {
  const poll = vi.fn().mockResolvedValue(workflowRunPollDelay('completed'))
  stops.push(startWorkflowPolling({ poll, onError: vi.fn(), isCurrent: () => true }))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(5) // Previously 61 requests in the same minute.
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(5)
})

test('same content revision with a newer layout timestamp still invalidates the definition', async () => {
  const poll = vi.fn().mockResolvedValue(15_000)
  stops.push(
    startWorkflowPolling({
      poll,
      onError: vi.fn(),
      isCurrent: () => true,
      changes: { serverId: 'target', definitionId: 'flow' },
    })
  )
  await vi.advanceTimersByTimeAsync(0)
  const changed = (updatedAtMs: number) =>
    window.dispatchEvent(
      new CustomEvent('kcoder:workflow-definition-changed', {
        detail: { serverId: 'target', definitionId: 'flow', revision: 3, updatedAtMs },
      })
    )
  changed(10)
  await vi.advanceTimersByTimeAsync(0)
  changed(11)
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(3)
  changed(10)
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(3)
})

test('hidden and stopped polls abort reads, ignore late values and recover even if transport cannot abort', async () => {
  const signals: AbortSignal[] = []
  const lives: Array<() => boolean> = []
  const replies: Array<(delay: number) => void> = []
  const poll = vi.fn((isLive: () => boolean, signal: AbortSignal) => {
    signals.push(signal)
    lives.push(isLive)
    return new Promise<number>(resolve => replies.push(resolve))
  })
  const onError = vi.fn()
  const stop = startWorkflowPolling({ poll, onError, isCurrent: () => true })
  stops.push(stop)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(signals[0].aborted).toBe(true)
  expect(lives[0]()).toBe(false)
  Object.defineProperty(document, 'visibilityState', { value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(poll).toHaveBeenCalledTimes(2)
  replies[0](1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(2)
  expect(lives[0]()).toBe(false)
  expect(lives[1]()).toBe(true)
  stop()
  expect(signals[1].aborted).toBe(true)
  replies[1](1000)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(2)
  expect(onError).not.toHaveBeenCalled()
})

test('aborting an in-flight read does not report a reconnect failure', async () => {
  const onError = vi.fn()
  const stop = startWorkflowPolling({
    isCurrent: () => true,
    onError,
    poll: (_isLive, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  })
  stops.push(stop)
  stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(onError).not.toHaveBeenCalled()
})

test('a late cancellation failure does not increase the next live reconnect backoff', async () => {
  let rejectOld!: (error: unknown) => void
  const poll = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number>((_, reject) => {
          rejectOld = reject
        })
    )
    .mockResolvedValueOnce(1000)
    .mockRejectedValueOnce(new Error('current connection lost'))
    .mockResolvedValue(1000)
  const onError = vi.fn()
  stops.push(startWorkflowPolling({ poll, onError, isCurrent: () => true }))
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  Object.defineProperty(document, 'visibilityState', { value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  rejectOld(new DOMException('Aborted', 'AbortError'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(3)
  expect(onError).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(4)
})

test('a foreground snapshot that never returns expires and recovers without publishing its late value', async () => {
  let late!: (delay: number) => void
  let oldIsLive!: () => boolean
  let oldSignal!: AbortSignal
  const poll = vi
    .fn()
    .mockImplementationOnce((isLive: () => boolean, signal: AbortSignal) => {
      oldIsLive = isLive
      oldSignal = signal
      return new Promise<number>(resolve => {
        late = resolve
      })
    })
    .mockResolvedValue(15_000)
  const onError = vi.fn()
  stops.push(startWorkflowPolling({ poll, onError, isCurrent: () => true }))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(onError).toHaveBeenCalledTimes(1)
  expect(oldSignal.aborted).toBe(true)
  expect(oldIsLive()).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(2)
  late(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(2)
})
