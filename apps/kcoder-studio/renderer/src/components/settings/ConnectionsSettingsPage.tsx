import { ToolSelectionsSettingsPage } from './ToolSelectionsSettingsPage'
import { ChannelsSettingsPage } from '@/features/connectivity/ChannelsSettingsPage'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { useResizableSidebar } from '@/components/layout/useResizableSidebar'
import {
  useDesktopSidebarCollapsed,
  useDesktopSidebarToggleRequest,
} from '@/components/layout/useDesktopSidebarCollapsed'
import { Button } from '@/components/ui/button'
import { stripAppBasePath } from '@/config/runtime'
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
import {
  AppWindow,
  Archive,
  ArrowLeft,
  ChartNoAxesColumn,
  Cpu,
  FolderGit2,
  HardDrive,
  Info,
  Keyboard,
  MessageSquareText,
  Network,
  Package,
  Palette,
  QrCode,
  ScanLine,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Webhook,
} from 'lucide-react'
import type { ComponentType } from 'react'
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
import { IconSelect } from './settings-ui'
import { SshConnectionsSettingsPage } from './SshConnectionsSettingsPage'
import { StorageSettingsPage } from './StorageSettingsPage'
import { UsageSettingsPage } from './UsageSettingsPage'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'

interface ConnectionsSettingsPageProps {
  onBack: () => void
  onLeaveToRuntimeTask?: () => void
  autoOpenAddCloudDeviceDialog?: boolean
  services?: WorkbenchServices
  devices?: RuntimeDeviceInfo[]
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: () => Promise<void>
}

type SettingsCategory = 'personal' | 'integrations' | 'coding' | 'archived'

interface SettingsNavItem {
  key: string
  icon: ComponentType<{ className?: string }>
  label: string
  fallback: string
  category?: SettingsCategory
}

const settingsNavItems: SettingsNavItem[] = [
  {
    key: 'usage',
    icon: ChartNoAxesColumn,
    label: 'settings_nav_usage',
    fallback: '用量',
    category: 'personal',
  },
  {
    key: 'general',
    icon: SlidersHorizontal,
    label: 'settings_nav_general',
    fallback: '通用',
    category: 'personal',
  },

  {
    key: 'kcoder-servers',
    icon: Server,
    label: 'settings_nav_kcoder_servers',
    fallback: '运行目标',
    category: 'personal',
  },
  {
    key: 'access-links',
    icon: QrCode,
    label: 'settings_nav_access_links',
    fallback: '访问链接',
    category: 'personal',
  },
  {
    key: 'ssh-connections',
    icon: Terminal,
    label: 'settings_nav_ssh_connections',
    fallback: 'SSH 连接',
    category: 'personal',
  },
  {
    key: 'appearance',
    icon: Palette,
    label: 'settings_nav_appearance',
    fallback: '外观',
    category: 'personal',
  },
  {
    key: 'context',
    icon: Terminal,
    label: 'settings_nav_context',
    fallback: '上下文',
    category: 'personal',
  },
  {
    key: 'model-settings',
    icon: Cpu,
    label: 'settings_nav_model_settings',
    fallback: '模型',
    category: 'personal',
  },
  {
    key: 'proxy',
    icon: Network,
    label: 'settings_nav_proxy',
    fallback: '代理',
    category: 'personal',
  },
  {
    key: 'keyboard-shortcuts',
    icon: Keyboard,
    label: 'settings_nav_keyboard_shortcuts',
    fallback: '快捷键',
    category: 'personal',
  },
  {
    key: 'quick-phrases',
    icon: MessageSquareText,
    label: 'settings_nav_quick_phrases',
    fallback: '快捷短语',
    category: 'personal',
  },
  {
    key: 'about',
    icon: Info,
    label: 'settings_nav_about',
    fallback: '关于',
    category: 'personal',
  },
  {
    key: 'storage',
    icon: HardDrive,
    label: 'settings_nav_storage',
    fallback: '存储与诊断',
    category: 'personal',
  },
  {
    key: 'appshots',
    icon: ScanLine,
    label: 'settings_nav_appshots',
    fallback: '应用快照',
    category: 'integrations',
  },
  {
    key: 'plugins',
    icon: Package,
    label: 'settings_nav_plugins',
    fallback: '插件',
    category: 'integrations',
  },
  {
    key: 'browser',
    icon: AppWindow,
    label: 'settings_nav_browser',
    fallback: '浏览器',
    category: 'integrations',
  },
  {
    key: 'channels',
    icon: MessageSquareText,
    label: 'settings_nav_channels',
    fallback: '通讯渠道',
    category: 'integrations',
  },
  {
    key: 'tools',
    icon: SlidersHorizontal,
    label: 'settings_nav_tools',
    fallback: '工具',
    category: 'coding',
  },
  {
    key: 'worktrees',
    icon: FolderGit2,
    label: 'settings_nav_worktrees',
    fallback: '工作树',
    category: 'coding',
  },
  {
    key: 'execution-defaults',
    icon: ShieldCheck,
    label: 'settings_nav_execution_defaults',
    fallback: '新会话默认值',
    category: 'coding',
  },
  {
    key: 'hooks',
    icon: Webhook,
    label: 'settings_nav_hooks',
    fallback: 'Hooks',
    category: 'coding',
  },
  {
    key: 'archived-conversations',
    icon: Archive,
    label: 'settings_nav_archived_conversations',
    fallback: '已归档对话',
    category: 'archived',
  },
]

const settingsCategoryLabels: Record<SettingsCategory, { label: string; fallback: string }> = {
  personal: {
    label: 'settings_category_personal',
    fallback: '个人',
  },
  integrations: {
    label: 'settings_category_integrations',
    fallback: '集成',
  },
  coding: {
    label: 'settings_category_coding',
    fallback: '编码',
  },
  archived: {
    label: 'settings_category_archived',
    fallback: '已归档',
  },
}

function getSettingsNavFromPath(path: string): string {
  const normalizedPath = stripAppBasePath(path)
  if (normalizedPath === '/settings') return 'general'
  if (normalizedPath === '/settings/personal') return 'model-settings'
  if (
    normalizedPath === '/settings/mobile-connection' ||
    normalizedPath === '/settings/browser-access'
  )
    return 'access-links'
  const matchedItem = settingsNavItems.find(item => getSettingsNavPath(item.key) === normalizedPath)
  if (matchedItem) return matchedItem.key
  const match = normalizedPath.match(/^\/settings\/([^/]+)$/)
  if (!match) return 'general'
  return settingsNavItems.some(item => item.key === match[1]) ? match[1] : 'general'
}

function getSettingsNavPath(key: string): string {
  if (key === 'context') return '/settings/personal/context'
  if (key === 'model-settings') return '/settings/personal/models'
  if (key === 'proxy') return '/settings/personal/proxy'
  if (key === 'keyboard-shortcuts') return '/settings/personal/keyboard-shortcuts'
  if (key === 'quick-phrases') return '/settings/personal/quick-phrases'
  if (key === 'general') return '/settings'
  return `/settings/${key}`
}

export function ConnectionsSettingsPage({
  onBack,
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
  const visibleSettingsNavItems = settingsNavItems.filter(item => {
    if (item.key === 'usage') return kcoderGatewayPage
    if (item.key === 'tools') return kcoderGatewayPage
    if (item.key === 'channels') return false
    if (item.key === 'execution-defaults') return kcoderGatewayPage
    if (
      item.key === 'kcoder-servers' ||
      item.key === 'access-links' ||
      item.key === 'ssh-connections'
    )
      return kcoderGatewayPage
    if (item.key === 'proxy' || item.key === 'plugins') {
      return !kcoderGatewayPage
    }
    return item.key !== 'appshots' || usesOverlayTitlebar
  })
  const [activeNav, setActiveNav] = useState(() => {
    const requested = getSettingsNavFromPath(window.location.pathname)
    if (!kcoderGatewayPage && (requested === 'ssh-connections' || requested === 'access-links'))
      return 'general'
    return kcoderGatewayPage && (requested === 'proxy' || requested === 'plugins')
      ? 'general'
      : requested
  })

  useEffect(() => {
    const handlePopState = () => {
      const requested = getSettingsNavFromPath(window.location.pathname)
      if (!kcoderGatewayPage && (requested === 'ssh-connections' || requested === 'access-links')) {
        setActiveNav('general')
        return
      }
      setActiveNav(
        kcoderGatewayPage && (requested === 'proxy' || requested === 'plugins')
          ? 'general'
          : requested
      )
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [kcoderGatewayPage])

  return (
    <div
      data-testid="studio-settings-page"
      className={cn(
        'relative flex h-screen min-w-0 flex-1 overflow-hidden text-text-primary max-md:flex-col',
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
          'relative flex min-w-0 shrink-0 flex-col border-r border-border/70 px-1.5 pb-4 transition-[width,opacity] duration-200 ease-out max-md:hidden shadow-[inset_-1px_0_0_rgb(var(--color-border))]',
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
              {t('workbench.settings_back_to_app', '返回')}
            </button>
          }
        />

        <nav
          data-testid="settings-sidebar-nav"
          className="scrollbar-soft min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5"
        >
          {visibleSettingsNavItems.map((item, index) => {
            const showCategory =
              item.category && visibleSettingsNavItems[index - 1]?.category !== item.category
            const categoryLabel = item.category ? settingsCategoryLabels[item.category] : null
            return (
              <div key={item.key}>
                {showCategory &&
                  categoryLabel &&
                  (item.category === 'archived' ? (
                    <button
                      type="button"
                      data-testid="settings-category-archived"
                      onClick={() => {
                        setActiveNav(item.key)
                        navigateTo(getSettingsNavPath(item.key))
                      }}
                      className="mb-1 mt-5 flex min-h-[30px] w-full items-center rounded-lg px-2.5 text-left text-xs font-medium text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {t(`workbench.${categoryLabel.label}`, categoryLabel.fallback)}
                    </button>
                  ) : (
                    <div
                      data-testid={`settings-category-${item.category}`}
                      className="mb-1 mt-5 px-2.5 text-xs font-medium text-text-muted"
                    >
                      {t(`workbench.${categoryLabel.label}`, categoryLabel.fallback)}
                    </div>
                  ))}
                <button
                  type="button"
                  data-testid={`settings-nav-${item.key}`}
                  aria-current={activeNav === item.key ? 'page' : undefined}
                  onClick={() => {
                    setActiveNav(item.key)
                    navigateTo(getSettingsNavPath(item.key))
                  }}
                  className={[
                    'flex min-h-[30px] w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                    activeNav === item.key
                      ? 'bg-[rgb(var(--color-sidebar-active))] font-medium text-text-primary'
                      : 'text-text-secondary hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-text-primary',
                  ].join(' ')}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {item.key === 'tools'
                      ? t('tool_selections.title')
                      : t(`workbench.${item.label}`, item.fallback)}
                  </span>
                </button>
              </div>
            )
          })}
        </nav>

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
          aria-label={t('workbench.settings_back_to_app')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <IconSelect
            data-testid="settings-compact-select"
            icon={<SlidersHorizontal className="h-4 w-4" />}
            aria-label={t('workbench.settings')}
            value={activeNav}
            onChange={event => {
              setActiveNav(event.target.value)
              navigateTo(getSettingsNavPath(event.target.value))
            }}
          >
            {visibleSettingsNavItems.map(item => (
              <option key={item.key} value={item.key}>
                {item.key === 'tools'
                  ? t('tool_selections.title')
                  : t(`workbench.${item.label}`, item.fallback)}
              </option>
            ))}
          </IconSelect>
        </div>
      </header>
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
        className={cn(
          'studio-page-gutter min-h-0 min-w-0 flex-1 overflow-auto pb-8 max-md:pt-4',
          background.imagePath && background.inMain ? 'bg-background/20' : 'bg-background',
          usesOverlayTitlebar ? 'pt-16' : 'pt-8'
        )}
      >
        {activeNav === 'general' ? (
          <GeneralSettingsPage />
        ) : activeNav === 'appearance' ? (
          <AppearanceSettingsPage />
        ) : activeNav === 'usage' && kcoderGatewayPage ? (
          <UsageSettingsPage />
        ) : activeNav === 'context' ? (
          <ContextSettingsPage devices={devices} />
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
        ) : activeNav === 'channels' && kcoderGatewayPage ? (
          <ChannelsSettingsPage />
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
