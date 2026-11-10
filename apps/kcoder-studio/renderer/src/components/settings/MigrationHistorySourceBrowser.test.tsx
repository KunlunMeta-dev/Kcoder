import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MigrationHistorySourceBrowser } from './MigrationHistorySourceBrowser'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationHistorySourcesResult } from '../../../../shared/generated/contracts'

const transfer = vi.hoisted(() => ({ start: vi.fn(async () => {}), busy: false, requestId: null, error: null, result: null }))
vi.mock('@/kcoder/useMigrationSourceTransfer', () => ({ useMigrationSourceTransfer: () => transfer }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const current = () => true
const source: GatewayServer = { id: 'source-device', label: 'Source', description: '', runtime: 'kcoder', transport: 'ssh' }
const destination = { ...source, id: 'destination-device' }
function page(offset = 0): MigrationHistorySourcesResult {
  return { catalogId: 'owned-native-catalog', items: Array.from({ length: offset ? 3 : 10 }, (_, i) => ({ sourceHandle: `opaque-${offset + i}`,
    source: 'codex', sourceSessionId: `physical-session-${offset + i}`, sourceArtifactId: `physical-artifact-${offset + i}`,
    parentSessionId: null, agentId: null, bytes: 24, modifiedAtMs: null, archived: true, compressed: true,
    title: `Original history ${offset + i}`, project: null, previewIncomplete: i === 0,
    importIssues: offset === 0 && i === 1 ? ['migration_history_source_budget_exceeded'] : [] })),
    totalItems: 13, nextCursor: offset ? null : 'next-ten', discoveryComplete: false, problems: [{ code: 'partial', count: 1 }] }
}
afterEach(() => { vi.unstubAllGlobals(); transfer.start.mockClear() })

it('requires an explicit full family index and offers basic browsing after an old source rejects it without a fallback query', async () => {
  const queries: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return new Response(JSON.stringify({ status: 'ready', launching: false, ownedChildren: 1 }));
    if (String(url).endsWith('/close')) return new Response(JSON.stringify({ status: 'released' }));
    const q = JSON.parse(String(init?.body)).query; queries.push(q.kind);
    return q.kind === 'history_families' ? new Response(JSON.stringify({ error: 'source_transfer_unsupported_native' }), { status: 409 }) : new Response(JSON.stringify(page()));
  }));
  render(<MigrationHistorySourceBrowser source={source} destination={destination} isCurrent={current} onBusy={vi.fn()}/>);
  expect(screen.queryByTestId('migration-history-families-discover')).toBeNull(); fireEvent.click(screen.getByText('Codex'));
  expect(queries).toEqual([]); fireEvent.click(screen.getByTestId('migration-history-families-discover'));
  await screen.findByText('historyFamilies.updateRequired'); expect(queries).toEqual(['history_families']);
  expect(screen.queryByTestId('migration-history-source-row')).toBeNull();
  fireEvent.click(screen.getByTestId('migration-history-source-discover')); await screen.findByLabelText('Original history 0');
  expect(queries).toEqual(['history_families', 'history']);
});

it('shows ten physical items, keeps partial sources selectable and submits only explicitly selected cross-page opaque refs', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const input = JSON.parse(String(init?.body))
    return new Response(JSON.stringify(String(url).endsWith('/open') ? { status: 'ready', launching: false, ownedChildren: 1 }
      : String(url).endsWith('/close') ? { status: 'released' }
        : page(input.query.kind === 'history_page' && input.query.params.cursor ? 10 : 0)))
  })
  vi.stubGlobal('fetch', fetcher)
  const mounted = render(<MigrationHistorySourceBrowser source={source} destination={destination} isCurrent={current} onBusy={vi.fn()}/>)
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Codex'))
  fireEvent.click(screen.getByTestId('migration-history-source-discover'))
  await screen.findByLabelText('Original history 0')
  expect(screen.getAllByTestId('migration-history-source-row')).toHaveLength(10)
  expect(screen.queryByLabelText('Original history 10')).toBeNull()
  expect(screen.getByText('transferHistory.partialDiscovery')).toBeTruthy()
  expect(screen.getByLabelText('Original history 0')).not.toBeDisabled()
  expect(screen.getByLabelText('Original history 1')).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Original history 0'))
  fireEvent.click(screen.getByTestId('migration-history-source-next'))
  await screen.findByLabelText('Original history 12')
  expect(screen.getAllByTestId('migration-history-source-row')).toHaveLength(3)
  fireEvent.click(screen.getByLabelText('Original history 12'))
  await act(async () => {
    fireEvent.click(screen.getByTestId('migration-history-source-transfer'))
    fireEvent.click(screen.getByTestId('migration-history-source-transfer'))
  })
  expect(transfer.start).toHaveBeenCalledTimes(1)
  expect(transfer.start.mock.calls[0]).toEqual([expect.objectContaining({ purpose: 'source', targetId: source.id }), [
    { kind: 'history', catalogId: 'owned-native-catalog', sourceHandle: 'opaque-0' },
    { kind: 'history', catalogId: 'owned-native-catalog', sourceHandle: 'opaque-12' },
  ]])
  mounted.unmount()
  await waitFor(() => expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/close'))).toBe(true))
})

it('uses the same explicit source-directory control for history before opening a catalog', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return new Response(JSON.stringify({ status: 'ready', launching: false, ownedChildren: 1 }))
    if (String(url).endsWith('/close')) return new Response(JSON.stringify({ status: 'released' }))
    const body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify(body.query.kind === 'directory_select'
      ? { selectionId: body.query.params.selectionId, source: body.query.params.source, remainingMs: 600000 } : page()))
  })
  vi.stubGlobal('fetch', fetcher)
  render(<MigrationHistorySourceBrowser source={source} destination={destination} isCurrent={current} onBusy={vi.fn()}/>)
  fireEvent.click(screen.getByText('Codex'))
  fireEvent.click(screen.getByTestId('migration-source-directory-explicit'))
  expect(screen.getByTestId('migration-history-source-discover')).toBeDisabled()
  fireEvent.change(screen.getByTestId('migration-source-directory-path'), { target: { value: '/on/source/history-product' } })
  fireEvent.click(screen.getByTestId('migration-history-source-discover'))
  await screen.findByLabelText('Original history 0')
  const bodies = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
  expect(bodies[1].query).toMatchObject({ kind: 'directory_select', params: { source: 'codex', directory: '/on/source/history-product' } })
  expect(bodies[2].query.kind).toBe('history')
  expect(bodies[1].session).toEqual(bodies[2].session)
})
