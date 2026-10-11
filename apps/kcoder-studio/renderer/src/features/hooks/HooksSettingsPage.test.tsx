import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HooksSettingsPage } from './HooksSettingsPage'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { readHookConfiguration } from '@/kcoder/hookConfigurationApi'
vi.mock('@/kcoder/gatewayRpc', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/gatewayRpc')>()),
  fetchGatewayServers: vi.fn(),
}))
vi.mock('@/kcoder/hookConfigurationApi', () => ({
  readHookConfiguration: vi.fn(),
  updateHookConfiguration: vi.fn(),
}))

const request = vi.hoisted(() => vi.fn())
vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: request,
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(vi.fn()),
}))

describe('HooksSettingsPage', () => {
  beforeEach(() => request.mockReset())
  afterEach(() => document.head.querySelector('meta[name="kcoder-rpc-token"]')?.remove())

  test('routes gateway Hooks to the account-scoped editor instead of native plugin installation', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="test">')
    const target = { id: 'remote', label: 'Remote', description: '', transport: 'ssh' as const }
    vi.mocked(fetchGatewayServers).mockResolvedValue([target])
    vi.mocked(readHookConfiguration).mockResolvedValue({
      hooks: {},
      revision: 'r1',
      configurationPath: '/owned/settings.json',
      appliesToNewConversations: true,
    })
    render(<HooksSettingsPage />)
    expect(await screen.findByTestId('hooks-json')).toBeInTheDocument()
    expect(readHookConfiguration).toHaveBeenCalledWith(target)
    expect(screen.getByTestId('hooks-save')).toBeDisabled()
    expect(screen.getByTestId('hooks-example')).toBeEnabled()
    expect(request).not.toHaveBeenCalled()
    expect(screen.queryByTestId('hooks-import-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('hooks-add-button')).not.toBeInTheDocument()
  })

  test('renders empty state and opens the editor', async () => {
    request.mockResolvedValueOnce({ plugins: [] })
    render(<HooksSettingsPage />)
    expect(await screen.findByText('尚未安装 Hook。')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('hooks-add-button'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('hook-editor-save')).toBeDisabled()
  })

  test('renders source, health, and managed policy', async () => {
    request.mockResolvedValueOnce({
      plugins: [
        {
          manifest: {
            schemaVersion: 1,
            id: 'managed',
            name: 'Managed reporter',
            description: 'Reports changes',
            version: '1',
          },
          enabled: true,
          source: 'managed',
          installPath: '/managed',
          policy: { canDisable: false, canEdit: false, canDelete: false },
          health: { status: 'ready' },
          handlers: [],
          recentRuns: [],
        },
      ],
    })
    render(<HooksSettingsPage />)
    expect(await screen.findByTestId('hook-row-managed')).toHaveTextContent('组织')
    expect(screen.getByTestId('hook-row-managed')).toHaveTextContent('可用')
    expect(screen.getByTestId('hook-enabled-managed')).toBeDisabled()
    expect(screen.queryByTestId('hook-menu-managed')).not.toBeInTheDocument()
    await waitFor(() => expect(request).toHaveBeenCalledWith('runtime.hooks.list'))
  })
})
