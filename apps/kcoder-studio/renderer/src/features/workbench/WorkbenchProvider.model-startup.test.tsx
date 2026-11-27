import '@/i18n'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useWorkbench } from './useWorkbench'
import { BootstrapProbe, clearGatewayRuntime, createRuntimeWorkApiMock,
  createWorkbenchServices, deferred, renderWorkbench, setGatewayRuntime } from './WorkbenchProvider.test-support'
import type { RuntimeWorkListResponse } from '@/types/api'

function ModelStartupProbe() {
  const { projectChat } = useWorkbench()
  return <output data-testid="startup-models">{projectChat.models.map(model => model.name).join(',')}</output>
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  setGatewayRuntime()
  document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="owned-model-startup-test">')
})
afterEach(() => {
  clearGatewayRuntime()
  document.querySelectorAll('meta[content="owned-model-startup-test"]').forEach(node => node.remove())
})

// Provider readiness and read ownership only; no real Gateway or model request.
test('device model choices become ready without waiting for the historical workspace directory', async () => {
  const history = deferred<RuntimeWorkListResponse>()
  const listRuntimeWork = vi.fn(() => history.promise)
  const listModels = vi.fn().mockResolvedValue({ data: [{ name: 'gpt-5.5', type: 'public', modelId: 'owned-startup' }] })
  const services = createWorkbenchServices({
    modelApi: { listModels },
    runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
  })
  const page = renderWorkbench(<><BootstrapProbe /><ModelStartupProbe /></>, services)
  try {
    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    expect(listRuntimeWork).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('startup-models')).toHaveTextContent('gpt-5.5')
    expect(listModels).toHaveBeenCalledExactlyOnceWith(
      { deviceId: 'device-1', workspacePath: undefined }, { signal: expect.any(AbortSignal) }
    )
    // Settle the directory only after the model controls are already available.
    await act(async () => history.resolve({ projects: [], chats: [], totalTasks: 0 }))
    expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready')
    expect(listModels).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => history.resolve({ projects: [], chats: [], totalTasks: 0 }))
    page.unmount()
  }
})
