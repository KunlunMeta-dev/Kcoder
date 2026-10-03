import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from '../WorkbenchProvider'
import { useWorkbench } from '../useWorkbench'
import {
  clearTauriRuntime,
  createRuntimeWork,
  createRuntimeWorkApiMock,
  createWorkbenchServices,
} from '../WorkbenchProvider.test-support'

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi
    .fn()
    .mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  requestLocalExecutor: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(() => {}),
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
}))

beforeEach(() => {
  clearTauriRuntime()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

// The device-workspace normalization this provider applies to its background
// subscription addresses is unit-tested in
// `__tests__/workbenchRuntimeHelpers.test.ts`; this case only pins that the
// provider still bootstraps its runtime work list through that data path.
test('bootstraps runtime work for the workbench context', async () => {
  let workbench!: ReturnType<typeof useWorkbench>
  const listRuntimeWork = vi.fn().mockResolvedValue(createRuntimeWork())
  const api = createRuntimeWorkApiMock({ listRuntimeWork })
  const services = createWorkbenchServices({
    runtimeWorkApi: api as WorkbenchServices['runtimeWorkApi'],
  })
  function Probe() {
    const current = useWorkbench()
    useEffect(() => {
      workbench = current
    })
    return null
  }
  render(
    <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
      <Probe />
    </WorkbenchProvider>
  )
  await waitFor(() => expect(workbench?.state.isBootstrapping).toBe(false))
  await waitFor(() => expect(workbench.state.runtimeWork?.projects).toHaveLength(1))
})