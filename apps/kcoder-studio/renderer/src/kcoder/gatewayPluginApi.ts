import i18n from '@/i18n'
import { createRandomUuid } from '@/lib/random-id'
import type { PluginActivationSnapshot } from '@/features/plugins/pluginLifecycle'
import { GatewayRpcError } from './gatewayRpc'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import type {
  LocalCodexPluginApi,
  LocalCodexPluginsState,
  PluginProxySettings,
} from '@/api/local/codexPlugins'
import type {
  InstalledPlugin,
  InstalledPluginComponents,
  LocalDeviceSkill,
  PluginMarketplaceItem,
} from '@/types/api'

export const PLUGIN_RPC_METHODS = new Set([
  'skills/list',
  'skills/setEnabled',
  'skills/import',
  'skills/remove',
  'mcp/list',
  'mcp/install',
  'mcp/remove',
  'mcp/logout',
  'mcp/login',
  'gateway/mcp/login',
  'mcp/callback',
  'mcp/cancel',
  'plugin/trust/list',
  'plugin/trust/set',
  'plugin/list',
  'plugin/read',
  'plugin/revalidate',
  'plugin/activation/read',
  'plugin/activation/conversations',
  'plugin/credentials/configure',
  'plugin/icon',
  'plugin/proxy/status',
  'plugin/proxy/configure',
  'plugin/install',
  'plugin/install/cancel',
  'plugin/uninstall',
  'plugin/enable',
  'plugin/disable',
  'marketplace/list',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/refresh',
])

export function requiredPluginCapabilities(
  method: string,
  params: Record<string, unknown>
): string[] {
  const capabilities: string[] = []
  if (method === 'skills/list' || method === 'skills/setEnabled')
    capabilities.push('skillActivationV1')
  if (method === 'plugin/revalidate') capabilities.push('pluginRevalidationV1')
  if (method.startsWith('plugin/activation/')) capabilities.push('pluginActivationV1')
  if (method === 'plugin/credentials/configure') capabilities.push('pluginPrivateCredentialsV1')
  if (
    method === 'marketplace/add' &&
    typeof params.source === 'string' &&
    /^https:\/\/download\.codebuddy\.cn\/plugin-marketplace\/(codebuddy-plugins-official|cb_teams_marketplace)\.zip$/.test(
      params.source
    )
  )
    capabilities.push('hostedPluginMarketplacesV1', 'workbuddyPluginMarketplaceV1')
  if (method.startsWith('plugin/proxy/')) capabilities.push('pluginProxyDiscoveryV1')
  if (
    method === 'marketplace/add' &&
    typeof params.source === 'string' &&
    /^https:\/\/(?:work\.trae\.cn\/marketplace|api\.trae\.com\.cn\/extensions\/api\/-\/plugin\/list)\/?$/.test(
      params.source
    )
  )
    capabilities.push('hostedPluginMarketplacesV1', 'traeCnPluginMarketplaceV1')
  if (
    method === 'marketplace/add' &&
    typeof params.source === 'string' &&
    /^https:\/\/qoder\.com\/marketplace\/?$/.test(params.source)
  )
    capabilities.push('hostedPluginMarketplacesV1')
  if (method === 'plugin/install/cancel') capabilities.push('pluginInstallCancellation')
  if (method.startsWith('plugin/trust/')) capabilities.push('pluginTrustManagement')
  if (method === 'marketplace/add' && params.trustSourceDirectory === true)
    capabilities.push('marketplaceDirectoryTrust')
  if (method === 'plugin/icon') capabilities.push('pluginIcons')
  if (method === 'marketplace/add' && params.proxyUrl !== undefined)
    capabilities.push('pluginDownloadProxy')
  if (
    method === 'marketplace/refresh' ||
    (method === 'marketplace/add' &&
      params.replaceExisting !== undefined &&
      params.replaceExisting !== false)
  )
    capabilities.push('marketplaceGitRefresh')
  return capabilities
}

interface Plugin {
  id: string
  name: string
  description?: string | null
  version?: string | null
  enabled: boolean
  root: string
  components?: Array<{
    kind: string
    name: string
    path?: string | null
    description?: string | null
  }>
  compatibility?: { level: string; supportedCapabilities: string[]; deferredCapabilities: string[] }
}

interface Marketplace {
  sourceUrl?: string
  id: string
  path: string
  displayName?: string | null
  plugins: Array<{
    pluginId: string
    version?: string | null
    installPolicy: string
    source: Record<string, unknown>
    manifestFallback?: Record<string, unknown> | null
  }>
}

function catalogInterface(metadata: Record<string, unknown>): PluginMarketplaceItem['interface'] {
  const source =
    metadata.interface && typeof metadata.interface === 'object'
      ? (metadata.interface as Record<string, unknown>)
      : {}
  const icon = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value !== 'string') continue
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && !url.username && !url.password) return url.href
      } catch {
        /* Local assets are read only by the target-scoped icon loader. */
      }
    }
    return undefined
  }
  return {
    logo: icon(source.logo, metadata.icon, metadata.icon_url, metadata.logo),
    logoDark: icon(source.logoDark, metadata.logoDark),
    composerIcon: icon(source.composerIcon),
  }
}

function components(plugin?: Plugin): InstalledPluginComponents {
  const result: InstalledPluginComponents = {
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcps: [],
    lsps: [],
    monitors: [],
    bins: [],
  }
  for (const component of plugin?.components ?? []) {
    if (component.kind === 'skill') {
      result.skills.push({
        name: component.name,
        path: component.path ?? '',
        description: component.description ?? '',
      })
    } else if (component.kind === 'mcp') {
      result.mcps.push({ name: component.name, server: {} })
    } else if (component.kind === 'hook' || component.kind === 'command') {
      result[component.kind === 'hook' ? 'hooks' : 'commands'].push({
        name: component.name,
        path: component.path ?? '',
        description: component.description,
      })
    }
  }
  return result
}

function installed(plugin: Plugin): InstalledPlugin {
  const [name, marketplace] = plugin.id.split('@')
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name, namespace: marketplace, labels: { id: plugin.id } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: marketplace,
        pluginKey: name,
        catalogItemId: plugin.id,
      },
      displayName: plugin.name,
      description: plugin.description ?? '',
      version: plugin.version,
      installState: 'installed',
      enabled: plugin.enabled,
      manifest: { id: plugin.id, root: plugin.root, compatibility: plugin.compatibility },
      components: components(plugin),
    },
    status: { state: plugin.enabled ? 'enabled' : 'disabled' },
  }
}

export function createKCoderPluginApi(
  base: LocalCodexPluginApi,
  target?: { deviceId?: string; workspacePath?: string; isScopeCurrent?: () => boolean }
): LocalCodexPluginApi {
  const { isScopeCurrent, ...scopeTarget } = target ?? {}
  const assertScope = () => {
    if (isScopeCurrent && !isScopeCurrent())
      throw new GatewayRpcError(
        'Plugin target or account changed',
        -32049,
        {
          kind: 'plugin_scope_changed',
        },
        'plugin-manage',
        'remote'
      )
  }
  let selectedId = ''
  const iconCache = new Map<string, Promise<string | null>>()
  let activeIcons = 0
  const iconQueue: Array<() => void> = []

  const request = async <T>(
    method: string,
    params: Record<string, unknown> = {},
    taskId?: string
  ) => {
    let result: T
    try {
      assertScope()
      result = await requestLocalExecutor<T>('runtime.plugins.request', {
        ...scopeTarget,
        ...(taskId ? { taskId } : {}),
        method,
        params,
      })
      assertScope()
    } catch (error) {
      const failure = error as Error & { data?: { kind?: string } }
      const key =
        failure.data?.kind === 'plugin_scope_changed'
          ? 'workbench.plugins_error_scope_changed'
          : failure.data?.kind === 'plugin_update_required' && method.startsWith('skills/')
            ? 'workbench.skill_activation_upgrade'
            : `pluginNetwork.errors.${failure.data?.kind ?? ''}`
      if (failure.data?.kind && i18n.exists(key)) {
        if (error instanceof GatewayRpcError) {
          const translated = new GatewayRpcError(
            i18n.t(key),
            error.code,
            error.data,
            error.operation,
            error.reason,
            error.targetId,
            error.diagnosticContext
          )
          translated.cause = error
          throw translated
        }
        throw new Error(i18n.t(key), { cause: error })
      }
      throw error
    }
    if (
      ![
        'skills/list',
        'plugin/list',
        'plugin/read',
        'plugin/activation/read',
        'plugin/activation/conversations',
        'plugin/revalidate',
        'plugin/icon',
        'plugin/proxy/status',
        'plugin/proxy/configure',
        'plugin/trust/list',
        'marketplace/list',
        'plugin/install/cancel',
      ].includes(method)
    ) {
      iconCache.clear()
      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
    }
    return result
  }
  const readState: LocalCodexPluginApi['readState'] = async (params = {}) => {
    const refreshed = params.refresh
      ? await request<{ diagnostics?: Array<{ message: string }> }>('marketplace/refresh', {
          marketplaceName: params.marketplaceId || selectedId || undefined,
        })
      : undefined
    const [catalog, inventory] = await Promise.all([
      request<{
        marketplaces: Marketplace[]
        diagnostics: Array<{ message: string }>
        lifecycleCapabilities?: {
          revalidation: boolean
          privateCredentials: boolean
          activation: boolean
        }
      }>('marketplace/list'),
      request<{ plugins: Plugin[] }>('plugin/list', { all: true }),
    ])
    delete api.revalidateAvailablePlugin
    delete api.readPluginActivation
    delete api.listActivationConversations
    delete api.configurePluginCredentials
    if (catalog.lifecycleCapabilities?.revalidation === true)
      api.revalidateAvailablePlugin = async (id, options) => {
        const [pluginName, marketplaceName] = String(id).split('@')
        await request('plugin/revalidate', {
          marketplaceName,
          pluginName,
          revalidationAttemptId: options?.revalidationAttemptId ?? createRandomUuid(),
        })
      }
    if (catalog.lifecycleCapabilities?.activation === true) {
      api.readPluginActivation = (id, options) =>
        request<PluginActivationSnapshot>(
          'plugin/activation/read',
          { pluginId: String(id) },
          options?.taskId
        )
      api.listActivationConversations = () => request('plugin/activation/conversations')
    }
    if (catalog.lifecycleCapabilities?.privateCredentials === true)
      api.configurePluginCredentials = (id, values, options) =>
        request('plugin/credentials/configure', { pluginId: String(id), values, ...options })
    const selected = params.marketplaceId ?? selectedId
    selectedId = catalog.marketplaces.some(m => m.id === selected)
      ? selected
      : (catalog.marketplaces[0]?.id ?? '')
    if (params.refresh) iconCache.clear()
    const byId = new Map(inventory.plugins.map(p => [p.id, p]))
    const marketplaceItems: PluginMarketplaceItem[] = catalog.marketplaces
      .filter(m => !selectedId || m.id === selectedId)
      .flatMap(m =>
        m.plugins.map(p => {
          const existing = byId.get(p.pluginId)
          const fallback = p.manifestFallback ?? {}
          const name = p.pluginId.split('@')[0]
          const chinese = i18n.language.startsWith('zh')
          const displayName =
            chinese && typeof fallback.displayNameZh === 'string' && fallback.displayNameZh
              ? fallback.displayNameZh
              : fallback.displayName
          const description =
            chinese && typeof fallback.descriptionZh === 'string' && fallback.descriptionZh
              ? fallback.descriptionZh
              : !chinese && typeof fallback.description_en === 'string'
                ? fallback.description_en
                : fallback.description
          return {
            id: p.pluginId,
            remotePluginId: p.pluginId,
            name,
            displayName:
              typeof displayName === 'string'
                ? displayName
                : typeof fallback.name === 'string'
                  ? fallback.name
                  : name,
            description: typeof description === 'string' ? description : '',
            version: p.version,
            visibility: 'personal' as const,
            featured: false,
            installed: Boolean(existing),
            installable: !['NOT_AVAILABLE', 'not_available'].includes(p.installPolicy),
            installedPluginId: existing?.id ?? null,
            enabled: existing?.enabled ?? false,
            sourceType: 'marketplace' as const,
            components: components(existing),
            interface: catalogInterface(fallback),
            manifest: { ...fallback, source: p.source, installPolicy: p.installPolicy },
            ownerUserId: 0,
          }
        })
      )
      .filter(
        p =>
          !params.q ||
          `${p.name} ${p.displayName} ${p.description}`
            .toLowerCase()
            .includes(params.q.toLowerCase())
      )
    return {
      marketplaceItems,
      diagnostics: Array.from(
        new Set(
          [...(refreshed?.diagnostics ?? []), ...catalog.diagnostics].map(item => item.message)
        )
      ),
      installedPlugins: inventory.plugins.map(installed),
      marketplaces: catalog.marketplaces.map(m => ({
        id: m.id,
        name: m.displayName ?? m.id,
        path: m.sourceUrl ?? m.path,
        sourceUrl: m.sourceUrl,
        manifestPath: m.path,
      })),
      selectedMarketplaceId: selectedId,
      marketplacePath: catalog.marketplaces.find(m => m.id === selectedId)?.path ?? '',
      installRegistryPath: '',
    } satisfies LocalCodexPluginsState
  }
  const api: LocalCodexPluginApi = {
    ...base,
    supportsAuthoring: false,
    supportsMarketplacePresets: true,
    getProxySettings: () => request<PluginProxySettings>('plugin/proxy/status', {}),
    configureAutoProxy: async (enabled, probeUrl) => {
      const result = await request<PluginProxySettings>('plugin/proxy/configure', {
        enabled,
        ...(probeUrl ? { probeUrl } : {}),
      })
      iconCache.clear()
      window.dispatchEvent(new Event('kcoder:plugin-icons-invalidated'))
      return result
    },
    listTrust: () => request('plugin/trust/list', {}),
    setTrust: (path, action) => request('plugin/trust/set', { path, action }),
    readPluginIcon(id, dark) {
      const key = `${id}:${dark}`
      let pending = iconCache.get(key)
      if (!pending) {
        if (iconCache.size >= 64) iconCache.delete(iconCache.keys().next().value!)
        pending = (async () => {
          if (activeIcons >= 4) await new Promise<void>(resolve => iconQueue.push(resolve))
          else activeIcons += 1
          try {
            return (await request<{ url: string | null }>('plugin/icon', { pluginId: id, dark }))
              .url
          } finally {
            const next = iconQueue.shift()
            if (next) next()
            else activeIcons -= 1
          }
        })().catch(() => {
          if (iconCache.get(key) === pending) iconCache.delete(key)
          return null
        })
        iconCache.set(key, pending)
      }
      return pending
    },
    readState,
    async listInstalledPlugins() {
      return { items: (await readState()).installedPlugins }
    },
    async listAvailablePlugins(params) {
      return { items: (await readState(params)).marketplaceItems }
    },
    selectMarketplace(id) {
      return readState({ marketplaceId: id })
    },
    async upsertMarketplace(data) {
      const result = await request<{ marketplaceName: string }>('marketplace/add', {
        source: data.path.trim(),
        ...(data.trustSourceDirectory ? { trustSourceDirectory: true } : {}),
        ...(data.id ? { marketplaceName: data.id, replaceExisting: true } : {}),
        ...(data.proxyUrl !== undefined ? { proxyUrl: data.proxyUrl.trim() } : {}),
      })
      return readState({ marketplaceId: result.marketplaceName })
    },
    async deleteMarketplace(id) {
      await request('marketplace/remove', { marketplaceName: id })
      return readState()
    },
    async reorderMarketplaces() {
      throw new Error('KCoder does not support marketplace reordering.')
    },
    async installAvailablePlugin(id, options) {
      const [pluginName, marketplaceName] = String(id).split('@')
      const result = await request<{ plugin: Plugin }>('plugin/install', {
        marketplaceName,
        pluginName,
        ...(options ? { installAttemptId: options.installAttemptId } : {}),
      })
      return installed(result.plugin)
    },
    cancelInstallAttempt: installAttemptId =>
      request('plugin/install/cancel', { installAttemptId }),
    async readInstalledPluginForTrial(id) {
      const result = await request<{ plugin: Plugin }>('plugin/read', { pluginId: String(id) })
      return installed(result.plugin)
    },
    async updateInstalledPlugin(id, data) {
      if (
        data.componentStates ||
        data.displayName !== undefined ||
        data.description !== undefined
      ) {
        throw new Error(
          'KCoder supports enabling or disabling a whole plugin, not editing its components.'
        )
      }
      if (data.enabled === undefined) return this.readInstalledPluginForTrial(id)
      const result = await request<{ plugin: Plugin }>(
        data.enabled ? 'plugin/enable' : 'plugin/disable',
        { pluginId: String(id) }
      )
      return installed(result.plugin)
    },
    async uninstallInstalledPlugin(id) {
      await request('plugin/uninstall', { pluginId: String(id), purgeData: false })
    },
    async listSkills(params = {}) {
      try {
        const result = await request<{
          items: Array<{
            name: string
            description: string
            path: string
            enabled: boolean
            userInvocable: boolean
            canRemove: boolean
          }>
        }>('skills/list', { includeDisabled: params.includeDisabled ?? false })
        return result.items.map(skill => ({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          source: 'kcoder',
          enabled: skill.enabled,
          can_set_enabled: true,
          user_invocable: skill.userInvocable,
          can_remove: skill.canRemove,
        }))
      } catch (error) {
        if (
          !(error instanceof GatewayRpcError) ||
          (error.data as { kind?: string } | undefined)?.kind !== 'plugin_update_required'
        )
          throw error
      }
      assertScope()
      const result = await requestLocalExecutor<{
        success: boolean
        stdout: LocalDeviceSkill[]
        stderr: string
      }>('device.execute_command', { ...target, command_key: 'ls_skills', args: [] })
      assertScope()
      if (!result.success) throw new Error(result.stderr || 'KCoder skill listing failed')
      return result.stdout
    },
    async setSkillEnabled(name, enabled) {
      const receipt = await request<{
        name: string
        enabled: boolean
        appliesToNewConversations: boolean
      }>('skills/setEnabled', { name, enabled })
      if (
        receipt.name !== name ||
        receipt.enabled !== enabled ||
        receipt.appliesToNewConversations !== true
      )
        throw new Error(i18n.t('workbench.skill_activation_invalid_receipt'))
      return receipt
    },
    async listApps() {
      return []
    },
  }
  delete api.revalidateAvailablePlugin
  delete api.readPluginActivation
  delete api.listActivationConversations
  delete api.configurePluginCredentials
  return api
}
