import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { useWorkControl } from '../useWorkControl'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))

const executor = vi.mocked(requestLocalExecutor)
const request = {
  workId: 'work-1',
  threadId: 'thread-1',
  workspacePath: '/owned',
  revision: 3,
  action: 'stop' as const,
}

beforeEach(() => executor.mockReset())
afterEach(() => vi.clearAllMocks())

test('control stays disabled and sends nothing until the target negotiates it', async () => {
  executor.mockResolvedValue({ status: 'unsupported', read: false, input: false, control: false })
  const { result } = renderHook(() => useWorkControl('owned-target'))
  await waitFor(() => expect(executor).toHaveBeenCalledWith(
    'runtime.continuousWork.capabilities',
    { deviceId: 'owned-target' }
  ))
  expect(result.current.enabled).toBe(false)

  executor.mockClear()
  await act(async () => {
    await result.current.submit(request)
  })
  expect(executor).not.toHaveBeenCalled()
  expect(result.current.receipt('work-1')).toBeUndefined()
})

test('an enabled target receives exactly one request and its state is shown', async () => {
  executor
    .mockResolvedValueOnce({ status: 'ready', read: true, input: true, control: true })
    .mockResolvedValueOnce({ state: 'settling', workId: 'work-1', requestId: 'request-1' })
  const { result } = renderHook(() => useWorkControl('owned-target'))
  await waitFor(() => expect(result.current.enabled).toBe(true))

  executor.mockClear()
  executor.mockResolvedValueOnce({ state: 'accepted', workId: 'work-1', requestId: 'x' })
  await act(async () => {
    await result.current.submit(request)
  })
  const control = executor.mock.calls.filter(call => call[0] === 'runtime.continuousWork.control')
  expect(control).toHaveLength(1)
  const params = control[0][1] as Record<string, unknown>
  expect(params).toMatchObject({
    deviceId: 'owned-target',
    workspacePath: '/owned',
    threadId: 'thread-1',
    workId: 'work-1',
    expectedRevision: 3,
    action: 'stop',
    target: { kind: 'work' },
  })
  expect(typeof params.requestId).toBe('string')
})

test('an unknown outcome blocks a resend until the work is re-read', async () => {
  executor
    .mockResolvedValueOnce({ status: 'ready', read: true, input: true, control: true })
    .mockRejectedValueOnce(new Error('reply lost'))
  const { result } = renderHook(() => useWorkControl('owned-target'))
  await waitFor(() => expect(result.current.enabled).toBe(true))

  await act(async () => {
    await result.current.submit(request)
  })
  expect(result.current.receipt('work-1')?.state).toBe('unknown')

  executor.mockClear()
  await act(async () => {
    await result.current.submit(request)
  })
  expect(executor).not.toHaveBeenCalled()

  executor.mockResolvedValueOnce({ status: 'ready', work: { workId: 'work-1' } })
  await act(async () => {
    await result.current.recheck({ workId: 'work-1', workspacePath: '/owned' })
  })
  expect(executor).toHaveBeenCalledWith('runtime.continuousWork.read', {
    deviceId: 'owned-target',
    workspacePath: '/owned',
    workId: 'work-1',
  })
  expect(result.current.receipt('work-1')?.state).toBe('reconciled')

  executor.mockResolvedValueOnce({ state: 'accepted', workId: 'work-1', requestId: 'y' })
  await act(async () => {
    await result.current.submit(request)
  })
  expect(
    executor.mock.calls.filter(call => call[0] === 'runtime.continuousWork.control')
  ).toHaveLength(1)
})
