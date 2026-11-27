import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { requestLocalExecutor } from '@/host/localExecutor'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { fetchGatewayServers, GatewayRpcError } from './gatewayRpc'
import { KCoderPluginManagementWorkspace } from './KCoderPluginManagementWorkspace'

const { gatewayServers } = vi.hoisted(() => ({ gatewayServers: vi.fn() }))
vi.mock('./gatewayRpc', async importOriginal => {
  const actual = await importOriginal<typeof import('./gatewayRpc')>()
  return { ...actual, fetchGatewayServers: gatewayServers }
})
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/api/local/codexPlugins', () => ({ createLocalCodexPluginApi: vi.fn() }))
const readState = vi.fn()
const listSkills = vi.fn()
const updateInstalledPlugin = vi.fn()
const uninstallInstalledPlugin = vi.fn()
const setSkillEnabled = vi.fn()
const plugin = {
  metadata: { name: 'demo', labels: { id: 'demo@market' } },
  spec: {
    displayName: 'Installed demo',
    description: 'Native plugin',
    enabled: true,
    components: { mcps: [{ name: 'native-search' }], hooks: [{ name: 'UserPromptSubmit' }] },
  },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchGatewayServers).mockResolvedValue([])
  vi.mocked(requestLocalExecutor).mockResolvedValue({
    servers: [{ name: 'native-search', transport: 'http', authorization: 'notAuthorized' }],
  })
  readState.mockResolvedValue({
    installedPlugins: [plugin],
    marketplaces: [],
    marketplaceItems: [],
  })
  listSkills.mockResolvedValue([
    {
      name: 'native-skill',
      description: 'Real target inventory',
      path: '/remote/skills/native-skill/SKILL.md',
      source: 'kcoder',
      can_remove: true,
      can_set_enabled: true,
      enabled: true,
    },
  ])
  vi.mocked(createLocalCodexPluginApi).mockReturnValue({
    readState,
    listSkills,
    updateInstalledPlugin,
    uninstallInstalledPlugin,
    setSkillEnabled,
  } as unknown as ReturnType<typeof createLocalCodexPluginApi>)
})

afterEach(() => {
  document
    .querySelectorAll('meta[name="kcoder-rpc-token"][content="test-gateway"]')
    .forEach(node => node.remove())
})

const gatewayTargets = [
  {
    id: 'alpha',
    label: 'Alpha',
    description: 'Local target',
    runtime: 'kcoder' as const,
    transport: 'local' as const,
    workspacePath: '/alpha/configured-workspace',
  },
  {
    id: 'beta',
    label: 'Beta',
    description: 'SSH target',
    runtime: 'kcoder' as const,
    transport: 'ssh' as const,
    workspacePath: '/beta/configured-workspace',
  },
]

function gatewayWorkbench(): WorkbenchContextValue {
  return {
    state: {
      currentRuntimeTask: {
        deviceId: 'beta',
        taskId: 'active-task',
        workspacePath: '/beta/current-task',
      },
      currentProject: null,
      runtimeWork: null,
      selectedDeviceWorkspaceId: null,
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
    },
  } as WorkbenchContextValue
}

function useGatewayPage() {
  document.head.insertAdjacentHTML(
    'beforeend',
    '<meta name="kcoder-rpc-token" content="test-gateway">'
  )
}

test('defaults plugin management to the local host rather than the remote conversation', async () => {
  useGatewayPage()
  vi.mocked(fetchGatewayServers).mockResolvedValue(gatewayTargets)

  render(
    <WorkbenchContext.Provider value={gatewayWorkbench()}>
      <KCoderPluginManagementWorkspace
        targetDeviceId="beta"
        targetWorkspacePath="/beta/current-task"
      />
    </WorkbenchContext.Provider>
  )

  await waitFor(() => expect(screen.getByTestId('kcoder-plugin-target-select')).toHaveValue('alpha'))
  await waitFor(() => expect(readState).toHaveBeenCalled())
  expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
  expect(createLocalCodexPluginApi).toHaveBeenCalledWith({ deviceId: 'alpha', workspacePath: '/alpha/configured-workspace', isScopeCurrent: expect.any(Function) })

})

test('opens target trust management only from an explicit management action and restores focus on close', async () => {
  const listTrust = vi.fn().mockResolvedValue({ entries: [], bypassActive: false })
  const api = vi.mocked(createLocalCodexPluginApi).getMockImplementation()!()
  vi.mocked(createLocalCodexPluginApi).mockReturnValue({ ...api, listTrust })
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" targetWorkspacePath="/remote/project" />)
  await screen.findByText('Installed demo')
  expect(listTrust).not.toHaveBeenCalled()
  const open = screen.getByTestId('plugins-trust-manage-button')
  fireEvent.click(open)
  await waitFor(() => expect(listTrust).toHaveBeenCalledOnce())
  const manager = screen.getByTestId('plugin-trust-manager')
  expect(manager).toHaveTextContent('remote')
  fireEvent.click(within(manager).getByRole('button', { name: '关闭' }))
  expect(screen.queryByTestId('plugin-trust-manager')).not.toBeInTheDocument()
  await waitFor(() => expect(open).toHaveFocus())
})

test('uses the selected target and never carries another task workspace across targets', async () => {
  useGatewayPage()
  vi.mocked(fetchGatewayServers).mockResolvedValue(gatewayTargets)

  render(
    <WorkbenchContext.Provider value={gatewayWorkbench()}>
      <KCoderPluginManagementWorkspace
        targetDeviceId="beta"
        targetWorkspacePath="/beta/current-task"
      />
    </WorkbenchContext.Provider>
  )

  fireEvent.change(await screen.findByTestId('kcoder-plugin-target-select'), {
    target: { value: 'alpha' },
  })

  await screen.findByText('Installed demo')
  expect(createLocalCodexPluginApi).toHaveBeenCalledWith({
    deviceId: 'alpha',
    workspacePath: '/alpha/configured-workspace',
    isScopeCurrent: expect.any(Function),
  })
  expect(screen.getByTestId('kcoder-plugin-current-target')).toHaveTextContent('Beta (beta)')
  expect(screen.getByTestId('plugins-install-target')).toHaveTextContent(
    '/alpha/configured-workspace'
  )

  fireEvent.change(screen.getByTestId('kcoder-plugin-target-select'), {
    target: { value: 'beta' },
  })
  await waitFor(() =>
    expect(createLocalCodexPluginApi).toHaveBeenLastCalledWith({
      deviceId: 'beta',
      workspacePath: '/beta/current-task',
      isScopeCurrent: expect.any(Function),
    })
  )
  expect(screen.getByTestId('plugins-install-target')).toHaveTextContent('/beta/current-task')
})

test('skill toggle persists activation while retaining the row and independent plugin ownership', async () => {
  render(
    <KCoderPluginManagementWorkspace
      targetDeviceId="remote"
      targetWorkspacePath="/remote/project"
    />
  )
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  expect(listSkills).toHaveBeenCalledWith({ includeDisabled: true })
  const toggle = screen.getByTestId('kcoder-skill-toggle')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  let complete!: () => void
  setSkillEnabled.mockReturnValueOnce(
    new Promise<void>(resolve => {
      complete = resolve
    })
  )
  fireEvent.click(toggle)
  expect(toggle).toBeDisabled()
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  listSkills.mockResolvedValue([
    {
      name: 'native-skill',
      description: 'Real target inventory',
      path: '/remote/skills/native-skill/SKILL.md',
      source: 'kcoder',
      can_remove: true,
      can_set_enabled: true,
      enabled: false,
    },
  ])
  await act(async () => complete())
  await waitFor(() =>
    expect(screen.getByTestId('kcoder-skill-toggle')).toHaveAttribute('aria-checked', 'false')
  )
  expect(setSkillEnabled).toHaveBeenCalledWith('native-skill', false)
  expect(screen.getByText('native-skill')).toBeInTheDocument()
  expect(screen.getByTestId('kcoder-skill-remove')).toBeEnabled()
  expect(screen.getByTestId('kcoder-skill-activation-timing')).toHaveTextContent(
    /新会话|New conversations/
  )
  expect(updateInstalledPlugin).not.toHaveBeenCalled()
  expect(uninstallInstalledPlugin).not.toHaveBeenCalled()
})

test('failed skill activation keeps the confirmed state and exposes a retryable error', async () => {
  setSkillEnabled.mockRejectedValueOnce(new Error('Target settings are busy'))
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  fireEvent.click(screen.getByTestId('kcoder-skill-toggle'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Target settings are busy')
  expect(screen.getByTestId('kcoder-skill-toggle')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByTestId('kcoder-skill-toggle')).toBeEnabled()
})

test('a confirmed skill receipt stays visible when refresh fails, and refresh can recover', async () => {
  let complete!: () => void
  setSkillEnabled.mockReturnValueOnce(
    new Promise<void>(resolve => {
      complete = resolve
    })
  )
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  listSkills.mockRejectedValueOnce(new Error('Refresh connection lost'))
  fireEvent.click(screen.getByTestId('kcoder-skill-toggle'))
  expect(screen.getByTestId('kcoder-skill-toggle')).toHaveAttribute('aria-checked', 'true')
  await act(async () => complete())
  expect(await screen.findByRole('alert')).toHaveTextContent(/已保存|was saved/)
  expect(screen.getByTestId('kcoder-skill-toggle')).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByTestId('kcoder-skill-toggle')).toBeEnabled()
  listSkills.mockResolvedValueOnce([
    {
      name: 'native-skill',
      enabled: false,
      can_set_enabled: true,
      description: 'Recovered inventory',
      path: '/remote/skills/native-skill/SKILL.md',
      source: 'kcoder',
    },
  ])
  fireEvent.click(screen.getByTestId('kcoder-plugins-refresh'))
  await screen.findByText('Recovered inventory')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(setSkillEnabled).toHaveBeenCalledTimes(1)
})

test('a late skill save from the previous target cannot replace the current target state', async () => {
  let finish!: () => void
  const previous = new Promise<void>(resolve => {
    finish = resolve
  })
  const firstSave = vi.fn(() => previous)
  const currentSave = vi.fn()
  vi.mocked(createLocalCodexPluginApi).mockImplementation(
    target =>
      ({
        readState: async () => ({ installedPlugins: [], marketplaces: [], marketplaceItems: [] }),
        listSkills: async () => [
          {
            name: 'same-skill',
            description: target?.deviceId,
            path: `/${target?.deviceId}/SKILL.md`,
            source: 'kcoder',
            enabled: true,
            can_set_enabled: true,
          },
        ],
        setSkillEnabled: target?.deviceId === 'previous' ? firstSave : currentSave,
      }) as unknown as ReturnType<typeof createLocalCodexPluginApi>
  )
  const view = render(<KCoderPluginManagementWorkspace targetDeviceId="previous" />)
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  await screen.findByText('previous')
  fireEvent.click(screen.getByTestId('kcoder-skill-toggle'))
  view.rerender(<KCoderPluginManagementWorkspace targetDeviceId="current" />)
  await screen.findByText('current')
  await act(async () => {
    finish()
    await previous
  })
  expect(screen.getByTestId('kcoder-skill-toggle')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByTestId('kcoder-skill-toggle')).toBeEnabled()
  expect(firstSave).toHaveBeenCalledWith('same-skill', false)
  expect(currentSave).not.toHaveBeenCalled()
})

test('plugin ownership comes from the actual declared source instead of a spoofed skill name', async () => {
  readState.mockResolvedValue({
    installedPlugins: [
      {
        ...plugin,
        spec: {
          ...plugin.spec,
          components: {
            ...plugin.spec.components,
            skills: [{ name: 'real-plugin-skill', path: '/plugin/demo/skills' }],
          },
        },
      },
    ],
    marketplaces: [],
    marketplaceItems: [],
  })
  listSkills.mockResolvedValue([
    {
      name: 'real-plugin-skill',
      description: 'Actual plugin source',
      path: '/plugin/demo/skills/tool/SKILL.md',
      source: 'kcoder',
      enabled: true,
      can_set_enabled: true,
    },
    {
      name: 'plugin:demo:market:command:spoof',
      description: 'User source',
      path: '/user/skills/spoof/SKILL.md',
      source: 'kcoder',
      enabled: true,
      can_set_enabled: true,
    },
  ])
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  const real = screen.getByText('real-plugin-skill').closest('article')!
  const spoof = screen.getByText('plugin:demo:market:command:spoof').closest('article')!
  expect(within(real).getByText(/Installed demo/)).toBeInTheDocument()
  expect(within(spoof).queryByText(/Installed demo/)).not.toBeInTheDocument()
})

test('uses native target inventory for plugins, skills, MCP and hooks', async () => {
  render(
    <KCoderPluginManagementWorkspace
      targetDeviceId="remote"
      targetWorkspacePath="/remote/project"
    />
  )
  await screen.findByText('Installed demo')
  expect(createLocalCodexPluginApi).toHaveBeenCalledWith({
    deviceId: 'remote',
    workspacePath: '/remote/project',
    isScopeCurrent: expect.any(Function),
  })
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  expect(screen.getByText('native-skill')).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
  expect(await screen.findByText('native-search')).toBeInTheDocument()
  expect(screen.getByTestId('kcoder-plugin-tab-mcp')).toHaveFocus()
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-hooks'))
  expect(screen.getByText('UserPromptSubmit')).toBeInTheDocument()
})

test('toggles and confirms uninstall through the owning native plugin', async () => {
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-toggle-demo@market'))
  await waitFor(() =>
    expect(updateInstalledPlugin).toHaveBeenCalledWith('demo@market', { enabled: false })
  )
  await waitFor(() =>
    expect(screen.getByTestId('kcoder-plugin-uninstall-demo@market')).toBeEnabled()
  )
  fireEvent.click(screen.getByTestId('kcoder-plugin-uninstall-demo@market'))
  expect(uninstallInstalledPlugin).not.toHaveBeenCalled()
  readState.mockResolvedValue({ installedPlugins: [], marketplaces: [], marketplaceItems: [] })
  fireEvent.click(screen.getByTestId('kcoder-plugin-confirm-uninstall-demo@market'))
  await waitFor(() => expect(uninstallInstalledPlugin).toHaveBeenCalledWith('demo@market'))
  await waitFor(() => expect(screen.queryByText('Installed demo')).not.toBeInTheDocument())
})

test('search filters each inventory and Hooks can open their owning plugin', async () => {
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  const search = screen.getByTestId('kcoder-plugin-search')
  fireEvent.change(search, { target: { value: 'missing' } })
  expect(screen.queryByTestId('kcoder-plugin-row-demo@market')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  expect(screen.queryByTestId('kcoder-skill-row')).not.toBeInTheDocument()
  fireEvent.change(search, { target: { value: 'native-skill' } })
  expect(screen.getByTestId('kcoder-skill-row')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-mcp'))
  await waitFor(() => expect(screen.getByTestId('kcoder-plugin-tab-mcp')).toHaveTextContent('(1)'))
  expect(screen.queryByText('native-search')).not.toBeInTheDocument()
  fireEvent.change(search, { target: { value: 'native-search' } })
  expect(await screen.findByText('native-search')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-hooks'))
  fireEvent.change(search, { target: { value: 'UserPromptSubmit' } })
  const hook = screen.getByText('UserPromptSubmit').closest('article')!
  fireEvent.click(within(hook).getByRole('button'))
  expect(screen.getByTestId('kcoder-plugin-tab-plugins')).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByTestId('kcoder-plugin-row-demo@market')).toBeInTheDocument()
})

test('plugin details are read-only and return focus to their menu trigger', async () => {
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-actions-demo@market'))
  fireEvent.click(await screen.findByTestId('kcoder-plugin-details-demo@market'))
  expect(screen.getByTestId('kcoder-plugin-details')).toHaveTextContent('native-search')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByTestId('kcoder-plugin-details')).not.toBeInTheDocument()
  expect(updateInstalledPlugin).not.toHaveBeenCalled()
})

test('shows inventory failures instead of pretending the target has no extensions', async () => {
  readState.mockRejectedValue(new Error('Remote target is unavailable'))
  render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Remote target is unavailable')
  expect(screen.queryByTestId('kcoder-plugin-row-demo@market')).not.toBeInTheDocument()
})

test('changing target discards late inventory from the previous host', async () => {
  let finishPrevious!: (value: unknown) => void
  const previous = new Promise(resolve => {
    finishPrevious = resolve
  })
  vi.mocked(createLocalCodexPluginApi).mockImplementation(
    target =>
      ({
        readState: () =>
          target?.deviceId === 'previous'
            ? previous
            : Promise.resolve({
                installedPlugins: [
                  { ...plugin, spec: { ...plugin.spec, displayName: 'New host plugin' } },
                ],
                marketplaces: [],
                marketplaceItems: [],
              }),
        listSkills: async () => [],
      }) as unknown as ReturnType<typeof createLocalCodexPluginApi>
  )
  const view = render(<KCoderPluginManagementWorkspace targetDeviceId="previous" />)
  view.rerender(<KCoderPluginManagementWorkspace targetDeviceId="current" />)
  await screen.findByText('New host plugin')
  await act(async () => {
    finishPrevious({ installedPlugins: [plugin], marketplaces: [], marketplaceItems: [] })
    await previous
  })
  expect(screen.queryByText('Installed demo')).not.toBeInTheDocument()
  expect(screen.getByText('New host plugin')).toBeInTheDocument()
})

test('preserves the selected management tab when the target resolves or changes', async () => {
  const view = render(<KCoderPluginManagementWorkspace />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-mcp'))
  await screen.findByText('native-search')
  view.rerender(
    <KCoderPluginManagementWorkspace
      targetDeviceId="remote"
      targetWorkspacePath="/remote/project"
    />
  )
  await screen.findByText('native-search')
  expect(screen.getByTestId('kcoder-plugin-tab-mcp')).toHaveAttribute('aria-selected', 'true')
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/remote/project',
    method: 'mcp/list',
    params: {},
  })
})

test('removes a user skill through the selected target and refreshes the inventory', async () => {
  render(
    <KCoderPluginManagementWorkspace
      targetDeviceId="remote"
      targetWorkspacePath="/remote/project"
    />
  )
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  fireEvent.click(screen.getByTestId('kcoder-skill-remove'))
  listSkills.mockResolvedValue([])
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: /^删除$|^Remove$/ })
  )
  await waitFor(() => expect(screen.queryByText('native-skill')).not.toBeInTheDocument())
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/remote/project',
    method: 'skills/remove',
    params: { name: 'native-skill' },
  })
})

test('imports a directory on the selected host and reloads the skill inventory', async () => {
  render(
    <KCoderPluginManagementWorkspace
      targetDeviceId="remote"
      targetWorkspacePath="/remote/project"
    />
  )
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  const input = screen.getByLabelText(/Skill directory|所选主机上的技能目录/)
  fireEvent.change(input, { target: { value: '/remote/source/imported' } })
  listSkills.mockResolvedValue([
    {
      name: 'new-imported-skill',
      description: 'Imported',
      path: '/remote/skills/new-imported-skill/SKILL.md',
      source: 'kcoder',
      can_remove: true,
    },
  ])
  fireEvent.click(screen.getByRole('button', { name: /Import skill|导入技能/ }))
  await screen.findByText('new-imported-skill')
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/remote/project',
    method: 'skills/import',
    params: { path: '/remote/source/imported' },
  })
  await waitFor(() => expect(input).toHaveValue(''))
})

function renderGatewayManagement(inventory: (method: string, params: unknown) => unknown) {
  document.head.insertAdjacentHTML(
    'beforeend',
    '<meta name="kcoder-rpc-token" content="test-gateway">'
  )
  vi.mocked(fetchGatewayServers).mockResolvedValue([gatewayTargets[0]])
  listSkills.mockResolvedValue([
    {
      name: 'lark-doc',
      description: 'Feishu documents',
      path: '/home/u/.kcoder/skills/.builtin/lark-doc/SKILL.md',
      source: 'kcoder',
      can_set_enabled: true,
      enabled: true,
    },
  ])
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const request = value as { method: string; params: unknown }
    if (request.method.startsWith('extensions/')) return inventory(request.method, request.params)
    return { servers: [] }
  })
  render(
    <WorkbenchContext.Provider value={gatewayWorkbench()}>
      <KCoderPluginManagementWorkspace />
    </WorkbenchContext.Provider>
  )
}

test('the unified views list every copy, badge skill rows and show Hook problems', async () => {
  const { larkInventory } = await import('./extensionsInventory.test-fixtures')
  renderGatewayManagement(() => larkInventory())
  const all = await screen.findByTestId('kcoder-plugin-tab-all')
  await waitFor(() => expect(all).toHaveTextContent(/\(6\)/))
  expect(screen.getByTestId('kcoder-plugin-tab-conflicts')).toHaveTextContent(/\(3\)/)
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-skills'))
  expect(await screen.findByTestId('kcoder-skill-override-badges')).toHaveTextContent(
    /Lark/
  )
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-hooks'))
  expect(screen.getByTestId('extensions-hook-issue')).toHaveTextContent(
    'hooks.PreToolUse[1].hooks[0]'
  )
  fireEvent.click(all)
  expect(await screen.findAllByTestId('extensions-item')).toHaveLength(6)
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-conflicts'))
  expect(await screen.findAllByTestId('extensions-conflict')).toHaveLength(2)
  // Automatic and refresh paths never ask the target to probe binaries.
  fireEvent.click(screen.getByTestId('kcoder-plugins-refresh'))
  await waitFor(() =>
    expect(
      vi
        .mocked(requestLocalExecutor)
        .mock.calls.filter(([, value]) => (value as { method: string }).method === 'extensions/inventory')
    ).toHaveLength(2)
  )
  for (const [, value] of vi.mocked(requestLocalExecutor).mock.calls)
    expect((value as { params?: { includeBinaries?: boolean } }).params?.includeBinaries).not.toBe(
      true
    )
})

test('a target without extensionsInventoryV1 hides the unified views with an upgrade hint', async () => {
  renderGatewayManagement(() => {
    throw new GatewayRpcError('upgrade', -32000, { kind: 'plugin_update_required' })
  })
  expect(await screen.findByTestId('extensions-upgrade-hint')).toBeInTheDocument()
  expect(screen.queryByTestId('kcoder-plugin-tab-all')).not.toBeInTheDocument()
  expect(screen.queryByTestId('kcoder-plugin-tab-conflicts')).not.toBeInTheDocument()
  expect(screen.getByTestId('kcoder-plugin-tab-plugins')).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})


test('refreshing the active MCP panel reads its rows and tab count once', async () => {
  const view = render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-mcp'))
  await screen.findByText('native-search')
  const reads = () => vi.mocked(requestLocalExecutor).mock.calls.filter(([, value]) => (value as { method?: string }).method === 'mcp/list').length
  const before = reads(), previousStateReads = readState.mock.calls.length, previousSkillReads = listSkills.mock.calls.length
  vi.mocked(requestLocalExecutor).mockResolvedValue({ servers: [
    { name: 'native-search', transport: 'http', authorization: 'notAuthorized' },
    { name: 'fresh-second', transport: 'http', authorization: 'notAuthorized' },
  ] })
  fireEvent.click(screen.getByTestId('kcoder-plugins-refresh'))
  await screen.findByText('fresh-second')
  await waitFor(() => expect(readState).toHaveBeenCalledTimes(previousStateReads + 1))
  expect(listSkills).toHaveBeenCalledTimes(previousSkillReads + 1)
  expect(reads() - before).toBe(1)
  expect(screen.getByTestId('kcoder-plugin-tab-mcp')).toHaveTextContent('(2)')
  view.unmount()
})

test('a target replacement with the MCP tab open delegates its initial count to the panel', async () => {
  const view = render(<KCoderPluginManagementWorkspace targetDeviceId="original" />)
  await screen.findByText('Installed demo')
  fireEvent.click(screen.getByTestId('kcoder-plugin-tab-mcp'))
  await screen.findByText('native-search')
  vi.mocked(requestLocalExecutor).mockClear()
  view.rerender(<KCoderPluginManagementWorkspace targetDeviceId="replacement" />)
  await screen.findByText('native-search')
  expect(screen.getByTestId('kcoder-plugin-tab-mcp')).toHaveAttribute('aria-selected', 'true')
  const reads = vi.mocked(requestLocalExecutor).mock.calls.filter(([, value]) => (value as { method?: string }).method === 'mcp/list')
  expect(reads).toHaveLength(1)
  expect(reads[0][1]).toMatchObject({ deviceId: 'replacement' })
  view.unmount()
})

test('a pending badge read cannot overwrite the newer panel count after that panel closes', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
  let calls = 0
  vi.mocked(requestLocalExecutor).mockImplementation((method, value) => {
    if ((value as { method?: string }).method === 'mcp/list') return ++calls === 1 ? pending : Promise.resolve({ servers: [
      { name: 'native-search', transport: 'http', authorization: 'notAuthorized' },
      { name: 'current-second', transport: 'http', authorization: 'notAuthorized' },
    ] })
    return original(method, value)
  })
  const view = render(<KCoderPluginManagementWorkspace targetDeviceId="remote" />)
  try {
    await screen.findByText('Installed demo')
    fireEvent.click(screen.getByTestId('kcoder-plugin-tab-mcp'))
    await screen.findByText('current-second')
    fireEvent.click(screen.getByTestId('kcoder-plugin-tab-plugins'))
    await act(async () => release({ servers: [{ name: 'obsolete' }] }))
    expect(screen.getByTestId('kcoder-plugin-tab-mcp')).toHaveTextContent('(2)')
    expect(calls).toBe(2)
  } finally { release({ servers: [] }); view.unmount() }
})
