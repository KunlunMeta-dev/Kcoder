import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { useTaskReviewContext } from './useTaskReviewContext'
import { createTaskComparisonController } from './controller'
import type { RuntimeTaskAddress } from '@/types/api'

const mocks = vi.hoisted(() => ({
  workbench: {} as Record<string, unknown>,
  pane: {} as Record<string, unknown>,
  runtimeRequest: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => mocks.workbench,
  useWorkbenchPaneContext: () => mocks.pane,
}))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({
  invokeRuntimeCommand: mocks.runtimeRequest,
}))
const address: RuntimeTaskAddress = {
  deviceId: 'target-A',
  taskId: 'task-A',
  runtimeHandle: { threadId: 'thread-A' },
  workspacePath: '/source',
}
function fixture() {
  const drafts = new Map([
    ['task-A', 'Keep original A draft'],
    ['task-B', 'Keep original B draft'],
  ])
  const open = vi.fn(async () => {})
  const create = vi.fn(async () => ({
    accepted: true,
    taskId: 'task-C',
    deviceId: 'target-A',
    workspacePath: '/managed/C',
    runtime: 'kcoder',
    runtimeHandle: { threadId: 'thread-C' },
  }))
  const refresh = vi.fn(async () => {})
  const setInput = vi.fn()
  const work = {
    projects: [],
    totalTasks: 2,
    chats: [
      {
        deviceId: 'target-A',
        tasks: [
          {
            taskId: 'task-A',
            threadId: 'thread-A',
            workspacePath: '/source',
            title: 'A',
            runtime: 'kcoder',
          },
          {
            taskId: 'task-B',
            threadId: 'thread-B',
            workspacePath: '/managed/B',
            title: 'B',
            runtime: 'kcoder',
          },
        ],
      },
    ],
  }
  const append = vi.fn((target: RuntimeTaskAddress, text: string) => {
    if (
      target.deviceId !== 'target-A' ||
      target.taskId !== 'task-B' ||
      target.threadId !== 'thread-B'
    )
      return false
    drafts.set(target.taskId, `${drafts.get(target.taskId)}\n\n${text}`)
    return true
  })
  mocks.workbench = {
    state: { defaultTeam: { id: 42 } },
    services: { runtimeWorkApi: { createRuntimeTask: create } },
    openRuntimeTask: open,
    refreshWorkLists: refresh,
    appendRuntimeTaskDraft: append,
  }
  mocks.pane = {
    state: { user: { id: 1 }, runtimeWork: work },
    projectChat: {
      selectedModel: { name: 'pinned-model', type: 'public' },
      selectedModelOptions: { permissionMode: 'ask', reasoningEffort: 'high' },
      getModelSelectionMode: () => 'pinned',
      setInput,
    },
  }
  return { drafts, open, create, refresh, setInput, append, work }
}
beforeEach(() => {
  fixture()
})
describe('product review actions use real model, team, task and draft scopes', () => {
  it('creates through the ordinary runtime API with the selected model and actual default team', async () => {
    const { create, refresh } = fixture()
    const { result } = renderHook(() => useTaskReviewContext(address, 'template-A'))
    expect(result.current?.owner.threadId).toBe('thread-A')
    const created = await result.current?.createTask?.({
      deviceId: 'target-A',
      workspacePath: '/managed/C',
      creationRequestId: 'stable-create',
      title: 'C',
      prompt: 'Same requirement',
    })
    expect(created).toMatchObject({
      taskId: 'task-C',
      threadId: 'thread-C',
      workspacePath: '/managed/C',
    })
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        teamId: 42,
        modelId: 'pinned-model',
        settingsTemplate: 'template-A',
        taskId: 'stable-create',
        clientMessageId: 'stable-create',
        workspacePath: '/managed/C',
        sessionMode: 'default',
        modelOptions: expect.objectContaining({ permissionMode: 'ask', reasoningEffort: 'high' }),
      })
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('routes selected B feedback without touching the active A composer or replacing either draft', () => {
    const { drafts, open, setInput, append } = fixture()
    const { result } = renderHook(() => useTaskReviewContext(address))
    result.current?.onAddToTaskDraft?.('Fix B failed CI', {
      taskId: 'task-B',
      threadId: 'thread-B',
      deviceId: 'target-A',
    })
    expect(append).toHaveBeenCalledWith(
      { taskId: 'task-B', threadId: 'thread-B', deviceId: 'target-A' },
      'Fix B failed CI'
    )
    expect(drafts.get('task-A')).toBe('Keep original A draft')
    expect(drafts.get('task-B')).toBe('Keep original B draft\n\nFix B failed CI')
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-B',
        threadId: 'thread-B',
        workspacePath: '/managed/B',
      })
    )
    expect(setInput).not.toHaveBeenCalled()
  })
  it('rejects a changed recipient, account or workspace before adding feedback', () => {
    const { append, open } = fixture()
    const { result, rerender } = renderHook(({ target }) => useTaskReviewContext(target), {
      initialProps: { target: address },
    })
    expect(() =>
      result.current?.onAddToTaskDraft?.('wrong', {
        taskId: 'task-B',
        threadId: 'peer',
        deviceId: 'target-A',
      })
    ).toThrow()
    expect(open).not.toHaveBeenCalled()
    const old = result.current
    act(() => notifyAccountContextChange('target-A'))
    expect(old?.isCurrent()).toBe(false)
    expect(() =>
      old?.onAddToTaskDraft?.('late', {
        taskId: 'task-B',
        threadId: 'thread-B',
        deviceId: 'target-A',
      })
    ).toThrow()
    expect(append).toHaveBeenCalledTimes(1)
    rerender({ target: { ...address, workspacePath: '/peer-workspace' } })
    expect(result.current).toBeUndefined()
  })
  it('retires an unmounted pane while task creation awaits and never binds, opens or appends its late result', async () => {
    const { create, refresh, open, append, drafts } = fixture()
    let created!: (value: Awaited<ReturnType<typeof create>>) => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    create.mockImplementation(() => {
      started()
      return new Promise(resolve => { created = resolve })
    })
    const projection = { sourcePath: '/source', deviceId: 'target-A', comparisonId: 'comparison-unmount',
      ownerThreadId: 'thread-A', requirement: 'Same requirement', candidates: [], selectedThreadId: null }
    mocks.runtimeRequest.mockReset()
    mocks.runtimeRequest.mockImplementation(async (_command: unknown, raw: unknown) => {
      const method = (raw as { method: string }).method
      if (method === 'runtime.worktrees.comparison.read' || method === 'runtime.worktrees.comparison.bind') return projection
      if (method === 'runtime.worktrees.prepare') return { success: true, path: '/managed/C' }
      if (method === 'runtime.worktrees.list') return { items: [{ path: '/managed/C', sourcePath: '/source', revision: 1 }] }
      throw new Error('Unexpected review operation')
    })
    const { result, unmount } = renderHook(() => useTaskReviewContext(address))
    const original = result.current!
    const controller = createTaskComparisonController({
      scope: { deviceId: 'target-A', sourcePath: '/source', ownerThreadId: 'thread-A',
        comparisonId: 'comparison-unmount', requirement: 'Same requirement' },
      supported: true, request: original.request, isCurrent: original.isCurrent, createTask: original.createTask,
    })
    const pending = controller.create({ label: 'C', branch: 'candidate-C', prompt: 'Same requirement' })
    const rejected = expect(pending).rejects.toThrow()
    await act(async () => { await waiting })
    unmount()
    const retired = original.isCurrent()
    await act(async () => {
      created({ accepted: true, taskId: 'task-C', deviceId: 'target-A', workspacePath: '/managed/C',
        runtime: 'kcoder', runtimeHandle: { threadId: 'thread-C' } })
      await rejected
    })
    expect(retired).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    original.onOpenTask?.({ taskId: 'task-B', threadId: 'thread-B', deviceId: 'target-A', workspacePath: '/managed/B', title: 'B' })
    expect(() => original.onAddToTaskDraft?.('late feedback', { taskId: 'task-B', threadId: 'thread-B', deviceId: 'target-A' })).toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(drafts.get('task-A')).toBe('Keep original A draft')
    expect(drafts.get('task-B')).toBe('Keep original B draft')
    expect(mocks.runtimeRequest.mock.calls.map(call => (call[1] as { method: string }).method)).toEqual([
      'runtime.worktrees.comparison.read', 'runtime.worktrees.prepare',
    ])
  })
  it('does not invent a model or team when creation prerequisites are unavailable', () => {
    fixture()
    mocks.workbench.state = { defaultTeam: null }
    const { result } = renderHook(() => useTaskReviewContext(address))
    expect(result.current?.createTask).toBeUndefined()
    expect(result.current?.availableTasks).toHaveLength(2)
  })
})
