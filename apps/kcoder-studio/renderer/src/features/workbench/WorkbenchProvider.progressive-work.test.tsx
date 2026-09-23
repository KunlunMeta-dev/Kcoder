import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { useWorkbench } from './useWorkbench'
import {
  createRuntimeWork,
  createWorkbenchServices,
  deferred,
  renderWorkbench,
} from './WorkbenchProvider.test-support'

function Probe() {
  const { state, refreshWorkLists } = useWorkbench()
  return (
    <>
      <button onClick={() => void refreshWorkLists()}>Refresh projects</button>
      <span data-testid="progressive-tasks">
        {state.runtimeWork?.projects
          .flatMap(project => project.deviceWorkspaces)
          .flatMap(workspace => workspace.tasks)
          .map(task => task.taskId)
          .join('|')}
      </span>
    </>
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

test('publishes manual refresh progress without waiting for device health', async () => {
  const services = createWorkbenchServices()
  const completed = deferred<RuntimeWorkListResponse>()
  const health = deferred<Awaited<ReturnType<typeof services.deviceApi.listDevices>>>()
  const { unmount } = renderWorkbench(<Probe />, services)
  try {
    await waitFor(() =>
      expect(screen.getByTestId('progressive-tasks')).toHaveTextContent('runtime-a')
    )
    let publish: ((value: RuntimeWorkListResponse) => void) | undefined
    vi.mocked(services.runtimeWorkApi.listRuntimeWork).mockImplementation(callback => {
      publish = callback
      return completed.promise
    })
    vi.mocked(services.deviceApi.listDevices).mockReturnValue(health.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }))
    await waitFor(() => expect(publish).toBeTypeOf('function'))
    const partial = createRuntimeWork()
    partial.projects[0].deviceWorkspaces[0].tasks = []
    act(() => publish!(partial))
    await waitFor(() => expect(screen.getByTestId('progressive-tasks')).toBeEmptyDOMElement())
  } finally {
    unmount()
    health.resolve([])
    completed.resolve(createRuntimeWork({ projects: [], totalTasks: 0 }))
  }
})

test('shows partial sessions before the complete request settles and replaces them with the final snapshot', async () => {
  const services = createWorkbenchServices()
  const completed = deferred<RuntimeWorkListResponse>()
  let publish: ((value: RuntimeWorkListResponse) => void) | undefined
  vi.mocked(services.runtimeWorkApi.listRuntimeWork).mockImplementation(callback => {
    publish = callback
    return completed.promise
  })
  const { unmount } = renderWorkbench(<Probe />, services)
  try {
    await waitFor(() => expect(publish).toBeTypeOf('function'))
    act(() => publish!(createRuntimeWork()))
    await waitFor(() =>
      expect(screen.getByTestId('progressive-tasks')).toHaveTextContent('runtime-a')
    )
    expect(services.runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
    await act(async () => completed.resolve(createRuntimeWork({ projects: [], totalTasks: 0 })))
    await waitFor(() => expect(screen.getByTestId('progressive-tasks')).toBeEmptyDOMElement())
  } finally {
    completed.resolve(createRuntimeWork({ projects: [], totalTasks: 0 }))
    unmount()
  }
})

test('ignores older bootstrap progress after a newer manual refresh completes', async () => {
  const services = createWorkbenchServices()
  const old = deferred<RuntimeWorkListResponse>()
  let publish: ((value: RuntimeWorkListResponse) => void) | undefined
  vi.mocked(services.runtimeWorkApi.listRuntimeWork)
    .mockImplementationOnce(callback => {
      publish = callback
      return old.promise
    })
    .mockResolvedValue(createRuntimeWork({ projects: [], totalTasks: 0 }))
  const { unmount } = renderWorkbench(<Probe />, services)
  try {
    await waitFor(() => expect(publish).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }))
    await waitFor(() => expect(services.runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    await act(async () => {
      publish!(createRuntimeWork())
      old.resolve(createRuntimeWork())
    })
    expect(screen.getByTestId('progressive-tasks')).toBeEmptyDOMElement()
  } finally {
    old.resolve(createRuntimeWork({ projects: [], totalTasks: 0 }))
    unmount()
  }
})
