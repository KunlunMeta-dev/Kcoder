import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import { toolPathPreviews, ToolPathPreviewConsumer } from '@/kcoder/toolPathPreview'
import { useProviderRetryActivity } from './useProviderRetryActivity'

function retryEvents() {
  const consumer = new ToolPathPreviewConsumer(), client = {}
  const sequences = new Map<string, number>()
  return {
    consumer,
    send(method: string, target = 'target', task = 'task', extra = {}) {
      const key = `${target}/${task}`, sequence = (sequences.get(key) ?? 0) + 1
      sequences.set(key, sequence)
      consumer.handle(method, { serverId: 'instance', threadId: task, turnId: 'turn',
        sequence, ...extra }, target, task, client)
    },
    retry(attempt: number, target = 'target', task = 'task') {
      this.send('item/event', target, task, { event: { type: 'system_notice', kind: 'provider_retry',
        request_kind: 'main', attempt, max_retries: 3, retry_after_ms: 5000 } })
    },
  }
}

test('unrelated progress does not rerender retry consumers, while retries and recovery still update', () => {
  const events = retryEvents(), render = vi.fn()
  const page = renderHook(() => { render(); return useProviderRetryActivity('target', 'task') })
  const otherLease = toolPathPreviews.acquire('other', 'task')
  try {
    act(() => { events.send('turn/started'); events.send('turn/started', 'other') })
    const before = render.mock.calls.length, revision = toolPathPreviews.snapshot()
    const read = vi.spyOn(toolPathPreviews, 'readProviderRetry')
    try {
      for (let chars = 1; chars <= 40; chars++) act(() => events.send('item/event', 'other', 'task', {
        event: { type: 'tool_input_progress', id: 'foreign-input', name: 'write', chars },
      }))
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
    for (let chars = 1; chars <= 40; chars++) act(() => {
      events.send('item/event', 'target', 'task', { event: {
        type: 'tool_input_progress', id: 'input', name: 'write', chars } })
      events.send('item/event', 'other', 'task', { event: {
        type: 'tool_input_progress', id: 'foreign-input', name: 'write', chars } })
    })
    expect(toolPathPreviews.snapshot()).toBeGreaterThanOrEqual(revision + 80)
    expect(render).toHaveBeenCalledTimes(before)
    act(() => events.retry(1))
    expect(page.result.current?.attempt).toBe(1)
    const waiting = render.mock.calls.length, activity = page.result.current
    for (let additions = 1; additions <= 40; additions++) act(() => {
      events.send('item/event', 'target', 'task', { event: { type: 'workspace_file_progress',
        counts: { additions, deletions: 0, files: 1, binaryFiles: 0 } } })
    })
    expect(render).toHaveBeenCalledTimes(waiting)
    expect(page.result.current).toBe(activity)
    act(() => events.retry(2))
    expect(page.result.current?.attempt).toBe(2)
    act(() => events.send('item/delta', 'target', 'task', { delta: { text: 'Recovered' } }))
    expect(page.result.current).toBeNull()
  } finally { page.unmount(); otherLease(); events.consumer.dispose() }
})

test.each(['retained', 'browser'] as const)('%s hiding pauses retry display without releasing its lease or restarting backoff', boundary => {
  const events = retryEvents()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const readRetry = toolPathPreviews.readProviderRetry
  const read = vi.spyOn(toolPathPreviews, 'readProviderRetry')
  const listeners = new Set<() => void>(), subscribe = toolPathPreviews.subscribe
  const subscription = vi.spyOn(toolPathPreviews, 'subscribe').mockImplementation((listener, ...scope) => {
    listeners.add(listener)
    const unsubscribe = subscribe(listener, ...scope)
    return () => { listeners.delete(listener); unsubscribe() }
  })
  const acquire = toolPathPreviews.acquire, release = vi.fn()
  const lease = vi.spyOn(toolPathPreviews, 'acquire').mockImplementation((target, task) => {
    const dispose = acquire(target, task)
    return () => { release(); dispose() }
  })
  let open = true
  const page = renderHook(() => useProviderRetryActivity('target', 'task'), {
    wrapper: ({ children }) => <RetainedPageActive.Provider value={open}>{children}</RetainedPageActive.Provider>,
  })
  const show = (visible: boolean) => act(() => {
    if (boundary === 'retained') open = visible
    else visibility.mockReturnValue(visible ? 'visible' : 'hidden')
    page.rerender()
    document.dispatchEvent(new Event('visibilitychange'))
  })
  try {
    act(() => { events.send('turn/started'); events.retry(1) })
    expect(page.result.current?.attempt).toBe(1)
    const displayed = page.result.current
    show(false)
    expect(page.result.current).toBe(displayed)
    read.mockClear()
    act(() => events.retry(2))
    expect(listeners.size).toBe(0)
    expect(read).not.toHaveBeenCalled()
    expect(lease).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    const latest = readRetry('target', 'task')
    show(true)
    expect(page.result.current).toBe(latest)
    expect(page.result.current?.attempt).toBe(2)
    show(false)
    act(() => events.send('turn/completed'))
    show(true)
    expect(page.result.current).toBeNull()
    page.unmount()
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    page.unmount(); events.consumer.dispose(); read.mockRestore()
    visibility.mockRestore(); subscription.mockRestore(); lease.mockRestore()
  }
})

test.each(['target', 'task'] as const)('%s changes select the current retry snapshot and ignore retired scope events', field => {
  const events = retryEvents()
  const otherTarget = field === 'target' ? 'second-target' : 'target'
  const otherTask = field === 'task' ? 'second-task' : 'task'
  const page = renderHook(({ target, task }) => useProviderRetryActivity(target, task), {
    initialProps: { target: 'target', task: 'task' },
  })
  try {
    act(() => { events.send('turn/started'); events.retry(1) })
    expect(page.result.current?.attempt).toBe(1)
    page.rerender({ target: otherTarget, task: otherTask })
    expect(page.result.current).toBeNull()
    act(() => {
      events.send('turn/started', otherTarget, otherTask)
      events.retry(2, otherTarget, otherTask)
      events.retry(3)
    })
    expect(page.result.current?.attempt).toBe(2)
    act(() => events.send('turn/completed'))
    expect(page.result.current?.attempt).toBe(2)
  } finally { page.unmount(); events.consumer.dispose() }
})
