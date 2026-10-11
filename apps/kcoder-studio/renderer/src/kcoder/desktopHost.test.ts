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
