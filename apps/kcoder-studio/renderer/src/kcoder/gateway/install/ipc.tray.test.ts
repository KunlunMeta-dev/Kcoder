import { afterEach, expect, test, vi } from 'vitest'
import { createGatewayPageIpcHandler } from './ipc'
import type { KCoderGatewayRuntime } from '../../gatewayRuntime'

afterEach(() => { delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost })
test('the real Gateway close command requires the current window tray and never substitutes another action', async () => {
  const invoke = createGatewayPageIpcHandler({} as KCoderGatewayRuntime)
  for (const available of [false, undefined]) {
    const host = { getTrayCapabilities: vi.fn().mockResolvedValue(available === undefined ? undefined : { available }), hideToTray: vi.fn(), windowAction: vi.fn() }
    Object.assign(window, { kcoderDesktopHost: host })
    await expect(invoke('close_main_window_to_tray')).rejects.toThrow('DESKTOP_TRAY_')
    expect(host.hideToTray).not.toHaveBeenCalled(); expect(host.windowAction).not.toHaveBeenCalled()
  }
  const failure = new Error('owned unknown outcome'), host = { getTrayCapabilities: vi.fn().mockResolvedValue({ available: true }), hideToTray: vi.fn().mockRejectedValue(failure), windowAction: vi.fn() }
  Object.assign(window, { kcoderDesktopHost: host })
  await expect(invoke('close_main_window_to_tray')).rejects.toBe(failure)
  expect(host.hideToTray).toHaveBeenCalledTimes(1); expect(host.windowAction).not.toHaveBeenCalled()
})
