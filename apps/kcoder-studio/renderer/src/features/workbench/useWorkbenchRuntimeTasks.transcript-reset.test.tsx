import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import '@/i18n'

test('explicit reset takes a fresh snapshot instead of joining a stale in-flight read', async () => {
  const pending: Array<(value: unknown) => void> = []
  const getRuntimeTranscript = vi.fn(() => new Promise(resolve => pending.push(resolve)))
  const options = {
    user: { id: 1 },
    state: { currentRuntimeTask: null, runtimeWork: { projects: [], chats: [] } },
    dispatch: vi.fn(),
    executorClient: { runtime: { getRuntimeTranscript } },
    services: {},
    lifecycleStore: new RuntimeTaskLifecycleStore('test'),
    markRuntimeTasksArchived: vi.fn(),
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof useWorkbenchRuntimeTasks>[0]
  const { result } = renderHook(() => useWorkbenchRuntimeTasks(options))
  const address = { deviceId: 'local', taskId: 'reset-task', workspacePath: '/owned/reset' }
  const old = result.current.loadRuntimeTranscriptForPane(address, { refresh: true })
  const reset = result.current.loadRuntimeTranscriptForPane(address, { refresh: true })
  expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)
  pending[1]({ messages: [], running: false, rangeStart: 7, rangeEnd: 7 })
  expect((await reset).rangeStart).toBe(7)
  pending[0]({ messages: [], running: true, rangeStart: 0, rangeEnd: 0 })
  expect((await old).rangeStart).toBe(0)
  const normal1 = result.current.loadRuntimeTranscriptForPane(address)
  const normal2 = result.current.loadRuntimeTranscriptForPane(address)
  expect(getRuntimeTranscript).toHaveBeenCalledTimes(3)
  pending[2]({ messages: [], running: false })
  await Promise.all([normal1, normal2])
})
