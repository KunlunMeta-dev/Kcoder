import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useSubagentConversation } from './useSubagentConversation'
import type { RuntimeSubagentConversationEvent } from '@/types/subagents'
const address = {
  runtime: 'kcoder' as const,
  deviceId: 'owned-target',
  taskId: 'original-task',
  threadId: 'original-parent',
}
const run = { parentSessionId: 'original-parent', agentId: 'original-child', runId: 'original-run' }
afterEach(() => vi.useRealTimers())
test('exact run mismatch settles unavailable once instead of retrying toward a newer run', async () => {
  vi.useFakeTimers()
  const unsubscribe = vi.fn(async () => {})
  const subscribe = vi.fn(async () => ({
    snapshot: {
      threadId: run.parentSessionId,
      agentId: run.agentId,
      subscriptionId: 's',
      runId: 'newer-run',
      sequence: 1,
      active: true,
      messages: [],
    },
    unsubscribe,
  }))
  const api = { subscribeRuntimeSubagentConversation: subscribe }
  const hook = renderHook(() =>
    useSubagentConversation(api, address, run.agentId, true, { expectedBackgroundRun: run })
  )
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
  expect(hook.result.current.loading).toBe(false)
  expect(hook.result.current.error).toBeTruthy()
  expect(hook.result.current.messages).toEqual([])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  expect(subscribe).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(subscribe.mock.calls[0][0]).toMatchObject({ expectedBackgroundRun: run })
  hook.unmount()
})
test('completed exact snapshot remains readable, then native closed invalidates only its observer', async () => {
  vi.useFakeTimers()
  let event!: (value: RuntimeSubagentConversationEvent) => void
  const unsubscribe = vi.fn(async () => {})
  const subscribe = vi.fn(async (_data, accept) => {
    event = accept
    return {
      snapshot: {
        threadId: run.parentSessionId,
        agentId: run.agentId,
        subscriptionId: 's',
        runId: run.runId,
        sequence: 1,
        active: false,
        status: 'completed',
        messages: [
          {
            id: 'a',
            role: 'assistant' as const,
            content: 'Original completed response',
            status: 'done' as const,
            createdAt: '',
          },
        ],
      },
      unsubscribe,
    }
  })
  const api = { subscribeRuntimeSubagentConversation: subscribe }
  const hook = renderHook(() =>
    useSubagentConversation(api, address, run.agentId, true, { expectedBackgroundRun: run })
  )
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
  expect(hook.result.current.messages?.[0].content).toBe('Original completed response')
  expect(hook.result.current.status).toBe('completed')
  expect(hook.result.current.error).toBeUndefined()
  act(() =>
    event({
      type: 'disconnected',
      threadId: run.parentSessionId,
      agentId: run.agentId,
      subscriptionId: 's',
      reason: 'agent_run_changed',
    })
  )
  expect(hook.result.current.messages).toEqual([])
  expect(hook.result.current.error).toBe('agent_run_changed')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000)
  })
  expect(subscribe).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  hook.unmount()
})
