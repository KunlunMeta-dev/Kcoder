import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { usePluginPageNavigation } from './usePluginPageNavigation'
import { requestDesktopSidebarToggle } from '@/components/layout/useDesktopSidebarCollapsed'
const originalWidth = window.innerWidth
function resize(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  window.dispatchEvent(new Event('resize'))
}
afterEach(() => {
  localStorage.clear()
  resize(originalWidth)
})

test('compact navigation does not persist collapse and restores the wide preference', () => {
  localStorage.setItem('wework.desktop.sidebar.collapsed', 'false')
  resize(1280)
  const { result } = renderHook(() => usePluginPageNavigation(false))
  expect(result.current.sidebarCollapsed).toBe(false)
  act(() => resize(400))
  expect(result.current.sidebarCollapsed).toBe(true)
  expect(localStorage.getItem('wework.desktop.sidebar.collapsed')).toBe('false')
  act(() => {
    expect(requestDesktopSidebarToggle()).toBe(true)
  })
  expect(result.current.drawerOpen).toBe(true)
  act(() => resize(1280))
  expect(result.current.drawerOpen).toBe(false)
  expect(result.current.sidebarCollapsed).toBe(false)
  act(() => resize(400))
  expect(result.current.drawerOpen).toBe(false)
})

test('an explicitly collapsed wide sidebar remains collapsed after resizing', () => {
  localStorage.setItem('wework.desktop.sidebar.collapsed', 'true')
  resize(400)
  const { result } = renderHook(() => usePluginPageNavigation(false))
  act(() => resize(1280))
  expect(result.current.sidebarCollapsed).toBe(true)
  act(() => result.current.toggleSidebar())
  expect(result.current.sidebarCollapsed).toBe(false)
  expect(localStorage.getItem('wework.desktop.sidebar.collapsed')).toBe('false')
})

test('mobile menu handling stays temporary and stops intercepting requests after unmount', () => {
  resize(400)
  const { result, unmount } = renderHook(() => usePluginPageNavigation(true))
  act(() => result.current.toggleSidebar())
  expect(result.current.drawerOpen).toBe(true)
  act(() => resize(410))
  expect(result.current.drawerOpen).toBe(true)
  expect(localStorage.getItem('wework.desktop.sidebar.collapsed')).toBeNull()
  unmount()
  expect(requestDesktopSidebarToggle()).toBe(false)
})
