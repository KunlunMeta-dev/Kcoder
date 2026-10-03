import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { StorageSettingsPage } from '@/components/settings/StorageSettingsPage'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { cleanStorage, disableDebugLog, readStorageReport } from '@/kcoder/storageDiagnostics'
import { readTurnFileChangesPolicy, saveTurnFileChangesPolicy } from '@/kcoder/turnFileChanges'
import '@/i18n'

vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))
vi.mock('@/kcoder/turnFileChanges', () => ({
  readTurnFileChangesPolicy: vi.fn(),
  saveTurnFileChangesPolicy: vi.fn(),
}))
vi.mock('@/kcoder/storageDiagnostics', () => ({
  readStorageReport: vi.fn(),
  cleanStorage: vi.fn(),
  disableDebugLog: vi.fn(),
}))

const report = {
  configRoot: '/home/u/.config/kcoder',
  totalBytes: 54 * 1024 * 1024 * 1024,
  totalFiles: 1234,
  buckets: [
    { id: 'debug-logs', bytes: 3 * 1024 * 1024 * 1024, files: 3400, cleanable: true },
    { id: 'turn-snapshots', bytes: 50 * 1024 * 1024 * 1024, files: 27, cleanable: true },
    { id: 'session-data', bytes: 1024, files: 12, cleanable: false },
  ],
  credentials: {
    path: '/home/u/.config/kcoder/credentials.json',
    present: true,
    userOnly: true,
    providers: 2,
    dotenvCredentialLines: 1,
    keyringAvailable: true,
    keyringBackend: 'Secret Service (gnome-keyring / KWallet) [kcoder]',
    keyringProviders: ['deepseek'],
    plaintextProviders: ['openai'],
  },
  devDebug: {
    enabled: true,
    envSet: true,
    dotenvLines: 1,
    retentionDays: 7,
    logBytes: 3 * 1024 * 1024 * 1024,
    logFiles: 3400,
    oldestDay: '20260901',
  },
}

beforeEach(() => {
  vi.mocked(fetchGatewayServers).mockReset()
  vi.mocked(readStorageReport).mockReset()
  vi.mocked(cleanStorage).mockReset()
  vi.mocked(disableDebugLog).mockReset()
  vi.mocked(readTurnFileChangesPolicy).mockReset()
  vi.mocked(saveTurnFileChangesPolicy).mockReset()
  vi.mocked(readTurnFileChangesPolicy).mockResolvedValue({
    enabled: true,
    retentionDays: 14,
    maxTotalBytes: 5 * 1024 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
    ignoreGlobs: [],
  })
  vi.mocked(saveTurnFileChangesPolicy).mockImplementation(async (_id, policy) => policy)
  vi.mocked(fetchGatewayServers).mockResolvedValue([{ id: 'server-1' }] as never)
  vi.mocked(readStorageReport).mockResolvedValue(report)
  vi.mocked(cleanStorage).mockResolvedValue({
    removedBytes: 2048,
    removedFiles: 4,
    report: { ...report, buckets: [] },
  })
  vi.mocked(disableDebugLog).mockResolvedValue({
    changed: true,
    dotenvPath: '/home/u/.config/kcoder/.env',
    note: 'commented out in .env',
  } as never)
})

test('renders bucket usage and the DEV_DEBUG state', async () => {
  render(<StorageSettingsPage />)

  expect(await screen.findByTestId('storage-bucket-turn-snapshots')).toBeInTheDocument()
  expect(screen.getByTestId('storage-total').textContent).toContain('54.00 GiB')
  const devDebug = screen.getByTestId('storage-dev-debug')
  expect(devDebug.textContent).toContain('3.00 GiB')
  expect(devDebug.textContent).toContain('20260901')
  expect(screen.getByTestId('storage-env-warning')).toBeInTheDocument()
  expect(screen.getByTestId('storage-credentials').textContent).toContain('credentials.json')
  expect(screen.getByTestId('storage-credentials-dotenv')).toBeInTheDocument()
  expect(screen.queryByTestId('storage-clean-session-data')).not.toBeInTheDocument()
})

test('confirms before cleaning and reports what was reclaimed', async () => {
  const user = userEvent.setup()
  render(<StorageSettingsPage />)
  await screen.findByTestId('storage-bucket-turn-snapshots')

  await user.click(screen.getByTestId('storage-clean-turn-snapshots'))
  expect(cleanStorage).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toHaveTextContent('50.00 GiB')
  await user.click(screen.getByTestId('storage-clean-dialog-confirm'))
  await waitFor(() => expect(cleanStorage).toHaveBeenCalledWith('server-1', 'turn-snapshots'))
  expect(await screen.findByTestId('storage-notice')).toBeInTheDocument()
})

test('turns the recorder off through the disable rpc', async () => {
  const user = userEvent.setup()
  render(<StorageSettingsPage />)
  await screen.findByTestId('storage-disable-debug')

  await user.click(screen.getByTestId('storage-disable-debug'))
  await waitFor(() => expect(disableDebugLog).toHaveBeenCalledWith('server-1'))
  await waitFor(() => expect(readStorageReport).toHaveBeenCalledTimes(2), { timeout: 3000 })
})

test('edits and saves the snapshot policy', async () => {
  const user = userEvent.setup()
  render(<StorageSettingsPage />)
  await screen.findByTestId('policy-enabled')

  expect((screen.getByTestId('policy-retention-days') as HTMLInputElement).value).toBe('14')
  expect((screen.getByTestId('policy-max-file-mib') as HTMLInputElement).value).toBe('64')

  await user.clear(screen.getByTestId('policy-retention-days'))
  await user.type(screen.getByTestId('policy-retention-days'), '7')
  await user.type(screen.getByTestId('policy-ignore-globs'), '**/*.gguf')
  await user.click(screen.getByTestId('policy-save'))

  await waitFor(() =>
    expect(saveTurnFileChangesPolicy).toHaveBeenCalledWith(
      'server-1',
      expect.objectContaining({ retentionDays: 7, ignoreGlobs: ['**/*.gguf'] })
    )
  )
  expect(await screen.findByTestId('storage-notice')).toBeInTheDocument()
})

test('reports the credential store and plaintext secrets', async () => {
  render(<StorageSettingsPage />)
  const keyring = await screen.findByTestId('credentials-keyring')
  expect(keyring).toHaveTextContent('Secret Service')
  const plaintext = await screen.findByTestId('credentials-plaintext')
  expect(plaintext).toHaveTextContent('openai')
  expect(plaintext).toHaveTextContent('migrate --to keyring')
})

test('cancels cleanup and restores focus; failure stays in dialog for retry', async () => {
  const user = userEvent.setup()
  render(<StorageSettingsPage />)
  const trigger = await screen.findByTestId('storage-clean-turn-snapshots')
  await user.click(trigger)
  await user.keyboard('{Escape}')
  expect(cleanStorage).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(trigger).toHaveFocus())
  vi.mocked(cleanStorage).mockRejectedValueOnce(new Error('files locked'))
  await user.click(trigger)
  await user.click(screen.getByTestId('storage-clean-dialog-confirm'))
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('files locked'))
  await user.click(screen.getByTestId('storage-clean-dialog-confirm'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(cleanStorage).toHaveBeenCalledTimes(2)
})

test('zero-size categories cannot be cleaned', async () => {
  vi.mocked(readStorageReport).mockResolvedValue({
    ...report,
    buckets: [{ id: 'debug-logs', bytes: 0, files: 0, cleanable: true }],
  })
  render(<StorageSettingsPage />)
  expect(await screen.findByTestId('storage-clean-debug-logs')).toBeDisabled()
  expect(screen.getByTestId('storage-distribution').children).toHaveLength(0)
})
