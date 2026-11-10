import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationSourceTransferSelection } from './MigrationSourceTransferSelection'
import type { useMigrationSourceDiscovery } from '@/kcoder/useMigrationSourceDiscovery'
import type { GatewayServer } from '@/kcoder/gatewayRpc'

const transfer = vi.hoisted(() => ({ result: null, requestId: null, busy: false, error: null,
  start: vi.fn(async () => {}), retry: vi.fn(), refresh: vi.fn(), cancel: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/useMigrationSourceTransfer', () => ({ useMigrationSourceTransfer: () => transfer }))
const destination: GatewayServer = { id: 'target', label: 'Target', description: '', runtime: 'kcoder', transport: 'local' }
function source(): ReturnType<typeof useMigrationSourceDiscovery> {
  return { result: { sources: [{ sourceId: 'configuration-reference', kind: 'codex', displayName: 'Configuration with unsupported hooks', scope: 'user', formatRevision: '1', availableCategories: ['hook'] }] },
    busy: false, error: null, releasePending: false,
    discover: vi.fn(async () => {}), close: vi.fn(async () => {}),
    session: { sessionId: '22222222-2222-4222-8222-222222222222', targetId: 'source', purpose: 'source' },
    selections: vi.fn(async () => [{ kind: 'configuration', sourceId: 'configuration-reference' }]),
    canDeriveCodexLayers: false, deriveCodexLayers: vi.fn(), readCodexLayers: vi.fn(), readConfigurationLayers: vi.fn() }
}
beforeEach(() => vi.clearAllMocks())
it('asks Native to classify selected sources before creating any destination operation', async () => {
  const value = source()
  render(<MigrationSourceTransferSelection source={value} destination={destination} isCurrent={() => true} onBusy={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'transferBrowser.transfer' }))
  await waitFor(() => expect(transfer.start).toHaveBeenCalledOnce())
  expect(value.selections).toHaveBeenCalledWith(['configuration-reference'])
  expect(transfer.start).toHaveBeenCalledWith(value.session, [{ kind: 'configuration', sourceId: 'configuration-reference' }])
})
it('does not create the destination operation when classification fails', async () => {
  const value = source()
  vi.mocked(value.selections).mockRejectedValue(new Error('expired source'))
  render(<MigrationSourceTransferSelection source={value} destination={destination} isCurrent={() => true} onBusy={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'transferBrowser.transfer' }))
  await waitFor(() => expect(value.selections).toHaveBeenCalledOnce())
  expect(transfer.start).not.toHaveBeenCalled()
})


it('localizes the selected static Claude layer family instead of showing internal scope labels', () => {
  const value = source();
  value.result!.sources = [{ sourceId: 'claude-layers', kind: 'claude-code', displayName: 'Claude Code - selected settings layers', scope: 'project-effective', formatRevision: 'claude-settings-layers/v1', availableCategories: ['provider'] }];
  render(<MigrationSourceTransferSelection source={value} destination={destination} isCurrent={() => true} onBusy={vi.fn()} />);
  expect(screen.getByText('layers.effectiveSource')).toBeTruthy();
  expect(screen.getByText('layers.effectiveScope')).toBeTruthy();
  expect(screen.queryByText('project-effective')).toBeNull();
  expect(screen.queryByText('Claude Code - selected settings layers')).toBeNull();
  expect(value.readConfigurationLayers).not.toHaveBeenCalled();
});
