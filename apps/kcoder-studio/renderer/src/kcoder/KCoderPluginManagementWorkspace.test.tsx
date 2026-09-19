import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { KCoderPluginManagementWorkspace } from './KCoderPluginManagementWorkspace'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/api/local/codexPlugins', () => ({ createLocalCodexPluginApi: vi.fn() }))
const readState = vi.fn()
const listSkills = vi.fn()
const updateInstalledPlugin = vi.fn()
const uninstallInstalledPlugin = vi.fn()
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
    },
  ])
  vi.mocked(createLocalCodexPluginApi).mockReturnValue({
    readState,
    listSkills,
    updateInstalledPlugin,
    uninstallInstalledPlugin,
  } as unknown as ReturnType<typeof createLocalCodexPluginApi>)
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
