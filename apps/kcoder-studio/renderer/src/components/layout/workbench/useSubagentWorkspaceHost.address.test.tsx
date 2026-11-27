import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentCommandsResponse, RuntimeSubagentListResponse } from '@/types/subagents'
import type { AgentTaskBinding } from '../../../../../shared/generated/contracts'
import { initialWorkbenchState, workbenchReducer } from '@/features/workbench/workbenchReducer'
import { useSubagentWorkspaceHost } from './useSubagentWorkspaceHost'

const original: RuntimeTaskAddress = { deviceId: 'target', taskId: 'task', threadId: 'parent', workspacePath: '/owned',
  runtimeHandle: { threadId: 'parent', memoryTaskSnapshot: { sequence: 1 } } }
const list: RuntimeSubagentListResponse = { threadId: 'parent', journalScope: 'owned-journal',
  capabilities: { artifacts: true, publicTranscript: true, pages: true, live: true, receipts: true,
    conversationStream: false, steering: true, stop: false },
  agents: [{ agentId: 'worker', status: 'running', acceptingMessages: true, queueDepth: 0 }],
}
const commands = (epoch: number): RuntimeSubagentCommandsResponse =>
  ({ receiptEpoch: epoch, retainedCount: 0, retainedLimit: 256, receipts: [] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
function setup(first = Promise.resolve(commands(1)), address: RuntimeTaskAddress = original) {
  vi.useFakeTimers()
  const api = {
    listRuntimeSubagents: vi.fn().mockResolvedValue(list),
    listRuntimeSubagentCommands: vi.fn().mockReturnValueOnce(first).mockResolvedValue(commands(2)),
    steerRuntimeSubagent: vi.fn().mockResolvedValue({ agentId: 'worker', clientMessageId: 'cmd:1:owned', messageId: 'owned', queued: true }),
    archiveRuntimeSubagentCommands: vi.fn().mockResolvedValue({ receiptEpoch: 2 }),
  }
  const hook = renderHook(({ address, adapter = api }: { address: RuntimeTaskAddress; adapter?: typeof api }) => useSubagentWorkspaceHost(
    adapter as unknown as ReturnType<typeof createRuntimeWorkApi>, address, []
  ), { initialProps: { address } })
  return { ...hook, api, open: async () => {
    await advance()
    act(() => hook.result.current.openAgent('worker'))
    await advance(1)
    expect(api.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
  } }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })

// Use the production reducer: real expert metadata changes the selected address object.
test.each([false, true])('expert binding updates do not reread the same command journal (first read pending: %s)', async pending => {
  const first = deferred<RuntimeSubagentCommandsResponse>()
  const hook = setup(pending ? first.promise : undefined)
  try {
    await hook.open()
    const binding = { definition: { id: 'personal.owned', version: '1', definitionSha256: 'a'.repeat(64) },
      owner: {}, source: 'expert', title: 'Owned expert' } as AgentTaskBinding
    const state = workbenchReducer({ ...initialWorkbenchState, currentRuntimeTask: original },
      { type: 'runtime_task_expert_binding_updated', address: original, binding })
    expect(state.currentRuntimeTask).not.toBe(original)
    expect(state.currentRuntimeTask?.runtimeHandle?.agentDefinition).toEqual(binding)
    hook.rerender({ address: state.currentRuntimeTask! })
    await advance(1)
    if (pending) await act(async () => { first.resolve(commands(1)); await first.promise })
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    expect(hook.result.current.workspace?.commandEpoch).toBe(1)
    await advance(15_000)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(2)
  } finally { hook.unmount(); first.resolve(commands(1)) }
})

test.each([
  { workspacePath: '/replacement' },
  { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'parent' } },
])('actual read constraint changes start a new read and reject the late old reply: %j', async narrowing => {
  const first = deferred<RuntimeSubagentCommandsResponse>()
  const directory = deferred<RuntimeSubagentListResponse>()
  const hook = setup(first.promise)
  try {
    await hook.open()
    const next = { ...original, ...narrowing }
    hook.api.listRuntimeSubagents.mockReturnValueOnce(directory.promise)
    hook.rerender({ address: next })
    await advance(1)
    expect(hook.result.current.workspace).toBeNull()
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
    await act(async () => { directory.resolve(list); await directory.promise })
    await advance(1)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(2)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenLastCalledWith(expect.objectContaining({
      address: expect.objectContaining({ deviceId: next.deviceId, taskId: next.taskId,
        threadId: next.threadId, workspacePath: next.workspacePath, ...narrowing }),
    }))
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
    await act(async () => { first.resolve(commands(9)); await first.promise })
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
  } finally { hook.unmount(); first.resolve(commands(9)); directory.resolve(list) }
})

test.each([
  { workspacePath: '/replacement' },
  { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'parent' } },
  { threadId: undefined, runtimeHandle: { threadId: 'replacement-thread' } },
])('directory reads retire the previous read constraint: %j', async narrowing => {
  const first = deferred<RuntimeSubagentListResponse>()
  const hook = setup()
  hook.api.listRuntimeSubagents.mockReturnValueOnce(first.promise)
  try {
    await advance()
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledOnce()
    hook.rerender({ address: { ...original, ...narrowing } })
    await advance(1)
    expect(hook.api.listRuntimeSubagents).toHaveBeenCalledTimes(2)
    const readAddress = hook.api.listRuntimeSubagents.mock.calls[1]![0].address
    expect(readAddress).toEqual({ deviceId: 'target', taskId: 'task',
      threadId: narrowing.runtimeHandle?.threadId ?? 'parent', workspacePath: narrowing.workspacePath ?? '/owned',
      ...(narrowing.expectedSessionAddress ? { expectedSessionAddress: narrowing.expectedSessionAddress } : {}),
    })
    act(() => hook.result.current.openAgent('worker'))
    await advance(1)
    expect(hook.result.current.workspace?.connected).toBe(true)
    await act(async () => { first.resolve({ ...list, agents: [] }); await first.promise })
    expect(hook.result.current.workspace?.connected).toBe(true)
    expect(hook.result.current.statuses.map(item => item.agentId)).toEqual(['worker'])
  } finally { hook.unmount(); first.resolve(list) }
})

test('a changed thread carried by a runtime handle remains an actual read constraint', async () => {
  const first = deferred<RuntimeSubagentCommandsResponse>()
  const directory = deferred<RuntimeSubagentListResponse>()
  const source = { ...original, threadId: undefined }
  const hook = setup(first.promise, source)
  try {
    await hook.open()
    hook.api.listRuntimeSubagents.mockReturnValueOnce(directory.promise)
    hook.rerender({ address: { ...source, runtimeHandle: { threadId: 'replacement-thread' } } })
    await advance(1)
    expect(hook.result.current.workspace).toBeNull()
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
    await act(async () => { directory.resolve({ ...list, threadId: 'replacement-thread' }); await directory.promise })
    await advance(1)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(2)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenLastCalledWith(expect.objectContaining({
      address: { deviceId: 'target', taskId: 'task', threadId: 'replacement-thread', workspacePath: '/owned' },
    }))
    await act(async () => { first.resolve(commands(9)); await first.promise })
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
  } finally { hook.unmount(); first.resolve(commands(9)); directory.resolve(list) }
})

test('metadata enrichment remains on mutation requests while directory and receipt reads use the original identity', async () => {
  const hook = setup()
  try {
    await hook.open()
    const enriched = { ...original, runtimeHandle: { ...original.runtimeHandle, memoryTaskSnapshot: { sequence: 2 } } }
    hook.rerender({ address: enriched })
    await advance(1)
    await act(async () => { await hook.result.current.workspace!.onSteer('worker', 'owned command', 'cmd:1:owned') })
    expect(hook.api.steerRuntimeSubagent).toHaveBeenCalledExactlyOnceWith({
      address: enriched, agentId: 'worker', message: 'owned command', clientMessageId: 'cmd:1:owned',
    })
    const read = hook.api.listRuntimeSubagentCommands.mock.calls.at(-1)![0]
    expect(read.address).toEqual({ deviceId: 'target', taskId: 'task', threadId: 'parent', workspacePath: '/owned' })
    expect(hook.api.listRuntimeSubagents).toHaveBeenLastCalledWith({ address: read.address })
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
  } finally { hook.unmount() }
})

test('a replacement API does not borrow the old API flight or accept its late reply', async () => {
  const first = deferred<RuntimeSubagentCommandsResponse>()
  const directory = deferred<RuntimeSubagentListResponse>()
  const hook = setup(first.promise)
  try {
    await hook.open()
    const replacement = { ...hook.api, listRuntimeSubagents: vi.fn(() => directory.promise),
      listRuntimeSubagentCommands: vi.fn().mockResolvedValue(commands(2)) }
    hook.rerender({ address: original, adapter: replacement })
    await advance(1)
    expect(replacement.listRuntimeSubagents).toHaveBeenCalledOnce()
    expect(replacement.listRuntimeSubagentCommands).not.toHaveBeenCalled()
    expect(hook.result.current.workspace).toBeNull()
    await act(async () => { directory.resolve(list); await directory.promise })
    await advance(1)
    expect(replacement.listRuntimeSubagentCommands).toHaveBeenCalledOnce()
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
    await act(async () => { first.resolve(commands(9)); await first.promise })
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
  } finally { hook.unmount(); first.resolve(commands(9)); directory.resolve(list) }
})

test('finishing the previous worker read does not replace the selected worker journal', async () => {
  const first = deferred<RuntimeSubagentCommandsResponse>()
  const hook = setup(first.promise)
  hook.api.listRuntimeSubagents.mockResolvedValue({ ...list, agents: [...list.agents,
    { agentId: 'second-worker', status: 'running', acceptingMessages: true, queueDepth: 0 }] })
  try {
    await hook.open()
    act(() => hook.result.current.openAgent('second-worker'))
    await advance(1)
    expect(hook.result.current.workspace?.agent.agentId).toBe('second-worker')
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
    await act(async () => { first.resolve(commands(9)); await first.promise })
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenCalledTimes(2)
  } finally { hook.unmount(); first.resolve(commands(9)) }
})

test('a previous worker archive still reconciles its receipt without replacing the new worker view', async () => {
  const archive = deferred<{ receiptEpoch: number }>()
  const hook = setup()
  hook.api.listRuntimeSubagents.mockResolvedValue({ ...list, agents: [...list.agents,
    { agentId: 'second-worker', status: 'running', acceptingMessages: true, queueDepth: 0 }] })
  hook.api.archiveRuntimeSubagentCommands.mockReturnValueOnce(archive.promise)
  try {
    await hook.open()
    let pending!: Promise<boolean>
    act(() => { pending = hook.result.current.workspace!.onArchiveCommands!([], 1) })
    act(() => hook.result.current.openAgent('second-worker'))
    await advance(1)
    await act(async () => { archive.resolve({ receiptEpoch: 2 }); await pending })
    expect(hook.result.current.workspace?.agent.agentId).toBe('second-worker')
    expect(hook.result.current.workspace?.commandEpoch).toBe(2)
    expect(hook.api.listRuntimeSubagentCommands).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'worker' }))
  } finally { hook.unmount(); archive.resolve({ receiptEpoch: 2 }) }
})


test.each([false, true])('equivalent Native selectors retain the directory, selected view and journal (first read pending: %s)', async pending => {
  const first = deferred<RuntimeSubagentCommandsResponse>()
  const source: RuntimeTaskAddress = { ...original,
    expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'parent' } }
  const hook = setup(pending ? first.promise : undefined, source)
  try {
    await hook.open()
    let missingViews = 0
    for (let sequence = 2; sequence < 22; sequence++) {
      hook.rerender({ address: { ...source,
        runtimeHandle: { ...source.runtimeHandle, memoryTaskSnapshot: { sequence } },
        expectedSessionAddress: { threadId: 'parent', workspaceId: 'native-workspace', targetId: 'native-target' },
      } })
      if (hook.result.current.workspace?.agent.agentId !== 'worker') missingViews++
      await advance(1)
    }
    if (pending) await act(async () => { first.resolve(commands(1)); await first.promise })
    expect.soft(hook.api.listRuntimeSubagents.mock.calls.length, 'directory reads for twenty equivalent DTO updates').toBe(2)
    expect.soft(hook.api.listRuntimeSubagentCommands.mock.calls.length, 'journal reads for twenty equivalent DTO updates').toBe(1)
    expect.soft(missingViews, 'equivalent DTO updates must preserve the selected workspace').toBe(0)
    expect(hook.result.current.workspace?.commandEpoch).toBe(1)
  } finally { hook.unmount(); first.resolve(commands(1)) }
})
