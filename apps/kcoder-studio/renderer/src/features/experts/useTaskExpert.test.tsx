import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useTaskExpert } from './useTaskExpert'
const request = vi.hoisted(() => vi.fn())
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: request }))
const address = { deviceId: 'original', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
const result = { threadId: 'thread', revision: 3, expert: null, turns: [] }
beforeEach(() => request.mockReset())

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
