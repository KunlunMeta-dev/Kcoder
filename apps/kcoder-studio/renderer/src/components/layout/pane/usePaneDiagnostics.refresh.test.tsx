import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { usePaneDiagnostics } from './usePaneDiagnostics'
import type { usePaneGoal } from './usePaneGoal'

vi.mock('@/lib/debugPanel', () => ({ compareMessageStyles: vi.fn(), summarizeMessages: vi.fn(),
  summarizeRuntimePaneMemory: vi.fn(), updateRuntimePaneDebugSnapshot: vi.fn() }))

function contextFor(reader: ReturnType<typeof vi.fn>, taskId = 'original') {
  const address = { deviceId: 'target', taskId, threadId: taskId, workspacePath: '/owned' }
  return { currentRuntimeTask: address, runtimeTaskLoadTarget: { address }, getRuntimeSessionModes: reader,
    codeCommentContexts: [], input: '', turnNavigation: [], messages: [], loadedTranscriptRanges: [],
    transcriptLoading: false } as unknown as ReturnType<typeof usePaneGoal>
}

test('task metadata updates do not cancel a still-pending original mode read', async () => {
  let resolve!: (value: unknown) => void
  const reader = vi.fn(() => new Promise(done => { resolve = done }))
  const context = contextFor(reader)
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  hook.rerender({ ...context, currentRuntimeTask: { ...context.currentRuntimeTask!, runtimeHandle: { memoryTaskSnapshot: { sequence: 2 } } } })
  await act(async () => resolve({ sessionMode: 'orchestrate' }))
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('orchestrate'))
  expect(reader).toHaveBeenCalledTimes(1)
})

test.each([false, true])('retained presentation facts do not restart a mode read (already completed: %s)', async completed => {
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => { resolve = done })
  const reader = vi.fn(() => pending)
  const context = contextFor(reader)
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  const response = { sessionMode: 'orchestrate', settingsTemplate: { id: 'bound', revisionSha256: 'original' } }
  if (completed) await act(async () => { resolve(response); await pending })
  const enriched = { ...context.currentRuntimeTask!, runtimeHandle: { memoryTaskSnapshot: { sequence: 2 }, agentDefinition: { agentId: 'display' } } }
  hook.rerender({ ...context, currentRuntimeTask: enriched,
    runtimeTaskLoadTarget: { ...context.runtimeTaskLoadTarget!, address: enriched } })
  expect(reader).toHaveBeenCalledTimes(1)
  if (!completed) await act(async () => { resolve(response); await pending })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('orchestrate'))
  expect(hook.result.current.loadedSessionTemplate?.binding).toEqual(response.settingsTemplate)
})

test('a late previous task response cannot overwrite the current mode read', async () => {
  let resolve!: (value: unknown) => void
  const reader = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockResolvedValueOnce({ sessionMode: 'default' })
  const context = contextFor(reader)
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  hook.rerender(contextFor(reader, 'next'))
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.taskId).toBe('next'))
  await act(async () => resolve({ sessionMode: 'orchestrate' }))
  expect(hook.result.current.loadedSessionMode).toMatchObject({ taskId: 'next', mode: 'default' })
})

test.each([
  { threadId: 'replacement-thread' },
  { workspacePath: '/replacement-workspace' },
  { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'original' } },
])('original read narrowing changes require a new mode read: %j', async narrowing => {
  const reader = vi.fn().mockResolvedValue({ sessionMode: 'default' })
  const context = contextFor(reader)
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('default'))
  const changed = { ...context.currentRuntimeTask!, ...narrowing }
  hook.rerender({ ...context, currentRuntimeTask: changed,
    runtimeTaskLoadTarget: { ...context.runtimeTaskLoadTarget!, address: changed } })
  await waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
  expect(reader).toHaveBeenLastCalledWith({ address: changed })
})

test('reloading a transcript and replacing its reader both recheck the mode', async () => {
  const reader = vi.fn().mockResolvedValue({ sessionMode: 'default' })
  const context = contextFor(reader)
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('default'))
  hook.rerender({ ...context, transcriptLoading: true })
  expect(reader).toHaveBeenCalledTimes(1)
  hook.rerender(context)
  await waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
  const replacement = vi.fn().mockResolvedValue({ sessionMode: 'orchestrate' })
  hook.rerender({ ...context, getRuntimeSessionModes: replacement })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('orchestrate'))
  expect(replacement).toHaveBeenCalledTimes(1)
})

test('a retained address from another target cannot select that target for the new mode read', async () => {
  const reader = vi.fn().mockResolvedValue({ sessionMode: 'default' })
  const context = contextFor(reader)
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('default'))
  const changed = { ...context.currentRuntimeTask!, deviceId: 'other-target' }
  hook.rerender({ ...context, currentRuntimeTask: changed })
  await waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
  expect(reader).toHaveBeenLastCalledWith({ address: changed })
})

test('session mode reads follow the retained transcript address, not changing task metadata', async () => {
  const address = { deviceId: 'target', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
  const reader = vi.fn().mockResolvedValue({ sessionMode: 'default', settingsTemplate: null })
  const context = { currentRuntimeTask: address, runtimeTaskLoadTarget: { address }, getRuntimeSessionModes: reader,
    codeCommentContexts: [], input: '', turnNavigation: [], messages: [], loadedTranscriptRanges: [],
    transcriptLoading: false } as unknown as ReturnType<typeof usePaneGoal>
  const hook = renderHook(value => usePaneDiagnostics(value), { initialProps: context })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.mode).toBe('default'))
  hook.rerender({ ...context, currentRuntimeTask: { ...address, runtimeHandle: { memoryTaskSnapshot: { sequence: 2 } } } })
  expect(reader).toHaveBeenCalledTimes(1)
  const next = { ...address, taskId: 'next-task', threadId: 'next-thread' }
  hook.rerender({ ...context, currentRuntimeTask: next, runtimeTaskLoadTarget: { ...context.runtimeTaskLoadTarget!, address: next } })
  await waitFor(() => expect(hook.result.current.loadedSessionMode?.taskId).toBe('next-task'))
  expect(reader).toHaveBeenCalledTimes(2)
  expect(reader).toHaveBeenLastCalledWith({ address: next })
})
