import { afterEach, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import {
  canUseNativeProjectPickerForDevice,
  pickProjectDirectoriesForDevice,
} from './desktopDirectoryPicker'

const openNativeProjectDirectoryPickers = vi.hoisted(() => vi.fn())
vi.mock('@/lib/native-directory-picker', () => ({ openNativeProjectDirectoryPickers }))
const local = {
  device_id: 'local',
  capabilities: ['kcoder-gateway-local'],
  device_type: 'remote',
} as DeviceInfo
const ssh = { device_id: 'ssh', capabilities: [], device_type: 'remote' } as DeviceInfo
afterEach(() => {
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
  document.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
  vi.clearAllMocks()
})

test('only a local Electron directory capability can pick Gateway-local roots', async () => {
  const pickWorkspacePaths = vi.fn().mockResolvedValue(['/workspace/a', '/workspace/b'])
  Object.assign(window, { kcoderDesktopHost: { pickWorkspacePaths } })
  expect(canUseNativeProjectPickerForDevice(local, false)).toBe(true)
  await expect(pickProjectDirectoriesForDevice(local, '/workspace')).resolves.toEqual([
    '/workspace/a',
    '/workspace/b',
  ])
  expect(pickWorkspacePaths).toHaveBeenCalledWith({
    serverId: 'local',
    initialDirectory: '/workspace',
    multiple: true,
  })
  expect(canUseNativeProjectPickerForDevice(ssh, true)).toBe(false)
  await expect(pickProjectDirectoriesForDevice(ssh)).rejects.toThrow('server-side')
})

test('remote Electron and ordinary browser never map Gateway-local targets to PC paths', async () => {
  document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="fixture">')
  for (const host of [undefined, { windowAction: vi.fn() }]) {
    Object.assign(window, { kcoderDesktopHost: host })
    expect(canUseNativeProjectPickerForDevice(local, true)).toBe(false)
    await expect(pickProjectDirectoriesForDevice(local)).rejects.toThrow('server-side')
  }
  expect(openNativeProjectDirectoryPickers).not.toHaveBeenCalled()
})

test('standalone native Tauri local picker keeps its existing path', async () => {
  const device = { device_id: 'native', device_type: 'local' } as DeviceInfo
  openNativeProjectDirectoryPickers.mockResolvedValue(['/legacy'])
  expect(canUseNativeProjectPickerForDevice(device, true)).toBe(true)
  await expect(pickProjectDirectoriesForDevice(device, '/home')).resolves.toEqual(['/legacy'])
  expect(openNativeProjectDirectoryPickers).toHaveBeenCalledWith('/home')
})
