import { expect, it } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source-credentials.json'
import { pendingPrivatePreparation, privatePreparationIdentity, validPrivatePreparation } from '../../../shared/migrationPrivatePreparation'
import type { MigrationSourceCredentialPreparationReadParams, MigrationSourceCredentialPreparationResult } from '../../../shared/generated/contracts'
import { migrationFailureCode } from './migrationFailureCode'
const input = examples.MigrationSourceCredentialPreparationReadParams[0].value as MigrationSourceCredentialPreparationReadParams
const result = (phase: string) => structuredClone(examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === phase)!.value) as MigrationSourceCredentialPreparationResult

it('keeps preparation error exceptions exact and never displays arbitrary private text', () => {
  for (const code of ['private_credentials_preparation_pending', 'private_credentials_publication_unknown']) expect(migrationFailureCode(new Error(code))).toBe(code)
  for (const value of ['private_credentials_SYNTHETIC_NEVER_DISPLAY', 'private_credentials_preparation_pending SYNTHETIC_NEVER_DISPLAY']) expect(migrationFailureCode(new Error(value))).toBe('error')
})

it('validates all official states without treating preparation as publication or worker evidence', () => {
  for (const row of examples.MigrationSourceCredentialPreparationResult) expect(validPrivatePreparation(input, row.value)).toBe(true)
  for (const phase of ['prepared', 'unknown', 'not_started']) expect(pendingPrivatePreparation(result(phase), input.target)).toBeNull()
  expect(pendingPrivatePreparation(result('pending'), input.target)).toEqual({ jobId: input.jobId,
    locator: { requestId: input.requestId, target: input.target, offerId: result('pending').offerIds![0] },
    additionalOffers: result('pending').offerIds!.slice(1), expectedSequence: 1, consent: { apiKeys: true, mcpPrivateFields: true } })
})
it('rejects wrong original identities, partial intents, unsorted or duplicate offers and false phase counters', () => {
  const pending = result('pending')
  for (const changed of [
    { ...pending, requestId: '33333333-3333-4333-8333-333333333333' }, { ...pending, jobId: 'mig-' + 'b'.repeat(32) },
    { ...pending, consent: null }, { ...pending, expectedSequence: null }, { ...pending, originalPlanId: null },
    { ...pending, offerIds: [...pending.offerIds!].reverse() }, { ...pending, offerIds: [pending.offerIds![0], pending.offerIds![0]] },
    { ...pending, offerIds: ['arbitrary-path'] }, { ...pending, sequence: 2 }, { ...pending, phase: 'prepared' },
    { ...pending, phase: 'not_started' }, { ...pending, privateValue: 'SYNTHETIC_REJECTED_VALUE' },
  ]) expect(validPrivatePreparation(input, changed)).toBe(false)
})
it('pins the full original intent across pending to prepared and rejects any silent set, sequence or consent replacement', () => {
  const pending = result('pending'), prepared = result('prepared')
  expect(privatePreparationIdentity(pending)).toBe(privatePreparationIdentity(prepared))
  for (const changed of [{ ...prepared, expectedSequence: 2 }, { ...prepared, offerIds: prepared.offerIds!.slice(0, 1) },
    { ...prepared, consent: { apiKeys: false, mcpPrivateFields: true } }, { ...prepared, originalPlanId: 'other-original-plan' }]) {
    expect(privatePreparationIdentity(changed)).not.toBe(privatePreparationIdentity(pending))
  }
})
