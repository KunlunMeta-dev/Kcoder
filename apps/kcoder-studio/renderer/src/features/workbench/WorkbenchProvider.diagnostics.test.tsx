import '@/i18n'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { getWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { useWorkbench } from './useWorkbench'
import { renderWorkbench, clearGatewayRuntime } from './WorkbenchProvider.test-support'

vi.mock('@/host/localExecutor', () => ({
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensureLocalExecutorStarted: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' }),
  requestLocalExecutor: vi.fn().mockResolvedValue({}),
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(vi.fn()),
}))

afterEach(() => { localStorage.clear(); sessionStorage.clear(); clearGatewayRuntime(); vi.restoreAllMocks() })

test('draft updates do not scan diagnostic directories; explicit reads use current data and unmount releases it', async () => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  const capture = vi.fn<(value: ReturnType<typeof useWorkbench>) => void>()
  function Draft() {
    const workbench = useWorkbench()
    useEffect(() => { capture(workbench) }, [workbench])
    return <>
      <p>{workbench.state.isBootstrapping ? 'Loading' : 'Ready'}</p>
      <input aria-label="Draft" value={workbench.projectChat.input}
        onChange={event => workbench.projectChat.setInput(event.target.value)} />
    </>
  }
  const view = renderWorkbench(<Draft />)
  await screen.findByText('Ready')
  await waitFor(() => expect(capture.mock.lastCall?.[0].state.runtimeWork).not.toBeNull())
  const directory = capture.mock.lastCall![0].state.runtimeWork!
  const traverse = vi.spyOn(directory.projects, 'flatMap')
  for (let index = 1; index <= 12; index++)
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: `Draft ${index}` } })
  expect(traverse).not.toHaveBeenCalled()
  const snapshot = getWorkbenchDebugSnapshot().workbench!
  expect(snapshot.composer?.currentInputLength).toBe('Draft 12'.length)
  expect(snapshot.runtimeWorkSummary.totalTasks).toBe(directory.totalTasks)
  expect(traverse).toHaveBeenCalled()
  view.unmount()
  expect(getWorkbenchDebugSnapshot().workbench).toBeNull()
})
