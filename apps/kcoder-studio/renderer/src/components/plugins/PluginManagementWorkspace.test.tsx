import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginManagementWorkspace } from './PluginManagementWorkspace'

const mocks = vi.hoisted(() => ({
  listTrust: vi.fn(),
  listInstalledPlugins: vi.fn(),
  listInstalledSystemSkills: vi.fn(),
  listInstalledMcps: vi.fn(),
  listProviders: vi.fn(),
}))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: vi.fn(() => ({
    listTrust: mocks.listTrust,
    listInstalledPlugins: mocks.listInstalledPlugins,
  })),
}))

vi.mock('@/api/http', () => ({ createHttpClient: vi.fn(() => ({})) }))
vi.mock('@/api/systemSkills', () => ({
  createSystemSkillApi: vi.fn(() => ({
    listInstalledSystemSkills: mocks.listInstalledSystemSkills,
  })),
}))
vi.mock('@/api/mcps', () => ({
  createMcpApi: vi.fn(() => ({
    listInstalledMcps: mocks.listInstalledMcps,
    listProviders: mocks.listProviders,
  })),
}))
vi.mock('@/config/runtime', () => ({ getRuntimeConfig: () => ({ apiBaseUrl: 'fixture:' }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listTrust.mockResolvedValue({ entries: [], bypassActive: false })
  mocks.listInstalledPlugins.mockResolvedValue({ items: [] })
  mocks.listInstalledSystemSkills.mockResolvedValue({ items: [] })
  mocks.listInstalledMcps.mockResolvedValue({ items: [] })
  mocks.listProviders.mockResolvedValue({ providers: [] })
})

test('opens target trust management on demand and restores focus when closed', async () => {
  render(
    <PluginManagementWorkspace
      targetDeviceId="target-alpha"
      targetWorkspacePath="/workspaces/alpha"
    />
  )

  expect(await screen.findByTestId('plugin-management-workspace')).toBeInTheDocument()
  expect(mocks.listTrust).not.toHaveBeenCalled()

  const open = screen.getByTestId('plugins-trust-manage-button')
  fireEvent.click(open)
  const manager = await screen.findByTestId('plugin-trust-manager')
  expect(manager).toHaveTextContent('target-alpha')
  await waitFor(() => expect(mocks.listTrust).toHaveBeenCalledOnce())

  fireEvent.click(within(manager).getByRole('button', { name: '关闭' }))
  expect(screen.queryByTestId('plugin-trust-manager')).not.toBeInTheDocument()
  await waitFor(() => expect(open).toHaveFocus())
})
