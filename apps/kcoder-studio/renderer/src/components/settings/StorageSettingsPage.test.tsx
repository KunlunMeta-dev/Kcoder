import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import {
  cleanStorage,
  cancelStorageScan,
  readStorageReport,
  type StorageReport,
} from '@/kcoder/storageDiagnostics'
import { readTurnFileChangesPolicy } from '@/kcoder/turnFileChanges'
import { StorageSettingsPage } from './StorageSettingsPage'

vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))
vi.mock('@/kcoder/storageDiagnostics', () => ({
  readStorageReport: vi.fn(),
  cleanStorage: vi.fn(),
  cancelStorageScan: vi.fn(),
  disableDebugLog: vi.fn(),
}))
vi.mock('@/kcoder/turnFileChanges', () => ({
  readTurnFileChangesPolicy: vi.fn(async () => null),
  saveTurnFileChangesPolicy: vi.fn(),
}))

function report(configRoot: string, totalBytes: number): StorageReport {
  return {
    configRoot,
    totalBytes,
    totalFiles: 1,
    buckets: [{ id: 'debug-logs', bytes: totalBytes, files: 1, cleanable: true }],
    devDebug: {
      enabled: false,
      envSet: false,
      dotenvLines: 0,
      retentionDays: 7,
      logBytes: 0,
      logFiles: 0,
    },
    credentials: {
      path: '/tmp/credentials.json',
      present: false,
      providers: 0,
      dotenvCredentialLines: 0,
      keyringAvailable: false,
      keyringBackend: 'none',
      keyringProviders: [],
      plaintextProviders: [],
    },
  }
}

const servers = [
  {
    id: 'alpha',
    label: 'Alpha target',
    description: '',
    runtime: 'kcoder' as const,
    transport: 'local' as const,
  },
  {
    id: 'beta',
    label: 'Beta target',
    description: '',
    runtime: 'kcoder' as const,
    transport: 'ssh' as const,
    accountIdentity: { principalId: 'p1', username: 'alice', role: 'user' as const },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchGatewayServers).mockResolvedValue(servers)
  vi.mocked(readTurnFileChangesPolicy).mockResolvedValue(null)
  vi.mocked(cancelStorageScan).mockResolvedValue({ cancelled: true })
})

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('StorageSettingsPage scan scope', () => {
  test('says which target the totals describe', async () => {
    vi.mocked(readStorageReport).mockResolvedValue(report('/home/alice/.config/kcoder', 1024))
    render(<StorageSettingsPage />)

    const target = await screen.findByTestId('storage-scan-target')
    expect(target).toHaveTextContent('Alpha target')
    // The first target carries no account identity, so no account line.
    expect(screen.queryByTestId('storage-scan-account')).not.toBeInTheDocument()
  })

  test('names the account when the target reports one', async () => {
    vi.mocked(fetchGatewayServers).mockResolvedValue([servers[1]])
    vi.mocked(readStorageReport).mockResolvedValue(report('/srv/kcoder', 2048))
    render(<StorageSettingsPage />)

    const account = await screen.findByTestId('storage-scan-account')
    expect(account).toHaveTextContent('alice')
    expect(account).toHaveTextContent('user')
  })
})

describe('StorageSettingsPage stale scans', () => {
  test('a superseded scan does not overwrite the report on screen', async () => {
    // First scan never settles until we say so, so the second one overtakes it.
    let releaseFirst!: (value: StorageReport) => void
    const first = new Promise<StorageReport>(resolve => {
      releaseFirst = resolve
    })
    vi.mocked(readStorageReport)
      .mockReturnValueOnce(first)
      .mockResolvedValue(report('/new/root', 4096))

    render(<StorageSettingsPage />)
    // The first scan is deliberately left unresolved, so wait for the request
    // rather than for the scope line that only renders with a report.
    await waitFor(() => expect(readStorageReport).toHaveBeenCalledTimes(1))

    // Changing the locale re-creates `refresh`, which issues a newer scan.
    await i18n.changeLanguage('en')
    await waitFor(() => expect(readStorageReport).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('storage-total')).toHaveTextContent('/new/root'))

    // The superseded response lands late and must be dropped.
    releaseFirst(report('/stale/root', 1))
    await waitFor(() => expect(screen.getByTestId('storage-total')).toHaveTextContent('4.0 KiB'))
    expect(screen.queryByText(/stale\/root/)).not.toBeInTheDocument()
  })
})

test('switching targets immediately invalidates an outstanding scan and its report', async () => {
  let release!: (value: StorageReport) => void
  vi.mocked(readStorageReport).mockImplementation(id =>
    id === 'alpha'
      ? new Promise(resolve => {
          release = resolve
        })
      : Promise.resolve(report('/beta-profile', 2048))
  )
  render(<StorageSettingsPage />)
  await waitFor(() => expect(readStorageReport).toHaveBeenCalledWith('alpha', expect.any(String)))
  fireEvent.change(screen.getByTestId('storage-target'), { target: { value: 'beta' } })
  await waitFor(() =>
    expect(screen.getByTestId('storage-total')).toHaveTextContent('/beta-profile')
  )
  await act(async () => {
    release(report('/alpha-old', 100))
  })
  expect(screen.getByTestId('storage-scan-target')).toHaveTextContent('Beta target')
  expect(screen.getByTestId('storage-total')).not.toHaveTextContent('/alpha-old')
})

test('account replacement clears old storage and reloads identity on the same target', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([servers[1]])
  vi.mocked(readStorageReport).mockResolvedValue(report('/alice', 100))
  render(<StorageSettingsPage />)
  await screen.findByTestId('storage-scan-account')
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    {
      ...servers[1],
      accountIdentity: {
        principalId: 'second',
        username: 'bob',
        role: 'user',
      },
    },
  ])
  vi.mocked(readStorageReport).mockResolvedValue(report('/bob', 200))
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  expect(screen.queryByTestId('storage-total')).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('storage-scan-account')).toHaveTextContent('bob'))
  expect(screen.getByTestId('storage-total')).toHaveTextContent('/bob')
})

test('busy cleanup leaves the confirmation open with a localized explanation', async () => {
  vi.mocked(readStorageReport).mockResolvedValue(report('/alpha', 100))
  vi.mocked(cleanStorage).mockRejectedValueOnce(
    Object.assign(new Error('raw internal detail'), { code: -32034 })
  )
  render(<StorageSettingsPage />)
  fireEvent.click(await screen.findByTestId('storage-clean-debug-logs'))
  fireEvent.click(screen.getByTestId('storage-clean-dialog-confirm'))
  await waitFor(() =>
    expect(screen.getByTestId('storage-clean-dialog')).toHaveTextContent('存储资源正在使用中')
  )
  expect(screen.getByTestId('storage-clean-dialog')).not.toHaveTextContent('raw internal detail')
  expect(screen.getByTestId('storage-clean-dialog-confirm')).toBeEnabled()
})

test('cancelled scans cannot replace the prior result, and report completeness is explicit', async () => {
  let finish!: (value: StorageReport) => void
  vi.mocked(readStorageReport)
    .mockResolvedValueOnce({
      ...report('/retained', 100),
      partial: true,
      scannedAt: '2026-09-23T00:00:00Z',
    })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  render(<StorageSettingsPage />)
  await screen.findByTestId('storage-total')
  expect(screen.getByTestId('storage-scan-completeness')).toHaveTextContent('部分估算')
  fireEvent.click(screen.getByTestId('storage-refresh'))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  const id = vi.mocked(readStorageReport).mock.calls.at(-1)![1]
  fireEvent.click(screen.getByTestId('storage-cancel-scan'))
  await waitFor(() => expect(cancelStorageScan).toHaveBeenCalledWith('alpha', id))
  await act(async () => finish(report('/discarded', 9999)))
  expect(screen.getByTestId('storage-total')).toHaveTextContent('/retained')
  expect(screen.queryByText(/discarded/)).not.toBeInTheDocument()
  expect(screen.getByTestId('storage-refresh')).toBeEnabled()
})

test('partial cleanup shows the rescanned capacity and the failure separately', async () => {
  vi.mocked(readStorageReport).mockResolvedValue(report('/alpha', 100))
  vi.mocked(cleanStorage).mockResolvedValue({
    removedBytes: 30,
    removedFiles: 1,
    report: report('/alpha', 70),
    errors: ['fixture permission denied'],
  })
  render(<StorageSettingsPage />)
  fireEvent.click(await screen.findByTestId('storage-clean-debug-logs'))
  fireEvent.click(screen.getByTestId('storage-clean-dialog-confirm'))
  await waitFor(() => expect(screen.getByTestId('storage-total')).toHaveTextContent('70 B'))
  expect(screen.getByText(/部分文件未能清理/)).toHaveTextContent('fixture permission denied')
  expect(screen.queryByTestId('storage-clean-dialog')).not.toBeInTheDocument()
})
