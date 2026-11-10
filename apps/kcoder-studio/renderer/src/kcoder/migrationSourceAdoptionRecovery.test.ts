import { beforeEach, expect, it, vi } from 'vitest'
import { createMigrationSourceAdoptionRecovery } from './migrationSourceAdoptionRecovery'
import type { MigrationSourceAdoptionPrepareParams } from '../../../shared/generated/contracts'

const requestId = '33333333-3333-4333-8333-333333333333'
const adoptionId = '44444444-4444-4444-8444-444444444444'
const input: MigrationSourceAdoptionPrepareParams = { locator: { requestId, adoptionId,
  target: { sessionId: requestId, purpose: 'target', targetId: 'target' } }, manifestSha256: 'a'.repeat(64),
  selections: [{ entryId: 'e0000-0000' }, { entryId: 'e0001-0000', projectMapping: 'current_workspace' }] }
beforeEach(() => localStorage.clear())
it('reopens an uncertain preview as the original adoption and never sends prepare again', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('reply lost'))
  const options = { storage: localStorage, captureScope: () => 'account', recoveryScope: 'owned-target', fetcher }
  await expect(createMigrationSourceAdoptionRecovery(options).prepare(input)).rejects.toMatchObject({ outcomeUnknown: true })
  expect(localStorage.length).toBe(1)
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ state: null })))
  const reopened = createMigrationSourceAdoptionRecovery(options)
  const changedConnection = { ...input, locator: { ...input.locator, adoptionId: '55555555-5555-4555-8555-555555555555',
    target: { ...input.locator.target, sessionId: adoptionId, purpose: 'target_recovery' as const } }, selections: [...input.selections].reverse() }
  const { prepare } = reopened
  const result = await prepare(changedConnection)
  expect(result.locator.adoptionId).toBe(adoptionId)
  expect(result.result).toEqual({ state: null })
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/api/migration/source-transfer/adoption-prepare', '/api/migration/source-transfer/adoption-read'])
  expect(localStorage.length).toBe(1)
})
it('refuses to overwrite the same identity with changed selection semantics', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ state: null })))
  const cache = createMigrationSourceAdoptionRecovery({ storage: localStorage, captureScope: () => 'a', recoveryScope: 'target', fetcher })
  await cache.prepare(input)
  await expect(cache.prepare({ ...input, selections: [{ entryId: 'e0002-0000' }] })).rejects.toMatchObject({ code: 'source_transfer_recovery_unavailable' })
  expect(fetcher).toHaveBeenCalledOnce()
})
it('does not silently replace a corrupt persisted intent with a fresh task', async () => {
  localStorage.setItem(`kcoder.migration.adoption:target:${requestId}:${adoptionId}`, '{')
  const fetcher = vi.fn<typeof fetch>()
  const cache = createMigrationSourceAdoptionRecovery({ storage: localStorage, captureScope: () => 'a', recoveryScope: 'target', fetcher })
  await expect(cache.prepare(input)).rejects.toMatchObject({ code: 'source_transfer_adoption_recovery_invalid' })
  expect(fetcher).not.toHaveBeenCalled()
  expect(localStorage.length).toBe(1)
})
it('refuses a read after retargeting the stored adoption to another workspace', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ state: null })))
  const cache = createMigrationSourceAdoptionRecovery({ storage: localStorage, captureScope: () => 'a', recoveryScope: 'target', fetcher })
  await cache.prepare(input)
  await expect(cache.read(input, { ...input.locator.target, workspacePath: '/different' })).rejects.toMatchObject({ code: 'source_transfer_request_changed' })
  expect(fetcher).toHaveBeenCalledOnce()
})
