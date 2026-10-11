import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  useDesktopSidebarCollapsed,
  useDesktopSidebarToggleRequest,
} from '@/components/layout/useDesktopSidebarCollapsed'

const compactWidth = 960
const isCompact = () => window.innerWidth <= compactWidth

/** Compact plugin routes use navigation over the page, without changing preferences. */
export function usePluginPageNavigation(isMobile: boolean) {
  const { sidebarCollapsed: storedCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const subscribe = useCallback((notify: () => void) => {
    let previous = isCompact()
    const resize = () => {
      const next = isCompact()
      if (next !== previous) setDrawerOpen(false)
      previous = next
      notify()
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const compact = useSyncExternalStore(subscribe, isCompact, () => false)
  const overlayNavigation = isMobile || compact
  const toggleSidebar = useCallback(() => {
    if (overlayNavigation) setDrawerOpen(open => !open)
    else setSidebarCollapsed(!storedCollapsed)
  }, [overlayNavigation, storedCollapsed, setSidebarCollapsed])
  useDesktopSidebarToggleRequest(toggleSidebar)
  return {
    sidebarCollapsed: compact || storedCollapsed,
    compact,
    overlayNavigation,
    drawerOpen,
    setDrawerOpen,
    toggleSidebar,
  }
}
