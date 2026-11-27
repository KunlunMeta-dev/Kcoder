import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { navigateTo } from '@/lib/navigation'
import type {
  RuntimeTaskCreationReadRequest,
  RuntimeTaskCreationReadResponse,
  RuntimeTaskSummary,
} from '@/types/api'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'

vi.mock('@/lib/navigation', async importActual => ({
  ...(await importActual<typeof import('@/lib/navigation')>()),
  navigateTo: vi.fn(),
}))

const address = {
  deviceId: 'original-target',
  taskId: 'original-create',
  workspacePath: '/original',
}
const draft: RuntimeTaskSummary = {
  taskId: address.taskId,
  workspacePath: address.workspacePath,
  title: 'Unconfirmed input',
  runtime: 'kcoder',
  optimistic: true,
  status: 'failed',
  running: false,
  updatedAt: 12,
  creationRequest: {
    clientRequestId: address.taskId,
    clientMessageId: 'first-input',
    outcome: 'unknown',
  },
}
const ready: Extract<RuntimeTaskCreationReadResponse, { status: 'ready' }> = {
  status: 'ready',
  address: { ...address, taskId: 'kcoder:original-target:thread', threadId: 'thread' },
  initialMessage: { status: 'completed', turnId: 'original-turn' },
}
type Options = Parameters<typeof useWorkbenchRuntimeTasks>[0]

function setup() {
  const runtime = {
    readRuntimeTaskCreation: vi.fn<(request: RuntimeTaskCreationReadRequest) => Promise<RuntimeTaskCreationReadResponse>>(
      async () => ready
    ),
    getRuntimeTranscript: vi.fn(async () => ({ messages: [] })),
    createRuntimeTask: vi.fn(),
    sendRuntimeMessage: vi.fn(),
  }
  const client = { runtime } as unknown as Options['executorClient']
  const state = {
    currentRuntimeTask: null,
    currentProject: null,
    selectedDeviceWorkspaceId: 17,
    standaloneDeviceId: address.deviceId,
    standaloneWorkspacePath: address.workspacePath,
    standaloneChatKey: 3,
    projects: [],
    runtimeWork: {
      projects: [],
      chats: [{ deviceId: address.deviceId, workspacePath: address.workspacePath, tasks: [draft] }],
    },
  } as unknown as Options['state']
  const dispatch = vi.fn()
  const hook = renderHook(
    ({ state, client }) =>
      useWorkbenchRuntimeTasks({
        user: { id: 1 },
        state,
        dispatch,
        executorClient: client,
        services: {},
        lifecycleStore: new RuntimeTaskLifecycleStore('creation-recovery'),
        markRuntimeTasksArchived: vi.fn(),
        refreshWorkLists: vi.fn(),
      } as unknown as Options),
    { initialProps: { state, client } }
  )
  return { ...hook, runtime, client, state, dispatch }
}

beforeEach(() => {
  vi.mocked(navigateTo).mockClear()
  window.history.replaceState({}, '', '/')
})

test('querying uses the retained original identities and does not open or discard a draft', async () => {
  const f = setup()
  expect(await f.result.current.recoverRuntimeTask(address)).toEqual(ready)
  expect(f.runtime.readRuntimeTaskCreation).toHaveBeenCalledWith({
    deviceId: address.deviceId,
    workspacePath: address.workspacePath,
    clientRequestId: address.taskId,
    clientMessageId: 'first-input',
  })
  expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(navigateTo).not.toHaveBeenCalled()
  expect(f.runtime.createRuntimeTask).not.toHaveBeenCalled()
  expect(f.runtime.sendRuntimeMessage).not.toHaveBeenCalled()
})

test.each(['unknown', 'unavailable'] as const)(
  '%s evidence never opens or discards a draft',
  async status => {
    const f = setup()
    f.runtime.readRuntimeTaskCreation.mockResolvedValue({ status })
    expect(await f.result.current.recoverRuntimeTask(address, true)).toEqual({ status })
    expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  }
)

test.each(['completed', 'unknown'] as const)(
  'opening checks original history and preserves an %s initial message',
  async status => {
    const f = setup()
    f.runtime.readRuntimeTaskCreation.mockResolvedValue({ ...ready, initialMessage: { status } })
    await act(async () => {
      await f.result.current.recoverRuntimeTask(address, true)
    })
    expect(f.runtime.getRuntimeTranscript).toHaveBeenCalledWith(ready.address)
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'runtime_task_opened', address: ready.address })
    )
    const removal = { type: 'runtime_task_optimistic_removed', address }
    if (status === 'unknown') expect(f.dispatch).not.toHaveBeenCalledWith(removal)
    else expect(f.dispatch).toHaveBeenCalledWith(removal)
    expect(f.runtime.createRuntimeTask).not.toHaveBeenCalled()
    expect(f.runtime.sendRuntimeMessage).not.toHaveBeenCalled()
  }
)

test('history failure preserves the failed record and does not navigate', async () => {
  const f = setup()
  f.runtime.getRuntimeTranscript.mockRejectedValue(new Error('history unavailable'))
  await expect(f.result.current.recoverRuntimeTask(address, true)).rejects.toThrow(
    'history unavailable'
  )
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(navigateTo).not.toHaveBeenCalled()
})

test.each([
  { ...ready.address, deviceId: 'other-target' },
  { ...ready.address, workspacePath: '/other' },
  { ...ready.address, taskId: 'kcoder:original-target:other-thread' },
])('rejects a recovered address outside the exact original owner: %j', async recovered => {
  const f = setup()
  f.runtime.readRuntimeTaskCreation.mockResolvedValue({ ...ready, address: recovered })
  await expect(f.result.current.recoverRuntimeTask(address, true)).rejects.toThrow()
  expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
  expect(f.dispatch).not.toHaveBeenCalled()
})

test.each(['account', 'executor', 'draft', 'navigation'] as const)(
  'a pending lookup cannot commit after %s changes',
  async change => {
    const f = setup()
    let release!: (result: RuntimeTaskCreationReadResponse) => void
    f.runtime.readRuntimeTaskCreation.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const request = f.result.current.recoverRuntimeTask(address, true)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    if (change === 'account') notifyAccountContextChange(address.deviceId)
    if (change === 'executor') f.rerender({ state: f.state, client: { ...f.client } })
    if (change === 'draft')
      f.rerender({
        state: { ...f.state, runtimeWork: { projects: [], chats: [] } },
        client: f.client,
      })
    if (change === 'navigation') window.history.pushState({}, '', '/different-conversation')
    release(ready)
    await rejected
    expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  }
)

const recoveryViewChanges = [
  ['target', { standaloneDeviceId: 'next-target' }],
  ['workspace path', { standaloneWorkspacePath: '/next-workspace' }],
  ['selected workspace', { selectedDeviceWorkspaceId: 18 }],
  ['chat key', { standaloneChatKey: 4 }],
] as const

test.each(recoveryViewChanges)(
  'an explicit open cannot commit after the selected %s changes while lookup is pending',
  async (_name, patch) => {
    const f = setup()
    let release!: (result: RuntimeTaskCreationReadResponse) => void
    f.runtime.readRuntimeTaskCreation.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const opening = f.result.current.recoverRuntimeTask(address, true)
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' })

    f.rerender({ state: { ...f.state, ...patch }, client: f.client })
    release(ready)
    await rejected

    expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  }
)

test('an explicit open cannot commit after the failed creation outcome changes', async () => {
  const f = setup()
  let release!: (result: RuntimeTaskCreationReadResponse) => void
  f.runtime.readRuntimeTaskCreation.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const opening = f.result.current.recoverRuntimeTask(address, true)
  const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
  const changedDraft = {
    ...draft,
    creationRequest: { ...draft.creationRequest!, outcome: 'rejected' as const },
  }
  f.rerender({
    state: {
      ...f.state,
      runtimeWork: {
        projects: [],
        chats: [{ deviceId: address.deviceId, workspacePath: address.workspacePath, tasks: [changedDraft] }],
      },
    },
    client: f.client,
  })
  release(ready)
  await rejected

  expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(navigateTo).not.toHaveBeenCalled()
})

test('a pure query completes after the selected view changes without opening or navigating', async () => {
  const f = setup()
  let release!: (result: RuntimeTaskCreationReadResponse) => void
  f.runtime.readRuntimeTaskCreation.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const query = f.result.current.recoverRuntimeTask(address)

  f.rerender({ state: { ...f.state, standaloneDeviceId: 'next-target' }, client: f.client })
  release(ready)
  await expect(query).resolves.toEqual(ready)

  expect(f.runtime.getRuntimeTranscript).not.toHaveBeenCalled()
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(navigateTo).not.toHaveBeenCalled()
})
