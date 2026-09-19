import { afterEach, expect, test, vi } from 'vitest'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { requestLocalExecutor } from '@/tauri/localExecutor'

vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
}))

afterEach(() => {
  document.head.innerHTML = ''
  vi.resetAllMocks()
})

test('successful plugin mutations invalidate presentation but failures do not', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const invalidated = vi.fn()
  window.addEventListener('kcoder:tools-catalog-invalidated', invalidated)
  try {
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({})
    const api = createLocalCodexPluginApi()
    await api.uninstallInstalledPlugin('demo@market')
    expect(invalidated).toHaveBeenCalledTimes(1)
    vi.mocked(requestLocalExecutor).mockRejectedValueOnce(new Error('denied'))
    await expect(api.uninstallInstalledPlugin('demo@market')).rejects.toThrow('denied')
    expect(invalidated).toHaveBeenCalledTimes(1)
  } finally {
    window.removeEventListener('kcoder:tools-catalog-invalidated', invalidated)
  }
})

test('the production plugin factory uses native KCoder marketplace and inventory contracts', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const inventory = {
    id: 'demo@market',
    name: 'demo',
    enabled: true,
    root: '/store/demo',
    version: '1',
    components: [
      {
        kind: 'skill',
        name: 'demo-skill',
        path: '/store/demo/skills/demo/SKILL.md',
        description: 'Demo skill',
      },
      { kind: 'mcp', name: 'demo-search' },
    ],
  }
  vi.mocked(requestLocalExecutor).mockImplementation(async (method, raw) => {
    expect(method).toBe('runtime.plugins.request')
    const request = raw as { method: string; params: Record<string, unknown> }
    if (request.method === 'marketplace/add') {
      expect(request.params).toEqual({ source: 'https://github.com/example/market.git' })
      return { marketplaceName: 'market' }
    }
    if (request.method === 'marketplace/list')
      return {
        marketplaces: [
          {
            id: 'market',
            path: '/managed/market',
            plugins: [
              {
                pluginId: 'demo@market',
                source: { type: 'local', path: '/demo' },
                installPolicy: 'available',
              },
            ],
          },
        ],
        diagnostics: [],
      }
    if (request.method === 'plugin/list') {
      expect(request.params).toEqual({ all: true })
      return { plugins: [inventory] }
    }
    if (request.method === 'plugin/install') {
      expect(request.params).toEqual({ pluginName: 'demo', marketplaceName: 'market' })
      return { plugin: inventory }
    }
    if (request.method === 'plugin/disable') {
      expect(request.params).toEqual({ pluginId: inventory.id })
      return { plugin: { ...inventory, enabled: false } }
    }
    throw new Error(`unexpected ${request.method}`)
  })
  const api = createLocalCodexPluginApi()
  expect(api.supportsAuthoring).toBe(false)
  const state = await api.upsertMarketplace({ path: 'https://github.com/example/market.git' })
  expect(state.selectedMarketplaceId).toBe('market')
  expect(state.marketplaceItems[0].id).toBe('demo@market')
  expect(state.installedPlugins[0].spec.enabled).toBe(true)
  expect(state.installedPlugins[0].spec.components.skills[0].name).toBe('demo-skill')
  expect(state.marketplaceItems[0].components.mcps).toEqual([{ name: 'demo-search', server: {} }])
  expect((await api.installAvailablePlugin('demo@market')).metadata.labels).toEqual({
    id: 'demo@market',
  })
  expect((await api.updateInstalledPlugin('demo@market', { enabled: false })).spec.enabled).toBe(
    false
  )
})

test('plugin mutations and skill listing retain the explicitly selected remote workspace', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockResolvedValue({ success: true, stdout: [], stderr: '' })
  const api = createLocalCodexPluginApi({ deviceId: 'remote', workspacePath: '/srv/project' })
  await api.uninstallInstalledPlugin('demo@market')
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/srv/project',
    method: 'plugin/uninstall',
    params: { pluginId: 'demo@market', purgeData: false },
  })
  await api.listSkills()
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('device.execute_command', {
    deviceId: 'remote',
    workspacePath: '/srv/project',
    command_key: 'ls_skills',
    args: [],
  })
})
