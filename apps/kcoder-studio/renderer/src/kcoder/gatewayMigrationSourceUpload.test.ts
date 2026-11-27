import { expect, it, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { createSourceUploadApi } from './gatewayMigrationSourceUpload'

const id = '11111111-1111-4111-8111-111111111111'
const state = { upload: { operationId: id, manifestSha256: 'a'.repeat(64), source: 'codex', stage: 'receiving', sequence: 0,
  cancelWatermark: 0, cancelRequested: false, workerState: 'stopped', totalFiles: 1, completedFiles: 0,
  totalBytes: 4, receivedBytes: 4, verifiedBytes: 0, errorCode: null } }
const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.test', workspacePath: '/owned' }

it('gates uploads by capability and passes AbortSignal only to exact reads', async () => {
  const client = new FakeGatewayClient(null)
  const capability = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationSourceUploadV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(state as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  const invoke = (method: string, params: object) => runtime.request('runtime.migration.request', { deviceId: target.id, method, params }, options)
  try {
    await expect(invoke('migration/source/upload/read', { operationId: id })).rejects.toThrow('migration_source_upload_update_required')
    expect(request).not.toHaveBeenCalled(); capability.mockReturnValue(true)
    await expect(invoke('migration/source/upload/part', { operationId: id, path: '/private' })).rejects.toThrow('migration_invalid_parameters')
    await invoke('migration/source/upload/read', { operationId: id })
    expect(request).toHaveBeenLastCalledWith('migration/source/upload/read', { operationId: id }, options)
    const input = { operationId: id, commandId: '22222222-2222-4222-8222-222222222222' }
    await invoke('migration/source/upload/cancel', input)
    expect(request).toHaveBeenLastCalledWith('migration/source/upload/cancel', input)
  } finally { await runtime.dispose() }
})

it('rejects a foreign operation and a nonadvancing resume page', async () => {
  const invoke = vi.fn(), api = createSourceUploadApi(invoke)
  invoke.mockResolvedValueOnce({ upload: { ...state.upload, operationId: '22222222-2222-4222-8222-222222222222' } })
  await expect(api.sourceUploadRead({ operationId: id })).rejects.toThrow('migration_invalid_response')
  invoke.mockResolvedValueOnce({ page: { operationId: id, manifestSha256: 'a'.repeat(64), files: [], nextCursor: 0 } })
  await expect(api.sourceUploadFiles({ operationId: id })).rejects.toThrow('migration_invalid_response')
})
