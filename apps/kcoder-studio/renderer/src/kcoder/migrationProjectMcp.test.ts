import { expect, it, vi } from 'vitest'
import { ProjectMcpCatalogController, validProjectMcpCatalog, createProjectMcpApi, PROJECT_MCP_CAPABILITY, PROJECT_MCP_METHOD } from '../../../shared/migrationProjectMcp'
import type { MigrationProjectMcpCatalogResult } from '../../../shared/generated/contracts'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

const revision = 'a'.repeat(64)
const page = (index = 0): MigrationProjectMcpCatalogResult => ({ jobId: 'owned', status: 'selection_required',
  names: Array.from({ length: index === 0 ? 10 : 3 }, (_, n) => `server-${index * 10 + n}`), totalNames: 13, revision,
  nextPageIndex: index === 0 ? 1 : null })

it('keeps an explicit empty choice distinct from no confirmation, and retains selections across pages', async () => {
  const read = vi.fn(async input => page(input.pageIndex))
  const controller = new ProjectMcpCatalogController('owned', read, () => true)
  expect(controller.selection()).toBeUndefined()
  await controller.load()
  expect(controller.selection()).toBeUndefined()
  controller.confirm(true)
  expect(controller.selection()).toEqual({ names: [], expectedRevision: revision })
  controller.choose('server-0')
  expect(controller.selection()).toBeUndefined()
  await controller.load(1)
  controller.choose('server-12')
  controller.choose('unknown-server')
  controller.confirm(true)
  expect(controller.selection()).toEqual({ names: ['server-0', 'server-12'], expectedRevision: revision })
  expect(read).toHaveBeenLastCalledWith({ jobId: 'owned', pageIndex: 1, expectedRevision: revision })
})

it('invalidates all choices when the original catalog changes and ignores late responses after disposal', async () => {
  const read = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce({ ...page(1), revision: 'b'.repeat(64) })
  const controller = new ProjectMcpCatalogController('owned', read, () => true)
  await controller.load(); controller.choose('server-0'); controller.confirm(true)
  await controller.load(1)
  expect(controller.snapshot()).toMatchObject({ page: null, selected: [], confirmed: false, error: 'migration_invalid_response' })
  let release!: (value: MigrationProjectMcpCatalogResult) => void
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = controller.load(0, true)
  controller.invalidate()
  release(page()); await pending
  expect(controller.snapshot()).toMatchObject({ page: null, busy: false, selected: [] })
})

it('rejects foreign jobs, oversized or inconsistent pages, duplicate names and injected definitions', async () => {
  const input = { jobId: 'owned', pageIndex: 0 }
  const invoke = vi.fn(), api = createProjectMcpApi(invoke)
  for (const value of [{ ...page(), jobId: 'peer' }, { ...page(), names: [] }, { ...page(), totalNames: 1025 },
    { ...page(), nextPageIndex: null }, { ...page(), names: Array(10).fill('duplicate') }, { ...page(), definitions: [] }]) {
    invoke.mockResolvedValueOnce(value)
    await expect(api.projectMcpCatalog(input)).rejects.toThrow('migration_invalid_response')
  }
  expect(validProjectMcpCatalog({ jobId: 'owned', pageIndex: 1 })).toBe(false)
  expect(validProjectMcpCatalog({ ...input, profile: 'peer' })).toBe(false)
})

it('requires the independent target capability and forwards cancellation only for catalog reads', async () => {
  const target = { id: 'owned-target', label: 'Owned target', description: '', runtime: 'kcoder' as const, transport: 'local' as const }
  const client = new FakeGatewayClient(null)
  const support = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== PROJECT_MCP_CAPABILITY)
  const request = vi.spyOn(client, 'request').mockResolvedValue(page() as never)
  const runtime = createTestGatewayRuntime('fixture', { loadServers: async () => [target], createClient: () => client })
  const params = { jobId: 'owned', pageIndex: 0 }
  const options = { signal: new AbortController().signal }
  try {
    const invoke = () => runtime.request('runtime.migration.request', { deviceId: target.id, method: PROJECT_MCP_METHOD, params }, options)
    await expect(invoke()).rejects.toThrow('migration_project_mcp_update_required')
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    await expect(invoke()).resolves.toEqual(page())
    expect(request).toHaveBeenCalledWith(PROJECT_MCP_METHOD, params, options)
  } finally { await runtime.dispose() }
})
