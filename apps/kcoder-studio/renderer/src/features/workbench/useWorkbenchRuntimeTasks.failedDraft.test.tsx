import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { isFailedRuntimeDraft } from '@/lib/failed-runtime-draft'
import type { RuntimeTaskSummary } from '@/types/api'
import '@/i18n'

const address = { deviceId: 'local', taskId: 'failed-draft', workspacePath: 'C:\\work' }
const draft: RuntimeTaskSummary = { ...address, title: 'Failed', runtime: 'kcoder', status: 'failed', optimistic: true, error: 'Fixture provider failure' }

test('removes a failed client-only task without archiving a nonexistent backend thread', async () => {
  const archiveConversation = vi.fn()
  const dispatch = vi.fn()
  const lifecycleStore = new RuntimeTaskLifecycleStore('test')
  const options = {
    user: { id: 1 }, state: { currentRuntimeTask: null, runtimeWork: { projects: [], chats: [{ deviceId: 'local', workspacePath: 'C:\\work', tasks: [draft] }] } },
    dispatch, executorClient: { runtime: { archiveConversation } }, services: {}, lifecycleStore,
    markRuntimeTasksArchived: vi.fn(), refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof useWorkbenchRuntimeTasks>[0]
  const { result } = renderHook(() => useWorkbenchRuntimeTasks(options))
  await act(async () => { expect(await result.current.archiveRuntimeTask(address)).toEqual({ status: 'archived' }) })
  expect(archiveConversation).not.toHaveBeenCalled()
  expect(dispatch).toHaveBeenCalledWith({ type: 'runtime_task_optimistic_removed', address })
})

test('does not locally discard a pending task or a real backend session', () => {
  expect(isFailedRuntimeDraft(draft)).toBe(true)
  for (const patch of [{ status: 'running' }, { running: true }, { optimistic: false }, { threadId: 'real-thread' }, { runtimeHandle: { session_id: 'real-thread' } }, { taskId: 'kcoder:local:real-thread' }]) {
    expect(isFailedRuntimeDraft({ ...draft, ...patch })).toBe(false)
  }
})
