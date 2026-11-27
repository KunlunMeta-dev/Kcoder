import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useTaskExpert } from './useTaskExpert'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import { Activity, type ReactNode } from 'react'
const request = vi.hoisted(() => vi.fn())
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: request }))
const address = { deviceId: 'original', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
const result = { threadId: 'thread', revision: 3, expert: null, turns: [] }
// A function returned from beforeEach is a teardown hook; never return the mock itself.
beforeEach(() => { request.mockReset() })

it('recovers an unavailable target by reading again without replaying a mutation', async () => {
  vi.useFakeTimers()
  request.mockRejectedValueOnce(new Error('AGENT_TURN_CONFIGURATION_UNSUPPORTED')).mockResolvedValueOnce(result)
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    expect(hook.result.current.error).toContain('UNSUPPORTED')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(hook.result.current.snapshot?.revision).toBe(3)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([, params]) => params.change === undefined)).toBe(true)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('resolves the persisted thread from the original runtime handle', async () => {
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert({ ...address, threadId: undefined, runtimeHandle: { threadId: 'thread' } }))
  await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
  expect(request.mock.calls[0][1].threadId).toBe('thread')
})

it('looks up a legacy task and pins an expert change to the resolved thread', async () => {
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert({ ...address, threadId: undefined }))
  await waitFor(() => expect(hook.result.current.snapshot?.threadId).toBe(result.threadId))
  expect(request.mock.calls[0][1]).toEqual({
    deviceId: address.deviceId, taskId: address.taskId, workspacePath: address.workspacePath,
  })
  request.mockResolvedValue({ ...result, revision: 4 })
  await act(() => hook.result.current.select(null))
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
    threadId: result.threadId, change: { expectedRevision: result.revision, expert: null },
  })
})

it('switches on the same task with the authoritative revision without creating a task', async () => {
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert(address))
  await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
  request.mockResolvedValue({ ...result, revision: 4 })
  await act(() => hook.result.current.select(null))
  expect(request).toHaveBeenLastCalledWith('runtime.taskExpert.request', {
    deviceId: 'original', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
    change: { expectedRevision: 3, expert: null },
  }, { signal: expect.any(AbortSignal) })
  expect(hook.result.current.snapshot?.revision).toBe(4)
})

it('ignores a late reply after switching to a different target with the same task id', async () => {
  let resolve!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockResolvedValueOnce({ ...result, revision: 8 })
  const hook = renderHook(({ deviceId }) => useTaskExpert({ ...address, deviceId }), { initialProps: { deviceId: 'original' } })
  hook.rerender({ deviceId: 'another' })
  await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(8))
  await act(async () => { resolve(result) })
  expect(hook.result.current.snapshot?.revision).toBe(8)
})

it('reconciles an unknown mutation by reading and never resubmits the change', async () => {
  request.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('transport lost'))
    .mockResolvedValueOnce({ ...result, revision: 4 })
  const hook = renderHook(() => useTaskExpert(address))
  await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
  await act(async () => { await expect(hook.result.current.select(null)).rejects.toThrow('transport lost') })
  expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
  expect(hook.result.current.snapshot?.revision).toBe(4)
})

it('refreshes the binding while visible, pauses polling while hidden, and reads on visibility return', async () => {
  vi.useFakeTimers()
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  setVisibility('visible')
  request.mockResolvedValueOnce(result)
    .mockResolvedValueOnce({ ...result, revision: 4 })
    .mockResolvedValueOnce({ ...result, revision: 5 })
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(hook.result.current.snapshot?.revision).toBe(4)
    expect(request).toHaveBeenCalledTimes(2)
    setVisibility('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(request).toHaveBeenCalledTimes(2)
    setVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(hook.result.current.snapshot?.revision).toBe(5)
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    hook.unmount()
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else delete (document as Partial<Document>).visibilityState
    vi.useRealTimers()
  }
})

it('marks a previously read binding unavailable after a failed refresh and clears it after recovery', async () => {
  vi.useFakeTimers()
  request.mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new Error('target temporarily unavailable'))
    .mockResolvedValueOnce({ ...result, revision: 4 })
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    expect(hook.result.current.snapshot?.revision).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(hook.result.current.error).toContain('temporarily unavailable')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(hook.result.current.snapshot?.revision).toBe(4)
    expect(hook.result.current.error).toBe('')
  } finally {
    hook.unmount()
    vi.useRealTimers()
  }
})

it('starts the next poll after a focus refresh instead of immediately repeating the read', async () => {
  vi.useFakeTimers()
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    expect(request).toHaveBeenCalledTimes(3)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('a successful manual refresh replaces a scheduled failure retry', async () => {
  vi.useFakeTimers()
  request.mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(9_900) })
    await act(async () => { await hook.result.current.refresh() })
    expect(hook.result.current.error).toBe('')
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    expect(request).toHaveBeenCalledTimes(3)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('resets the next poll when visibility returns instead of keeping the old interval', async () => {
  vi.useFakeTimers()
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  const show = (value: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, value })
  show('visible')
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    show('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(29_800) })
    expect(request).toHaveBeenCalledTimes(1)
    show('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    hook.unmount()
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else delete (document as Partial<Document>).visibilityState
    vi.useRealTimers()
  }
})

it('an old refresh callback cannot replace the new target poll', async () => {
  vi.useFakeTimers()
  request.mockResolvedValue(result)
  const hook = renderHook(({ deviceId }) => useTaskExpert({ ...address, deviceId }),
    { initialProps: { deviceId: 'original' } })
  try {
    await act(async () => {})
    const oldRefresh = hook.result.current.refresh
    hook.rerender({ deviceId: 'another' })
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    await act(async () => { await expect(oldRefresh()).rejects.toThrow('AGENT_ORIGINAL_TASK_REQUIRED') })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.at(-1)?.[1].deviceId).toBe('another')
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('a late read from the former target cannot schedule work or cancel current polling', async () => {
  vi.useFakeTimers()
  let finish!: (value: typeof result) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ...result, revision: 4 })
  const hook = renderHook(({ deviceId }) => useTaskExpert({ ...address, deviceId }),
    { initialProps: { deviceId: 'original' } })
  try {
    await act(async () => {})
    hook.rerender({ deviceId: 'another' })
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); finish(result) })
    expect(hook.result.current.snapshot?.revision).toBe(4)
    expect(hook.result.current.error).toBe('')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.at(-1)?.[1].deviceId).toBe('another')
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('a successful expert change postpones the next read and is never repeated by the poll', async () => {
  vi.useFakeTimers()
  request.mockResolvedValueOnce(result).mockResolvedValue({ ...result, revision: 4 })
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    await act(async () => { await hook.result.current.select(null) })
    expect(hook.result.current.snapshot?.revision).toBe(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
    expect(request.mock.calls.at(-1)?.[1].change).toBeUndefined()
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('pauses expert polling on a retained hidden page and reads once on return', async () => {
  vi.useFakeTimers()
  let active = true
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert(address), { wrapper: ({ children }: { children: ReactNode }) =>
    <RetainedPageActive.Provider value={active}>{children}</RetainedPageActive.Provider> })
  try {
    expect(document.visibilityState).toBe('visible')
    await act(async () => {})
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    active = false; hook.rerender()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(hook.result.current.snapshot?.revision).toBe(3)
    active = true; hook.rerender()
    await act(async () => {})
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_900) })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(request).toHaveBeenCalledTimes(3)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('does not read an initially hidden retained task until it becomes active', async () => {
  vi.useFakeTimers()
  let active = false
  request.mockResolvedValue(result)
  const hook = renderHook(() => useTaskExpert(address), { wrapper: ({ children }: { children: ReactNode }) =>
    <RetainedPageActive.Provider value={active}>{children}</RetainedPageActive.Provider> })
  try {
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(60_000) })
    expect(request).not.toHaveBeenCalled()
    active = true; hook.rerender()
    await act(async () => {})
    expect(request).toHaveBeenCalledTimes(1)
    expect(hook.result.current.snapshot?.revision).toBe(3)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('keeps an accepted expert change and its lost-reply reconciliation alive while the page hides', async () => {
  vi.useFakeTimers()
  let active = true, rejectChange!: (error: Error) => void
  request.mockResolvedValueOnce(result)
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectChange = reject }))
    .mockResolvedValueOnce({ ...result, revision: 4 })
    .mockResolvedValue({ ...result, revision: 5 })
  const hook = renderHook(() => useTaskExpert(address), { wrapper: ({ children }: { children: ReactNode }) =>
    <RetainedPageActive.Provider value={active}>{children}</RetainedPageActive.Provider> })
  try {
    await act(async () => {})
    let outcome!: Promise<unknown>
    act(() => { outcome = hook.result.current.select(null).catch(error => error) })
    const signal = request.mock.calls[1][2].signal as AbortSignal
    active = false; hook.rerender()
    expect(signal.aborted).toBe(false)
    await act(async () => { rejectChange(new Error('transport lost')); await outcome })
    expect(hook.result.current.snapshot?.revision).toBe(4)
    expect(hook.result.current.busy).toBe(false)
    expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(request).toHaveBeenCalledTimes(3)
    active = true; hook.rerender()
    await act(async () => {})
    expect(request).toHaveBeenCalledTimes(4)
    expect(hook.result.current.snapshot?.revision).toBe(5)
    expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('a retired pre-change read cannot replace the successful change polling deadline', async () => {
  vi.useFakeTimers()
  let finish!: (value: typeof result) => void
  request.mockResolvedValueOnce(result)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ...result, revision: 4 })
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    let stale!: Promise<unknown>
    act(() => { stale = hook.result.current.refresh().catch(error => error) })
    await act(async () => { await hook.result.current.select(null) })
    await act(async () => { finish(result); await stale })
    expect(hook.result.current.snapshot?.revision).toBe(4)
    expect(hook.result.current.error).toBe('')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(request.mock.calls.length).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(request.mock.calls.length).toBe(4)
    expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it.each([['before', 3], ['during', 3], ['before', 4], ['during', 4]] as const)('unknown changes reconcile beyond the %s read, including unchanged revision %s', async (when, freshRevision) => {
  let finishRead!: (value: typeof result) => void, failChange!: (error: Error) => void
  let reads = 0
  request.mockImplementation((_method, params) => {
    if (params.change) return new Promise((_resolve, reject) => { failChange = reject })
    reads++
    if (reads === 2) return new Promise(resolve => { finishRead = resolve })
    return Promise.resolve({ ...result, revision: reads === 1 ? 3 : freshRevision })
  })
  const hook = renderHook(() => useTaskExpert(address))
  let stale!: Promise<unknown>, outcome!: Promise<unknown>
  const beginRead = () => { stale = hook.result.current.refresh().catch(error => error) }
  try {
    await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
    if (when === 'before') act(beginRead)
    act(() => { outcome = hook.result.current.select(null).catch(error => error) })
    if (when === 'during') act(beginRead)
    await act(async () => { failChange(new Error('lost original change receipt')); await Promise.resolve() })
    expect(request.mock.calls.length).toBe(4)
    await act(async () => { await outcome })
    expect(hook.result.current.snapshot?.revision).toBe(freshRevision)
    expect(hook.result.current.error).toContain('lost original change receipt')
    expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
    await act(async () => { finishRead(result); await stale })
    expect(hook.result.current.snapshot?.revision).toBe(freshRevision)
    expect(hook.result.current.error).toContain('lost original change receipt')
  } finally {
    if (finishRead) await act(async () => { finishRead(result); await stale; await outcome })
    hook.unmount()
  }
})

it('a former target mutation cannot retire the replacement target read when it settles', async () => {
  let finishChange!: (value: typeof result) => void, finishRead!: (value: typeof result) => void
  request.mockImplementation((_method, params) => {
    if (params.change) return new Promise(resolve => { finishChange = resolve })
    return params.deviceId === 'another'
      ? new Promise(resolve => { finishRead = resolve }) : Promise.resolve(result)
  })
  const hook = renderHook(({ deviceId }) => useTaskExpert({ ...address, deviceId }), { initialProps: { deviceId: 'original' } })
  try {
    await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
    let change!: Promise<unknown>
    act(() => { change = hook.result.current.select(null).catch(error => error) })
    hook.rerender({ deviceId: 'another' })
    await act(async () => { finishChange({ ...result, revision: 4 }); await change })
    let current!: Promise<unknown>
    act(() => { current = hook.result.current.refresh().catch(error => error) })
    expect(request.mock.calls.length).toBe(3)
    await act(async () => { finishRead({ ...result, revision: 8 }); await current })
    expect(hook.result.current.snapshot?.revision).toBe(8)
  } finally { hook.unmount() }
})

it('a retained owner replacement clears only its old mutation busy state and preserves the new read', async () => {
  let active = true, finishChange!: (value: typeof result) => void, finishRead!: (value: typeof result) => void
  let reads = 0
  request.mockImplementation((_method, params) => {
    if (params.change) return new Promise(resolve => { finishChange = resolve })
    reads++
    return reads === 1 ? Promise.resolve(result) : new Promise(resolve => { finishRead = resolve })
  })
  const hook = renderHook(() => useTaskExpert(address), { wrapper: ({ children }) =>
    <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity> })
  try {
    await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
    let change!: Promise<unknown>
    act(() => { change = hook.result.current.select(null).catch(error => error) })
    active = false; hook.rerender()
    active = true; hook.rerender()
    await act(async () => { finishChange({ ...result, revision: 4 }); await change })
    let current!: Promise<unknown>
    act(() => { current = hook.result.current.refresh().catch(error => error) })
    expect(request.mock.calls.length).toBe(3)
    await act(async () => { finishRead({ ...result, revision: 8 }); await current })
    expect(hook.result.current.snapshot?.revision).toBe(8)
    expect(hook.result.current.busy).toBe(false)
    expect(request.mock.calls.filter(([, params]) => params.change)).toHaveLength(1)
  } finally { hook.unmount() }
})

it('a retired operation cannot clear the replacement task mutation busy state', async () => {
  const finish: Record<string, (value: typeof result) => void> = {}
  request.mockImplementation((_method, params) => params.change
    ? new Promise(resolve => { finish[params.deviceId] = resolve })
    : Promise.resolve({ ...result, revision: params.deviceId === 'original' ? 3 : 8 }))
  const hook = renderHook(({ deviceId }) => useTaskExpert({ ...address, deviceId }), { initialProps: { deviceId: 'original' } })
  try {
    await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
    let old!: Promise<unknown>, current!: Promise<unknown>
    act(() => { old = hook.result.current.select(null).catch(error => error) })
    hook.rerender({ deviceId: 'another' })
    await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(8))
    act(() => { current = hook.result.current.select(null).catch(error => error) })
    expect(hook.result.current.busy).toBe(true)
    await act(async () => { finish.original({ ...result, revision: 4 }); await old })
    expect(hook.result.current.busy).toBe(true)
    await act(async () => { finish.another({ ...result, revision: 9 }); await current })
    expect(hook.result.current.snapshot?.revision).toBe(9)
    expect(hook.result.current.busy).toBe(false)
  } finally { hook.unmount() }
})

const busy = () => new Error('CHAT_TASK_LIFECYCLE_BUSY')
const timedOut = () => Object.assign(new Error('read timed out'), { name: 'GatewayRpcTimeoutError' })

it('keeps the last snapshot while the original task is compacting and recovers without an error', async () => {
  vi.useFakeTimers()
  request.mockResolvedValueOnce(result)
    .mockRejectedValueOnce(busy())
    .mockRejectedValueOnce(new Error('history source changed during resume preparation; prepare it again'))
    .mockRejectedValueOnce(timedOut())
    .mockResolvedValueOnce({ ...result, revision: 4 })
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    expect(hook.result.current.snapshot?.revision).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(request).toHaveBeenCalledTimes(2)
    expect(hook.result.current.error).toBe('')
    expect(hook.result.current.snapshot?.revision).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(request).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(request).toHaveBeenCalledTimes(4)
    expect(hook.result.current.error).toBe('')
    expect(hook.result.current.busy).toBe(false)
    expect(hook.result.current.snapshot?.revision).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(request).toHaveBeenCalledTimes(5)
    expect(hook.result.current.snapshot?.revision).toBe(4)
    expect(hook.result.current.error).toBe('')
    expect(request.mock.calls.every(([, params]) => params.change === undefined)).toBe(true)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('reports a transient failure that outlasts the bounded window even with a snapshot', async () => {
  vi.useFakeTimers()
  request.mockResolvedValueOnce(result).mockRejectedValue(timedOut())
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(590_000) })
    expect(hook.result.current.error).toBe('')
    expect(hook.result.current.snapshot?.revision).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(hook.result.current.errorReason).toBe('timeout')
    expect(request.mock.calls.every(([, params]) => params.change === undefined)).toBe(true)
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('loads quietly through transient failures without a snapshot, then reports the classified reason', async () => {
  vi.useFakeTimers()
  request.mockRejectedValue(busy())
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await act(async () => {})
    expect(hook.result.current.error).toBe('')
    expect(hook.result.current.busy).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(request).toHaveBeenCalledTimes(3)
    expect(hook.result.current.error).toBe('')
    expect(hook.result.current.busy).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(request).toHaveBeenCalledTimes(4)
    expect(hook.result.current.error).toContain('CHAT_TASK_LIFECYCLE_BUSY')
    expect(hook.result.current.errorReason).toBe('busy')
    expect(hook.result.current.snapshot).toBeUndefined()
    request.mockResolvedValue(result)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(hook.result.current.snapshot?.revision).toBe(3)
    expect(hook.result.current.error).toBe('')
  } finally { hook.unmount(); vi.useRealTimers() }
})

it('an explicit refresh keeps the snapshot on a transient failure and still rejects a persistent one', async () => {
  request.mockResolvedValueOnce(result)
  const hook = renderHook(() => useTaskExpert(address))
  try {
    await waitFor(() => expect(hook.result.current.snapshot?.revision).toBe(3))
    request.mockRejectedValueOnce(new Error('history commit is in progress; retry session preparation'))
    await act(async () => { await expect(hook.result.current.refresh()).resolves.toMatchObject({ revision: 3 }) })
    expect(hook.result.current.error).toBe('')
    request.mockRejectedValueOnce(new Error('CHAT_TASK_WORKSPACE_CHANGED'))
    await act(async () => {
      await expect(hook.result.current.refresh()).rejects.toThrow('CHAT_TASK_WORKSPACE_CHANGED')
    })
    expect(hook.result.current.errorReason).toBe('workspaceChanged')
    expect(request.mock.calls.every(([, params]) => params.change === undefined)).toBe(true)
  } finally { hook.unmount() }
})
