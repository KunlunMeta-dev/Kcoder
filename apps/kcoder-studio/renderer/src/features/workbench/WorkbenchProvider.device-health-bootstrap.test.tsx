import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useWorkbench } from './useWorkbench'
import { readCachedDeviceList } from './workbenchCloudStatus'
import {
  createDevice,
  createWorkbenchServices,
  deferred,
  renderWorkbench,
} from './WorkbenchProvider.test-support'
import type { DeviceInfo } from '@/types/api'

function DeviceHealthProbe() {
  const { state, refreshDevices } = useWorkbench()
  return (
    <>
      <span data-testid="health-bootstrap">{state.isBootstrapping ? 'loading' : 'ready'}</span>
      <span data-testid="health-devices">
        {state.devices.map(device => `${device.device_id}:${device.status}`).join('|')}
      </span>
      <span data-testid="health-selection">{state.standaloneDeviceId}</span>
      <button onClick={() => void refreshDevices()}>Refresh health</button>
    </>
  )
}

function setup(gateway = true) {
  const health = deferred<DeviceInfo[]>()
  const selected = createDevice({ capabilities: gateway ? ['kcoder-gateway'] : [] })
  const other = createDevice({
    id: 2,
    device_id: 'device-2',
    name: 'Other',
    status: 'offline',
    is_default: false,
  })
  const initial = [selected, other]
  const services = createWorkbenchServices()
  const listDevices = vi.mocked(services.deviceApi.listDevices)
  listDevices.mockImplementation(async options =>
    options?.health === 'selected' ? initial : health.promise
  )
  return { health, services, listDevices, initial, selected, other }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

// Deferred transport responses verify bootstrap scheduling, not model behavior.
test('reveals bootstrap before full health and updates health once without replacing the selected device', async () => {
  const { services, health, listDevices, selected, other } = setup()
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    expect(listDevices).toHaveBeenNthCalledWith(1, { health: 'selected' })
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    expect(listDevices).toHaveBeenNthCalledWith(2)
    expect(screen.getByTestId('health-devices')).toHaveTextContent('device-2:offline')
    expect(screen.getByTestId('health-selection')).toHaveTextContent('device-1')
    await act(async () =>
      health.resolve([
        { ...other, status: 'online', is_default: true },
        { ...selected, is_default: false },
      ])
    )
    await waitFor(() =>
      expect(screen.getByTestId('health-devices')).toHaveTextContent('device-2:online')
    )
    expect(screen.getByTestId('health-selection')).toHaveTextContent('device-1')
    expect(listDevices).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh health' }))
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(3))
    expect(listDevices).toHaveBeenLastCalledWith()
  } finally {
    health.resolve([])
    unmount()
  }
})

test('ignores a late background health result after unmount without rewriting cached devices', async () => {
  const { services, health, listDevices, other } = setup()
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
  const cached = readCachedDeviceList()
  unmount()
  await act(async () => health.resolve([{ ...other, status: 'online' }]))
  expect(readCachedDeviceList()).toEqual(cached)
  expect(listDevices).toHaveBeenCalledTimes(2)
})

test('does not start an extra background health refresh for non-Gateway devices', async () => {
  const { services, health, listDevices } = setup(false)
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    expect(listDevices).toHaveBeenCalledTimes(1)
  } finally {
    health.resolve([])
    unmount()
  }
})
