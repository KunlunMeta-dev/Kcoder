import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { mergeResolvedRuntimeTaskAddress } from './runtimeTaskAddressResolution'

test.each([undefined, null])('an absent Native presentation fact (%s) does not create a new resolved address', missing => {
  const original: RuntimeTaskAddress = { deviceId: 'target', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
    runtimeHandle: { threadId: 'thread' } }
  const incoming = { ...original, runtimeHandle: { ...original.runtimeHandle, agentDefinition: missing } }
  expect(mergeResolvedRuntimeTaskAddress(original, incoming)).toBe(original)
  const populated = { ...incoming, runtimeHandle: { ...incoming.runtimeHandle, verifiedFact: false } }
  expect(mergeResolvedRuntimeTaskAddress(original, populated)?.runtimeHandle?.verifiedFact).toBe(false)
})

const route: RuntimeTaskAddress = { deviceId: 'resolve-origin', taskId: 'kcoder:resolve-origin:display-id' }
const resolved: RuntimeTaskAddress = { ...route, threadId: 'native-original', workspacePath: '/native/original',
  runtimeHandle: { threadId: 'native-original' } }
function response(extra: Partial<RuntimeTranscriptResponse> = {}): RuntimeTranscriptResponse {
  return { taskId: route.taskId, workspacePath: resolved.workspacePath!, runtime: 'kcoder',
    resolvedAddress: resolved, messages: [], ...extra }
}
function deferredClient() {
  let resolve!: (value: RuntimeTranscriptResponse) => void
  const promise = new Promise<RuntimeTranscriptResponse>(done => { resolve = done })
  const getRuntimeTranscript = vi.fn(() => promise)
  return { client: { runtime: { getRuntimeTranscript } }, getRuntimeTranscript, resolve }
}
function reader(client: ReturnType<typeof deferredClient>['client']) {
  const dispatch = vi.fn()
  const state = { ...initialWorkbenchState, currentRuntimeTask: route, runtimeWork: { projects: [], chats: [] } }
  const hook = renderHook(({ state, client }) => useWorkbenchRuntimeTasks({
    user: { id: 1 }, state, dispatch, executorClient: client, services: {},
    lifecycleStore: new RuntimeTaskLifecycleStore('resolved-address-reader'),
    markRuntimeTasksArchived: vi.fn(), refreshWorkLists: vi.fn(),
  } as unknown as Parameters<typeof useWorkbenchRuntimeTasks>[0]), { initialProps: { state, client } })
  return { hook, dispatch, state }
}

test('a verified cold transcript fills the active React address without inferring its thread from the URL', async () => {
  const route = { deviceId: 'origin', taskId: 'kcoder:origin:display-id' }
  const resolved = { ...route, threadId: 'actual-native-thread', workspacePath: '/native/original-workspace',
    runtimeHandle: { threadId: 'actual-native-thread' } }
  const state = { ...initialWorkbenchState, currentRuntimeTask: route, runtimeWork: { projects: [], chats: [] } }
  const dispatch = vi.fn()
  const hook = renderHook(() => useWorkbenchRuntimeTasks({
    user: { id: 1 }, state, dispatch,
    executorClient: { runtime: { getRuntimeTranscript: vi.fn(async () => ({
      taskId: route.taskId, workspacePath: resolved.workspacePath, runtime: 'kcoder',
      resolvedAddress: resolved, messages: [], rangeStart: 0,
    })) } }, services: {}, lifecycleStore: new RuntimeTaskLifecycleStore('cold-address-projection'),
    markRuntimeTasksArchived: vi.fn(), refreshWorkLists: vi.fn(),
  } as unknown as Parameters<typeof useWorkbenchRuntimeTasks>[0]))
  expect(runtimeThreadId(state.currentRuntimeTask)).toBeNull()
  await hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(dispatch).toHaveBeenCalledWith({ type: 'runtime_task_address_resolved', original: route, address: resolved })
  const updated = workbenchReducer(state, dispatch.mock.calls[0][0])
  expect(runtimeThreadId(updated.currentRuntimeTask)).toBe('actual-native-thread')
  expect(updated.currentRuntimeTask?.workspacePath).toBe(resolved.workspacePath)
  expect(updated.currentProject).toBe(state.currentProject)
})

test('each current pane sharing one Native read receives its own verified address projection', async () => {
  const pending = deferredClient(), first = reader(pending.client), second = reader(pending.client)
  const a = first.hook.result.current.loadRuntimeTranscriptForPane(route)
  const b = second.hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(pending.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  pending.resolve(response())
  await Promise.all([a, b])
  for (const value of [first, second]) expect(value.dispatch).toHaveBeenCalledWith({
    type: 'runtime_task_address_resolved', original: route, address: resolved,
  })
})

test('unmounting the first reader does not block a coalesced current reader or publish for the retired pane', async () => {
  const pending = deferredClient(), first = reader(pending.client), second = reader(pending.client)
  const a = first.hook.result.current.loadRuntimeTranscriptForPane(route)
  const retired = expect(a).rejects.toMatchObject({ name: 'AbortError' })
  const b = second.hook.result.current.loadRuntimeTranscriptForPane(route)
  first.hook.unmount()
  pending.resolve(response())
  await retired
  await b
  expect(pending.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  expect(first.dispatch).not.toHaveBeenCalled()
  expect(second.dispatch).toHaveBeenCalledTimes(1)
})

test('a changed selection keeps its own address when an earlier cold read completes', async () => {
  const pending = deferredClient(), view = reader(pending.client)
  const request = view.hook.result.current.loadRuntimeTranscriptForPane(route)
  view.hook.rerender({ state: { ...view.state, currentRuntimeTask: { ...route, taskId: 'replacement' } }, client: pending.client })
  pending.resolve(response())
  await request
  expect(view.dispatch).not.toHaveBeenCalled()
})

test('a background read cannot become a live identity projection when its task is selected later', async () => {
  const pending = deferredClient(), view = reader(pending.client)
  view.hook.rerender({ state: { ...view.state, currentRuntimeTask: { ...route, taskId: 'another-task' } }, client: pending.client })
  const request = view.hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(pending.getRuntimeTranscript.mock.calls[0]).toEqual([route])
  view.hook.rerender({ state: view.state, client: pending.client })
  pending.resolve(response())
  await request
  expect(view.dispatch).not.toHaveBeenCalled()
})

test.each(['account', 'executor'] as const)('a retired %s cannot publish its address into the current view', async boundary => {
  const pending = deferredClient(), view = reader(pending.client)
  const request = view.hook.result.current.loadRuntimeTranscriptForPane(route)
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  if (boundary === 'account') notifyAccountContextChange(route.deviceId)
  else view.hook.rerender({ state: view.state, client: deferredClient().client })
  pending.resolve(response())
  await rejected
  expect(view.dispatch).not.toHaveBeenCalled()
})

test('a history-only read retains its flag without promoting the restored view to a message sender', async () => {
  const pending = deferredClient(), view = reader(pending.client)
  const request = view.hook.result.current.loadRuntimeTranscriptForPane(route)
  pending.resolve(response({ historyReadOnly: true }))
  expect((await request).historyReadOnly).toBe(true)
  expect(view.dispatch).not.toHaveBeenCalled()
})

test.each([null, route.deviceId])('a target configuration replacement (%s) rejects old readers and starts a fresh read on the same executor', async targetId => {
  const replies: Array<(value: RuntimeTranscriptResponse) => void> = []
  const getRuntimeTranscript = vi.fn(() => new Promise<RuntimeTranscriptResponse>(resolve => replies.push(resolve)))
  const client = { runtime: { getRuntimeTranscript } }, first = reader(client), second = reader(client)
  const a = first.hook.result.current.loadRuntimeTranscriptForPane(route)
  const rejectedA = expect(a).rejects.toMatchObject({ name: 'AbortError' })
  const b = second.hook.result.current.loadRuntimeTranscriptForPane(route)
  const rejectedB = expect(b).rejects.toMatchObject({ name: 'AbortError' })
  expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId } }))
  const fresh = second.hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)
  replies[0](response())
  await Promise.all([rejectedA, rejectedB])
  expect(first.dispatch).not.toHaveBeenCalled()
  expect(second.dispatch).not.toHaveBeenCalled()
  const currentAddress = { ...resolved, workspacePath: '/replacement-profile/workspace' }
  replies[1](response({ resolvedAddress: currentAddress }))
  await fresh
  expect(second.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: 'runtime_task_address_resolved', original: route, address: currentAddress,
  })
})

test('an identified unrelated target change preserves the current read and its pending projection', async () => {
  const pending = deferredClient(), view = reader(pending.client)
  const a = view.hook.result.current.loadRuntimeTranscriptForPane(route)
  window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'unrelated-target' } }))
  const b = view.hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(pending.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  pending.resolve(response())
  await Promise.all([a, b])
  expect(view.dispatch).toHaveBeenCalledTimes(2)
})

test('a retired pending producer cannot lend its old configuration to a newly mounted reader', async () => {
  const replies: Array<(value: RuntimeTranscriptResponse) => void> = []
  const getRuntimeTranscript = vi.fn(() => new Promise<RuntimeTranscriptResponse>(resolve => replies.push(resolve)))
  const client = { runtime: { getRuntimeTranscript } }, original = reader(client)
  const old = original.hook.result.current.loadRuntimeTranscriptForPane(route)
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
  original.hook.unmount()
  window.dispatchEvent(new Event('kcoder:servers-changed'))
  const replacement = reader(client)
  const fresh = replacement.hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)
  replies[0](response())
  await rejected
  replies[1](response())
  await fresh
  expect(original.dispatch).not.toHaveBeenCalled()
  expect(replacement.dispatch).toHaveBeenCalledTimes(1)
})

test.each([
  { deviceId: 'another-target' },
  { taskId: 'another-task' },
  { threadId: 'another-thread' },
  { workspacePath: '/another-workspace' },
  { runtimeHandle: { threadId: 'another-thread' } },
])('a mismatched Native address cannot fill an already constrained view: %j', async mismatch => {
  const pending = deferredClient(), view = reader(pending.client)
  const request = view.hook.result.current.loadRuntimeTranscriptForPane(resolved)
  pending.resolve(response({ resolvedAddress: { ...resolved, ...mismatch } }))
  await expect(request).rejects.toThrow('RUNTIME_TRANSCRIPT_ADDRESS_CHANGED')
  expect(view.dispatch).not.toHaveBeenCalled()
})

test('address hydration preserves canonical selectors, existing metadata and pane identity', () => {
  const expected = { targetId: 'native-target', workspaceId: 'native-workspace', threadId: resolved.threadId! }
  const original = { ...route, expectedSessionAddress: expected, runtimeHandle: { ownerMetadata: 'keep' } }
  const state = { ...initialWorkbenchState, currentRuntimeTask: original, standaloneChatKey: 7 }
  const action = { type: 'runtime_task_address_resolved' as const, original,
    address: { ...resolved, runtimeHandle: { threadId: resolved.threadId, ownerMetadata: 'must-not-replace' } } }
  const updated = workbenchReducer(state, action)
  expect(updated.currentRuntimeTask?.expectedSessionAddress).toBe(expected)
  expect(updated.currentRuntimeTask?.runtimeHandle).toEqual({ threadId: resolved.threadId, ownerMetadata: 'keep' })
  expect(updated.standaloneChatKey).toBe(7)
  expect(updated.currentProject).toBe(state.currentProject)
  expect(workbenchReducer(updated, action)).toBe(updated)
  for (const current of [{ ...resolved, threadId: 'new-thread' }, { ...resolved, workspacePath: '/new-workspace' }]) {
    const changed = { ...state, currentRuntimeTask: { ...current, expectedSessionAddress: expected } }
    expect(workbenchReducer(changed, action)).toBe(changed)
  }
})
