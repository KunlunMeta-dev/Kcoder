import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { createRandomUuid } from '@/lib/random-id'
import { PluginInstallCancelledError } from './plugin-errors'
import { PluginTrustManager } from './PluginTrustManager'
import { DeviceFolderPicker } from '@/components/projects/DeviceFolderPicker'
import type { DeviceInfo } from '@/types/api'
import { Checkbox } from '@/components/ui/checkbox'
import { PluginIcon, type PluginIconLoader } from './PluginIcon'
import './plugin-marketplace.css'
import { InputWithIcon } from '@/components/settings/settings-ui'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Boxes,
  Network,
  Check,
  ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { useIsMobile } from '@/hooks/useIsMobile'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createMcpApi } from '@/api/mcps'
import { createPluginApi } from '@/api/plugins'
import { createSystemSkillApi } from '@/api/systemSkills'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import type {
  InstalledSkill,
  InstalledPlugin,
  InstalledMCPServerConfig,
  MCPProviderInfo,
  MCPServer,
  PersonalSkill,
  PluginMarketplaceItem,
  SystemSkillCatalogItem,
  SystemSkillProviderError,
} from '@/types/api'
import type { LocalCodexMarketplace } from '@/api/local/codexPlugins'
import { type InstalledPluginItem } from './PluginManagementRows'
import { ConfirmUninstallDialog, type CatalogItem } from './PluginCatalogSections'
import { classifyPluginFailure } from './plugin-errors'
import { CustomMcpDialog, type CustomMcpFormState } from './McpManagementSections'
import { parseOptionalStringRecordJson } from './mcp-json-import'
import { PluginCreateMenu } from './PluginCreateMenu'
import { PluginDetailView } from './PluginDetailView'
import { PluginUploadDialog } from './PluginUploadDialog'
import { SkillUploadDialog } from './SkillUploadDialog'
import { resolvePluginAssetUrl } from './plugin-assets'

type CatalogTab = 'mcp' | 'skills' | 'plugins'
type MarketplaceKind = 'local' | 'cloud'

interface MarketplaceOption {
  key: string
  id: string
  name: string
  kind: MarketplaceKind
  path?: string
}

interface MarketplaceFormState {
  trustSourceDirectory?: boolean
  proxyUrl?: string
  id?: string
  path: string
}

function isUserManagedMarketplace(marketplace: MarketplaceOption): boolean {
  return marketplace.kind === 'local' && marketplace.id !== 'openai-curated-remote'
}

interface PendingMarketplaceDelete {
  id: string
  name: string
}

interface PendingMcpUninstall {
  provider: MCPProviderInfo
  server: MCPServer
}

interface SystemSkillState {
  items: CatalogItem[]
  providerErrors: SystemSkillProviderError[]
  total: number
  page: number
  pageSize: number
  isLoading: boolean
  error: string | null
}

interface PersonalSkillState {
  items: CatalogItem[]
  isLoading: boolean
  error: string | null
}

interface McpMarketplaceState {
  providers: MCPProviderInfo[]
  providerServers: Record<string, MCPServer[]>
  providerErrors: Record<string, string>
  providerLoadingByKey: Record<string, boolean>
  isLoading: boolean
  error: string | null
}

interface PluginMarketplaceState {
  items: PluginMarketplaceItem[]
  isLoading: boolean
  error: string | null
}

const SYSTEM_SKILL_PAGE_SIZE = 20
const MARKETPLACE_SECTION_COLLAPSED_COUNT = 6
const emptyCustomMcpForm: CustomMcpFormState = {
  name: '',
  displayName: '',
  description: '',
  type: 'streamable-http',
  url: '',
  command: '',
  args: '',
  envJson: '',
  headersJson: '',
}

const skillIconByName: Record<string, Pick<CatalogItem, 'icon' | 'iconClassName'>> = {
  'image-gen': {
    icon: ImageIcon,
    iconClassName: 'bg-sky-100 text-sky-600',
  },
  'openai-docs': {
    icon: BookOpen,
    iconClassName: 'bg-orange-50 text-orange-500',
  },
}

function getSkillIcon(item: SystemSkillCatalogItem): Pick<CatalogItem, 'icon' | 'iconClassName'> {
  if (skillIconByName[item.name]) {
    return skillIconByName[item.name]
  }
  if (item.tags.includes('docs')) {
    return {
      icon: BookOpen,
      iconClassName: 'bg-orange-50 text-orange-500',
    }
  }
  if (
    item.tags.includes('image') ||
    item.capabilities.some(capability => capability.includes('image'))
  ) {
    return {
      icon: ImageIcon,
      iconClassName: 'bg-sky-100 text-sky-600',
    }
  }
  return {
    icon: Sparkles,
    iconClassName: 'bg-indigo-50 text-indigo-500',
  }
}

function toCatalogItem(item: SystemSkillCatalogItem): CatalogItem {
  const icon = getSkillIcon(item)
  return {
    id: item.id,
    providerKey: item.providerKey,
    skillKey: item.name,
    catalogItemId: item.id,
    installedSkillId: item.installedSkillId,
    name: item.displayName || item.name,
    description: item.description,
    version: item.version,
    author: item.author,
    tags: item.tags,
    section: 'system',
    icon: icon.icon,
    iconClassName: icon.iconClassName,
    installState: item.installState,
    enabled: item.enabled,
    sourceType: 'system',
  }
}

function getPersonalSkillId(item: PersonalSkill): number | null {
  const labels = item.metadata.labels
  const id = labels && typeof labels === 'object' ? labels.id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getInstalledSkillKey(item: InstalledSkill): string {
  return item.spec.skillRef?.name || item.spec.source.skillKey
}

function toPersonalCatalogItem(
  item: PersonalSkill,
  installedBySkillKey: Map<string, InstalledSkill> = new Map()
): CatalogItem {
  const installed = installedBySkillKey.get(item.metadata.name)
  return {
    id: `personal-${item.metadata.name}`,
    name: item.spec.displayName || item.metadata.name,
    description: item.spec.description,
    personalSkillId: getPersonalSkillId(item),
    installedSkillId: installed ? getInstalledSkillId(installed) : null,
    version: item.spec.version,
    author: item.spec.author,
    tags: item.spec.tags ?? [],
    section: 'personal',
    icon: Sparkles,
    iconClassName: 'bg-teal-50 text-teal-600',
    installState: installed?.spec.installState ?? 'not_installed',
    enabled: installed?.spec.enabled ?? false,
    sourceType: 'personal',
  }
}

function getInstalledSkillId(item: InstalledSkill): number | null {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function toInstalledPluginItem(item: InstalledPlugin): InstalledPluginItem {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const components = item.spec.components
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : '',
    name: item.spec.displayName || item.spec.source.pluginKey,
    description: item.spec.description,
    enabled: item.spec.enabled,
    version: item.spec.version,
    componentCounts: {
      skills: components.skills.length,
      commands: components.commands.length,
      agents: components.agents.length,
      mcp: components.mcps.length,
      hooks: components.hooks.length,
      lsp: components.lsps.length,
      monitors: components.monitors.length,
      bin: components.bins.length,
    },
    raw: item,
  }
}

function toMarketplaceInstalledPluginItem(item: PluginMarketplaceItem): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: item.name,
      namespace: 'marketplace',
      labels: { id: item.id },
    },
    spec: {
      source: {
        type: item.sourceType,
        providerKey: 'marketplace',
        pluginKey: item.name,
        catalogItemId: item.remotePluginId,
      },
      displayName: item.displayName || item.name,
      description: item.description,
      version: item.version,
      author: item.author,
      installState: item.installed ? 'installed' : 'not_installed',
      enabled: item.enabled,
      componentStates: {},
      manifest: item.manifest ?? {},
      components: item.components,
      interface: item.interface,
      packageRef: null,
      sourcePayload: null,
    },
    status: { state: item.installed ? 'enabled' : 'available' },
  }
  return toInstalledPluginItem(raw)
}

function serverConfigFromCustomForm(form: CustomMcpFormState): InstalledMCPServerConfig {
  if (form.type === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      args: form.args
        .split(/\s+/)
        .map(arg => arg.trim())
        .filter(Boolean),
      env: parseOptionalStringRecordJson(form.envJson) ?? undefined,
    }
  }

  return {
    type: form.type,
    url: form.url.trim(),
    base_url: form.url.trim(),
    headers: parseOptionalStringRecordJson(form.headersJson) ?? undefined,
  }
}

function createDefaultSystemSkillApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createSystemSkillApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDefaultMcpApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createMcpApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDefaultPluginApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createPluginApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function marketplaceSectionTitle(
  item: PluginMarketplaceItem,
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (item.featured) return t('pluginNetwork.groups.featured')
  const category =
    item.interface?.category ||
    (typeof item.manifest.category === 'string' ? item.manifest.category : '')
  if (category.trim()) return category.trim()
  if (item.visibility === 'personal') return t('pluginNetwork.groups.marketplace')
  if (item.visibility === 'workspace') return t('pluginNetwork.groups.workspace')
  return t('pluginNetwork.groups.other')
}

function tryPluginInChat(plugin: InstalledPlugin): boolean {
  const queued = queuePluginTrial(plugin)
  if (queued) navigateTo('/')
  return queued
}

function localMarketplaceKey(id: string): string {
  return `local:${id}`
}

function cloudMarketplaceKey(): string {
  return 'cloud:default'
}

function toMarketplaceOptions(
  localMarketplaces: LocalCodexMarketplace[],
  cloudAvailable: boolean,
  cloudMarketplaceLabel: string
): MarketplaceOption[] {
  const cloudOptions: MarketplaceOption[] = cloudAvailable
    ? [
        {
          key: cloudMarketplaceKey(),
          id: 'default',
          name: cloudMarketplaceLabel,
          kind: 'cloud',
        },
      ]
    : []
  return [
    ...cloudOptions,
    ...localMarketplaces.map(marketplace => ({
      key: localMarketplaceKey(marketplace.id),
      id: marketplace.id,
      name: marketplace.name,
      path: marketplace.path,
      kind: 'local' as const,
    })),
  ]
}

function InstalledPluginStrip({
  plugins,
  title,
  onManage,
  onSelect,
  iconLoader,
}: {
  plugins: InstalledPluginItem[]
  title: string
  onManage: () => void
  onSelect: (id: string | number) => void
  iconLoader?: PluginIconLoader
}) {
  const { t } = useTranslation('common')
  if (plugins.length === 0) return null
  return (
    <section className="space-y-4" data-testid="plugins-installed-strip">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <h2 className="text-lg font-medium leading-6 text-text-primary">{title}</h2>
        <button
          type="button"
          aria-label={t('workbench.plugins_manage', '管理')}
          data-testid="plugins-installed-manage-button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          onClick={onManage}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-10 items-center gap-3 overflow-x-auto pb-1 pl-0.5">
        {plugins.map(plugin => {
          const logo = resolvePluginAssetUrl(
            plugin.raw.spec.interface?.logo || plugin.raw.spec.interface?.composerIcon
          )
          return (
            <button
              key={plugin.id}
              type="button"
              data-testid={`plugins-installed-strip-item-${plugin.id}`}
              title={plugin.name}
              className="plugin-installed-shortcut"
              onClick={() => onSelect(plugin.id)}
            >
              <PluginIcon
                id={plugin.id}
                source={logo}
                darkSource={plugin.raw.spec.interface?.logoDark}
                loader={iconLoader}
                className="h-8 w-8 rounded-lg"
              />
              <span className="truncate text-sm font-medium">{plugin.name}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function PluginMarketplaceRow({
  item,
  isInstalling,
  isCancelling,
  onCancel,
  installLabel,
  installingLabel,
  tryLabel,
  uninstallLabel,
  onOpen,
  onInstall,
  onUninstall,
  iconLoader,
}: {
  iconLoader?: PluginIconLoader
  item: PluginMarketplaceItem
  isInstalling: boolean
  isCancelling?: boolean
  onCancel?: () => void
  installLabel: string
  installingLabel: string
  tryLabel: string
  uninstallLabel: string
  onOpen: () => void
  onInstall: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const logo = resolvePluginAssetUrl(item.interface?.logo || item.interface?.composerIcon)
  return (
    <article
      role="button"
      tabIndex={0}
      data-testid={`plugin-marketplace-row-${item.id}`}
      className="plugin-marketplace-card group"
      onClick={onOpen}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface text-text-secondary shadow-sm"
        style={{
          backgroundColor: item.interface?.brandColor || undefined,
          color: item.interface?.brandColor ? 'rgb(var(--color-bg-base))' : undefined,
        }}
      >
        <PluginIcon
          id={item.id}
          source={logo}
          darkSource={item.interface?.logoDark}
          loader={iconLoader}
        />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-base font-semibold leading-5 text-text-primary">
            {item.displayName || item.name}
          </h3>
          {item.version && (
            <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-xs font-normal leading-4 text-text-muted">
              {item.version}
            </span>
          )}
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-5 text-text-secondary">
          {item.interface?.shortDescription || item.description}
        </p>
      </div>
      <div className="plugin-card-actions flex items-center justify-end gap-1.5">
        <button
          type="button"
          data-testid={`plugin-marketplace-install-${item.id}`}
          disabled={
            (isInstalling && (!onCancel || isCancelling)) ||
            (!item.installed && item.installable === false)
          }
          title={item.installable === false ? t('pluginNetwork.unavailable') : undefined}
          className={[
            'flex h-8 min-w-[58px] items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            item.installed
              ? 'border-border bg-background text-text-primary hover:bg-surface'
              : 'border-transparent bg-text-primary text-background hover:bg-text-primary/90',
            isInstalling ? 'cursor-wait opacity-70' : '',
          ].join(' ')}
          onClick={event => {
            event.stopPropagation()
            if (isInstalling && onCancel) onCancel()
            else onInstall()
          }}
        >
          {!item.installed && item.installable === false ? (
            t('pluginNetwork.unavailable')
          ) : isInstalling ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
              {isCancelling
                ? t('pluginNetwork.cancellingInstall')
                : onCancel
                  ? t('pluginNetwork.cancelInstall')
                  : installingLabel}
            </>
          ) : item.installed ? (
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4 text-text-muted" />
              {tryLabel}
            </span>
          ) : (
            installLabel
          )}
        </button>
        {item.installed && (
          <div className="relative">
            <button
              type="button"
              data-testid={`plugin-marketplace-actions-${item.id}`}
              aria-label={`${item.displayName || item.name} · ${t('workbench.plugins_actions', '插件操作')}`}
              aria-expanded={isActionMenuOpen}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-background hover:text-text-primary"
              onClick={event => {
                event.stopPropagation()
                setIsActionMenuOpen(open => !open)
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {isActionMenuOpen && (
              <div
                data-testid={`plugin-marketplace-actions-menu-${item.id}`}
                className="absolute right-0 top-9 z-30 w-28 rounded-xl border border-border bg-background p-1 shadow-xl"
                onClick={event => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid={`plugin-marketplace-uninstall-${item.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-red-600 transition-colors hover:bg-red-50"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onUninstall()
                  }}
                >
                  {uninstallLabel}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function PluginMarketplaceWelcome({
  title,
  description,
  manageLabel,
  customAddLabel,
  onAddCustomMarketplace,
  onManage,
}: {
  title: string
  description: string
  manageLabel: string
  customAddLabel: string
  onAddCustomMarketplace: () => void
  onManage: () => void
}) {
  return (
    <div
      data-testid="plugins-no-marketplace-welcome"
      className="flex min-h-[280px] flex-col items-center justify-center gap-5 border-t border-border px-5 py-12 text-center"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-blue-600 shadow-sm">
          <Boxes className="h-5 w-5" />
        </span>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary shadow-sm">
          <Sparkles className="h-5 w-5" />
        </span>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-teal-600 shadow-sm">
          <Plus className="h-5 w-5" />
        </span>
      </div>
      <div className="max-w-[440px] space-y-2">
        <h2 className="heading-base text-text-primary">{title}</h2>
        <p className="text-sm leading-6 text-text-secondary">{description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          data-testid="plugins-add-custom-marketplace-empty-button"
          className="flex h-8 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-semibold text-background transition-colors hover:bg-text-primary/90"
          onClick={onAddCustomMarketplace}
        >
          <Plus className="h-4 w-4" />
          {customAddLabel}
        </button>
        <button
          type="button"
          data-testid="plugins-manage-empty-button"
          className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          onClick={onManage}
        >
          <Settings className="h-4 w-4" />
          {manageLabel}
        </button>
      </div>
    </div>
  )
}

function PluginMarketplaceLoadingSkeleton({ message, hint }: { message: string; hint?: string }) {
  return (
    <div
      data-testid="plugins-marketplace-loading"
      className="space-y-8 border-t border-border pt-8"
    >
      <div className="flex items-center gap-3 text-sm text-text-secondary">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-text-muted" />
        <div>
          <div className="font-medium text-text-primary">{message}</div>
          {hint && <div className="mt-1 text-xs leading-5 text-text-muted">{hint}</div>}
        </div>
      </div>
      {['Featured', 'Productivity'].map(section => (
        <section key={section} className="space-y-4">
          <div className="border-b border-border pb-3">
            <div className="h-5 w-28 animate-pulse rounded-md bg-surface" />
          </div>
          <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="grid min-h-[66px] grid-cols-[44px_minmax(0,1fr)_72px] items-center gap-3 rounded-lg px-2 py-2"
              >
                <div className="h-10 w-10 animate-pulse rounded-lg bg-surface" />
                <div className="space-y-2">
                  <div className="h-4 w-32 animate-pulse rounded-md bg-surface" />
                  <div className="h-3 w-44 max-w-full animate-pulse rounded-md bg-surface" />
                </div>
                <div className="h-8 animate-pulse rounded-xl bg-surface" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

interface PluginsWorkspaceProps {
  targetDeviceId?: string
  targetWorkspacePath?: string
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudMarketplaceAvailable?: boolean
  directoryPicker?: {
    device: DeviceInfo
    getHome: (deviceId: string) => Promise<string>
    list: (deviceId: string, path: string) => Promise<string[]>
    create: (deviceId: string, path: string) => Promise<void>
  }
}

export function PluginsWorkspace(props: PluginsWorkspaceProps) {
  const scope = usePluginTargetScope(props.targetDeviceId, props.targetWorkspacePath)
  return <ScopedPluginsWorkspace key={scope.key} {...props} isScopeCurrent={scope.isCurrent} />
}

function ScopedPluginsWorkspace({
  isScopeCurrent,
  targetDeviceId,
  targetWorkspacePath,
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudMarketplaceAvailable = true,
  directoryPicker,
}: PluginsWorkspaceProps & { isScopeCurrent: () => boolean }) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const [showTrustManager, setShowTrustManager] = useState(false)
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false)
  useEffect(() => setShowDirectoryPicker(false), [targetDeviceId])
  const [activeTab, setActiveTab] = useState<CatalogTab>('plugins')
  const [query, setQuery] = useState('')
  const [pendingUninstallItem, setPendingUninstallItem] = useState<CatalogItem | null>(null)
  const [pendingUninstallMcp, setPendingUninstallMcp] = useState<PendingMcpUninstall | null>(null)
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false)
  const [showSkillUploadDialog, setShowSkillUploadDialog] = useState(false)
  const [showPluginUploadDialog, setShowPluginUploadDialog] = useState(false)
  const [showMarketplaceManager, setShowMarketplaceManager] = useState(false)
  const [showAddMarketplaceMenu, setShowAddMarketplaceMenu] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
    string | number | null
  >(null)
  const installAttempts = useRef(
    new Map<
      string | number,
      {
        id: string
        operationKey: string
        target: string | undefined
        dispatched: boolean
        cancelRequested: boolean
        cancel: () => Promise<{ cancellationRequested: boolean }>
      }
    >()
  )
  const [cancellingInstalls, setCancellingInstalls] = useState(new Set<string | number>())
  const canCancelInstall = (id: string | number) => {
    const attempt = installAttempts.current.get(id)
    return Boolean(attempt && attempt.target === targetDeviceId)
  }
  const cancelInstall = async (id: string | number) => {
    const attempt = installAttempts.current.get(id)
    if (!attempt || attempt.target !== targetDeviceId || cancellingInstalls.has(id)) return
    attempt.cancelRequested = true
    setCancellingInstalls(previous => new Set(previous).add(id))
    if (!attempt.dispatched) return
    try {
      const result = await attempt.cancel()
      if (!result.cancellationRequested && installAttempts.current.get(id) === attempt)
        setCancellingInstalls(previous => {
          const next = new Set(previous)
          next.delete(id)
          return next
        })
    } catch {
      if (installAttempts.current.get(id) !== attempt) return
      setCancellingInstalls(previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t('pluginNetwork.cancelInstallFailed'),
      }))
    }
  }
  const [installingMarketplacePluginIds, setInstallingMarketplacePluginIds] = useState<
    Set<string | number>
  >(() => new Set())
  const [expandedMarketplaceSections, setExpandedMarketplaceSections] = useState<Set<string>>(
    () => new Set()
  )
  const [customMcpForm, setCustomMcpForm] = useState<CustomMcpFormState>(emptyCustomMcpForm)
  const [isCreatingCustomMcp, setIsCreatingCustomMcp] = useState(false)
  const [isUploadingSkill, setIsUploadingSkill] = useState(false)
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [pluginUploadError, setPluginUploadError] = useState<string | null>(null)
  const [marketplaceDiagnostics, setMarketplaceDiagnostics] = useState<string[]>([])
  const consumedRefreshTick = useRef(0)
  const [marketplaceLoadingMessage, setMarketplaceLoadingMessage] = useState('')
  const [marketplaceRefreshTick, setMarketplaceRefreshTick] = useState(0)
  const [systemSkillPage, setSystemSkillPage] = useState(1)
  const systemSkillApi = useMemo(() => createDefaultSystemSkillApi(), [])
  const mcpApi = useMemo(() => createDefaultMcpApi(), [])
  const pluginApi = useMemo(() => createDefaultPluginApi(), [])
  const localPluginApi = useMemo(
    () =>
      createLocalCodexPluginApi({
        deviceId: targetDeviceId,
        workspacePath: targetWorkspacePath,
        isScopeCurrent,
      }),
    [targetDeviceId, targetWorkspacePath, isScopeCurrent]
  )
  const initialMarketplaceLoadKeyRef = useRef<string | null>(null)
  const [isMarketplaceConfigLoading, setIsMarketplaceConfigLoading] = useState(true)
  const [marketplaces, setMarketplaces] = useState<MarketplaceOption[]>([])
  const [selectedMarketplaceKey, setSelectedMarketplaceKey] = useState('')
  const [marketplaceForm, setMarketplaceForm] = useState<MarketplaceFormState | null>(null)
  const [marketplaceConfigError, setMarketplaceConfigError] = useState<string | null>(null)
  const [isSavingMarketplace, setIsSavingMarketplace] = useState(false)
  const [pendingMarketplaceDelete, setPendingMarketplaceDelete] =
    useState<PendingMarketplaceDelete | null>(null)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>([])
  const [, setSystemSkillState] = useState<SystemSkillState>({
    items: [],
    providerErrors: [],
    total: 0,
    page: 1,
    pageSize: SYSTEM_SKILL_PAGE_SIZE,
    isLoading: true,
    error: null,
  })
  const [, setPersonalSkillState] = useState<PersonalSkillState>({
    items: [],
    isLoading: true,
    error: null,
  })
  const [, setMcpMarketplaceState] = useState<McpMarketplaceState>({
    providers: [],
    providerServers: {},
    providerErrors: {},
    providerLoadingByKey: {},
    isLoading: true,
    error: null,
  })
  const [pluginMarketplaceState, setPluginMarketplaceState] = useState<PluginMarketplaceState>({
    items: [],
    isLoading: true,
    error: null,
  })

  const selectedMarketplace = useMemo(
    () =>
      marketplaces.find(marketplace => marketplace.key === selectedMarketplaceKey) ??
      marketplaces[0] ??
      null,
    [marketplaces, selectedMarketplaceKey]
  )
  const hasMarketplace = selectedMarketplace !== null
  const selectedMarketplaceLoadKey = selectedMarketplace?.key ?? ''

  const normalizedQuery = query.trim().toLowerCase()

  const applyLocalMarketplaceState = useCallback(
    (state: Awaited<ReturnType<typeof localPluginApi.readState>>) => {
      setMarketplaceDiagnostics(state.diagnostics ?? [])
      const options = toMarketplaceOptions(
        state.marketplaces,
        cloudMarketplaceAvailable,
        t('workbench.plugins_cloud_marketplace', '云端插件市场')
      )
      setMarketplaces(options)
      setSelectedMarketplaceKey(current => {
        const selectedKey = state.selectedMarketplaceId
          ? localMarketplaceKey(state.selectedMarketplaceId)
          : ''
        if (selectedKey && options.some(marketplace => marketplace.key === selectedKey)) {
          return selectedKey
        }
        if (current && options.some(marketplace => marketplace.key === current)) {
          return current
        }
        if (cloudMarketplaceAvailable) return cloudMarketplaceKey()
        return options[0]?.key || ''
      })
    },
    [cloudMarketplaceAvailable, localPluginApi, t]
  )

  const updateCatalogItem = (itemId: string, updates: Partial<CatalogItem>) => {
    setSystemSkillState(previous => ({
      ...previous,
      items: previous.items.map(item => (item.id === itemId ? { ...item, ...updates } : item)),
    }))
  }

  const uninstallSystemSkill = async (item: CatalogItem) => {
    if (item.sourceType === 'personal') {
      if (!item.installedSkillId) return

      setPersonalSkillState(previous => ({
        ...previous,
        items: previous.items.map(skill =>
          skill.id === item.id
            ? {
                ...skill,
                installState: 'not_installed',
                installedSkillId: null,
                enabled: false,
              }
            : skill
        ),
      }))

      try {
        await systemSkillApi.uninstallInstalledSystemSkill(item.installedSkillId)
      } catch (error) {
        setPersonalSkillState(previous => ({
          ...previous,
          items: previous.items.map(skill => (skill.id === item.id ? item : skill)),
          error: error instanceof Error ? error.message : 'Failed to uninstall personal skill',
        }))
      }
      return
    }

    if (!item.installedSkillId) return

    updateCatalogItem(item.id, {
      installState: 'not_installed',
      installedSkillId: null,
      enabled: false,
    })

    try {
      await systemSkillApi.uninstallInstalledSystemSkill(item.installedSkillId)
    } catch (error) {
      updateCatalogItem(item.id, {
        installState: item.installState,
        installedSkillId: item.installedSkillId,
        enabled: item.enabled,
      })
      setSystemSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to uninstall system skill',
      }))
    }
  }

  const loadMcpProviderServers = useCallback(
    (providerKey: string) => {
      setMcpMarketplaceState(previous => ({
        ...previous,
        providerLoadingByKey: {
          ...previous.providerLoadingByKey,
          [providerKey]: true,
        },
        providerErrors: {
          ...previous.providerErrors,
          [providerKey]: '',
        },
      }))

      mcpApi
        .listProviderServers(providerKey)
        .then(response => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerServers: {
              ...previous.providerServers,
              [providerKey]: response.success ? response.servers : [],
            },
            providerErrors: {
              ...previous.providerErrors,
              [providerKey]: response.success ? '' : response.message,
            },
          }))
        })
        .catch((error: Error) => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerErrors: {
              ...previous.providerErrors,
              [providerKey]: error.message,
            },
          }))
        })
        .finally(() => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerLoadingByKey: {
              ...previous.providerLoadingByKey,
              [providerKey]: false,
            },
          }))
        })
    },
    [mcpApi]
  )

  const uninstallProviderServer = (provider: MCPProviderInfo, server: MCPServer) => {
    if (!server.installedMcpId) return

    mcpApi.uninstallInstalledMcp(server.installedMcpId).then(() => {
      setMcpMarketplaceState(previous => ({
        ...previous,
        providerServers: {
          ...previous.providerServers,
          [provider.key]: (previous.providerServers[provider.key] ?? []).map(candidate =>
            candidate.id === server.id
              ? {
                  ...candidate,
                  installState: 'not_installed',
                  installedMcpId: null,
                  enabled: false,
                }
              : candidate
          ),
        },
      }))
    })
  }

  const createCustomMcp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const displayName = customMcpForm.displayName.trim()
    const name = customMcpForm.name.trim()
    if (!name || !displayName) return

    setIsCreatingCustomMcp(true)
    mcpApi
      .createCustomMcp({
        name,
        displayName,
        description: customMcpForm.description.trim(),
        server: serverConfigFromCustomForm(customMcpForm),
        enabled: true,
      })
      .then(() => {
        setCustomMcpForm(emptyCustomMcpForm)
        setShowCustomMcpDialog(false)
      })
      .finally(() => setIsCreatingCustomMcp(false))
  }

  const uploadPersonalSkill = async (file: File, name: string) => {
    setIsUploadingSkill(true)
    try {
      const uploaded = await systemSkillApi.uploadPersonalSkill(file, name)
      const personalSkillId = getPersonalSkillId(uploaded)
      const installed = personalSkillId
        ? await systemSkillApi.installPersonalSkill(personalSkillId)
        : null
      const catalogItem = toPersonalCatalogItem(
        uploaded,
        installed ? new Map([[getInstalledSkillKey(installed), installed]]) : new Map()
      )
      setPersonalSkillState(previous => ({
        ...previous,
        items: [catalogItem, ...previous.items.filter(item => item.id !== catalogItem.id)],
        error: null,
      }))
      setShowSkillUploadDialog(false)
    } catch (error) {
      setPersonalSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to upload personal skill',
      }))
      throw error
    } finally {
      setIsUploadingSkill(false)
    }
  }

  const uploadPlugin = async (file: File) => {
    setIsUploadingPlugin(true)
    setPluginUploadError(null)
    try {
      const response = await pluginApi.publishMarketplacePlugin(file, 'workspace')
      setPluginMarketplaceState(previous => ({
        ...previous,
        items: [response.item, ...previous.items.filter(item => item.id !== response.item.id)],
        error: null,
      }))
      setActiveTab('plugins')
      setShowPluginUploadDialog(false)
    } catch (error) {
      setPluginUploadError(error instanceof Error ? error.message : 'Failed to upload plugin')
      throw error
    } finally {
      setIsUploadingPlugin(false)
    }
  }

  const togglePluginComponent = (id: string | number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return

    const previousStates = plugin.raw.spec.componentStates || {}
    const nextStates = { ...previousStates, [componentKey]: enabled }
    setInstalledPlugins(previous =>
      previous.map(item =>
        item.id === id
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: {
                  ...item.raw.spec,
                  componentStates: nextStates,
                },
              },
            }
          : item
      )
    )
    localPluginApi
      .updateInstalledPlugin(id, {
        componentStates: { [componentKey]: enabled },
      })
      .then(updated => {
        const nextItem = toInstalledPluginItem(updated)
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? nextItem : item)))
      })
      .catch(() => {
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? plugin : item)))
      })
  }

  const uninstallInstalledPlugin = (id: string | number) => {
    const plugin = installedPlugins.find(item => item.id === id)
    if (!plugin) return

    setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
    setSelectedPluginId(current => (String(current) === String(id) ? null : current))
    setPluginMarketplaceState(previous => ({
      ...previous,
      items: previous.items.map(item =>
        String(item.installedPluginId) === String(id)
          ? {
              ...item,
              installed: false,
              installedPluginId: null,
              enabled: false,
            }
          : item
      ),
    }))
    localPluginApi
      .uninstallInstalledPlugin(id)
      .then(() => notifyLocalPluginSkillsChanged())
      .catch(() => {
        setInstalledPlugins(previous => [...previous, plugin])
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(item =>
            item.installedPluginId === null && String(item.id) === String(plugin.id)
              ? {
                  ...item,
                  installed: true,
                  installedPluginId: plugin.id,
                  enabled: plugin.enabled,
                }
              : item
          ),
        }))
      })
  }

  const refreshMarketplace = () => {
    setMarketplaceRefreshTick(previous => previous + 1)
  }

  const tryLocalInstalledPluginInChat = (pluginId: string | number) => {
    localPluginApi
      .readInstalledPluginForTrial(pluginId)
      .then(plugin => {
        if (!tryPluginInChat(plugin)) {
          setPluginMarketplaceState(previous => ({
            ...previous,
            error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
          }))
        }
      })
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
      })
  }

  const installMarketplacePlugin = (item: PluginMarketplaceItem) => {
    if (!selectedMarketplace) {
      return
    }
    if (item.installed) {
      const installed =
        item.installedPluginId === null || item.installedPluginId === undefined
          ? null
          : (installedPlugins.find(
              plugin => String(plugin.id) === String(item.installedPluginId)
            ) ?? null)
      const trialPluginId = installed?.id ?? item.installedPluginId ?? item.id
      if (selectedMarketplace.kind === 'local') {
        tryLocalInstalledPluginInChat(trialPluginId)
        return
      }
      if (!tryPluginInChat((installed ?? toMarketplaceInstalledPluginItem(item)).raw)) {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
        }))
      }
      return
    }
    if (item.installable === false) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t('pluginNetwork.unavailable'),
      }))
      return
    }
    if (installAttempts.current.has(item.id) || installingMarketplacePluginIds.has(item.id)) {
      return
    }

    const cancellationApi =
      selectedMarketplace.kind === 'local' ? localPluginApi.cancelInstallAttempt : undefined
    const operationKey = JSON.stringify([
      targetDeviceId ?? null,
      targetWorkspacePath ?? null,
      selectedMarketplace.kind,
      selectedMarketplace.id,
      item.id,
      item.version ?? null,
    ])
    const attemptId = createRandomUuid()
    const attempt = cancellationApi
      ? {
          id: attemptId,
          operationKey,
          target: targetDeviceId,
          dispatched: false,
          cancelRequested: false,
          cancel: () => cancellationApi.call(localPluginApi, attemptId),
        }
      : undefined
    if (attempt) installAttempts.current.set(item.id, attempt)
    setInstallingMarketplacePluginIds(previous => new Set(previous).add(item.id))
    setPluginMarketplaceState(previous => ({
      ...previous,
      error: null,
    }))
    const request =
      selectedMarketplace.kind === 'local'
        ? localPluginApi.selectMarketplace(selectedMarketplace.id).then(() => {
            if (attempt?.cancelRequested) throw new PluginInstallCancelledError()
            if (attempt) attempt.dispatched = true
            return localPluginApi.installAvailablePlugin(
              item.id,
              attempt ? { installAttemptId: attempt.id } : undefined
            )
          })
        : pluginApi.installMarketplacePlugin(item.id).then(response => response.plugin)

    request
      .then(plugin => {
        if (!isScopeCurrent()) return
        const installed = toInstalledPluginItem(plugin)
        setInstalledPlugins(previous => [
          installed,
          ...previous.filter(plugin => plugin.id !== installed.id),
        ])
        notifyLocalPluginSkillsChanged()
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate =>
            candidate.id === item.id && candidate.version === item.version
              ? {
                  ...candidate,
                  installed: true,
                  enabled: plugin.spec.enabled,
                  installedPluginId: installed.id,
                  components: plugin.spec.components,
                  manifest: plugin.spec.manifest,
                  interface: plugin.spec.interface,
                }
              : candidate
          ),
          error: null,
        }))
      })
      .catch((error: unknown) => {
        if (!isScopeCurrent()) return
        // X4/D3: keep a stable code and phase in diagnostics, and show the user
        // an actionable sentence rather than the raw server text.
        const failure = classifyPluginFailure(error)
        console.error('[KCoder Studio plugins] install failed', {
          failureCode: failure.code,
          phase: failure.phase,
          retryable: failure.retryable,
        })
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate => (candidate.id === item.id ? item : candidate)),
          error: t(failure.messageKey, {
            defaultValue: t('workbench.plugins_error_unknown', '操作失败，详情见诊断信息。'),
          }),
        }))
      })
      .finally(() => {
        if (!isScopeCurrent()) return
        if (installAttempts.current.get(item.id) === attempt)
          installAttempts.current.delete(item.id)
        setCancellingInstalls(previous => {
          const next = new Set(previous)
          next.delete(item.id)
          return next
        })
        setInstallingMarketplacePluginIds(previous => {
          const next = new Set(previous)
          next.delete(item.id)
          return next
        })
      })
  }

  const persistMarketplace = (form: MarketplaceFormState) => {
    setMarketplaceConfigError(null)
    setIsSavingMarketplace(true)
    localPluginApi
      .upsertMarketplace(form)
      .then(state => {
        applyLocalMarketplaceState(state)
        setMarketplaceForm(null)
      })
      .catch((error: Error) => {
        setMarketplaceConfigError(error.message)
      })
      .finally(() => {
        setIsSavingMarketplace(false)
      })
  }

  const saveMarketplace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!marketplaceForm) return
    persistMarketplace(marketplaceForm)
  }

  const deleteMarketplace = () => {
    if (!pendingMarketplaceDelete) return

    const marketplace = pendingMarketplaceDelete
    setPendingMarketplaceDelete(null)
    localPluginApi
      .deleteMarketplace(marketplace.id)
      .then(state => {
        applyLocalMarketplaceState(state)
        setPluginMarketplaceState({
          items: [],
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
      })
  }

  const reorderLocalMarketplace = (id: string, direction: -1 | 1) => {
    const localMarketplaces = marketplaces.filter(isUserManagedMarketplace)
    const currentIndex = localMarketplaces.findIndex(marketplace => marketplace.id === id)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= localMarketplaces.length) return

    const nextMarketplaces = [...localMarketplaces]
    const [current] = nextMarketplaces.splice(currentIndex, 1)
    nextMarketplaces.splice(nextIndex, 0, current)

    localPluginApi
      .reorderMarketplaces(nextMarketplaces.map(marketplace => marketplace.id))
      .then(applyLocalMarketplaceState)
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
      })
  }

  useEffect(() => {
    if (activeTab !== 'skills') return

    let isCurrent = true

    setSystemSkillState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    systemSkillApi
      .listSystemSkills({
        keyword: normalizedQuery || undefined,
        page: systemSkillPage,
        pageSize: SYSTEM_SKILL_PAGE_SIZE,
        category: 'system',
      })
      .then(response => {
        if (!isCurrent) return

        setSystemSkillState({
          items: response.items.map(toCatalogItem),
          providerErrors: response.providerErrors,
          total: response.total,
          page: response.page,
          pageSize: response.pageSize,
          isLoading: false,
          error: null,
        })
      })
      .catch(error => {
        if (!isCurrent) return

        setSystemSkillState({
          items: [],
          providerErrors: [],
          total: 0,
          page: systemSkillPage,
          pageSize: SYSTEM_SKILL_PAGE_SIZE,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load system skills',
        })
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, normalizedQuery, systemSkillApi, systemSkillPage])

  useEffect(() => {
    if (activeTab !== 'skills') return

    let isCurrent = true

    setPersonalSkillState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    Promise.all([systemSkillApi.listPersonalSkills(), systemSkillApi.listInstalledSystemSkills()])
      .then(([personalResponse, installedResponse]) => {
        if (!isCurrent) return
        const personalInstalled = installedResponse.items.filter(
          item => item.spec.source.type === 'personal'
        )
        const installedBySkillKey = new Map(
          personalInstalled.map(item => [getInstalledSkillKey(item), item])
        )
        setPersonalSkillState({
          items: personalResponse.items.map(item =>
            toPersonalCatalogItem(item, installedBySkillKey)
          ),
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setPersonalSkillState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, systemSkillApi])

  useEffect(() => {
    if (activeTab !== 'mcp') return

    let isCurrent = true
    setMcpMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    mcpApi
      .listProviders()
      .then(response => {
        if (!isCurrent) return

        setMcpMarketplaceState(previous => ({
          ...previous,
          providers: response.providers,
          isLoading: false,
          error: null,
        }))

        response.providers
          .filter(provider => !provider.requires_token || provider.has_token)
          .forEach(provider => loadMcpProviderServers(provider.key))
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setMcpMarketplaceState(previous => ({
          ...previous,
          providers: [],
          isLoading: false,
          error: error.message,
        }))
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, loadMcpProviderServers, mcpApi])

  useEffect(() => {
    let isCurrent = true
    setIsMarketplaceConfigLoading(true)
    setPluginMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))
    localPluginApi
      .readState()
      .then(state => {
        if (!isCurrent) return
        applyLocalMarketplaceState(state)
        const selectedKey = state.selectedMarketplaceId
          ? localMarketplaceKey(state.selectedMarketplaceId)
          : ''
        initialMarketplaceLoadKeyRef.current = selectedKey
        setInstalledPlugins(state.installedPlugins.map(toInstalledPluginItem))
        setPluginMarketplaceState({
          items: state.marketplaceItems,
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        const options = toMarketplaceOptions(
          [],
          cloudMarketplaceAvailable,
          t('workbench.plugins_cloud_marketplace', '云端插件市场')
        )
        setMarketplaces(options)
        setSelectedMarketplaceKey(current => current || options[0]?.key || '')
        setInstalledPlugins([])
        setPluginMarketplaceState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })
      .finally(() => {
        if (isCurrent) setIsMarketplaceConfigLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [applyLocalMarketplaceState, cloudMarketplaceAvailable, localPluginApi, t])

  useEffect(() => {
    if (activeTab !== 'plugins') return

    if (isMarketplaceConfigLoading) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        isLoading: true,
        error: null,
      }))
      return
    }

    const marketplace =
      marketplaces.find(item => item.key === selectedMarketplaceLoadKey) ?? marketplaces[0] ?? null

    if (!marketplace) {
      setPluginMarketplaceState({
        items: [],
        isLoading: false,
        error: null,
      })
      return
    }

    let isCurrent = true
    if (
      initialMarketplaceLoadKeyRef.current === marketplace.key &&
      marketplaceRefreshTick === 0 &&
      !normalizedQuery
    ) {
      initialMarketplaceLoadKeyRef.current = null
      return
    }
    const isGithubMarketplace =
      marketplace.kind === 'local' && /^https?:\/\/github\.com\//i.test(marketplace.path || '')
    const isExplicitRefresh = marketplaceRefreshTick > consumedRefreshTick.current
    if (isExplicitRefresh) consumedRefreshTick.current = marketplaceRefreshTick
    setMarketplaceLoadingMessage(
      isGithubMarketplace
        ? isExplicitRefresh
          ? t('workbench.plugins_refreshing_github_marketplace', '正在刷新 GitHub 插件市场')
          : t(
              'workbench.plugins_syncing_github_marketplace',
              '正在同步 GitHub 插件市场，首次添加时需要 clone 仓库。'
            )
        : isExplicitRefresh
          ? t('workbench.plugins_refreshing_marketplace', '正在刷新插件市场')
          : t('workbench.plugins_loading_marketplace', '正在加载插件市场')
    )
    setPluginMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    const request =
      marketplace.kind === 'local'
        ? localPluginApi
            .readState({
              q: normalizedQuery || undefined,
              marketplaceId: marketplace.id,
              refresh: isExplicitRefresh,
            })
            .then(state => ({ items: state.marketplaceItems, diagnostics: state.diagnostics }))
        : pluginApi.listMarketplacePlugins({ q: normalizedQuery || undefined })

    request
      .then(response => {
        if (!isCurrent) return
        setMarketplaceLoadingMessage('')
        setMarketplaceDiagnostics(
          'diagnostics' in response && Array.isArray(response.diagnostics)
            ? response.diagnostics.filter((value): value is string => typeof value === 'string')
            : []
        )
        setPluginMarketplaceState({
          items: response.items,
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setMarketplaceLoadingMessage('')
        setPluginMarketplaceState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })

    return () => {
      isCurrent = false
    }
  }, [
    activeTab,
    isMarketplaceConfigLoading,
    localPluginApi,
    marketplaces,
    marketplaceRefreshTick,
    normalizedQuery,
    pluginApi,
    selectedMarketplaceLoadKey,
    t,
  ])

  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => plugin.id === selectedPluginId) ?? null),
    [installedPlugins, selectedPluginId]
  )
  const selectedMarketplacePlugin = useMemo(
    () =>
      selectedMarketplacePluginId === null
        ? null
        : (pluginMarketplaceState.items.find(item => item.id === selectedMarketplacePluginId) ??
          null),
    [pluginMarketplaceState.items, selectedMarketplacePluginId]
  )
  const marketplaceGroups = useMemo(() => {
    const groups = new Map<string, PluginMarketplaceItem[]>()
    for (const item of pluginMarketplaceState.items) {
      const title = marketplaceSectionTitle(item, t)
      groups.set(title, [...(groups.get(title) ?? []), item])
    }
    return Array.from(groups.entries())
  }, [pluginMarketplaceState.items, t])

  const toggleMarketplaceSectionExpanded = (title: string) => {
    setExpandedMarketplaceSections(previous => {
      const next = new Set(previous)
      if (next.has(title)) {
        next.delete(title)
      } else {
        next.add(title)
      }
      return next
    })
  }

  if (activeTab === 'plugins' && selectedPlugin) {
    return (
      <PluginDetailView
        iconLoader={localPluginApi.readPluginIcon}
        plugin={selectedPlugin}
        actionError={pluginMarketplaceState.error}
        onDismissError={() => setPluginMarketplaceState(previous => ({ ...previous, error: null }))}
        onBack={() => setSelectedPluginId(null)}
        onToggle={() => {
          const sourceType = selectedPlugin.raw.spec.source.type
          if (sourceType === 'marketplace') {
            tryLocalInstalledPluginInChat(selectedPlugin.id)
            return
          }
          if (!tryPluginInChat(selectedPlugin.raw)) {
            setPluginMarketplaceState(previous => ({
              ...previous,
              error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
            }))
          }
        }}
        onComponentToggle={(componentKey, enabled) =>
          togglePluginComponent(selectedPlugin.id, componentKey, enabled)
        }
        onUninstall={() => uninstallInstalledPlugin(selectedPlugin.id)}
      />
    )
  }

  if (activeTab === 'plugins' && selectedMarketplacePlugin) {
    const installedDetail =
      selectedMarketplacePlugin.installedPluginId === null ||
      selectedMarketplacePlugin.installedPluginId === undefined
        ? null
        : (installedPlugins.find(
            plugin => String(plugin.id) === String(selectedMarketplacePlugin.installedPluginId)
          ) ?? null)
    const detailPlugin =
      installedDetail ?? toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
    const isInstalled = selectedMarketplacePlugin.installed || installedDetail !== null
    const isInstalling = installingMarketplacePluginIds.has(selectedMarketplacePlugin.id)

    return (
      <PluginDetailView
        iconLoader={localPluginApi.readPluginIcon}
        plugin={detailPlugin}
        actionError={pluginMarketplaceState.error}
        onDismissError={() => setPluginMarketplaceState(previous => ({ ...previous, error: null }))}
        primaryActionLabel={
          isInstalling
            ? cancellingInstalls.has(selectedMarketplacePlugin.id)
              ? t('pluginNetwork.cancellingInstall')
              : canCancelInstall(selectedMarketplacePlugin.id)
                ? t('pluginNetwork.cancelInstall')
                : t('workbench.plugins_installing', '安装中...')
            : isInstalled
              ? t('workbench.plugins_try_in_chat', '在对话中试用')
              : selectedMarketplacePlugin.installable === false
                ? t('pluginNetwork.unavailable')
                : t('workbench.plugins_install', '安装')
        }
        primaryActionDisabled={
          (isInstalling &&
            (!canCancelInstall(selectedMarketplacePlugin.id) ||
              cancellingInstalls.has(selectedMarketplacePlugin.id))) ||
          (!isInstalled && selectedMarketplacePlugin.installable === false)
        }
        showUninstall={isInstalled}
        onBack={() => setSelectedMarketplacePluginId(null)}
        onToggle={() => {
          if (isInstalling) {
            void cancelInstall(selectedMarketplacePlugin.id)
            return
          }
          if (isInstalled && installedDetail) {
            if (selectedMarketplace?.kind === 'local') {
              tryLocalInstalledPluginInChat(installedDetail.id)
              return
            }
            if (!tryPluginInChat(installedDetail.raw)) {
              setPluginMarketplaceState(previous => ({
                ...previous,
                error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
              }))
            }
            return
          }
          installMarketplacePlugin(selectedMarketplacePlugin)
        }}
        onComponentToggle={(componentKey, enabled) => {
          if (installedDetail) {
            togglePluginComponent(installedDetail.id, componentKey, enabled)
          }
        }}
        onUninstall={() => {
          if (installedDetail) {
            uninstallInstalledPlugin(installedDetail.id)
          }
        }}
      />
    )
  }

  return (
    <main
      data-testid="plugins-workspace"
      className="plugin-marketplace-page min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl">
        <DesktopTopBar
          testId="plugins-topbar"
          className={[
            'mx-auto h-12 max-w-[1420px] pl-20 pr-5 md:h-[52px] md:pr-7',
            sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          ].join(' ')}
          left={topBarLeftActions}
          dragRegionClassName="hidden md:block"
          right={
            <div className="hidden items-center gap-5 overflow-visible md:flex">
              <button
                type="button"
                data-testid="plugins-refresh-button"
                aria-label={t('workbench.plugins_refresh_marketplace', '刷新插件市场')}
                disabled={pluginMarketplaceState.isLoading}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-black/[0.06] hover:text-text-primary active:bg-black/[0.10] disabled:cursor-wait disabled:opacity-60"
                onClick={refreshMarketplace}
              >
                <RefreshCw
                  className={[
                    'h-[18px] w-[18px] stroke-[2]',
                    pluginMarketplaceState.isLoading ? 'animate-spin' : '',
                  ].join(' ')}
                />
              </button>
              <button
                type="button"
                data-testid="plugins-manage-button"
                className="flex h-8 min-w-[44px] items-center gap-1.5 rounded-lg bg-transparent px-2 text-sm font-medium leading-[18px] transition-colors hover:bg-black/[0.06] active:bg-black/[0.10]"
                onClick={() => navigateTo('/plugins/manage')}
              >
                <Settings className="h-[18px] w-[18px] stroke-[2]" />
                {t('workbench.plugins_manage', '管理')}
              </button>
              {!isMobile && localPluginApi.supportsAuthoring !== false && (
                <PluginCreateMenu
                  isOpen={isCreateMenuOpen}
                  onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                  onCreateSkill={() => {
                    setIsCreateMenuOpen(false)
                    setShowSkillUploadDialog(true)
                  }}
                  onCreateMcp={() => {
                    setIsCreateMenuOpen(false)
                    setShowCustomMcpDialog(true)
                  }}
                  onCreatePlugin={() => {
                    setIsCreateMenuOpen(false)
                    navigateTo('/plugins/create')
                  }}
                />
              )}
            </div>
          }
        />
      </div>

      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-5 pb-14 pt-5 md:px-8 md:pt-4">
        {localPluginApi.listTrust && (
          <div className="space-y-3">
            <button
              type="button"
              data-testid="plugins-trust-manage-button"
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
              onClick={() => setShowTrustManager(value => !value)}
            >
              {t('pluginTrust.title')}
            </button>
            {showTrustManager && (
              <PluginTrustManager
                key={`${targetDeviceId}:${targetWorkspacePath}`}
                api={localPluginApi}
                target={targetDeviceId ?? 'local'}
                onClose={() => {
                  setShowTrustManager(false)
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLButtonElement>(
                        '[data-testid="plugins-trust-manage-button"]'
                      )
                      ?.focus()
                  )
                }}
              />
            )}
          </div>
        )}
        <section className="space-y-1.5">
          <h1 className="text-heading-md font-semibold tracking-tight text-text-primary">
            {t('workbench.plugin_management_tab_plugins', '插件')}
          </h1>
          <p className="text-sm leading-6 text-text-secondary">
            {t('workbench.plugins_subtitle', '通过插件扩展 KCoder Studio 能力')}
          </p>
          {targetDeviceId && (
            <p
              data-testid="plugins-install-target"
              className="break-all text-sm text-text-secondary"
            >
              {t('workbench.plugins_install_target', {
                target: targetDeviceId,
                path: targetWorkspacePath ?? '',
              })}
            </p>
          )}
        </section>

        {hasMarketplace && (
          <>
            <div className="grid w-full grid-cols-[minmax(0,1fr)_44px] items-center gap-2 md:block">
              <div className="min-w-0">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">
                    {t('workbench.plugins_search_plugins', '搜索插件')}
                  </span>
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <input
                    value={query}
                    onChange={event => {
                      setQuery(event.target.value)
                      setSystemSkillPage(1)
                    }}
                    placeholder={t('workbench.plugins_search_plugins', '搜索插件')}
                    data-testid="plugins-search-input"
                    className="plugin-marketplace-search h-11 w-full rounded-xl border border-border bg-surface/40 pl-10 pr-4 text-sm text-text-primary shadow-sm outline-none transition-colors placeholder:text-text-muted"
                  />
                </label>
              </div>
              {isMobile && localPluginApi.supportsAuthoring !== false && (
                <div className="md:hidden">
                  <PluginCreateMenu
                    compact
                    isOpen={isCreateMenuOpen}
                    onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                    onCreateSkill={() => {
                      setIsCreateMenuOpen(false)
                      setShowSkillUploadDialog(true)
                    }}
                    onCreateMcp={() => {
                      setIsCreateMenuOpen(false)
                      setShowCustomMcpDialog(true)
                    }}
                    onCreatePlugin={() => {
                      setIsCreateMenuOpen(false)
                      navigateTo('/plugins/create')
                    }}
                  />
                </div>
              )}
            </div>

            <InstalledPluginStrip
              iconLoader={localPluginApi.readPluginIcon}
              plugins={installedPlugins}
              title={t('workbench.plugins_installed', '已安装')}
              onManage={() => navigateTo('/plugins/manage')}
              onSelect={setSelectedPluginId}
            />

            <div
              className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-surface/40 p-2"
              data-testid="plugins-marketplace-source-switcher"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <select
                  data-testid="plugins-marketplace-selector"
                  value={selectedMarketplaceKey}
                  aria-label={t('workbench.plugins_marketplace_select', '选择市场')}
                  className="sr-only"
                  onChange={event => {
                    const key = event.target.value
                    const marketplace = marketplaces.find(item => item.key === key)
                    setSelectedMarketplaceKey(key)
                    if (marketplace?.kind === 'local') {
                      void localPluginApi.selectMarketplace(marketplace.id)
                    }
                  }}
                >
                  {marketplaces.map(marketplace => (
                    <option key={marketplace.key} value={marketplace.key}>
                      {marketplace.name}
                    </option>
                  ))}
                </select>
                {marketplaces.map(marketplace => {
                  const isSelected = selectedMarketplace?.key === marketplace.key
                  return (
                    <button
                      key={marketplace.key}
                      type="button"
                      aria-pressed={isSelected}
                      data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                      className={[
                        'h-8 shrink-0 rounded-lg px-3 text-sm font-medium leading-5 transition-colors',
                        isSelected
                          ? 'bg-background text-text-primary shadow-sm'
                          : 'text-text-muted hover:bg-surface hover:text-text-primary',
                      ].join(' ')}
                      onClick={() => {
                        setSelectedMarketplaceKey(marketplace.key)
                        if (marketplace.kind === 'local') {
                          void localPluginApi.selectMarketplace(marketplace.id)
                        }
                      }}
                    >
                      {marketplace.name}
                    </button>
                  )
                })}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  data-testid="plugins-manage-marketplaces-button"
                  aria-label={t('workbench.plugins_marketplace_manage', '管理市场')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
                  onClick={() => setShowMarketplaceManager(true)}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </button>
                <div className="relative">
                  <button
                    type="button"
                    data-testid="plugins-add-marketplace-button"
                    aria-expanded={showAddMarketplaceMenu}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
                    onClick={() => setShowAddMarketplaceMenu(previous => !previous)}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  {showAddMarketplaceMenu && (
                    <div
                      data-testid="plugins-add-marketplace-menu"
                      className="absolute right-0 top-9 z-50 w-64 rounded-xl border border-border bg-background p-1.5 shadow-xl"
                    >
                      <button
                        type="button"
                        data-testid="plugins-add-custom-marketplace-button"
                        className="flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface"
                        onClick={() => {
                          setShowAddMarketplaceMenu(false)
                          setMarketplaceConfigError(null)
                          setMarketplaceForm({ path: '' })
                        }}
                      >
                        <span className="text-sm font-medium text-text-primary">
                          {t('workbench.plugins_add_custom_marketplace', '添加自定义市场')}
                        </span>
                        <span className="mt-0.5 text-xs leading-5 text-text-muted">
                          {t(
                            'workbench.plugins_add_custom_marketplace_description',
                            '填写 GitHub 仓库或本地 marketplace.json。'
                          )}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        <section className="space-y-8">
          {marketplaceDiagnostics.length > 0 && (
            <div
              role="status"
              data-testid="plugin-marketplace-diagnostics"
              className="rounded-xl border border-border bg-surface/40 p-4 text-sm"
            >
              <p className="font-medium">{t('pluginNetwork.diagnostics')}</p>
              {marketplaceDiagnostics.map((message, index) => (
                <p key={index} className="mt-2 break-words text-text-secondary">
                  {message}
                </p>
              ))}
            </div>
          )}
          {
            <div className="space-y-8">
              {!pluginMarketplaceState.isLoading &&
                pluginMarketplaceState.error &&
                pluginMarketplaceState.items.length > 0 && (
                  <div
                    role="alert"
                    data-testid="plugin-marketplace-action-error"
                    className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 text-sm text-text-secondary"
                  >
                    <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {pluginMarketplaceState.error}
                    </span>
                    <button
                      type="button"
                      data-testid="plugin-marketplace-dismiss-error"
                      onClick={() =>
                        setPluginMarketplaceState(previous => ({ ...previous, error: null }))
                      }
                      className="shrink-0 rounded px-2 py-1 hover:bg-surface-hover"
                    >
                      {t('workbench.dismiss_error', '关闭提示')}
                    </button>
                  </div>
                )}
              {pluginMarketplaceState.isLoading ? (
                <PluginMarketplaceLoadingSkeleton
                  message={
                    marketplaceLoadingMessage ||
                    t('workbench.plugins_loading_marketplace', '正在加载插件市场')
                  }
                  hint={
                    selectedMarketplace?.kind === 'local' &&
                    /^https?:\/\/github\.com\//i.test(selectedMarketplace.path || '')
                      ? t(
                          'workbench.plugins_github_clone_hint',
                          '这个过程会在本地缓存仓库，完成后再次打开会直接读取缓存。'
                        )
                      : undefined
                  }
                />
              ) : pluginMarketplaceState.error && pluginMarketplaceState.items.length === 0 ? (
                <div
                  role="alert"
                  className="flex min-h-[180px] items-center justify-center text-sm font-semibold text-text-secondary"
                >
                  {pluginMarketplaceState.error}
                </div>
              ) : !selectedMarketplace ? (
                <PluginMarketplaceWelcome
                  title={t('workbench.plugins_marketplace_welcome_title', '添加一个插件市场')}
                  description={t(
                    'workbench.plugins_marketplace_welcome_description',
                    '插件市场可以来自 GitHub 仓库或本地 marketplace.json。添加后即可搜索、安装和管理兼容插件。'
                  )}
                  manageLabel={t('workbench.plugins_manage', '管理')}
                  customAddLabel={t('workbench.plugins_add_custom_marketplace', '添加自定义市场')}
                  onAddCustomMarketplace={() => {
                    setMarketplaceConfigError(null)
                    setMarketplaceForm({ path: '' })
                  }}
                  onManage={() => navigateTo('/plugins/manage')}
                />
              ) : marketplaceGroups.length === 0 ? (
                <div className="flex min-h-[120px] flex-col items-start justify-center gap-3 border-t border-border pt-8 text-sm font-semibold">
                  <div className="text-text-secondary">
                    {t('workbench.plugins_no_marketplace_results', '找不到匹配的插件')}
                  </div>
                  <button
                    type="button"
                    data-testid="plugins-publish-empty-button"
                    className="rounded-lg bg-text-primary px-4 py-2 text-background hover:bg-text-primary/90"
                    onClick={() => {
                      if (selectedMarketplace.kind === 'local') {
                        navigateTo('/plugins/create')
                        return
                      }
                      setPluginUploadError(null)
                      setShowPluginUploadDialog(true)
                    }}
                  >
                    {selectedMarketplace.kind === 'local'
                      ? t('workbench.plugins_create_new_plugin', '创建插件')
                      : t('workbench.plugins_publish_plugin', '发布插件')}
                  </button>
                </div>
              ) : (
                marketplaceGroups.map(([title, items]) => {
                  const isExpanded = expandedMarketplaceSections.has(title)
                  const visibleItems = isExpanded
                    ? items
                    : items.slice(0, MARKETPLACE_SECTION_COLLAPSED_COUNT)
                  const hiddenItems = items.slice(MARKETPLACE_SECTION_COLLAPSED_COUNT)
                  const previewItems = hiddenItems.slice(0, 3)
                  const previewNames = previewItems
                    .map(item => item.displayName || item.name)
                    .join('、')
                  const remainingCount = Math.max(hiddenItems.length - previewItems.length, 0)

                  return (
                    <section key={title} className="space-y-4">
                      <div className="border-b border-border pb-3">
                        <h2 className="flex items-center gap-2 text-base font-semibold leading-6 text-text-primary">
                          {title}
                          <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-medium text-text-muted">
                            {items.length}
                          </span>
                        </h2>
                      </div>
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        {visibleItems.map(item => (
                          <PluginMarketplaceRow
                            iconLoader={
                              selectedMarketplace?.kind === 'local'
                                ? localPluginApi.readPluginIcon
                                : undefined
                            }
                            key={item.id}
                            item={item}
                            isInstalling={installingMarketplacePluginIds.has(item.id)}
                            isCancelling={cancellingInstalls.has(item.id)}
                            onCancel={
                              canCancelInstall(item.id)
                                ? () => void cancelInstall(item.id)
                                : undefined
                            }
                            installLabel={t('workbench.plugins_install', '安装')}
                            installingLabel={t('workbench.plugins_installing', '安装中...')}
                            tryLabel={t('workbench.plugins_try_in_chat', '在对话中试用')}
                            uninstallLabel={t('workbench.plugins_uninstall', '卸载')}
                            onOpen={() => setSelectedMarketplacePluginId(item.id)}
                            onInstall={() => installMarketplacePlugin(item)}
                            onUninstall={() => {
                              const installed =
                                item.installedPluginId === null ||
                                item.installedPluginId === undefined
                                  ? null
                                  : (installedPlugins.find(
                                      plugin => String(plugin.id) === String(item.installedPluginId)
                                    ) ?? null)
                              uninstallInstalledPlugin(
                                installed?.id ?? toMarketplaceInstalledPluginItem(item).id
                              )
                            }}
                          />
                        ))}
                      </div>
                      {hiddenItems.length > 0 && (
                        <button
                          type="button"
                          data-testid={`plugins-marketplace-expand-${title}`}
                          className="flex min-h-9 max-w-full items-center gap-3 rounded-lg px-1 text-left text-sm leading-5 text-text-muted transition-colors hover:text-text-primary"
                          onClick={() => toggleMarketplaceSectionExpanded(title)}
                        >
                          <span className="flex h-7 min-w-11 items-center">
                            {previewItems.map((item, index) => {
                              const logo = resolvePluginAssetUrl(
                                item.interface?.logo || item.interface?.composerIcon
                              )
                              return (
                                <span
                                  key={item.id}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background text-text-muted shadow-sm"
                                  style={{ marginLeft: index === 0 ? 0 : -8 }}
                                >
                                  {logo ? (
                                    <img src={logo} alt="" className="h-full w-full object-cover" />
                                  ) : (
                                    <Boxes className="h-3.5 w-3.5" />
                                  )}
                                </span>
                              )
                            })}
                          </span>
                          <span className="truncate">
                            {isExpanded
                              ? t('workbench.plugins_collapse_section', '收起')
                              : remainingCount > 0
                                ? `查看 ${previewNames}，以及另外 ${remainingCount} 个`
                                : `查看 ${previewNames}`}
                          </span>
                        </button>
                      )}
                    </section>
                  )
                })
              )}
            </div>
          }
        </section>
      </div>
      {pendingUninstallItem && (
        <ConfirmUninstallDialog
          item={pendingUninstallItem}
          title={t('workbench.plugins_uninstall_confirm_title', '卸载技能？')}
          description={t(
            'workbench.plugins_uninstall_confirm_description',
            '卸载后可以随时重新安装。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_uninstall_confirm', '卸载')}
          onCancel={() => setPendingUninstallItem(null)}
          onConfirm={() => {
            const item = pendingUninstallItem
            setPendingUninstallItem(null)
            void uninstallSystemSkill(item)
          }}
        />
      )}
      {pendingUninstallMcp && (
        <ConfirmUninstallDialog
          item={{ name: pendingUninstallMcp.server.name }}
          title={t('workbench.plugins_uninstall_mcp_confirm_title', '卸载 MCP？')}
          description={t(
            'workbench.plugins_uninstall_mcp_confirm_description',
            '卸载后可以在市场中重新安装。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_uninstall_confirm', '卸载')}
          confirmTestId="mcp-market-confirm-uninstall-button"
          onCancel={() => setPendingUninstallMcp(null)}
          onConfirm={() => {
            const item = pendingUninstallMcp
            setPendingUninstallMcp(null)
            uninstallProviderServer(item.provider, item.server)
          }}
        />
      )}
      {pendingMarketplaceDelete && (
        <ConfirmUninstallDialog
          item={{ name: pendingMarketplaceDelete.name }}
          title={t('workbench.plugins_marketplace_delete_title', '删除市场？')}
          description={t(
            'workbench.plugins_marketplace_delete_description',
            '删除后只会移除这个市场配置，不会卸载已经安装的插件。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_marketplace_delete_confirm', '删除')}
          confirmTestId="plugins-marketplace-confirm-delete-button"
          onCancel={() => setPendingMarketplaceDelete(null)}
          onConfirm={deleteMarketplace}
        />
      )}
      {showCustomMcpDialog && (
        <CustomMcpDialog
          form={customMcpForm}
          isSubmitting={isCreatingCustomMcp}
          onCancel={() => setShowCustomMcpDialog(false)}
          onChange={nextForm => setCustomMcpForm(nextForm)}
          onSubmit={createCustomMcp}
        />
      )}
      {showSkillUploadDialog && (
        <SkillUploadDialog
          isUploading={isUploadingSkill}
          onCancel={() => setShowSkillUploadDialog(false)}
          onUpload={uploadPersonalSkill}
        />
      )}
      {showPluginUploadDialog && (
        <PluginUploadDialog
          isUploading={isUploadingPlugin}
          uploadError={pluginUploadError}
          onCancel={() => setShowPluginUploadDialog(false)}
          onErrorReset={() => setPluginUploadError(null)}
          onUpload={uploadPlugin}
        />
      )}
      {showMarketplaceManager && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 px-4">
          <div
            role="dialog"
            aria-modal="true"
            data-testid="plugins-marketplace-manager-dialog"
            className="w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-base font-medium text-text-primary">
                  {t('workbench.plugins_marketplace_manage', '管理市场')}
                </h2>
                <p className="text-sm leading-5 text-text-secondary">
                  {t(
                    'workbench.plugins_marketplace_manage_description',
                    '调整市场顺序，或编辑、删除已添加的本地/GitHub 市场。'
                  )}
                </p>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-surface hover:text-text-primary"
                onClick={() => setShowMarketplaceManager(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 space-y-2">
              {marketplaces.filter(isUserManagedMarketplace).length === 0 ? (
                <div className="rounded-lg border border-border px-4 py-5 text-sm text-text-secondary">
                  {t('workbench.plugins_marketplace_no_local_markets', '还没有可管理的市场。')}
                </div>
              ) : (
                marketplaces
                  .filter(isUserManagedMarketplace)
                  .map((marketplace, index, localMarketplaces) => (
                    <div
                      key={marketplace.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {marketplace.name}
                        </div>
                        <div className="truncate text-xs leading-5 text-text-muted">
                          {marketplace.path}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`plugins-marketplace-move-up-${marketplace.id}`}
                          disabled={index === 0}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => reorderLocalMarketplace(marketplace.id, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          data-testid={`plugins-marketplace-move-down-${marketplace.id}`}
                          disabled={index === localMarketplaces.length - 1}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => reorderLocalMarketplace(marketplace.id, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          data-testid={`plugins-marketplace-edit-${marketplace.id}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
                          onClick={() => {
                            setShowMarketplaceManager(false)
                            setMarketplaceConfigError(null)
                            setMarketplaceForm({
                              id: marketplace.id,
                              path: marketplace.path || '',
                            })
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          data-testid={`plugins-marketplace-delete-${marketplace.id}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-red-50 hover:text-red-600"
                          onClick={() => {
                            setShowMarketplaceManager(false)
                            setPendingMarketplaceDelete({
                              id: marketplace.id,
                              name: marketplace.name,
                            })
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))
              )}
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="h-9 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary"
                onClick={() => setShowMarketplaceManager(false)}
              >
                {t('workbench.plugins_uninstall_cancel', '取消')}
              </button>
            </div>
          </div>
        </div>
      )}
      {marketplaceForm && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 px-4">
          <form
            role="dialog"
            aria-modal="true"
            data-testid="plugins-marketplace-config-dialog"
            className="max-h-[calc(100dvh-2rem)] min-w-0 w-full max-w-md overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl"
            onSubmit={saveMarketplace}
          >
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-text-primary">
                {marketplaceForm.id
                  ? t('workbench.plugins_marketplace_edit_title', '编辑市场')
                  : t('workbench.plugins_marketplace_config_title', '添加市场')}
              </h2>
              <p className="text-sm leading-5 text-text-secondary">
                {marketplaceForm.id
                  ? t(
                      'workbench.plugins_marketplace_edit_description',
                      '更新市场地址。市场名称由 marketplace.json 决定。'
                    )
                  : t(
                      'workbench.plugins_marketplace_config_description',
                      '填写 GitHub 仓库地址，或本地 marketplace.json/目录。'
                    )}
              </p>
            </div>
            <div className="mt-5 space-y-4">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-text-primary">
                  {t('workbench.plugins_marketplace_path', '市场路径')}
                </span>
                <input
                  data-testid="plugins-marketplace-path-input"
                  disabled={isSavingMarketplace}
                  value={marketplaceForm.path}
                  placeholder="https://github.com/org/repo"
                  onChange={event =>
                    setMarketplaceForm(previous =>
                      previous
                        ? { ...previous, path: event.target.value, trustSourceDirectory: false }
                        : previous
                    )
                  }
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-muted"
                />
              </label>
              {directoryPicker && (
                <div className="space-y-3">
                  <button
                    type="button"
                    data-testid="plugins-marketplace-browse-directory"
                    disabled={isSavingMarketplace}
                    onClick={() => setShowDirectoryPicker(value => !value)}
                    className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
                  >
                    {t('workbench.plugins_browse_target_directory')}
                  </button>
                  {showDirectoryPicker && (
                    <DeviceFolderPicker
                      key={directoryPicker.device.device_id}
                      device={directoryPicker.device}
                      mode="select"
                      variant="remoteDark"
                      initialPath={targetWorkspacePath}
                      disabled={isSavingMarketplace}
                      confirmLabel={t('workbench.plugins_select_directory')}
                      onGetDeviceHomeDirectory={directoryPicker.getHome}
                      onListDeviceDirectories={directoryPicker.list}
                      onCreateDeviceDirectory={directoryPicker.create}
                      onCancel={() => setShowDirectoryPicker(false)}
                      onConfirm={({ path }) => {
                        setMarketplaceForm(previous =>
                          previous ? { ...previous, path, trustSourceDirectory: false } : previous
                        )
                        setShowDirectoryPicker(false)
                      }}
                    />
                  )}
                </div>
              )}
              {localPluginApi.supportsAuthoring === false && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">{t('pluginNetwork.proxyLabel')}</span>
                  <InputWithIcon
                    icon={<Network />}
                    data-testid="plugins-marketplace-proxy-input"
                    value={marketplaceForm.proxyUrl ?? ''}
                    placeholder="http://127.0.0.1:7890"
                    disabled={isSavingMarketplace}
                    onChange={event =>
                      setMarketplaceForm(previous =>
                        previous ? { ...previous, proxyUrl: event.target.value } : previous
                      )
                    }
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                  />
                  <span className="block text-xs text-text-secondary">
                    {t('pluginNetwork.proxyHelp')}
                  </span>
                </label>
              )}
              {localPluginApi.supportsAuthoring === false &&
                marketplaceForm.path.trim() &&
                !/^[a-z][a-z0-9+.-]*:\/\//i.test(marketplaceForm.path.trim()) &&
                !/\.json$/i.test(marketplaceForm.path.trim()) && (
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 text-sm text-text-primary">
                      <Checkbox
                        data-testid="plugins-marketplace-trust-directory"
                        checked={marketplaceForm.trustSourceDirectory ?? false}
                        disabled={isSavingMarketplace}
                        onChange={event =>
                          setMarketplaceForm(previous =>
                            previous
                              ? { ...previous, trustSourceDirectory: event.target.checked }
                              : previous
                          )
                        }
                      />
                      <span>{t('pluginNetwork.trustDirectoryLabel')}</span>
                    </label>
                    <p className="text-xs text-text-secondary [overflow-wrap:anywhere]">
                      {marketplaceForm.path.trim()}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {t('pluginNetwork.trustDirectoryWarning')}
                    </p>
                  </div>
                )}
              {marketplaceConfigError && (
                <div
                  role="alert"
                  data-testid="plugins-marketplace-config-error"
                  className="max-h-40 min-w-0 overflow-y-auto whitespace-pre-wrap text-sm text-red-600 [overflow-wrap:anywhere] dark:text-red-400"
                >
                  {marketplaceConfigError}
                  {marketplaceConfigError.includes('requires folder trust') && (
                    <div
                      data-testid="plugins-marketplace-trust-help"
                      className="mt-3 space-y-2 text-text-secondary"
                    >
                      <p>{t('pluginNetwork.trustHelp')}</p>
                      <code className="block select-text">{t('pluginNetwork.trustCommand')}</code>
                      <p>{t('pluginNetwork.trustRetry')}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="h-9 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary"
                disabled={isSavingMarketplace}
                onClick={() => setMarketplaceForm(null)}
              >
                {t('workbench.plugins_uninstall_cancel', '取消')}
              </button>
              <button
                type="submit"
                data-testid="plugins-marketplace-save-button"
                disabled={isSavingMarketplace}
                className="h-9 rounded-lg bg-text-primary px-4 text-sm font-semibold text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSavingMarketplace
                  ? t(
                      marketplaceForm.path.trim().startsWith('https://')
                        ? 'pluginNetwork.downloading'
                        : 'workbench.saving'
                    )
                  : t('workbench.save', '保存')}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}
