import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopFileMenuBridge } from './DesktopFileMenuBridge'
import {
  requestDesktopFileAction,
  subscribeDesktopFileAction,
  clearPendingDesktopFileActions,
} from './desktopFileActions'

const mocks = vi.hoisted(() => ({
  startNewChat: vi.fn(),
  logout: vi.fn(),
  navigateTo: vi.fn(),
  onMenuCommand: vi.fn(),
}))
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ logout: mocks.logout }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ startNewChat: mocks.startNewChat }),
}))
vi.mock('@/lib/navigation', () => ({ navigateTo: mocks.navigateTo }))
vi.mock('./desktopHost', () => ({ desktopHost: () => ({ onMenuCommand: mocks.onMenuCommand }) }))
afterEach(() => {
  cleanup()
  clearPendingDesktopFileActions()
  vi.clearAllMocks()
})

test('native File commands use real workbench actions and release the host listener', () => {
  const unsubscribe = vi.fn()
  mocks.onMenuCommand.mockReturnValue(unsubscribe)
  const view = render(<DesktopFileMenuBridge />)
  const command = mocks.onMenuCommand.mock.calls[0][0]
  act(() => command('new-chat'))
  expect(mocks.startNewChat).toHaveBeenCalledOnce()
  expect(mocks.navigateTo).toHaveBeenCalledWith('/')
  const temporary = vi.fn(),
    folder = vi.fn()
  const offTemp = subscribeDesktopFileAction('new-temporary-chat', temporary)
  const offFolder = subscribeDesktopFileAction('open-folder', folder)
  act(() => {
    command('new-temporary-chat')
    command('open-folder')
    command('logout')
  })
  expect(temporary).toHaveBeenCalledOnce()
  expect(folder).toHaveBeenCalledOnce()
  expect(mocks.logout).toHaveBeenCalledOnce()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  offTemp()
  offFolder()
})

test('actions survive initial settings route mount but are consumed only once', () => {
  requestDesktopFileAction('open-folder')
  const first = vi.fn()
  subscribeDesktopFileAction('open-folder', first)()
  expect(first).toHaveBeenCalledOnce()
  const second = vi.fn()
  subscribeDesktopFileAction('open-folder', second)()
  expect(second).not.toHaveBeenCalled()
})

test('unmount clears pending actions so a different login cannot inherit them', () => {
  const view = render(<DesktopFileMenuBridge />)
  act(() => mocks.onMenuCommand.mock.calls[0][0]('new-temporary-chat'))
  view.unmount()
  const next = vi.fn()
  subscribeDesktopFileAction('new-temporary-chat', next)()
  expect(next).not.toHaveBeenCalled()
})
