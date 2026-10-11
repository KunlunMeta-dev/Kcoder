import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type {
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSnapshot,
} from '@/types/subagents'
import { useSubagentConversation } from './useSubagentConversation'

const address: RuntimeTaskAddress = { runtime: 'kcoder', deviceId: 'device', taskId: 'task' }
const snapshot: RuntimeSubagentConversationSnapshot = {
  threadId: 'parent',
  agentId: 'worker',
  runId: 'run',
  subscriptionId: 'sub',
  sequence: 1,
  active: true,
  messages: [],
}
type Api = Pick<ReturnType<typeof createRuntimeWorkApi>, 'subscribeRuntimeSubagentConversation'>
type Subscription = {
  snapshot: RuntimeSubagentConversationSnapshot
  unsubscribe: () => Promise<void>
}
function chunk(sequence: number, content: string): RuntimeSubagentConversationEvent {
  return {
    type: 'event',
    ...snapshot,
    sequence,
    method: 'item/delta',
    params: {},
    actions: [{ type: 'assistant_chunk', subtaskId: 'assistant', content }],
  }
}

// QA: subscription ownership and recovery are UI orchestration, independent of model behavior.
// Each test owns/unmounts its hooks and unsubscribe handles; no workers are started or stopped.
describe('subagent conversation observation lifecycle', () => {
  test('a new authoritative run resumes streaming in the open view while retaining its completed transcript', async () => {
    const callbacks: Array<(event: RuntimeSubagentConversationEvent) => void> = []
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (_params, next) => {
        callbacks.push(next)
        return { snapshot, unsubscribe }
      }),
    }
    const hook = renderHook(
      ({ runId }) => useSubagentConversation(api, address, 'worker', true, { runId }),
      {
        initialProps: { runId: 'run' },
      }
    )
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => callbacks[0](chunk(2, 'first completed response')))
    act(() =>
      callbacks[0]({
        ...chunk(3, ''),
        terminalStatus: 'completed',
        actions: [{ type: 'assistant_done', subtaskId: 'assistant' }],
      })
    )
    expect(hook.result.current.active).toBe(false)
    const history = hook.result.current.messages!
    let complete: (subscription: Subscription) => void = () => {}
    vi.mocked(api.subscribeRuntimeSubagentConversation).mockImplementationOnce((_params, next) => {
      callbacks.push(next)
      return new Promise(resolve => {
        complete = resolve
      })
    })
    hook.rerender({ runId: 'continued-run' })
    expect(hook.result.current.messages?.[0].content).toBe('first completed response')
    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.observedActive).toBeUndefined()
    await waitFor(() => expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    act(() => callbacks[0](chunk(4, 'stale first run')))
    const nextEvent: RuntimeSubagentConversationEvent = {
      ...chunk(1, ''),
      runId: 'continued-run',
      subscriptionId: 'continued-sub',
      actions: [
        {
          type: 'assistant_chunk',
          subtaskId: 'continued-assistant',
          content: 'S03_ADJUST_AFTER_COMPLETE',
        },
      ],
    }
    act(() => callbacks[1](nextEvent))
    await act(async () =>
      complete({
        snapshot: {
          ...snapshot,
          runId: 'continued-run',
          subscriptionId: 'continued-sub',
          sequence: 0,
          messages: history,
        },
        unsubscribe,
      })
    )
    expect(hook.result.current.messages).toHaveLength(2)
    expect(hook.result.current.messages?.[0].content).toBe('first completed response')
    expect(hook.result.current.messages?.[1].content).toBe('S03_ADJUST_AFTER_COMPLETE')
    expect(hook.result.current.active).toBe(true)
    act(() => callbacks[1](nextEvent))
    expect(hook.result.current.messages?.[1].content).toBe('S03_ADJUST_AFTER_COMPLETE')
    hook.rerender({ runId: 'continued-run' })
    expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2)
    hook.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  test('metadata reaching a new run before its public registry retries an old terminal snapshot until recovery', async () => {
    let handler: (event: RuntimeSubagentConversationEvent) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (_params, next) => {
        handler = next
        return { snapshot, unsubscribe }
      }),
    }
    const hook = renderHook(
      ({ runId }) => useSubagentConversation(api, address, 'worker', true, { runId }),
      {
        initialProps: { runId: 'run' },
      }
    )
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => handler(chunk(2, 'retained terminal history')))
    act(() =>
      handler({
        ...chunk(3, ''),
        terminalStatus: 'completed',
        actions: [{ type: 'assistant_done', subtaskId: 'assistant' }],
      })
    )
    const history = hook.result.current.messages!
    // The task registry has the new background run but the public stream registry is still old.
    vi.mocked(api.subscribeRuntimeSubagentConversation).mockResolvedValueOnce({
      snapshot: { ...snapshot, active: false, messages: [] },
      unsubscribe,
    })
    vi.mocked(api.subscribeRuntimeSubagentConversation).mockImplementationOnce(
      async (_params, next) => {
        handler = next
        return {
          snapshot: {
            ...snapshot,
            runId: 'new-run',
            subscriptionId: 'new-sub',
            sequence: 0,
            messages: history,
          },
          unsubscribe,
        }
      }
    )
    hook.rerender({ runId: 'new-run' })
    await waitFor(() => expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hook.result.current.error).toContain('authoritative run'))
    expect(hook.result.current.messages?.[0].content).toBe('retained terminal history')
    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.observedActive).toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    // Recovery requires no second metadata change, navigation, or extra user instruction.
    await waitFor(() => expect(hook.result.current.active).toBe(true), { timeout: 2500 })
    expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(3)
    expect(hook.result.current.error).toBeUndefined()
    act(() =>
      handler({
        ...chunk(1, ''),
        runId: 'new-run',
        subscriptionId: 'new-sub',
        actions: [
          {
            type: 'assistant_chunk',
            subtaskId: 'new-assistant',
            content: 'recovered new increment',
          },
        ],
      })
    )
    expect(hook.result.current.messages?.[1].content).toBe('recovered new increment')
    hook.unmount()
  })

  test('replays events received before the subscribe snapshot and unsubscribes on close', async () => {
    let handler: (event: RuntimeSubagentConversationEvent) => void = () => {}
    let complete: (subscription: Subscription) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn((_params, next) => {
        handler = next
        return new Promise(resolve => {
          complete = resolve
        })
      }),
    }
    const hook = renderHook(() => useSubagentConversation(api, address, 'worker', true))
    await waitFor(() => expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(1))
    act(() => handler(chunk(2, 'early ')))
    await act(async () => complete({ snapshot, unsubscribe }))
    expect(hook.result.current.messages?.[0].content).toBe('early ')
    act(() => handler(chunk(3, 'delta')))
    expect(hook.result.current.messages?.[0].content).toBe('early delta')
    expect(hook.result.current.loading).toBe(false)
    hook.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    act(() => handler(chunk(4, 'late')))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  test('a sequence gap discards untrustworthy increments and restores a fresh snapshot', async () => {
    let handler: (event: RuntimeSubagentConversationEvent) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (_params, next) => {
        handler = next
        return { snapshot, unsubscribe }
      }),
    }
    const hook = renderHook(() => useSubagentConversation(api, address, 'worker', true))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => handler(chunk(2, 'observed')))
    vi.mocked(api.subscribeRuntimeSubagentConversation).mockImplementationOnce(async () => ({
      snapshot: {
        ...snapshot,
        subscriptionId: 'new-sub',
        sequence: 8,
        active: false,
        messages: [
          {
            id: 'final',
            role: 'assistant',
            content: 'recovered final',
            status: 'done',
            createdAt: '',
          },
        ],
      },
      unsubscribe,
    }))
    act(() => handler(chunk(4, 'missing predecessor')))
    expect(hook.result.current.messages?.[0].content).toBe('observed')
    await waitFor(() => expect(hook.result.current.messages?.[0].content).toBe('recovered final'))
    expect(hook.result.current.active).toBe(false)
    expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  test('switching agents cannot render or accept callbacks from the previous observation', async () => {
    const callbacks: Array<(event: RuntimeSubagentConversationEvent) => void> = []
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (params, next) => {
        callbacks.push(next)
        return {
          snapshot: { ...snapshot, agentId: params.agentId, subscriptionId: params.agentId },
          unsubscribe,
        }
      }),
    }
    const hook = renderHook(({ agentId }) => useSubagentConversation(api, address, agentId, true), {
      initialProps: { agentId: 'worker' },
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => callbacks[0]({ ...chunk(2, 'first agent'), subscriptionId: 'worker' }))
    expect(hook.result.current.messages?.[0].content).toBe('first agent')
    hook.rerender({ agentId: 'second' })
    expect(hook.result.current.messages).toEqual([])
    act(() => callbacks[0]({ ...chunk(3, 'stale'), subscriptionId: 'worker' }))
    await waitFor(() => expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2))
    expect(hook.result.current.messages).toEqual([])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  test('an authority change never reuses retained transcript from the previous account', async () => {
    const callbacks: Array<(event: RuntimeSubagentConversationEvent) => void> = []
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (_params, next) => {
        callbacks.push(next)
        return { snapshot, unsubscribe }
      }),
    }
    const hook = renderHook(
      ({ ownerScope }) => useSubagentConversation(api, address, 'worker', true, { ownerScope }),
      {
        initialProps: { ownerScope: 'principal-one' },
      }
    )
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => callbacks[0](chunk(2, 'previous account transcript')))
    hook.rerender({ ownerScope: 'principal-two' })
    expect(hook.result.current.messages).toEqual([])
    await waitFor(() => expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2))
    act(() => callbacks[0](chunk(3, 'old owner frame')))
    expect(hook.result.current.messages).toEqual([])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  test('a subscription resolving after unmount still releases its observer', async () => {
    let complete: (subscription: Subscription) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(
        () =>
          new Promise(resolve => {
            complete = resolve
          })
      ),
    }
    const hook = renderHook(() => useSubagentConversation(api, address, 'worker', true))
    await waitFor(() => expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(1))
    hook.unmount()
    await act(async () => complete({ snapshot, unsubscribe }))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  test('disconnect preserves observed text, disables live activity, and recovers without resending', async () => {
    let handler: (event: RuntimeSubagentConversationEvent) => void = () => {}
    const unsubscribe = vi.fn(async () => {})
    const api: Api = {
      subscribeRuntimeSubagentConversation: vi.fn(async (_params, next) => {
        handler = next
        return { snapshot, unsubscribe }
      }),
    }
    const hook = renderHook(() => useSubagentConversation(api, address, 'worker', true))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => handler(chunk(2, 'kept before reconnect')))
    vi.mocked(api.subscribeRuntimeSubagentConversation).mockResolvedValueOnce({
      snapshot: {
        ...snapshot,
        subscriptionId: 'new-sub',
        sequence: 5,
        active: false,
        messages: [
          {
            id: 'final',
            role: 'assistant',
            content: 'reconnected final',
            status: 'done',
            createdAt: '',
          },
        ],
      },
      unsubscribe,
    })
    act(() =>
      handler({
        type: 'disconnected',
        threadId: 'parent',
        agentId: 'worker',
        subscriptionId: 'sub',
        reason: 'transport closed',
      })
    )
    expect(hook.result.current.messages?.[0].content).toBe('kept before reconnect')
    expect(hook.result.current.active).toBe(false)
    expect(hook.result.current.error).toBe('transport closed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await waitFor(
      () => expect(hook.result.current.messages?.[0].content).toBe('reconnected final'),
      { timeout: 2500 }
    )
    expect(hook.result.current.error).toBeUndefined()
    expect(hook.result.current.active).toBe(false)
    hook.unmount()
  })
})
