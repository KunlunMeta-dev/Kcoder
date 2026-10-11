import i18n from '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchPage } from './WorkbenchPage'

const mocks = vi.hoisted(() => ({
  isNativeTauriHost: vi.fn(),
  isMobile: vi.fn(),
  getUsage: vi.fn(),
  syncTray: vi.fn(),
  taskGroups: { hasRunningTasks: true },
  reminders: {
    unreadCount: 2,
    preferences: { trayUnreadEnabled: true, trayRunningEnabled: true, trayUsageEnabled: true },
  },
}))

vi.mock('@/components/layout/DesktopWorkbenchLayout', () => ({
  DesktopWorkbenchLayout: () => <div data-testid="desktop-layout" />,
}))
vi.mock('@/components/layout/MobileWorkbenchLayout', () => ({
  MobileWorkbenchLayout: () => <div data-testid="mobile-layout" />,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: { runtimeWork: null }, runtimeTaskReminders: mocks.reminders }),
}))
vi.mock('@/features/workbench/runtimeTaskReminders', () => ({
  EMPTY_RUNTIME_TASK_REMINDERS: mocks.reminders,
}))
vi.mock('@/features/workbench/useRuntimeTaskRouteRestoration', () => ({
  useRuntimeTaskRouteRestoration: vi.fn(),
}))
vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  useRuntimeTaskLifecycleStoreSnapshot: () => null,
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: mocks.isMobile }))
vi.mock('@/lib/runtime-environment', () => ({ isNativeTauriHost: mocks.isNativeTauriHost }))
vi.mock('@/tauri/trayMenuState', () => ({ buildTrayMenuTaskGroups: () => mocks.taskGroups }))
vi.mock('@/tauri/trayNavigation', () => ({ syncTrayMenuState: mocks.syncTray }))
vi.mock('@/api/local/codexUsage', () => ({
  getLocalCodexUsageDisplay: mocks.getUsage,
  emptyCodexUsageDisplay: () => ({ status: 'none', tooltip: '', trayTitle: '' }),
}))

describe('WorkbenchPage quota removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.getUsage.mockResolvedValue({
      status: 'available',
      tooltip: 'Codex quota',
      trayTitle: '5h 90%',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test.each([
    { native: true, mobile: false, layout: 'desktop-layout' },
    { native: true, mobile: true, layout: 'desktop-layout' },
    { native: false, mobile: false, layout: 'desktop-layout' },
    { native: false, mobile: true, layout: 'mobile-layout' },
  ])('never fetches quota on $layout with native=$native mobile=$mobile', async options => {
    mocks.isNativeTauriHost.mockReturnValue(options.native)
    mocks.isMobile.mockReturnValue(options.mobile)

    const view = render(<WorkbenchPage />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(screen.getByTestId(options.layout)).toBeInTheDocument()
    expect(mocks.getUsage).not.toHaveBeenCalled()
    expect(mocks.syncTray).toHaveBeenLastCalledWith(mocks.taskGroups, undefined, {
      title: null,
      tooltip: expect.stringMatching(/2/),
    })
    expect(mocks.syncTray.mock.lastCall?.[2].tooltip).not.toMatch(/Codex|5h|7d/)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

test('tray status follows the selected application language without an OS-language override', async () => {
  const previous = i18n.language
  mocks.isNativeTauriHost.mockReturnValue(true)
  mocks.isMobile.mockReturnValue(false)
  await i18n.changeLanguage('en')
  const view = render(<WorkbenchPage />)
  expect(mocks.syncTray.mock.lastCall?.[2].tooltip).toContain('Tasks running')
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  expect(mocks.syncTray.mock.lastCall?.[2].tooltip).toContain('有任务运行中')
  view.unmount()
  await i18n.changeLanguage(previous)
})
