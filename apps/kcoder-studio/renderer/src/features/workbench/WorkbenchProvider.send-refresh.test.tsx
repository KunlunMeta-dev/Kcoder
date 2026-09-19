import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import {
  createRuntimeWork,
  createRuntimeWorkApiMock,
  createWorkbenchServices,
  clearTauriRuntime,
} from './WorkbenchProvider.test-support'
import { clearRuntimeConversationCacheForTests } from './runtimeConversationCache'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { RuntimeWorkListResponse } from '@/types/api'

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  requestLocalExecutor: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(() => {}),
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
}))

const address = {
  deviceId: 'device-1',
  taskId: 'runtime-a',
  workspacePath: '/workspace/project-alpha',
}
beforeEach(() => {
  clearTauriRuntime()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  clearRuntimeConversationCacheForTests()
})
afterEach(() => clearRuntimeConversationCacheForTests())

test('ordinary accepted/start/done update one task without another work list request', async () => {
  let workbench!: ReturnType<typeof useWorkbench>
  const subscribers = new Set<ChatStreamHandlers>()
  const list = vi.fn().mockResolvedValue(createRuntimeWork())
  const send = vi.fn().mockResolvedValue({ accepted: true, taskId: address.taskId })
  const api = createRuntimeWorkApiMock({ listRuntimeWork: list, sendRuntimeMessage: send })
  const services = createWorkbenchServices({
    runtimeWorkApi: api as WorkbenchServices['runtimeWorkApi'],
    chatStream: {
      subscribe: (handlers: ChatStreamHandlers) => {
        subscribers.add(handlers)
        return () => {
          subscribers.delete(handlers)
        }
      },
    } as WorkbenchServices['chatStream'],
  })
  function Probe() {
    const current = useWorkbench()
    const { subscribeRuntimeTaskStream, refreshWorkLists } = current
    useEffect(() => {
      workbench = current
    })
    useEffect(
      () =>
        subscribeRuntimeTaskStream(address, {
          onMessageAction: () => {},
          onRefreshWorkLists: () => {
            void refreshWorkLists()
          },
        }),
      [subscribeRuntimeTaskStream, refreshWorkLists]
    )
    return null
  }
  render(
    <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
      <Probe />
    </WorkbenchProvider>
  )
  await waitFor(() => expect(workbench?.state.isBootstrapping).toBe(false))
  await act(async () => {
    await workbench.openRuntimeTask(address)
  })
  const other = workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[1]
  list.mockClear()
  await act(async () => {
    expect(await workbench.sendRuntimePaneMessage({ address, message: 'hello' })).toBe(true)
  })
  expect(list).not.toHaveBeenCalled()
  await act(async () => {
    for (const handler of [...subscribers])
      handler.onChatStart?.({ ...address, subtaskId: 'turn-a' })
  })
  expect(list).not.toHaveBeenCalled()
  expect(workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0].running).toBe(true)
  await act(async () => {
    for (const handler of [...subscribers])
      handler.onChatDone?.({ ...address, subtaskId: 'turn-a', result: { content: 'done' } })
  })
  expect(list).not.toHaveBeenCalled()
  const tasks = workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks
  expect(tasks[0].running).toBe(false)
  expect(tasks[0].title).toBe('Runtime A')
  expect(tasks[1]).toEqual(other)
  await act(async () => {
    await workbench.refreshWorkLists()
  })
  expect(list).toHaveBeenCalled()
  let publishPartial: ((partial: RuntimeWorkListResponse) => void) | undefined
  let finishScan!: (result: RuntimeWorkListResponse) => void
  const oldScan = new Promise<RuntimeWorkListResponse>(resolve => {
    finishScan = resolve
  })
  list.mockImplementationOnce((partial: (value: RuntimeWorkListResponse) => void) => {
    publishPartial = partial
    return oldScan
  })
  let refresh!: Promise<void>
  await act(async () => {
    refresh = workbench.refreshWorkLists()
  })
  await waitFor(() => expect(publishPartial).toBeDefined())
  await act(async () => {
    for (const handler of [...subscribers])
      handler.onChatStart?.({ ...address, subtaskId: 'newer-turn' })
    for (const handler of [...subscribers])
      handler.onChatDone?.({
        ...address,
        subtaskId: 'newer-turn',
        result: { content: 'newer done' },
      })
  })
  const latestActivity =
    workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0].updatedAt
  await act(async () => {
    publishPartial?.({ projects: [], chats: [], totalTasks: 0 })
  })
  expect(workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
    running: false,
    updatedAt: latestActivity,
  })
  const stale = createRuntimeWork()
  stale.projects[0].deviceWorkspaces[0].tasks[0].running = true
  await act(async () => {
    finishScan(stale)
    await refresh
  })
  expect(workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
    running: false,
    updatedAt: latestActivity,
  })
  list.mockClear()
  // A new scan does not make retained, still-unscanned workspace data fresh.
  const nextScan = new Promise<RuntimeWorkListResponse>(resolve => {
    finishScan = resolve
  })
  list.mockImplementationOnce((partial: (value: RuntimeWorkListResponse) => void) => {
    publishPartial = partial
    return nextScan
  })
  await act(async () => {
    refresh = workbench.refreshWorkLists()
  })
  await act(async () => {
    publishPartial?.({ projects: [], chats: [], totalTasks: 0 })
  })
  expect(workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0]).toMatchObject({
    running: false,
    updatedAt: latestActivity,
  })
  await act(async () => {
    finishScan(stale)
    await refresh
  })
  expect(workbench.state.runtimeWork!.projects[0].deviceWorkspaces[0].tasks[0].running).toBe(true)
  list.mockClear()
  await act(async () => {
    for (const handler of [...subscribers])
      handler.onChatError?.({
        ...address,
        subtaskId: 'turn-error',
        error: 'recoverable test failure',
      })
  })
  expect(list).toHaveBeenCalled()
})
