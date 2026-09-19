import { requestLocalExecutor } from '@/tauri/localExecutor'
import type { LocalCodexPluginApi, LocalCodexPluginsState } from '@/api/local/codexPlugins'
import type {
  InstalledPlugin,
  InstalledPluginComponents,
  LocalDeviceSkill,
  PluginMarketplaceItem,
} from '@/types/api'

export const PLUGIN_RPC_METHODS = new Set([
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
  'plugin/list',
  'plugin/read',
  'plugin/install',
  'plugin/uninstall',
  'plugin/enable',
  'plugin/disable',
  'marketplace/list',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/refresh',
])

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
  target?: { deviceId?: string; workspacePath?: string }
): LocalCodexPluginApi {
  let selectedId = ''
  const request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    const result = await requestLocalExecutor<T>('runtime.plugins.request', {
      ...target,
      method,
      params,
    })
    if (!['plugin/list', 'plugin/read', 'marketplace/list'].includes(method))
      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
    return result
  }
  const readState: LocalCodexPluginApi['readState'] = async (params = {}) => {
    if (params.refresh) await request('marketplace/refresh')
    const [catalog, inventory] = await Promise.all([
      request<{ marketplaces: Marketplace[]; diagnostics: Array<{ message: string }> }>(
        'marketplace/list'
      ),
      request<{ plugins: Plugin[] }>('plugin/list', { all: true }),
    ])
    const selected = params.marketplaceId ?? selectedId
    selectedId = catalog.marketplaces.some(m => m.id === selected)
      ? selected
      : (catalog.marketplaces[0]?.id ?? '')
    const byId = new Map(inventory.plugins.map(p => [p.id, p]))
    const marketplaceItems: PluginMarketplaceItem[] = catalog.marketplaces
      .filter(m => !selectedId || m.id === selectedId)
      .flatMap(m =>
        m.plugins.map(p => {
          const existing = byId.get(p.pluginId)
          const fallback = p.manifestFallback ?? {}
          const name = p.pluginId.split('@')[0]
          return {
            id: p.pluginId,
            remotePluginId: p.pluginId,
            name,
            displayName: typeof fallback.name === 'string' ? fallback.name : name,
            description: typeof fallback.description === 'string' ? fallback.description : '',
            version: p.version,
            visibility: 'personal' as const,
            featured: false,
            installed: Boolean(existing),
            installedPluginId: existing?.id ?? null,
            enabled: existing?.enabled ?? false,
            sourceType: 'marketplace' as const,
            components: components(existing),
            manifest: { ...fallback, source: p.source, installPolicy: p.installPolicy },
            ownerUserId: 0,
          }
        })
      )
      .filter(
        p =>
          !params.q || `${p.name} ${p.description}`.toLowerCase().includes(params.q.toLowerCase())
      )
    return {
      marketplaceItems,
      installedPlugins: inventory.plugins.map(installed),
      marketplaces: catalog.marketplaces.map(m => ({
        id: m.id,
        name: m.displayName ?? m.id,
        path: m.path,
      })),
      selectedMarketplaceId: selectedId,
      marketplacePath: catalog.marketplaces.find(m => m.id === selectedId)?.path ?? '',
      installRegistryPath: '',
    } satisfies LocalCodexPluginsState
  }
  return {
    ...base,
    supportsAuthoring: false,
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
      if (data.id) {
        const current = (await readState()).marketplaces.find(m => m.id === data.id)
        if (current?.path === data.path.trim()) return readState({ marketplaceId: data.id })
        throw new Error('Remove the existing marketplace before replacing its source.')
      }
      const result = await request<{ marketplaceName: string }>('marketplace/add', {
        source: data.path.trim(),
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
    async installAvailablePlugin(id) {
      const [pluginName, marketplaceName] = String(id).split('@')
      const result = await request<{ plugin: Plugin }>('plugin/install', {
        marketplaceName,
        pluginName,
      })
      return installed(result.plugin)
    },
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
    async listSkills() {
      const result = await requestLocalExecutor<{
        success: boolean
        stdout: LocalDeviceSkill[]
        stderr: string
      }>('device.execute_command', { ...target, command_key: 'ls_skills', args: [] })
      if (!result.success) throw new Error(result.stderr || 'KCoder skill listing failed')
      return result.stdout
    },
    async listApps() {
      return []
    },
  }
}
