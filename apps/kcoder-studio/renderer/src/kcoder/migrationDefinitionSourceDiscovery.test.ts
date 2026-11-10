import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MigrationDefinitionSourceDiscovery } from './migrationDefinitionSourceDiscovery'
import type { MigrationSourceSummary } from '../../../shared/generated/contracts'
const { client, created } = vi.hoisted(() => ({ client: { open: vi.fn(), close: vi.fn(), definitions: vi.fn(), bindings: vi.fn(), selectDirectory: vi.fn() }, created: vi.fn() }))
vi.mock('./gatewayMigrationSourceSessions', async original => ({ ...await original<typeof import('./gatewayMigrationSourceSessions')>(), createMigrationSourceSessionClient: (options: unknown) => { created(options); return client } }))
const item = (n: number): MigrationSourceSummary => ({ sourceId: `source-${n}`, kind: 'codex', displayName: 'Codex', scope: 'user-agents', availableCategories: ['agent'], formatRevision: 'passive-definition/v1' })
const page = (start: number, end: number, next: number | null) => ({ catalogId: 'owned-catalog', sources: Array.from({ length: end - start }, (_, i) => item(i + start)), nextPage: next, totalSources: 11, problems: [] })
beforeEach(() => { vi.clearAllMocks(); client.open.mockResolvedValue({ status: 'ready' }); client.close.mockResolvedValue({ status: 'released' }); client.definitions.mockResolvedValue(page(0, 10, 1)); client.bindings.mockImplementation(async (_session, ids: string[]) => ({ bindings: ids.map(sourceId => ({ sourceId, family: 'assets' })) })) })
afterEach(() => { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ })
it('keeps ten-row static catalogs in one child and uses native binding families before transfer', async () => {
  const model = new MigrationDefinitionSourceDiscovery('source', undefined, () => true)
  await model.discover('codex', true); model.select('source-0', true)
  const session = model.snapshot().session!
  expect(client.definitions).toHaveBeenLastCalledWith(session, { sources: ['codex'], includeProject: true, pageIndex: 0 })
  client.definitions.mockResolvedValueOnce(page(10, 11, null)); await model.changePage('next'); model.select('source-10', true)
  expect(model.snapshot().selected.map(row => row.sourceId)).toEqual(['source-0', 'source-10'])
  expect(client.definitions).toHaveBeenLastCalledWith(session, { sources: ['codex'], includeProject: true, catalogId: 'owned-catalog', pageIndex: 1 })
  await expect(model.selections()).resolves.toEqual([{ kind: 'assets', sourceId: 'source-0' }, { kind: 'assets', sourceId: 'source-10' }])
  expect(client.bindings).toHaveBeenCalledWith(session, ['source-0', 'source-10'])
  model.dispose()
})
it('rejects a changed catalog and a same-ID configuration binding without substituting source IDs', async () => {
  const model = new MigrationDefinitionSourceDiscovery('source', undefined, () => true)
  await model.discover('codex', false); model.select('source-0', true)
  client.definitions.mockResolvedValueOnce({ ...page(10, 11, null), catalogId: 'other' }); await model.changePage('next')
  expect(model.snapshot().selected).toEqual([]); expect(model.snapshot().page).toBeNull()
  await model.discover('codex', false); model.select('source-0', true)
  client.bindings.mockResolvedValueOnce({ bindings: [{ sourceId: 'source-0', family: 'configuration' }] })
  await expect(model.selections()).rejects.toThrow('source_transfer_definition_catalog_unavailable')
  expect(model.snapshot().selected).toEqual([]); model.dispose()
})
it('cleans a late open using its original session and never discovers under the replacement view', async () => {
  let finish!: (value: { status: string }) => void
  client.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const model = new MigrationDefinitionSourceDiscovery('original-source', undefined, () => true)
  const opening = model.discover('codex', false); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const original = client.open.mock.calls[0][0]
  model.dispose(); finish({ status: 'ready' }); await opening
  expect(client.close.mock.calls.map(([session]) => session)).toEqual([original, original])
  expect(client.definitions).not.toHaveBeenCalled()
})
it('a pending directory select retries exactly its original authority, and Relay mount changes invalidate cleanup routing', async () => {
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/old' }
  client.selectDirectory.mockRejectedValueOnce(new Error('lost receipt')).mockImplementation(async (_session, params) => ({ selectionId: params.selectionId, source: params.source, remainingMs: 600000 }))
  const model = new MigrationDefinitionSourceDiscovery('source', undefined, () => true)
  await model.discover('codex', false, '/owned/product'); const original = client.open.mock.calls[0][0]
  await model.discover('codex', false, '/owned/product')
  expect(client.open.mock.calls[1][0]).toEqual(original)
  expect(client.selectDirectory.mock.calls[1][1].selectionId).toEqual(client.selectDirectory.mock.calls[0][1].selectionId)
  const capture = created.mock.calls[0][0].captureScope; expect(capture()).not.toBe('')
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/new' }; expect(capture()).toBe('')
  model.dispose(); model.activate(); model.select('source-0', true)
  expect(model.snapshot().selected).toEqual([])
})
