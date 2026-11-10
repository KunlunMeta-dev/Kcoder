import { expect, it, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { createSourceProductApi } from './gatewayMigrationSourceProduct'

const id = '11111111-1111-4111-8111-111111111111', digest = 'a'.repeat(64)
const selector = { operationId: id, manifestSha256: digest }
const state = { materialization: { ...selector, source: 'codex', stage: 'verifying', sequence: 4, cancelWatermark: 2,
  cancelRequested: false, workerState: 'running', totalFiles: 1, completedFiles: 0, totalBytes: 4, receivedBytes: 4, verifiedBytes: 0, errorCode: null } }
const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.test', workspacePath: '/owned' }

it('gates product preparation independently and keeps its controls ordered', async () => {
  const client = new FakeGatewayClient(null)
  const capability = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationSourceUploadedV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(state as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  const invoke = (method: string, params: object) => runtime.request('runtime.migration.request', { deviceId: target.id, method, params }, options)
  try {
    await expect(invoke('migration/source/upload/product/read', selector)).rejects.toThrow('migration_source_uploaded_update_required')
    expect(request).not.toHaveBeenCalled(); capability.mockReturnValue(true)
    await expect(invoke('migration/source/upload/product/read', { ...selector, path: '/not-authority' })).rejects.toThrow('migration_invalid_parameters')
    await invoke('migration/source/upload/product/read', selector)
    expect(request).toHaveBeenLastCalledWith('migration/source/upload/product/read', selector, options)
    const run = { ...selector, expectedSequence: 4, cancelWatermark: 2 }
    await invoke('migration/source/upload/product/run', run)
    expect(request).toHaveBeenLastCalledWith('migration/source/upload/product/run', run)
  } finally { await runtime.dispose() }
})

it('does not accept an upload receipt as a product receipt or a foreign manifest', async () => {
  const invoke = vi.fn(), api = createSourceProductApi(invoke)
  invoke.mockResolvedValueOnce({ upload: state.materialization })
  await expect(api.sourceProductRead(selector)).rejects.toThrow('migration_invalid_response')
  invoke.mockResolvedValueOnce({ materialization: { ...state.materialization, manifestSha256: 'b'.repeat(64) } })
  await expect(api.sourceProductRead(selector)).rejects.toThrow('migration_invalid_response')
  invoke.mockResolvedValueOnce({ materialization: { ...state.materialization, stage: 'ready' } })
  await expect(api.sourceProductRead(selector)).rejects.toThrow('migration_invalid_response')
})
