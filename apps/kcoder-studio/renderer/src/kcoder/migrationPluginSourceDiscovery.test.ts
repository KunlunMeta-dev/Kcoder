import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MigrationPluginSourceDiscovery } from './migrationPluginSourceDiscovery'
const { client, created } = vi.hoisted(() => ({
  client: {
    open: vi.fn(),
    close: vi.fn(),
    plugins: vi.fn(),
    selectDirectory: vi.fn(),
    selectUploaded: vi.fn(),
  },
  created: vi.fn(),
}))
vi.mock('./gatewayMigrationSourceSessions', async original => ({
  ...(await original<typeof import('./gatewayMigrationSourceSessions')>()),
  createMigrationSourceSessionClient: (options: unknown) => {
    created(options)
    return client
  },
}))
const item = (index: number, scope = 'project') => ({
  candidateId: `plug-${index}`,
  source: 'codex' as const,
  name: `plugin-${index}`,
  installedVersion: '1.0.0',
  scope,
  sourceEnabled: true,
  pending: scope === 'project' ? ['plugin_project_mapping_required'] : [],
})
const page = (start: number, next: string | null) => ({
  candidates: Array.from({ length: 10 }, (_, i) => item(start + i)),
  nextCursor: next,
  problems: [],
})
beforeEach(() => {
  vi.clearAllMocks()
  client.open.mockResolvedValue({ status: 'ready' })
  client.close.mockResolvedValue({ status: 'released' })
  client.plugins.mockResolvedValue(page(0, 'fixed-catalog:10'))
})
afterEach(() => {
  delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
})
it('keeps a cursor catalog and cross-page opaque plugin grants in the same source child', async () => {
  const model = new MigrationPluginSourceDiscovery('source', '/workspace', () => true)
  await model.discover('codex', true)
  const session = model.snapshot().session!
  model.select('plug-0', true)
  client.plugins.mockResolvedValueOnce(page(10, null))
  await model.changePage('next')
  model.select('plug-10', true)
  expect(client.plugins).toHaveBeenLastCalledWith(session, {
    sources: ['codex'],
    includeProject: true,
    cursor: 'fixed-catalog:10',
  })
  expect(model.selections()).toEqual([
    { kind: 'plugin', candidateId: 'plug-0' },
    { kind: 'plugin', candidateId: 'plug-10' },
  ])
  await model.changePage('previous')
  expect(model.snapshot().pageIndex).toBe(0)
  expect(client.plugins).toHaveBeenCalledTimes(2)
  model.dispose()
})
it('does not treat unknown contributions as transferable and rejects duplicate or foreign catalog rows', async () => {
  const model = new MigrationPluginSourceDiscovery('source', undefined, () => true)
  client.plugins.mockResolvedValueOnce({
    ...page(0, 'fixed:10'),
    candidates: [{ ...item(0), pending: ['plugin_install_fields_pending'] }],
  })
  await model.discover('codex', false)
  model.select('plug-0', true)
  expect(model.snapshot().selected).toEqual([])
  client.plugins.mockResolvedValueOnce(page(0, 'fixed:10'))
  await model.discover('codex', false)
  model.select('plug-0', true)
  client.plugins.mockResolvedValueOnce(page(0, null))
  await model.changePage('next')
  expect(model.snapshot().page).toBeNull()
  expect(model.snapshot().selected).toEqual([])
  client.plugins.mockResolvedValueOnce({
    ...page(0, null),
    candidates: [{ ...item(0), source: 'claude-code' }],
  })
  await model.discover('codex', false)
  expect(model.snapshot().page).toBeNull()
  model.dispose()
})
it('retries an unknown directory selection with its original identity and discards a late open', async () => {
  client.selectDirectory
    .mockRejectedValueOnce(new Error('lost receipt'))
    .mockImplementation(async (_session, p) => ({
      selectionId: p.selectionId,
      source: p.source,
      remainingMs: 600000,
    }))
  const model = new MigrationPluginSourceDiscovery('source', undefined, () => true)
  await model.discover('codex', false, '/product')
  const session = model.snapshot().session
  await model.discover('codex', false, '/product')
  expect(model.snapshot().session).toEqual(session)
  expect(client.selectDirectory.mock.calls[0][1].selectionId).toEqual(
    client.selectDirectory.mock.calls[1][1].selectionId
  )
  model.dispose()
  let finish!: (value: unknown) => void
  client.open.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const late = new MigrationPluginSourceDiscovery('original', undefined, () => true),
    opening = late.discover('codex', false)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const original = client.open.mock.calls.at(-1)![0]
  late.dispose()
  finish({ status: 'ready' })
  await opening
  expect(client.close.mock.calls.slice(-2).every(([actual]) => actual === original)).toBe(true)
})
it('binds cleanup and results to the original Relay mount', async () => {
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/old' }
  const model = new MigrationPluginSourceDiscovery('source', undefined, () => true)
  await model.discover('codex', false)
  const capture = created.mock.calls[0][0].captureScope
  expect(capture()).not.toBe('')
  window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/new' }
  expect(capture()).toBe('')
  model.dispose()
})

it('project and local rows cannot be selected without the explicit source project grant', async () => {
  const model = new MigrationPluginSourceDiscovery('source', '/project', () => true)
  await model.discover('codex', false)
  model.select('plug-0', true)
  expect(model.snapshot().selected).toEqual([])
  expect(() => model.selections()).toThrow('source_transfer_plugin_catalog_unavailable')
  model.dispose()
})

it('binds uploaded package pages to the exact product selection without claiming a source workspace grant', async () => {
  const root = {
    operationId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'a'.repeat(64),
  }
  client.selectUploaded.mockResolvedValue({
    ...root,
    source: 'codex',
    origin: 'user_supplied',
    remainingMs: 600000,
  })
  const model = new MigrationPluginSourceDiscovery('target-with-upload', undefined, () => true)
  await model.discover('codex', false, root)
  const session = model.snapshot().session!
  expect(client.selectUploaded).toHaveBeenCalledWith(session, root)
  expect(client.plugins).toHaveBeenLastCalledWith(session, {
    sources: ['codex'],
    includeProject: false,
    includeUploaded: true,
  })
  model.select('plug-0', true)
  client.plugins.mockResolvedValueOnce(page(10, null))
  await model.changePage('next')
  model.select('plug-10', true)
  expect(client.plugins).toHaveBeenLastCalledWith(session, {
    sources: ['codex'],
    includeProject: false,
    includeUploaded: true,
    cursor: 'fixed-catalog:10',
  })
  expect(model.selections()).toEqual([
    { kind: 'plugin', candidateId: 'plug-0' },
    { kind: 'plugin', candidateId: 'plug-10' },
  ])
  expect(client.selectDirectory).not.toHaveBeenCalled()
  model.dispose()
})

it('never falls back to ordinary home discovery after an unsupported uploaded-plugin query', async () => {
  const root = {
    operationId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'a'.repeat(64),
  }
  client.selectUploaded.mockResolvedValue({
    ...root,
    source: 'codex',
    origin: 'user_supplied',
    remainingMs: 600000,
  })
  const { MigrationSourceHttpError } = await import('./gatewayMigrationSourceSessions')
  client.plugins.mockRejectedValueOnce(
    new MigrationSourceHttpError('source_transfer_uploaded_update_required', false)
  )
  const model = new MigrationPluginSourceDiscovery('old-target', undefined, () => true)
  await model.discover('codex', false, root)
  expect(model.snapshot().error).toBe('source_transfer_uploaded_update_required')
  expect(model.snapshot().selected).toEqual([])
  expect(client.plugins).toHaveBeenCalledTimes(1)
  model.dispose()
})
