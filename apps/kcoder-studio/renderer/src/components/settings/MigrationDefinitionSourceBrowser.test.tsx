import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationDefinitionSourceBrowser } from './MigrationDefinitionSourceBrowser'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
const { model, transfer } = vi.hoisted(() => ({ model: { busy: false, error: null as string | null, releasePending: false, session: null as object | null, page: null as null | { catalogId: string; sources: object[]; problems: object[]; totalSources: number; nextPage: number | null }, pageIndex: 0, selected: [] as { sourceId: string }[], discover: vi.fn(), close: vi.fn(), select: vi.fn(), changePage: vi.fn(), selections: vi.fn() }, transfer: { busy: false, requestId: null as string | null, result: null, start: vi.fn() } }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/useMigrationDefinitionSourceDiscovery', () => ({ useMigrationDefinitionSourceDiscovery: () => model }))
vi.mock('@/kcoder/useMigrationSourceTransfer', () => ({ useMigrationSourceTransfer: () => transfer }))
vi.mock('./MigrationSourceTransferStatus', () => ({ MigrationSourceTransferStatus: () => null }))
vi.mock('./MigrationSourceAdoptionPanel', () => ({ MigrationSourceAdoptionPanel: () => null }))
const source: GatewayServer = { id: 'source', label: 'Owned source', description: '', runtime: 'kcoder', transport: 'ssh' }
const props = () => ({ source, destination: { ...source, id: 'destination' }, isCurrent: () => true, onBusy: vi.fn() })
beforeEach(() => { vi.clearAllMocks(); model.busy = false; model.error = null; model.session = null; model.page = null; model.selected = []; transfer.busy = false; transfer.requestId = null })
it('requires explicit source discovery and preserves the source-side project/directory choice', () => {
  render(<MigrationDefinitionSourceBrowser {...props()}/>)
  expect(model.discover).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Codex' })); fireEvent.click(screen.getByLabelText('project'))
  fireEvent.click(screen.getByTestId('migration-source-directory-explicit'))
  fireEvent.change(screen.getByTestId('migration-source-directory-path'), { target: { value: 'relative' } })
  expect(screen.getByRole('button', { name: 'find' })).toBeDisabled()
  fireEvent.change(screen.getByTestId('migration-source-directory-path'), { target: { value: '/on-source/product' } })
  fireEvent.click(screen.getByRole('button', { name: 'find' }))
  expect(model.discover).toHaveBeenCalledWith('codex', true, '/on-source/product')
})
it('uploaded products never request an extra source-host project root', () => {
  const root = { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64) }
  render(<MigrationDefinitionSourceBrowser {...props()} root={root} fixedKind="codex"/>)
  expect(screen.queryByLabelText('project')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'find' }))
  expect(model.discover).toHaveBeenCalledWith('codex', false, root)
})
it('a partial catalog needs consent and double click cannot start a second transfer', async () => {
  model.session = { sessionId: 'original' }; model.selected = [{ sourceId: 'opaque-definition' }]
  model.page = { catalogId: 'original-catalog', sources: [], problems: [{}], totalSources: 1, nextPage: null }
  let release!: () => void
  model.selections.mockImplementation(() => new Promise(resolve => { release = () => resolve([{ kind: 'assets', sourceId: 'opaque-definition' }]) }))
  render(<MigrationDefinitionSourceBrowser {...props()}/>)
  const action = screen.getByRole('button', { name: 'transferBrowser.transfer' })
  expect(action).toBeDisabled(); fireEvent.click(screen.getByLabelText('definitionSource.partial')); expect(action).not.toBeDisabled()
  fireEvent.click(action); fireEvent.click(action)
  expect(model.selections).toHaveBeenCalledTimes(1); release()
  await waitFor(() => expect(transfer.start).toHaveBeenCalledTimes(1))
  expect(transfer.start).toHaveBeenCalledWith(model.session, [{ kind: 'assets', sourceId: 'opaque-definition' }])
})
