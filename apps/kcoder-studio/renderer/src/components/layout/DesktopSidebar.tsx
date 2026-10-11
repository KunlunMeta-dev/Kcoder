import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { Plus, Search } from 'lucide-react'
import { DesktopAppSwitcher } from './DesktopAppSwitcher'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { AccountSection } from './sidebar/AccountSection'
import { SidebarDialogs } from './sidebar/SidebarDialogs'
import { MACOS_WINDOW_CONTROLS_SAFE_AREA_CLASS } from './sidebar/sidebarSelectors'
import { SidebarButton } from './sidebar/SidebarWidgets'
import { SidebarWorklists } from './sidebar/SidebarWorklists'
import { type DesktopSidebarProps } from './sidebar/types'
import { useSidebarModel } from './sidebar/useSidebarModel'

export function DesktopSidebar(props: DesktopSidebarProps) {
  const model = useSidebarModel(props)
  const {
    activeItem,
    onNewChat,
    onOpenSearch,
    collapsed,
    containerTestId,
    hideResizeHandle,
    onPointerEnter,
    onPointerLeave,
    onToggleSidebar,
    onOpenWorkbench,
    onOpenTodo,
    onOpenApps,
    background,
    t,
    sidebarWidth,
    resizing,
    handleResizeStart,
    usesOverlayTitlebar,
    windowFocused,
  } = model
  return (
    <aside
      data-testid={containerTestId}
      data-window-focused={windowFocused}
      aria-hidden={collapsed}
      inert={collapsed}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        'relative z-popover h-full shrink-0 overflow-visible border-r border-black/[0.08] transition-[width,background-color] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[width] dark:border-white/[0.08]',
        background.imagePath && background.inSidebar
          ? 'bg-background/25'
          : 'bg-[rgb(var(--color-sidebar))]',
        !windowFocused &&
          !(background.imagePath && background.inSidebar) &&
          'bg-[rgb(var(--color-sidebar-unfocused))]',
        resizing && 'transition-none',
        collapsed && 'pointer-events-none'
      )}
      style={{ width: collapsed ? 0 : sidebarWidth }}
    >
      <div className="h-full overflow-hidden">
        <div
          className={cn(
            'relative flex h-full flex-col px-1.5',
            usesOverlayTitlebar ? 'pt-[44px]' : 'pt-1.5'
          )}
          style={{ width: sidebarWidth }}
        >
          {usesOverlayTitlebar && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {usesOverlayTitlebar && onToggleSidebar && (
            <div
              data-testid="desktop-sidebar-chrome-controls"
              className={cn(
                'absolute top-0 z-chrome flex h-[38px] items-center gap-1',
                MACOS_WINDOW_CONTROLS_SAFE_AREA_CLASS
              )}
            >
              <DesktopWindowControls
                sidebarCollapsed={false}
                onToggleSidebar={onToggleSidebar}
                className="gap-1"
              />
              <DesktopAppSwitcher
                activeApp={
                  activeItem === 'todo' ? 'todo' : activeItem === 'plugins' ? 'apps' : 'studio'
                }
                onNavigate={app => {
                  if (app === 'studio') onOpenWorkbench?.()
                  if (app === 'todo') onOpenTodo?.()
                  if (app === 'apps') onOpenApps?.()
                  if (app === 'wegent') navigateTo('/app/wegent')
                }}
              />
            </div>
          )}
          <div className="mb-1 flex h-9 items-center justify-between px-2">
            <span className="min-w-0 truncate text-heading-sm font-semibold leading-6 text-[rgb(var(--color-sidebar-text-primary))]">
              {t('workbench.brand', 'KCoder Studio')}
            </span>
            {onOpenSearch && (
              <button
                type="button"
                data-testid="runtime-search-button"
                onClick={onOpenSearch}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                title={t('workbench.search')}
                aria-label={t('workbench.search')}
              >
                <Search className="h-4 w-4" />
              </button>
            )}
          </div>
          <nav className="space-y-0.5">
            <SidebarButton
              icon={Plus}
              label={t('workbench.new_task')}
              testId="new-chat-button"
              onClick={onNewChat}
            />
          </nav>

          <SidebarWorklists model={model} />

          <AccountSection model={model} />

          <SidebarDialogs model={model} />
        </div>
      </div>

      {!collapsed && !hideResizeHandle && (
        <button
          type="button"
          data-testid="sidebar-resize-handle"
          onPointerDown={handleResizeStart}
          className="absolute right-[-14px] top-0 z-[80] h-full w-[18px] cursor-col-resize touch-none bg-transparent after:absolute after:left-1 after:top-0 after:h-full after:w-px after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-primary/35"
          aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
        />
      )}
    </aside>
  )
}
