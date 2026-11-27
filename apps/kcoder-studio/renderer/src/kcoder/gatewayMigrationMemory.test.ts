import { expect, it, vi } from 'vitest'
import { createMemoryApi } from './gatewayMigrationMemory'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const record = { id: 'ctx-owned', ownerOperationId: 'owner', name: 'Notes', scope: { kind: 'global' }, enabled: false, revision: 'sha', bytes: 3 }
const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.test', workspacePath: '/owned' }
it('uses an independent capability, validates before forwarding and keeps controls ordered', async () => {
  const client = new FakeGatewayClient(null), support = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationMemoryV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({ items: [record], totalRecords: 1, nextPage: null } as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  const invoke = (method: string, params: object) => runtime.request('runtime.migration.request', { deviceId: target.id, method, params }, options)
  try {
    await expect(invoke('migration/memory/list', {})).rejects.toThrow('migration_memory_update_required')
    expect(request).not.toHaveBeenCalled(); support.mockReturnValue(true)
    await expect(invoke('migration/memory/list', { path: '/not-authorized' })).rejects.toThrow('migration_invalid_parameters')
    await expect(invoke('migration/memory/list', {})).resolves.toHaveProperty('items')
    expect(request).toHaveBeenLastCalledWith('migration/memory/list', {}, options)
    const input = { requestId: 'controlled', id: 'ctx-owned', ownerOperationId: 'owner', expectedRevision: 'sha', enabled: true, confirmUnverifiedNotes: true }
    request.mockResolvedValueOnce({ receipt: { request: input, appliedRevision: 'new' }, current: { ...record, enabled: true, revision: 'new' } } as never)
    await invoke('migration/memory/control', input)
    expect(request).toHaveBeenLastCalledWith('migration/memory/control', input)
  } finally { await runtime.dispose() }
})
it('rejects oversized pages, foreign receipts, forged verified claims and non-progressing text', async () => {
  const invoke = vi.fn(), api = createMemoryApi(invoke)
  invoke.mockResolvedValueOnce({ items: Array(11).fill(record), totalRecords: 11, nextPage: 1 })
  await expect(api.memoryList({})).rejects.toThrow('migration_invalid_response')
  invoke.mockResolvedValueOnce({ receipt: { request: { requestId: 'foreign', id: 'ctx-owned', ownerOperationId: 'owner', expectedRevision: 'sha', enabled: false, confirmUnverifiedNotes: false }, appliedRevision: 'new' }, current: record })
  await expect(api.memoryControlRead({ requestId: 'owned' })).rejects.toThrow('migration_invalid_response')
  invoke.mockResolvedValueOnce({ record, text: 'abc', totalBytes: 10, nextOffset: 0 })
  await expect(api.memoryRead({ id: record.id })).rejects.toThrow('migration_invalid_response')
  invoke.mockResolvedValueOnce({ items: [{ ...record, provenance: { source: 'codex', layout: 'codex_memory_files_v1', sourceGroup: 'memories', sourceFile: 'MEMORY.md', sourceRevision: 'sha', sourceModifiedAtMs: null, factsVerified: true } }], totalRecords: 1, nextPage: null })
  await expect(api.memoryList({})).rejects.toThrow('migration_invalid_response')
})
