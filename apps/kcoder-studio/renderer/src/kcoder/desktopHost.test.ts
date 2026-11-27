import { afterEach, expect, test, vi } from 'vitest'
import {
  installDesktopHostNavigation,
  syncDesktopPreferences,
  syncDesktopTrayState,
} from './desktopHost'

const navigateTo = vi.hoisted(() => vi.fn())
vi.mock('@/lib/navigation', () => ({ navigateTo }))
afterEach(() => {
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
})

test('desktop synchronization uses only client window preference and safe tray metadata', async () => {
  const host = { capabilities: { completionBadge: true }, setPreferences: vi.fn(), setTrayState: vi.fn(), onSettings: vi.fn() }
  Object.assign(window, { kcoderDesktopHost: host })
  await syncDesktopPreferences({
    closeToTrayEnabled: true,
    language: 'en-US',
    secret: 'not forwarded',
  })
  expect(host.setPreferences).toHaveBeenCalledWith({ closeToTrayEnabled: true, language: 'en' })
  await syncDesktopTrayState({
    language: 'zh',
    activeTaskIds: ['task-1'],
    unreadCount: 12,
    usageTitle: 'not forwarded',
  })
  expect(host.setTrayState).toHaveBeenCalledWith({ language: 'zh-CN', activeTaskIds: ['task-1'], unreadCount: 12 })
  installDesktopHostNavigation()
  host.onSettings.mock.calls[0][0]()
  expect(navigateTo).toHaveBeenCalledWith('/settings')
})

test('ordinary browser remains independent of Electron native capabilities', async () => {
  await expect(syncDesktopPreferences({ closeToTrayEnabled: false })).resolves.toEqual({
    closeToTrayEnabled: false,
  })
  await expect(syncDesktopTrayState({})).resolves.toBeNull()
  expect(installDesktopHostNavigation()).toBeTypeOf('function')
})

test('older Electron hosts retain the original tray-state shape', async () => {
  const host = {setTrayState:vi.fn()}
  Object.assign(window,{kcoderDesktopHost:host})
  await syncDesktopTrayState({language:'en',activeTaskIds:[],unreadCount:3})
  expect(host.setTrayState).toHaveBeenCalledWith({language:'en',activeTaskIds:[]})
})

test('tray actions require a current positive owner query and never fall back to close', async () => {
  const { readDesktopTrayAvailability, hideDesktopWindowToTray } = await import('./desktopHost')
  for (const result of [undefined, { available: false }, { available: 'true' }]) {
    const host = { getTrayCapabilities: vi.fn().mockResolvedValue(result), hideToTray: vi.fn(), windowAction: vi.fn() }
    Object.assign(window, { kcoderDesktopHost: host })
    await expect(hideDesktopWindowToTray()).rejects.toThrow('DESKTOP_TRAY_')
    expect(host.hideToTray).not.toHaveBeenCalled()
    expect(host.windowAction).not.toHaveBeenCalled()
  }
  const oldHost = { hideToTray: vi.fn() }
  Object.assign(window, { kcoderDesktopHost: oldHost })
  expect(await readDesktopTrayAvailability()).toBe('unknown')
  await expect(hideDesktopWindowToTray()).rejects.toThrow('DESKTOP_TRAY_CAPABILITY_UNKNOWN')
  expect(oldHost.hideToTray).not.toHaveBeenCalled()
  const failure = new Error('owned unknown hide receipt')
  const host = { getTrayCapabilities: vi.fn().mockResolvedValue({ available: true }), hideToTray: vi.fn().mockRejectedValue(failure), windowAction: vi.fn() }
  Object.assign(window, { kcoderDesktopHost: host })
  await expect(hideDesktopWindowToTray()).rejects.toBe(failure)
  expect(host.hideToTray).toHaveBeenCalledTimes(1)
  expect(host.windowAction).not.toHaveBeenCalled()
})

test('a late tray read cannot authorize a replaced host or preserve an old positive verdict', async () => {
  const { readDesktopTrayAvailability, hideDesktopWindowToTray } = await import('./desktopHost')
  let finish!: (value: { available: boolean }) => void
  const host = { getTrayCapabilities: vi.fn(() => new Promise<{ available: boolean }>(resolve => { finish = resolve })), hideToTray: vi.fn() }
  Object.assign(window, { kcoderDesktopHost: host })
  const pending = hideDesktopWindowToTray()
  Object.assign(window, { kcoderDesktopHost: { hideToTray: vi.fn() } })
  finish({ available: true })
  await expect(pending).rejects.toThrow('DESKTOP_TRAY_CAPABILITY_UNKNOWN')
  expect(host.hideToTray).not.toHaveBeenCalled()
  const current = { getTrayCapabilities: vi.fn().mockResolvedValueOnce({ available: true }).mockRejectedValue(new Error('lost query')), hideToTray: vi.fn() }
  Object.assign(window, { kcoderDesktopHost: current })
  expect(await readDesktopTrayAvailability()).toBe('available')
  await expect(hideDesktopWindowToTray()).rejects.toThrow('DESKTOP_TRAY_CAPABILITY_UNKNOWN')
  expect(current.hideToTray).not.toHaveBeenCalled()
})

test('an acknowledgement from a replaced window host cannot mark the next owner completed', async () => {
  const { hideDesktopWindowToTray } = await import('./desktopHost')
  let finish!: () => void
  const host = { getTrayCapabilities: vi.fn().mockResolvedValue({ available: true }), hideToTray: vi.fn(() => new Promise<void>(resolve => { finish = resolve })) }
  Object.assign(window, { kcoderDesktopHost: host })
  const pending = hideDesktopWindowToTray()
  await vi.waitFor(() => expect(host.hideToTray).toHaveBeenCalledTimes(1))
  Object.assign(window, { kcoderDesktopHost: { hideToTray: vi.fn() } })
  finish()
  await expect(pending).rejects.toThrow('DESKTOP_TRAY_OWNER_CHANGED')
})
