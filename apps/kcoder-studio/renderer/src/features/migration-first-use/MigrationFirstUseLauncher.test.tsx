import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { MigrationFirstUseLauncher } from './MigrationFirstUseLauncher'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { readProviderSettings } from '@/kcoder/providerSettings'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

vi.mock('@/kcoder/gatewayRpc', async original => ({ ...await original<typeof import('@/kcoder/gatewayRpc')>(), fetchGatewayServers: vi.fn(), isKCoderGatewayPage: () => true }))
vi.mock('@/kcoder/providerSettings', () => ({ readProviderSettings: vi.fn() }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: (id: string) => ({ key: id, isCurrent: () => true }) }))
vi.mock('@/components/settings/MigrationDialog', () => ({ MigrationDialog: ({ onClose, target }: { onClose(): void; target: { id: string } }) => <div data-testid="first-use-dialog" data-target={target.id}><button onClick={onClose}>close import</button></div> }))
const target = { id: 'current', label: 'Current', description: '', runtime: 'kcoder' as const, transport: 'local' as const }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(fetchGatewayServers).mockResolvedValue([target]); vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [], restartRequired: false }) })
afterEach(() => { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ })
it('offers a scoped optional migration only after the current target confirms empty settings and refreshes on return', async () => {
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledWith('current')
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-target', 'current')
  fireEvent.click(screen.getByText('close import'))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
  expect(await screen.findByTestId('migration-first-use-import')).toBeTruthy()
  fireEvent.click(screen.getByTestId('migration-first-use-skip'))
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(3))
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
})
it('does not infer missing configuration from read failure or choose the first of multiple targets', async () => {
  vi.mocked(readProviderSettings).mockRejectedValue(new Error('offline'))
  const first = render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('migration-first-use-import')).toBeNull(); first.unmount()
  // Without an explicit target only the current host is implied; several remote targets never default to the first one.
  vi.mocked(fetchGatewayServers).mockResolvedValue([{ ...target, id: 'peer', transport: 'ssh' }, { ...target, id: 'other-peer', transport: 'ssh' }]); vi.mocked(readProviderSettings).mockClear()
  render(<MigrationFirstUseLauncher enabled/>)
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(2))
  expect(readProviderSettings).not.toHaveBeenCalled()
})
it('already configured targets do not show another first-use guide or migration dialog', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({ restartRequired: false, profiles: [{ id: 'ready', endpoint: 'https://example.invalid', model: 'ready', apiFormat: 'openai_chat_completions', contextWindowTokens: 32000, maxOutputTokens: 4096, apiKeyConfigured: true, isDefault: true }] })
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
  expect(screen.queryByTestId('first-use-dialog')).toBeNull()
})
it('rejects a delayed old-account settings read and does not carry skip choices into a new account', async () => {
  let finish!: (value: { profiles: []; restartRequired: false }) => void
  vi.mocked(readProviderSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  vi.mocked(fetchGatewayServers).mockResolvedValue([{ ...target, accountIdentity: { principalId: 'new', username: 'new', role: 'user' } }])
  act(() => notifyAccountContextChange('current'))
  await act(async () => { finish({ profiles: [], restartRequired: false }) })
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledTimes(2)
})
