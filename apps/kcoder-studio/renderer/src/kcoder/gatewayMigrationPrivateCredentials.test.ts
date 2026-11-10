import { expect, it, vi } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source-credentials.json'
import type { MigrationSourceCredentialCandidatesParams, MigrationSourceCredentialLocator, MigrationSourceCredentialRunParams, MigrationSourceCredentialPrepareParams } from '../../../shared/generated/contracts'
import { createMigrationPrivateCredentialClient } from './gatewayMigrationPrivateCredentials'

const locator = examples.MigrationSourceCredentialLocator[0].value as MigrationSourceCredentialLocator
const offered = examples.MigrationSourceCredentialResult[0].value
const response = (value: unknown) => new Response(JSON.stringify(value))
const plannedInput = examples.MigrationSourceCredentialCandidatesParams.find(row => row.name === 'original_saved_plan_selector')!.value as MigrationSourceCredentialCandidatesParams
const plannedResult = examples.MigrationSourceCredentialCandidatesResult.find(row => row.name === 'saved_plan_exact_entry_mapping')!.value

it('reads the original native preparation without an offer cache and keeps missing private capability errors read-only', async () => {
  const input = examples.MigrationSourceCredentialPreparationReadParams[0].value
  const prepared = examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === 'prepared')!.value
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(prepared))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  await expect(client.preparationRead(input)).resolves.toEqual(prepared)
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/private/prepare-status')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input)
  fetcher.mockResolvedValue(new Response(JSON.stringify({ error: 'private_credentials_update_required' }), { status: 409 }))
  await expect(client.preparationRead(input)).rejects.toMatchObject({ code: 'private_credentials_update_required', outcomeUnknown: false })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('reconciles the original private offer through a target-only read', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(offered))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  await expect(client.read(locator)).resolves.toEqual(offered)
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/private/read')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(locator)
})

it('retains an uncertain run without resending or exposing transport failure text', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('untrusted failure detail'))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  const input = examples.MigrationSourceCredentialRunParams[0].value as MigrationSourceCredentialRunParams
  await expect(client.run(input)).rejects.toMatchObject({ code: 'source_transfer_outcome_unknown', outcomeUnknown: true })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input)
})

it('rejects a late reply after account ownership changes', async () => {
  let scope = 'original'
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => scope, fetcher })
  const pending = client.read(locator)
  scope = 'replacement'
  finish(response(offered))
  await expect(pending).rejects.toMatchObject({ code: 'source_transfer_authority_changed', outcomeUnknown: false })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('rejects a peer offer and inconsistent claimed completion', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...offered, offerId: '44444444-4444-4444-8444-444444444444' }))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  await expect(client.read(locator)).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false })
  fetcher.mockResolvedValue(response({ ...offered, received: true, phase: 'received' }))
  await expect(client.read(locator)).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false })
})

it('preserves closed private diagnostics while suppressing arbitrary backend text', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  for (const code of ['private_credentials_keyring_unavailable', 'private_credentials_SYNTHETIC_PRIVATE_VALUE']) {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: code }), { status: 409 }))
    await expect(client.read(locator)).rejects.toMatchObject({ code: code.endsWith('unavailable') ? code : 'source_transfer_outcome_unknown', outcomeUnknown: false })
  }
})

it('requires the original job and plan together before dispatching a mapped candidate query', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  for (const input of [{ ...plannedInput, jobId: undefined }, { ...plannedInput, expectedPlanId: undefined }]) {
    await expect(client.candidates(input)).rejects.toMatchObject({ code: 'source_transfer_invalid_request', outcomeUnknown: false })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('accepts only mappings tied to the exact saved plan and the requested page', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(plannedResult))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  await expect(client.candidates(plannedInput)).resolves.toEqual(plannedResult)
  for (const result of [
    { ...plannedResult, plan: { ...plannedResult.plan, jobId: 'peer-job' } },
    { ...plannedResult, plan: { ...plannedResult.plan, planId: 'peer-plan' } },
    { ...plannedResult, nextPage: 1 },
    { ...plannedResult, items: [] },
    { ...plannedResult, items: [plannedResult.items[0], { ...plannedResult.items[0], itemId: 'another-item' }], totalItems: 2 },
  ]) {
    fetcher.mockResolvedValue(response(result))
    await expect(client.candidates(plannedInput)).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false })
  }
})

it('requires an exact sorted bundle receipt and refuses a primary offer repeated as an additional member', async () => {
  const base = examples.MigrationSourceCredentialPrepareParams[0].value as MigrationSourceCredentialPrepareParams
  const extra = '44444444-4444-4444-8444-444444444444'
  const input = { ...base, additionalOffers: [extra] }
  const sample = examples.MigrationSourceCredentialPrepareResult[0].value
  const output = { ...sample, requestId: base.locator.requestId, offerId: base.locator.offerId,
    job: { ...sample.job, job: { ...sample.job.job, jobId: base.jobId } } }
  const fetcher = vi.fn<typeof fetch>()
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  await expect(client.prepare({ ...base, additionalOffers: [base.locator.offerId] })).rejects.toMatchObject({ code: 'source_transfer_invalid_request', outcomeUnknown: false })
  expect(fetcher).not.toHaveBeenCalled()
  for (const value of [output, { ...output, offerIds: [extra, base.locator.offerId] },
    { ...output, offerIds: [base.locator.offerId, extra, '55555555-5555-4555-8555-555555555555'] }]) {
    fetcher.mockResolvedValue(response(value))
    await expect(client.prepare(input)).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: true })
  }
  const complete = { ...output, offerIds: [base.locator.offerId, extra].sort() }
  fetcher.mockResolvedValue(response(complete))
  await expect(client.prepare(input)).resolves.toEqual(complete)
})

it('observes only the original source and rejects target custody claims on the source-only lane', async () => {
  const run = examples.MigrationSourceCredentialRunParams[0].value as MigrationSourceCredentialRunParams
  const sourceOnly = { ...offered, sourceControl: { sequence: 3, cancelWatermark: 1, cancelled: true, ready: false },
    sourceObserved: true, sourceWorkerRunning: false, targetControl: null, targetObserved: false, targetWorkerRunning: null,
    received: false, keyReleased: false, phase: 'cancelled' }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(sourceOnly))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'original', fetcher })
  await expect(client.sourceRead({ locator, source: run.source })).resolves.toEqual(sourceOnly)
  expect(fetcher.mock.calls[0][0]).toBe('/api/migration/source-transfer/private/source-read')
  for (const value of [{ ...sourceOnly, received: true }, { ...sourceOnly, targetObserved: true },
    { ...sourceOnly, sourceWorkerRunning: null }, { ...sourceOnly, phase: 'sealed' }]) {
    fetcher.mockResolvedValue(response(value))
    await expect(client.sourceRead({ locator, source: run.source })).rejects.toMatchObject({ outcomeUnknown: false })
  }
  fetcher.mockClear()
  await expect(client.sourceRead({ locator, source: { ...run.source, purpose: 'target' } })).rejects.toMatchObject({ outcomeUnknown: false })
  expect(fetcher).not.toHaveBeenCalled()
})

it('aborts only the disposed controller HTTP observation while retaining an uncertain dispatched mutation', async () => {
  const abort = new AbortController()
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error('observation closed')), { once: true })
  }))
  const client = createMigrationPrivateCredentialClient({ captureScope: () => 'owned', fetcher }, () => abort.signal)
  const run = examples.MigrationSourceCredentialRunParams[0].value as MigrationSourceCredentialRunParams
  const pending = client.run(run)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ code: 'source_transfer_outcome_unknown', outcomeUnknown: true })
  expect(fetcher).toHaveBeenCalledOnce()
})
