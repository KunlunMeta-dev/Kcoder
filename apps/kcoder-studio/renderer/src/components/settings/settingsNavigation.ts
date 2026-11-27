import {
  AppWindow,
  Archive,
  Blocks,
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
  SquareTerminal,
  Terminal,
  TrendingUp,
  Webhook,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { stripAppBasePath } from '@/config/runtime'

export const settingsGroups = ['workspace', 'conversation', 'connections', 'tools', 'data'] as const
type SettingsGroupId = (typeof settingsGroups)[number]

interface SettingsEntry {
  key: string
  group: SettingsGroupId
  icon: LucideIcon
  label: string
  searchKeys?: readonly string[]
  route?: string
  requires?: 'gateway' | 'standalone' | 'titlebar'
  layout?: 'desktop' | 'mobile'
}

const settingsDirectory = [
  {
    key: 'general',
    group: 'workspace',
    icon: SlidersHorizontal,
    label: 'workbench.settings_nav_general',
    searchKeys: [
      'workbench.general_settings_language_preference',
      'profile.avatar',
      'workbench.work_mode.inline_widgets',
      'workbench.general_settings_experimental_features',
      'workbench.general_sections.data',
    ],
  },
  {
    key: 'appearance',
    group: 'workspace',
    icon: Palette,
    label: 'workbench.settings_nav_appearance',
    searchKeys: [
      'workbench.appearance_fonts',
      'workbench.appearance_ui_font_size',
      'workbench.appearance_code_font_size',
      'workbench.appearance_background',
    ],
  },
  {
    key: 'keyboard-shortcuts',
    group: 'workspace',
    icon: Keyboard,
    label: 'workbench.settings_nav_keyboard_shortcuts',
    route: '/settings/personal/keyboard-shortcuts',
    layout: 'desktop',
  },
  {
    key: 'quick-phrases',
    group: 'workspace',
    icon: MessageSquareText,
    label: 'workbench.settings_nav_quick_phrases',
    route: '/settings/personal/quick-phrases',
  },
  {
    key: 'model-settings',
    group: 'conversation',
    icon: Cpu,
    label: 'workbench.settings_nav_model_settings',
    route: '/settings/personal/models',
  },
  {
    key: 'context',
    group: 'conversation',
    icon: SquareTerminal,
    label: 'workbench.settings_nav_context',
    route: '/settings/personal/context',
  },
  {
    key: 'self-evolution',
    group: 'conversation',
    icon: TrendingUp,
    label: 'workbench.settings_nav_self_evolution',
    route: '/settings/personal/self-evolution',
    searchKeys: [
      'workbench.settings_search_self_evolution.evolution',
      'workbench.settings_search_self_evolution.learning',
      'workbench.settings_search_self_evolution.skills',
      'workbench.settings_search_self_evolution.preferences',
      'workbench.settings_search_self_evolution.feedback',
      'workbench.settings_search_self_evolution.rating',
    ],
  },
  {
    key: 'execution-defaults',
    group: 'conversation',
    icon: ShieldCheck,
    label: 'workbench.settings_nav_execution_defaults',
    requires: 'gateway',
    layout: 'desktop',
  },
  {
    key: 'usage',
    group: 'conversation',
    icon: ChartNoAxesColumn,
    label: 'workbench.settings_nav_usage',
    requires: 'gateway',
  },
  {
    key: 'kcoder-servers',
    group: 'connections',
    icon: Server,
    label: 'workbench.settings_nav_kcoder_servers',
    requires: 'gateway',
    layout: 'desktop',
  },
  {
    key: 'ssh-connections',
    group: 'connections',
    icon: Terminal,
    label: 'workbench.settings_nav_ssh_connections',
    requires: 'gateway',
    layout: 'desktop',
  },
  {
    key: 'access-links',
    group: 'connections',
    icon: QrCode,
    label: 'workbench.settings_nav_access_links',
    requires: 'gateway',
  },
  {
    key: 'channels',
    group: 'connections',
    icon: MessageSquareText,
    label: 'workbench.settings_nav_channels',
    requires: 'gateway',
    layout: 'mobile',
    route: '/settings/channels',
  },
  {
    key: 'proxy',
    group: 'connections',
    icon: Network,
    label: 'workbench.settings_nav_proxy',
    route: '/settings/personal/proxy',
    requires: 'standalone',
    layout: 'desktop',
  },
  {
    key: 'tools',
    group: 'tools',
    icon: Wrench,
    label: 'tool_selections.title',
    requires: 'gateway',
  },
  {
    key: 'browser',
    group: 'tools',
    icon: AppWindow,
    label: 'workbench.settings_nav_browser',
    layout: 'desktop',
  },
  { key: 'worktrees', group: 'tools', icon: FolderGit2, label: 'workbench.settings_nav_worktrees' },
  {
    key: 'hooks',
    group: 'tools',
    icon: Webhook,
    label: 'workbench.settings_nav_hooks',
    layout: 'desktop',
  },
  {
    key: 'appshots',
    group: 'tools',
    icon: ScanLine,
    label: 'workbench.settings_nav_appshots',
    requires: 'titlebar',
    layout: 'desktop',
  },
  {
    key: 'plugins',
    group: 'tools',
    icon: Package,
    label: 'workbench.settings_nav_plugin_configuration',
    requires: 'standalone',
  },
  {
    key: 'plugin-library',
    group: 'tools',
    icon: Blocks,
    label: 'workbench.settings_nav_plugin_library',
    requires: 'standalone',
    layout: 'mobile',
    route: '/plugins',
  },
  {
    key: 'archived-conversations',
    group: 'data',
    icon: Archive,
    label: 'workbench.settings_nav_archived_conversations',
  },
  {
    key: 'storage',
    group: 'data',
    icon: HardDrive,
    label: 'workbench.settings_nav_storage',
    requires: 'gateway',
    layout: 'desktop',
  },
  { key: 'about', group: 'data', icon: Info, label: 'workbench.settings_nav_about' },
] as const satisfies readonly SettingsEntry[]

export type SettingsKey = (typeof settingsDirectory)[number]['key']
export type SettingsItem = SettingsEntry & { key: SettingsKey }

export function availableSettings(
  layout: 'desktop' | 'mobile',
  gateway: boolean,
  titlebar: boolean
): SettingsItem[] {
  const entries: readonly SettingsItem[] = settingsDirectory
  return entries.filter(
    item =>
      (!item.layout || item.layout === layout) &&
      (!item.requires ||
        (item.requires === 'gateway' && gateway) ||
        (item.requires === 'standalone' && !gateway) ||
        (item.requires === 'titlebar' && titlebar))
  )
}

export function settingsPath(item: SettingsItem) {
  return item.route ?? `/settings/${item.key}`
}

const aliases: Record<string, SettingsKey> = {
  '/settings/personal': 'model-settings',
  '/settings/browser-access': 'access-links',
}

export function settingsFromPath(path: string, entries: SettingsItem[]) {
  const route = stripAppBasePath(path).replace(/\/+$/, '')
  return entries.find(
    item =>
      settingsPath(item) === route ||
      route === `/settings/${item.key}` ||
      item.key === aliases[route]
  )
}

function subscribeToPath(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

export function useSettingsSearch() {
  return useSyncExternalStore(subscribeToPath, () => window.location.search)
}

export function useSettingsPathname() {
  return useSyncExternalStore(subscribeToPath, () => window.location.pathname)
}

/** Some bookmarked desktop pages render their own unsupported-host explanation. */
export function desktopSettingsFromPath(path: string, entries: SettingsItem[]) {
  const selected = settingsFromPath(path, entries)
  if (selected) return selected
  return (
    settingsFromPath(
      path,
      settingsDirectory.filter(
        item =>
          item.key === 'execution-defaults' ||
          item.key === 'tools' ||
          item.key === 'appshots' ||
          item.key === 'kcoder-servers'
      )
    ) ?? entries[0]
  )
}
