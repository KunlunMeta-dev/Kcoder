import { DesktopMenuBar } from '../../src/kcoder/DesktopMenuBar'
import { ConnectionsSettingsPage } from '../../src/components/settings/ConnectionsSettingsPage'
import { DeferredMobileSettingsPage } from '../../src/components/layout/DeferredWorkbenchPage'
import { Suspense, useLayoutEffect } from 'react'

/** Synthetic presentation fixture; it never creates tasks or changes a target. */
export default function SettingsSidebarFixture() {
  useLayoutEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute('data-theme')
    root.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
    return () => {
      if (previous === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', previous)
    }
  }, [])
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <DesktopMenuBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {new URLSearchParams(location.search).has('mobileSettings') ? (
          <Suspense fallback={null}><DeferredMobileSettingsPage onBack={() => {}} /></Suspense>
        ) : <ConnectionsSettingsPage onBack={() => {}} />}
      </div>
    </div>
  )
}
