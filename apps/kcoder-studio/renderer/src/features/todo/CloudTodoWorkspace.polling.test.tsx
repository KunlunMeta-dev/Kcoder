import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { User } from '@/types/api'
import { CloudTodoWorkspace } from './CloudTodoWorkspace'

const project = { id: 'owned-project', project_key: 'OWN', name: 'Owned board', description: '',
  project_store: 'backend', task_provider: 'local', provider_config: {}, status: 'active',
  version: 1, created_by_user_id: 1, created_at: '', updated_at: '2026-11-23' }
const item: CloudLoopItem = { id: 'owned-item', cloud_project_id: project.id, title: 'Current item',
  status: 'in_progress', priority: 'medium', tags: [], parent_id: null, sort_order: 0, version: 1,
  description: '', sequence_number: 1, created_by_user_id: 1, assignee_user_id: null,
  due_at: null, current_delivery_id: null, completed_at: null,
  created_at: '2026-11-23', updated_at: '2026-11-23' }
const page = { items: [item] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
async function setup() {
  const list = vi.fn().mockResolvedValue(page)
  const services = { deliveryApi: {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [project] }),
    listCloudProjectMembers: vi.fn().mockResolvedValue([]),
    listLoopItems: list,
  } } as unknown as WorkbenchServices
  const view = (active: boolean) => <RetainedPageActive.Provider value={active}>
    <CloudTodoWorkspace user={{ id: 1 } as User} localProjects={[]} services={services} />
  </RetainedPageActive.Provider>
  const hook = render(view(true))
  const projectButton = (await screen.findAllByText(project.name))[0]
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(projectButton) })
  expect(screen.getByTestId('cloud-todo-card-owned-item')).toBeInTheDocument()
  list.mockClear()
  return { ...hook, list, visible: (active: boolean) => hook.rerender(view(active)) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

// Count the real component's transport calls, including deferred and late replies.
test('a retained hidden board stays quiet and immediately reconciles on return', async () => {
  const hook = await setup()
  try {
    hook.visible(false)
    await advance(45_000)
    expect(hook.list).not.toHaveBeenCalled()
    hook.visible(true)
    await advance()
    expect(hook.list).toHaveBeenCalledExactlyOnceWith(project.id)
  } finally { hook.unmount() }
})

test('the next board poll waits for completion instead of overlapping a slow read', async () => {
  const pending = deferred<typeof page>()
  const hook = await setup()
  hook.list.mockReturnValueOnce(pending.promise)
  try {
    await advance(15_000)
    expect(hook.list).toHaveBeenCalledOnce()
    await advance(20_000)
    expect(hook.list).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(page); await pending.promise })
    await advance(14_999)
    expect(hook.list).toHaveBeenCalledOnce()
    await advance(1)
    expect(hook.list).toHaveBeenCalledTimes(2)
  } finally { hook.unmount(); pending.resolve(page) }
})

test('browser visibility resumes a fresh read and rejects a late pre-hide snapshot', async () => {
  const pending = deferred<typeof page>()
  const hook = await setup()
  hook.list.mockReturnValueOnce(pending.promise)
  try {
    await advance(15_000)
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(20_000)
    expect(hook.list).toHaveBeenCalledOnce()
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance()
    expect(hook.list).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending.resolve({ items: [{ ...item, title: 'Late old item' }] })
      await pending.promise
    })
    expect(screen.getByTestId('cloud-todo-card-owned-item')).toHaveTextContent('Current item')
    expect(screen.queryByText('Late old item')).not.toBeInTheDocument()
  } finally { hook.unmount(); pending.resolve(page) }
})

test('a current board error remains visible until a fresh snapshot succeeds', async () => {
  const hook = await setup()
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(Math, 'random').mockReturnValue(1)
  hook.list.mockRejectedValueOnce(new Error('Owned board failure'))
  try {
    await advance(15_000)
    expect(screen.getByText('Owned board failure')).toBeInTheDocument()
    expect(report).toHaveBeenCalledOnce()
    await advance(14_999)
    expect(hook.list).toHaveBeenCalledOnce()
    await advance(1)
    expect(hook.list).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Owned board failure')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-owned-item')).toHaveTextContent('Current item')
  } finally { hook.unmount() }
})
