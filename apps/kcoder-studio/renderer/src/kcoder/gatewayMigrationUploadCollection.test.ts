import { expect, test, vi } from 'vitest'
import { createUploadCollectionApi } from './gatewayMigrationUploadCollection'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const selection = { jobId: 'history', position: 0, blockIndex: 0 }
const value = {
  operationId: 'owned',
  selection,
  collectionId: 'a'.repeat(64),
  sequence: 1,
  uploadSequence: 2,
  stage: 'prepared',
  cancelRequested: false,
  cancelRevision: 0,
  storageRetired: false,
  deletedBytes: 0,
  releasedReservationBytes: 0,
  failureCode: null,
}
const state = { collection: value, workerRunning: false, workerScheduled: false, workerError: null }
test('generated shape and source coordinates reject unrelated collection receipts and oversized pages', async () => {
  const invoke = vi.fn().mockResolvedValue(state),
    api = createUploadCollectionApi(invoke)
  expect(await api.uploadCollectionRead({ operationId: 'owned', selection })).toEqual(state)
  invoke.mockResolvedValue({
    ...state,
    collection: { ...value, selection: { ...selection, position: 9 } },
  })
  await expect(api.uploadCollectionRead({ operationId: 'owned', selection })).rejects.toThrow(
    'invalid_response'
  )
  invoke.mockResolvedValue({ items: Array(11).fill(state), nextCursor: null })
  await expect(api.uploadCollectionList({ selection })).rejects.toThrow('invalid_response')
  invoke.mockResolvedValue({ items: [state], nextCursor: 'same' })
  await expect(api.uploadCollectionList({ selection, cursor: 'same' })).rejects.toThrow(
    'invalid_response'
  )
})
test('collection has its own capability and only exact read/list methods forward read cancellation', async () => {
  const target = {
    id: 'remote',
    label: 'Remote',
    runtime: 'kcoder' as const,
    description: '',
    transport: 'ssh' as const,
    host: 'remote.test',
    workspacePath: '/owned',
  }
  const client = new FakeGatewayClient(null)
  const support = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationUploadCollectionV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(state as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const call = (name: string) =>
    runtime.request(
      'runtime.migration.request',
      {
        deviceId: 'remote',
        method: `migration/history/upload-collection/${name}`,
        params: { operationId: 'owned', selection },
      },
      options
    )
  try {
    await expect(call('run')).rejects.toThrow('migration_upload_collection_update_required')
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    await call('read')
    expect(request).toHaveBeenLastCalledWith(
      'migration/history/upload-collection/read',
      { operationId: 'owned', selection },
      options
    )
    await call('run')
    expect(request).toHaveBeenLastCalledWith('migration/history/upload-collection/run', {
      operationId: 'owned',
      selection,
    })
    await expect(call('purge')).rejects.toThrow('migration_invalid_operation')
  } finally {
    await runtime.dispose()
  }
})
