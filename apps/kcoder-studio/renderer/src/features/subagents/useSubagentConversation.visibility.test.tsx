import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeSubagentConversationEvent, RuntimeSubagentConversationSnapshot } from '@/types/subagents'
import { useSubagentConversation } from './useSubagentConversation'

const address = { runtime: 'kcoder' as const, deviceId: 'target', taskId: 'parent' }
const snapshot: RuntimeSubagentConversationSnapshot = {
  threadId: 'parent', agentId: 'worker', runId: 'run', subscriptionId: 'observer',
  sequence: 1, active: true,
  messages: [{ id: 'answer', subtaskId: 'answer', role: 'assistant', status: 'streaming',
    content: 'observed response', createdAt: '' }],
}
const disconnected: RuntimeSubagentConversationEvent = {
  type: 'disconnected', threadId: 'parent', agentId: 'worker', subscriptionId: 'observer', reason: 'offline',
}
type Boundary = 'tab' | 'retained-page' | 'host-pane'
type Subscribe = ReturnType<typeof createRuntimeWorkApi>['subscribeRuntimeSubagentConversation']

async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function setup(boundary: Boundary, initiallyVisible = true) {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let pageActive = true
  let hostActive = true
  let callback!: (event: RuntimeSubagentConversationEvent) => void
  const unsubscribe = vi.fn(async () => {})
  const subscribe = vi.fn<Subscribe>(async (_params, accept) => {
    callback = accept
    return { snapshot, unsubscribe }
  })
  const api = { subscribeRuntimeSubagentConversation: subscribe }
  const applyVisibility = (visible: boolean) => {
    if (boundary === 'tab') visibility.mockReturnValue(visible ? 'visible' : 'hidden')
    else if (boundary === 'retained-page') pageActive = visible
    else hostActive = visible
  }
  applyVisibility(initiallyVisible)
  const renders = vi.fn()
  const hook = renderHook(() => {
    const view = useSubagentConversation(api, address, 'worker', true, undefined, hostActive)
    renders(view)
    return view
  }, {
    wrapper: ({ children }: { children: ReactNode }) =>
      <RetainedPageActive.Provider value={pageActive}>{children}</RetainedPageActive.Provider>,
  })
  return { ...hook, renders, subscribe, unsubscribe, event: (event: RuntimeSubagentConversationEvent) => act(() => callback(event)),
    visible: (visible: boolean) => {
      applyVisibility(visible)
      hook.rerender()
      act(() => document.dispatchEvent(new Event('visibilitychange')))
    },
  }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test.each<Boundary>(['tab', 'retained-page', 'host-pane'])('a healthy hidden %s accumulates deltas without rendering or opening another observer', async boundary => {
  const hook = setup(boundary)
  try {
    await advance()
    hook.visible(false)
    const renders = hook.renders.mock.calls.length
    for (let sequence = 2; sequence <= 51; sequence++) hook.event({
      type: 'event', ...snapshot, sequence, method: 'item/delta', params: {},
      actions: [{ type: 'assistant_chunk', subtaskId: 'answer', content: ` chunk-${sequence}` }],
    })
    expect(hook.renders).toHaveBeenCalledTimes(renders)
    expect(hook.result.current.messages?.[0].content).toBe('observed response')
    hook.visible(true)
    await advance()
    expect(hook.result.current.messages?.[0].content).toBe('observed response' +
      Array.from({ length: 50 }, (_, index) => ` chunk-${index + 2}`).join(''))
    expect(hook.subscribe).toHaveBeenCalledOnce()
    expect(hook.unsubscribe).not.toHaveBeenCalled()
  } finally { hook.unmount() }
})

test.each<Boundary>(['tab', 'retained-page', 'host-pane'])('a terminal event in a hidden %s publishes all retained deltas and settles immediately', async boundary => {
  const hook = setup(boundary)
  try {
    await advance()
    hook.visible(false)
    const renders = hook.renders.mock.calls.length
    hook.event({ type: 'event', ...snapshot, sequence: 2, method: 'item/delta', params: {},
      actions: [{ type: 'assistant_chunk', subtaskId: 'answer', content: ' hidden ending' }] })
    expect(hook.renders).toHaveBeenCalledTimes(renders)
    hook.event({ type: 'event', ...snapshot, sequence: 3, method: 'turn/completed', params: {},
      terminalStatus: 'completed', actions: [{ type: 'assistant_done', subtaskId: 'answer' }] })
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.status).toBe('completed')
    expect(hook.result.current.messages?.[0]).toMatchObject({ content: 'observed response hidden ending', status: 'done' })
    hook.visible(true)
    await advance()
    expect(hook.subscribe).toHaveBeenCalledOnce()
  } finally { hook.unmount() }
})

test('hidden tool lifecycle updates still settle before the worker completes', async () => {
  const hook = setup('tab')
  try {
    await advance()
    hook.visible(false)
    hook.event({ type: 'event', ...snapshot, sequence: 2, method: 'item/started', params: {},
      actions: [{ type: 'assistant_chunk', subtaskId: 'answer', content: '', blocks: [
        { id: 'read', type: 'tool', toolName: 'Read', status: 'running', createdAt: 1 },
      ] }] })
    expect(hook.result.current.messages?.[0].blocks?.[0].status).toBe('running')
    hook.event({ type: 'event', ...snapshot, sequence: 3, method: 'item/completed', params: {},
      actions: [{ type: 'block_updated', subtaskId: 'answer', blockId: 'read', updates: { status: 'done', toolOutput: 'Read result' } }] })
    expect(hook.result.current.messages?.[0].blocks?.[0]).toMatchObject({ status: 'done', toolOutput: 'Read result' })
    expect(hook.result.current.active).toBe(true)
    expect(hook.subscribe).toHaveBeenCalledOnce()
  } finally { hook.unmount() }
})

test('a hidden disconnect publishes accumulated text and retires the active projection immediately', async () => {
  const hook = setup('tab')
  try {
    await advance()
    hook.visible(false)
    hook.event({ type: 'event', ...snapshot, sequence: 2, method: 'item/delta', params: {},
      actions: [{ type: 'assistant_chunk', subtaskId: 'answer', content: ' before disconnect' }] })
    hook.event(disconnected)
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.error).toBe('offline')
    expect(hook.result.current.messages?.[0].content).toBe('observed response before disconnect')
    await advance(30_000)
    expect(hook.subscribe).toHaveBeenCalledOnce()
  } finally { hook.unmount() }
})

// Only observation changes: no fixture starts, steers or stops a worker.
test.each<Boundary>(['tab', 'retained-page', 'host-pane'])('a hidden %s waits to open its first observer', async boundary => {
  const hook = setup(boundary, false)
  try {
    await advance(30_000)
    expect(hook.subscribe).not.toHaveBeenCalled()
    hook.visible(true)
    hook.visible(true)
    await advance()
    expect(hook.subscribe).toHaveBeenCalledOnce()
    expect(hook.result.current.messages?.[0].content).toBe('observed response')
  } finally { hook.unmount() }
})

test.each<Boundary>(['tab', 'retained-page', 'host-pane'])('a disconnected hidden %s pauses retries and reconciles once on return', async boundary => {
  const hook = setup(boundary)
  try {
    await advance()
    hook.subscribe.mockRejectedValue(new Error('offline'))
    hook.event(disconnected)
    hook.visible(false)
    await advance(30_000)
    expect(hook.subscribe).toHaveBeenCalledOnce()
    expect(hook.unsubscribe).toHaveBeenCalledOnce()
    expect(hook.result.current.messages?.[0].content).toBe('observed response')
    expect(hook.result.current.active).toBe(false)
    hook.subscribe.mockResolvedValue({ snapshot: { ...snapshot, active: false, status: 'completed' }, unsubscribe: hook.unsubscribe })
    hook.visible(true)
    hook.visible(true)
    await advance()
    expect(hook.subscribe).toHaveBeenCalledTimes(2)
    expect(hook.result.current.status).toBe('completed')
    expect(hook.result.current.error).toBeUndefined()
    hook.event({ ...disconnected, subscriptionId: 'old-observer' })
    await advance(30_000)
    expect(hook.subscribe).toHaveBeenCalledTimes(2)
  } finally { hook.unmount() }
})

test('healthy hidden observers still receive terminal events without reconnecting on return', async () => {
  const hook = setup('retained-page')
  try {
    await advance()
    hook.visible(false)
    hook.event({ type: 'event', ...snapshot, sequence: 2, method: 'turn/completed', params: {},
      terminalStatus: 'completed', actions: [{ type: 'assistant_done', subtaskId: 'answer' }] })
    await advance(30_000)
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.status).toBe('completed')
    expect(hook.result.current.messages?.[0].status).toBe('done')
    expect(hook.unsubscribe).not.toHaveBeenCalled()
    hook.visible(true)
    await advance()
    expect(hook.subscribe).toHaveBeenCalledOnce()
  } finally { hook.unmount() }
  expect(hook.unsubscribe).toHaveBeenCalledOnce()
})

test.each(['resolve', 'reject'] as const)('a pending observer may %s after hiding without starting another hidden request', async outcome => {
  const hook = setup('tab')
  let resolve!: (value: { snapshot: RuntimeSubagentConversationSnapshot; unsubscribe: typeof hook.unsubscribe }) => void
  let reject!: (error: Error) => void
  hook.subscribe.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
  try {
    await advance()
    hook.visible(false)
    await act(async () => {
      if (outcome === 'resolve') resolve({ snapshot, unsubscribe: hook.unsubscribe })
      else reject(new Error('offline'))
    })
    await advance(30_000)
    expect(hook.subscribe).toHaveBeenCalledOnce()
    hook.visible(true)
    await advance()
    expect(hook.subscribe).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 2)
  } finally { hook.unmount() }
})

test('returning cannot revive a failed exact run observation', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const subscribe = vi.fn().mockRejectedValue(new Error('exact run unavailable'))
  const api = { subscribeRuntimeSubagentConversation: subscribe }
  const hook = renderHook(() => useSubagentConversation(api, address, 'worker', true,
    { expectedBackgroundRun: { parentSessionId: 'parent', agentId: 'worker', runId: 'run' } }))
  try {
    await advance()
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await advance(30_000)
    expect(subscribe).toHaveBeenCalledOnce()
    expect(hook.result.current.loading).toBe(false)
  } finally { hook.unmount() }
})
