import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTaskViewAttachment } from './useTaskViewAttachment'

const transport = vi.hoisted(() => ({
  attach: vi.fn().mockResolvedValue({ attached: true }),
  release: vi.fn().mockResolvedValue({ released: true }),
}))
vi.mock('./taskLifetime', () => ({ attachTaskView: transport.attach, releaseTaskView: transport.release }))
const address: RuntimeTaskAddress = { deviceId: 'target', taskId: 'kcoder:target:one', threadId: 'one' }
beforeEach(() => vi.clearAllMocks())

it('an idle visible pane attaches and navigation releases its exact incarnation', () => {
  const hook = renderHook(({ current, visible }) => useTaskViewAttachment(current, visible), {
    initialProps: { current: address as RuntimeTaskAddress | null, visible: true },
  })
  const first = transport.attach.mock.calls[0]
  expect(first[0]).toEqual(address)
  hook.rerender({ current: address, visible: false })
  expect(transport.release).toHaveBeenCalledWith(address, first[1])
  hook.rerender({ current: address, visible: true })
  expect(transport.attach).toHaveBeenCalledTimes(2)
  expect(transport.attach.mock.calls[1][1]).not.toBe(first[1])
  hook.unmount()
  expect(transport.release).toHaveBeenLastCalledWith(address, transport.attach.mock.calls[1][1])
})

it('an index/history-only page never claims attachment', () => {
  const hook = renderHook(() => useTaskViewAttachment(null, true))
  expect(transport.attach).not.toHaveBeenCalled()
  hook.unmount()
  expect(transport.release).not.toHaveBeenCalled()
})

it('hydrating the same task identity does not detach the running conversation', () => {
  const initial: RuntimeTaskAddress = { deviceId: 'target', taskId: 'kcoder:target:one' }
  const hook = renderHook(({ current }) => useTaskViewAttachment(current, true), {
    initialProps: { current: initial },
  })
  hook.rerender({ current: { ...initial, threadId: 'one', workspacePath: 'C:\\Users\\tester' } })
  hook.rerender({ current: { ...initial, threadId: 'one', workspacePath: 'C:/Users/tester/' } })
  expect(transport.attach).toHaveBeenCalledTimes(1)
  expect(transport.release).not.toHaveBeenCalled()
  hook.unmount()
  expect(transport.release).toHaveBeenCalledTimes(1)
})

it('changing the target still retires only the old conversation view', () => {
  const hook = renderHook(({ current }) => useTaskViewAttachment(current, true), {
    initialProps: { current: address },
  })
  const originalView = transport.attach.mock.calls[0][1]
  const next = { ...address, deviceId: 'another-target' }
  hook.rerender({ current: next })
  expect(transport.release).toHaveBeenCalledWith(address, originalView)
  expect(transport.attach).toHaveBeenLastCalledWith(next, expect.any(String))
  hook.unmount()
})
