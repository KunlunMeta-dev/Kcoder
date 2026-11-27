import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import { usePageSurfaceTransition } from '@/components/layout/pageTransitionAnimation'
import { ToolSelectionsSettingsPage } from './ToolSelectionsSettingsPage'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { useResizableSidebar } from '@/components/layout/useResizableSidebar'
import {
  useDesktopSidebarCollapsed,
  useDesktopSidebarToggleRequest,
} from '@/components/layout/useDesktopSidebarCollapsed'
import { Button } from '@/components/ui/button'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { ExecutionDefaultsSettingsPage } from '@/features/execution-settings/ExecutionDefaultsSettingsPage'
import { HooksSettingsPage } from '@/features/hooks/HooksSettingsPage'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { navigateTo } from '@/lib/navigation'
import { isGatewayRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import type { DeviceInfo as RuntimeDeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AboutSettingsPage } from './AboutSettingsPage'
import { AppshotsSettingsPage } from './AppshotsSettingsPage'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import { BrowserAccessSettingsPage } from './BrowserAccessSettingsPage'
import { BrowserSettingsPage } from './BrowserSettingsPage'
import { ContextSettingsPage } from './ContextSettingsPage'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import { KCoderProviderSettingsPage } from './KCoderProviderSettingsPage'
import { KCoderServersSettingsPage } from './KCoderServersSettingsPage'
import { KeyboardShortcutsSettingsPage } from './KeyboardShortcutsSettingsPage'
import { ModelSettingsPage } from './ModelSettingsPage'
import { PluginSettingsPage } from './PluginSettingsPage'
import { ProxySettingsPage } from './ProxySettingsPage'
import { QuickPhrasesSettingsPage } from './QuickPhrasesSettingsPage'
import { SelfEvolutionSettingsPage } from './SelfEvolutionSettingsPage'
import { SettingsDirectory } from './SettingsDirectory'
import { ModalDialog } from '@/components/ui/modal-dialog'
import {
  availableSettings,
  desktopSettingsFromPath,
  settingsPath,
  useSettingsPathname,
  type SettingsItem,
} from './settingsNavigation'
import { SshConnectionsSettingsPage } from './SshConnectionsSettingsPage'
import { StorageSettingsPage } from './StorageSettingsPage'
import { UsageSettingsPage } from './UsageSettingsPage'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'
import { ReturnToConversationButton } from './ReturnToConversationButton'

interface ConnectionsSettingsPageProps {
  onBack: () => void
  backLabel?: string
  onLeaveToRuntimeTask?: () => void
  autoOpenAddCloudDeviceDialog?: boolean
  services?: WorkbenchServices
  devices?: RuntimeDeviceInfo[]
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: () => Promise<void>
}

export function ConnectionsSettingsPage({
  onBack,
  backLabel,
  onLeaveToRuntimeTask,
  services,
  devices = [],
  onOpenRuntimeTask,
  onRefreshWorkLists,
}: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  useDesktopSidebarToggleRequest(() => setSidebarCollapsed(!sidebarCollapsed))
  const usesOverlayTitlebar = isGatewayRuntime()
  const kcoderGatewayPage = isKCoderGatewayPage()
  const entries = availableSettings('desktop', kcoderGatewayPage, usesOverlayTitlebar)
  const path = useSettingsPathname()
  const active = desktopSettingsFromPath(path, entries)
  const activeNav = active.key
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const pageActive = useRetainedPageActive()
  const pageSurface = usePageSurfaceTransition<HTMLElement>(activeNav)
  useEffect(() => {
    if (!directoryOpen) return
    const close = () => setDirectoryOpen(false)
    window.addEventListener('popstate', close)
    return () => window.removeEventListener('popstate', close)
  }, [directoryOpen])
  useEffect(() => {
    pageSurface.current?.scrollTo?.({ top: 0 })
  }, [activeNav, pageSurface])

  const choose = (item: SettingsItem) => {
    setDirectoryOpen(false)
    navigateTo(item.key === 'general' ? '/settings' : settingsPath(item))
  }

  return (
    <div
      data-testid="studio-settings-page"
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden text-text-primary max-md:flex-col',
        background.imagePath && (background.inMain || background.inSidebar || background.inTopBar)
          ? 'bg-transparent'
          : 'bg-background'
      )}
    >
      <aside
        data-testid="settings-sidebar"
        aria-hidden={sidebarCollapsed}
        inert={sidebarCollapsed}
        className={cn(
          'relative flex min-h-0 min-w-0 shrink-0 flex-col border-r border-border/70 px-1.5 pb-4 transition-[width,opacity] duration-200 ease-out max-md:hidden shadow-[inset_-1px_0_0_rgb(var(--color-border))]',
          sidebarCollapsed && 'pointer-events-none overflow-hidden border-r-0 px-0 opacity-0',
          background.imagePath && background.inSidebar
            ? 'bg-background/25'
            : 'bg-[rgb(var(--color-sidebar))] backdrop-blur-xl backdrop-saturate-150'
        )}
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      >
        <DesktopTopBar
          testId="settings-sidebar-topbar"
          className={cn(
            '-mx-1.5 mb-1 w-[calc(100%+0.75rem)] shrink-0 bg-transparent pr-2 pl-2',
            usesOverlayTitlebar && 'h-[76px] pt-6'
          )}
          left={
            <button
              type="button"
              data-testid="settings-back-button"
              onClick={onBack}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary transition-colors hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ArrowLeft className="h-4 w-4" />
              {backLabel ?? t('workbench.settings_back_to_app', '返回')}
            </button>
          }
        />

        <SettingsDirectory entries={entries} current={activeNav} onChoose={choose} />

        <button
          type="button"
          data-testid="settings-sidebar-resize-handle"
          disabled={sidebarCollapsed}
          onPointerDown={handleResizeStart}
          className="absolute right-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
          aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
        />
      </aside>

      <header
        className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 md:hidden"
        data-testid="settings-compact-navigation"
      >
        <Button
          variant="ghost"
          size="icon"
          data-testid="settings-compact-back"
          onClick={onBack}
          aria-label={backLabel ?? t('workbench.settings_back_to_app')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <button
          type="button"
          data-testid="settings-compact-directory"
          aria-haspopup="dialog"
          aria-expanded={directoryOpen}
          onClick={() => setDirectoryOpen(true)}
          className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-sm focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="truncate">{t(active.label)}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      </header>
      {directoryOpen && (
        <ModalDialog
          title={t('workbench.settings')}
          testId="settings-directory-dialog"
          hidden={!pageActive}
          closeLabel={t('common.close')}
          onClose={() => setDirectoryOpen(false)}
          className="flex max-h-[min(80dvh,42rem)] flex-col gap-3 overflow-hidden"
        >
          <SettingsDirectory entries={entries} current={activeNav} onChoose={choose} mobile />
        </ModalDialog>
      )}
      {usesOverlayTitlebar && (
        <div
          data-testid="settings-main-titlebar-drag-region"
          className="absolute right-0 top-0 z-titlebar h-[52px] max-md:hidden"
          style={{ left: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <MacOSTitleBarDragRegion className="h-full w-full" />
        </div>
      )}

      <main
        ref={pageSurface}
        className={cn(
          'studio-page-gutter min-h-0 min-w-0 flex-1 overflow-auto pb-8 max-md:pt-4',
          background.imagePath && background.inMain ? 'bg-background/20' : 'bg-background',
          usesOverlayTitlebar ? 'pt-16' : 'pt-8'
        )}
      >
        <div className="mx-auto mb-2 flex w-full max-w-[var(--studio-page-column-width)] items-center justify-between gap-2">
          {sidebarCollapsed ? (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={directoryOpen}
              onClick={() => setDirectoryOpen(true)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-text-secondary hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus max-md:hidden"
            >
              {t('workbench.settings')} <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <span className="text-xs font-medium text-text-muted">
              {t(`workbench.settings_groups.${active.group}`)}
            </span>
          )}
          <ReturnToConversationButton />
        </div>
        {activeNav === 'general' ? (
          <GeneralSettingsPage />
        ) : activeNav === 'appearance' ? (
          <AppearanceSettingsPage />
        ) : activeNav === 'usage' && kcoderGatewayPage ? (
          <UsageSettingsPage />
        ) : activeNav === 'context' ? (
          <ContextSettingsPage devices={devices} />
        ) : activeNav === 'self-evolution' ? (
          <SelfEvolutionSettingsPage />
        ) : activeNav === 'about' ? (
          <AboutSettingsPage />
        ) : activeNav === 'storage' && kcoderGatewayPage ? (
          <StorageSettingsPage />
        ) : activeNav === 'model-settings' ? (
          kcoderGatewayPage ? (
            <KCoderProviderSettingsPage />
          ) : (
            <ModelSettingsPage />
          )
        ) : activeNav === 'proxy' ? (
          <ProxySettingsPage />
        ) : activeNav === 'kcoder-servers' ? (
          <KCoderServersSettingsPage />
        ) : activeNav === 'access-links' && kcoderGatewayPage ? (
          <BrowserAccessSettingsPage />
        ) : activeNav === 'ssh-connections' && kcoderGatewayPage ? (
          <SshConnectionsSettingsPage />
        ) : activeNav === 'tools' ? (
          <ToolSelectionsSettingsPage />
        ) : activeNav === 'execution-defaults' ? (
          <ExecutionDefaultsSettingsPage />
        ) : activeNav === 'keyboard-shortcuts' ? (
          <KeyboardShortcutsSettingsPage />
        ) : activeNav === 'quick-phrases' ? (
          <QuickPhrasesSettingsPage />
        ) : activeNav === 'appshots' ? (
          <AppshotsSettingsPage />
        ) : activeNav === 'plugins' ? (
          <PluginSettingsPage />
        ) : activeNav === 'browser' ? (
          <BrowserSettingsPage />
        ) : activeNav === 'worktrees' ? (
          <WorktreesSettingsPage
            api={services?.runtimeWorkApi}
            devices={devices}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={onRefreshWorkLists}
            onLeaveSettings={onLeaveToRuntimeTask ?? onBack}
          />
        ) : activeNav === 'hooks' ? (
          <HooksSettingsPage />
        ) : activeNav === 'archived-conversations' ? (
          <ArchivedConversationsSettingsPage
            api={services?.runtimeWorkApi}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={onRefreshWorkLists}
            onLeaveSettings={onLeaveToRuntimeTask ?? onBack}
          />
        ) : (
          <GeneralSettingsPage />
        )}
      </main>
    </div>
  )
}
