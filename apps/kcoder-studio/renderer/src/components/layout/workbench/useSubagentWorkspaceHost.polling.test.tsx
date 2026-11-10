import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentListResponse } from '@/types/subagents'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import { useSubagentWorkspaceHost } from './useSubagentWorkspaceHost'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function listFor(owner: string): RuntimeSubagentListResponse {
  return {
    threadId: owner,
    journalScope: `journal:${owner}`,
    capabilities: {
      artifacts: true,
      publicTranscript: true,
      pages: true,
      live: true,
      conversationStream: false,
      receipts: false,
      steering: false,
      stop: false,
    },
    agents: [
      {
        agentId: `${owner}-agent`,
        status: 'running',
        acceptingMessages: true,
        queueDepth: 0,
      },
    ],
  }
}

function setup(
  address: RuntimeTaskAddress,
  reads: Array<ReturnType<typeof deferred<RuntimeSubagentListResponse>>>
) {
  let active = 0
  let maxActive = 0
  let readIndex = 0
  const listRuntimeSubagents = vi.fn(() => {
    active += 1
    maxActive = Math.max(maxActive, active)
    const read = reads[readIndex++]
    if (!read) throw new Error('unexpected subagent list read')
    return read.promise.finally(() => {
      active -= 1
    })
  })
  const api = { listRuntimeSubagents } as unknown as ReturnType<typeof createRuntimeWorkApi>
  const hook = renderHook(
    ({ taskAddress }) => useSubagentWorkspaceHost(api, taskAddress, [] as RuntimeSubagentStatus[]),
    { initialProps: { taskAddress: address } }
  )
  return { ...hook, api: { listRuntimeSubagents }, getMaxActive: () => maxActive }
}

const address = (taskId: string): RuntimeTaskAddress =>
  ({ runtime: 'kcoder', deviceId: 'target-1', taskId }) as RuntimeTaskAddress

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function resolveRead(
  read: ReturnType<typeof deferred<RuntimeSubagentListResponse>>,
  owner: string
) {
  await act(async () => {
    read.resolve(listFor(owner))
    await read.promise
    await Promise.resolve()
  })
}

describe('subagent workspace list polling', () => {
  afterEach(() => vi.useRealTimers())

  test('drops interval ticks while a list read is pending, then polls on the next tick', async () => {
    vi.useFakeTimers()
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('task-1'), reads)

    await advance(0)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    await advance(8_000)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)

    await resolveRead(reads[0]!, 'task-1')
    await advance(1_999)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    expect(hook.getMaxActive()).toBe(1)

    hook.unmount()
    await resolveRead(reads[1]!, 'task-1')
  })

  test('coalesces explicit refreshes into one trailing read without overlapping requests', async () => {
    vi.useFakeTimers()
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('task-1'), reads)

    await advance(0)
    act(() => {
      hook.result.current.openAgent('task-1-agent')
      hook.result.current.openAgent('task-1-agent')
      hook.result.current.openAgent('task-1-agent')
    })
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)

    await resolveRead(reads[0]!, 'task-1')
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    expect(hook.getMaxActive()).toBe(1)

    hook.unmount()
    await resolveRead(reads[1]!, 'task-1')
  })

  test('does not apply a delayed result from the previous task owner', async () => {
    vi.useFakeTimers()
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('task-old'), reads)

    await advance(0)
    hook.rerender({ taskAddress: address('task-new') })
    await advance(0)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)

    await resolveRead(reads[1]!, 'task-new')
    await resolveRead(reads[0]!, 'task-old')
    expect(hook.result.current.statuses.map(item => item.agentId)).toEqual(['task-new-agent'])

    hook.unmount()
  })

  test('cancels an event trailing read when the hook unmounts', async () => {
    vi.useFakeTimers()
    const reads = [deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('task-1'), reads)

    await advance(0)
    act(() => hook.result.current.openAgent('task-1-agent'))
    hook.unmount()
    await resolveRead(reads[0]!, 'task-1')
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
  })
})
