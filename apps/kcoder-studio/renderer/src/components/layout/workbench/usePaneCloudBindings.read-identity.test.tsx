import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { hydrateLocalWorkItems } from '@/features/todo/todoModel'
import type { CloudTaskContext } from '@/api/deliveries'
import type { RuntimeTaskAddress } from '@/types/api'
import { usePaneCloudBindings } from './usePaneCloudBindings'
import type { usePaneIdentity } from './usePaneIdentity'
import { cloudBindingState, usePendingCloudContext } from './cloudBindings'
import { captureAccountContextRevision, notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { PendingTodoBinding } from './types'
import { StrictMode } from 'react'

vi.mock('@/features/todo/todoModel', () => ({
  hydrateLocalWorkItems: vi.fn(async () => []), loadLocalWorkItems: vi.fn(), saveLocalWorkItems: vi.fn(),
}))

afterEach(() => { cloudBindingState.pendingTodoBinding = null })

function contextFor(read?: ReturnType<typeof vi.fn>) {
  return { state: { user: { id: 1 } }, currentRuntimeTask: {
    deviceId: 'target', taskId: 'original', threadId: 'original', workspacePath: '/owned',
  }, services: read ? { deliveryApi: { findCloudContextForTask: read,
    listCloudProjects: vi.fn(async () => ({ items: [] })), bindTask: vi.fn(), bindProjectTask: vi.fn() } } : {},
  setBoundCloudProject: vi.fn(), setBoundCloudItem: vi.fn(), setDeliveryItem: vi.fn(),
  setCloudProjects: vi.fn(), setPendingCloudContext: vi.fn(), setTodoBindingError: vi.fn(),
  cloudProjects: [], t: (_key: string, fallback: string) => fallback,
  } as unknown as ReturnType<typeof usePaneIdentity>
}

const cloudContext = { project: { id: 'project' }, loop_item: null } as unknown as CloudTaskContext

test.each([false, true])('presentation enrichment keeps the task context read (completed: %s)', async completed => {
  let resolve!: (value: CloudTaskContext) => void
  const read = vi.fn(() => new Promise<CloudTaskContext>(done => { resolve = done }))
  const context = contextFor(read)
  const view = renderHook(usePaneCloudBindings, { initialProps: context })
  if (completed) await act(async () => resolve(cloudContext))
  for (let sequence = 1; sequence <= 40; sequence++) {
    view.rerender({ ...context, currentRuntimeTask: { ...context.currentRuntimeTask!,
      runtimeHandle: { memoryTaskSnapshot: { sequence }, agentDefinition: { agentId: 'display' } } } })
  }
  expect(read).toHaveBeenCalledTimes(1)
  if (!completed) await act(async () => resolve(cloudContext))
  expect(context.setBoundCloudProject).toHaveBeenLastCalledWith(cloudContext.project)
  expect(context.services?.deliveryApi?.bindTask).not.toHaveBeenCalled()
  expect(context.services?.deliveryApi?.bindProjectTask).not.toHaveBeenCalled()
})

test('local TODO hydration shares the same original task identity', async () => {
  vi.mocked(hydrateLocalWorkItems).mockClear()
  const context = contextFor()
  const view = renderHook(usePaneCloudBindings, { initialProps: context })
  await waitFor(() => expect(context.setDeliveryItem).toHaveBeenCalledWith(null))
  view.rerender({ ...context, currentRuntimeTask: { ...context.currentRuntimeTask!,
    runtimeHandle: { memoryTaskSnapshot: { sequence: 2 } } } })
  expect(hydrateLocalWorkItems).toHaveBeenCalledTimes(1)
  view.rerender({ ...context, state: { ...context.state, user: { ...context.state.user!, id: 2 } } })
  await waitFor(() => expect(hydrateLocalWorkItems).toHaveBeenCalledTimes(2))
  expect(hydrateLocalWorkItems).toHaveBeenLastCalledWith(2)
})

test.each<Partial<RuntimeTaskAddress>>([
  { deviceId: 'next-target' }, { taskId: 'next-task' }, { workspacePath: '/next' },
  { threadId: 'next-thread' },
  { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'workspace', threadId: 'original' } },
])('a changed task read boundary retires the previous response: %j', async change => {
  let resolve!: (value: CloudTaskContext) => void
  const next = { ...cloudContext, project: { ...cloudContext.project, id: 'next' } }
  const read = vi.fn().mockImplementationOnce(() => new Promise<CloudTaskContext>(done => { resolve = done }))
    .mockResolvedValue(next)
  const context = contextFor(read)
  const view = renderHook(usePaneCloudBindings, { initialProps: context })
  const address = { ...context.currentRuntimeTask!, ...change }
  view.rerender({ ...context, currentRuntimeTask: address })
  await waitFor(() => expect(context.setBoundCloudProject).toHaveBeenLastCalledWith(next.project))
  await act(async () => resolve(cloudContext))
  expect(read).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenLastCalledWith(address)
  expect(context.setBoundCloudProject).not.toHaveBeenCalledWith(cloudContext.project)
})

test.each(['account', 'service'])('a %s change still re-reads and discards the previous owner response', async boundary => {
  let resolve!: (value: CloudTaskContext) => void
  const next = { ...cloudContext, project: { ...cloudContext.project, id: 'next' } }
  const read = vi.fn().mockImplementationOnce(() => new Promise<CloudTaskContext>(done => { resolve = done }))
    .mockResolvedValue(next)
  const context = contextFor(read)
  const view = renderHook(usePaneCloudBindings, { initialProps: context })
  const serviceRead = vi.fn().mockResolvedValue(next)
  view.rerender(boundary === 'account'
    ? { ...context, state: { ...context.state, user: { ...context.state.user!, id: 2 } } }
    : { ...context, services: contextFor(serviceRead).services })
  await waitFor(() => expect(context.setBoundCloudProject).toHaveBeenLastCalledWith(next.project))
  expect(read).toHaveBeenCalledTimes(boundary === 'account' ? 2 : 1)
  expect(serviceRead).toHaveBeenCalledTimes(boundary === 'service' ? 1 : 0)
  await act(async () => resolve(cloudContext))
  expect(context.setBoundCloudProject).not.toHaveBeenCalledWith(cloudContext.project)
})

function intentFor(context: ReturnType<typeof contextFor>, item: PendingTodoBinding['item'] = null): PendingTodoBinding {
  return { project: cloudContext.project, item, target: context.currentRuntimeTask,
    api: context.services?.deliveryApi, userId: context.state.user?.id, accountCurrent: captureAccountContextRevision() }
}

function useOwnedBinding(context: ReturnType<typeof contextFor>) {
  const pending = usePendingCloudContext(context.currentRuntimeTask, context.services?.deliveryApi, context.state.user?.id)
  return usePaneCloudBindings({ ...context, ...pending })
}

test.each([false, true])('display enrichment and title changes do not resubmit pending binding (TODO: %s)', async todo => {
  let resolve!: () => void
  const binding = new Promise<void>(done => { resolve = done })
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  context.currentRuntimeTask = { ...context.currentRuntimeTask!,
    runtimeHandle: { owner: 'original', memoryTaskSnapshot: { sequence: 0 } } }
  context.runtimeTaskTitle = 'Original title'
  const item = { id: 'todo', title: 'Original TODO', status: 'inbox', priority: 'medium' } as NonNullable<CloudTaskContext['loop_item']>
  const intent = intentFor(context, todo ? item : null)
  cloudBindingState.pendingTodoBinding = intent
  const api = context.services!.deliveryApi!
  const bind = vi.mocked(todo ? api.bindTask : api.bindProjectTask).mockReturnValue(binding)
  const view = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(context.setBoundCloudProject).toHaveBeenCalled())
  vi.mocked(context.setBoundCloudProject).mockClear()
  for (let sequence = 1; sequence <= 40; sequence++) {
    view.rerender({ ...context, currentRuntimeTask: { ...context.currentRuntimeTask!,
      runtimeHandle: { owner: 'original', memoryTaskSnapshot: { sequence } } },
    runtimeTaskTitle: `Display title ${sequence}` })
  }
  expect(bind).toHaveBeenCalledTimes(1)
  expect(bind).toHaveBeenCalledWith(todo ? item.id : cloudContext.project.id,
    intent.target, 'Original title')
  await act(async () => resolve())
  expect(context.setBoundCloudProject).toHaveBeenCalledExactlyOnceWith(cloudContext.project)
  expect(context.setBoundCloudItem).toHaveBeenLastCalledWith(todo ? item : null)
  expect(view.result.current.pendingCloudBinding).toBeNull()
  expect(cloudBindingState.pendingTodoBinding).toBeNull()
})

test('an unconfirmed binding failure survives remount without automatic replay', async () => {
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  const intent = intentFor(context)
  cloudBindingState.pendingTodoBinding = intent
  const bind = vi.mocked(context.services!.deliveryApi!.bindProjectTask)
    .mockRejectedValue(new Error('Original receipt unavailable'))
  const first = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(context.setTodoBindingError).toHaveBeenCalledWith('Original receipt unavailable'))
  const originalRequest = intent.submission
  first.unmount()
  const second = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(context.setTodoBindingError).toHaveBeenCalledTimes(2))
  second.rerender({ ...context, currentRuntimeTask: { ...context.currentRuntimeTask!, runtimeHandle: { display: true } } })
  expect(bind).toHaveBeenCalledTimes(1)
  expect(intent.submission).toBe(originalRequest)
  expect(second.result.current.pendingCloudBinding).toBe(intent)
})

test('StrictMode mount replay subscribes to the original binding without resubmitting it', async () => {
  let resolve!: () => void
  const pending = new Promise<void>(done => { resolve = done })
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  cloudBindingState.pendingTodoBinding = intentFor(context)
  const bind = vi.mocked(context.services!.deliveryApi!.bindProjectTask).mockReturnValue(pending)
  const view = renderHook(useOwnedBinding, { initialProps: context, wrapper: StrictMode })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
  await act(async () => resolve())
  expect(view.result.current.pendingCloudBinding).toBeNull()
  expect(cloudBindingState.pendingTodoBinding).toBeNull()
})

test('two panes for the same intent observe one original submission', async () => {
  let resolve!: () => void
  const pending = new Promise<void>(done => { resolve = done })
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  cloudBindingState.pendingTodoBinding = intentFor(context)
  const bind = vi.mocked(context.services!.deliveryApi!.bindProjectTask).mockReturnValue(pending)
  const first = renderHook(useOwnedBinding, { initialProps: context })
  const second = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
  await act(async () => resolve())
  expect(first.result.current.pendingCloudBinding).toBeNull()
  expect(second.result.current.pendingCloudBinding).toBeNull()
  expect(cloudBindingState.pendingTodoBinding).toBeNull()
})

test('clearing an unrelated pane cannot consume the shared pending intent', () => {
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  const intent = intentFor(context)
  cloudBindingState.pendingTodoBinding = intent
  const unrelated = { ...context, currentRuntimeTask: { deviceId: 'target', taskId: 'unrelated' } }
  const view = renderHook(useOwnedBinding, { initialProps: unrelated })
  expect(view.result.current.pendingCloudBinding).toBeNull()
  act(() => view.result.current.setPendingCloudContext(null, null))
  expect(cloudBindingState.pendingTodoBinding).toBe(intent)
  expect(context.services!.deliveryApi!.bindProjectTask).not.toHaveBeenCalled()
})

test('one pane settling does not clear another pane pending intent', async () => {
  let resolveOld!: () => void, resolveNew!: () => void
  const oldRequest = new Promise<void>(done => { resolveOld = done })
  const newRequest = new Promise<void>(done => { resolveNew = done })
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  const original = intentFor(context)
  cloudBindingState.pendingTodoBinding = original
  const bind = vi.mocked(context.services!.deliveryApi!.bindProjectTask)
    .mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest)
  const first = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
  const next = { ...contextFor(vi.fn().mockResolvedValue(cloudContext)), services: context.services,
    currentRuntimeTask: { deviceId: 'target', taskId: 'other-task', threadId: 'other-thread' } }
  const other = { ...intentFor(next), project: { ...cloudContext.project, id: 'other-pane' } }
  cloudBindingState.pendingTodoBinding = other
  const second = renderHook(useOwnedBinding, { initialProps: next })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(2))
  await act(async () => resolveOld())
  expect(first.result.current.pendingCloudBinding).toBeNull()
  expect(second.result.current.pendingCloudBinding).toBe(other)
  expect(cloudBindingState.pendingTodoBinding).toBe(other)
  await act(async () => resolveNew())
  expect(second.result.current.pendingCloudBinding).toBeNull()
  expect(cloudBindingState.pendingTodoBinding).toBeNull()
})

test.each(['service', 'user', 'account'])('a changed %s cannot resubmit or consume the original mutation', async boundary => {
  let resolve!: () => void
  const pending = new Promise<void>(done => { resolve = done })
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  const intent = intentFor(context)
  cloudBindingState.pendingTodoBinding = intent
  const bind = vi.mocked(context.services!.deliveryApi!.bindProjectTask).mockReturnValue(pending)
  const view = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
  const next = boundary === 'service' ? { ...context, services: contextFor(vi.fn().mockResolvedValue(cloudContext)).services }
    : boundary === 'user' ? { ...context, state: { ...context.state, user: { ...context.state.user!, id: 2 } } } : context
  if (boundary === 'account') notifyAccountContextChange('target')
  view.rerender(next)
  await act(async () => { await Promise.resolve() })
  vi.mocked(context.setBoundCloudProject).mockClear()
  expect(view.result.current.pendingCloudBinding).toBeNull()
  await act(async () => resolve())
  expect(bind).toHaveBeenCalledTimes(1)
  expect(context.setBoundCloudProject).not.toHaveBeenCalled()
  expect(cloudBindingState.pendingTodoBinding).toBe(intent)
  if (boundary === 'service') expect(next.services!.deliveryApi!.bindProjectTask).not.toHaveBeenCalled()
})

test('account retirement before dispatch cannot start a pending mutation', async () => {
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  const intent = intentFor(context)
  cloudBindingState.pendingTodoBinding = intent
  const view = renderHook(useOwnedBinding, { initialProps: context })
  notifyAccountContextChange('target')
  await act(async () => { await Promise.resolve() })
  expect(context.services!.deliveryApi!.bindProjectTask).not.toHaveBeenCalled()
  view.rerender(context)
  expect(view.result.current.pendingCloudBinding).toBeNull()
})

test.each<Partial<RuntimeTaskAddress>>([
  { deviceId: 'next-target' }, { taskId: 'next-task' }, { workspacePath: '/next' }, { threadId: 'next-thread' },
  { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'workspace', threadId: 'original' } },
])('a changed original task boundary retires the binding view without replay: %j', async change => {
  let resolve!: () => void
  const request = new Promise<void>(done => { resolve = done })
  const context = contextFor(vi.fn().mockResolvedValue(cloudContext))
  const intent = intentFor(context)
  cloudBindingState.pendingTodoBinding = intent
  const bind = vi.mocked(context.services!.deliveryApi!.bindProjectTask).mockReturnValue(request)
  const view = renderHook(useOwnedBinding, { initialProps: context })
  await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
  view.rerender({ ...context, currentRuntimeTask: { ...context.currentRuntimeTask!, ...change } })
  await act(async () => { await Promise.resolve() })
  vi.mocked(context.setBoundCloudProject).mockClear()
  expect(view.result.current.pendingCloudBinding).toBeNull()
  await act(async () => resolve())
  expect(bind).toHaveBeenCalledTimes(1)
  expect(context.setBoundCloudProject).not.toHaveBeenCalled()
  expect(cloudBindingState.pendingTodoBinding).toBe(intent)
})

test('a stale local clear and a creation callback preserve the newer shared intent', async () => {
  const context = contextFor()
  const draft = { ...context, currentRuntimeTask: null }
  let created!: (address: RuntimeTaskAddress) => void
  draft.sendPaneInput = vi.fn((_value, options) => { created = options!.onRuntimeTaskCreated! }) as typeof draft.sendPaneInput
  const view = renderHook(useOwnedBinding, { initialProps: draft })
  act(() => view.result.current.setPendingCloudContext(cloudContext.project, null))
  const original = view.result.current.pendingCloudBinding!
  const clearOriginal = view.result.current.setPendingCloudContext
  act(() => { void view.result.current.submitPaneInput('owned message') })
  const newer = { ...cloudContext.project, id: 'newer' }
  act(() => view.result.current.setPendingCloudContext(newer, null))
  const replacement = view.result.current.pendingCloudBinding
  act(() => clearOriginal(null, null))
  expect(view.result.current.pendingCloudBinding).toBe(replacement)
  created({ deviceId: 'target', taskId: 'created-original' })
  expect(original.target?.taskId).toBe('created-original')
  expect(replacement?.target).toBeNull()
  expect(cloudBindingState.pendingTodoBinding).toBe(replacement)
})
