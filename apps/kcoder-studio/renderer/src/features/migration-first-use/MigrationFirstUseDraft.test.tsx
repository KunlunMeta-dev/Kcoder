import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { KCoderProviderSettingsPage } from '@/components/settings/KCoderProviderSettingsPage'
import { readProviderSettings, saveProviderSettings, probeProviderSettings, applyProviderSettings } from '@/kcoder/providerSettings'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
vi.mock('@/kcoder/gatewayRpc', async original => ({ ...await original<typeof import('@/kcoder/gatewayRpc')>(), fetchGatewayServers: vi.fn() }))
vi.mock('@/kcoder/configTemplates', () => ({ listSettingsTemplates: vi.fn(async () => ({ templates: [] })), readSettingsTemplate: vi.fn(), saveSettingsTemplate: vi.fn(), deleteSettingsTemplate: vi.fn(), setDefaultSettingsTemplate: vi.fn() }))
vi.mock('@/kcoder/providerSettings', () => ({ readProviderSettings: vi.fn(), readProviderTemplates: vi.fn(async () => ({ templates: [] })), saveProviderSettings: vi.fn(), probeProviderSettings: vi.fn(), applyProviderSettings: vi.fn(), deleteProviderSettings: vi.fn(), clearProviderUserOverride: vi.fn() }))
vi.mock('@/components/settings/MigrationDialog', () => ({ MigrationDialog: ({ target, onClose }: { target: { id: string }; onClose(): void }) => <div data-testid="draft-import-dialog" data-target={target.id}><button onClick={onClose}>return from import</button></div> }))
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  vi.mocked(fetchGatewayServers).mockResolvedValue([{ id: 'own-target', label: 'Own', description: '', runtime: 'kcoder', transport: 'local' }])
  vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [], restartRequired: false, supportsOptimisticConcurrency: true, revision: 'before' })
})
it('keeps the manual form mounted and preserves its unsent fields when migration closes or saves a separate connection', async () => {
  render(<KCoderProviderSettingsPage/>)
  // The provider page offers migration through its own card; the manual editor opens on an explicit action.
  await screen.findByTestId('provider-migration-open')
  await waitFor(() => expect(screen.getByTestId('provider-new')).toBeEnabled())
  fireEvent.click(screen.getByTestId('provider-new'))
  expect(screen.getByTestId('provider-form')).toBeVisible()
  fireEvent.change(screen.getByTestId('provider-id'), { target: { value: 'UnsentManual' } })
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'unsent-model' } })
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'synthetic-unsent-key' } })
  await waitFor(() => expect(screen.getByTestId('provider-migration-open')).toBeEnabled())
  fireEvent.click(screen.getByTestId('provider-migration-open'))
  expect(screen.getByTestId('draft-import-dialog')).toHaveAttribute('data-target', 'own-target')
  fireEvent.click(screen.getByText('return from import'))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('provider-form')).toBeVisible()
  expect(screen.getByTestId('provider-id')).toHaveValue('UnsentManual')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('synthetic-unsent-key')
  vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [{ id: 'Imported', endpoint: 'https://example.invalid', model: 'imported-model', apiFormat: 'openai_chat_completions', contextWindowTokens: 32000, maxOutputTokens: 4096, apiKeyConfigured: false, isDefault: false }], restartRequired: false, revision: 'after' })
  await waitFor(() => expect(screen.getByTestId('provider-migration-open')).toBeEnabled())
  fireEvent.click(screen.getByTestId('provider-migration-open')); fireEvent.click(screen.getByText('return from import'))
  await screen.findByTestId('provider-edit-Imported')
  expect(screen.getByTestId('provider-form')).toBeVisible()
  expect(screen.getByTestId('provider-id')).toHaveValue('UnsentManual')
  expect(screen.getByTestId('provider-model')).toHaveValue('unsent-model')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('synthetic-unsent-key')
  expect(saveProviderSettings).not.toHaveBeenCalled(); expect(probeProviderSettings).not.toHaveBeenCalled(); expect(applyProviderSettings).not.toHaveBeenCalled()
})
