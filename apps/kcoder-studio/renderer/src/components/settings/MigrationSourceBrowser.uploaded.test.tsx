import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MigrationSourceBrowser } from './MigrationSourceBrowser'
import type { SourceUploadState } from '../../../../shared/generated/contracts'
const mocks = vi.hoisted(() => ({ configuration: vi.fn(), history: vi.fn(), memory: vi.fn(), current: () => true }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'fixed', isCurrent: mocks.current }) }))
vi.mock('@/kcoder/useMigrationSourceDiscovery', () => ({ useMigrationSourceDiscovery: () => ({ busy: false, error: null, result: null, releasePending: false, session: null, discover: mocks.configuration }) }))
vi.mock('@/kcoder/useMigrationHistorySourceDiscovery', () => ({ useMigrationHistorySourceDiscovery: () => ({ busy: false, error: null, page: null, releasePending: false, session: null, selected: [], discover: mocks.history }) }))
vi.mock('@/kcoder/useMigrationMemorySourceDiscovery', () => ({ useMigrationMemorySourceDiscovery: () => ({ busy: false, error: null, page: null, releasePending: false, session: null, selected: [], discover: mocks.memory }) }))
vi.mock('@/kcoder/useMigrationSourceTransfer', () => ({ useMigrationSourceTransfer: () => ({ busy: false, result: null, requestId: null }) }))
vi.mock('./MigrationSourceTransferStatus', () => ({ MigrationSourceTransferStatus: () => null }))
vi.mock('./MigrationTransferRecords', () => ({ MigrationTransferRecords: () => null }))
const target = { id: 'destination', label: 'Destination', description: '', runtime: 'kcoder' as const, transport: 'local' as const }
const upload: SourceUploadState = { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), source: 'codex', stage: 'ready', sequence: 9, cancelWatermark: 2,
  cancelRequested: false, workerState: 'stopped', totalFiles: 1, completedFiles: 1, totalBytes: 10, receivedBytes: 10, verifiedBytes: 10 }
it('locks user-supplied inspection to the original target/product and passes opaque selection to all three source modes', () => {
  render(<MigrationSourceBrowser destination={target} targets={[{ ...target, id: 'peer' }, target]} uploaded={upload} isCurrent={mocks.current} onBusy={vi.fn()}/>)
  expect(screen.getByLabelText('transferBrowser.source')).toHaveValue('destination')
  expect(screen.getByLabelText('transferBrowser.source')).toBeDisabled()
  expect(screen.getByText('userSupplied')).toBeTruthy()
  expect(screen.queryByText('project')).toBeNull()
  expect(screen.queryByText('sourceDirectory.enable')).toBeNull()
  fireEvent.click(screen.getByText('find'))
  const binding = { operationId: upload.operationId, manifestSha256: upload.manifestSha256 }
  expect(mocks.configuration).toHaveBeenCalledWith('codex', false, binding)
  fireEvent.click(screen.getByTestId('migration-source-mode-history'))
  fireEvent.click(screen.getByTestId('migration-history-source-discover'))
  expect(mocks.history).toHaveBeenCalledWith('codex', binding)
  fireEvent.click(screen.getByTestId('migration-source-mode-memory'))
  fireEvent.click(screen.getByText('discover'))
  expect(mocks.memory).toHaveBeenCalledWith('codex', binding)
  expect(screen.getByRole('button', { name: 'Claude Code', exact: true })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Codex', exact: true })).toBeDisabled()
})
