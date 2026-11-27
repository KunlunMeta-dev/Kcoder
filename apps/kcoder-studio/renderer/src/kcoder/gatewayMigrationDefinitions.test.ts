import { expect, it, vi } from 'vitest'
import { createDefinitionsApi } from './gatewayMigrationDefinitions'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { validDefinitionCall } from '../../../shared/migrationDefinitions'
import { DefinitionSourcesController } from '../../../shared/migrationDefinitionSources'
import { DefinitionPreviewController } from '../../../shared/migrationDefinitionPreview'
import type * as C from '../../../shared/generated/contracts'
const item = { jobId: 'mig-owned', itemId: 'item-owned' }
const report: C.MigrationDefinitionReportResult = { ...item, pageIndex: 0, totalFields: 1, nextPage: null, totalBytes: 3, report: { kind: 'agent', format: 'claude_agent_markdown', parseStatus: 'parsed', elements: 1, unknownFields: 0, fields: [{ ordinal: 0, element: 0, field: 'tools' }], executionAllowed: false, requiresReview: true } }
const body: C.MigrationDefinitionBodyResult = { ...item, offset: 0, encoding: 'utf8', text: 'abc', bytesBase64: 'YWJj', totalBytes: 3, nextOffset: null, sha256: 'a'.repeat(64) }
const source = (i: number): C.MigrationSourceSummary => ({ sourceId: `opaque-${i}`, kind: 'claude-code', scope: 'user-agents', displayName: 'Agent source', formatRevision: 'fixture/v1', availableCategories: ['agent'] })
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { resolve, promise } }
it('gates the new read-only methods before forwarding and refuses arbitrary paths', async () => {
  const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.invalid' }
  const client = new FakeGatewayClient(null), supports = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationDefinitionsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(report as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const invoke = (method: string, params: object) => runtime.request('runtime.migration.request', { deviceId: target.id, method, params })
  try {
    await expect(invoke('migration/definitions/report', item)).rejects.toThrow('migration_definitions_update_required'); expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    await expect(invoke('migration/definitions/body', { ...item, path: '/private' })).rejects.toThrow('migration_invalid_parameters'); expect(request).not.toHaveBeenCalled()
    await expect(invoke('migration/definitions/report', item)).resolves.toEqual(report)
  } finally { await runtime.dispose() }
})
it('rejects executable claims, leaked arbitrary source keys, oversized pages and foreign locators', async () => {
  const invoke = vi.fn(), api = createDefinitionsApi(invoke)
  for (const bad of [{ ...report, report: { ...report.report, executionAllowed: true } }, { ...report, report: { ...report.report, requiresReview: false } }, { ...report, report: { ...report.report, fields: [{ ordinal: 0, element: 0, field: null, sourceKey: 'PRIVATE_NAME' }] } }, { ...report, itemId: 'peer' }, { ...report, totalFields: 11, report: { ...report.report, fields: Array(11).fill(report.report.fields[0]) } }]) {
    invoke.mockResolvedValueOnce(bad); await expect(api.definitionReport(item)).rejects.toThrow('migration_invalid_response')
  }
  expect(validDefinitionCall('migration/definitions/discover', { pageIndex: 1 })).toBe(false)
})
it('validates raw UTF8 windows, binary data and strict progression without executing or reparsing body text', async () => {
  const method = 'migration/definitions/body'
  expect(validDefinitionCall(method, item, body)).toBe(true)
  for (const bad of [{ ...body, offset: 1 }, { ...body, nextOffset: 0 }, { ...body, text: 'wrong' }, { ...body, bytesBase64: 'YWJj\n' }, { ...body, bytesBase64: 'AAAA'.repeat(6000) }, { ...body, encoding: 'binary', text: 'abc' }]) expect(validDefinitionCall(method, item, bad)).toBe(false)
  const binaryBody = { ...body, encoding: 'binary', bytesBase64: '/wD+', totalBytes: 3 }; delete binaryBody.text
  expect(validDefinitionCall(method, item, binaryBody)).toBe(true)
})
it('keeps ten source rows per Native page and 64 explicit selections without auto-discovery or body reads', async () => {
  const discover = vi.fn(async (p: C.MigrationDefinitionsDiscoverParams): Promise<C.MigrationDefinitionsDiscoverResult> => ({ catalogId: 'owned', totalSources: 70, nextPage: (p.pageIndex ?? 0) < 6 ? (p.pageIndex ?? 0) + 1 : null, sources: Array.from({ length: 10 }, (_, i) => source((p.pageIndex ?? 0) * 10 + i)), problems: [] }))
  const scan = vi.fn(async (ids: string[]) => { expect(ids.length).toBeGreaterThan(0); return 'mig-selected' }), model = new DefinitionSourcesController({ definitionsDiscover: discover, scan }, () => true)
  expect(discover).not.toHaveBeenCalled(); await model.discover()
  for (let page = 0; page < 7; page++) { if (page) await model.page(page); for (const row of model.snapshot().page!.sources) model.select(row.sourceId) }
  expect(model.snapshot().selected).toHaveLength(64); expect(await model.prepare()).toBe('mig-selected'); expect(scan.mock.calls[0][0]).toHaveLength(64); model.dispose()
})
it('drops late account/view results and never blindly retries uncertain preview creation', async () => {
  let current = true; const pending = deferred<C.MigrationDefinitionsDiscoverResult>()
  const discover = vi.fn(() => pending.promise), scan = vi.fn(async () => { throw new Error('lost preview reply') })
  const model = new DefinitionSourcesController({ definitionsDiscover: discover, scan }, () => current)
  const reading = model.discover(); current = false; pending.resolve({ catalogId: 'old', totalSources: 0, nextPage: null, sources: [], problems: [] }); await reading; expect(model.snapshot().page).toBeNull(); model.dispose()
  current = true; discover.mockResolvedValue({ catalogId: 'owned', sources: [source(0)], totalSources: 1, nextPage: null, problems: [] })
  const second = new DefinitionSourcesController({ definitionsDiscover: discover, scan }, () => true); await second.discover(); second.select('opaque-0'); await second.prepare(); await second.prepare()
  expect(scan).toHaveBeenCalledTimes(1); expect(second.snapshot().scanUnknown).toBe(true); second.dispose()
})
it('loads reports/text only explicitly and discards late body replies after closing', async () => {
  const pending = deferred<C.MigrationDefinitionBodyResult>(), api = { definitionReport: vi.fn(async () => report), definitionBody: vi.fn(() => pending.promise) }
  const model = new DefinitionPreviewController(api, item, () => true)
  expect(api.definitionReport).not.toHaveBeenCalled(); expect(api.definitionBody).not.toHaveBeenCalled()
  await model.report(); expect(model.snapshot().report).toEqual(report)
  const reading = model.body(); model.dispose(); pending.resolve(body); await reading; expect(model.snapshot().body).toBeNull()
})
