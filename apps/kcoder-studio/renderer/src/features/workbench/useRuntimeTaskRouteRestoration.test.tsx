import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { navigateTo } from '@/lib/navigation'
import { useRuntimeTaskRouteRestoration } from './useRuntimeTaskRouteRestoration'
const { state, open } = vi.hoisted(() => ({
  state: { isBootstrapping: false, currentRuntimeTask: null as unknown, runtimeWork: null },
  open: vi.fn(async () => {}),
}))
vi.mock('./useWorkbench', () => ({ useWorkbench: () => ({ state, openRuntimeTask: open }) }))
beforeEach(() => {
  vi.clearAllMocks()
  state.currentRuntimeTask = null
  state.isBootstrapping = false
  state.runtimeWork = null
  window.history.replaceState({}, '', '/')
})
test('a new route opens an imported idle thread without a runtime-list update', async () => {
  renderHook(() => useRuntimeTaskRouteRestoration())
  expect(open).not.toHaveBeenCalled()
  act(() => navigateTo('/runtime-tasks?deviceId=target&taskId=kcoder%3Atarget%3AAb123'))
  await waitFor(() =>
    expect(open).toHaveBeenCalledExactlyOnceWith(
      { deviceId: 'target', taskId: 'kcoder:target:Ab123' },
      { navigate: false }
    )
  )
})
test('query-only navigation can replace an already selected conversation', async () => {
  window.history.replaceState({}, '', '/runtime-tasks?deviceId=target&taskId=old')
  state.currentRuntimeTask = { deviceId: 'target', taskId: 'old' }
  renderHook(() => useRuntimeTaskRouteRestoration())
  expect(open).not.toHaveBeenCalled()
  act(() => navigateTo('/runtime-tasks?deviceId=target&taskId=new'))
  await waitFor(() =>
    expect(open).toHaveBeenCalledExactlyOnceWith(
      { deviceId: 'target', taskId: 'new' },
      { navigate: false }
    )
  )
})
test('bootstrap waits and an already selected route does not reopen the session', async () => {
  window.history.replaceState({}, '', '/runtime-tasks?deviceId=target&taskId=one')
  state.isBootstrapping = true
  const hook = renderHook(() => useRuntimeTaskRouteRestoration())
  expect(open).not.toHaveBeenCalled()
  state.isBootstrapping = false
  state.currentRuntimeTask = { deviceId: 'target', taskId: 'one' }
  hook.rerender()
  expect(hook.result.current).toBeNull()
  expect(open).not.toHaveBeenCalled()
})

test('expert conversation deep links retain their page and exact workspace', async () => {
  window.history.replaceState(
    {},
    '',
    '/expert-conversations?deviceId=target&taskId=original&workspacePath=%2Fowned&expertId=expert'
  )
  renderHook(() => useRuntimeTaskRouteRestoration())
  await waitFor(() =>
    expect(open).toHaveBeenCalledExactlyOnceWith(
      { deviceId: 'target', taskId: 'original', workspacePath: '/owned' },
      { navigate: false }
    )
  )
  expect(window.location.pathname).toBe('/expert-conversations')
})

test('unrelated work-list updates do not replay a pending original task opening', async () => {
  window.history.replaceState({}, '', '/runtime-tasks?deviceId=target&taskId=pending')
  open.mockImplementationOnce(() => new Promise(() => {}))
  const hook = renderHook(() => useRuntimeTaskRouteRestoration())
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  state.runtimeWork = { projects: [], chats: [] } as never
  hook.rerender()
  expect(open).toHaveBeenCalledTimes(1)
})
