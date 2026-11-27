import { expect, it, vi } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source.json'
import { createMigrationSourceAdoptionClient } from './gatewayMigrationSourceAdoption'
import type { MigrationSourceAdoptionPrepareParams } from '../../../shared/generated/contracts'

const id = '33333333-3333-4333-8333-333333333333'
const adoptionId = '44444444-4444-4444-8444-444444444444'
const target = { sessionId: id, purpose: 'target_recovery' as const, targetId: 'target' }
const locator = { target, requestId: id, adoptionId }
const input: MigrationSourceAdoptionPrepareParams = { locator, manifestSha256: 'a'.repeat(64), selections: [{ entryId: 'e0000-0000' }] }
const response = (value: unknown) => new Response(JSON.stringify(value))
it('preserves an uncertain prepare identity without retrying or substituting a batch publication call', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('lost reply'))
  const client = createMigrationSourceAdoptionClient({ captureScope: () => 'account', fetcher })
  await expect(client.prepare(input)).rejects.toMatchObject({ outcomeUnknown: true })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/adoption-prepare')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input)
})
it('accepts an untracked read without inventing a stopped worker or an empty completed preview', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ state: null }))
  const client = createMigrationSourceAdoptionClient({ captureScope: () => 'account', fetcher })
  await expect(client.read(locator)).resolves.toEqual({ state: null })
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/adoption-read')
})
it('rejects a receipt from another manifest and a preview from another adoption', async () => {
  const received = examples.MigrationSourceReceivedResult[0].value
  const ready = examples.MigrationSourceAdoptionResult.find(row => row.name === 'only_preview_ready')!.value
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(received))
  const client = createMigrationSourceAdoptionClient({ captureScope: () => 'account', fetcher })
  await expect(client.received({ target, requestId: id, manifestSha256: 'b'.repeat(64), pageIndex: 0 })).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false })
  fetcher.mockImplementation(async () => response(ready))
  await expect(client.read({ ...locator, adoptionId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({ code: 'source_transfer_invalid_response' })
  await expect(client.read(locator)).resolves.toEqual(ready)
})
it('rejects repeated entry anchors even when their project mapping differs', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationSourceAdoptionClient({ captureScope: () => 'account', fetcher })
  await expect(client.prepare({ ...input, selections: [{ entryId: 'e0000-0000' }, { entryId: 'e0000-0000', projectMapping: 'current_workspace' }] })).rejects.toMatchObject({ code: 'source_transfer_invalid_request', outcomeUnknown: false })
  expect(fetcher).not.toHaveBeenCalled()
})
