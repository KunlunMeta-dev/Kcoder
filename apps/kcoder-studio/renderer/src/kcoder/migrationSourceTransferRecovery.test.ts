import { expect, it, vi } from 'vitest'
import { createMigrationSourceTransferRecovery } from './migrationSourceTransferRecovery'

const id = '22222222-2222-4222-8222-222222222222'
const source = { sessionId: id, purpose: 'source' as const, targetId: 'source' }
const target = { sessionId: id, purpose: 'target' as const, targetId: 'target' }
const input = { requestId: id, attemptId: id, source, target,
  selections: [{ kind: 'configuration' as const, sourceId: 'source-ref' }] }
const unknown = { requestId: id, coordinatorState: 'unknown', observation: 'unobserved', result: null, progress: null, errorCode: null }
function storage() {
  const values = new Map<string, string>()
  return { values, get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) } }
}
it('persists before dispatch and reopens with read-only reconciliation after a lost reply', async () => {
  const cache = storage()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    expect(cache.values.size).toBe(1)
    throw new Error('lost reply')
  })
  const options = { storage: cache, captureScope: () => 'account-a', recoveryScope: 'account-a:target', fetcher }
  await expect(createMigrationSourceTransferRecovery(options).start(input)).rejects.toMatchObject({ outcomeUnknown: true })
  const saved = [...cache.values.values()][0]
  expect(saved).not.toContain('selections')
  expect(saved).not.toContain('source-ref')
  const reopened = createMigrationSourceTransferRecovery(options)
  await expect(reopened.start(input)).rejects.toMatchObject({ code: 'source_transfer_reconcile_required' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  fetcher.mockResolvedValue(new Response(JSON.stringify(unknown)))
  await expect(reopened.reconcile(id)).resolves.toEqual(unknown)
  expect(fetcher.mock.calls[1][0]).toBe('/api/migration/source-transfer/read')
})
it('does not submit if persistent recovery storage is unavailable', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationSourceTransferRecovery({ captureScope: () => 'a', recoveryScope: 'a', fetcher,
    storage: { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error('quota') } } })
  await expect(client.start(input)).rejects.toMatchObject({ code: 'source_transfer_recovery_unavailable', outcomeUnknown: false })
  expect(fetcher).not.toHaveBeenCalled()
})
it('does not query or submit after an account switch', async () => {
  let account = 'a'
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationSourceTransferRecovery({ captureScope: () => account, recoveryScope: 'a', fetcher, storage: storage() })
  account = 'b'
  await expect(client.start(input)).rejects.toMatchObject({ code: 'source_transfer_authority_changed' })
  await expect(client.reconcile(id)).rejects.toMatchObject({ code: 'source_transfer_authority_changed' })
  expect(fetcher).not.toHaveBeenCalled()
})
it('refuses corrupt or cross-operation cached records instead of overwriting them', () => {
  const cache = storage()
  cache.setItem(`kcoder.migration.transfer:a:${id}`, JSON.stringify({ version: 1, request: { requestId: id, source, target }, attemptId: id, credential: 'not-allowed' }))
  const client = createMigrationSourceTransferRecovery({ captureScope: () => 'a', recoveryScope: 'a', storage: cache })
  expect(() => client.load(id)).toThrow('source_transfer_recovery_invalid')
  expect(cache.values.size).toBe(1)
})
it('does not reserve an operation that was cancelled before submission', async () => {
  const cache = storage()
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationSourceTransferRecovery({ captureScope: () => 'a', recoveryScope: 'a', storage: cache, fetcher })
  const abort = new AbortController()
  abort.abort()
  await expect(client.start(input, abort.signal)).rejects.toMatchObject({ code: 'source_transfer_request_not_sent', outcomeUnknown: false })
  expect(cache.values.size).toBe(0)
  expect(fetcher).not.toHaveBeenCalled()
})
it('pages only the original account namespace and reports corrupt records without dropping them', () => {
  const cache = storage()
  for (let index = 0; index < 12; index++) {
    const requestId = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`
    cache.setItem(`kcoder.migration.transfer:a:${requestId}`, JSON.stringify({ version: 1, attemptId: id,
      request: { requestId, source, target } }))
  }
  cache.setItem(`kcoder.migration.transfer:b:${id}`, 'not this account')
  cache.setItem('kcoder.migration.transfer:a:zz-corrupt', '{')
  const client = createMigrationSourceTransferRecovery({ captureScope: () => 'a', recoveryScope: 'a', storage: cache })
  expect(client.list().records).toHaveLength(10)
  expect(client.list(1)).toMatchObject({ total: 13, pageIndex: 1, invalidRequestIds: ['zz-corrupt'] })
  expect(client.list(1).records).toHaveLength(2)
  expect(client.list(2).records).toHaveLength(0)
  expect(cache.values.size).toBe(14)
})
it('does not promote a target-only recovery session into a new transfer', async () => {
  const cache = storage()
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationSourceTransferRecovery({ captureScope: () => 'a', recoveryScope: 'a', storage: cache, fetcher })
  await expect(client.start({ ...input, target: { ...target, purpose: 'target_recovery' } })).rejects.toMatchObject({ code: 'source_transfer_invalid_request' })
  expect(cache.values.size).toBe(0)
  expect(fetcher).not.toHaveBeenCalled()
})
it('reconciles an unavailable source through an explicitly opened original-target recovery session', async () => {
  const cache = storage()
  cache.setItem(`kcoder.migration.transfer:a:${id}`, JSON.stringify({ version: 1, attemptId: id, request: { requestId: id, source, target } }))
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(unknown)))
  const client = createMigrationSourceTransferRecovery({ captureScope: () => 'a', recoveryScope: 'a', storage: cache, fetcher })
  const recovery = { ...target, purpose: 'target_recovery' as const, sessionId: '33333333-3333-4333-8333-333333333333' }
  await expect(client.reconcileTarget(id, recovery)).resolves.toEqual(unknown)
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/target-read')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ requestId: id, target: recovery })
  await expect(client.reconcileTarget(id, { ...recovery, targetId: 'different' })).rejects.toMatchObject({ code: 'source_transfer_request_changed' })
  await expect(client.reconcileTarget(id, { ...recovery, workspacePath: '/different' })).rejects.toMatchObject({ code: 'source_transfer_request_changed' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
