import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MigrationMemorySourceDiscovery } from './migrationMemorySourceDiscovery'
import type { ImportedMemorySourceSummary } from '../../../shared/generated/contracts'
const { client, created } = vi.hoisted(() => ({ client: { open: vi.fn(), close: vi.fn(), query: vi.fn(), bindings: vi.fn(), selectDirectory: vi.fn() }, created: vi.fn() }))
vi.mock('./gatewayMigrationSourceSessions', async original => ({ ...await original<typeof import('./gatewayMigrationSourceSessions')>(), createMigrationSourceSessionClient: (options: unknown) => { created(options); return client } }))
const item = (n: number): ImportedMemorySourceSummary => ({ sourceId: `source-${n}`, source: 'codex', sourceGroup: 'memories', layout: 'codex_memory_files_v1', files: 1, bytes: 40, blockedItems: 0 })
const page = (start: number, end: number, next: string | null) => ({ catalogId: 'owned-catalog', items: Array.from({ length: end - start }, (_, i) => item(i + start)), nextCursor: next, problems: [], unobserved: ['source_runtime_selection'] })
beforeEach(() => { vi.clearAllMocks(); client.open.mockResolvedValue({ status: 'ready' }); client.close.mockResolvedValue({ status: 'released' }); client.query.mockResolvedValue(page(0, 10, 'next')); client.bindings.mockImplementation(async (_session, ids: string[]) => ({ bindings: ids.map(sourceId => ({ sourceId, family: 'assets' })) })) })
afterEach(() => { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ })
it('queries explicit memory catalogs in one child, retains selection across pages and resolves only Native asset grants', async () => {
  const model = new MigrationMemorySourceDiscovery('source', undefined, () => true)
  await model.discover('codex'); model.select('source-0', true)
  const session = model.snapshot().session!
  expect(client.query).toHaveBeenLastCalledWith({ session, query: { kind: 'memory', params: { source: 'codex' } } })
  client.query.mockResolvedValueOnce(page(10, 11, null)); await model.changePage('next'); model.select('source-10', true)
  expect(model.snapshot().selected.map(row => row.sourceId)).toEqual(['source-0', 'source-10'])
  expect(client.query).toHaveBeenLastCalledWith({ session, query: { kind: 'memory_page', params: { catalogId: 'owned-catalog', cursor: 'next' } } })
  await expect(model.selections()).resolves.toEqual([{ kind: 'assets', sourceId: 'source-0' }, { kind: 'assets', sourceId: 'source-10' }])
  expect(client.bindings).toHaveBeenCalledWith(session, ['source-0', 'source-10'])
  model.dispose()
})
it('clears a stale catalog selection and refuses a foreign family even when the source ID is unchanged', async () => {
  const model = new MigrationMemorySourceDiscovery('source', undefined, () => true)
  await model.discover('codex'); model.select('source-0', true)
  client.query.mockResolvedValueOnce({ ...page(10, 11, null), catalogId: 'different-catalog' })
  await model.changePage('next'); expect(model.snapshot().selected).toEqual([])
  expect(model.snapshot().page).toBeNull()
  await model.discover('codex'); model.select('source-0', true)
  client.bindings.mockResolvedValueOnce({ bindings: [{ sourceId: 'source-0', family: 'configuration' }] })
  await expect(model.selections()).rejects.toThrow('source_transfer_memory_catalog_unavailable')
  expect(model.snapshot().selected).toEqual([]); model.dispose()
})
it('a late open is cleaned through its original owner after the view closes and never queries the source', async () => {
  let finish!: (value: { status: string }) => void
  client.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const model = new MigrationMemorySourceDiscovery('original-source', undefined, () => true)
  const opening = model.discover('codex'); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const original = client.open.mock.calls[0][0]
  model.dispose(); finish({ status: 'ready' }); await opening
  expect(client.close).toHaveBeenCalledTimes(2)
  expect(client.close.mock.calls.map(([session]) => session)).toEqual([original, original])
  expect(client.query).not.toHaveBeenCalled()
})
it('cleanup does not borrow a new Relay mount or reactivate an old source lifetime', async () => {
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/old' }
  const model = new MigrationMemorySourceDiscovery('source', undefined, () => true)
  await model.discover('codex')
  const oldScope = created.mock.calls[0][0].captureScope
  expect(oldScope()).not.toBe('')
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/new' }
  expect(oldScope()).toBe('')
  model.dispose(); model.activate()
  model.select('source-0', true)
  expect(model.snapshot().selected).toEqual([])
  await expect(model.selections()).rejects.toThrow('source_transfer_memory_catalog_unavailable')
})
