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
                manifestFallback: { displayName: 'Demo tool', description: 'A useful plugin' },
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
  expect(state.marketplaceItems[0].displayName).toBe('Demo tool')
  expect(state.marketplaceItems[0].description).toBe('A useful plugin')
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

test('plugin network failures are actionable and target proxy stays on the target request', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const api = createLocalCodexPluginApi({ deviceId: 'remote', workspacePath: '/srv/project' })
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    Object.assign(new Error('git failed'), { data: { kind: 'network_reset' } })
  )
  await expect(
    api.upsertMarketplace({
      path: 'https://github.com/org/repo',
      proxyUrl: 'http://127.0.0.1:7890',
    })
  ).rejects.toThrow('当前运行目标')
  expect(requestLocalExecutor).toHaveBeenCalledWith(
    'runtime.plugins.request',
    expect.objectContaining({
      deviceId: 'remote',
      workspacePath: '/srv/project',
      method: 'marketplace/add',
      params: { source: 'https://github.com/org/repo', proxyUrl: 'http://127.0.0.1:7890' },
    })
  )
})

test('marketplace diagnostics and install policy survive the adapter', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, raw) => {
    const request = raw as { method: string; params: Record<string, unknown> }
    if (request.method === 'marketplace/refresh') {
      expect(request.params.marketplaceName).toBe('market')
      return { diagnostics: [{ message: 'Old snapshot retained' }] }
    }
    if (request.method === 'marketplace/list')
      return {
        marketplaces: [
          {
            id: 'market',
            path: '/snapshot',
            plugins: [{ pluginId: 'metadata@market', installPolicy: 'NOT_AVAILABLE', source: {} }],
          },
        ],
        diagnostics: [{ message: 'Unsupported entry' }],
      }
    if (request.method === 'plugin/list') return { plugins: [] }
    throw new Error(request.method)
  })
  const state = await createLocalCodexPluginApi().readState({
    marketplaceId: 'market',
    refresh: true,
  })
  expect(state.marketplaceItems[0].installable).toBe(false)
  expect(state.diagnostics).toEqual(['Old snapshot retained', 'Unsupported entry'])
})

test('plugin icons share an in-flight request and retain target and theme', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockResolvedValue({ url: 'data:image/png;base64,AA==' })
  const api = createLocalCodexPluginApi({ deviceId: 'remote-test', workspacePath: '/work' })
  const values = await Promise.all([
    api.readPluginIcon!('demo@market', true),
    api.readPluginIcon!('demo@market', true),
  ])
  expect(values).toEqual(['data:image/png;base64,AA==', 'data:image/png;base64,AA=='])
  expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  expect(requestLocalExecutor).toHaveBeenCalledWith(
    'runtime.plugins.request',
    expect.objectContaining({
      deviceId: 'remote-test',
      workspacePath: '/work',
      method: 'plugin/icon',
      params: { pluginId: 'demo@market', dark: true },
    })
  )
})

test('directory trust consent is capability-gated and routed to the selected target', async () => {
  const { requiredPluginCapabilities } = await import('./gatewayPluginApi')
  expect(requiredPluginCapabilities('marketplace/add', { trustSourceDirectory: true })).toContain(
    'marketplaceDirectoryTrust'
  )
  expect(requiredPluginCapabilities('marketplace/add', {})).not.toContain(
    'marketplaceDirectoryTrust'
  )
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(new Error('stop after request'))
  const api = createLocalCodexPluginApi({ deviceId: 'remote', workspacePath: '/srv/project' })
  await expect(
    api.upsertMarketplace({ path: '/srv/project/market', trustSourceDirectory: true })
  ).rejects.toThrow('stop after request')
  expect(requestLocalExecutor).toHaveBeenCalledWith(
    'runtime.plugins.request',
    expect.objectContaining({
      deviceId: 'remote',
      workspacePath: '/srv/project',
      method: 'marketplace/add',
      params: { source: '/srv/project/market', trustSourceDirectory: true },
    })
  )
})

test('trust management requires the target capability and preserves target scope', async () => {
  const { requiredPluginCapabilities } = await import('./gatewayPluginApi')
  expect(requiredPluginCapabilities('plugin/trust/list', {})).toEqual(['pluginTrustManagement'])
  expect(requiredPluginCapabilities('plugin/trust/set', { action: 'revoke' })).toEqual([
    'pluginTrustManagement',
  ])
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockResolvedValue({ entries: [], bypassActive: false })
  const api = createLocalCodexPluginApi({ deviceId: 'remote', workspacePath: '/srv/project' })
  await api.setTrust!('/srv/extensions', 'revoke')
  expect(requestLocalExecutor).toHaveBeenCalledWith(
    'runtime.plugins.request',
    expect.objectContaining({
      deviceId: 'remote',
      workspacePath: '/srv/project',
      method: 'plugin/trust/set',
      params: { path: '/srv/extensions', action: 'revoke' },
    })
  )
})

test('network error localization preserves RPC identity through the production factory', async () => {
  const { GatewayRpcError } = await import('./gatewayRpc')
  const { classifyPluginFailure } = await import('@/components/plugins/plugin-errors')
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockRejectedValue(
    new GatewayRpcError(
      'https://user:secret@host',
      -32050,
      { kind: 'network_tls' },
      'plugin-manage',
      'remote'
    )
  )
  const api = createLocalCodexPluginApi({ deviceId: 'remote' })
  const error = await api.uninstallInstalledPlugin('demo@market').catch(error => error)
  expect(error).toBeInstanceOf(GatewayRpcError)
  expect(classifyPluginFailure(error)).toMatchObject({
    code: 'tls',
    phase: 'plugin-manage',
    retryable: false,
  })
  expect(error.message).not.toContain('secret')
})

test('cancellation targets its install attempt and does not announce a plugin mutation', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const invalidated = vi.fn()
  window.addEventListener('kcoder:tools-catalog-invalidated', invalidated)
  try {
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({ cancellationRequested: true })
    const api = createLocalCodexPluginApi()
    expect(await api.cancelInstallAttempt?.('attempt-one')).toEqual({ cancellationRequested: true })
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
      method: 'plugin/install/cancel',
      params: { installAttemptId: 'attempt-one' },
    })
    expect(invalidated).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('kcoder:tools-catalog-invalidated', invalidated)
  }
})

test('an invalidated plugin scope rejects queued writes and ignores late mutation replies', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  let active = true
  const api = createLocalCodexPluginApi({ deviceId: 'alpha', isScopeCurrent: () => active })
  let finish: (value: unknown) => void = () => {}
  vi.mocked(requestLocalExecutor).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = api.uninstallInstalledPlugin('demo@market')
  active = false
  finish({})
  await expect(pending).rejects.toMatchObject({ data: { kind: 'plugin_scope_changed' } })
  const calls = vi.mocked(requestLocalExecutor).mock.calls.length
  await expect(api.installAvailablePlugin('demo@market')).rejects.toMatchObject({
    data: { kind: 'plugin_scope_changed' },
  })
  expect(requestLocalExecutor).toHaveBeenCalledTimes(calls)
  expect(vi.mocked(requestLocalExecutor).mock.calls[0][1]).not.toHaveProperty('isScopeCurrent')
})
