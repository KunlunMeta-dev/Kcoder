import { afterEach, expect, test, vi } from 'vitest'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { GatewayRpcError } from './gatewayRpc'

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
                manifestFallback: {
                  displayName: 'Demo tool',
                  description: 'A useful plugin',
                  interface: {
                    logo: 'https://cdn.example/logo.svg',
                    logoDark: 'https://cdn.example/dark.svg',
                  },
                },
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
  expect(state.marketplaceItems[0].interface).toMatchObject({
    logo: 'https://cdn.example/logo.svg',
    logoDark: 'https://cdn.example/dark.svg',
  })
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
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce({ items: [] })
  await api.listSkills()
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/srv/project',
    method: 'skills/list',
    params: { includeDisabled: false },
  })
})

test('disabled skills remain visible in management and activation retains target ownership', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const invalidated = vi.fn()
  window.addEventListener('kcoder:tools-catalog-invalidated', invalidated)
  try {
    const api = createLocalCodexPluginApi({
      deviceId: 'account-target',
      workspacePath: '/work/project',
    })
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({
      items: [
        {
          name: 'plugin:demo:market:command:review',
          description: 'Plugin skill',
          path: '/owned/materialized/SKILL.md',
          enabled: false,
          userInvocable: true,
          canRemove: false,
        },
      ],
    })
    expect(await api.listSkills({ includeDisabled: true })).toEqual([
      expect.objectContaining({ enabled: false, can_set_enabled: true, can_remove: false }),
    ])
    expect(invalidated).not.toHaveBeenCalled()
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({
      name: 'plugin:demo:market:command:review',
      enabled: true,
      appliesToNewConversations: true,
    })
    await api.setSkillEnabled!('plugin:demo:market:command:review', true)
    expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.plugins.request', {
      deviceId: 'account-target',
      workspacePath: '/work/project',
      method: 'skills/setEnabled',
      params: { name: 'plugin:demo:market:command:review', enabled: true },
    })
    expect(invalidated).toHaveBeenCalledTimes(1)
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce({
      name: 'different',
      enabled: true,
      appliesToNewConversations: true,
    })
    await expect(api.setSkillEnabled!('requested', true)).rejects.toThrow()
  } finally {
    window.removeEventListener('kcoder:tools-catalog-invalidated', invalidated)
  }
})

test('older targets retain read-only skill inventory while real errors are propagated', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const api = createLocalCodexPluginApi({ deviceId: 'old-target', workspacePath: '/work' })
  vi.mocked(requestLocalExecutor)
    .mockRejectedValueOnce(
      new GatewayRpcError('Upgrade required', -32000, { kind: 'plugin_update_required' })
    )
    .mockResolvedValueOnce({
      success: true,
      stdout: [{ name: 'legacy', path: '/work/SKILL.md', description: 'Legacy', source: 'kcoder' }],
      stderr: '',
    })
  const items = await api.listSkills({ includeDisabled: true })
  expect(items[0].can_set_enabled).toBeUndefined()
  expect(requestLocalExecutor).toHaveBeenLastCalledWith(
    'device.execute_command',
    expect.objectContaining({ deviceId: 'old-target', command_key: 'ls_skills' })
  )
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(new Error('Connection lost'))
  await expect(api.listSkills({ includeDisabled: true })).rejects.toThrow('Connection lost')
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

test('requires explicit hosted marketplace support before registering Qoder', async () => {
  const { requiredPluginCapabilities } = await import('./gatewayPluginApi')
  expect(
    requiredPluginCapabilities('marketplace/add', { source: 'https://qoder.com/marketplace' })
  ).toContain('hostedPluginMarketplacesV1')
  expect(
    requiredPluginCapabilities('marketplace/add', { source: 'https://github.com/openai/plugins' })
  ).not.toContain('hostedPluginMarketplacesV1')
})

test('requires TRAE CN marketplace support before adding its official catalog', async () => {
  const { requiredPluginCapabilities } = await import('./gatewayPluginApi')
  expect(
    requiredPluginCapabilities('marketplace/add', { source: 'https://work.trae.cn/marketplace' })
  ).toEqual(['hostedPluginMarketplacesV1', 'traeCnPluginMarketplaceV1'])
})

test('searches the displayed localized marketplace name and switches language', async () => {
  const { default: i18n } = await import('@/i18n')
  const previous = i18n.language
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, raw) => {
    if ((raw as { method: string }).method === 'plugin/list') return { plugins: [] }
    return {
      diagnostics: [],
      marketplaces: [
        {
          id: 'market',
          path: '/market',
          plugins: [
            {
              pluginId: 'teacher@market',
              source: { type: 'trae', id: 'teacher', version: '1.0' },
              manifestFallback: {
                displayName: 'Teacher assistant',
                displayNameZh: '教学管理助理',
                description: 'Unrelated description',
                descriptionZh: '用于教学分析',
              },
            },
          ],
        },
      ],
    }
  })
  try {
    const api = createLocalCodexPluginApi()
    await i18n.changeLanguage('zh-CN')
    const zh = await api.readState({ q: '教学管理助理' })
    expect(zh.marketplaceItems).toHaveLength(1)
    expect(zh.marketplaceItems[0].description).toBe('用于教学分析')
    await i18n.changeLanguage('en')
    const en = await api.readState({ q: 'Teacher assistant' })
    expect(en.marketplaceItems).toHaveLength(1)
    expect(en.marketplaceItems[0].displayName).toBe('Teacher assistant')
    expect(en.marketplaceItems[0].description).toBe('Unrelated description')
  } finally {
    await i18n.changeLanguage(previous)
  }
})

test('icon reads stay read-only and successful mutations invalidate cached icons', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  let url = 'https://cdn.example/catalog.svg'
  const invalidated = vi.fn()
  window.addEventListener('kcoder:tools-catalog-invalidated', invalidated)
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, raw) => {
    if ((raw as { method: string }).method === 'plugin/icon') return { url }
    return {}
  })
  try {
    const api = createLocalCodexPluginApi()
    expect(await api.readPluginIcon!('demo@market', false)).toBe(url)
    expect(invalidated).not.toHaveBeenCalled()
    const before = vi.mocked(requestLocalExecutor).mock.calls.length
    await api.readPluginIcon!('demo@market', false)
    expect(vi.mocked(requestLocalExecutor)).toHaveBeenCalledTimes(before)
    await api.uninstallInstalledPlugin('demo@market')
    url = 'https://cdn.example/new.svg'
    expect(await api.readPluginIcon!('demo@market', false)).toBe(url)
    expect(invalidated).toHaveBeenCalledTimes(1)
    expect(vi.mocked(requestLocalExecutor)).toHaveBeenCalledTimes(before + 2)
  } finally {
    window.removeEventListener('kcoder:tools-catalog-invalidated', invalidated)
  }
})

test('plugin lifecycle methods exist only after actual target capability negotiation', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  let upgraded = false
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, raw) => {
    const input = raw as { method: string; params: Record<string, unknown> }
    if (input.method === 'marketplace/list')
      return {
        marketplaces: [],
        diagnostics: [],
        ...(upgraded
          ? {
              lifecycleCapabilities: {
                revalidation: true,
                privateCredentials: true,
                activation: true,
              },
            }
          : {}),
      }
    if (input.method === 'plugin/list') return { plugins: [] }
    if (input.method === 'plugin/activation/read')
      return { generation: 1, phase: 'unknown', components: [] }
    if (input.method === 'plugin/credentials/configure')
      return { generation: 1, missingNames: [], effectiveFrom: 'next_turn' }
    if (input.method === 'plugin/revalidate') return {}
    throw new Error(`unexpected ${input.method}`)
  })
  const api = createLocalCodexPluginApi()
  expect(api.revalidateAvailablePlugin).toBeUndefined()
  await api.readState()
  expect(api.configurePluginCredentials).toBeUndefined()
  expect(api.readPluginActivation).toBeUndefined()
  upgraded = true
  await api.readState()
  await api.revalidateAvailablePlugin!('demo@market', { revalidationAttemptId: 'owned-revalidate' })
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.plugins.request', {
    method: 'plugin/revalidate',
    params: {
      pluginName: 'demo',
      marketplaceName: 'market',
      revalidationAttemptId: 'owned-revalidate',
    },
  })
  await api.configurePluginCredentials!(
    'demo@market',
    { TOKEN: 'synthetic' },
    {
      expectedOperationId: 'abc',
      expectedGeneration: 1,
    }
  )
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.plugins.request', {
    method: 'plugin/credentials/configure',
    params: {
      pluginId: 'demo@market',
      values: { TOKEN: 'synthetic' },
      expectedOperationId: 'abc',
      expectedGeneration: 1,
    },
  })
  await api.readPluginActivation!('demo@market')
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.plugins.request', {
    method: 'plugin/activation/read',
    params: { pluginId: 'demo@market' },
  })
  upgraded = false
  await api.readState()
  expect(api.revalidateAvailablePlugin).toBeUndefined()
  expect(api.configurePluginCredentials).toBeUndefined()
})

test('failure of an invalidated icon request cannot evict its newer replacement', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  let rejectOld!: (error: Error) => void
  let finishNew!: (result: unknown) => void
  let icons = 0
  vi.mocked(requestLocalExecutor).mockImplementation((_method, raw) => {
    if ((raw as { method: string }).method !== 'plugin/icon') return Promise.resolve({})
    ++icons
    return new Promise((resolve, reject) => {
      if (icons === 1) rejectOld = reject
      else finishNew = resolve
    })
  })
  const api = createLocalCodexPluginApi()
  const old = api.readPluginIcon!('owned@market', false)
  await api.configureAutoProxy!(false)
  const newer = api.readPluginIcon!('owned@market', false)
  rejectOld(new Error('old connection failed'))
  await old
  const shared = api.readPluginIcon!('owned@market', false)
  expect(icons).toBe(2)
  finishNew({ url: 'https://icons.test/new.svg' })
  expect(await Promise.all([newer, shared])).toEqual([
    'https://icons.test/new.svg',
    'https://icons.test/new.svg',
  ])
})

test('icon request bursts preserve the four-request limit and release slots after errors', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  let active = 0,
    peak = 0
  vi.mocked(requestLocalExecutor).mockImplementation(() => {
    ++active
    peak = Math.max(peak, active)
    return new Promise((resolve, reject) => pending.push({ resolve, reject })).finally(() => {
      --active
    })
  })
  const api = createLocalCodexPluginApi()
  const reads = Array.from({ length: 9 }, (_, index) =>
    api.readPluginIcon!(`icon-${index}@market`, false)
  )
  expect(pending).toHaveLength(4)
  pending[0].reject(new Error('first failed'))
  await reads[0]
  expect(pending).toHaveLength(5)
  for (let index = 1; index < 9; ++index) {
    pending[index].resolve({ url: 'https://icons.test/ok.svg' })
    await reads[index]
  }
  expect(await Promise.all(reads)).toEqual([null, ...Array(8).fill('https://icons.test/ok.svg')])
  expect(peak).toBe(4)
  expect(active).toBe(0)
})
