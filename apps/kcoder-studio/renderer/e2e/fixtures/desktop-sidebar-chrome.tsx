import { useState } from 'react'
import { DesktopMenuBar } from '../../src/kcoder/DesktopMenuBar'
import { DesktopWindowControls } from '../../src/components/layout/DesktopWindowControls'
import { useDesktopSidebarCollapsed } from '../../src/components/layout/useDesktopSidebarCollapsed'

export function DesktopSidebarChromeFixture() {
  const [pageControls, setPageControls] = useState(true)
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  return (
    <div className="h-screen overflow-hidden bg-background">
      <DesktopMenuBar />
      {pageControls && (
        <DesktopWindowControls
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      )}
      <button
        type="button"
        data-testid="fixture-change-page-controls"
        onClick={() => setPageControls(value => !value)}
      >
        切换页面控件
      </button>
    </div>
  )
}
