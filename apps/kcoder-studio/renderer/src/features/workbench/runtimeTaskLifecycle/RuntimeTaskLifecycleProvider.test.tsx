import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { useRuntimeTaskLifecycle, useRuntimeTaskLifecycleStoreSnapshot } from './context'
import { RuntimeTaskLifecycleProvider } from './RuntimeTaskLifecycleProvider'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const setTaskActivity = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  setTaskActivity.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { kcoderDesktopHost: { setTaskActivity } })
})
afterEach(() => {
  Reflect.deleteProperty(window, 'kcoderDesktopHost')
  vi.restoreAllMocks()
})

test('peer lifecycle updates leave the selected task display idle while global consumers update', () => {
  const store = new RuntimeTaskLifecycleStore('task-display-scope')
  const address = { deviceId: 'owned-target', taskId: 'owned-task' }
  store.turnStarted(address, 'owned-turn')
  const selected = vi.fn(), global = vi.fn()
  function TaskDisplay() {
    const snapshot = useRuntimeTaskLifecycle(address)
    selected(snapshot)
    return <output data-testid="task-active">{String(snapshot?.derived.isBusy)}</output>
  }
  function GlobalDisplay() {
    global(useRuntimeTaskLifecycleStoreSnapshot())
    return null
  }
  const page = render(<RuntimeTaskLifecycleProvider store={store}>
    <TaskDisplay /><GlobalDisplay />
  </RuntimeTaskLifecycleProvider>)
  try {
    const before = selected.mock.calls.length, globalBefore = global.mock.calls.length
    const original = store.getTask(address)
    for (let index = 0; index < 40; index++) act(() => store.turnStarted(
      index % 2 ? { ...address, deviceId: `peer-target-${index}` }
        : { ...address, taskId: `peer-task-${index}` }, `peer-turn-${index}`))
    expect(global).toHaveBeenCalledTimes(globalBefore + 40)
    expect(selected).toHaveBeenCalledTimes(before)
    expect(store.getTask(address)).toBe(original)
    expect(page.getByTestId('task-active')).toHaveTextContent('true')
    act(() => store.turnSettled(address, 'owned-turn'))
    expect(selected).toHaveBeenCalledTimes(before + 1)
    expect(page.getByTestId('task-active')).toHaveTextContent('false')
    expect(original?.derived.isBusy).toBe(true)
    expect(store.getTask(address)).not.toBe(original)
    act(() => store.remove(address))
    expect(selected).toHaveBeenCalledTimes(before + 2)
    expect(selected.mock.calls.at(-1)?.[0]).toBeNull()
  } finally { page.unmount() }
})

test('task and store replacement retire the previous display selection', () => {
  const original = new RuntimeTaskLifecycleStore('display-original-store')
  const replacement = new RuntimeTaskLifecycleStore('display-replacement-store')
  const first = { deviceId: 'owned-target', taskId: 'first' }
  const second = { ...first, taskId: 'second' }
  original.turnStarted(first, 'first-turn')
  const observed = vi.fn()
  let currentStore = original
  const view = renderHook(({ address }) => {
    const snapshot = useRuntimeTaskLifecycle(address)
    observed(snapshot)
    return snapshot
  }, { initialProps: { address: first as RuntimeTaskAddress | null },
    wrapper: ({ children }) => <RuntimeTaskLifecycleProvider store={currentStore}>{children}</RuntimeTaskLifecycleProvider>,
  })
  try {
    expect(view.result.current?.derived.isBusy).toBe(true)
    act(() => original.rename(first, second))
    expect(view.result.current).toBeNull()
    view.rerender({ address: second })
    expect(view.result.current?.address.taskId).toBe(second.taskId)
    expect(view.result.current?.derived.isBusy).toBe(true)
    currentStore = replacement
    view.rerender({ address: second })
    expect(view.result.current).toBeNull()
    expect(setTaskActivity.mock.calls.slice(-2)).toEqual([[null], [0]])
    const before = observed.mock.calls.length
    const publications = setTaskActivity.mock.calls.length
    act(() => original.turnSettled(second))
    expect(observed).toHaveBeenCalledTimes(before)
    expect(setTaskActivity).toHaveBeenCalledTimes(publications)
    act(() => replacement.turnStarted(second, 'replacement-turn'))
    expect(view.result.current?.derived.isBusy).toBe(true)
    view.rerender({ address: null })
    expect(view.result.current).toBeNull()
    const empty = observed.mock.calls.length
    act(() => replacement.turnSettled(second, 'replacement-turn'))
    expect(observed).toHaveBeenCalledTimes(empty)
  } finally { view.unmount() }
})

test('desktop activity includes pending tasks without sidebar entries and becomes unknown on unmount', () => {
  const store = new RuntimeTaskLifecycleStore('desktop-tray-fixture')
  const { unmount } = render(
    <RuntimeTaskLifecycleProvider store={store}>
      <div />
    </RuntimeTaskLifecycleProvider>
  )
  expect(setTaskActivity).toHaveBeenLastCalledWith(0)
  const address = { deviceId: 'local', taskId: 'pending-task', workspacePath: '/fixture' }
  act(() => store.sendRequested(address))
  expect(setTaskActivity).toHaveBeenLastCalledWith(1)
  act(() => store.sendRejected(address))
  expect(setTaskActivity).toHaveBeenLastCalledWith(0)
  unmount()
  expect(setTaskActivity).toHaveBeenLastCalledWith(null)
  const count = setTaskActivity.mock.calls.length
  act(() => store.sendRequested(address))
  expect(setTaskActivity).toHaveBeenCalledTimes(count)
})


test('unchanged running counts share pending and completed desktop publications', async () => {
  let finish!: () => void
  setTaskActivity.mockReset().mockResolvedValue(undefined)
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const store = new RuntimeTaskLifecycleStore('desktop-publication-count')
  const address = { deviceId: 'local', taskId: 'running-task' }
  const peer = { ...address, taskId: 'peer-task' }
  store.turnStarted(address, 'turn')
  const page = render(<RuntimeTaskLifecycleProvider store={store}><div /></RuntimeTaskLifecycleProvider>)
  try {
    for (let index = 0; index < 40; index++) act(() => store.goalStatusReceived(peer, index % 2 ? 'paused' : 'active'))
    expect(setTaskActivity.mock.calls).toEqual([[1]])
    await act(async () => finish())
    act(() => store.goalStatusReceived(peer, 'paused'))
    expect(setTaskActivity.mock.calls).toEqual([[1]])
    act(() => store.turnSettled(address, 'turn'))
    expect(setTaskActivity.mock.calls).toEqual([[1], [0]])
  } finally { finish(); page.unmount() }
  expect(setTaskActivity.mock.calls).toEqual([[1], [0], [null]])
})

test.each(['rejected', 'thrown'])('a %s desktop publication retries on the next notification without a timer', async outcome => {
  const failure = new Error('desktop publication rejected')
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  setTaskActivity.mockReset().mockResolvedValue(undefined).mockImplementationOnce(() => {
    if (outcome === 'thrown') throw failure
    return Promise.reject(failure)
  })
  const store = new RuntimeTaskLifecycleStore('desktop-publication-retry')
  const peer = { deviceId: 'local', taskId: 'peer-task' }
  const page = render(<RuntimeTaskLifecycleProvider store={store}><div /></RuntimeTaskLifecycleProvider>)
  try {
    await act(async () => {})
    expect(setTaskActivity.mock.calls).toEqual([[0]])
    await act(async () => store.goalStatusReceived(peer, 'paused'))
    act(() => store.goalStatusReceived(peer, 'active'))
    expect(setTaskActivity.mock.calls).toEqual([[0], [0]])
    expect(errors).toHaveBeenCalledExactlyOnceWith('Failed to synchronize desktop task activity', failure)
  } finally { page.unmount(); errors.mockRestore() }
  expect(setTaskActivity.mock.calls).toEqual([[0], [0], [null]])
})

test('a late desktop failure cannot retire a newer publication with the same count', async () => {
  let reject!: (error: Error) => void
  const failure = new Error('old desktop publication rejected')
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  setTaskActivity.mockReset().mockResolvedValue(undefined)
    .mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
  const store = new RuntimeTaskLifecycleStore('desktop-publication-late-failure')
  const address = { deviceId: 'local', taskId: 'pending-task' }
  const page = render(<RuntimeTaskLifecycleProvider store={store}><div /></RuntimeTaskLifecycleProvider>)
  try {
    act(() => store.sendRequested(address))
    await act(async () => store.sendRejected(address))
    await act(async () => reject(failure))
    act(() => store.goalStatusReceived({ ...address, taskId: 'peer-task' }, 'paused'))
    expect(setTaskActivity.mock.calls).toEqual([[0], [1], [0]])
    expect(errors).toHaveBeenCalledExactlyOnceWith('Failed to synchronize desktop task activity', failure)
  } finally { reject(failure); page.unmount(); errors.mockRestore() }
  expect(setTaskActivity.mock.calls).toEqual([[0], [1], [0], [null]])
})


test('ordinary Web performs no native activity subscription or snapshot reads during lifecycle updates', () => {
  Reflect.deleteProperty(window, 'kcoderDesktopHost')
  const store = new RuntimeTaskLifecycleStore('web-no-native-activity')
  const subscribe = vi.spyOn(store, 'subscribe')
  const read = vi.spyOn(store, 'getSnapshot')
  const page = render(<RuntimeTaskLifecycleProvider store={store}><div /></RuntimeTaskLifecycleProvider>)
  try {
    for (let index = 0; index < 40; index++) act(() => store.turnStarted({
      deviceId: 'owned-target', taskId: `task-${index}`,
    }, `turn-${index}`))
    expect({ subscriptions: subscribe.mock.calls.length, reads: read.mock.calls.length })
      .toEqual({ subscriptions: 0, reads: 0 })
    expect(store.getTask({ deviceId: 'owned-target', taskId: 'task-39' })?.derived.isBusy).toBe(true)
    expect(setTaskActivity).not.toHaveBeenCalled()
  } finally { page.unmount() }
})

test('host appearance, replacement and removal keep activity publications with their original owner', () => {
  Reflect.deleteProperty(window, 'kcoderDesktopHost')
  const store = new RuntimeTaskLifecycleStore('native-activity-owner')
  const address = { deviceId: 'owned-target', taskId: 'task' }
  const view = () => <RuntimeTaskLifecycleProvider store={store}><div /></RuntimeTaskLifecycleProvider>
  const page = render(view())
  const replacement = vi.fn().mockResolvedValue(undefined)
  try {
    act(() => store.sendRequested(address))
    Object.assign(window, { kcoderDesktopHost: { setTaskActivity } })
    page.rerender(view())
    expect(setTaskActivity.mock.calls).toEqual([[1]])
    Object.assign(window, { kcoderDesktopHost: { setTaskActivity: replacement } })
    page.rerender(view())
    expect(setTaskActivity.mock.calls).toEqual([[1], [null]])
    expect(replacement.mock.calls).toEqual([[1]])
    Reflect.deleteProperty(window, 'kcoderDesktopHost')
    page.rerender(view())
    expect(replacement.mock.calls).toEqual([[1], [null]])
    act(() => store.sendRejected(address))
    expect(replacement.mock.calls).toEqual([[1], [null]])
    expect(setTaskActivity.mock.calls).toEqual([[1], [null]])
  } finally { page.unmount() }
})
