import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentListResponse, RuntimeSubagentConversationEvent } from '@/types/subagents'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import { useSubagentWorkspaceHost } from './useSubagentWorkspaceHost'
import { updateRuntimeSubagentStatuses } from '../pane/subagentState'

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
    ({ taskAddress, active = true, activity = [], adapter = api }: { taskAddress: RuntimeTaskAddress; active?: boolean; activity?: RuntimeSubagentStatus[]; adapter?: typeof api }) =>
      useSubagentWorkspaceHost(adapter, taskAddress, activity, undefined, active),
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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  test.each(['resolve', 'reject'] as const)('a replacement API reads independently and ignores the old API list %s', async outcome => {
    vi.useFakeTimers()
    const owner = address('api-owner')
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(owner, reads)
    const replacement = { listRuntimeSubagents: vi.fn().mockResolvedValue({
      ...listFor('api-owner'), agents: [{ ...listFor('api-owner').agents[0]!, agentName: 'Current API worker' }],
    }) } as unknown as ReturnType<typeof createRuntimeWorkApi>
    try {
      await advance(0)
      await resolveRead(reads[0]!, 'api-owner')
      act(() => hook.result.current.openAgent('api-owner-agent'))
      await advance(0)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      hook.rerender({ taskAddress: owner, adapter: replacement })
      expect(hook.result.current.statuses).toEqual([])
      expect(hook.result.current.workspace).toBeNull()
      await advance(0)
      expect(replacement.listRuntimeSubagents).toHaveBeenCalledOnce()
      expect(hook.result.current.workspace?.agent.agentName).toBe('Current API worker')
      await act(async () => {
        if (outcome === 'resolve') reads[1]!.resolve(listFor('old-api'))
        else reads[1]!.reject(new Error('old API disconnected'))
      })
      expect(hook.result.current.workspace?.connected).toBe(true)
      expect(hook.result.current.workspace?.agent.agentName).toBe('Current API worker')
      expect(hook.result.current.statuses.map(item => item.agentId)).toEqual(['api-owner-agent'])
      await advance(15_000)
      expect(replacement.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('cleanup')) }
  })

  test('old API completion and a retained old callback cannot postpone the replacement clock', async () => {
    vi.useFakeTimers()
    const owner = address('clock-owner')
    const pending = deferred<RuntimeSubagentListResponse>()
    const hook = setup(owner, [pending])
    const previousOpen = hook.result.current.openAgent
    const replacement = {
      listRuntimeSubagents: vi.fn().mockResolvedValue(listFor('clock-owner')),
    } as unknown as ReturnType<typeof createRuntimeWorkApi>
    try {
      await advance(0)
      hook.rerender({ taskAddress: owner, adapter: replacement })
      await advance(0)
      expect(replacement.listRuntimeSubagents).toHaveBeenCalledOnce()
      await advance(14_999)
      act(() => previousOpen('clock-owner-agent'))
      await resolveRead(pending, 'old-clock-owner')
      await advance(1)
      expect(replacement.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledOnce()
    } finally { hook.unmount(); pending.resolve(listFor('cleanup')) }
  })

  test('unselected progress timestamps and activity ordering do not reread the directory', async () => {
    vi.useFakeTimers()
    const owner = address('progress-owner')
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(owner, reads)
    let activity: RuntimeSubagentStatus[] = []
    try {
      await advance(0)
      await resolveRead(reads[0]!, 'progress-owner')
      for (const agentId of ['progress-owner-agent', 'other-agent']) {
        activity = updateRuntimeSubagentStatuses(activity, {
          agentPath: agentId, kind: 'background', status: 'running', occurredAtMs: 1,
        })
      }
      hook.rerender({ taskAddress: owner, activity })
      await advance(0)
      await resolveRead(reads[1]!, 'progress-owner')
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)

      for (let tick = 2; tick < 42; tick++) {
        activity = updateRuntimeSubagentStatuses(activity, {
          agentPath: tick % 2 ? 'progress-owner-agent' : 'other-agent',
          kind: 'background', status: 'running', occurredAtMs: tick,
        })
        hook.rerender({ taskAddress: owner, activity })
        await advance(0)
      }
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('progress-owner')) }
  })

  test.each(['status', 'steer', 'capacity', 'member'])('still reconciles %s changes immediately', async change => {
    vi.useFakeTimers()
    const owner = address('semantic-owner')
    const reads = Array.from({ length: 3 }, () => deferred<RuntimeSubagentListResponse>())
    const hook = setup(owner, reads)
    let activity = updateRuntimeSubagentStatuses([], {
      agentPath: 'semantic-owner-agent', kind: 'background', status: 'running', occurredAtMs: 1,
    })
    try {
      await advance(0)
      await resolveRead(reads[0]!, 'semantic-owner')
      hook.rerender({ taskAddress: owner, activity })
      await advance(0)
      await resolveRead(reads[1]!, 'semantic-owner')
      activity = updateRuntimeSubagentStatuses(activity, {
        agentPath: change === 'member' ? 'new-agent' : 'semantic-owner-agent',
        kind: 'background', status: change === 'status' ? 'done' : 'running', occurredAtMs: 2,
        ...(change === 'steer' ? { steerStatus: 'applied', steerMessageId: 'original-steer' } : {}),
        ...(change === 'capacity' ? { retainedRuns: 8, retainedRunLimit: 8, capacityWarning: true } : {}),
      })
      hook.rerender({ taskAddress: owner, activity })
      await advance(0)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(3)
      await resolveRead(reads[2]!, 'semantic-owner')
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('semantic-owner')) }
  })

  test('selected progress refreshes details while another worker progress does not', async () => {
    vi.useFakeTimers()
    const owner = address('selected-owner')
    const reads = Array.from({ length: 4 }, () => deferred<RuntimeSubagentListResponse>())
    const hook = setup(owner, reads)
    let activity: RuntimeSubagentStatus[] = []
    for (const agentId of ['selected-owner-agent', 'other-agent']) activity = updateRuntimeSubagentStatuses(activity, {
      agentPath: agentId, kind: 'background', status: 'running', occurredAtMs: 1,
    })
    try {
      await advance(0)
      await resolveRead(reads[0]!, 'selected-owner')
      hook.rerender({ taskAddress: owner, activity })
      await advance(0)
      await resolveRead(reads[1]!, 'selected-owner')
      act(() => hook.result.current.openAgent('selected-owner-agent'))
      await advance(0)
      await resolveRead(reads[2]!, 'selected-owner')
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(3)
      for (const agentId of ['other-agent', 'selected-owner-agent']) {
        activity = updateRuntimeSubagentStatuses(activity, {
          agentPath: agentId, kind: 'background', status: 'running', occurredAtMs: 2,
        })
        hook.rerender({ taskAddress: owner, activity })
        await advance(0)
        expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(agentId === 'other-agent' ? 3 : 4)
      }
      await resolveRead(reads[3]!, 'selected-owner')
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('selected-owner')) }
  })

  test.each(['tab', 'retained-pane'])('defers a queued display reconciliation when the %s hides before the original read ends', async boundary => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const owner = address('hidden-followup')
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(owner, reads)
    try {
      await advance(0)
      act(() => hook.result.current.openAgent('hidden-followup-agent'))
      if (boundary === 'tab') visibility.mockReturnValue('hidden')
      else hook.rerender({ taskAddress: owner, active: false })
      await resolveRead(reads[0]!, 'hidden-followup')
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
      await advance(30_000)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
      if (boundary === 'tab') {
        visibility.mockReturnValue('visible')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
      } else hook.rerender({ taskAddress: owner, active: true })
      await advance(0)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      await resolveRead(reads[1]!, 'hidden-followup')
      expect(hook.result.current.statuses.map(item => item.agentId)).toEqual(['hidden-followup-agent'])
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('hidden-followup')) }
  })

  test('a scheduled initial display read checks visibility when it actually runs', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const reads = [deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('initial-owner'), reads)
    try {
      visibility.mockReturnValue('hidden')
      await advance(0)
      expect(hook.api.listRuntimeSubagents).not.toHaveBeenCalled()
      visibility.mockReturnValue('visible')
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await advance(0)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledOnce()
      await resolveRead(reads[0]!, 'initial-owner')
    } finally { hook.unmount(); reads[0]!.resolve(listFor('initial-owner')) }
  })

  test('waits fifteen seconds after a pending list read completes before polling again', async () => {
    vi.useFakeTimers()
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('task-1'), reads)

    await advance(0)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    await advance(8_000)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)

    await resolveRead(reads[0]!, 'task-1')
    await advance(14_999)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    expect(hook.getMaxActive()).toBe(1)

    hook.unmount()
    await resolveRead(reads[1]!, 'task-1')
  })

  test('foreground discovery starts a fresh delay instead of running the old periodic tick', async () => {
    vi.useFakeTimers()
    const reads = Array.from({ length: 3 }, () => deferred<RuntimeSubagentListResponse>())
    const hook = setup(address('focus-owner'), reads)
    try {
      await advance(0)
      await resolveRead(reads[0]!, 'focus-owner')
      await advance(14_999)
      act(() => window.dispatchEvent(new Event('focus')))
      await advance(0)
      await resolveRead(reads[1]!, 'focus-owner')
      await advance(1)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      await advance(14_999)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(3)
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('focus-owner')) }
  })

  test('an explicit directory reconciliation also retires the previous periodic deadline', async () => {
    vi.useFakeTimers()
    const reads = Array.from({ length: 3 }, () => deferred<RuntimeSubagentListResponse>())
    const hook = setup(address('explicit-owner'), reads)
    try {
      await advance(0)
      await resolveRead(reads[0]!, 'explicit-owner')
      await advance(14_999)
      act(() => hook.result.current.openAgent('explicit-owner-agent'))
      await resolveRead(reads[1]!, 'explicit-owner')
      await advance(1)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      await advance(14_999)
      expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(3)
    } finally { hook.unmount(); for (const read of reads) read.resolve(listFor('explicit-owner')) }
  })

  test('a steer receipt read resets command polling without replaying the mutation', async () => {
    vi.useFakeTimers()
    const owner = address('steer-cadence-owner')
    const list = listFor('steer-cadence-owner')
    list.capabilities.receipts = true
    list.capabilities.steering = true
    const readTimes: number[] = []
    const api = {
      listRuntimeSubagents: vi.fn().mockResolvedValue(list),
      listRuntimeSubagentCommands: vi.fn(async () => {
        readTimes.push(Date.now())
        return { receiptEpoch: 1, retainedCount: 0, retainedLimit: 256, receipts: [] }
      }),
      steerRuntimeSubagent: vi.fn().mockResolvedValue({
        agentId: 'steer-cadence-owner-agent', clientMessageId: 'cmd:1:cadence', queued: true,
      }),
    }
    const hook = renderHook(() => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, owner, []
    ))
    try {
      await advance(1)
      act(() => hook.result.current.openAgent('steer-cadence-owner-agent'))
      await advance(1)
      expect(api.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
      await advance(14_999 - (Date.now() - readTimes[0]!))
      await act(async () => { await hook.result.current.workspace!.onSteer(
        'steer-cadence-owner-agent', 'Owned command', 'cmd:1:cadence'
      ) })
      await advance(1)
      expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(2)
      await advance(14_999)
      expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(3)
      expect(api.steerRuntimeSubagent).toHaveBeenCalledExactlyOnceWith({
        address: owner, agentId: 'steer-cadence-owner-agent', message: 'Owned command', clientMessageId: 'cmd:1:cadence',
      })
    } finally { hook.unmount() }
  })

  test('foreground command reconciliation also retires the previous periodic deadline', async () => {
    vi.useFakeTimers()
    const owner = address('focus-command-owner')
    const list = listFor('focus-command-owner')
    list.capabilities.receipts = true
    const readTimes: number[] = []
    const api = {
      listRuntimeSubagents: vi.fn().mockResolvedValue(list),
      listRuntimeSubagentCommands: vi.fn(async () => {
        readTimes.push(Date.now())
        return { receiptEpoch: 1, retainedCount: 0, retainedLimit: 256, receipts: [] }
      }),
    }
    const hook = renderHook(() => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, owner, []
    ))
    try {
      await advance(1)
      act(() => hook.result.current.openAgent('focus-command-owner-agent'))
      await advance(1)
      expect(api.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
      await advance(14_999 - (Date.now() - readTimes[0]!))
      act(() => window.dispatchEvent(new Event('focus')))
      await advance(1)
      expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(2)
      await advance(14_999)
      expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(3)
    } finally { hook.unmount() }
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
    await advance(60_000)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  test('pauses discovery while hidden and reconciles immediately on returning', async () => {
    vi.useFakeTimers()
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const reads = [deferred<RuntimeSubagentListResponse>(), deferred<RuntimeSubagentListResponse>()]
    const hook = setup(address('foreground-owner'), reads)
    await advance(0)
    await resolveRead(reads[0]!, 'foreground-owner')
    visible.mockReturnValue('hidden')
    await advance(60_000)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    visible.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await advance(0)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    hook.unmount()
    await resolveRead(reads[1]!, 'foreground-owner')
  })

  test('selected command reads do not overlap on slow links and hidden panes do not poll', async () => {
    vi.useFakeTimers()
    localStorage.clear()
    const list = listFor('command-owner')
    list.capabilities.receipts = true
    const command = deferred<{ receiptEpoch: number; retainedCount: number; retainedLimit: number; receipts: [] }>()
    const api = {
      listRuntimeSubagents: vi.fn().mockResolvedValue(list),
      listRuntimeSubagentCommands: vi.fn().mockReturnValueOnce(command.promise)
        .mockResolvedValue({ receiptEpoch: 1, retainedCount: 0, retainedLimit: 256, receipts: [] }),
    }
    const hook = renderHook(({ active }) => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, address('command-owner'), [], undefined, active
    ), { initialProps: { active: true } })
    await advance(1)
    act(() => hook.result.current.openAgent('command-owner-agent'))
    await advance(1)
    expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(1)
    await advance(45_000)
    expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(1)
    await act(async () => command.resolve({ receiptEpoch: 1, retainedCount: 0, retainedLimit: 256, receipts: [] }))
    hook.rerender({ active: false })
    const reads = api.listRuntimeSubagents.mock.calls.length
    await advance(60_000)
    expect(api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(1)
    expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(reads)
    hook.unmount()
  })

  test('the host active boundary pauses a disconnected child observer without closing a healthy one', async () => {
    vi.useFakeTimers()
    const owner = address('stream-owner')
    const list = listFor('stream-owner')
    list.capabilities.conversationStream = true
    let event!: (value: RuntimeSubagentConversationEvent) => void
    const unsubscribe = vi.fn(async () => {})
    const api = {
      listRuntimeSubagents: vi.fn().mockResolvedValue(list),
      subscribeRuntimeSubagentConversation: vi.fn<ReturnType<typeof createRuntimeWorkApi>['subscribeRuntimeSubagentConversation']>(async (_params, accept) => {
        event = accept
        return { snapshot: { threadId: 'stream-owner', agentId: 'stream-owner-agent', runId: 'run',
          subscriptionId: 'stream', sequence: 1, active: true, messages: [] }, unsubscribe }
      }),
    }
    const hook = renderHook(({ active }) => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, owner, [], undefined, active
    ), { initialProps: { active: true } })
    try {
      await advance(0)
      act(() => hook.result.current.openAgent('stream-owner-agent'))
      await advance(1)
      expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledOnce()
      hook.rerender({ active: false })
      expect(unsubscribe).not.toHaveBeenCalled()
      act(() => event({ type: 'disconnected', threadId: 'stream-owner', agentId: 'stream-owner-agent', subscriptionId: 'stream' }))
      await advance(30_000)
      expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledOnce()
      hook.rerender({ active: true })
      await advance(1)
      expect(api.subscribeRuntimeSubagentConversation).toHaveBeenCalledTimes(2)
      expect(hook.result.current.workspace?.connected).toBe(true)
    } finally { hook.unmount() }
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  test('returning to a retained task shares its pending discovery and performs one trailing reconciliation', async () => {
    vi.useFakeTimers()
    const pending = deferred<RuntimeSubagentListResponse>()
    const api = { listRuntimeSubagents: vi.fn().mockReturnValueOnce(pending.promise)
      .mockResolvedValue(listFor('retained-owner')) }
    const taskAddress = address('retained-owner')
    const hook = renderHook(({ active }) => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, taskAddress, [], undefined, active
    ), { initialProps: { active: true } })
    await advance(0)
    hook.rerender({ active: false })
    await advance(30_000)
    hook.rerender({ active: true })
    await advance(0)
    expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(1)
    await resolveRead(pending, 'retained-owner')
    expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    expect(hook.result.current.statuses.map(item => item.agentId)).toEqual(['retained-owner-agent'])
    hook.unmount()
  })

  test('hiding a retained page preserves an accepted stop and its authoritative reconciliation', async () => {
    vi.useFakeTimers()
    const list = listFor('stop-owner')
    const run = { parentSessionId: 'stop-owner', agentId: 'stop-owner-agent', runId: 'owned-run' }
    list.capabilities.stop = true
    Object.assign(list.agents[0]!, { backgroundRun: run, presentation: { canStop: true } })
    const pending = deferred<{ stopped: boolean; status: string }>()
    const api = { listRuntimeSubagents: vi.fn().mockResolvedValue(list),
      stopRuntimeSubagent: vi.fn().mockReturnValue(pending.promise) }
    const taskAddress = address('stop-owner')
    const hook = renderHook(({ active }) => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, taskAddress, [], undefined, active
    ), { initialProps: { active: true } })
    await advance(0)
    act(() => hook.result.current.openAgent('stop-owner-agent'))
    await advance(0)
    let stop!: Promise<{ stopped: boolean; status: string }>
    act(() => { stop = hook.result.current.workspace!.onStop!('stop-owner-agent') })
    hook.rerender({ active: false })
    const before = api.listRuntimeSubagents.mock.calls.length
    await act(async () => {
      const settled = expect(stop).resolves.toMatchObject({ stopped: true, status: 'stopped' })
      pending.resolve({ stopped: true, status: 'stopped' })
      await settled
    })
    expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(before + 1)
    expect(api.stopRuntimeSubagent).toHaveBeenCalledExactlyOnceWith({
      address: taskAddress, agentId: 'stop-owner-agent', expectedBackgroundRun: run,
    })
    await advance(60_000)
    expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(before + 1)
    hook.unmount()
  })

  test('a display refresh cannot downgrade a pending stop reconciliation when the page hides', async () => {
    vi.useFakeTimers()
    const list = listFor('priority-owner')
    const run = { parentSessionId: 'priority-owner', agentId: 'priority-owner-agent', runId: 'owned-run' }
    list.capabilities.stop = true
    Object.assign(list.agents[0]!, { backgroundRun: run, presentation: { canStop: true } })
    const pendingList = deferred<RuntimeSubagentListResponse>()
    const pendingStop = deferred<{ stopped: boolean; status: string }>()
    const stopped = { ...list, agents: list.agents.map(agent => ({ ...agent, status: 'cancelled', acceptingMessages: false })) }
    const api = {
      listRuntimeSubagents: vi.fn().mockResolvedValueOnce(list).mockReturnValueOnce(pendingList.promise).mockResolvedValue(stopped),
      stopRuntimeSubagent: vi.fn().mockReturnValue(pendingStop.promise),
    }
    const owner = address('priority-owner')
    const hook = renderHook(({ active }) => useSubagentWorkspaceHost(
      api as unknown as ReturnType<typeof createRuntimeWorkApi>, owner, [], undefined, active
    ), { initialProps: { active: true } })
    try {
      await advance(0)
      act(() => hook.result.current.openAgent('priority-owner-agent'))
      await advance(0)
      expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
      let stop!: Promise<{ stopped: boolean; status: string }>
      act(() => { stop = hook.result.current.workspace!.onStop!('priority-owner-agent') })
      await act(async () => { pendingStop.resolve({ stopped: true, status: 'stopped' }); await pendingStop.promise })
      act(() => hook.result.current.openAgent('priority-owner-agent'))
      hook.rerender({ active: false })
      await act(async () => {
        pendingList.resolve(list)
        await expect(stop).resolves.toMatchObject({ stopped: true, status: 'stopped' })
      })
      expect(api.stopRuntimeSubagent).toHaveBeenCalledOnce()
      expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(3)
      expect(hook.result.current.statuses[0]?.status).toBe('interrupted')
      await advance(60_000)
      expect(api.listRuntimeSubagents).toHaveBeenCalledTimes(3)
    } finally { hook.unmount(); pendingList.resolve(list); pendingStop.resolve({ stopped: true, status: 'stopped' }) }
  })

})


test.each([false, true])('foreground hints share only the unfinished read (original already settled: %s)', async settled => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const reads = Array.from({ length: 3 }, () => deferred<RuntimeSubagentListResponse>())
  const hook = setup(address('foreground-cohort'), reads)
  try {
    await advance(0)
    await resolveRead(reads[0]!, 'foreground-cohort')
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await advance(0)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    if (settled) await resolveRead(reads[1]!, 'foreground-cohort')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await advance(0)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(settled ? 3 : 2)
    expect(hook.getMaxActive()).toBe(1)
  } finally {
    hook.unmount()
    for (const read of reads) read.resolve(listFor('cleanup'))
    vi.useRealTimers(); vi.restoreAllMocks()
  }
})
