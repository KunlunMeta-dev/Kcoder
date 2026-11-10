import { afterEach, expect, it, vi } from 'vitest'
import { MigrationHistorySourceDiscovery } from './migrationHistorySourceDiscovery'
import type { HistorySourceSummary, MigrationHistorySourcesResult } from '../../../shared/generated/contracts'

const ready = { status: 'ready', launching: false, ownedChildren: 1 }
const current = () => true
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function item(index: number): HistorySourceSummary {
  return { sourceHandle: `opaque-history-${index}`, source: 'codex', sourceSessionId: `session-${index}`,
    sourceArtifactId: `artifact-${index}`, parentSessionId: null, agentId: null, bytes: 123, modifiedAtMs: null,
    archived: false, compressed: false, title: `History ${index}`, project: null, previewIncomplete: false, importIssues: [] }
}
function page(offset = 0, count = 13): MigrationHistorySourcesResult {
  return { catalogId: 'opaque-catalog', items: Array.from({ length: Math.min(10, count - offset) }, (_, index) => item(offset + index)),
    totalItems: count, nextCursor: offset + 10 < count ? `cursor-${offset + 10}` : null, discoveryComplete: true, problems: [] }
}
function fixture(count = 13) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const input = JSON.parse(String(init?.body))
    return response(page(input.query.kind === 'history' ? 0 : Number(input.query.params.cursor?.split('-')[1] ?? 0), count))
  })
  vi.stubGlobal('fetch', fetcher)
  return { fetcher, model: new MigrationHistorySourceDiscovery('source-host', '/owned-project', current) }
}
afterEach(() => vi.unstubAllGlobals())

it('explicitly indexes Codex families and keeps a third-page grandchild under the previously observed root without selecting ancestors', async () => {
  const f = fixture(22)
  const familyPage = (offset: number) => {
    const value = page(offset, 22)
    value.items = value.items.map(row => { const at = Number(row.sourceHandle.split('-').at(-1)); return { ...row,
      parentSessionId: at === 0 ? null : at <= 9 ? 'session-0' : at <= 19 ? 'session-9' : 'session-19', project: at ? '/different-child-cwd' : '/parent-cwd' } })
    return value
  }
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const q = JSON.parse(String(init?.body)).query
    return response(familyPage(q.kind === 'history_page' ? Number(q.params.cursor?.split('-')[1] ?? 0) : 0))
  })
  await f.model.discover('codex', undefined, true); f.model.select('opaque-history-9', true)
  await f.model.page('next'); await f.model.page('next'); f.model.select('opaque-history-21', true)
  expect(f.model.snapshot().familyGroups?.[0]).toMatchObject({ sessionId: 'session-0', title: 'History 0', parentObserved: true, parentOnPage: false })
  expect(f.model.snapshot().familyGroups?.[0].items).toHaveLength(2)
  expect(f.model.selections()).toEqual([{ kind: 'history', catalogId: 'opaque-catalog', sourceHandle: 'opaque-history-9' }, { kind: 'history', catalogId: 'opaque-catalog', sourceHandle: 'opaque-history-21' }])
  expect(f.fetcher.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).query?.kind === 'history')).toHaveLength(0)
  expect(f.fetcher.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).query?.kind === 'history_families')).toHaveLength(1)
  await f.model.close(); expect(f.model.snapshot().familyGroups).toBeNull()
})

it('never falls back to basic discovery after an old family capability rejects the explicit query', async () => {
  const f = fixture()
  f.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/open') ? response(ready) : String(url).endsWith('/close') ? response({ status: 'released' })
    : JSON.parse(String(init?.body)).query.kind === 'history_families' ? response({ error: 'source_transfer_unsupported_native' }, 409) : response(page()))
  await f.model.discover('codex', undefined, true)
  expect(f.model.snapshot().error).toBe('source_transfer_unsupported_native'); expect(f.model.snapshot().page).toBeNull()
  expect(f.fetcher.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).query?.kind === 'history')).toHaveLength(0)
  await f.model.discover('codex'); expect(f.model.snapshot().familyMode).toBe(false); expect(f.model.snapshot().page).not.toBeNull()
  await f.model.close()
})

it('uses only the selected source session and opaque catalog, preserving explicit selections across ten-item pages', async () => {
  const { model, fetcher } = fixture()
  await model.discover('codex')
  const opened = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  expect(opened).toMatchObject({ purpose: 'source', targetId: 'source-host', workspacePath: '/owned-project' })
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ session: opened, query: { kind: 'history', params: { source: 'codex' } } })
  expect(model.snapshot().page?.items).toHaveLength(10)
  model.select('opaque-history-0', true)
  await model.page('next'); expect(model.snapshot().page?.items).toHaveLength(3)
  model.select('opaque-history-12', true)
  expect(model.selections()).toEqual([{ kind: 'history', catalogId: 'opaque-catalog', sourceHandle: 'opaque-history-0' },
    { kind: 'history', catalogId: 'opaque-catalog', sourceHandle: 'opaque-history-12' }])
  expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ session: opened, query: { kind: 'history_page', params: { catalogId: 'opaque-catalog', cursor: 'cursor-10' } } })
  await model.page('previous'); expect(model.snapshot().selected).toHaveLength(2)
  await model.close(); expect(model.snapshot().session).toBeNull()
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual(opened)
})

it('keeps partial discovery, incomplete previews and original compressed/archived artifacts selectable', async () => {
  const f = fixture()
  const value = page(); value.discoveryComplete = false; value.problems = [{ code: 'history_discovery_unsafe_entry', count: 1 }]
  value.items[0] = { ...item(0), compressed: true, archived: true, previewIncomplete: true, parentSessionId: 'parent-session' }
  value.items[1] = { ...item(1), importIssues: ['migration_history_source_budget_exceeded'] }
  f.fetcher.mockImplementationOnce(async () => response(ready)).mockImplementationOnce(async () => response(value))
  await f.model.discover('codex')
  f.model.select(value.items[0].sourceHandle, true); f.model.select(value.items[1].sourceHandle, true)
  expect(f.model.snapshot().selected).toEqual([value.items[0]])
  expect(f.model.selections()).toHaveLength(1)
  expect(f.model.snapshot().page?.items[0].sourceArtifactId).toBe('artifact-0')
})

it('never accepts more than 64 explicit references across pages or silently replaces the catalog', async () => {
  const { model } = fixture(70)
  await model.discover('codex')
  for (let index = 0; index < 7; index++) {
    for (const row of model.snapshot().page!.items) model.select(row.sourceHandle, true)
    if (index < 6) await model.page('next')
  }
  expect(model.selections()).toHaveLength(64)
  expect(new Set(model.selections().map(value => value.kind === 'history' && value.catalogId))).toEqual(new Set(['opaque-catalog']))
  await model.discover('codex')
  expect(model.snapshot().selected).toEqual([])
  expect(() => model.selections()).toThrow('catalog_unavailable')
})

it.each(['foreign-catalog', 'wrong-source', 'looping-cursor', 'failed-query'])('invalidates the whole catalog on %s without submitting stale selections', async kind => {
  const { model, fetcher } = fixture()
  await model.discover('codex'); model.select('opaque-history-0', true)
  const value = page(10)
  if (kind === 'foreign-catalog') value.catalogId = 'peer-catalog'
  if (kind === 'wrong-source') value.items[0].source = 'claude-code'
  if (kind === 'looping-cursor') value.nextCursor = 'cursor-10'
  fetcher.mockResolvedValueOnce(kind === 'failed-query' ? response({ error: 'source_transfer_outcome_unknown' }, 409) : response(value))
  await model.page('next')
  expect(model.snapshot().page).toBeNull(); expect(model.snapshot().selected).toEqual([])
  expect(model.snapshot().error).toBe('source_transfer_history_catalog_unavailable')
  expect(() => model.selections()).toThrow('catalog_unavailable')
  expect(fetcher.mock.calls.filter(call => String(call[0]).includes('/source-transfer/'))).toHaveLength(0)
})

it('does not query after unmount and rechecks only its own late open cleanup', async () => {
  let complete!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/open')
    ? new Promise(resolve => { complete = resolve }) : response({ status: 'released' }))
  vi.stubGlobal('fetch', fetcher)
  const model = new MigrationHistorySourceDiscovery('original-host', undefined, current), pending = model.discover('codex')
  model.dispose(); complete(response(ready)); await pending
  const original = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/query'))).toHaveLength(0)
  for (const call of fetcher.mock.calls.slice(1)) expect(JSON.parse(String(call[1]?.body))).toEqual(original)
})

it('retains uncertain original cleanup and cannot launch another source process', async () => {
  const f = fixture(); await f.model.discover('codex')
  f.fetcher.mockResolvedValue(response({ status: 'unknown' }))
  await f.model.discover('claude-code')
  expect(f.model.snapshot().releasePending).toBe(true)
  expect(f.model.snapshot().page).toBeNull()
  expect(f.fetcher.mock.calls.filter(call => String(call[0]).endsWith('/open'))).toHaveLength(1)
})

it('discards a late page reply when the source view changes and never retargets cleanup', async () => {
  const f = fixture(); await f.model.discover('codex')
  let complete!: (value: Response) => void
  f.fetcher.mockImplementationOnce(async () => new Promise(resolve => { complete = resolve }))
  const pending = f.model.page('next'); f.model.dispose(); complete(response(page(10))); await pending
  expect(f.model.snapshot().pageIndex).toBe(0)
  expect(f.fetcher.mock.calls.filter(call => String(call[0]).endsWith('/close')).every(call => JSON.parse(String(call[1]?.body)).targetId === 'source-host')).toBe(true)
})

it('explicit history directories reconcile the same lost grant before any catalog discovery', async () => {
  let lose = true
  const f = fixture()
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const body = JSON.parse(String(init?.body))
    if (body.query.kind === 'directory_select') {
      if (lose) { lose = false; throw new TypeError('owned lost select reply') }
      return response({ selectionId: body.query.params.selectionId, source: body.query.params.source, remainingMs: 600000 })
    }
    return response(page())
  })
  await f.model.discover('codex', '/remote/selected-product')
  expect(f.model.snapshot().page).toBeNull()
  expect(f.fetcher.mock.calls).toHaveLength(2)
  await f.model.discover('codex', '/remote/selected-product')
  const bodies = f.fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
  expect(bodies.filter(value => value.query?.kind === 'directory_select')[1]).toEqual(bodies[1])
  expect(bodies.at(-1).query.kind).toBe('history')
  expect(f.model.snapshot().page?.items).toHaveLength(10)
})
it('a mount change during an explicit history grant cannot discover or clean up through the new mount', async () => {
  const f = fixture()
  let finish!: (value: Response) => void
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    const body = JSON.parse(String(init?.body))
    if (body.query?.kind === 'directory_select') return new Promise(resolve => { finish = resolve })
    return response({ status: 'released' })
  })
  const pending = f.model.discover('codex', '/remote/selected-product')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const original = JSON.parse(String(f.fetcher.mock.calls[1][1]?.body))
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/different-relay-mount' }
  finish(response({ selectionId: original.query.params.selectionId, source: 'codex', remainingMs: 600000 }))
  await pending; f.model.dispose(); await Promise.resolve()
  expect(f.fetcher).toHaveBeenCalledTimes(2)
  expect(f.model.snapshot().page).toBeNull()
  delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
})

it('rechecks visibility between the confirmed directory grant and history discovery', async () => {
  let granted = false, currentScope = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response(ready)
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    const body = JSON.parse(String(init?.body))
    if (body.query.kind === 'directory_select') granted = true
    return response(body.query.kind === 'directory_select'
      ? { selectionId: body.query.params.selectionId, source: body.query.params.source, remainingMs: 600000 } : page())
  })
  vi.stubGlobal('fetch', fetcher)
  const valid = () => { if (granted) { granted = false; queueMicrotask(() => { currentScope = false }) } return currentScope }
  const model = new MigrationHistorySourceDiscovery('source', undefined, valid)
  await model.discover('codex', '/on/source/product')
  expect(fetcher.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).query?.kind === 'history')).toHaveLength(0)
})
