import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleContext } from '@/features/workbench/runtimeTaskLifecycle/internalContext'
import { WorkbenchPage } from './WorkbenchPage'

const mocks = vi.hoisted(() => ({
  work: null as RuntimeWorkListResponse | null,
  syncTray: vi.fn(), layout: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({
  state: { runtimeWork: mocks.work, devices: [] },
}) }))
vi.mock('@/components/layout/DesktopWorkbenchLayout', () => ({ DesktopWorkbenchLayout: () => {
  mocks.layout(); return <main data-testid="tray-cost-workbench" />
} }))
vi.mock('@/components/layout/MobileWorkbenchLayout', () => ({ MobileWorkbenchLayout: () => null }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/features/workbench/useRuntimeTaskRouteRestoration', () => ({ useRuntimeTaskRouteRestoration: () => {} }))
vi.mock('@/host/trayNavigation', () => ({ syncTrayMenuState: mocks.syncTray }))

afterEach(() => {
  Reflect.deleteProperty(window, 'kcoderDesktopHost')
  mocks.work = null
  vi.clearAllMocks()
})

function fixture() {
  let scans = 0
  mocks.work = {
    get projects() { scans++; return [] },
    chats: [{ deviceId: 'tray-owned', workspacePath: '/owned', workspaceKind: 'chat', available: true,
      tasks: Array.from({ length: 100 }, (_, index) => ({ taskId: `task-${index}`,
        runtime: 'kcoder', title: `Task ${index}`, workspacePath: '/owned' })) }],
    totalTasks: 100,
  }
  const store = new RuntimeTaskLifecycleStore('tray-cost-owned')
  const subscribe = vi.spyOn(store, 'subscribe')
  const view = () => <RuntimeTaskLifecycleContext.Provider value={store}><WorkbenchPage /></RuntimeTaskLifecycleContext.Provider>
  return { store, subscribe, view, scans: () => scans }
}

test('ordinary Web does not subscribe or scan the task directory for an absent tray', () => {
  const f = fixture(), page = render(f.view())
  try {
    expect(screen.getByTestId('tray-cost-workbench')).toBeVisible()
    mocks.layout.mockClear()
    for (let index = 0; index < 40; index++) act(() => f.store.turnStarted({
      deviceId: 'tray-owned', taskId: `task-${index}`, workspacePath: '/owned',
    }, `turn-${index}`))
    expect(f.scans()).toBe(0)
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(mocks.layout).not.toHaveBeenCalled()
    expect(mocks.syncTray).not.toHaveBeenCalled()
  } finally { page.unmount() }
})

test('a native host appearing on a parent update starts tray observation and removal releases it', () => {
  const f = fixture(), page = render(f.view())
  try {
    Object.defineProperty(window, 'kcoderDesktopHost', { configurable: true, value: {} })
    page.rerender(f.view())
    expect(f.subscribe).toHaveBeenCalledTimes(1)
    act(() => f.store.executorStarted({ deviceId: 'tray-owned', taskId: 'task-0', workspacePath: '/owned' }))
    expect(mocks.syncTray.mock.lastCall?.[0]).toMatchObject({ runningCount: 1, activeTaskIds: ['task-0'] })
    Reflect.deleteProperty(window, 'kcoderDesktopHost')
    page.rerender(f.view())
    const scans = f.scans()
    mocks.syncTray.mockClear()
    act(() => f.store.turnStarted({ deviceId: 'tray-owned', taskId: 'task-1', workspacePath: '/owned' }, 'next-turn'))
    expect(f.scans()).toBe(scans)
    expect(mocks.syncTray).not.toHaveBeenCalled()
  } finally { page.unmount() }
})
