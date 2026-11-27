import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useWorkbench } from './useWorkbench'
import { WorkspaceScanCancelledError } from '@/kcoder/workspaceScanError'
import { readCachedDeviceList, resolveDeviceListWithCache } from './workbenchCloudStatus'
import {
  createDevice,
  createWorkbenchServices,
  deferred,
  renderWorkbench,
} from './WorkbenchProvider.test-support'
import type { DeviceInfo } from '@/types/api'

function DeviceHealthProbe() {
  const { state, refreshDevices, refreshWorkLists } = useWorkbench()
  return (
    <>
      <span data-testid="health-bootstrap">{state.isBootstrapping ? 'loading' : 'ready'}</span>
      <span data-testid="health-devices">
        {state.devices.map(device => `${device.device_id}:${device.status}`).join('|')}
      </span>
      <span data-testid="health-selection">{state.standaloneDeviceId}</span>
      <button onClick={() => void refreshDevices()}>Refresh health</button>
      <button onClick={() => void refreshWorkLists()}>Refresh work lists</button>
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
    capabilities: gateway ? ['kcoder-gateway'] : [],
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
afterEach(() => vi.restoreAllMocks())

test('hidden bootstrap defers full health until visible and starts that check only once', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const { services, health, listDevices, other } = setup()
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    expect(listDevices).toHaveBeenCalledExactlyOnceWith({ health: 'selected' })
    visibility.mockReturnValue('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(listDevices).toHaveBeenCalledTimes(2)
    expect(listDevices).toHaveBeenLastCalledWith()
    await act(async () => health.resolve([{ ...other, status: 'online' }]))
    await waitFor(() => expect(screen.getByTestId('health-devices')).toHaveTextContent('device-2:online'))
    await act(async () => {
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(listDevices).toHaveBeenCalledTimes(2)
  } finally { health.resolve([]); unmount() }
})

test('selected Gateway bootstrap does not replace the complete display cache', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const cached = [
    createDevice({ device_id: 'cached-selected', capabilities: ['kcoder-gateway'] }),
    createDevice({ id: 2, device_id: 'cached-peer', status: 'online', capabilities: ['kcoder-gateway'] }),
  ]
  resolveDeviceListWithCache(cached)
  const cacheBefore = sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')
  const { services, health, listDevices, initial } = setup()
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    expect(listDevices).toHaveBeenCalledExactlyOnceWith({ health: 'selected' })
    expect(sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')).toBe(cacheBefore)

    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(listDevices).toHaveBeenCalledTimes(2)
    await act(async () => health.resolve(initial.map(device => ({ ...device, status: 'online' }))))
    await waitFor(() => expect(readCachedDeviceList().map(device => device.device_id)).toEqual(['device-1', 'device-2']))
  } finally { health.resolve([]); unmount() }
})

test('unmounting a hidden bootstrap removes its deferred health check', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const { services, health, listDevices } = setup()
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    unmount()
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(listDevices).toHaveBeenCalledExactlyOnceWith({ health: 'selected' })
  } finally { health.resolve([]); unmount() }
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

test('late bootstrap health cannot replace a newer manual health result or its cache', async () => {
  const { services, health, listDevices, selected, other } = setup()
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    listDevices.mockResolvedValueOnce([selected, { ...other, status: 'online' }])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh health' }))
    await waitFor(() => expect(screen.getByTestId('health-devices')).toHaveTextContent('device-2:online'))
    const cached = readCachedDeviceList()
    await act(async () => health.resolve([selected, other]))
    expect(screen.getByTestId('health-devices')).toHaveTextContent('device-2:online')
    expect(readCachedDeviceList()).toEqual(cached)
    expect(listDevices).toHaveBeenCalledTimes(3)
  } finally { health.resolve([]); unmount() }
})

test.each(['abort', 'retired', 'ordinary'] as const)('bootstrap %s has an explicit device-cache boundary', async failure => {
  const cached = createDevice({ device_id: 'cached-original', capabilities: ['kcoder-gateway'] })
  resolveDeviceListWithCache([cached])
  const original = sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
  const health = deferred<DeviceInfo[]>()
  const services = createWorkbenchServices()
  const listDevices = vi.mocked(services.deviceApi.listDevices)
  listDevices.mockImplementation(options => options?.health === 'selected'
    ? Promise.reject(failure === 'abort' ? new DOMException('cancelled', 'AbortError')
      : failure === 'retired' ? new WorkspaceScanCancelledError() : new Error('offline'))
    : health.promise)
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    if (failure === 'ordinary') {
      expect(screen.getByTestId('health-devices')).toHaveTextContent('cached-original')
      await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    } else {
      expect(screen.getByTestId('health-devices')).not.toHaveTextContent('cached-original')
      expect(listDevices).toHaveBeenCalledExactlyOnceWith({ health: 'selected' })
    }
    expect(sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')).toBe(original)
  } finally { health.resolve([]); unmount() }
})

test.each(['device', 'team'] as const)('a manual read supersedes bootstrap while its %s is pending', async pending => {
  const bootstrapDevice = deferred<DeviceInfo[]>(), bootstrapTeam = deferred<null>(), lateHealth = deferred<DeviceInfo[]>()
  const original = createDevice({ device_id: 'bootstrap-old', capabilities: ['kcoder-gateway'] })
  const fresh = createDevice({ id: 2, device_id: 'manual-current', is_default: true })
  const services = createWorkbenchServices()
  const listDevices = vi.mocked(services.deviceApi.listDevices)
  let fullReads = 0
  listDevices.mockImplementation(options => options?.health === 'selected'
    ? pending === 'device' ? bootstrapDevice.promise : Promise.resolve([original])
    : ++fullReads === 1 ? Promise.resolve([fresh]) : lateHealth.promise)
  if (pending === 'team') vi.mocked(services.teamApi.getDefaultWorkbenchTeam).mockReturnValue(bootstrapTeam.promise)
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(listDevices).toHaveBeenCalledExactlyOnceWith({ health: 'selected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh health' }))
    await waitFor(() => expect(screen.getByTestId('health-devices')).toHaveTextContent('manual-current'))
    const cache = sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')
    await act(async () => { bootstrapDevice.resolve([original]); bootstrapTeam.resolve(null) })
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    expect(screen.getByTestId('health-devices')).toHaveTextContent('manual-current')
    expect(screen.getByTestId('health-devices')).not.toHaveTextContent('bootstrap-old')
    expect(screen.getByTestId('health-selection')).toHaveTextContent('manual-current')
    expect(sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')).toBe(cache)
    expect(listDevices).toHaveBeenCalledTimes(2)
  } finally { bootstrapDevice.resolve([]); bootstrapTeam.resolve(null); lateHealth.resolve([]); unmount() }
})

test('a successful Native device snapshot still renews the display-cache lifetime', async () => {
  const device = createDevice({ device_id: 'fresh-current' })
  resolveDeviceListWithCache([device])
  const before = JSON.parse(sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')!).updatedAt
  vi.spyOn(Date, 'now').mockReturnValue(before + 1000)
  const services = createWorkbenchServices()
  vi.mocked(services.deviceApi.listDevices).mockResolvedValue([device])
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    expect(JSON.parse(sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')!).updatedAt).toBe(before + 1000)
  } finally { unmount() }
})

test.each(['Refresh health', 'Refresh work lists'])('%s does not renew a fallback cache after an ordinary device failure', async action => {
  const { services, health, listDevices } = setup(false)
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    const cached = sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    listDevices.mockRejectedValueOnce(new Error('device-directory-offline'))
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(sessionStorage.getItem('wework.workbench.lastNonEmptyDevices')).toBe(cached)
  } finally { health.resolve([]); unmount() }
})

test('combined refresh writes the final device projection once', async () => {
  const { services, health, listDevices, initial } = setup(false)
  const { unmount } = renderWorkbench(<DeviceHealthProbe />, services)
  try {
    await waitFor(() => expect(screen.getByTestId('health-bootstrap')).toHaveTextContent('ready'))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    listDevices.mockResolvedValueOnce(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh work lists' }))
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(writes.mock.calls.filter(([key]) => key === 'wework.workbench.lastNonEmptyDevices')).toHaveLength(1)
  } finally { health.resolve([]); unmount() }
})
